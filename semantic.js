const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');

const SEMANTIC_TOOLS = [
  fn('semantic_index_build', 'Build or rebuild the workspace semantic vector index. Uses an OpenAI-compatible embeddings endpoint when configured, otherwise a local code-aware hash vector fallback.', obj({ path:str('Optional workspace-relative directory.'), file_pattern:str('Glob such as **/*.{js,ts,py,md}.'), max_files:int(1,10000), force:bool() })),
  fn('semantic_search', 'Semantic/vector search the indexed workspace and return the most relevant code/text chunks.', obj({ query:str(), top_k:int(1,50), path:str('Optional path prefix filter.') }, ['query'])),
  fn('semantic_index_status', 'Return semantic index provider, model, chunk/file counts and last build time.', obj({})),
  fn('semantic_index_clear', 'Delete the persisted semantic workspace index.', obj({})),
  fn('memory_save', 'Save a durable agent memory/knowledge item and embed it for later semantic recall.', obj({ text:str(), tags:{type:'array',items:{type:'string'},maxItems:20}, source:str() }, ['text'])),
  fn('memory_search', 'Semantic search durable agent memories for relevant prior knowledge.', obj({ query:str(), top_k:int(1,30) }, ['query'])),
  fn('memory_clear', 'Clear durable agent memories for this workspace.', obj({}))
];

const SEMANTIC_MUTATING = new Set(['semantic_index_build','semantic_index_clear','memory_save','memory_clear']);

let extensionContext;
let getEmbeddingApiKey = async () => '';
let cachedIndex;
let cachedMemory;
let loadedKey = '';

function initializeSemantic(context, runtime={}){
  extensionContext = context;
  if(runtime.getEmbeddingApiKey) getEmbeddingApiKey = runtime.getEmbeddingApiKey;
}

function fn(name,description,parameters){return {type:'function',function:{name,description,parameters}};}
function str(description){return {type:'string',...(description?{description}:{})};}
function int(minimum,maximum){return {type:'integer',minimum,maximum};}
function bool(){return {type:'boolean'};}
function obj(properties,required=[]){return {type:'object',properties,...(required.length?{required}:{}),additionalProperties:false};}

function workspaceRoot(){
  const folder=vscode.workspace.workspaceFolders&&vscode.workspace.workspaceFolders[0];
  if(!folder||folder.uri.scheme!=='file') throw new Error('Open a local workspace first.');
  return folder.uri.fsPath;
}
function safePath(relative=''){
  const root=path.resolve(workspaceRoot());
  const target=path.resolve(root,relative||'.');
  const r=process.platform==='win32'?root.toLowerCase():root;
  const t=process.platform==='win32'?target.toLowerCase():target;
  if(t!==r&&!t.startsWith(r+path.sep)) throw new Error(`Path escapes workspace: ${relative}`);
  return target;
}
function rel(full){return path.relative(workspaceRoot(),full).replace(/\\/g,'/')||'.';}
function workspaceId(){return crypto.createHash('sha1').update(path.resolve(workspaceRoot())).digest('hex').slice(0,16);}
async function storageDir(){
  if(!extensionContext) throw new Error('Semantic runtime is not initialized.');
  const base=extensionContext.globalStorageUri?.fsPath || extensionContext.extensionUri?.fsPath || workspaceRoot();
  const dir=path.join(base,'semantic');
  await fs.mkdir(dir,{recursive:true});
  return dir;
}
async function indexPath(){return path.join(await storageDir(),`${workspaceId()}-code.json`);}
async function memoryPath(){return path.join(await storageDir(),`${workspaceId()}-memory.json`);}

function configSnapshot(config){
  return {
    baseUrl:String(config?.get?.('semanticEmbeddingBaseUrl','')||'').replace(/\/+$/,''),
    model:String(config?.get?.('semanticEmbeddingModel','')||''),
    chunkChars:Math.max(800,Math.min(12000,Number(config?.get?.('semanticChunkChars',3500)||3500))),
    overlapChars:Math.max(0,Math.min(3000,Number(config?.get?.('semanticChunkOverlapChars',500)||500)))
  };
}

async function executeSemanticTool(name,args={},config){
  switch(name){
    case 'semantic_index_build': return buildIndex(args,config);
    case 'semantic_search': return searchIndex(args,config);
    case 'semantic_index_status': return indexStatus(config);
    case 'semantic_index_clear': return clearIndex();
    case 'memory_save': return saveMemory(args,config);
    case 'memory_search': return searchMemory(args,config);
    case 'memory_clear': return clearMemory();
    default:return {success:false,error:`Unknown semantic tool: ${name}`};
  }
}

