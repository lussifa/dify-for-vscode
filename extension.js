const vscode = require('vscode');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

const SECRET_KEY = 'difyForVscode.apiKey';
const VIEW_ID = 'difyForVscode.chatView';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_workspace_info',
      description: 'Get the current VS Code workspace root and top-level files/folders.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file inside the current workspace. Optionally read a line range.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 }
        },
        required: ['path'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories recursively inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative directory. Empty means workspace root.' },
          max_depth: { type: 'integer', minimum: 0, maximum: 8, default: 3 }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search text across workspace files and return matching lines.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          glob: { type: 'string', description: 'VS Code glob, e.g. **/*.ts. Default **/*.' },
          max_results: { type: 'integer', minimum: 1, maximum: 200, default: 50 }
        },
        required: ['query'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or completely overwrite a UTF-8 text file inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_text',
      description: 'Replace exact text in a UTF-8 workspace file. Best for small, precise edits.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          replace_all: { type: 'boolean', default: false }
        },
        required: ['path', 'old_text', 'new_text'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Run a shell command with the workspace root as the default working directory.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Optional workspace-relative working directory.' }
        },
        required: ['command'],
        additionalProperties: false
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_diagnostics',
      description: 'Get VS Code errors/warnings for one file or the whole workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional workspace-relative file path.' }
        },
        additionalProperties: false
      }
    }
  }
];

function activate(context) {
  const provider = new DifyChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('difyForVscode.configure', () => provider.configure()),
    vscode.commands.registerCommand('difyForVscode.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('difyForVscode.toggleYolo', () => provider.toggleYolo())
  );
}

function deactivate() {}

class DifyChatViewProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.running = false;
    this.history = context.workspaceState.get('difyForVscode.history', []);
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(async (msg) => {
      try {
        if (msg.type === 'send') await this.sendUserMessage(String(msg.text || '').trim());
        if (msg.type === 'configure') await this.configure();
        if (msg.type === 'newChat') await this.newChat();
        if (msg.type === 'toggleYolo') await this.toggleYolo();
      } catch (error) {
        this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    });
    this.pushState();
  }

  config() {
    return vscode.workspace.getConfiguration('difyForVscode');
  }

  async configure() {
    const config = this.config();
    const baseUrl = await vscode.window.showInputBox({
      title: 'Dify for VS Code - Base URL',
      prompt: 'Enter the Dify API base URL. Example: http://dify.example.local/v1',
      value: config.get('baseUrl', 'http://127.0.0.1/v1'),
      ignoreFocusOut: true
    });
    if (!baseUrl) return;

    const existing = await this.context.secrets.get(SECRET_KEY);
    const apiKey = await vscode.window.showInputBox({
      title: 'Dify for VS Code - App API Key',
      prompt: existing ? 'Enter a new key, or cancel to keep the existing key.' : 'Enter the Dify App API key (app-...).',
      password: true,
      ignoreFocusOut: true
    });

    const userId = await vscode.window.showInputBox({
      title: 'Dify for VS Code - User ID',
      value: config.get('userId', 'vscode-agent'),
      ignoreFocusOut: true
    });

    await config.update('baseUrl', normalizeBaseUrl(baseUrl), vscode.ConfigurationTarget.Global);
    if (apiKey) await this.context.secrets.store(SECRET_KEY, apiKey.trim());
    if (userId) await config.update('userId', userId.trim(), vscode.ConfigurationTarget.Global);

    this.pushState();
    vscode.window.showInformationMessage('Dify for VS Code configuration saved.');
  }

  async toggleYolo() {
    const config = this.config();
    const current = config.get('yoloMode', false);
    const next = !current;

    if (next) {
      const choice = await vscode.window.showWarningMessage(
        'Enable YOLO mode?',
        { modal: true, detail: 'YOLO automatically allows file writes and shell commands requested by the Dify model. Commands may affect files or systems outside the workspace.' },
        'Enable YOLO'
      );
      if (choice !== 'Enable YOLO') return;
    }

    await config.update('yoloMode', next, vscode.ConfigurationTarget.Global);
    this.pushState();
  }

  async newChat() {
    if (this.running) {
      vscode.window.showWarningMessage('A Dify agent task is currently running.');
      return;
    }
    this.history = [];
    await this.saveHistory();
    this.post({ type: 'clear' });
    this.pushState();
  }

  async sendUserMessage(text) {
    if (!text || this.running) return;
    const apiKey = await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      this.post({ type: 'error', message: 'Dify API key is not configured.' });
      await this.configure();
      return;
    }

    this.running = true;
    this.history.push({ role: 'user', content: text });
    await this.saveHistory();
    this.post({ type: 'message', role: 'user', content: text });
    this.post({ type: 'running', value: true });

    try {
      await this.agentLoop(text, apiKey);
    } finally {
      this.running = false;
      this.post({ type: 'running', value: false });
    }
  }

  async agentLoop(firstQuery, apiKey) {
    const maxSteps = this.config().get('maxAgentSteps', 20);
    let query = firstQuery;

    for (let step = 1; step <= maxSteps; step += 1) {
      this.post({ type: 'status', message: `Dify thinking - step ${step}/${maxSteps}` });
      const decision = await this.callDify(query, apiKey);

      if (decision.type === 'message') {
        const content = String(decision.content || '');
        this.history.push({ role: 'assistant', content });
        await this.saveHistory();
        this.post({ type: 'message', role: 'assistant', content });
        this.post({ type: 'status', message: '' });
        return;
      }

      if (decision.type !== 'tool_calls' || !Array.isArray(decision.tool_calls) || decision.tool_calls.length === 0) {
        throw new Error('Dify returned neither a message nor a valid tool_calls response.');
      }

      const calls = decision.tool_calls.map((call, index) => ({
        id: call.id || `call_${Date.now()}_${index}`,
        name: String(call.name || ''),
        arguments: normalizeArguments(call.arguments)
      }));

      this.history.push({ role: 'assistant', content: null, tool_calls: calls });

      for (const call of calls) {
        this.post({ type: 'tool', phase: 'start', name: call.name, arguments: call.arguments });
        const result = await this.executeWithApproval(call);
        this.history.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: JSON.stringify(result)
        });
        this.post({ type: 'tool', phase: 'end', name: call.name, result });
      }

      await this.saveHistory();
      query = 'Continue the coding task using the latest tool results in messages. Return the next tool call(s) or the final message.';
    }

    throw new Error(`Agent stopped after reaching maxAgentSteps (${maxSteps}).`);
  }

  async callDify(query, apiKey) {
    const config = this.config();
    const baseUrl = normalizeBaseUrl(config.get('baseUrl', 'http://127.0.0.1/v1'));
    const userId = config.get('userId', 'vscode-agent');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);

    try {
      const response = await fetch(`${baseUrl}/chat-messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          inputs: {
            messages: JSON.stringify(this.history),
            tools: JSON.stringify(TOOLS)
          },
          query,
          response_mode: 'blocking',
          user: userId
        }),
        signal: controller.signal
      });

      const body = await response.text();
      if (!response.ok) throw new Error(`Dify HTTP ${response.status}: ${body.slice(0, 2000)}`);

      let data;
      try { data = JSON.parse(body); } catch { throw new Error(`Dify returned invalid JSON: ${body.slice(0, 1000)}`); }
      return parseDifyAnswer(data.answer);
    } finally {
      clearTimeout(timeout);
    }
  }

  async executeWithApproval(call) {
    const mutating = ['write_file', 'replace_text', 'run_command'].includes(call.name);
    let yolo = this.config().get('yoloMode', false);

    if (mutating && !yolo) {
      const detail = JSON.stringify(call.arguments, null, 2).slice(0, 5000);
      const choice = await vscode.window.showWarningMessage(
        `Dify wants to run: ${call.name}`,
        { modal: true, detail },
        'Allow once',
        'Enable YOLO',
        'Deny'
      );

      if (choice === 'Enable YOLO') {
        await this.config().update('yoloMode', true, vscode.ConfigurationTarget.Global);
        yolo = true;
        this.pushState();
      } else if (choice !== 'Allow once') {
        return { success: false, error: 'User denied this tool call.' };
      }
    }

    try {
      return await executeTool(call.name, call.arguments, this.config());
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async saveHistory() {
    await this.context.workspaceState.update('difyForVscode.history', this.history);
  }

  pushState() {
    const config = this.config();
    this.post({
      type: 'state',
      configured: !!config.get('baseUrl'),
      yolo: config.get('yoloMode', false),
      history: this.history.filter(m => m.role === 'user' || (m.role === 'assistant' && typeof m.content === 'string'))
    });
  }

  post(message) {
    if (this.view) this.view.webview.postMessage(message);
  }

  getHtml(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-sideBar-background); height: 100vh; overflow: hidden; }
  #app { display:flex; flex-direction:column; height:100vh; }
  .top { padding:10px 10px 8px; border-bottom:1px solid var(--vscode-panel-border); display:flex; gap:8px; align-items:center; }
  .title { font-weight:700; flex:1; }
  button { border:1px solid var(--vscode-button-border, transparent); border-radius:5px; padding:6px 9px; cursor:pointer; color:var(--vscode-button-foreground); background:var(--vscode-button-background); }
  button:hover { background:var(--vscode-button-hoverBackground); }
  button.secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
  .yolo { padding:5px 8px; font-size:11px; font-weight:700; }
  .yolo.on { background:var(--vscode-testing-iconFailed); color:white; }
  #messages { flex:1; overflow:auto; padding:12px 10px; display:flex; flex-direction:column; gap:10px; }
  .msg { border-radius:8px; padding:9px 10px; white-space:pre-wrap; word-break:break-word; line-height:1.45; }
  .user { background:var(--vscode-textBlockQuote-background); margin-left:20px; }
  .assistant { background:var(--vscode-editor-background); border:1px solid var(--vscode-panel-border); margin-right:10px; }
  .tool { font-size:12px; padding:7px 9px; border-radius:6px; border:1px solid var(--vscode-panel-border); color:var(--vscode-descriptionForeground); }
  .tool strong { color:var(--vscode-foreground); }
  .error { color:var(--vscode-errorForeground); border:1px solid var(--vscode-inputValidation-errorBorder); padding:8px; border-radius:6px; }
  .status { color:var(--vscode-descriptionForeground); font-size:12px; min-height:18px; padding:0 10px 4px; }
  .composer { border-top:1px solid var(--vscode-panel-border); padding:9px; }
  textarea { width:100%; min-height:74px; max-height:220px; resize:vertical; background:var(--vscode-input-background); color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius:6px; padding:8px; font-family:var(--vscode-font-family); }
  .actions { display:flex; justify-content:flex-end; gap:7px; margin-top:7px; }
  .empty { color:var(--vscode-descriptionForeground); padding:18px 8px; text-align:center; line-height:1.55; }
</style>
</head>
<body>
<div id="app">
  <div class="top">
    <div class="title">Dify Agent</div>
    <button id="yolo" class="secondary yolo" title="Auto-approve file writes and commands">YOLO OFF</button>
    <button id="new" class="secondary" title="New chat">New</button>
    <button id="config" class="secondary" title="Configure Dify">Config</button>
  </div>
  <div id="messages"><div class="empty" id="empty">Direct Dify coding agent.<br/>Try: <b>Inspect this project and fix the first obvious bug.</b></div></div>
  <div id="status" class="status"></div>
  <div class="composer">
    <textarea id="input" placeholder="Ask Dify to inspect, edit, test, or explain this workspace..."></textarea>
    <div class="actions"><button id="send">Send</button></div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  const send = document.getElementById('send');
  const status = document.getElementById('status');
  const yolo = document.getElementById('yolo');
  let busy = false;

  function removeEmpty(){ const e=document.getElementById('empty'); if(e) e.remove(); }
  function addMessage(role, content){ removeEmpty(); const d=document.createElement('div'); d.className='msg '+role; d.textContent=content; messages.appendChild(d); messages.scrollTop=messages.scrollHeight; }
  function addTool(name, text){ removeEmpty(); const d=document.createElement('div'); d.className='tool'; const strong=document.createElement('strong'); strong.textContent=name; d.appendChild(strong); d.appendChild(document.createTextNode('  '+text)); messages.appendChild(d); messages.scrollTop=messages.scrollHeight; }
  function doSend(){ const text=input.value.trim(); if(!text || busy) return; input.value=''; vscode.postMessage({type:'send', text}); }
  send.addEventListener('click', doSend);
  input.addEventListener('keydown', e=>{ if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); doSend(); }});
  document.getElementById('config').addEventListener('click', ()=>vscode.postMessage({type:'configure'}));
  document.getElementById('new').addEventListener('click', ()=>vscode.postMessage({type:'newChat'}));
  yolo.addEventListener('click', ()=>vscode.postMessage({type:'toggleYolo'}));

  window.addEventListener('message', event=>{
    const m=event.data;
    if(m.type==='state'){
      yolo.textContent=m.yolo?'YOLO ON':'YOLO OFF'; yolo.classList.toggle('on', !!m.yolo);
      if(messages.children.length===0 || (messages.children.length===1 && document.getElementById('empty'))){
        if(Array.isArray(m.history) && m.history.length){ messages.innerHTML=''; m.history.forEach(x=>addMessage(x.role, x.content)); }
      }
    }
    if(m.type==='message') addMessage(m.role, m.content);
    if(m.type==='tool'){
      const text=m.phase==='start' ? JSON.stringify(m.arguments) : JSON.stringify(m.result);
      addTool((m.phase==='start'?'RUN ':'DONE ')+m.name, text.length>600?text.slice(0,600)+'...':text);
    }
    if(m.type==='error'){ removeEmpty(); const d=document.createElement('div'); d.className='error'; d.textContent=m.message; messages.appendChild(d); messages.scrollTop=messages.scrollHeight; }
    if(m.type==='status') status.textContent=m.message||'';
    if(m.type==='running'){ busy=!!m.value; send.disabled=busy; input.disabled=busy; }
    if(m.type==='clear'){ messages.innerHTML='<div class="empty" id="empty">New chat started.</div>'; status.textContent=''; }
  });
</script>
</body>
</html>`;
  }
}

