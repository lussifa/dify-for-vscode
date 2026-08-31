const vscode = require('vscode');

let context;
let runtime = {};
let mutationChain = Promise.resolve();

function initializeAgentRuntime(extensionContext, options = {}) {
  context = extensionContext;
  runtime = { ...options };
}

async function runSubAgent({ agent, task, contextText = '', allowedTools = null, maxSteps = 14, mode = 'worker' }) {
  if (!context) throw new Error('Sub-agent runtime is not initialized.');
  const apiKey = await context.secrets.get('difyForVscode.apiKey');
  if (!apiKey) throw new Error('Dify API key is not configured.');
  const config = vscode.workspace.getConfiguration('difyForVscode');
  const tools = filterTools(await runtime.getAllTools(), allowedTools).filter(t => t.function?.name !== 'run_crew');
  const reviewer = /review|qa|test/i.test(`${agent.id || ''} ${agent.role || ''}`);
  const system = [
    'You are a specialist agent inside a coordinated crew.',
    `Role: ${agent.role}`,
    `Goal: ${agent.goal}`,
    agent.backstory ? `Backstory: ${agent.backstory}` : '',
    'You must complete only the assigned task. Use tools when needed. Do not invent tool results.',
    reviewer ? 'Reviewer rule: inspect and verify, then return a clear PASS or FAIL with findings. Do not keep re-checking evidence you already have. Do not modify implementation unless the assigned task explicitly asks you to fix it.' : '',
    'Return protocol JSON only: either {"type":"tool_calls",...} or {"type":"message","content":"...","tool_calls":[]}.'
  ].filter(Boolean).join('\n');
  const user = [
    `Task: ${task.description}`,
    `Expected output: ${task.expected_output}`,
    contextText ? `Context from other completed tasks:\n${contextText}` : ''
  ].filter(Boolean).join('\n\n');
  const history = [{ role: 'system', content: system }, { role: 'user', content: user }];
  let query = user;
  const limit = Math.max(1, Math.min(40, Number(maxSteps || 14)));
  const callCounts = new Map();
  const observations = [];
  let repeatedCalls = 0;

  for (let step = 1; step <= limit; step += 1) {
    const remaining = limit - step;
    runtime.onEvent?.({ type: 'subagent_step', agent: agent.id, role: agent.role, task: task.id, step, remaining, mode });
    const budgetHint = remaining <= 1
      ? `Execution budget is almost exhausted (${remaining} tool step${remaining === 1 ? '' : 's'} remaining). Do not call another tool unless absolutely necessary. Return your best final result now.`
      : remaining <= 4
        ? `You have ${remaining} execution steps remaining. Prioritize only missing evidence, do not repeat completed checks, and finish as soon as the expected output is satisfied.`
        : `You have ${remaining} execution steps remaining.`;
    const decision = await callDify(`${query}\n\n${budgetHint}`, apiKey, history, tools, `${config.get('userId', 'vscode-agent')}:crew:${agent.id}`);
    if (decision.type === 'message') {
      return { content: String(decision.content || ''), steps: step, status: 'completed', partial: false, observations };
    }
    const calls = normalizeCalls(decision);
    if (!calls.length) throw new Error(`Sub-agent ${agent.id} returned neither a message nor valid tool calls.`);
    history.push({ role: 'assistant', content: null, tool_calls: calls });

    for (const call of calls) {
      const signature = toolSignature(call);
      const count = (callCounts.get(signature) || 0) + 1;
      callCounts.set(signature, count);
      let result;
      if (count >= 2) {
        repeatedCalls += 1;
        result = {
          success: false,
          repeated: true,
          repeat_count: count,
          error: 'This exact tool call was already executed. Reuse the previous result and move toward a final answer instead of repeating it.'
        };
      } else {
        result = await executeToolWithApproval(call, { source: 'crew', agent: agent.id, role: agent.role, task: task.id });
        observations.push({ tool: call.name, arguments: call.arguments, result: summarizeResult(result) });
        if (observations.length > 20) observations.shift();
      }
      history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(result) });
    }

    if (repeatedCalls >= 3) {
      query = 'You are repeating tool calls. Stop using tools now. Use the evidence already present in the conversation and return the required final answer immediately.';
    } else if (remaining <= 2) {
      query = 'Use the latest tool results and finalize now. Do not repeat checks. Return the expected output as a final message unless one indispensable check remains.';
    } else {
      query = 'Continue the assigned task using the latest tool results. Do not repeat identical tool calls. Finish when the expected output is satisfied.';
    }
  }

  // A sub-agent exhausting its tool budget should not crash the entire crew.
  // Give it one tool-free chance to summarize the evidence already collected.
  try {
    const finalDecision = await callDify(
      'The execution-step budget is exhausted. No more tools are available. Produce the best possible final result now from the existing conversation and tool evidence. Clearly mark uncertainty or incomplete verification.',
      apiKey,
      history,
      [],
      `${config.get('userId', 'vscode-agent')}:crew:${agent.id}:finalize`
    );
    if (finalDecision.type === 'message' && String(finalDecision.content || '').trim()) {
      return {
        content: String(finalDecision.content || ''),
        steps: limit,
        status: 'max_steps_reached',
        partial: true,
        observations
      };
    }
  } catch {}

  const evidence = observations.slice(-8).map((o, i) => `${i + 1}. ${o.tool}: ${JSON.stringify(o.result)}`).join('\n');
  return {
    content: `Partial result: sub-agent ${agent.id} reached its ${limit}-step budget before producing a formal final response.${evidence ? `\n\nRecent evidence:\n${evidence}` : ''}`,
    steps: limit,
    status: 'max_steps_reached',
    partial: true,
    observations
  };
}

