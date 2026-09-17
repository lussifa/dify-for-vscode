const vscode = require('vscode');
const crypto = require('crypto');
const { TOOLS, MUTATING_TOOLS, executeTool } = require('./tools');
const { prepareContext, compactHistory, optionsFromConfig } = require('./contextManager');
const { getPlatformTools } = require('./platform');
const { getSkillContext } = require('./skills');

const SECRET_KEY = 'difyForVscode.apiKey';
const LLM_SECRET_KEY = 'difyForVscode.llmApiKey';
const VIEW_ID = 'difyForVscode.chatView';
const LLM_TIMEOUT_MS = 300000;

function activate(context) {
  const provider = new DifyChatViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('difyForVscode.configure', () => provider.configure()),
    vscode.commands.registerCommand('difyForVscode.newChat', () => provider.newChat()),
    vscode.commands.registerCommand('difyForVscode.toggleYolo', () => provider.toggleYolo()),
    vscode.commands.registerCommand('difyForVscode.toggleLlm', () => provider.toggleLlm()),
    vscode.commands.registerCommand('difyForVscode.configureLlm', () => provider.configureLlm())
  );
}
function deactivate() {}

class DifyChatViewProvider {
  constructor(context) {
    this.context = context;
    this.view = undefined;
    this.running = false;
    this.history = context.workspaceState.get('difyForVscode.history', []);
    const visible = this.history.filter(message => message?.role === 'user' || (message?.role === 'assistant' && typeof message.content === 'string'));
    this.displayHistory = context.workspaceState.get('difyForVscode.displayHistory', visible);
    this.lastContextStats = null;
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage(async msg => {
      try {
        if (msg.type === 'send') await this.sendUserMessage(String(msg.text || '').trim());
        if (msg.type === 'configure') await this.configure();
        if (msg.type === 'newChat') await this.newChat();
        if (msg.type === 'toggleYolo') await this.toggleYolo();
        if (msg.type === 'toggleLlm') await this.toggleLlm();
      } catch (error) {
        this.post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
        if (msg.type === 'send') this.post({ type: 'running', value: false });
      }
    });
    this.pushState();
  }

  config() { return vscode.workspace.getConfiguration('difyForVscode'); }

  async configure() {
    const config = this.config();
    const baseUrl = await vscode.window.showInputBox({ title: 'Dify for VS Code - Base URL', prompt: 'Dify API base URL, e.g. http://dify.example.local/v1', value: config.get('baseUrl', 'http://127.0.0.1/v1'), ignoreFocusOut: true });
    if (!baseUrl) return;
    const existing = await this.context.secrets.get(SECRET_KEY);
    const apiKey = await vscode.window.showInputBox({ title: 'Dify for VS Code - App API Key', prompt: existing ? 'Enter a new key, or cancel to keep the existing key.' : 'Enter the Dify App API key (app-...).', password: true, ignoreFocusOut: true });
    const userId = await vscode.window.showInputBox({ title: 'Dify for VS Code - User ID', value: config.get('userId', 'vscode-agent'), ignoreFocusOut: true });
    await config.update('baseUrl', normalizeBaseUrl(baseUrl), vscode.ConfigurationTarget.Global);
    if (apiKey) await this.context.secrets.store(SECRET_KEY, apiKey.trim());
    if (userId) await config.update('userId', userId.trim(), vscode.ConfigurationTarget.Global);
    this.pushState();
    vscode.window.showInformationMessage('Dify for VS Code configuration saved.');
  }

  async toggleYolo() {
    const config = this.config();
    const next = !config.get('yoloMode', false);
    if (next) {
      const choice = await vscode.window.showWarningMessage('Enable YOLO mode?', { modal: true, detail: 'YOLO automatically approves mutating file tools, browser actions, shell commands, Office writes and potentially mutating MCP tools requested by the model (Dify Chatflow or plain LLM).' }, 'Enable YOLO');
      if (choice !== 'Enable YOLO') return;
    }
    await config.update('yoloMode', next, vscode.ConfigurationTarget.Global);
    this.pushState();
  }

