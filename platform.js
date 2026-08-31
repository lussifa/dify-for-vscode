const vscode = require('vscode');
const { BROWSER_TOOLS, BROWSER_MUTATING, executeBrowserTool, closeBrowser } = require('./browser');
const { SEMANTIC_TOOLS, SEMANTIC_MUTATING, initializeSemantic, executeSemanticTool } = require('./semantic');
const { CREW_TOOLS, initializeCrew, executeCrewTool } = require('./crew');
const { MCP_STATIC_TOOLS, getMcpTools, isMcpTool, isMcpMutating, executeMcpTool, refreshMcp, closeMcp, listMcpServers } = require('./mcp');
const { initializeMcpServer, startMcpServer, stopMcpServer, statusMcpServer, getMcpBridgeConfig } = require('./mcpServer');

const browserNames=new Set(BROWSER_TOOLS.map(t=>t.function.name));
const semanticNames=new Set(SEMANTIC_TOOLS.map(t=>t.function.name));
const crewNames=new Set(CREW_TOOLS.map(t=>t.function.name));
let extensionContext;
let runtime={};

function initializePlatform(context,options={}){
  extensionContext=context;runtime={...options};
  initializeSemantic(context,{getEmbeddingApiKey:async()=>context.secrets.get('difyForVscode.embeddingApiKey')||''});
  initializeCrew({
    runSubAgent:options.runSubAgent,
    onCrewEvent:options.onCrewEvent,
    saveMemory:async(text,tags,source)=>executeSemanticTool('memory_save',{text,tags,source},vscode.workspace.getConfiguration('difyForVscode'))
  });
  initializeMcpServer({
    getTools:async()=>options.getAllTools?options.getAllTools():[],
    executeTool:async(name,args)=>options.executeExternalTool?options.executeExternalTool(name,args):{success:false,error:'Bridge executor unavailable.'}
  });
}

async function getPlatformTools(config){
  const mcp=await getMcpTools(config).catch(error=>{
    console.warn('[Dify for VS Code] MCP discovery failed',error);
    return MCP_STATIC_TOOLS;
  });
  return [...BROWSER_TOOLS,...SEMANTIC_TOOLS,...CREW_TOOLS,...mcp];
}
function isPlatformTool(name){return browserNames.has(name)||semanticNames.has(name)||crewNames.has(name)||isMcpTool(name);}
function isPlatformMutating(name){return BROWSER_MUTATING.has(name)||SEMANTIC_MUTATING.has(name)||isMcpMutating(name);}
async function executePlatformTool(name,args,config){
  if(browserNames.has(name))return executeBrowserTool(name,args,config);
  if(semanticNames.has(name))return executeSemanticTool(name,args,config);
  if(crewNames.has(name))return executeCrewTool(name,args,config);
  if(isMcpTool(name))return executeMcpTool(name,args,config);
  return {success:false,error:`Unknown platform tool: ${name}`};
}
async function disposePlatform(){await Promise.allSettled([closeBrowser(),closeMcp(),stopMcpServer()]);}

async function configureEmbeddings(){
  if(!extensionContext)throw new Error('Platform not initialized.');
  const config=vscode.workspace.getConfiguration('difyForVscode');
  const base=await vscode.window.showInputBox({title:'Semantic Embeddings - Base URL',prompt:'OpenAI-compatible base URL, e.g. http://127.0.0.1:11434/v1. Leave empty to use the local hash-vector fallback.',value:config.get('semanticEmbeddingBaseUrl',''),ignoreFocusOut:true});
  if(base===undefined)return;
  const model=await vscode.window.showInputBox({title:'Semantic Embeddings - Model',prompt:'Embedding model, e.g. nomic-embed-text or text-embedding-3-small.',value:config.get('semanticEmbeddingModel',''),ignoreFocusOut:true});
  if(model===undefined)return;
  const current=await extensionContext.secrets.get('difyForVscode.embeddingApiKey');
  const key=await vscode.window.showInputBox({title:'Semantic Embeddings - API Key',prompt:current?'Enter a new key or leave empty to keep the existing key.':'Optional for local/Ollama endpoints.',password:true,ignoreFocusOut:true});
  await config.update('semanticEmbeddingBaseUrl',String(base).trim().replace(/\/+$/,''),vscode.ConfigurationTarget.Global);
  await config.update('semanticEmbeddingModel',String(model).trim(),vscode.ConfigurationTarget.Global);
  if(key)await extensionContext.secrets.store('difyForVscode.embeddingApiKey',key.trim());
  vscode.window.showInformationMessage(base&&model?'Semantic embeddings configured.':'Semantic embeddings endpoint cleared; local hash-vector fallback will be used.');
}

async function refreshMcpCommand(){
  const result=await refreshMcp(vscode.workspace.getConfiguration('difyForVscode'));
  vscode.window.showInformationMessage(`MCP refresh complete: ${result.servers.filter(s=>s.status==='connected').length}/${result.servers.length} servers connected.`);
  return result;
}
async function showMcpStatus(){
  const result=listMcpServers();
  const text=result.servers.length?result.servers.map(s=>`${s.name}: ${s.status} (${s.tool_count} tools)${s.error?` - ${s.error}`:''}`).join('\n'):'No MCP servers configured/connected.';
  vscode.window.showInformationMessage(text,{modal:true});
  return result;
}
async function startBridgeCommand(){
  const result=await startMcpServer(extensionContext,vscode.workspace.getConfiguration('difyForVscode'));
  const cfg=await getMcpBridgeConfig(extensionContext);
  const action=await vscode.window.showInformationMessage(`VS Code MCP bridge running at ${result.url}`,'Copy Client Config');
  if(action==='Copy Client Config')await vscode.env.clipboard.writeText(JSON.stringify(cfg,null,2));
  return result;
}
async function stopBridgeCommand(){const r=await stopMcpServer();vscode.window.showInformationMessage('VS Code MCP bridge stopped.');return r;}
async function copyBridgeConfig(){const cfg=await getMcpBridgeConfig(extensionContext);await vscode.env.clipboard.writeText(JSON.stringify(cfg,null,2));vscode.window.showInformationMessage('MCP bridge client config copied.');return cfg;}

module.exports={
  initializePlatform,getPlatformTools,isPlatformTool,isPlatformMutating,executePlatformTool,disposePlatform,
  configureEmbeddings,refreshMcpCommand,showMcpStatus,startBridgeCommand,stopBridgeCommand,copyBridgeConfig,statusMcpServer
};