async function executeTool(name, args, config) {
  switch (name) {
    case 'get_workspace_info': return getWorkspaceInfo();
    case 'read_file': return readFileTool(args);
    case 'list_files': return listFilesTool(args);
    case 'search_files': return searchFilesTool(args);
    case 'write_file': return writeFileTool(args);
    case 'replace_text': return replaceTextTool(args);
    case 'run_command': return runCommandTool(args, config);
    case 'get_diagnostics': return diagnosticsTool(args);
    default: return { success: false, error: `Unknown tool: ${name}` };
  }
}

function workspaceRoot() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) throw new Error('Open a folder/workspace in VS Code first.');
  if (folder.uri.scheme !== 'file') throw new Error('This version currently supports local/remote file workspaces only.');
  return folder.uri.fsPath;
}

function safePath(relative = '') {
  const root = workspaceRoot();
  const target = path.resolve(root, relative || '.');
  const rootCmp = process.platform === 'win32' ? root.toLowerCase() : root;
  const targetCmp = process.platform === 'win32' ? target.toLowerCase() : target;
  if (targetCmp !== rootCmp && !targetCmp.startsWith(rootCmp + path.sep)) {
    throw new Error(`Path escapes the workspace: ${relative}`);
  }
  return target;
}

async function getWorkspaceInfo() {
  const root = workspaceRoot();
  const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(root));
  return {
    success: true,
    root,
    top_level: entries.slice(0, 200).map(([name, type]) => ({ name, type: type === vscode.FileType.Directory ? 'directory' : 'file' }))
  };
}

