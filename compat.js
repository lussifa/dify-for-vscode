// Compatibility layer for the OpenAI-compatible Dify Chatflow contract.
// It keeps the stable v0.1 extension runtime intact while translating
// requests/responses to the coding-agent1.yml input/output schema.

const originalFetch = globalThis.fetch;

if (typeof originalFetch !== 'function') {
  throw new Error('Dify for VS Code requires a VS Code runtime with global fetch support.');
}

function toOpenAiHistory(messages) {
  if (!Array.isArray(messages)) return [];

  return messages.map(message => {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
      return message;
    }

    return {
      ...message,
      tool_calls: message.tool_calls.map(call => {
        if (call && call.type === 'function' && call.function) return call;

        const args = call && call.arguments !== undefined ? call.arguments : {};
        return {
          id: call && call.id ? call.id : `call_${Date.now()}`,
          type: 'function',
          function: {
            name: String((call && call.name) || ''),
            arguments: typeof args === 'string' ? args : JSON.stringify(args)
          }
        };
      })
    };
  });
}

function toLegacyAnswer(answer) {
  if (typeof answer !== 'string') return answer;

  let text = answer.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return answer;
  }

  if (!parsed || parsed.type !== 'tool_calls' || !Array.isArray(parsed.tool_calls)) {
    return answer;
  }

  const translated = {
    type: 'tool_calls',
    content: typeof parsed.content === 'string' ? parsed.content : '',
    tool_calls: parsed.tool_calls.map(call => ({
      id: call && call.id,
      name: call && call.function ? call.function.name : call && call.name,
      arguments: call && call.function ? call.function.arguments : call && call.arguments
    }))
  };

  return JSON.stringify(translated);
}

globalThis.fetch = async function difyCompatibleFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input);

  if (!url.endsWith('/chat-messages') || !init || typeof init.body !== 'string') {
    return originalFetch(input, init);
  }

  let requestBody;
  try {
    requestBody = JSON.parse(init.body);
  } catch {
    return originalFetch(input, init);
  }

  const oldInputs = requestBody.inputs || {};
  let history = [];
  try {
    history = JSON.parse(oldInputs.messages || '[]');
  } catch {
    history = [];
  }

  const translatedRequest = {
    ...requestBody,
    inputs: {
      messages_json: JSON.stringify(toOpenAiHistory(history)),
      tools_json: oldInputs.tools || '[]',
      tool_choice_json: '"auto"',
      retry_feedback: ''
    }
  };

  const response = await originalFetch(input, {
    ...init,
    body: JSON.stringify(translatedRequest)
  });

  const responseText = await response.text();
  let outputText = responseText;

  if (response.ok) {
    try {
      const data = JSON.parse(responseText);
      if (Object.prototype.hasOwnProperty.call(data, 'answer')) {
        data.answer = toLegacyAnswer(data.answer);
        outputText = JSON.stringify(data);
      }
    } catch {
      // Preserve original response if it is not JSON.
    }
  }

  return new Response(outputText, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
};

module.exports = require('./extension.js');
