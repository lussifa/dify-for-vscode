const vscode = require('vscode');
const compat = require('./compat');
const compatFetch = globalThis.fetch;
const localTools = require('./localTools');
const {
  initializePlatform, getPlatformTools, disposePlatform,
  configureEmbeddings, refreshMcpCommand, showMcpStatus,
  startBridgeCommand, stopBridgeCommand, copyBridgeConfig
} = require('./platform');
const { initializeAgentRuntime, runSubAgent, executeToolWithApproval } = require('./agentRuntime');
const { executeSemanticTool } = require('./semantic');

let extensionContext;

async function getAllTools() {
  const config = vscode.workspace.getConfiguration('difyForVscode');
  const platform = await getPlatformTools(config);
  const all = [...localTools.TOOLS, ...platform];
  const seen = new Set();
  return all.filter(t => {
    const name = t?.function?.name;
    if (!name || seen.has(name)) return false;
    seen.add(name); return true;
  });
}

globalThis.fetch = async function platformAwareFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : String(input?.url || input);
  if (!extensionContext || !url.endsWith('/chat-messages') || typeof init?.body !== 'string') return compatFetch(input, init);
  let body;
  try { body = JSON.parse(init.body); } catch { return compatFetch(input, init); }
  if (String(body.user || '').includes(':crew:')) return compatFetch(input, init);
  try {
    const existing = JSON.parse(body.inputs?.tools || '[]');
    const platform = await getPlatformTools(vscode.workspace.getConfiguration('difyForVscode'));
    const seen = new Set(existing.map(t => t?.function?.name).filter(Boolean));
    const merged = [...existing, ...platform.filter(t => t?.function?.name && !seen.has(t.function.name))];
    body.inputs = { ...(body.inputs || {}), tools: JSON.stringify(merged) };
    return compatFetch(input, { ...init, body: JSON.stringify(body) });
  } catch (error) {
    console.warn('[Dify for VS Code] platform tool injection failed', error);
    return compatFetch(input, init);
  }
};

function activate(context) {
  extensionContext = context;
  initializeAgentRuntime(context, { getAllTools });
  initializePlatform(context, {
    runSubAgent,
    onCrewEvent: event => console.log('[Dify Crew]', event),
    getAllTools,
    executeExternalTool: (name, args) => executeToolWithApproval({ id: `mcp_bridge_${Date.now()}`, name, arguments: args }, { source: 'mcp-bridge' })
  });

  compat.activate(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('difyForVscode.refreshMcp', refreshMcpCommand),
    vscode.commands.registerCommand('difyForVscode.showMcpStatus', showMcpStatus),
    vscode.commands.registerCommand('difyForVscode.startMcpServer', startBridgeCommand),
    vscode.commands.registerCommand('difyForVscode.stopMcpServer', stopBridgeCommand),
    vscode.commands.registerCommand('difyForVscode.copyMcpBridgeConfig', copyBridgeConfig),
    vscode.commands.registerCommand('difyForVscode.configureEmbeddings', configureEmbeddings),
    vscode.commands.registerCommand('difyForVscode.buildSemanticIndex', async () => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Building semantic workspace index', cancellable: false }, async () => {
        const result = await executeSemanticTool('semantic_index_build', {}, vscode.workspace.getConfiguration('difyForVscode'));
        vscode.window.showInformationMessage(`Semantic index ready: ${result.file_count} files / ${result.chunk_count} chunks (${result.provider}).`);
      });
    }),
    vscode.commands.registerCommand('difyForVscode.semanticIndexStatus', async () => {
      const result = await executeSemanticTool('semantic_index_status', {}, vscode.workspace.getConfiguration('difyForVscode'));
      vscode.window.showInformationMessage(result.exists ? `Semantic index: ${result.file_count} files, ${result.chunk_count} chunks, ${result.provider}/${result.model || ''}` : 'Semantic index has not been built yet.', { modal: true });
    })
  );

  if (vscode.workspace.getConfiguration('difyForVscode').get('mcpBridgeEnabled', false)) {
    setTimeout(() => startBridgeCommand().catch(error => console.warn('[Dify for VS Code] MCP bridge auto-start failed', error)), 1500);
  }
}

async function deactivate() {
  try { if (typeof compat.deactivate === 'function') compat.deactivate(); } finally { await disposePlatform(); extensionContext = undefined; }
}

module.exports = { activate, deactivate };
