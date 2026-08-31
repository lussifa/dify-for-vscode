const vscode = require('vscode');

const MCP_STATIC_TOOLS = [
  fn('mcp_refresh', 'Reconnect configured MCP servers and refresh their discovered tools.', obj({})),
  fn('mcp_list_servers', 'List configured MCP servers, connection state, errors, and discovered tool counts.', obj({})),
  fn('mcp_call_tool', 'Call a tool on a configured MCP server by server name and native MCP tool name. Dynamic mcp__server__tool wrappers are preferred when available.', obj({ server:str(), tool:str(), arguments:{type:'object'} }, ['server','tool']))
];

let stateKey='';
let records=new Map();
let dynamicTools=[];
let dynamicMeta=new Map();

function fn(name,description,parameters){return {type:'function',function:{name,description,parameters}};}
function str(description){return {type:'string',...(description?{description}:{})};}
function obj(properties,required=[]){return {type:'object',properties,...(required.length?{required}:{}),additionalProperties:false};}
function sanitize(value){return String(value||'').replace(/[^A-Za-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,70)||'tool';}
function resolveVars(value){
  if(typeof value==='string')return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g,(_,n)=>process.env[n]||'');
  if(Array.isArray(value))return value.map(resolveVars);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveVars(v)]));
  return value;
}
function configObject(config){return resolveVars(config?.get?.('mcpServers',{})||{});}

async function getMcpTools(config){
  await ensure(config);
  return [...MCP_STATIC_TOOLS,...dynamicTools];
}
function isMcpTool(name){return name==='mcp_refresh'||name==='mcp_list_servers'||name==='mcp_call_tool'||dynamicMeta.has(name);}
function isMcpMutating(name){
  if(name==='mcp_call_tool')return true;
  const meta=dynamicMeta.get(name);
  return meta ? meta.mutating : false;
}

async function ensure(config){
  const servers=configObject(config);
  const key=JSON.stringify(servers);
  if(key===stateKey&&records.size)return;
  await refresh(config);
}

async function refresh(config){
  await closeAll();
  const servers=configObject(config);
  stateKey=JSON.stringify(servers);
  dynamicTools=[];dynamicMeta=new Map();records=new Map();
  for(const [name,raw] of Object.entries(servers)){
    if(!raw||raw.enabled===false)continue;
    const rec={name,config:raw,status:'connecting',client:null,transport:null,tools:[],error:null};
    records.set(name,rec);
    try{
      const connected=await connectServer(name,raw);
      Object.assign(rec,connected,{status:'connected'});
      for(const tool of rec.tools){
        const wrapper=`mcp__${sanitize(name)}__${sanitize(tool.name)}`;
        const schema={
          type:'function',
          function:{
            name:wrapper,
            description:`MCP ${name}/${tool.name}: ${tool.description||'No description.'}`,
            parameters:normalizeSchema(tool.inputSchema)
          }
        };
        dynamicTools.push(schema);
        dynamicMeta.set(wrapper,{server:name,tool:tool.name,mutating:tool.annotations?.readOnlyHint!==true,annotations:tool.annotations||{}});
      }
    }catch(error){
      rec.status='error';rec.error=error instanceof Error?error.message:String(error);
    }
  }
  return listServers();
}

async function connectServer(name,cfg){
  const [clientMod,stdioMod]=await Promise.all([
    import('@modelcontextprotocol/client'),
    import('@modelcontextprotocol/client/stdio').catch(()=>({}))
  ]);
  const {Client,StreamableHTTPClientTransport,SSEClientTransport}=clientMod;
  const {StdioClientTransport}=stdioMod;
  const client=new Client({name:`dify-for-vscode-${sanitize(name)}`,version:'0.3.0'});
  const transportType=String(cfg.transport|| (cfg.command?'stdio':(cfg.url?'http':'stdio'))).toLowerCase();
  let transport;
  if(transportType==='stdio'){
    if(!cfg.command)throw new Error('stdio MCP server requires command.');
    if(!StdioClientTransport)throw new Error('MCP stdio transport is unavailable in installed SDK.');
    transport=new StdioClientTransport({command:String(cfg.command),args:Array.isArray(cfg.args)?cfg.args.map(String):[],env:{...process.env,...(cfg.env||{})},cwd:cfg.cwd||undefined,stderr:'pipe'});
  }else if(transportType==='sse'){
    if(!SSEClientTransport)throw new Error('MCP SSE compatibility transport is unavailable in installed SDK.');
    transport=new SSEClientTransport(new URL(String(cfg.url)),{requestInit:{headers:cfg.headers||{}}});
  }else{
    if(!StreamableHTTPClientTransport)throw new Error('MCP Streamable HTTP transport is unavailable in installed SDK.');
    transport=new StreamableHTTPClientTransport(new URL(String(cfg.url)),{requestInit:{headers:cfg.headers||{}}});
  }
  await withTimeout(client.connect(transport),Number(cfg.connectionTimeoutMs||15000),'MCP connect timeout');
  const listed=await withTimeout(client.listTools(),Number(cfg.discoveryTimeoutMs||20000),'MCP tool discovery timeout');
  return {client,transport,tools:Array.isArray(listed.tools)?listed.tools:[]};
}

function normalizeSchema(schema){
  if(!schema||typeof schema!=='object')return {type:'object',properties:{},additionalProperties:true};
  const copy=JSON.parse(JSON.stringify(schema));
  if(!copy.type)copy.type='object';
  if(copy.type==='object'&&!copy.properties)copy.properties={};
  return copy;
}

async function executeMcpTool(name,args={},config){
  if(name==='mcp_refresh')return refresh(config);
  await ensure(config);
  if(name==='mcp_list_servers')return listServers();
  if(name==='mcp_call_tool')return callNative(String(args.server||''),String(args.tool||''),args.arguments||{},config);
  const meta=dynamicMeta.get(name);
  if(!meta)return {success:false,error:`Unknown MCP tool: ${name}`};
  return callNative(meta.server,meta.tool,args,config);
}

async function callNative(serverName,toolName,args,config){
  await ensure(config);
  const rec=records.get(serverName);
  if(!rec||rec.status!=='connected'||!rec.client)throw new Error(`MCP server '${serverName}' is not connected${rec?.error?`: ${rec.error}`:''}.`);
  const timeout=Math.max(1000,Math.min(300000,Number(rec.config.toolTimeoutMs||60000)));
  const result=await withTimeout(rec.client.callTool({name:toolName,arguments:args||{}}),timeout,`MCP tool ${serverName}/${toolName} timed out`);
  return {success:!result.isError,server:serverName,tool:toolName,is_error:!!result.isError,content:result.content||[],structured_content:result.structuredContent};
}

function listServers(){
  return {success:true,servers:Array.from(records.values()).map(r=>({name:r.name,status:r.status,transport:r.config.transport||(r.config.command?'stdio':'http'),tool_count:r.tools.length,tools:r.tools.map(t=>t.name),error:r.error}))};
}

async function closeAll(){
  for(const rec of records.values()){
    try{await rec.client?.close?.();}catch{}
    try{await rec.transport?.close?.();}catch{}
  }
  records.clear();dynamicTools=[];dynamicMeta=new Map();
}
function withTimeout(promise,ms,message){
  let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);})]).finally(()=>clearTimeout(timer));
}

module.exports={MCP_STATIC_TOOLS,getMcpTools,isMcpTool,isMcpMutating,executeMcpTool,refreshMcp:refresh,closeMcp:closeAll,listMcpServers:listServers};