async function buildIndex(args,config){
  const cfg=configSnapshot(config);
  const maxFiles=Math.max(1,Math.min(10000,Number(args.max_files||config?.get?.('semanticIndexMaxFiles',2500)||2500)));
  const base=String(args.path||'').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
  if(base) safePath(base);
  const pattern=args.file_pattern||'**/*';
  const include=base?`${base}/${pattern}`:pattern;
  const exclude='**/{.git,node_modules,.venv,venv,__pycache__,.next,dist,build,.cache,coverage}/**';
  const uris=await vscode.workspace.findFiles(include,exclude,maxFiles);
  const chunks=[];
  for(const uri of uris){
    try{
      const stat=await vscode.workspace.fs.stat(uri);
      if(stat.size>2*1024*1024) continue;
      const bytes=await vscode.workspace.fs.readFile(uri);
      const text=new TextDecoder('utf-8').decode(bytes);
      if(text.includes('\u0000')) continue;
      chunks.push(...chunkFile(rel(uri.fsPath),text,cfg.chunkChars,cfg.overlapChars));
      if(chunks.length>=15000) break;
    }catch{}
  }
  const vectors=await embedTexts(chunks.map(c=>c.embedding_text),config);
  for(let i=0;i<chunks.length;i++){chunks[i].vector=vectors.vectors[i];delete chunks[i].embedding_text;}
  const index={version:2,workspace:workspaceRoot(),provider:vectors.provider,model:vectors.model,dimensions:vectors.vectors[0]?.length||0,built_at:new Date().toISOString(),file_count:new Set(chunks.map(c=>c.path)).size,chunk_count:chunks.length,chunks};
  await fs.writeFile(await indexPath(),JSON.stringify(index),'utf8');
  cachedIndex=index;loadedKey=workspaceId();
  return {success:true,provider:index.provider,model:index.model,dimensions:index.dimensions,file_count:index.file_count,chunk_count:index.chunk_count,built_at:index.built_at};
}

function chunkFile(file,text,maxChars,overlap){
  const lines=text.split(/\r?\n/);
  const chunks=[];
  let start=0;
  while(start<lines.length){
    let end=start;
    let size=0;
    while(end<lines.length&&size+lines[end].length+1<=maxChars){size+=lines[end].length+1;end++;}
    if(end===start)end=start+1;
    const content=lines.slice(start,end).join('\n');
    const ids=Array.from(new Set(content.match(/[A-Za-z_$][\w$]{2,}/g)||[])).slice(0,80).join(' ');
    chunks.push({id:crypto.createHash('sha1').update(`${file}:${start}:${content}`).digest('hex').slice(0,16),path:file,start_line:start+1,end_line:end,text:content.slice(0,maxChars),embedding_text:`File: ${file}\nSymbols: ${ids}\n${content}`});
    if(end>=lines.length)break;
    if(overlap<=0){start=end;continue;}
    let back=end-1,chars=0;
    while(back>start&&chars<overlap){chars+=lines[back].length+1;back--;}
    start=Math.max(start+1,back+1);
  }
  return chunks;
}

async function embedTexts(texts,config){
  const cfg=configSnapshot(config);
  if(cfg.baseUrl&&cfg.model){
    try{return await remoteEmbeddings(texts,cfg,await getEmbeddingApiKey());}
    catch(error){
      vscode.window.showWarningMessage(`Semantic embeddings endpoint failed; using local fallback for this operation: ${error.message}`);
    }
  }
  return {provider:'local-code-hash',model:'feature-hash-768',vectors:texts.map(hashEmbedding)};
}

async function remoteEmbeddings(texts,cfg,key){
  const all=[];
  for(let i=0;i<texts.length;i+=32){
    const input=texts.slice(i,i+32);
    const headers={'Content-Type':'application/json'};
    if(key)headers.Authorization=`Bearer ${key}`;
    const response=await fetch(`${cfg.baseUrl}/embeddings`,{method:'POST',headers,body:JSON.stringify({model:cfg.model,input})});
    const body=await response.text();
    if(!response.ok)throw new Error(`HTTP ${response.status}: ${body.slice(0,500)}`);
    const data=JSON.parse(body);
    const rows=(data.data||[]).sort((a,b)=>(a.index??0)-(b.index??0));
    if(rows.length!==input.length)throw new Error('Embeddings response count mismatch.');
    all.push(...rows.map(r=>normalize(r.embedding)));
  }
  return {provider:'openai-compatible',model:cfg.model,vectors:all};
}

function hashEmbedding(text){
  const dim=768,v=new Array(dim).fill(0);
  const tokens=String(text).toLowerCase().match(/[\p{L}\p{N}_$.-]{2,}/gu)||[];
  for(const token of tokens){
    const h=crypto.createHash('sha256').update(token).digest();
    const idx=h.readUInt32LE(0)%dim;
    const sign=(h[4]&1)?1:-1;
    const weight=1+Math.min(3,Math.log2(token.length+1));
    v[idx]+=sign*weight;
  }
  return normalize(v);
}
function normalize(v){
  const norm=Math.sqrt(v.reduce((s,x)=>s+x*x,0))||1;
  return v.map(x=>x/norm);
}
function dot(a,b){let s=0;const n=Math.min(a.length,b.length);for(let i=0;i<n;i++)s+=a[i]*b[i];return s;}