async function executeToolWithApproval(call, meta = {}) {
  const toolsModule = require('./tools');
  const mutating = toolsModule.MUTATING_TOOLS.has(call.name);
  const run = () => executeNow(toolsModule, call, mutating, meta);
  if (!mutating) return run();
  const queued = mutationChain.then(run, run);
  mutationChain = queued.catch(() => {});
  return queued;
}

async function executeNow(toolsModule, call, mutating, meta) {
  const config = vscode.workspace.getConfiguration('difyForVscode');
  if (mutating && !config.get('yoloMode', false)) {
    const label = meta.source === 'mcp-bridge' ? 'MCP client' : `Crew agent ${meta.agent || meta.role || ''}`.trim();
    const choice = await vscode.window.showWarningMessage(
      `${label || 'Agent'} wants to run: ${call.name}`,
      { modal: true, detail: JSON.stringify(call.arguments || {}, null, 2).slice(0, 8000) },
      'Allow once', 'Enable YOLO', 'Deny'
    );
    if (choice === 'Enable YOLO') await config.update('yoloMode', true, vscode.ConfigurationTarget.Global);
    else if (choice !== 'Allow once') return { success: false, error: 'User denied this tool call.' };
  }
  try { return await toolsModule.executeTool(call.name, call.arguments || {}, config); }
  catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

async function callDify(query, apiKey, history, tools, userId) {
  const config = vscode.workspace.getConfiguration('difyForVscode');
  const baseUrl = normalizeBaseUrl(config.get('baseUrl', 'http://127.0.0.1/v1'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);
  try {
    const response = await fetch(`${baseUrl}/chat-messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: { messages: JSON.stringify(history), tools: JSON.stringify(tools) }, query, response_mode: 'blocking', user: userId }),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Dify HTTP ${response.status}: ${body.slice(0, 2500)}`);
    let data;
    try { data = JSON.parse(body); } catch { throw new Error(`Dify returned invalid JSON: ${body.slice(0, 1200)}`); }
    return parseDifyAnswer(data.answer);
  } finally { clearTimeout(timeout); }
}

function filterTools(tools, patterns) {
  if (patterns === null || patterns === undefined) return tools;
  if (!Array.isArray(patterns)) return tools;
  if (!patterns.length) return [];
  return tools.filter(t => toolAllowed(String(t.function?.name || ''), patterns.map(String)));
}
function toolAllowed(name, patterns) { return patterns.some(p => p === '*' || p === name || (p.endsWith('*') && name.startsWith(p.slice(0, -1)))); }
function toolSignature(call) { return `${call.name}:${stableStringify(call.arguments || {})}`; }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function summarizeResult(result) {
  if (!result || typeof result !== 'object') return result;
  const copy = { ...result };
  for (const key of ['content', 'stdout', 'stderr', 'text']) {
    if (typeof copy[key] === 'string' && copy[key].length > 1600) copy[key] = `${copy[key].slice(0, 1600)}...`;
  }
  return copy;
}
function normalizeCalls(decision) {
  if (!decision || !['tool_calls', 'tool_call'].includes(decision.type)) return [];
  const raw = decision.type === 'tool_call' ? [decision] : (Array.isArray(decision.tool_calls) ? decision.tool_calls : []);
  return raw.map((call, index) => ({ id: call.id || `call_${Date.now()}_${index}`, name: String(call.name || call.function?.name || ''), arguments: normalizeArguments(call.arguments ?? call.function?.arguments) })).filter(c => c.name);
}
function normalizeArguments(value) { if (!value) return {}; if (typeof value === 'object') return value; if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } } return {}; }
function stripReasoning(text) { return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<analysis>[\s\S]*?<\/analysis>/gi, '').replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim(); }
function extractJson(text) {
  const source = stripReasoning(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(source); } catch {}
  const matches = [];
  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
      if (ch === '"') inString = true; else if (ch === '{') depth += 1; else if (ch === '}' && --depth === 0) { try { matches.push(JSON.parse(source.slice(start, i + 1))); } catch {} break; }
    }
  }
  return matches.reverse().find(x => x && ['message', 'tool_calls', 'tool_call'].includes(x.type)) || null;
}
function parseDifyAnswer(answer) {
  if (answer && typeof answer === 'object') answer = JSON.stringify(answer);
  const parsed = extractJson(answer);
  if (parsed?.type === 'message') return { type: 'message', content: stripReasoning(parsed.content || '') };
  if (parsed?.type === 'tool_calls' || parsed?.type === 'tool_call') return parsed;
  return { type: 'message', content: stripReasoning(answer) };
}
function normalizeBaseUrl(url) { let value = String(url || '').trim().replace(/\/+$/, ''); if (value.endsWith('/chat-messages')) value = value.slice(0, -'/chat-messages'.length); if (!value.endsWith('/v1')) value += '/v1'; return value; }

module.exports = { initializeAgentRuntime, runSubAgent, executeToolWithApproval };