async function readFileTool(args) {
  const file = safePath(args.path);
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error('File is larger than 2 MiB.');
  const text = new TextDecoder('utf-8').decode(bytes);
  const lines = text.split(/\r?\n/);
  const start = Math.max(1, Number(args.start_line || 1));
  const end = Math.min(lines.length, Number(args.end_line || lines.length));
  if (end < start) throw new Error('end_line must be >= start_line.');
  const selected = lines.slice(start - 1, end).map((line, i) => `${start + i}: ${line}`).join('\n');
  return { success: true, path: args.path, start_line: start, end_line: end, total_lines: lines.length, content: selected };
}

async function listFilesTool(args) {
  const startPath = safePath(args.path || '');
  const root = workspaceRoot();
  const maxDepth = Math.max(0, Math.min(8, Number(args.max_depth ?? 3)));
  const out = [];
  const ignore = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build']);

  async function walk(current, depth) {
    if (out.length >= 1000) return;
    const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(current));
    for (const [name, type] of entries) {
      if (ignore.has(name)) continue;
      const full = path.join(current, name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      out.push({ path: rel, type: type === vscode.FileType.Directory ? 'directory' : 'file' });
      if (type === vscode.FileType.Directory && depth < maxDepth) await walk(full, depth + 1);
      if (out.length >= 1000) break;
    }
  }

  await walk(startPath, 0);
  return { success: true, entries: out, truncated: out.length >= 1000 };
}