async function loadIndex(){
  const key=workspaceId();
  if(cachedIndex&&loadedKey===key)return cachedIndex;
  try{cachedIndex=JSON.parse(await fs.readFile(await indexPath(),'utf8'));loadedKey=key;return cachedIndex;}
  catch{return null;}
}
async function searchIndex(args,config){
  const index=await loadIndex();
  if(!index)throw new Error('Semantic index does not exist. Run semantic_index_build first.');
  const query=String(args.query||'').trim();if(!query)throw new Error('query is required.');
  let vector;
  if(index.provider==='openai-compatible'){
    const cfg=configSnapshot(config);
    if(!cfg.baseUrl||!cfg.model)throw new Error('Index was built with remote embeddings. Configure the same semanticEmbeddingBaseUrl/model before searching.');
    vector=(await remoteEmbeddings([query],cfg,await getEmbeddingApiKey())).vectors[0];
  }else vector=hashEmbedding(query);
  const prefix=String(args.path||'').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
  const topK=Math.max(1,Math.min(50,Number(args.top_k||8)));
  const scored=index.chunks.filter(c=>!prefix||c.path===prefix||c.path.startsWith(prefix+'/')).map(c=>({score:dot(vector,c.vector),path:c.path,start_line:c.start_line,end_line:c.end_line,text:c.text.slice(0,2200)})).sort((a,b)=>b.score-a.score).slice(0,topK);
  return {success:true,provider:index.provider,model:index.model,query,results:scored};
}
async function indexStatus(config){
  const index=await loadIndex();
  const cfg=configSnapshot(config);
  return {success:true,exists:!!index,configured_embedding_endpoint:!!(cfg.baseUrl&&cfg.model),provider:index?.provider||null,model:index?.model||cfg.model||null,dimensions:index?.dimensions||null,file_count:index?.file_count||0,chunk_count:index?.chunk_count||0,built_at:index?.built_at||null};
}
async function clearIndex(){
  await fs.unlink(await indexPath()).catch(()=>{});cachedIndex=null;return {success:true};
}

async function loadMemory(){
  const key=workspaceId();
  if(cachedMemory&&cachedMemory.workspace_id===key)return cachedMemory;
  try{cachedMemory=JSON.parse(await fs.readFile(await memoryPath(),'utf8'));}
  catch{cachedMemory={workspace_id:key,items:[]};}
  return cachedMemory;
}
async function saveMemory(args,config){
  const text=String(args.text||'').trim();if(!text)throw new Error('text is required.');
  const memory=await loadMemory();
  const embedded=await embedTexts([text],config);
  const item={id:crypto.randomUUID(),text:text.slice(0,20000),tags:Array.isArray(args.tags)?args.tags.map(String).slice(0,20):[],source:String(args.source||''),created_at:new Date().toISOString(),provider:embedded.provider,model:embedded.model,vector:embedded.vectors[0]};
  memory.items.push(item);if(memory.items.length>2000)memory.items=memory.items.slice(-2000);
  await fs.writeFile(await memoryPath(),JSON.stringify(memory),'utf8');cachedMemory=memory;
  return {success:true,id:item.id,provider:item.provider,model:item.model};
}
async function searchMemory(args,config){
  const memory=await loadMemory();
  if(!memory.items.length)return {success:true,results:[]};
  const query=String(args.query||'').trim();if(!query)throw new Error('query is required.');
  const topK=Math.max(1,Math.min(30,Number(args.top_k||6)));
  const groups=new Map();for(const item of memory.items){const k=`${item.provider}|${item.model}`;if(!groups.has(k))groups.set(k,[]);groups.get(k).push(item);}
  const results=[];
  for(const [key,items] of groups){
    const [provider,model]=key.split('|');let q;
    if(provider==='openai-compatible'){
      const cfg=configSnapshot(config);if(!cfg.baseUrl||cfg.model!==model)continue;
      q=(await remoteEmbeddings([query],cfg,await getEmbeddingApiKey())).vectors[0];
    }else q=hashEmbedding(query);
    for(const item of items)results.push({score:dot(q,item.vector),id:item.id,text:item.text,tags:item.tags,source:item.source,created_at:item.created_at});
  }
  results.sort((a,b)=>b.score-a.score);
  return {success:true,query,results:results.slice(0,topK)};
}
async function clearMemory(){await fs.unlink(await memoryPath()).catch(()=>{});cachedMemory=null;return {success:true};}

module.exports={SEMANTIC_TOOLS,SEMANTIC_MUTATING,initializeSemantic,executeSemanticTool,buildIndex,indexStatus};
