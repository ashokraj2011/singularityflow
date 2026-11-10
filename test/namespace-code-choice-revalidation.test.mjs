import test from 'node:test';import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './helpers/namespace-release-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceRoutingReceiptReader} from '../src/engine-storage/namespace-routing-receipt-reader.mjs';

test('a real human Code return through an ask preserves unchanged source, requires fresh tests and completes after revalidation',async t=>{
  const f=await namespaceReleaseFixture(t,{configure:source=>{
    source.definition.workTypes.simple.decisions=[{id:'release-choice',label:'Review the delivery',kind:'ask',after:'release',
      routes:[{id:'repair',label:'Revalidate Code',to:'build'},{id:'finish',label:'Finish',to:'end'}]}];
  }}),original=await f.published('build');f.control.permissions.push('decision.choose');
  async function choose(option){const {manifest}=await f.engine.run('decision.context');return {option,expected:manifest.question.key,
    reason:option==='repair'?'Review the same approved behavior with a separately executed regression run.':'The independently reviewed delivery and retained tests satisfy the approved requirements.'};}
  await f.write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const request=await choose('repair'),returned=await f.engine.run('decision.choose',request).catch(error=>{
    t.diagnostic(JSON.stringify({details:error.details,cause:error.cause?.message}));throw error;}),state=await f.capture();
  assert.equal(returned.currentPhase,'build');assert.equal(state.workflow.changeRequests[0].decision.by,'person');
  const reader=createNamespaceRoutingReceiptReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId}),
    link=state.workflow.namespaceRoutingChoiceReceipts[0],accepted=await reader.accepted(link);
  assert.equal(accepted.value.outcome.kind,'loop');
  Object.assign(f.control,{principalId:'author',agentId:'analyst',creator:{name:'Example reviewer',email:'reviewer@example.test',login:null}});
  await f.write('build','# Revalidated implementation\n\n## Agent brief\n\nThe human requested fresh execution of the same approved converter; the source is unchanged.\n');
  await f.engine.run('phase.source.retain',{operationId:'unchanged-successor-source',workId:f.inputs.workId,phaseId:'build'});
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'build',...releasePublish}),{code:'ENGINE_CHECK_EVIDENCE_REQUIRED'});
  await f.engine.run('phase.checks.run',{operationId:'unchanged-successor-tests',workId:f.inputs.workId,phaseId:'build'});
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});const successor=await f.published('build');
  assert.equal(successor.policy.kind,'code-delivery/v4');assert.equal(successor.report.preflight.history.mode,'revalidated');
  assert.equal(successor.report.preflight.history.profile,'sflow-namespace-code-history/v3');
  assert.ok(successor.report.preflight.history.return.choice.record);assert.ok(successor.report.preflight.history.repositories.every(row=>row.changes.length===0));
  assert.deepEqual(successor.report.preflight.history.predecessor.publication,original.binding);assert.equal(f.starts(),2);
  await f.approve('build');f.control.agentId='release-reviewer';await f.write('release',releaseReport());
  await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  await f.engine.run('decision.choose',await choose('finish'));assert.equal((await f.capture()).workflow.status,'closed');
  assert.deepEqual(await f.json(original.manifest.report),original.report);for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('A replay cannot restamp the human return.');}}});
  assert.deepEqual(await replay.run('decision.choose',request),returned);
});
