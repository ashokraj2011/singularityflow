/** Work products and observed data checks. Pure values; no source-control or execution discovery. */
import {SingularityFlowError} from '../foundation/failures.mjs';
import {jsonValueContract,admitRecordSchemaVersion,WORK_PRODUCT_SCHEMAS} from '../foundation/record-schema.mjs';
import {phaseNeedsGeneration} from './phase-policy.mjs';

export const WORK_PRODUCT_POLICY_PROFILE='sflow-work-product-policy/v1';
export const WORK_PRODUCT_REFERENCE_PROFILE='sflow-work-product-reference/v1';
export const DATA_EXECUTION_PROFILE='sflow-data-execution/v1';
export const WORK_PRODUCT_KINDS=Object.freeze(['source-code','document','report','query','notebook','dataset-snapshot','schema','pipeline-definition','pipeline-output']);
const values=()=>jsonValueContract({maximumBytes:4*1024*1024,maximumDepth:32,maximumNodes:100000,
  inputCode:'ENGINE_WORK_PRODUCT_INVALID',limitCode:'ENGINE_WORK_PRODUCT_LIMIT'});
const fail=(message,code='ENGINE_WORK_PRODUCT_INVALID',details=null)=>{throw new SingularityFlowError(message,{code,details});};
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(v);
const text=(v,max=4096)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000\u007f]/u.test(v);
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail('Use the exact declared work-product fields.');};
const ids=(v,label)=>{if(!Array.isArray(v)||v.length>128||v.some(x=>!id(x))||new Set(v).size!==v.length)fail('Invalid '+label+'.');return v;};
const timestamp=v=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function criterionList(input){
  const rows=values().namespaceJson(input),seen=new Set();
  if(!Array.isArray(rows)||rows.length>128)fail('Use bounded approved criteria.');
  for(const c of rows){exact(c,['id','description','metric','operator','expected']);exact(c.metric,['kind','column']);
    if(!id(c.id)||seen.has(c.id)||!text(c.description)||!['rows','distinct','nulls','sum'].includes(c.metric.kind))fail('Invalid or duplicate data criterion.');seen.add(c.id);
    if(c.metric.kind==='rows'?c.metric.column!==null:!id(c.metric.column))fail('A column metric needs its exact column.');
    if(!['eq','lte','gte'].includes(c.operator)||typeof c.expected!=='number'||!Number.isFinite(c.expected))fail('A data criterion needs an explicit finite comparison.');
  }
  return rows;
}
function reference(v){
  exact(v,['namespace','sha256','bytes']);
  if(!['config','state','evidence'].includes(v.namespace)||!hash(v.sha256)||!Number.isSafeInteger(v.bytes)||v.bytes<1||v.bytes>4*1024*1024)fail('A work product needs bounded shared immutable content.');
  return v;
}
export function workProductMutationRequest(operation,input){
  const authored=['work-product.retain','work-product.amend'].includes(operation);
  const fields=authored?['phaseId','assetId','content','reason',...(operation==='work-product.amend'?['expected']:[])]:['phaseId','expected','batchId'];
  const request=Object.fromEntries(fields.map(k=>[k,input[k]??null]));
  if(!id(request.phaseId))fail('Use an exact work-product phase.','ENGINE_INPUT_INVALID');
  if(authored){
    reference(request.content);
    if(!id(request.assetId)||request.content.namespace!=='evidence'||!text(request.reason,2048))fail('Retain exact shared input bytes with a reason.','ENGINE_INPUT_INVALID');
    if(operation==='work-product.amend'&&!hash(request.expected))fail('Approve the exact inspected input amendment.','ENGINE_INPUT_INVALID');
  }else if(operation!=='data.execute'||!hash(request.expected)||request.batchId!==null&&!id(request.batchId))fail('Execute an exact inspected data context.','ENGINE_INPUT_INVALID');
  return values().namespaceJson(request);
}
export function workProductReference(value,{projectId=null}={}){
  const v=values().namespaceJson(value);admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.reference,v);
  exact(v,['schemaVersion','profile','projectId','id','kind','mimeType','content','revision','observation','producer']);
  if(v.profile!==WORK_PRODUCT_REFERENCE_PROFILE||!id(v.projectId)||projectId!==null&&v.projectId!==projectId||!id(v.id)
    ||!WORK_PRODUCT_KINDS.includes(v.kind)||!text(v.mimeType,128))fail('Another work-product identity or kind.');
  reference(v.content);exact(v.revision,['scheme','value']);
  if(!['sha256','snapshot','opaque'].includes(v.revision.scheme)||!text(v.revision.value,512))fail('A work product needs its actual revision scheme.');
  if(v.revision.scheme==='sha256'&&v.revision.value!==v.content.sha256)fail('The content revision differs from its retained bytes.');
  exact(v.observation,['at','consistency','expiresAt']);
  if(!timestamp(v.observation.at)||!['retained-content','snapshot','live'].includes(v.observation.consistency)
    ||v.observation.expiresAt!==null&&(!timestamp(v.observation.expiresAt)||v.observation.expiresAt<=v.observation.at))fail('Invalid work-product observation.');
  if(v.observation.consistency==='retained-content'&&v.revision.scheme!=='sha256'
    ||v.observation.consistency==='snapshot'&&v.revision.scheme!=='snapshot')fail('Snapshot and retained-content claims need the corresponding revision.');
  exact(v.producer,['operationId','adapterId']);
  if(!id(v.producer.operationId)||!id(v.producer.adapterId))fail('A work product needs its actual producer operation and adapter.');
  return v;
}
export function workProductPolicy(value,{phaseIds=null}={}){
  const v=values().namespaceJson(value);admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.policy,v);
  exact(v,['schemaVersion','profile','requirements','assets','phases']);
  if(v.profile!==WORK_PRODUCT_POLICY_PROFILE||!Array.isArray(v.assets)||!v.assets.length||v.assets.length>128||!Array.isArray(v.phases)||!v.phases.length||v.phases.length>64)fail('Declare bounded work products and phase bindings.');
  const assets=new Map(),phases=new Set(),owners=new Map();
  for(const row of v.assets){exact(row,['id','kind','mimeType']);if(!id(row.id)||assets.has(row.id)||!WORK_PRODUCT_KINDS.includes(row.kind)||!text(row.mimeType,128))fail('Invalid or duplicate declared work product.');assets.set(row.id,row);}
  for(const row of v.phases){
    exact(row,['id','inputs','outputs','execution','criteria']);
    if(!id(row.id)||phases.has(row.id)||phaseIds!==null&&!phaseIds.includes(row.id))fail('The data policy names another or duplicate phase.');phases.add(row.id);
    ids(row.inputs,'phase inputs');ids(row.outputs,'phase outputs');
    if([...row.inputs,...row.outputs].some(x=>!assets.has(x))||row.inputs.some(x=>row.outputs.includes(x)))fail('Phase products must be declared, with separate input and output identities.');
    for(const output of row.outputs){if(owners.has(output))fail('A work product needs one owning phase.');owners.set(output,row.id);}
    criterionList(row.criteria);
    if(row.execution===null){if(row.criteria.length||row.outputs.some(x=>assets.get(x).kind==='pipeline-output'))fail('Observed pipeline outputs and checks need an actual execution binding.');continue;}
    exact(row.execution,['adapterId','kind','query','inputs','output']);
    const e=row.execution;
    if(!id(e.adapterId)||!['query','batch'].includes(e.kind)||!row.inputs.includes(e.query)||assets.get(e.query)?.kind!=='query'
      ||row.criteria.length===0||row.outputs.length!==1||row.outputs[0]!==e.output||!['report','dataset-snapshot','pipeline-output'].includes(assets.get(e.output)?.kind))fail('A data execution needs its one declared, supported output binding.');
    if(!Array.isArray(e.inputs)||!e.inputs.length||e.inputs.length>32)fail('A query needs bounded named input snapshots.');
    const tables=new Set();
    for(const input of e.inputs){exact(input,['assetId','table']);
      if(!row.inputs.includes(input.assetId)||assets.get(input.assetId)?.kind!=='dataset-snapshot'||!id(input.table)||tables.has(input.table))fail('Another input dataset or duplicate table.');tables.add(input.table);}
  }
  for(const row of v.phases)for(const input of row.inputs)if(!owners.has(input)||owners.get(input)===row.id)fail('Each input needs a distinct declared producer phase.');
  if(phaseIds!==null&&v.phases.some(row=>row.inputs.some(input=>phaseIds.indexOf(owners.get(input))>=phaseIds.indexOf(row.id))))fail('Each producing phase must precede its consumers in this workflow.');
  const criteria=new Set();for(const phase of v.phases)for(const criterion of phase.criteria){if(criteria.has(criterion.id))fail('A data criterion needs exactly one observing phase.');criteria.add(criterion.id);}
  if(!Array.isArray(v.requirements)||!v.requirements.length||v.requirements.length>128)fail('Declare the approved requirements and their measurable criteria.');
  const requirementIds=new Set(),covered=new Set();for(const row of v.requirements){exact(row,['id','statement','criteria']);ids(row.criteria,'requirement criteria');
    if(!id(row.id)||requirementIds.has(row.id)||!text(row.statement)||!row.criteria.length||row.criteria.some(id=>!criteria.has(id)))fail('Each requirement needs its exact declared criteria.');
    requirementIds.add(row.id);row.criteria.forEach(id=>covered.add(id));}
  if(covered.size!==criteria.size)fail('Every data criterion needs an approved requirement binding.');
  if(owners.size!==assets.size)fail('Each declared work product needs exactly one producer phase.');
  const visited=new Set(),active=new Set(),byId=new Map(v.phases.map(row=>[row.id,row]));
  function visit(phase){if(active.has(phase))fail('Work-product producer dependencies contain a cycle.');if(visited.has(phase))return;
    active.add(phase);for(const input of byId.get(phase).inputs)visit(owners.get(input));active.delete(phase);visited.add(phase);}
  for(const phase of phases)visit(phase);
  if(phaseIds!==null){const terminal=phaseIds.at(-1);if(!byId.has(terminal))fail('The closing data phase needs an explicit work-product acceptance contract.');
    const reachable=new Set();function ancestors(phase){if(reachable.has(phase))return;reachable.add(phase);for(const input of byId.get(phase).inputs)ancestors(owners.get(input));}ancestors(terminal);
    if(v.phases.some(phase=>phase.criteria.length&&!reachable.has(phase.id)))fail('Closing acceptance must consume every required criterion producer.');}
  return v;
}
export function datasetSnapshot(value){
  const v=values().namespaceJson(value);admitRecordSchemaVersion(WORK_PRODUCT_SCHEMAS.dataset,v);
  exact(v,['schemaVersion','profile','columns','rows']);
  if(v.profile!=='sflow-tabular-snapshot/v1'||!Array.isArray(v.columns)||!v.columns.length||v.columns.length>64
    ||!Array.isArray(v.rows)||v.rows.length>10000)fail('Use a bounded typed tabular snapshot.');
  const columns=new Set();
  for(const c of v.columns){exact(c,['name','type','nullable']);if(!id(c.name)||['__proto__','prototype','constructor'].includes(c.name)||columns.has(c.name)||!['text','integer','number','boolean'].includes(c.type)||typeof c.nullable!=='boolean')fail('Use distinct dataset columns compatible with the retained JSON execution contract.');columns.add(c.name);}
  for(const row of v.rows){exact(row,[...columns]);for(const c of v.columns){const x=row[c.name];
    if(x===null){if(!c.nullable)fail('A required dataset value is null.');}
    else if(c.type==='text'?typeof x!=='string'||x.length>65536:c.type==='boolean'?typeof x!=='boolean':typeof x!=='number'||!Number.isFinite(x)||c.type==='integer'&&!Number.isSafeInteger(x))fail('A dataset value differs from its declared type.');
  }}
  return v;
}
export function evaluateDataCriteria(criteria,snapshot){
  const data=datasetSnapshot(snapshot),columns=new Map(data.columns.map(c=>[c.name,c.type]));
  return criterionList(criteria).map(c=>{
    let observed=null,diagnostic=null;
    if(c.metric.kind!=='rows'&&!columns.has(c.metric.column))diagnostic='column-missing';
    else if(c.metric.kind==='rows')observed=data.rows.length;
    else if(c.metric.kind==='nulls')observed=data.rows.filter(r=>r[c.metric.column]===null).length;
    else if(c.metric.kind==='distinct')observed=new Set(data.rows.filter(r=>r[c.metric.column]!==null).map(r=>JSON.stringify(r[c.metric.column]))).size;
    else if(c.metric.kind==='sum'){
      const numbers=data.rows.map(r=>r[c.metric.column]).filter(x=>x!==null);
      if(!['integer','number'].includes(columns.get(c.metric.column))||numbers.some(x=>typeof x!=='number'))diagnostic='column-not-numeric';
      else{observed=numbers.reduce((a,b)=>a+b,0);if(!Number.isFinite(observed)){diagnostic='non-finite-aggregate';observed=null;}}
    }
    const passed=diagnostic===null&&(c.operator==='eq'?observed===c.expected:c.operator==='lte'?observed<=c.expected:observed>=c.expected);
    return {criterionId:c.id,metric:structuredClone(c.metric),operator:c.operator,expected:c.expected,observed,
      status:diagnostic?'unavailable':passed?'passed':'failed',diagnostic};
  });
}
export function planWorkProductRecord(workflow,request,facts,source){
  if((workflow.namespaceWorkProductReceipts??[]).length>=512)fail('The retained work-product history reached its bounded limit.','ENGINE_WORK_PRODUCT_LIMIT');
  const next=structuredClone(workflow),record={phase:request.phaseId,generation:source.generation,operationId:facts.operationId,
    asset:source.asset===null?null:workProductReference({...source.asset,observation:{...source.asset.observation,at:source.execution?source.asset.observation.at:facts.at},
      producer:{...source.asset.producer,operationId:facts.operationId}},{projectId:source.identity.projectId}),
    execution:source.execution??null,checks:source.checks??[],status:source.status??'retained',...(source.execution?{contextSha256:source.identity.contextSha256,observation:source.observation}:{}),...(source.amendment?{amendment:source.amendment}:{})};
  if(source.amendment)next.namespaceWorkProductAmendments=[...(workflow.namespaceWorkProductAmendments??[]),record];
  else if(record.asset)next.namespaceWorkProducts=[...(workflow.namespaceWorkProducts??[]).filter(row=>row.asset.id!==record.asset.id),record];
  if(record.asset){
    const kind='work-product:'+record.asset.id;
    // These are immutable Story inputs/observations, available before publication. The
    // work-product receipt owns the phase/generation binding; a phase-document index
    // would incorrectly claim that its target generation was already published.
    next.namespaceDocuments=[...(workflow.namespaceDocuments??[]).map(row=>row.kind===kind?{...row,status:'detached'}:row),
      {id:'WP-'+record.asset.id+'-'+facts.operationId,phase:null,generation:null,
        sourceKey:'work-products/'+encodeURIComponent(record.asset.id)+'/'+encodeURIComponent(facts.operationId),role:'file',name:'Work product '+record.asset.id,
        kind,mimeType:record.asset.mimeType,encoding:source.encoding??'utf8',locality:'project',status:'active',aliases:[],content:record.asset.content}];
  }
  if(source.execution){next.namespaceDataExecutions=[...(workflow.namespaceDataExecutions??[]),record];
    next.namespaceDocuments=[...(next.namespaceDocuments??[]),{id:source.observation.documentId,phase:null,generation:null,
      sourceKey:'data-executions/'+encodeURIComponent(facts.operationId)+'/observation',role:'file',name:'Actual data execution observation',
      kind:'data-execution-observation',mimeType:'application/json',encoding:'utf8',locality:'project',status:'active',aliases:[],content:source.observation.reference}];}
  next.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,event:source.amendment?'work_product_amended':source.execution?'data_execution_recorded':'work_product_retained',
    phase:request.phaseId,detail:record.asset?.id??'Retained execution failure'});
  return {workflow:next,outcome:{currentPhase:workflow.currentPhase,record}};
}
/** Legal work-product continuations. Hosts render these operations; they do not choose rules. */
export function workProductContinuations(workflow,selected){
  const workId=workflow.workItem.id,phaseId=selected.phase.id,inputs={workId,phaseId},actual=workflow.phases[phaseId],
    action=(operation,fields={},extra={})=>({operation,inputs:{...inputs,...fields},...extra});
  if(['paused','cancelled'].includes(workflow.status))return [{operation:'story.status',inputs:{workId}}];
  if(workflow.currentPhase!==phaseId){
    if(actual.generation>0)return [action('phase.review')];
    return workflow.currentPhase?[{operation:'phase.enter',inputs:{workId,phaseId:workflow.currentPhase}}]:[{operation:'story.status',inputs:{workId}}];
  }
  if(!phaseNeedsGeneration(workflow,actual))return [action('phase.review')];
  if(selected.missing.length)return [...new Set(selected.missing.map(id=>selected.declaration.phases.find(row=>row.outputs.includes(id)).id))]
    .map(owner=>({operation:'phase.review',inputs:{workId,phaseId:owner},prerequisites:['required-producing-publication']}));
  const latest=selected.state.executions.filter(row=>row.phase===phaseId&&row.generation===selected.binding.generation).at(-1),current=latest?.contextSha256===selected.contextSha256,
    missing=selected.phase.outputs.filter(id=>!selected.state.products.some(row=>row.asset.id===id&&row.phase===phaseId&&row.generation===selected.binding.generation));
  if(!selected.phase.execution)return missing.length?missing.map(assetId=>action('work-product.retain',{assetId},{requiredInputs:['operationId','content','reason']})):[action('phase.enter')];
  if(current&&latest.status==='passed'&&!missing.length)return [action('phase.enter')];
  const execute=action('data.execute',{expected:selected.contextSha256},{requiredInputs:['operationId',...(selected.phase.execution.kind==='batch'?['batchId']:[])]});
  if(!current||latest.status==='passed')return [execute];
  const repairs=selected.assets.filter(row=>['query','dataset-snapshot'].includes(row.asset.kind)).map(row=>action('work-product.amend',
    {assetId:row.asset.id,expected:selected.contextSha256},{requiredInputs:['operationId','content','reason'],prerequisites:['review-original-execution','authenticated-phase-approval-authority','exact-reviewed-input-amendment']}));
  return [...repairs,{...execute,prerequisites:['correction-or-resolved-execution-environment']}];
}
