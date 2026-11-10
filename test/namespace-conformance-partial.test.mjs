import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './helpers/namespace-release-fixture.mjs';
test('an honest partial release stays retained but cannot silently finish without its upstream human disposition',async t=>{
  const f=await namespaceReleaseFixture(t);await f.write('release',releaseReport('partial'));
  await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});const p=await f.published('release');
  assert.equal(p.report.gaps.length,2);assert.ok(p.report.gaps.every(row=>row.owners.includes('build')));
  await assert.rejects(f.approve('release'),error=>error.code==='ENGINE_CONFORMANCE_DECISION_REQUIRED'&&error.details.required.includes('upstream-gap-human-disposition'));
  const state=await f.capture();assert.equal(state.workflow.phases.release.status,'awaiting_approval');assert.notEqual(state.workflow.status,'closed');
  assert.equal(state.workflow.phases.release.approvals.length,0);assert.equal(f.starts(),1);
});