  async toggleLlm() {
    const config = this.config();
    const next = !config.get('llmMode', false);
    if (next) {
      const choice = await vscode.window.showWarningMessage('Switch to plain LLM mode?', { modal: true, detail: 'The extension will bypass the Dify Chatflow and call an OpenAI-compatible LLM directly. Local tools, Context Manager, approvals and YOLO keep working.' }, 'Switch to LLM');
      if (choice !== 'Switch to LLM') return;
      if (!(await this.ensureLlmConfigured())) return;
    }
    await config.update('llmMode', next, vscode.ConfigurationTarget.Global);
    this.pushState();
  }

  async ensureLlmConfigured() {
    const config = this.config();
    if (config.get('llmBaseUrl', '') && config.get('llmModel', '') && await this.context.secrets.get(LLM_SECRET_KEY)) return true;
    return this.configureLlm();
  }

  async configureLlm() {
    const config = this.config();
    const baseUrl = await vscode.window.showInputBox({ title: 'Dify for VS Code - LLM Base URL', prompt: 'OpenAI-compatible base URL, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1', value: config.get('llmBaseUrl', 'https://api.openai.com/v1'), ignoreFocusOut: true });
    if (!baseUrl) return false;
    const model = await vscode.window.showInputBox({ title: 'Dify for VS Code - LLM Model', prompt: 'Model name, e.g. gpt-4o-mini, deepseek-chat or qwen-plus', value: config.get('llmModel', ''), ignoreFocusOut: true });
    if (!model) return false;
    const existing = await this.context.secrets.get(LLM_SECRET_KEY);
    const apiKey = await vscode.window.showInputBox({ title: 'Dify for VS Code - LLM API Key', prompt: existing ? 'Enter a new key, or cancel to keep the existing key.' : 'Enter the LLM provider API key.', password: true, ignoreFocusOut: true });
    await config.update('llmBaseUrl', normalizeLlmBaseUrl(baseUrl), vscode.ConfigurationTarget.Global);
    await config.update('llmModel', model.trim(), vscode.ConfigurationTarget.Global);
    if (apiKey) await this.context.secrets.store(LLM_SECRET_KEY, apiKey.trim());
    const hasKey = Boolean(apiKey || existing);
    this.pushState();
    if (hasKey) vscode.window.showInformationMessage('Dify for VS Code LLM configuration saved.');
    return hasKey;
  }

  async newChat() {
    if (this.running) { vscode.window.showWarningMessage('An agent task is currently running.'); return; }
    this.history = [];
    this.displayHistory = [];
    this.lastContextStats = null;
    await this.saveHistory();
    this.post({ type: 'clear' });
    this.pushState();
  }

  async sendUserMessage(text) {
    if (!text || this.running) return;
    const llmMode = this.config().get('llmMode', false);
    const apiKey = llmMode ? await this.context.secrets.get(LLM_SECRET_KEY) : await this.context.secrets.get(SECRET_KEY);
    if (!apiKey) {
      this.post({ type: 'error', message: llmMode ? 'LLM API key is not configured.' : 'Dify API key is not configured.' });
      this.post({ type: 'running', value: false });
      if (llmMode) await this.configureLlm();
      else await this.configure();
      return;
    }
    this.running = true;
    const userMessage = { role: 'user', content: text };
    this.history.push(userMessage);
    this.displayHistory.push(userMessage);
    await this.saveHistory();
    this.post({ type: 'message', role: 'user', content: text });
    this.post({ type: 'running', value: true });
    try {
      await this.agentLoop(text, apiKey, llmMode);
    } finally {
      this.compactExecutionHistory();
      await this.saveHistory();
      this.running = false;
      this.post({ type: 'running', value: false });
      this.pushState();
    }
  }

  compactExecutionHistory() {
    const compacted = compactHistory(this.history, optionsFromConfig(this.config()));
    this.history = compacted.history;
  }

