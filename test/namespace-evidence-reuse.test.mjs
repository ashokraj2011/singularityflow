import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEvidenceReuseFixture,reuseReason} from './helpers/namespace-evidence-reuse-fixture.mjs';
import {rm,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {createNamespaceSubmissionReader} from '../src/engine-storage/namespace-submission-reader.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
test('reuse context and a human decision bind the original actual task without starting another process',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite'}),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'});
  assert.equal(view.manifest.candidates.length,1);assert.equal(view.manifest.candidates[0].sourceMatches,true);assert.equal(f.control.starts,1);
  f.human();const request={phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,reason:reuseReason},result=await f.engine.run('decision.evidence-reuse',request);
  assert.equal(result.record.profile,'sflow-namespace-evidence-reuse/v1');assert.equal(result.record.producer.phase,'intake');assert.equal(result.record.producer.tests.passed,1);
  assert.equal(result.record.producer.taskId,request.attemptId);assert.equal(result.currentPhase,'assess');assert.equal(f.control.starts,1);
  const again=await f.engine.run('decision.evidence-reuse',request);assert.deepEqual(again.record,result.record);
  assert.equal((await f.observer.inspect()).snapshot.workflow.namespaceEvidenceReuses.length,1);
});
test('new reuse cannot cite a failed, local-only, absent or nonmatching task',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite',run:false});f.human();
  for(const attemptId of ['TA-00000000000000000000','invented-task'])await assert.rejects(f.engine.run('decision.evidence-reuse',{
    phaseId:'assess',attemptId,reason:reuseReason}),{code:'EVIDENCE_REUSE_NOT_ELIGIBLE'});
  assert.equal((await f.observer.inspect()).snapshot.workflow.namespaceEvidenceReuses,undefined);assert.equal(f.control.starts,0);
  const failed=await namespaceEvidenceReuseFixture(t,{backend:'sqlite',failing:true});failed.human();
  await assert.rejects(failed.engine.run('decision.evidence-reuse',{phaseId:'assess',attemptId:'invented-task',reason:reuseReason}),{code:'EVIDENCE_REUSE_NOT_ELIGIBLE'});
  assert.equal(failed.control.starts,1);
});
test('an actual approved additive Story command is eligible even when its base workflow had no test command',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite',run:false,configure(source){source.definition.phases.intake.qualityCommands=[];}});
  f.accessControl.permissions.push('test-command.context','test-command.request','test-command.decide');
  const command=(await f.engine.run('test-command.context',{phaseId:'assess'})).manifest.commands[0].command;
  await f.engine.run('test-command.request',{phaseId:'intake',command:{profile:'sflow-namespace-story-command/v1',command,replaces:null},
    reason:'Add the actual reviewed structured test command to this otherwise document-only producer.'});
  f.human();await f.engine.run('test-command.decide',{accept:'TCD-001',reason:'The independent reviewer approves this exact additional test command.'});f.author();
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'});
  await f.engine.run('phase.draft.rebase',{operationId:'rebase-additive-producer',workId:f.inputs.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,
    confirm:draft.manifest.draft.bodySha256,reason:'Preserve the authored document after its acknowledged additive test command.'});
  await f.approveProducer();const view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'});
  assert.equal(view.manifest.candidates.length,1);assert.equal(view.manifest.candidates[0].sourceMatches,true);assert.equal(f.control.starts,1);
});
test('source changes and a changed command lapse reuse; real fresh execution remains the recovery',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite'}),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'}),task=view.manifest.candidates[0].taskId;
  const original=await readFile(path.join(f.root,'case.test.mjs'),'utf8');await writeFile(path.join(f.root,'case.test.mjs'),original+'\n// changed after producer approval\n');
  f.human();await assert.rejects(f.engine.run('decision.evidence-reuse',{phaseId:'assess',attemptId:task,reason:reuseReason}),{code:'ENGINE_SOURCE_CHANGED'});
  await writeFile(path.join(f.root,'case.test.mjs'),original);await f.engine.run('decision.evidence-reuse',{phaseId:'assess',attemptId:task,reason:reuseReason});
  await assert.rejects(f.engine.run('decision.evidence-reuse',{phaseId:'assess',attemptId:task,reason:reuseReason+' A second decision is unnecessary.'}),{code:'EVIDENCE_REUSE_ALREADY_RECORDED'});
  await f.prepareReceiver();await writeFile(path.join(f.root,'case.test.mjs'),original+'\n// changed before publication\n');
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'}),error=>
    error.code==='ENGINE_EVIDENCE_REUSE_INCOMPLETE'&&error.details.lapsed[0].state==='source-changed'
      &&error.details.actions.some(row=>row.operation==='phase.checks.run'));
  assert.equal((await f.observer.inspect()).snapshot.workflow.phases.assess.generation,0);assert.equal(f.control.starts,1);
});
test('revocation is append-only and a previously published reuse cannot slip through submission',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite'}),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'});
  f.human();await f.engine.run('decision.evidence-reuse',{phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,reason:reuseReason});await f.prepareReceiver();
  await f.engine.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'});f.human();
  await f.engine.run('decision.evidence-reuse',{revoke:'ERU-001',reason:'The receiving reviewer withdrew this original reuse authorization.'});f.author();
  await assert.rejects(f.engine.run('phase.submit',{phaseId:'assess'}),error=>error.code==='ENGINE_EVIDENCE_REUSE_INCOMPLETE'&&error.details.lapsed[0].state==='revoked');
  const snapshot=(await f.observer.inspect()).snapshot;assert.equal(snapshot.workflow.namespaceEvidenceReuses.length,2);
  assert.equal(snapshot.workflow.phases.assess.status,'in_progress');assert.equal(f.control.starts,1);
});
test('a human command amendment cannot silently inherit reuse of the old argv',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite'}),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'});f.human();
  await f.engine.run('decision.evidence-reuse',{phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,reason:reuseReason});
  f.accessControl.permissions.push('test-command.context','test-command.request','test-command.decide');f.author();
  const original=(await f.engine.run('test-command.context',{phaseId:'assess'})).manifest.commands[0];
  await f.engine.run('test-command.request',{phaseId:'assess',command:{profile:'sflow-namespace-story-command/v1',
    command:{...original.command,argv:[original.command.argv[0],'--test-concurrency=1',...original.command.argv.slice(1)]},
    replaces:{id:original.command.id,sha256:original.sha256}},reason:'The receiving phase now requires its exact amended test arguments.'});
  f.human();await f.engine.run('test-command.decide',{accept:'TCD-001',reason:'The independent reviewer confirms the changed command arguments.'});await f.prepareReceiver();
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'}),error=>
    error.code==='ENGINE_EVIDENCE_REUSE_INCOMPLETE'&&error.details.lapsed[0].state==='producer-or-command-changed');assert.equal(f.control.starts,1);
});
test('reuse never substitutes an agent identity or a caller success flag for a human reviewer',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite'}),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'}),
    request={phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,reason:reuseReason};
  await assert.rejects(f.engine.run('decision.evidence-reuse',{...request,approved:true}),{code:'ENGINE_INPUT_INVALID'});
  f.accessControl.actorKind='service';await assert.rejects(f.engine.run('decision.evidence-reuse',request),{code:'ENGINE_HUMAN_AUTHORITY_REQUIRED'});
  f.human();f.accessControl.actorKind='human';f.accessControl.creator.email='outside@example.test';
  await assert.rejects(f.engine.run('decision.evidence-reuse',request),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  assert.equal((await f.observer.inspect()).snapshot.workflow.namespaceEvidenceReuses,undefined);assert.equal(f.control.starts,1);
});
test('reuse expiry is checked again at submission and human approval, preserving the original publication',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite'}),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'}),
    at=await f.clock.now(),expires=new Date(new Date(at).getTime()+86400000).toISOString().slice(0,10);
  f.human();await f.engine.run('decision.evidence-reuse',{phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,expires,reason:reuseReason});await f.prepareReceiver();
  await f.engine.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'});
  const future=f.make({clock:{now:()=>new Date(new Date(at).getTime()+3*86400000).toISOString()}});
  await assert.rejects(future.run('phase.submit',{phaseId:'assess'}),error=>error.code==='ENGINE_EVIDENCE_REUSE_INCOMPLETE'&&error.details.lapsed[0].state==='expired');
  await f.engine.run('phase.submit',{phaseId:'assess'});f.human();const review=await f.engine.run('phase.review',{phaseId:'assess'}),binding=review.manifest.reviewBinding;
  await assert.rejects(future.run('phase.approve',{phaseId:'assess',confirmation:{workId:f.inputs.workId,phase:'assess',generation:binding.generation,reviewPacketSha256:binding.packetSha256}}),
    {code:'ENGINE_EVIDENCE_REUSE_INCOMPLETE'});
  assert.equal((await f.observer.inspect()).snapshot.workflow.phases.assess.approvals.length,0);assert.equal(f.control.starts,1);
});
test('takeover replays the same human decision without the old source, time or executor',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite'}),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'});f.human();
  const request={phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,reason:reuseReason},original=await f.engine.run('decision.evidence-reuse',request);
  await rm(f.root,{recursive:true,force:true});const later=f.make({sources:[],working:undefined,checks:undefined,clock:{now(){throw Error('No restamping.');}}});
  assert.deepEqual((await later.run('decision.evidence-reuse',request)).record,original.record);
  await assert.rejects(f.make({sources:[],working:undefined,checks:undefined}).run('decision.evidence-reuse',{...request,reason:reuseReason+' New authorization requires current source.'}),{code:'ENGINE_SOURCE_UNIT_UNAVAILABLE'});
  assert.equal((await f.observer.inspect()).snapshot.workflow.namespaceEvidenceReuses.length,1);
});
test('unreadable original receipts preserve the real error, and an interrupted acknowledgement cannot duplicate reuse',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend:'sqlite'}),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'});f.human();
  const request={phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,reason:reuseReason};let interrupted=false;
  const lost=Object.assign(Error('The actual accepted reuse acknowledgement was lost.'),{code:'SDA_NAMESPACE_OUTCOME_UNKNOWN'}),
    records={...f.records,async transact(scope,tx,options){const result=await f.records.transact(scope,tx,options);
      if(!interrupted&&tx.operationId.startsWith('lifecycle-')&&tx.changes.some(row=>row.namespace==='state'&&row.key.startsWith('stories/'))){interrupted=true;throw lost;}return result;}},engine=f.make({records});
  await assert.rejects(engine.run('decision.evidence-reuse',request),error=>error===lost);
  const replay=await engine.run('decision.evidence-reuse',request);assert.equal(replay.record.id,'ERU-001');
  const snapshot=(await f.observer.inspect()).snapshot,reference=snapshot.workflow.namespaceDecisionReceipts.find(row=>row.operation==='decision.evidence-reuse').record,
    denied=Object.assign(Error('The actual retained reuse receipt cannot be read.'),{code:'EACCES',path:'original-reuse-receipt'}),
    unreadable=f.make({content:{...f.content,read(scope,ref,options){if(ref.sha256===reference.sha256)throw denied;return f.content.read(scope,ref,options);}}});
  await assert.rejects(unreadable.run('evidence-reuse.context',{phaseId:'assess'}),error=>error===denied);
  assert.equal(snapshot.workflow.namespaceEvidenceReuses.length,1);assert.equal(f.control.starts,1);
});
for(const backend of ['filesystem','sqlite','application'])test(backend+': reuse publishes and independently approves without claiming a receiving execution',{timeout:120000},async t=>{
  const f=await namespaceEvidenceReuseFixture(t,{backend}),view=await f.engine.run('evidence-reuse.context',{phaseId:'assess'});
  f.human();const request={phaseId:'assess',attemptId:view.manifest.candidates[0].taskId,reason:reuseReason};
  await f.engine.run('decision.evidence-reuse',request);await f.prepareReceiver();
  const prepublish=await f.engine.run('phase.prepublish',{phaseId:'assess'});assert.equal(prepublish.manifest.qualityDisposition,'ready');
  assert.equal(prepublish.manifest.readiness.requiredTests,'reused-not-executed');
  const published=await f.engine.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'});assert.equal(published.status,'published');
  const snapshot=(await f.observer.inspect()).snapshot,publication=JSON.parse(Buffer.from((await f.content.read(f.scope,snapshot.workflow.phases.assess.publicationBindings[0].record)).data));
  assert.equal(publication.checks,null);assert.ok(publication.policyEvidence.some(row=>row.kind==='evidence-reuse/v1'));
  const submitted=await f.engine.run('phase.submit',{phaseId:'assess'});assert.equal(submitted.status,'awaiting-approval');f.human();
  const review=await f.engine.run('phase.review',{phaseId:'assess'}),binding=review.manifest.reviewBinding;
  assert.ok((await f.engine.run('phase.review.resources',{phaseId:'assess'})).manifest.resources.some(row=>row.kind==='evidence-reuse'));
  await f.engine.run('phase.approve',{phaseId:'assess',confirmation:{workId:f.inputs.workId,phase:'assess',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  assert.equal(f.control.starts,1);assert.equal((await f.observer.inspect()).snapshot.workflow.status,'closed');
  await rm(f.root,{recursive:true,force:true});
  const later=f.make({sources:[],working:undefined,checks:undefined,clock:{now(){throw Error('Shared proof replay cannot restamp a review.');}}});
  const retained=await later.run('phase.publish',{phaseId:'assess',authored:'governed-agent',channel:'copilot-host'});assert.equal(retained.status,'retained');
  const observer=createNamespaceStoryObserver({...f.common,sources:[]}),packets=createNamespaceSubmissionReader({observer,scope:f.scope,workId:f.inputs.workId,
    checks:createNamespacePhaseCheckReader({...f.common,sources:[],observer})}),retainedApproval=await packets.inspectApprovedMany((await observer.inspect()).snapshot,['assess']);
  assert.equal(retainedApproval[0].review.packetSha256,binding.packetSha256);
});
