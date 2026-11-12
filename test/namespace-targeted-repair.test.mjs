import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceTargetedRepairFixture,unrelatedSource,targetedReport} from './helpers/namespace-targeted-repair-fixture.mjs';
import {releasePublish} from './helpers/namespace-release-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
// An entire two-generation Story with diagnostic and governed checks; installed request limits stay unchanged.
for(const backend of ['sqlite','application','filesystem'])test(backend+': targeted Code returns refuse unrelated changes, preserve actual evidence and replay without a checkout',{timeout:600000},async t=>{
  const f=await namespaceTargetedRepairFixture(t,{backend}),head=await f.head();
  await assert.rejects(f.reviewer.run('phase.reject',{...f.request,clauseIds:['STORY-1:REQ-999']}),{code:'ENGINE_REPAIR_CLAUSE_UNKNOWN'});assert.deepEqual(await f.head(),head);
  const lost=Object.assign(Error('The accepted targeted return acknowledgement exceeded its deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:23456}});let interrupted=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!interrupted&&args[1].events.some(row=>row.payload?.operation==='phase.reject')){interrupted=true;throw lost;}return result;}};
  await assert.rejects(f.make({records,access:f.reviewerAccess}).run('phase.reject',f.request),error=>error===lost);assert.equal(interrupted,true);
  const returned=await f.reviewer.run('phase.reject',f.request);assert.deepEqual(returned.changeRequest.clauseIds,['STORY-1:REQ-001']);assert.deepEqual(returned.repairBudget,{consumed:1,maximum:1});
  const returnedHead=await f.head();await assert.rejects(f.reviewer.run('phase.reject',{...f.request,clauseIds:['STORY-1:REQ-002']}));assert.deepEqual(await f.head(),returnedHead);
  const snapshot=await f.capture(),link=snapshot.workflow.namespaceHumanDecisionReceipts.at(-1),wire=await f.json(link.record);
  assert.equal(wire.schemaVersion,3);assert.deepEqual(wire.source.targeted.scope.repositories[0].paths,['src/converter.js','test/converter.test.js']);
  await f.begin({beforeSourceEdit:async()=>{const before=await f.head(),entry=await f.engine.run('phase.enter',{phaseId:'build'});
    assert.equal(entry.manifest.contract,'sflow-phase-entry-manifest/v4');assert.equal(entry.manifest.repairScope.changeRequestId,returned.changeRequest.id);
    assert.deepEqual(entry.manifest.repairScope.current.repositories[0].paths,['src/converter.js','test/converter.test.js']);
    const resource=entry.manifest.resources.find(row=>row.kind==='repair-scope'&&row.reference.sha256===link.record.sha256),
      read=await f.engine.run('phase.context.read',{workId:f.inputs.workId,phaseId:'build',contextSha256:entry.manifest.context.sha256,resourceId:resource.id});
    assert.equal(JSON.parse(read.content.text).operation,'phase.reject');assert.deepEqual(await f.head(),before);
  }});await writeFile(path.join(f.root,'src/other.js'),unrelatedSource+'// This edit is planned for another clause.\n');
  await f.engine.run('phase.source.retain',{operationId:'targeted-outside-source',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('targeted-outside-tests');const before=await f.head();
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',...releasePublish}),error=>{assert.equal(error.code,'ENGINE_TARGETED_REPAIR_SCOPE_EXCEEDED');
    assert.deepEqual(error.details.outside,[{repositoryId:'app',path:'src/other.js'}]);assert.ok(error.details.actions.some(row=>row.operation==='plan.correction.context'));return true;});
  assert.deepEqual(await f.head(),before);assert.equal((await f.capture()).workflow.phases.build.generation,1);
  await writeFile(path.join(f.root,'src/other.js'),unrelatedSource);await f.engine.run('phase.source.retain',{operationId:'targeted-corrected-source',workId:f.inputs.workId,phaseId:'build'});
  await f.runChecks('targeted-corrected-tests');await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.approve('build');
  const publication=await f.published('build');assert.ok([14,15].includes(publication.manifest.schemaVersion));
  assert.equal(publication.report.preflight.history.profile,'sflow-namespace-code-history/v8');assert.equal(publication.report.preflight.history.mode,'changed');
  f.control.agentId='release-reviewer';await f.write('release',targetedReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),3);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,access:f.reviewerAccess,clock:{now(){throw Error('Targeted replay cannot consume another attempt or change its time.');}}});
  assert.deepEqual(await replay.run('phase.reject',f.request),returned);
});
