const CREW_TOOLS = [
  fn('run_crew', 'Run a CrewAI-inspired multi-agent crew. Agents have role/goal/backstory/tool allowlists; tasks have expected output, dependencies/context and optional async execution. Processes: sequential or hierarchical. Reviewer failures can trigger bounded fix/review cycles.', obj({
    name:str(),
    process:enumStr(['sequential','hierarchical']),
    planning:bool(),
    memory:bool(),
    manager:agentSchema(false),
    agents:{type:'array',items:agentSchema(true),minItems:1,maxItems:12},
    tasks:{type:'array',items:taskSchema(),minItems:1,maxItems:30},
    max_steps_per_task:int(1,40),
    max_review_cycles:int(0,5),
    final_synthesis:bool()
  }, ['agents','tasks']))
];

let runtime={};
function initializeCrew(options={}){runtime={...runtime,...options};}
function fn(name,description,parameters){return {type:'function',function:{name,description,parameters}};}
function str(description){return {type:'string',...(description?{description}:{})};}
function bool(){return {type:'boolean'};}
function int(minimum,maximum){return {type:'integer',minimum,maximum};}
function enumStr(values){return {type:'string',enum:values};}
function obj(properties,required=[]){return {type:'object',properties,...(required.length?{required}:{}),additionalProperties:false};}
function agentSchema(requiredId){return obj({id:str(),role:str(),goal:str(),backstory:str(),tools:{type:'array',items:{type:'string'},maxItems:100},allow_delegation:bool(),planning:bool(),max_steps:int(1,40)},requiredId?['id','role','goal']:['role','goal']);}
function taskSchema(){return obj({id:str(),description:str(),expected_output:str(),agent:str('Agent id; optional when hierarchical/planning chooses assignment.'),context:{type:'array',items:{type:'string'},maxItems:30},tools:{type:'array',items:{type:'string'},maxItems:100},async_execution:bool(),max_steps:int(1,40)},['id','description','expected_output']);}

async function executeCrewTool(name,args={},config){
  if(name!=='run_crew')return {success:false,error:`Unknown crew tool: ${name}`};
  if(typeof runtime.runSubAgent!=='function')throw new Error('Crew runtime is not initialized.');
  return runCrew(args,config);
}

