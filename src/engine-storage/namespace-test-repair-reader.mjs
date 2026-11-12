/** Authenticate repair reservations, scope and actual retry observations. No writes or execution. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {sourceSnapshot} from '../foundation/source-snapshot.mjs';
import {NODE_TEXT_DIGESTS} from '../records.mjs';
import {namespaceTestRecoveryPolicies} from '../kernel/test-recovery.mjs';
import {sourceSnapshotChanges} from '../kernel/source-changes.mjs';
import {isExecutableTestSourceCandidate,codeDeliveryCandidateScope} from '../engine-compatibility/node-source-policy.mjs';
import {repositoryPlanProjection} from '../engine-compatibility/node-repository-plan.mjs';
import {validateAgentTaskContract,validateExecutionUnitManifest,sha256} from '../sgos/node-execution-values.mjs';
import {namespaceLimits} from '../sda/namespace/contract.mjs';
import {exactObject,namespaceRevision} from '../sda/namespace/values.mjs';
import {createNamespaceTestRepairCodec,testRepairRecord} from './namespace-test-repair-contract.mjs';
import {createNamespaceTestRecoveryOwner} from './namespace-test-recovery-reader.mjs';
import {createNamespacePhaseCheckReader} from './namespace-phase-check-reader.mjs';
import {createNamespaceSpecificationReader} from './namespace-specifications.mjs';
import {createNamespaceSourceRetentionReader} from './namespace-source-retention-reader.mjs';
import {namespaceLifecycleStoryKey} from './namespace-lifecycle-codec.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),rules=namespaceTestRecoveryPolicies(NODE_TEXT_DIGESTS),
  fail=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>{throw new SingularityFlowError(message,{code,details});};
export const TEST_REPAIR_EXECUTION_PROFILE='sflow-namespace-test-repair-execution/v1';
export function createNamespaceTestRepairReader({observer,scope,workId}){
  const bindings=observer.evidenceReads,codec=createNamespaceTestRepairCodec({scope,workId,authority:bindings.authority,
    limits:namespaceLimits(bindings.records.descriptor.limits),textDigests:NODE_TEXT_DIGESTS}),
    checks=createNamespacePhaseCheckReader({...bindings,observer}),agreements=createNamespaceTestRecoveryOwner({observer,scope,workId}),
    plans=createNamespaceSpecificationReader({observer,scope,workId,checks}),retained=createNamespaceSourceRetentionReader({...bindings,observer});
  async function json(ref,signal){if(ref.bytes>33_554_432)fail('The repair record exceeds its byte limit.','ENGINE_STORAGE_LIMIT');
    const data=await observer.bytes(ref,ref.bytes,signal);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}
    catch(cause){throw new SingularityFlowError('The repair record is not valid UTF-8 JSON.',{code:'ENGINE_STORAGE_CORRUPT',cause});}}
  async function scopeFor(snapshot,phaseId,options={}){
    const planned=await plans.sourcePlan(snapshot,phaseId,options),phase=snapshot.workflow.phases[phaseId],paths=[];
    for(const repo of snapshot.workflow.sourceBindings?.current?.repositories??[]){
      const local=planned.repositoryPlan?repositoryPlanProjection(planned.repositoryPlan,repo.id):planned.planned,
        entries=[...(local.supportingFiles??[]),...Object.values(local.claims??{}).flatMap(row=>row.expectedPaths??[])],
        admitted=codeDeliveryCandidateScope([local],snapshot.workflow,phase);
      for(const path of entries)if(typeof path==='string'&&!isExecutableTestSourceCandidate(path,{sourceExtensions:[]})&&admitted?.allows(path))paths.push(repo.id+':'+path);
    }
    return {paths:[...new Set(paths)].sort(),proof:planned.proof};
  }
  async function source(snapshot,input,previous,{signal}={}){
    const failed=await checks.accepted({workId,phaseId:input.phaseId,operationId:input.failedOperationId},{signal});
    if(!failed||failed.plan.basis.headVersion!==snapshot.revision||!same(failed.plan.basis.configuration,snapshot.configuration))
      fail('Select the exact failed execution for the current lifecycle basis.','TEST_RECOVERY_FAILURE_REQUIRED');
    const agreement=await agreements.current(snapshot,{signal}),scopeProof=await scopeFor(snapshot,input.phaseId,{signal}),
      repair=rules.repairPlan({workflow:snapshot.workflow,phaseId:input.phaseId,agreement:agreement.agreement,failed,attempts:previous.attempts,paths:scopeProof.paths});
    return {failed,agreement,scopeProof,repair};
  }
  async function acceptedAttempt(input,{signal}={}){
    const keys=codec.keys(input),op=await bindings.records.inspectOperation(scope,keys.reservation,{signal}),
      metadata=await observer.record('runtime',keys.intent,true,signal,true);
    if(op.status==='missing'&&op.receipt===null){if(metadata)fail('A repair intent without acceptance cannot authorize execution.');return null;}
    if(!metadata)fail('The reserved repair lost its original intent.');
    const plan=testRepairRecord('attempt',await json(metadata.value.content,signal));
    exactObject(plan,['schemaVersion','profile','binding','input','parametersSha256','generation','draft','actor','basis','previous','repair','sources','manifest','contract']);
    exactObject(plan.previous,['version','attempts']);namespaceRevision(plan.previous.version);
    if(!same(plan.input,input)||!same(plan.binding,codec.binding)||plan.parametersSha256!==codec.digest({binding:codec.binding,input}))fail('The repair operation has another request.','ENGINE_OPERATION_ID_REUSED');
    const original=await observer.accepted(plan.basis.head.operationId,{signal}),head=plan.basis.head,
      state=await observer.state(await observer.bytes(head.state,head.state.bytes,signal),head,{signal}),snapshot={workflow:state.workflow,configuration:head.configuration,revision:plan.basis.headVersion};
    if(!same(head.state,original.plan.state)||original.receipt.records.find(row=>row.namespace==='state'&&row.key===namespaceLifecycleStoryKey(workId,NODE_TEXT_DIGESTS))?.version!==plan.basis.headVersion
      ||!same(original.state.workflow,state.workflow))fail('The repair intent lost its original lifecycle head.');
    if(!Array.isArray(plan.previous.attempts)||plan.previous.attempts.length>2)fail('The repair has an invalid predecessor budget.');
    const seen=new Set();let predecessor=null;for(const [index,row]of plan.previous.attempts.entries()){exactObject(row,['operationId','record']);
      if(seen.has(row.operationId)||row.operationId===input.operationId)fail('Duplicate repair reservation.');seen.add(row.operationId);
      const originalRequest=(await json(row.record,signal)).input;
      if(originalRequest?.operationId!==row.operationId||originalRequest.workId!==workId||originalRequest.phaseId!==input.phaseId)fail('The earlier repair belongs to another Story or phase.');
      const earlier=await acceptedAttempt(originalRequest,{signal});
      if(!earlier||!same(earlier.reference,row.record)||codec.indexKey(earlier.plan)!==codec.indexKey(plan)
        ||!same(earlier.plan.previous.attempts,plan.previous.attempts.slice(0,index)))fail('The repair budget has an unrelated or unaccepted predecessor.');predecessor=earlier;}
    if((predecessor?.receipt.records.find(row=>row.namespace==='runtime'&&row.key===codec.indexKey(plan))?.version??null)!==plan.previous.version)
      fail('The repair budget does not continue its last actual reservation.');
    const expected=await source(snapshot,input,plan.previous,{signal});
    if(!same(plan.repair,expected.repair)||!same(plan.sources,expected.failed.plan.sources)||!same(plan.draft,expected.failed.plan.draft))fail('The repair scope or failed source differs from its original proof.');
    validateExecutionUnitManifest(plan.manifest);validateAgentTaskContract(plan.contract,plan.manifest);
    // Inputs bind immutable failed evidence and the confirmed agreement, never the intent's own digest.
    if(plan.manifest.toolPolicy.profile!==TEST_REPAIR_EXECUTION_PROFILE||plan.manifest.toolPolicy.projectId!==scope.projectId
      ||plan.manifest.toolPolicy.phaseId!==input.phaseId||plan.contract.programSha256!=='sha256:'+codec.digest(plan.repair)
      ||!same(plan.contract.writeScope,plan.repair.allowedPaths)||!same(plan.contract.inputs,['sha256:'+expected.failed.record.content.sha256,expected.agreement.agreement.contextSha256]))
      fail('The repair execution contract changed its reviewed task or scope.');
    const tx=codec.transaction(plan,metadata.value.content),receipt=codec.receipt(op,tx);
    if(receipt.records.find(row=>row.key===keys.intent)?.version!==metadata.version)fail('The repair reservation has another revision.');
    codec.metadata(metadata.value,plan,metadata.value.content);return {plan,reference:metadata.value.content,receipt,snapshot,source:expected};
  }
  async function validateChanges(plan,after,signal){
    if(!Array.isArray(after)||after.length!==plan.sources.length)fail('The repair source inventory is incomplete.');const changes=[];
    for(const [index,row]of after.entries()){
      const before=plan.sources[index];if(row.id!==before.id||!same(row.descriptor,before.descriptor))fail('The repair changed its repository selection.');
      const original=sourceSnapshot(await json(before.content,signal),before.descriptor),current=sourceSnapshot(await json(row.content,signal),before.descriptor);
      if(row.revision!=='sha256:'+codec.digest(current))fail('The repair source revision differs from its retained bytes.');
      for(const change of sourceSnapshotChanges(original,current,before.descriptor).entries){
        for(const path of [change.oldPath,change.newPath].filter(Boolean))if(!plan.repair.allowedPaths.includes(row.id+':'+path))fail(
          'The repair changed a path outside its approved source/test-support scope. Preserve the checkout for human recovery.','TEST_RECOVERY_SCOPE_CHANGED',{
            repositoryId:row.id,path,operationId:plan.input.operationId,allowedPaths:plan.repair.allowedPaths});
        changes.push({repositoryId:row.id,...change});}
    }return changes;
  }
  async function accepted(input,{signal}={}){
    const keys=codec.keys(input),op=await bindings.records.inspectOperation(scope,keys.completion,{signal}),metadata=await observer.record('evidence',keys.result,true,signal,true);
    if(op.status==='missing'&&op.receipt===null){if(metadata)fail('An unaccepted repair result cannot support a retry claim.');return null;}
    if(!metadata)fail('The accepted repair result is missing.');
    const attempt=await acceptedAttempt(input,{signal});if(!attempt)fail('The repair result lost its reservation.');
    const result=testRepairRecord('result',await json(metadata.value.content,signal));
    exactObject(result,['schemaVersion','profile','input','attempt','recordedAt','handle','candidate','failure','quiescence','after','scopeViolation','source','checks','verdict']);
    if(!same(result.attempt,attempt.reference)||!same(result.input,input))fail('The repair result has another reserved attempt.');
    codec.metadata(metadata.value,attempt.plan,metadata.value.content,true);codec.receipt(op,codec.transaction(attempt.plan,metadata.value.content,{result:true}));
    if(result.candidate){const c=result.candidate;if(c.kind!=='candidate-result'||c.contractSha256!==attempt.plan.contract.contractSha256
      ||c.executionUnitManifestSha256!==attempt.plan.manifest.manifestSha256||c.outputSha256!==sha256(c.output)
      ||c.eventHeadSha256!==result.quiescence.eventHeadSha256)fail('The repair candidate has another execution binding.');}
    if(result.quiescence?.quiescent!==true||result.quiescence.handleSha256!==result.handle?.handleSha256
      ||result.handle?.contractSha256!==attempt.plan.contract.contractSha256)fail('The repair has no quiescent original execution.');
    let violation=null;try{await validateChanges(attempt.plan,result.after,signal);}catch(cause){if(cause.code!=='TEST_RECOVERY_SCOPE_CHANGED')throw cause;
      violation={name:cause.name,code:cause.code,message:cause.message,details:cause.details};}
    if(!same(result.scopeViolation,violation))fail('The repair scope diagnosis differs from its actual source changes.');
    if(violation&&(result.checks!==null||result.source!==null||result.verdict!=='scope-review-required'))fail('A scope violation cannot establish tested repair.');
    if(result.failure&&(result.checks!==null||result.source!==null||!violation&&result.verdict!=='repair-required'))fail('A failed executor cannot establish a tested repair.');
    if(result.checks){const observed=await checks.accepted({workId,phaseId:input.phaseId,operationId:result.checks.operationId},{signal}),
      source=await retained.accepted({workId,phaseId:input.phaseId,operationId:result.source.operationId},{signal});
      if(!observed||!source||!same(observed.record,result.checks.record)||!same(source.record,result.source.record)
        ||observed.plan.sources.some((row,index)=>row.revision!==result.after[index].revision)
        ||source.plan.sources.some((row,index)=>row.observed.revision!==result.after[index].revision)
        ||!same(observed.plan.draft,attempt.plan.draft)||result.verdict!==(observed.body.verdict==='passed'?'repaired':'repair-required'))fail('The repair retry has another source, draft or test result.');
    }else if(!result.failure&&result.scopeViolation===null)fail('An untested repair must preserve its execution failure.');
    return {...attempt,result,record:{key:keys.result,version:metadata.version,content:metadata.value.content}};
  }
  return Object.freeze({codec,checks,agreements,plans,json,source,acceptedAttempt,accepted,validateChanges});
}
