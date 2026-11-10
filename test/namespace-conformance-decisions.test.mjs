import test from 'node:test';import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './helpers/namespace-release-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
const reason='The original Code owner accepts this explicitly disclosed limitation until it can be repaired.';
test('exact owner decisions clear honest partial approval, survive takeover, and refuse stale, duplicate or unauthorised intents',async t=>{
  const f=await namespaceReleaseFixture(t,{configure:source=>{
    source.definition.approvalAuthorities.reviewers.allowAnyGitIdentity=false;
    source.definition.approvalAuthorities['quality-only']={allowAnyGitIdentity:false,members:[{email:'independent@example.test'},{email:'other@example.test'}]};
    source.definition.phases.release.approval.authorities=['quality-only'];
  }});f.control.permissions.push('conformance.context','conformance.decide','phase.reject');
  await f.write('release',releaseReport('partial'));await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});
  const original=await f.published('release');Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const context=await f.engine.run('conformance.context',{phaseId:'release'}),request={phaseId:'release',expected:context.expected,
    clauseId:'STORY-1:REQ-001',ownerPhase:'build',outcome:'accept-risk',expires:'2026-11-09',reason};
  assert.equal(context.gaps.length,2);assert.deepEqual(context.gaps[0].owners[0].authorities,['reviewers']);
  const before=await f.head();
  for(const change of [{expected:'f'.repeat(64)},{ownerPhase:'release'},{clauseId:'STORY-1:REQ-999'},{expires:'2026-11-08'}])await assert.rejects(
    f.engine.run('conformance.decide',{...request,...change}));
  f.control.creator={name:'Other reviewer',email:'other@example.test',login:null};await assert.rejects(f.engine.run('conformance.decide',request),{code:'APPROVAL_IDENTITY_NOT_AUTHORIZED'});
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});assert.deepEqual(await f.head(),before);
  const first=await f.engine.run('conformance.decide',request);assert.equal(first.record.outcome.verdict,'partial');
  assert.deepEqual(await f.engine.run('conformance.decide',request),first);
  await assert.rejects(f.engine.run('conformance.decide',{...request,reason:reason+' A different intent.'}),{code:'ENGINE_CONFORMANCE_ALREADY_DECIDED'});
  const second={...request,clauseId:'STORY-1:AC-001',outcome:'dismiss',expires:null,reason:'The report is deliberately conservative; the original retained execution proves this particular assertion.'};
  await f.engine.run('conformance.decide',second);
  f.control.now='2026-11-09T00:00:00.000Z';f.control.agentId='release-reviewer';await assert.rejects(f.approve('release'),{code:'ENGINE_CONFORMANCE_DECISION_REQUIRED'});f.control.agentId=null;
  const renewed=await f.engine.run('conformance.decide',{...request,expires:'2026-11-10',reason:reason+' The owner renews the dated risk.'});
  assert.notEqual(renewed.record.operationId,first.record.operationId);
  const decided=await f.engine.run('conformance.context',{phaseId:'release'});assert.ok(decided.gaps.every(gap=>gap.owners.every(owner=>owner.decision.active&&owner.choices.length===0)));
  f.control.agentId='release-reviewer';await f.approve('release');f.control.agentId=null;const final=await f.capture();assert.equal(final.workflow.status,'closed');
  assert.equal(final.workflow.namespaceHumanDecisionReceipts.length,3);assert.equal(f.starts(),1);
  assert.deepEqual(await f.json(original.manifest.report),original.report);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('A retained decision must not be restamped.');}}});
  assert.deepEqual(await replay.run('conformance.decide',request),first);
  assert.equal((await replay.run('phase.publish',{phaseId:'release',...releasePublish})).status,'retained');
});