async function runCrew(spec,config){
  const agents=normalizeAgents(spec.agents||[]);
  const tasks=normalizeTasks(spec.tasks||[]);
  validate(agents,tasks);
  const process=spec.process==='hierarchical'?'hierarchical':'sequential';
  const maxSteps=Math.max(1,Math.min(40,Number(spec.max_steps_per_task||config?.get?.('crewTaskMaxSteps',14)||14)));
  const maxParallel=Math.max(1,Math.min(8,Number(config?.get?.('crewMaxParallelTasks',3)||3)));
  const maxReviewCycles=Math.max(0,Math.min(5,Number(spec.max_review_cycles ?? config?.get?.('crewMaxReviewCycles',2) ?? 2)));
  const outputs=new Map();
  const events=[];
  const warnings=[];
  let assignments=new Map(tasks.filter(t=>t.agent).map(t=>[t.id,t.agent]));

  if(spec.planning||process==='hierarchical'){
    const manager=normalizeManager(spec.manager,agents);
    const planningPrompt=buildPlanningPrompt(spec,agents,tasks);
    runtime.onCrewEvent?.({type:'crew_planning',crew:spec.name||'crew',manager:manager.role});
    const planned=await runtime.runSubAgent({
      agent:manager,
      task:{id:'__plan__',description:planningPrompt,expected_output:'A JSON object with assignments and execution_order.'},
      contextText:'',allowedTools:[],maxSteps:Math.min(maxSteps,8),mode:'manager-plan'
    });
    const plan=parseJson(planned.content);
    if(plan&&Array.isArray(plan.assignments)){
      for(const a of plan.assignments){if(a&&a.task_id&&a.agent_id)assignments.set(String(a.task_id),String(a.agent_id));}
      if(Array.isArray(plan.execution_order))reorderTasks(tasks,plan.execution_order.map(String));
    } else if(planned.partial) {
      warnings.push('Manager planning reached its step budget; explicit/default task assignments were used.');
    }
    events.push({type:'plan',content:planned.content,parsed:plan||null,status:planned.status||'completed'});
  }

  for(const task of tasks){
    if(!assignments.has(task.id))assignments.set(task.id,task.agent||agents[0].id);
  }

  const pending=new Set(tasks.map(t=>t.id));
  while(pending.size){
    const ready=tasks.filter(t=>pending.has(t.id)&&dependencies(t).every(id=>outputs.has(id)));
    if(!ready.length)throw new Error(`Crew task dependency cycle or missing context: ${Array.from(pending).join(', ')}`);
    const asyncReady=ready.filter(t=>t.async_execution).slice(0,maxParallel);
    if(asyncReady.length>1){
      const results=await Promise.all(asyncReady.map(t=>executeTask(t,assignments.get(t.id),agents,outputs,maxSteps,spec,config)));
      for(const r of results){outputs.set(r.task.id,r);pending.delete(r.task.id);events.push(r.event);if(r.status!=='completed')warnings.push(`${r.task.id}/${r.agent.id}: ${r.status}`);}
      continue;
    }
    const task=ready[0];
    const result=await executeTask(task,assignments.get(task.id),agents,outputs,maxSteps,spec,config);
    outputs.set(task.id,result);pending.delete(task.id);events.push(result.event);if(result.status!=='completed')warnings.push(`${result.task.id}/${result.agent.id}: ${result.status}`);
  }

  // Reviewer agents report; implementation agents fix. Keep the loop bounded.
  if(maxReviewCycles>0){
    for(const reviewTask of tasks.filter(t=>isReviewerAgent(agents.find(a=>a.id===assignments.get(t.id))))) {
      let reviewResult=outputs.get(reviewTask.id);
      if(!reviewResult||!reviewFailed(reviewResult.content))continue;
      const fixTarget=findFixTarget(reviewTask,tasks,outputs,agents);
      if(!fixTarget){
        warnings.push(`Reviewer ${reviewTask.id} reported FAIL but no implementation task was available for an automatic fix cycle.`);
        continue;
      }
      const fixAgent=fixTarget.agent;
      for(let cycle=1;cycle<=maxReviewCycles&&reviewFailed(reviewResult.content);cycle+=1){
        runtime.onCrewEvent?.({type:'review_fix_cycle',crew:spec.name||'crew',cycle,review_task:reviewTask.id,fix_agent:fixAgent.id});
        const fixTask={
          id:`${fixTarget.task.id}__fix_${cycle}`,
          description:`Fix the implementation based on the reviewer feedback below. Address the concrete findings only, preserve working behavior, and verify the fix.\n\nOriginal task:\n${fixTarget.task.description}\n\nReviewer feedback:\n${reviewResult.content}`,
          expected_output:'A corrected implementation with a concise description of changes and verification.',
          tools:fixTarget.task.tools,
          max_steps:fixTarget.task.max_steps
        };
        const fixResult=await executeDirectTask(fixTask,fixAgent,`${fixTarget.content}\n\nReviewer feedback:\n${reviewResult.content}`,maxSteps,'review-fix');
        outputs.set(fixTarget.task.id,{...fixTarget,content:fixResult.content,steps:(fixTarget.steps||0)+(fixResult.steps||0),status:fixResult.status,partial:fixResult.partial});
        events.push({type:'review_fix',cycle,task:fixTarget.task.id,agent:fixAgent.id,status:fixResult.status});
        if(fixResult.status!=='completed')warnings.push(`Fix cycle ${cycle} for ${fixTarget.task.id}: ${fixResult.status}`);

        const recheckContext=`Updated implementation result:\n${fixResult.content}\n\nPrevious review:\n${reviewResult.content}`;
        const recheck=await executeDirectTask({...reviewTask,id:`${reviewTask.id}__recheck_${cycle}`},reviewResult.agent,recheckContext,maxSteps,'review-recheck');
        reviewResult={...reviewResult,content:recheck.content,steps:(reviewResult.steps||0)+(recheck.steps||0),status:recheck.status,partial:recheck.partial,review_cycle:cycle};
        outputs.set(reviewTask.id,reviewResult);
        events.push({type:'review_recheck',cycle,task:reviewTask.id,agent:reviewResult.agent.id,status:recheck.status,failed:reviewFailed(recheck.content)});
        if(recheck.status!=='completed')warnings.push(`Reviewer recheck cycle ${cycle}: ${recheck.status}`);
      }
      if(reviewFailed(reviewResult.content))warnings.push(`Reviewer ${reviewTask.id} still reports FAIL after ${maxReviewCycles} fix cycle(s).`);
    }
  }

  let final;
  if(spec.final_synthesis!==false){
    const manager=normalizeManager(spec.manager,agents);
    const summary=Array.from(outputs.values()).map(o=>`TASK ${o.task.id} (${o.agent.id}/${o.agent.role}) [status=${o.status||'completed'}]\nExpected: ${o.task.expected_output}\nOutput:\n${o.content}`).join('\n\n---\n\n');
    runtime.onCrewEvent?.({type:'crew_synthesis',crew:spec.name||'crew',manager:manager.role});
    final=await runtime.runSubAgent({agent:manager,task:{id:'__synthesis__',description:`Synthesize the crew's work into one final response for the user. Preserve important findings, changes, risks, verification, partial results and any unresolved reviewer failures. Do not hide incomplete work.\n\n${summary}${warnings.length?`\n\nCREW WARNINGS:\n${warnings.join('\n')}`:''}`,expected_output:'One concise but complete final answer.'},contextText:'',allowedTools:[],maxSteps:Math.min(maxSteps,8),mode:'manager-synthesis'});
    if(final.partial)warnings.push(`Manager synthesis: ${final.status}`);
  }

  if(spec.memory&&typeof runtime.saveMemory==='function'){
    const memoryText=`Crew ${spec.name||'crew'} completed.\n${Array.from(outputs.values()).map(o=>`${o.task.id} [${o.status||'completed'}]: ${o.content}`).join('\n')}`.slice(0,30000);
    await runtime.saveMemory(memoryText,['crew',process],`crew:${spec.name||'crew'}`).catch(()=>{});
  }

  return {
    success:true,
    crew:spec.name||'crew',
    process,
    assignments:Object.fromEntries(assignments),
    tasks:Array.from(outputs.values()).map(o=>({id:o.task.id,agent_id:o.agent.id,role:o.agent.role,content:o.content,steps:o.steps,status:o.status||'completed',partial:!!o.partial,review_cycle:o.review_cycle||0})),
    warnings,
    final:final?.content||Array.from(outputs.values()).at(-1)?.content||'',
    events
  };
}