  async agentLoop(firstQuery, apiKey, llmMode) {
    const maxSteps = this.config().get('maxAgentSteps', 40);
    const engineName = llmMode ? 'LLM' : 'Dify';
    let query = firstQuery;
    for (let step = 1; step <= maxSteps; step += 1) {
      this.post({ type: 'status', message: `${engineName} thinking - step ${step}/${maxSteps}` });
      const decision = llmMode ? await this.callLlm(query, apiKey) : await this.callDify(query, apiKey);
      if (decision.type === 'message') {
        const content = String(decision.content || '');
        const assistantMessage = { role: 'assistant', content };
        this.history.push(assistantMessage);
        this.displayHistory.push(assistantMessage);
        await this.saveHistory();
        this.post({ type: 'message', role: 'assistant', content });
        this.post({ type: 'status', message: '' });
        return;
      }
      if (decision.type !== 'tool_calls' || !Array.isArray(decision.tool_calls) || !decision.tool_calls.length) throw new Error(`${engineName} returned neither a message nor valid tool_calls.`);
      const calls = decision.tool_calls.map((call, index) => ({ id: call.id || `call_${Date.now()}_${index}`, name: String(call.name || call.function?.name || ''), arguments: normalizeArguments(call.arguments ?? call.function?.arguments) }));
      this.history.push({ role: 'assistant', content: null, tool_calls: calls });
      for (const call of calls) {
        this.post({ type: 'tool', phase: 'start', name: call.name, arguments: call.arguments });
        const result = await this.executeWithApproval(call, engineName);
        this.history.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify(result) });
        this.post({ type: 'tool', phase: 'end', name: call.name, result });
      }
      await this.saveHistory();
      query = 'Continue using the latest tool results in messages. Call more tools if needed, ask the user only if truly blocked, otherwise finish with the final answer.';
    }
    throw new Error(`Agent stopped after reaching maxAgentSteps (${maxSteps}).`);
  }

  async callDify(query, apiKey) {
    const config = this.config();
    const baseUrl = normalizeBaseUrl(config.get('baseUrl', 'http://127.0.0.1/v1'));
    const prepared = prepareContext(this.history, optionsFromConfig(config));
    this.lastContextStats = prepared.stats;
    this.post({ type: 'context', stats: prepared.stats });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000);
    try {
      const response = await fetch(`${baseUrl}/chat-messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs: { messages: JSON.stringify(prepared.messages), tools: JSON.stringify(TOOLS) }, query, response_mode: 'blocking', user: config.get('userId', 'vscode-agent') }),
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`Dify HTTP ${response.status}: ${body.slice(0, 2000)}`);
      let data;
      try { data = JSON.parse(body); }
      catch { throw new Error(`Dify returned invalid JSON: ${body.slice(0, 1000)}`); }
      return parseDifyAnswer(data.answer);
    } finally { clearTimeout(timeout); }
  }

  async callLlm(query, apiKey) {
    const config = this.config();
    const baseUrl = normalizeLlmBaseUrl(config.get('llmBaseUrl', 'https://api.openai.com/v1'));
    const model = String(config.get('llmModel', '') || '').trim();
    if (!model) throw new Error('LLM model is not configured. Run "Dify for VS Code: Configure LLM" or set difyForVscode.llmModel.');
    const prepared = prepareContext(this.history, optionsFromConfig(config));
    this.lastContextStats = prepared.stats;
    this.post({ type: 'context', stats: prepared.stats });
    const messages = [{ role: 'system', content: this.llmSystemPrompt(config) }, ...toOpenAiMessages(prepared.messages)];
    if (config.get('skillsEnabled', true)) {
      try {
        const skillContext = await getSkillContext(config);
        if (skillContext) {
          messages[0] = { role: 'system', content: `${messages[0].content}\n\n[Dify for VS Code skills]\n${skillContext}` };
        }
      } catch (error) {
        console.warn('[Dify for VS Code] skill context injection failed', error);
      }
    }
    const platform = await getPlatformTools(config);
    const tools = mergeToolSchemas(TOOLS, platform);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: config.get('llmTemperature', 0.2) }),
        signal: controller.signal
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`LLM HTTP ${response.status}: ${body.slice(0, 2000)}`);
      let data;
      try { data = JSON.parse(body); }
      catch { throw new Error(`LLM returned invalid JSON: ${body.slice(0, 1000)}`); }
      return parseLlmChoice(data);
    } finally { clearTimeout(timeout); }
  }

  llmSystemPrompt(config) {
    const override = String(config.get('llmSystemPrompt', '') || '').trim();
    if (override) return override;
    return [
      'You are Dify for VS Code running in plain LLM mode: an agent that helps with coding, Office documents, browser automation, shell and Git operations inside the current VS Code workspace.',
      'You have access to the exact tool list provided in this request. Reason step by step: call tools when they help, then continue from the tool results.',
      'Return a final plain-text answer to the user when the task is complete. If you are blocked and truly need the user, use the ask_user tool. Never fabricate tool results.',
      'For documents and spreadsheets, prefer the native Office tools (ppt_create, excel_create, word_create) instead of hand-written formats.'
    ].join(' ');
  }

  async executeWithApproval(call, engineName = 'Dify') {
    let yolo = this.config().get('yoloMode', false);
    if (MUTATING_TOOLS.has(call.name) && !yolo) {
      const choice = await vscode.window.showWarningMessage(`${engineName} wants to run: ${call.name}`, { modal: true, detail: JSON.stringify(call.arguments, null, 2).slice(0, 7000) }, 'Allow once', 'Enable YOLO', 'Deny');
      if (choice === 'Enable YOLO') {
        await this.config().update('yoloMode', true, vscode.ConfigurationTarget.Global);
        yolo = true;
        this.pushState();
      } else if (choice !== 'Allow once') {
        return { success: false, error: 'User denied this tool call.' };
      }
    }
    try { return await executeTool(call.name, call.arguments, this.config()); }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  async saveHistory() {
    await Promise.all([
      this.context.workspaceState.update('difyForVscode.history', this.history),
      this.context.workspaceState.update('difyForVscode.displayHistory', this.displayHistory)
    ]);
  }

  pushState() {
    this.post({
      type: 'state',
      configured: !!this.config().get('baseUrl'),
      yolo: this.config().get('yoloMode', false),
      llmMode: this.config().get('llmMode', false),
      toolCount: TOOLS.length,
      history: this.displayHistory,
      context: this.lastContextStats
    });
  }
  post(message) { if (this.view) this.view.webview.postMessage(message); }

  getHtml(webview) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"><style>
*{box-sizing:border-box}body{margin:0;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);height:100vh;overflow:hidden}#app{display:flex;flex-direction:column;height:100vh}.top{padding:9px;border-bottom:1px solid var(--vscode-panel-border);display:flex;gap:6px;align-items:center}.title{font-weight:700;flex:1}.meta{font-size:10px;color:var(--vscode-descriptionForeground)}button{border:1px solid var(--vscode-button-border,transparent);border-radius:5px;padding:5px 8px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button:disabled{opacity:.78;cursor:wait}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.yolo.on{background:var(--vscode-testing-iconFailed);color:white}.llm.on{background:var(--vscode-charts-blue,#2563eb);color:white}#messages{flex:1;overflow:auto;padding:12px 10px;display:flex;flex-direction:column;gap:9px}.msg{border-radius:8px;padding:9px 10px;white-space:pre-wrap;word-break:break-word;line-height:1.45}.user{background:var(--vscode-textBlockQuote-background);margin-left:18px}.assistant{background:var(--vscode-editor-background);border:1px solid var(--vscode-panel-border);margin-right:8px}.tool{font-size:11px;padding:7px 9px;border-radius:6px;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);white-space:pre-wrap;word-break:break-word}.error{color:var(--vscode-errorForeground);border:1px solid var(--vscode-inputValidation-errorBorder);padding:8px;border-radius:6px}.status{color:var(--vscode-descriptionForeground);font-size:11px;min-height:20px;padding:1px 10px 5px;display:flex;align-items:center;gap:6px}.status.running::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--vscode-progressBar-background);animation:pulse 1.1s ease-in-out infinite}.composer{border-top:1px solid var(--vscode-panel-border);padding:9px}textarea{width:100%;min-height:74px;max-height:220px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:6px;padding:8px;font-family:var(--vscode-font-family)}.actions{display:flex;justify-content:flex-end;margin-top:6px}.empty{color:var(--vscode-descriptionForeground);padding:18px 8px;text-align:center;line-height:1.55}#send{min-width:78px;display:inline-flex;align-items:center;justify-content:center;gap:7px}.spinner{display:none;width:13px;height:13px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .75s linear infinite}#send.running .spinner{display:inline-block}@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
</style></head><body><div id="app"><div class="top"><div><div class="title" id="title">Dify Agent</div><div id="meta" class="meta"></div></div><button id="llm" class="secondary llm" title="Use a plain OpenAI-compatible LLM instead of the Dify Chatflow">LLM OFF</button><button id="yolo" class="secondary yolo">YOLO OFF</button><button id="new" class="secondary" title="Start a clean conversation">+ New Chat</button><button id="config" class="secondary">Config</button></div><div id="messages"><div class="empty" id="empty">Direct Dify agent platform.<br>Ask it to code, research, automate files, or create Office documents.</div></div><div id="status" class="status"></div><div class="composer"><textarea id="input" placeholder="Ask Dify to work on this workspace..."></textarea><div class="actions"><button id="send"><span class="spinner"></span><span id="sendLabel">Send</span></button></div></div></div><script nonce="${nonce}">
const vscode=acquireVsCodeApi(),messages=document.getElementById('messages'),input=document.getElementById('input'),send=document.getElementById('send'),sendLabel=document.getElementById('sendLabel'),status=document.getElementById('status'),yolo=document.getElementById('yolo'),llm=document.getElementById('llm'),title=document.getElementById('title'),meta=document.getElementById('meta');let busy=false,toolCount=0,lastContext=null;function empty(){const e=document.getElementById('empty');if(e)e.remove()}function msg(role,content){empty();const d=document.createElement('div');d.className='msg '+role;d.textContent=content;messages.appendChild(d);messages.scrollTop=messages.scrollHeight}function tool(name,text){empty();const d=document.createElement('div');d.className='tool';d.textContent=name+'  '+text;messages.appendChild(d);messages.scrollTop=messages.scrollHeight}function refreshMeta(){let text=toolCount+' local tools + dynamic platform tools';if(lastContext&&lastContext.enabled){const used=Math.round((lastContext.outboundChars||0)/1000),cap=Math.round((lastContext.maxChars||0)/1000);text+=' | context '+used+'k/'+cap+'k';if(lastContext.summarizedTasks)text+=' | '+lastContext.summarizedTasks+' summarized'}meta.textContent=text}function setBusy(value){busy=!!value;send.disabled=busy;input.disabled=busy;send.classList.toggle('running',busy);sendLabel.textContent=busy?'Working':'Send';status.classList.toggle('running',busy);if(busy&&!status.textContent.trim())status.textContent='Task is running...';if(!busy&&status.textContent.trim()==='Task is running...')status.textContent=''}function go(){const text=input.value.trim();if(!text||busy)return;input.value='';setBusy(true);vscode.postMessage({type:'send',text})}send.onclick=go;input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();go()}};document.getElementById('config').onclick=()=>vscode.postMessage({type:'configure'});document.getElementById('new').onclick=()=>vscode.postMessage({type:'newChat'});yolo.onclick=()=>vscode.postMessage({type:'toggleYolo'});llm.onclick=()=>vscode.postMessage({type:'toggleLlm'});window.addEventListener('message',e=>{const m=e.data;if(m.type==='state'){yolo.textContent=m.yolo?'YOLO ON':'YOLO OFF';yolo.classList.toggle('on',!!m.yolo);llm.textContent=m.llmMode?'LLM ON':'LLM OFF';llm.classList.toggle('on',!!m.llmMode);title.textContent=m.llmMode?'LLM Agent':'Dify Agent';input.placeholder=m.llmMode?'Ask the LLM agent to work on this workspace...':'Ask Dify to work on this workspace...';toolCount=m.toolCount||0;lastContext=m.context||lastContext;refreshMeta();if((messages.children.length===0)||(messages.children.length===1&&document.getElementById('empty'))){if(Array.isArray(m.history)&&m.history.length){messages.innerHTML='';m.history.forEach(x=>msg(x.role,x.content))}}}if(m.type==='context'){lastContext=m.stats||null;refreshMeta()}if(m.type==='message')msg(m.role,m.content);if(m.type==='tool'){const t=m.phase==='start'?JSON.stringify(m.arguments):JSON.stringify(m.result);tool((m.phase==='start'?'RUN ':'DONE ')+m.name,t.length>1000?t.slice(0,1000)+'...':t)}if(m.type==='error'){empty();const d=document.createElement('div');d.className='error';d.textContent=m.message;messages.appendChild(d);messages.scrollTop=messages.scrollHeight}if(m.type==='status'){status.textContent=m.message||(busy?'Task is running...':'')}if(m.type==='running')setBusy(m.value);if(m.type==='clear'){messages.innerHTML='<div class="empty" id="empty">New chat started. Context is empty.</div>';status.textContent='';lastContext=null;refreshMeta();setBusy(false)}});
</script></body></html>`;
  }
}

