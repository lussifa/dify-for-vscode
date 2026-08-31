const http = require('http');
const crypto = require('crypto');

let httpServer;
let runtime={};
let token='';
let currentPort=0;
let nodeHandler;

function initializeMcpServer(options={}){runtime={...runtime,...options};}

async function startMcpServer(context,config){
  if(httpServer)return status();
  if(typeof runtime.getTools!=='function'||typeof runtime.executeTool!=='function')throw new Error('MCP bridge runtime is not initialized.');
  const port=Math.max(1024,Math.min(65535,Number(config?.get?.('mcpBridgePort',8765)||8765)));
  const requireToken=config?.get?.('mcpBridgeRequireToken',true)!==false;
  token=requireToken?(await context.secrets.get('difyForVscode.mcpBridgeToken')||crypto.randomBytes(24).toString('hex')):'';
  if(requireToken)await context.secrets.store('difyForVscode.mcpBridgeToken',token);

  const [{McpServer,createMcpHandler},{toNodeHandler}]=await Promise.all([
    import('@modelcontextprotocol/server'),
    import('@modelcontextprotocol/node')
  ]);

  const factory=()=>{
    const s=new McpServer({name:'dify-for-vscode',version:'0.3.0'},{capabilities:{tools:{}}});
    s.server.setRequestHandler('tools/list',async()=>({
      tools:(await runtime.getTools())
        .filter(t=>!String(t.function?.name||'').startsWith('mcp__'))
        .map(t=>({name:t.function.name,description:t.function.description,inputSchema:t.function.parameters||{type:'object',properties:{}}}))
    }));
    s.server.setRequestHandler('tools/call',async request=>{
      try{
        const result=await runtime.executeTool(request.params.name,request.params.arguments||{});
        return {content:[{type:'text',text:JSON.stringify(result)}],isError:result?.success===false};
      }catch(error){return {content:[{type:'text',text:String(error instanceof Error?error.message:error)}],isError:true};}
    });
    return s;
  };
  nodeHandler=toNodeHandler(createMcpHandler(factory,{legacy:'stateless'}));

  httpServer=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url||'/',`http://${req.headers.host||'127.0.0.1'}`);
      if(url.pathname!=='/mcp'){res.writeHead(404);res.end('Not found');return;}
      if(requireToken&&String(req.headers.authorization||'')!==`Bearer ${token}`){
        res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Unauthorized'}));return;
      }
      await nodeHandler(req,res);
    }catch(error){
      if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});
      if(!res.writableEnded)res.end(JSON.stringify({error:String(error instanceof Error?error.message:error)}));
    }
  });
  await new Promise((resolve,reject)=>{httpServer.once('error',reject);httpServer.listen(port,'127.0.0.1',resolve);});
  currentPort=port;return status();
}

async function stopMcpServer(){
  if(httpServer)await new Promise(resolve=>httpServer.close(()=>resolve()));
  httpServer=undefined;nodeHandler=undefined;currentPort=0;return {success:true,running:false};
}
function status(){return {success:true,running:!!httpServer,url:httpServer?`http://127.0.0.1:${currentPort}/mcp`:null,requires_token:!!token};}
async function bridgeConfig(context){const t=await context.secrets.get('difyForVscode.mcpBridgeToken');return {url:`http://127.0.0.1:${currentPort||8765}/mcp`,headers:t?{Authorization:`Bearer ${t}`}:{}};}
module.exports={initializeMcpServer,startMcpServer,stopMcpServer,statusMcpServer:status,getMcpBridgeConfig:bridgeConfig};