async function executeTask(task,agentId,agents,outputs,maxSteps,spec,config){
  const agent=agents.find(a=>a.id===agentId)||agents[0];
  const explicit=dependencies(task);
  const ctxIds=explicit.length?explicit:(String(spec.process||'sequential')==='sequential'?Array.from(outputs.keys()):[]);
  const contextText=ctxIds.length?ctxIds.map(id=>{const o=outputs.get(id);return o?`Context from task ${id} [${o.status||'completed'}]:\n${o.content}`:'';}).filter(Boolean).join('\n\n'):'';
  const allowed=intersectTools(agent.tools,task.tools);
  runtime.onCrewEvent?.({type:'task_start',crew:spec.name||'crew',task:task.id,agent:agent.id,role:agent.role});
  try{
    const result=await runtime.runSubAgent({agent,task,contextText,allowedTools:allowed,maxSteps:task.max_steps||agent.max_steps||maxSteps,mode:isReviewerAgent(agent)?'reviewer':'worker'});
    runtime.onCrewEvent?.({type:'task_end',crew:spec.name||'crew',task:task.id,agent:agent.id,role:agent.role,status:result.status||'completed'});
    return {task,agent,content:result.content,steps:result.steps,status:result.status||'completed',partial:!!result.partial,observations:result.observations||[],event:{type:'task',task:task.id,agent:agent.id,role:agent.role,status:result.status||'completed'}};
  }catch(error){
    const message=error instanceof Error?error.message:String(error);
    runtime.onCrewEvent?.({type:'task_error',crew:spec.name||'crew',task:task.id,agent:agent.id,role:agent.role,error:message});
    return {task,agent,content:`Task failed but crew execution continued. Error: ${message}`,steps:0,status:'failed',partial:true,observations:[],event:{type:'task',task:task.id,agent:agent.id,role:agent.role,status:'failed',error:message}};
  }
}

async function executeDirectTask(task,agent,contextText,maxSteps,mode){
  try{
    const allowed=intersectTools(agent.tools,task.tools);
    return await runtime.runSubAgent({agent,task,contextText,allowedTools:allowed,maxSteps:task.max_steps||agent.max_steps||maxSteps,mode});
  }catch(error){
    return {content:`Task failed during ${mode}: ${error instanceof Error?error.message:String(error)}`,steps:0,status:'failed',partial:true};
  }
}

