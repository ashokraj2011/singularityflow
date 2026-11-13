import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceForwardFixture} from './helpers/namespace-forward-fixture.mjs';
test('an approved forward projection is not misrepresented as an original phase submission',{timeout:120000},async t=>{
  const f=await namespaceForwardFixture(t,{backend:'sqlite'});await f.propose();await f.decide();
  const before=await f.capture();assert.equal(before.workflow.phases.intake.status,'approved');
  await assert.rejects(f.engine.run('phase.submit',{phaseId:'intake'}),error=>error.code==='PHASE_DRAFT_NOT_ACTIVE'
    &&error.details.profile==='sflow-namespace-forward-submission-handoff/v1'&&error.details.actions.some(row=>row.operation==='story.next'));
  assert.deepEqual(await f.capture(),before);
});
