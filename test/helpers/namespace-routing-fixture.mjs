/** Shared actual routed Story authoring; no seeded completion, votes or readiness flags. */
import assert from 'node:assert/strict';
import {createNamespacePublicationEngine} from '../../src/engine-storage/namespace-publication.mjs';
import {createNamespaceSubmissionEngine} from '../../src/engine-storage/namespace-submission.mjs';
const reviewer={name:'Independent reviewer',email:'independent@example.test',login:null};
const access=(f,permissions=['phase.approve'])=>({current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',
  agentId:null,identity:reviewer,permissions})});
function configure(kind='branch',{reuse=false}={}) {return source=>{
  source.definition.approvalAuthorities.reviewers.members.push({email:reviewer.email});source.definition.phases.intake.approval.allowSelfApproval=false;
  for(const [id,upstream]of [['review','intake'],['release','review']]) {
    source.definition.phases[id]={...structuredClone(source.definition.phases.intake),label:id,artifact:{path:'artifacts/'+id+'/report.md'},
      defaultTemplate:'intake.md',inputs:reuse||kind!=='branch'?[{phase:upstream}]:[],approval:{authorities:['reviewers'],minimum:1,rejectTo:[id],allowSelfApproval:false}};
    source.definition.workTypes.simple.phases.push(id);source.agents[0].phases.push(id);source.agents[0].defaultFor.push(id);
  }
  const omitted=()=>structuredClone(source.definition.workTypes.simple.omits);
  source.definition.workTypes.simple.decisions=kind==='loop'?[{id:'quality',label:'Quality review',kind:'loop',after:'review',
    inputs:[{name:'verdict',values:['Pass','Repair']}],goal:{verdict:'Pass'},back:'intake',maxRounds:1}]
    :kind==='ask'?[{id:'direction',label:'Choose delivery',kind:'ask',after:'intake',
      routes:[{id:'continue',label:'Continue',to:'next'},{id:'finish',label:'Finish',to:'end',omits:omitted()}]}]
      :[{id:'channel',label:'Delivery channel',kind:'branch',after:'intake',inputs:[{name:'channel',values:['Web','Mobile']}],
        routes:[{id:'web',label:'Web',when:{channel:'Web'},to:reuse?'next':'release',omits:omitted()},{id:'mobile',label:'Mobile',to:'end',omits:omitted()}]}];
  if(reuse)source.definition.workTypes.simple.decisions.push({id:'delivery-channel',label:'Retained channel',kind:'branch',after:'review',
    inputs:[{name:'channel',from:'channel'}],routes:[{id:'web',label:'Web',when:{channel:'Web'},to:'next'},{id:'mobile',label:'Mobile',to:'end',omits:omitted()}]});
};}
const approval=f=>f.makeApproval({access:access(f)});
async function confirmation(f,engine,phaseId) {
  const {manifest}=await engine.run('phase.review.resources',{phaseId});
  for(const resource of manifest.resources)assert.equal((await engine.run('document.read',{reference:resource.reference})).document.integrity,'matched');
  return {workId:f.inputs.workId,phase:phaseId,generation:manifest.generation,reviewPacketSha256:manifest.reviewBinding.packetSha256};
}
async function authorSubmit(f,phaseId,decisionValues={}) {
  try{await f.engine.run('phase.prepare',{phaseId});}
  catch(error) {
    if(error.code!=='ENGINE_DRAFT_BASIS_CHANGED')throw error;
    assert.equal(error.details.operation,'phase.draft.rebase');
    await f.engine.run(error.details.operation,{operationId:'rebase-'+phaseId+'-'+error.details.confirm.slice(0,16),workId:f.inputs.workId,phaseId,
      expectedRevision:error.details.revision,confirm:error.details.confirm,reason:'Preserve the reviewed draft for its actual successor generation.'});
  }
  const {manifest}=await f.engine.run('phase.draft.read',{phaseId}),generation=manifest.draft.generation;
  await f.engine.run('phase.draft.write',{operationId:'author-'+phaseId+'-'+generation,workId:f.inputs.workId,phaseId,
    expectedRevision:manifest.draft.revision,content:await f.upload('# Actual '+phaseId+' result\n\nGeneration '+generation+' retains its reviewed document and observable outcome.\n'),
    reason:'Complete the actual current document.'});
  const common={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock};
  await createNamespacePublicationEngine({...common,localRecords:f.localRecords,localContent:f.localContent}).run('phase.publish',
    {phaseId,authored:'governed-agent',channel:'copilot-host'});
  return createNamespaceSubmissionEngine(common).run('phase.submit',{phaseId,decisionValues});
}


export {reviewer,access,configure,approval,confirmation,authorSubmit};
