// Compatibility layer for the OpenAI-compatible Dify Chatflow contract.
// It keeps the stable extension runtime intact while translating
// requests/responses to the coding-agent1.yml input/output schema.

const vscode = require('vscode');
const pkg = require('./package.json');
const core = require('./extension.js');
const originalFetch = globalThis.fetch;
const RELEASE_API = 'https://api.github.com/repos/lussifa/dify-for-vscode/releases/latest';

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

function stripReasoningBlocks(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .trim();
}

function extractJsonObject(text) {
  const source = stripReasoningBlocks(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(source);
  } catch {
    // Fall through and scan for a balanced JSON object in mixed model output.
  }

  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, i + 1);
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }

  return null;
}

function toLegacyAnswer(answer) {
  if (typeof answer !== 'string') return answer;

  const parsed = extractJsonObject(answer);
  if (!parsed || typeof parsed !== 'object') {
    return stripReasoningBlocks(answer);
  }

  if (parsed.type === 'tool_calls' && Array.isArray(parsed.tool_calls)) {
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

  // Preserve structured final-message responses while removing any model reasoning prefix/suffix.
  if (parsed.type === 'message') {
    return JSON.stringify(parsed);
  }

  return JSON.stringify(parsed);
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

function versionParts(version) {
  return String(version || '')
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map(part => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const a = versionParts(candidate);
  const b = versionParts(current);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i] || 0;
    const right = b[i] || 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

async function checkForUpdates(showUpToDate = false) {
  try {
    const response = await originalFetch(RELEASE_API, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'User-Agent': `dify-for-vscode/${pkg.version}`
      }
    });

    if (!response.ok) {
      if (showUpToDate) {
        vscode.window.showWarningMessage(`Unable to check for updates (GitHub HTTP ${response.status}).`);
      }
      return;
    }

    const release = await response.json();
    const latest = String(release.tag_name || release.name || '').replace(/^v/i, '');
    if (!latest) return;

    if (isNewerVersion(latest, pkg.version)) {
      const action = await vscode.window.showInformationMessage(
        `Dify for VS Code ${latest} is available. You are using ${pkg.version}.`,
        'Open Release'
      );
      if (action === 'Open Release' && release.html_url) {
        await vscode.env.openExternal(vscode.Uri.parse(release.html_url));
      }
    } else if (showUpToDate) {
      vscode.window.showInformationMessage(`Dify for VS Code ${pkg.version} is up to date.`);
    }
  } catch (error) {
    if (showUpToDate) {
      vscode.window.showWarningMessage(`Update check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function activate(context) {
  core.activate(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('difyForVscode.checkUpdates', () => checkForUpdates(true))
  );

  const config = vscode.workspace.getConfiguration('difyForVscode');
  if (config.get('checkUpdatesOnStartup', true)) {
    setTimeout(() => checkForUpdates(false), 3000);
  }
}

function deactivate() {
  if (typeof core.deactivate === 'function') core.deactivate();
}

module.exports = { activate, deactivate };
