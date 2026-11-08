import test from 'node:test';
import assert from 'node:assert/strict';
import {namespacePreparationFixture} from './helpers/namespace-preparation-fixture.mjs';
import {createNamespacePublicationEngine} from '../src/engine-storage/namespace-publication.mjs';
import {createNamespaceSubmissionEngine} from '../src/engine-storage/namespace-submission.mjs';
import {createNamespaceLifecycleObserver} from '../src/engine-storage/namespace-lifecycle-reader.mjs';
const publishInput={phaseId:'intake',authored:'governed-agent',channel:'copilot-host'};
async function prepared(t) {
  const f=await namespacePreparationFixture(t,{backend:'sqlite'});f.control.permissions.push('phase.publish','phase.submit');
  await f.engine.run('phase.prepare');const draft=await f.read(f.engine);
  await f.engine.run('phase.draft.write',{operationId:'author-overlap',workId:f.inputs.workId,phaseId:'intake',
    expectedRevision:draft.manifest.draft.revision,content:await f.upload('# Actual result\n\nA complete observable document retained for review.\n'),reason:'Retain the authored result.'});
  const common={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock};
  const publisher=extra=>createNamespacePublicationEngine({...common,localRecords:f.localRecords,localContent:f.localContent,...extra});
  return {...f,common,publisher};
}
test('an identical publication accepted during preparation is recovered without another generation',async t=>{
  const f=await prepared(t),fast=f.publisher();let accepted,entered=false;
  const access={async current(request){if(request.operation==='phase.publish'&&!entered){entered=true;accepted=await fast.run('phase.publish',publishInput);}return f.access.current(request);}};
  const recovered=await f.publisher({access}).run('phase.publish',publishInput);
  assert.equal(entered,true);assert.equal(recovered.revision,accepted.revision);
  const {snapshot}=await createNamespaceLifecycleObserver(f.common).capture();
  assert.equal(snapshot.workflow.phases.intake.generation,1);assert.equal(snapshot.workflow.phases.intake.publicationBindings.length,1);
});
test('an identical submission accepted during preparation retains its real packet and timestamp',async t=>{
  const f=await prepared(t);await f.publisher().run('phase.publish',publishInput);
  const fast=createNamespaceSubmissionEngine(f.common);let accepted,calls=0;
  const access={async current(request){if(request.operation==='phase.submit'&&++calls===2)accepted=await fast.run('phase.submit',{phaseId:'intake'});return f.access.current(request);}};
  const recovered=await createNamespaceSubmissionEngine({...f.common,access}).run('phase.submit',{phaseId:'intake'});
  assert.ok(accepted);assert.equal(recovered.revision,accepted.revision);assert.deepEqual(recovered.submission,accepted.submission);
  const {snapshot}=await createNamespaceLifecycleObserver(f.common).capture();assert.equal(snapshot.workflow.lineage.submissions.length,1);
});
