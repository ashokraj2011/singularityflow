/** Git-free workflows assembled and accepted solely through registered operations. */
import {createHash} from 'node:crypto';
import {realpath,readFile} from 'node:fs/promises';
import path from 'node:path';
import {namespaceApprovalFixture} from './namespace-approval-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createSqliteDataExecutionUnit,SQLITE_DATA_DRIVER_SHA256} from '../../src/sgos/sqlite-data-execution.mjs';
import {createNodeExecutionOwner} from '../../src/sgos/node-execution-owner.mjs';
import {createExecutionUnitManifest,sha256} from '../../src/sgos/node-execution-values.mjs';
import {canonicalJson} from '../../src/foundation/record-schema.mjs';
const executable=await realpath(process.execPath),executableSha256=createHash('sha256').update(await readFile(executable)).digest('hex');
export async function namespaceDataFixture(t,{backend='sqlite',kind='query',expected=50,timeoutMs=30000,query='SELECT sum(amount) AS total FROM orders;'}={}){
  const f=await namespaceApprovalFixture(t,{backend,storyText:'# Revenue analysis\n\nREQ-REVENUE: Reconcile revenue from an immutable orders snapshot with the approved SQL.\nAC-RECONCILE: The reported revenue must equal '+expected+'.\n',configure(source){
    source.schemaVersion=2;source.format='sflow-namespace-configuration-source/v2';
    const intake=source.definition.phases.intake;
    source.definition.phases.analyze={...structuredClone(intake),label:'Analyze data',artifact:{path:'artifacts/analyze/report.md'},inputs:[{phase:'intake'}]};
    source.definition.phases.accept={...structuredClone(intake),label:'Accept result',artifact:{path:'artifacts/accept/report.md'},inputs:[{phase:'analyze'}]};
    for(const id of ['intake','analyze','accept']){source.definition.phases[id].approval.rejectTo=[id];source.definition.phases[id].approval.allowSelfApproval=false;}
    source.definition.approvalAuthorities.reviewers.members.push({email:'independent@example.test'});
    source.definition.workTypes.simple.phases=['intake','analyze','accept'];source.agents[0].phases=['intake','analyze','accept'];source.agents[0].defaultFor=['intake','analyze','accept'];
    source.workProducts={simple:{schemaVersion:1,profile:'sflow-work-product-policy/v1',requirements:[{id:'REQ-REVENUE',statement:'Reconcile revenue from the retained orders snapshot using the approved SQL.',criteria:['AC-RECONCILE']}],assets:[
      {id:'orders',kind:'dataset-snapshot',mimeType:'application/json'},{id:'query',kind:'query',mimeType:'text/plain'},
      {id:'result',kind:kind==='batch'?'pipeline-output':'report',mimeType:'application/json'}],phases:[
      {id:'intake',inputs:[],outputs:['orders','query'],execution:null,criteria:[]},
      {id:'analyze',inputs:['orders','query'],outputs:['result'],execution:{adapterId:'sql-data',kind,query:'query',inputs:[{assetId:'orders',table:'orders'}],output:'result'},
        criteria:[{id:'AC-RECONCILE',description:'Total reconciles to the approved expected revenue.',metric:{kind:'sum',column:'total'},operator:'eq',expected}]},
      {id:'accept',inputs:['result'],outputs:[],execution:null,criteria:[]}]}};
  }});
  f.control.permissions.push('work-product.context','work-product.retain','data.execute','phase.prepublish','phase.enter','phase.context.read');
  const common={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock},
    manifest=createExecutionUnitManifest({id:'sql-data',version:'1.0.0',publisher:'test-host',provider:'deterministic-sqlite',models:[],capabilities:{query:true,batch:kind==='batch'},
      sandbox:{kind:'fixed-sql-driver'},network:{mode:'deny'},toolPolicy:{profile:'sflow-sql-data-execution/v1',runtimeSha256:'sha256:'+executableSha256,driverSha256:SQLITE_DATA_DRIVER_SHA256,...(kind==='batch'?{sinkId:'results',projectId:f.scope.projectId}:{})},risk:{class:'bounded'},tests:{conformanceReceiptSha256:sha256('test-only-qualification')}}),
    sink={filename:path.join(await realpath(f.directory),'result-sink.db'),projectId:f.scope.projectId,id:'results'},
    makeUnit=(deadlineMs=timeoutMs)=>createSqliteDataExecutionUnit({manifest,executable,executableSha256,content:f.content,scope:f.scope,sink:kind==='batch'?sink:null,timeoutMs:deadlineMs,
      authorize:()=>f.control.permissions.includes('data.execute')}),
    unit=makeUnit(),
    data={owner:createNodeExecutionOwner({hostId:'data-test-host'}),bindings:[{adapterId:'sql-data',unit}]};
  const make=(extra={})=>createNamespaceEngine({...common,working:{records:f.localRecords,content:f.localContent},data,...extra}),engine=make(),
    put=async value=>(await f.content.put(f.scope,'evidence',Buffer.from(typeof value==='string'?value:canonicalJson(value)))).reference;
  const dataset={schemaVersion:1,profile:'sflow-tabular-snapshot/v1',columns:[{name:'id',type:'integer',nullable:false},{name:'amount',type:'number',nullable:false}],rows:[{id:1,amount:20},{id:2,amount:30}]};
  async function retainInputs(){
    for(const [assetId,value]of [['orders',dataset],['query',query]])await engine.run('work-product.retain',{
      operationId:'retain-'+assetId,workId:f.inputs.workId,phaseId:'intake',assetId,content:await put(value),reason:'Retain the reviewed immutable '+assetId+' input.'});
  }
  const reviewerAccess={current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',identity:{name:'Independent reviewer',email:'independent@example.test',login:null},
    agentId:null,permissions:['phase.approve']})};
  async function approve(phaseId){const human=make({access:reviewerAccess,data:undefined}),confirmation=await f.confirmation(human,phaseId);return human.run('phase.approve',{phaseId,confirmation});}
  async function authorAndSubmit(phaseId){await engine.run('phase.prepare',{phaseId});const draft=await engine.run('phase.draft.read',{phaseId});
    await engine.run('phase.draft.write',{operationId:'author-'+phaseId,workId:f.inputs.workId,phaseId,expectedRevision:draft.manifest.draft.revision,
      content:await f.upload('# Actual '+phaseId+' observations\n\nReviewed the bound inputs, output dataset and exact observed reconciliation checks. No process success is substituted for acceptance.\n'),reason:'Author the observed result.'});
    await engine.run('phase.publish',{phaseId,authored:'governed-agent',channel:'copilot-host'});return engine.run('phase.submit',{phaseId});}
  const requests=new Map();
  async function execute(operationId='execute-1',extra={}){if(!requests.has(operationId)){const context=await engine.run('work-product.context',{phaseId:'analyze'});requests.set(operationId,{
    operationId,workId:f.inputs.workId,phaseId:'analyze',expected:context.expected,...(kind==='batch'?{batchId:'batch-1'}:{}),...extra});}return engine.run('data.execute',requests.get(operationId));}
  return {...f,common,engine,make,put,data,unit,makeUnit,manifest,sink,kind,dataset,retainInputs,approve,authorAndSubmit,execute,requests};
}