function stripReasoning(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .trim();
}
function extractJson(text) {
  const source = stripReasoning(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(source); } catch {}
  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) {
        try { return JSON.parse(source.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  return null;
}
function parseDifyAnswer(answer) {
  if (typeof answer !== 'string') throw new Error('Dify response is missing the answer string.');
  const parsed = extractJson(answer);
  if (parsed && parsed.type === 'message' && typeof parsed.content === 'string') return { type: 'message', content: parsed.content };
  if (parsed && (parsed.type === 'tool_calls' || parsed.type === 'tool_call')) return parsed.type === 'tool_call' ? { type: 'tool_calls', tool_calls: [parsed] } : parsed;
  return { type: 'message', content: stripReasoning(answer) };
}
function normalizeArguments(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return {};
}
function normalizeBaseUrl(url) {
  let value = String(url || '').trim().replace(/\/+$/, '');
  if (value.endsWith('/chat-messages')) value = value.slice(0, -'/chat-messages'.length);
  if (!value.endsWith('/v1')) value += '/v1';
  return value;
}
function normalizeLlmBaseUrl(url) {
  let value = String(url || '').trim().replace(/\/+$/, '');
  if (value.endsWith('/chat/completions')) value = value.slice(0, -'/chat/completions'.length);
  if (!value.endsWith('/v1')) value += '/v1';
  return value;
}
function toOpenAiMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(message => {
    if (!message || typeof message !== 'object') return message;
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content };
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return message;
    return {
      ...message,
      tool_calls: message.tool_calls.map(call => ({
        id: call && call.id ? call.id : `call_${Date.now()}`,
        type: 'function',
        function: {
          name: String((call && call.name) || (call && call.function && call.function.name) || ''),
          arguments: typeof (call && (call.arguments ?? call.function?.arguments)) === 'string' ? call.arguments ?? call.function.arguments : JSON.stringify(call.arguments ?? call.function?.arguments ?? {})
        }
      }))
    };
  });
}
function parseLlmChoice(data) {
  const choice = data && data.choices && data.choices[0];
  const message = (choice && choice.message) || {};
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    const tool_calls = message.tool_calls.map(call => ({
      id: call && call.id ? call.id : `call_${Date.now()}`,
      name: String((call && call.function && call.function.name) || ''),
      arguments: normalizeArguments(call && call.function && call.function.arguments)
    })).filter(call => call.name);
    if (tool_calls.length) return { type: 'tool_calls', tool_calls };
  }
  const content = String(message.content || '');
  if (choice && choice.finish_reason === 'length' && !content) throw new Error('LLM response was truncated (finish_reason=length).');
  return { type: 'message', content: stripReasoning(content) };
}
function mergeToolSchemas(...groups) {
  const seen = new Set();
  const merged = [];
  for (const group of groups) {
    for (const tool of Array.isArray(group) ? group : []) {
      const name = tool && tool.function && tool.function.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      merged.push(tool);
    }
  }
  return merged;
}
module.exports = { activate, deactivate, toOpenAiMessages, parseLlmChoice, normalizeLlmBaseUrl, mergeToolSchemas };
