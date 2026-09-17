// Smoke test for the plain LLM mode protocol helpers in extension.js.
// Run: node scripts/llm-mode-smoke.js
'use strict';
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: { workspaceFolders: [{ uri: { scheme: 'file', fsPath: process.cwd() } }] },
      window: {}, commands: {}, env: {}, Uri: { parse: s => ({ toString: () => s }) }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { toOpenAiMessages, parseLlmChoice, normalizeLlmBaseUrl, mergeToolSchemas } = require('../extension.js');

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log(`PASS  ${name}`); }
  else { failures += 1; console.error(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
}

// 1. toOpenAiMessages converts legacy assistant tool_calls + tool results.
const converted = toOpenAiMessages([
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', name: 'list_files', arguments: { path: 'src' } }] },
  { role: 'tool', tool_call_id: 'call_1', name: 'list_files', content: '{"ok":true}' },
  { role: 'assistant', content: 'done' }
]);
check('toOpenAiMessages keeps user message', converted[0].role === 'user' && converted[0].content === 'hello');
check('toOpenAiMessages converts tool_calls to OpenAI shape', converted[1].role === 'assistant' && Array.isArray(converted[1].tool_calls) && converted[1].tool_calls[0].type === 'function' && converted[1].tool_calls[0].function.name === 'list_files');
check('toOpenAiMessages stringifies arguments', converted[1].tool_calls[0].function.arguments === JSON.stringify({ path: 'src' }));
check('toOpenAiMessages strips tool name field', converted[2].role === 'tool' && converted[2].tool_call_id === 'call_1' && converted[2].name === undefined && converted[2].content === '{"ok":true}');
check('toOpenAiMessages keeps final assistant', converted[3].role === 'assistant' && converted[3].content === 'done');

// 2. parseLlmChoice with tool_calls response.
const toolResponse = parseLlmChoice({ choices: [{ message: { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] }, finish_reason: 'tool_calls' }] });
check('parseLlmChoice returns tool_calls', toolResponse.type === 'tool_calls' && toolResponse.tool_calls.length === 1 && toolResponse.tool_calls[0].name === 'read_file');
check('parseLlmChoice parses arguments object', toolResponse.tool_calls[0].arguments.path === 'a.txt');

// 3. parseLlmChoice with plain message response (with reasoning wrapper).
const msgResponse = parseLlmChoice({ choices: [{ message: { content: '<thinking>internal</thinking>Final answer.' }, finish_reason: 'stop' }] });
check('parseLlmChoice strips reasoning wrapper', msgResponse.type === 'message' && msgResponse.content === 'Final answer.');

// 4. parseLlmChoice truncated without content.
let truncatedThrew = false;
try { parseLlmChoice({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }); } catch (e) { truncatedThrew = true; }
check('parseLlmChoice throws on empty truncation', truncatedThrew);

// 5. normalizeLlmBaseUrl.
check('normalizeLlmBaseUrl keeps /v1', normalizeLlmBaseUrl('https://api.openai.com/v1') === 'https://api.openai.com/v1');
check('normalizeLlmBaseUrl strips /chat/completions', normalizeLlmBaseUrl('https://api.openai.com/v1/chat/completions') === 'https://api.openai.com/v1');
check('normalizeLlmBaseUrl appends /v1', normalizeLlmBaseUrl('http://127.0.0.1:11434') === 'http://127.0.0.1:11434/v1');

// 6. mergeToolSchemas dedupes by function name.
const a = [{ type: 'function', function: { name: 'dup' } }, { type: 'function', function: { name: 'only_a' } }];
const b = [{ type: 'function', function: { name: 'dup' } }, { type: 'function', function: { name: 'only_b' } }];
const merged = mergeToolSchemas(a, b);
check('mergeToolSchemas dedupes and preserves order', merged.length === 3 && merged.map(t => t.function.name).join(',') === 'dup,only_a,only_b');

console.log(failures === 0 ? '\nAll LLM mode smoke tests passed.' : `\n${failures} smoke test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
