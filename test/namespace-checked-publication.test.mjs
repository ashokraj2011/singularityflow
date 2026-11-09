/** Registered execution, exact conditional publication, shared submission and actual human approval. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {namespacePhaseCheckFixture} from './helpers/namespace-phase-check-fixture.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {createNamespaceSubmissionEngine} from '../src/engine-storage/namespace-submission.mjs';
import {createNamespaceApprovalEngine} from '../src/engine-storage/namespace-approval.mjs';
import {createNamespaceReadEngine} from '../src/engine-storage/namespace-reader.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceLifecycleReceiptReader} from '../src/engine-storage/namespace-lifecycle-receipt-reader.mjs';
import {namespacePublicationValue} from '../src/engine-storage/namespace-publication-contract.mjs';
import {namespaceSubmissionValue} from '../src/engine-storage/namespace-submission-contract.mjs';
const publishInput={phaseId:'intake',authored:'governed-agent',channel:'copilot-host'};
const reviewer={name:'Independent test reviewer',email:'checks-reviewer@example.test',login:null};
const independent=source=>{source.definition.approvalAuthorities.reviewers.members.push({email:reviewer.email});
  source.definition.phases.intake.approval.allowSelfApproval=false;};
async function fixture(t,options={}) {
  const f=await namespacePhaseCheckFixture(t,options);f.accessControl.permissions.push('phase.publish','phase.submit','phase.approve');
  const publisher=extra=>createNamespacePublicationEngine({...f.options,...extra});
  const shared={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock};
  const submitter=extra=>createNamespaceSubmissionEngine({...shared,...extra});
  const approver=extra=>createNamespaceApprovalEngine({...shared,...extra});
  const json=async ref=>JSON.parse(Buffer.from((await f.content.read(f.scope,ref)).data));
  return {...f,publisher,submitter,approver,json,shared};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': real checks flow through publication, shared review and independent human completion',async t=>{
  const f=await fixture(t,{backend,configure:independent}),checked=await f.engine.run('phase.checks.run',f.input);
  const publication=await f.publisher().run('phase.publish',publishInput);
  assert.equal(publication.status,'published');assert.equal(f.control.starts,1);
  const phase=(await f.state()).snapshot.workflow.phases.intake;
  const published=await f.json(phase.publicationBindings[0].record);
  assert.equal(published.schemaVersion,2);assert.equal(published.checks.result.version,checked.record.version);
  const reader=createNamespaceLifecycleReceiptReader(f.options),proof=await reader.accepted(published.operationId);
  assert.equal(proof.plan.schemaVersion,2);
  assert.ok(proof.plan.readBindings.some(row=>row.key===published.checks.index.key&&row.version===published.checks.index.version));
  assert.equal((await createNamespaceEngine(f.shared).run('phase.publish',publishInput)).status,'retained');
  const submitted=await f.submitter().run('phase.submit',{phaseId:'intake'});assert.equal(submitted.status,'awaiting-approval');
  const after=(await f.state()).snapshot.workflow.phases.intake,packet=await f.json(after.namespaceSubmission.record);
  assert.equal(packet.schemaVersion,3);assert.equal(packet.routing,null);assert.deepEqual(packet.checks,published.checks);
  const submissionProof=await reader.accepted(packet.operationId);assert.equal(submissionProof.plan.schemaVersion,2);
  const read=createNamespaceReadEngine(f.shared),review=await read.run('phase.review',{phaseId:'intake'});
  const binding=review.manifest.reviewBinding;
  Object.assign(f.accessControl,{principalId:'independent-check-reviewer',creator:reviewer,agentId:null});
  const accepted=await f.approver().run('phase.approve',{phaseId:'intake',confirmation:{workId:f.inputs.workId,phase:'intake',generation:1,
    reviewPacketSha256:binding.packetSha256}});
  assert.equal(accepted.approval.thresholdReached,true);assert.equal(accepted.approval.selfApproval,false);
  assert.equal((await f.state()).snapshot.workflow.status,'closed');assert.equal(f.control.starts,1);
  assert.equal((await f.state()).snapshot.workflow.phases.intake.approvals.length,1);
});

test('missing or failed checks have an exact repair route and cannot publish a generation',async t=>{
  for(const failing of [false,true]){
    const f=await fixture(t,{failing});
    if(failing)await f.engine.run('phase.checks.run',f.input);
    const before=(await f.state()).snapshot;
    await assert.rejects(f.publisher().run('phase.publish',publishInput),cause=>cause.code===(failing?'PHASE_CHECKS_NOT_PASSED':'ENGINE_CHECK_EVIDENCE_REQUIRED')
      &&cause.details.operation==='phase.checks.run');
    assert.deepEqual((await f.state()).snapshot,before);
  }
});
test('changing the authored artifact or source after successful checks requires current evidence',async t=>{
  const f=await fixture(t);await f.engine.run('phase.checks.run',f.input);
  await writeFile(path.join(f.root,'new-application-source.js'),'export const changed = true;');
  await assert.rejects(f.publisher().run('phase.publish',publishInput),{code:'ENGINE_SOURCE_CHANGED'});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.write',{operationId:'corrected-draft',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload('# Corrected artifact\n\nThe change describes a different exact reviewed outcome.'),reason:'Retain the corrected authored artifact.'});
  await assert.rejects(f.publisher().run('phase.publish',publishInput),{code:'ENGINE_CHECK_EVIDENCE_REQUIRED'});
  assert.equal(f.control.starts,1);assert.equal((await f.state()).snapshot.workflow.phases.intake.generation,0);
});
test('a later failed run cannot race publication; repairing checks produces a fresh candidate in the same phase',async t=>{
  const f=await fixture(t);await f.engine.run('phase.checks.run',f.input);
  const original=await readFile(path.join(f.root,'case.test.mjs'),'utf8');let pending=null;
  const records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
    const candidate=tx.changes.find(change=>change.namespace==='runtime'&&change.value?.operation==='phase.publish');
    if(candidate&&!pending){pending=structuredClone(candidate.value);
      await writeFile(path.join(f.root,'case.test.mjs'),original.replace('2+2,4','2+2,5'));
      assert.equal((await f.engine.run('phase.checks.run',{...f.input,operationId:'later-failed-checks'})).verdict,'failed');
    }
    return result;}};
  await assert.rejects(f.publisher({records}).run('phase.publish',publishInput),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.ok(pending);assert.equal((await f.state()).snapshot.workflow.phases.intake.generation,0);
  await writeFile(path.join(f.root,'case.test.mjs'),original);
  assert.equal((await f.engine.run('phase.checks.run',{...f.input,operationId:'repaired-checks'})).verdict,'passed');
  assert.equal((await f.publisher().run('phase.publish',publishInput)).status,'published');
  const current=(await f.state()).snapshot.workflow.phases.intake,publication=await f.json(current.publicationBindings[0].record);
  assert.notEqual(publication.operationId,pending.operationId);assert.equal(f.control.starts,3);
  assert.equal(publication.checks.operationId,'repaired-checks');
});
test('missing retained raw reports preserve their actual error on review without running another process',async t=>{
  const f=await fixture(t);await f.engine.run('phase.checks.run',f.input);await f.publisher().run('phase.publish',publishInput);
  const proof=await createNamespacePhaseCheckReader(f.options).accepted(f.input);
  const raw=proof.body.results[0].candidate.output.reports.raw[0].content;
  const content={...f.content,read(scope,ref,options){return ref.sha256===raw.sha256?{status:'missing',reference:ref,data:null}:f.content.read(scope,ref,options);}};
  await assert.rejects(f.submitter({content}).run('phase.submit',{phaseId:'intake'}),{code:'ENGINE_STORAGE_CONTENT_MISSING'});
  assert.equal(f.control.starts,1);assert.equal((await f.state()).snapshot.workflow.phases.intake.status,'in_progress');
});
test('checked records cannot be silently downgraded to earlier publication and submission formats',async t=>{
  const f=await fixture(t);await f.engine.run('phase.checks.run',f.input);await f.publisher().run('phase.publish',publishInput);
  await f.submitter().run('phase.submit',{phaseId:'intake'});
  const phase=(await f.state()).snapshot.workflow.phases.intake;
  const publication=await f.json(phase.publicationBindings[0].record),packet=await f.json(phase.namespaceSubmission.record);
  for(const [value,validate]of [[publication,namespacePublicationValue],[packet,namespaceSubmissionValue]]){
    const options={projectId:f.scope.projectId,workId:f.inputs.workId,phaseId:'intake'};
    assert.equal(validate(value,options),value);
    const downgraded={...value,schemaVersion:1,format:value.format.replace(/v\d$/u,'v1'),profile:value.profile.replace(/v\d$/u,'v1')};
    assert.throws(()=>validate(downgraded,options));
    const missing=structuredClone(value);delete missing.checks;assert.throws(()=>validate(missing,options));
  }
});
test('checked submission retains routing inputs and independent approval applies the pinned outcome',async t=>{
  const f=await fixture(t,{configure:source=>{independent(source);source.definition.workTypes.simple.decisions=[{
    id:'channel',label:'Channel',after:'intake',kind:'branch',inputs:[{name:'channel',values:['Web','Mobile']}],
    routes:[{id:'web',label:'Web',when:{channel:'Web'},to:'next'},{id:'otherwise',label:'Otherwise',to:'end',
      omits:structuredClone(source.definition.workTypes.simple.omits)}]}];}});
  await f.engine.run('phase.checks.run',f.input);await f.publisher().run('phase.publish',publishInput);
  await f.submitter().run('phase.submit',{phaseId:'intake',decisionValues:{channel:' Web '}});
  const phase=(await f.state()).snapshot.workflow.phases.intake,packet=await f.json(phase.namespaceSubmission.record);
  assert.equal(packet.schemaVersion,3);assert.deepEqual(packet.routing.record.values,{channel:'Web'});assert.equal(packet.checks.operationId,f.input.operationId);
  const binding=(await f.submitter().run('phase.review',{phaseId:'intake'})).manifest.reviewBinding;
  Object.assign(f.accessControl,{principalId:'routing-reviewer',creator:reviewer,agentId:null});
  const result=await f.approver().run('phase.approve',{phaseId:'intake',confirmation:{workId:f.inputs.workId,phase:'intake',generation:1,reviewPacketSha256:binding.packetSha256}});
  assert.equal(result.approval.selfApproval,false);assert.equal((await f.state()).snapshot.workflow.status,'closed');assert.equal(f.control.starts,1);
});
test('a lost checked publication acknowledgement preserves the actual error and recovers its original receipt',async t=>{
  const f=await fixture(t);await f.engine.run('phase.checks.run',f.input);let failed=false;
  const failure=Object.assign(Error('Actual checked publication acknowledgement timed out.'),{code:'ETIMEDOUT',details:{timeoutMs:300000}});
  const records={...f.records,async transact(scope,tx,options){const accepted=await f.records.transact(scope,tx,options);
    if(!failed&&tx.events.some(event=>event.eventType==='engine.operation-committed')){failed=true;throw failure;}return accepted;}};
  await assert.rejects(f.publisher({records}).run('phase.publish',publishInput),cause=>cause===failure);
  const published=await f.publisher().run('phase.publish',publishInput);assert.equal(published.status,'retained');
  assert.equal((await f.state()).snapshot.workflow.phases.intake.generation,1);assert.equal(f.control.starts,1);
});
test('check-proof reading has no filesystem/process imports or process launch dependency',()=>{
  const target=new URL('../src/engine-storage/namespace-phase-check-reader.mjs',import.meta.url).href;
  const source=`import {registerHooks} from 'node:module';
    const hooks=registerHooks({resolve(specifier,context,next){if(['node:child_process','node:fs','node:fs/promises'].includes(specifier))throw Error('Unexpected I/O import '+specifier);return next(specifier,context);}});
    try{const value=await import(${JSON.stringify(target)});if(typeof value.createNamespacePhaseCheckReader!=='function')throw Error('missing reader');}finally{hooks.deregister();}`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,PATH:''},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr||result.error?.message);
});
