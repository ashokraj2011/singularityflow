/** Actual Code source, qualified SGOS execution and a separately authorized reuse decision. */
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {namespaceTestWitnessFixture} from './namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createEnvironmentQualifiedNodeCheckExecutionUnit} from '../../src/sgos/node-check-execution-unit.mjs';
import {createNodeExecutionOwner} from '../../src/sgos/node-execution-owner.mjs';
export const reuseReason='The original full execution covers the exact same source and runner inputs; retain its attribution without claiming another execution.';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
export async function namespaceCodeReuseFixture(t,{backend='sqlite',recovery=false,recoveryReuse='environment-qualified-exact',run=true,configure=()=>{},...extra}={}){
 const f=await namespaceTestWitnessFixture(t,{backend,run:false,...extra,configure:source=>{
  for(const email of ['independent@example.test','author@example.test'])if(!source.definition.approvalAuthorities.reviewers.members.some(row=>row.email===email))source.definition.approvalAuthorities.reviewers.members.push({email});
  source.definition.phases.build.approval={...source.definition.phases.build.approval,allowSelfApproval:false};
  if(recovery)source.definition.testRecovery={enabled:true,allowEvidenceReuse:true,reuseProfile:'environment-qualified-exact/v1'};configure(source);
 },beforeSpecification:recovery?async input=>{
  input.control.permissions.push('test-recovery.context','test-recovery.confirm');const engine=createNamespaceEngine(input.common),reuse=recoveryReuse,view=await engine.run('test-recovery.context',{reuse});
  await engine.run('test-recovery.confirm',{operationId:'confirm-qualified-recovery',phaseId:'intake',reuse,expectedContext:view.manifest.expectedContext,reason:reuseReason});
 }:undefined});
 let starts=0;const bindings=[];
 for(const [index,old]of f.checks.bindings.entries()){
  const unit=await createEnvironmentQualifiedNodeCheckExecutionUnit({id:'qualified-code-'+index,hostId:'qualified-code-host',root:f.roots[index],projectId:f.scope.projectId,repositoryId:old.repositoryId,content:f.content,
   command:{executable:process.execPath,executableSha256,arguments:['--test','test/converter.test.js'],environment:old.environment},report:{adapter:'node-tap',files:[]},authorizeCommand:m=>m.manifestSha256});
  bindings.push({...old,unit:{...unit,start(...args){starts++;return unit.start(...args);}}});
 }
 const checks={owner:createNodeExecutionOwner({hostId:'qualified-code-host'}),bindings,codeRecoveryReuse:true},make=options=>createNamespaceEngine({...f.options,checks,...options}),engine=make(),
  author=()=>Object.assign(f.control,{principalId:'code-reuse-author',agentId:'analyst',creator:{name:'Phase author',email:'author@example.test',login:null}}),
  human=()=>Object.assign(f.control,{principalId:'code-reuse-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
 f.control.permissions.push('evidence-reuse.context','decision.evidence-reuse');author();
 const producer={producerPhaseId:'build',producerOperationId:'original-code-execution'},runInput={operationId:producer.producerOperationId,workId:f.inputs.workId,phaseId:'build'};
 if(run)await engine.run('phase.checks.run',runInput);
 const view=()=>engine.run('evidence-reuse.context',{phaseId:'build',...producer}),decide=async()=>{human();const {manifest}=await view(),candidate=manifest.candidates[0],request={phaseId:'build',...producer,attemptId:candidate.taskId,reason:reuseReason};
  return {request,result:await engine.run('decision.evidence-reuse',request)};},
  rebase=async(operationId='rebase-reused-code')=>{author();const draft=await engine.run('phase.draft.read',{phaseId:'build'});
   await engine.run('phase.draft.rebase',{operationId,workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,confirm:draft.manifest.draft.bodySha256,reason:reuseReason});
   await engine.run('phase.source.retain',{operationId:operationId+'-source',workId:f.inputs.workId,phaseId:'build'});};
 const decideAll=async({phaseId='build',expires}={})=>{human();const view=await engine.run('evidence-reuse.context',{phaseId,...producer}),results=[];
  for(const candidate of view.manifest.candidates)results.push(await engine.run('decision.evidence-reuse',{phaseId,...producer,attemptId:candidate.taskId,reason:reuseReason,...(expires?{expires}:{})}));return results;};
 return {...f,checks,engine,make,author,human,producer,runInput,view,decide,decideAll,rebase,starts:()=>starts};
}