function normalizeAgents(items){return items.map((a,i)=>({id:String(a.id||`agent_${i+1}`),role:String(a.role||`Agent ${i+1}`),goal:String(a.goal||''),backstory:String(a.backstory||''),tools:Array.isArray(a.tools)?a.tools.map(String):null,allow_delegation:!!a.allow_delegation,planning:!!a.planning,max_steps:Number(a.max_steps||0)||null}));}
function normalizeTasks(items){return items.map((t,i)=>({id:String(t.id||`task_${i+1}`),description:String(t.description||''),expected_output:String(t.expected_output||''),agent:t.agent?String(t.agent):'',context:Array.isArray(t.context)?t.context.map(String):[],tools:Array.isArray(t.tools)?t.tools.map(String):null,async_execution:!!t.async_execution,max_steps:Number(t.max_steps||0)||null}));}
function normalizeManager(manager,agents){return {id:String(manager?.id||'manager'),role:String(manager?.role||'Crew Manager'),goal:String(manager?.goal||'Coordinate specialists, validate their work, and produce a correct final result.'),backstory:String(manager?.backstory||'You are a rigorous technical lead who delegates based on expertise and verifies task outcomes.'),tools:Array.isArray(manager?.tools)?manager.tools.map(String):[],allow_delegation:true,planning:true,max_steps:Number(manager?.max_steps||0)||null};}
function validate(agents,tasks){
  if(!agents.length)throw new Error('run_crew requires at least one agent.');
  const ids=new Set();for(const a of agents){if(ids.has(a.id))throw new Error(`Duplicate agent id: ${a.id}`);ids.add(a.id);if(!a.role||!a.goal)throw new Error(`Agent ${a.id} requires role and goal.`);}
  const tids=new Set();for(const t of tasks){if(tids.has(t.id))throw new Error(`Duplicate task id: ${t.id}`);tids.add(t.id);if(!t.description||!t.expected_output)throw new Error(`Task ${t.id} requires description and expected_output.`);}
  for(const t of tasks){if(t.agent&&!ids.has(t.agent))throw new Error(`Task ${t.id} references unknown agent ${t.agent}.`);for(const c of t.context)if(!tids.has(c))throw new Error(`Task ${t.id} context references unknown task ${c}.`);}
}
function dependencies(task){return Array.isArray(task.context)?task.context:[];}
function intersectTools(agentTools,taskTools){
  if(!agentTools&&!taskTools)return null;
  if(agentTools&&!taskTools)return agentTools;
  if(!agentTools&&taskTools)return taskTools;
  const allowed=new Set(agentTools);return taskTools.filter(t=>allowed.has(t));
}
function isReviewerAgent(agent){return !!agent&&/review|qa|test/i.test(`${agent.id||''} ${agent.role||''}`);}
function reviewFailed(content){
  const text=String(content||'');
  if(/\bPASS(?:ED)?\b/i.test(text)&&!/\bFAIL(?:ED)?\b/i.test(text))return false;
  return /\bFAIL(?:ED)?\b|blocking issue|must fix|critical issue|regression detected|verification failed/i.test(text);
}
function findFixTarget(reviewTask,tasks,outputs,agents){
  const candidates=[...dependencies(reviewTask)].reverse().map(id=>outputs.get(id)).filter(Boolean);
  const prior=tasks.slice(0,Math.max(0,tasks.findIndex(t=>t.id===reviewTask.id))).reverse().map(t=>outputs.get(t.id)).filter(Boolean);
  const all=[...candidates,...prior];
  return all.find(o=>o&&!isReviewerAgent(o.agent)&&/coder|developer|engineer|implement/i.test(`${o.agent.id||''} ${o.agent.role||''} ${o.task.description||''}`))||all.find(o=>o&&!isReviewerAgent(o.agent))||null;
}
function reorderTasks(tasks,order){const rank=new Map(order.map((id,i)=>[id,i]));tasks.sort((a,b)=>(rank.get(a.id)??9999)-(rank.get(b.id)??9999));}
function buildPlanningPrompt(spec,agents,tasks){
  return `You are the manager of a multi-agent crew. Create the execution assignment plan.\nReturn ONLY JSON: {"assignments":[{"task_id":"...","agent_id":"..."}],"execution_order":["task_id",...]}. Respect explicit task dependencies. Choose agents by role/goal. Reviewers should verify and report PASS/FAIL rather than edit implementation; implementation agents should perform fixes when review fails.\n\nAGENTS:\n${agents.map(a=>`- ${a.id}: role=${a.role}; goal=${a.goal}; tools=${a.tools?.join(', ')||'all allowed'}`).join('\n')}\n\nTASKS:\n${tasks.map(t=>`- ${t.id}: ${t.description}; expected=${t.expected_output}; explicit_agent=${t.agent||'none'}; context=${t.context.join(',')||'none'}; async=${t.async_execution}`).join('\n')}`;
}
function parseJson(text){
  const s=String(text||'').replace(/<think>[\s\S]*?<\/think>/gi,'').trim();
  try{return JSON.parse(s);}catch{}
  const start=s.indexOf('{');const end=s.lastIndexOf('}');if(start>=0&&end>start){try{return JSON.parse(s.slice(start,end+1));}catch{}}
  return null;
}

module.exports={CREW_TOOLS,initializeCrew,executeCrewTool};