async function searchFilesTool(args) {
  const query = String(args.query || '');
  if (!query) throw new Error('query is required.');
  const maxResults = Math.max(1, Math.min(200, Number(args.max_results || 50)));
  const glob = args.glob || '**/*';
  const files = await vscode.workspace.findFiles(glob, '**/{.git,node_modules,.venv,venv,dist,build}/**', 300);
  const root = workspaceRoot();
  const results = [];
  const needle = query.toLowerCase();

  for (const uri of files) {
    if (results.length >= maxResults) break;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 1024 * 1024) continue;
      const text = new TextDecoder('utf-8').decode(await vscode.workspace.fs.readFile(uri));
      if (text.includes('\u0000')) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < maxResults; i += 1) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push({ path: path.relative(root, uri.fsPath).replace(/\\/g, '/'), line: i + 1, text: lines[i].slice(0, 500) });
        }
      }
    } catch {}
  }
  return { success: true, query, results, truncated: results.length >= maxResults };
}

async function writeFileTool(args) {
  if (typeof args.content !== 'string') throw new Error('content must be a string.');
  const file = safePath(args.path);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)));
  await vscode.workspace.fs.writeFile(vscode.Uri.file(file), new TextEncoder().encode(args.content));
  return { success: true, path: args.path, bytes: Buffer.byteLength(args.content, 'utf8') };
}

async function replaceTextTool(args) {
  const file = safePath(args.path);
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
  const original = new TextDecoder('utf-8').decode(bytes);
  const oldText = String(args.old_text ?? '');
  const newText = String(args.new_text ?? '');
  if (!oldText) throw new Error('old_text cannot be empty.');
  const count = original.split(oldText).length - 1;
  if (count === 0) throw new Error('old_text was not found.');
  if (!args.replace_all && count !== 1) throw new Error(`old_text occurs ${count} times. Make it more specific or use replace_all.`);
  const updated = args.replace_all ? original.split(oldText).join(newText) : original.replace(oldText, newText);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(file), new TextEncoder().encode(updated));
  return { success: true, path: args.path, replacements: args.replace_all ? count : 1 };
}

async function runCommandTool(args, config) {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('command is required.');
  const cwd = safePath(args.cwd || '');
  const timeout = config.get('commandTimeoutMs', 120000);

  return await new Promise((resolve) => {
    exec(command, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        success: !error,
        command,
        cwd: path.relative(workspaceRoot(), cwd).replace(/\\/g, '/') || '.',
        exit_code: error && typeof error.code === 'number' ? error.code : (error ? null : 0),
        stdout: String(stdout || '').slice(-200000),
        stderr: String(stderr || '').slice(-200000),
        error: error ? error.message : undefined
      });
    });
  });
}

async function diagnosticsTool(args) {
  const root = workspaceRoot();
  let groups;
  if (args.path) {
    const uri = vscode.Uri.file(safePath(args.path));
    groups = [[uri, vscode.languages.getDiagnostics(uri)]];
  } else {
    groups = vscode.languages.getDiagnostics().filter(([uri]) => uri.scheme === 'file' && safeContains(root, uri.fsPath));
  }
  const items = [];
  for (const [uri, diagnostics] of groups) {
    for (const d of diagnostics) {
      items.push({
        path: path.relative(root, uri.fsPath).replace(/\\/g, '/'),
        line: d.range.start.line + 1,
        column: d.range.start.character + 1,
        severity: ['Error', 'Warning', 'Information', 'Hint'][d.severity] || String(d.severity),
        message: d.message,
        source: d.source || ''
      });
      if (items.length >= 300) break;
    }
    if (items.length >= 300) break;
  }
  return { success: true, diagnostics: items, truncated: items.length >= 300 };
}

function safeContains(root, target) {
  const r = process.platform === 'win32' ? root.toLowerCase() : root;
  const t = process.platform === 'win32' ? target.toLowerCase() : target;
  return t === r || t.startsWith(r + path.sep);
}

function parseDifyAnswer(answer) {
  if (typeof answer !== 'string') throw new Error('Dify response is missing the answer string.');
  let text = answer.trim();
  if (text.startsWith('```')) text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.type === 'message' && typeof parsed.content === 'string') return parsed;
    if (parsed && (parsed.type === 'tool_calls' || parsed.type === 'tool_call')) {
      if (parsed.type === 'tool_call') return { type: 'tool_calls', tool_calls: [parsed] };
      return parsed;
    }
  } catch {}
  return { type: 'message', content: answer };
}

function normalizeArguments(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  return {};
}

function normalizeBaseUrl(url) {
  let value = String(url || '').trim().replace(/\/+$/, '');
  if (value.endsWith('/chat-messages')) value = value.slice(0, -'/chat-messages'.length);
  if (!value.endsWith('/v1')) value += '/v1';
  return value;
}

module.exports = { activate, deactivate };
