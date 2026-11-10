/** Actual private/published reports, ordered receipt recovery, and cross-device replay. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
import {UPSTREAM_ISSUE_PROBLEM_MAXIMUM} from '../src/kernel/upstream-issues.mjs';
async function fixture(t,backend='filesystem'){
  const f=await namespaceEngineFixture(t,{backend,configure(source){
    for(const id of ['planning','followup'])source.definition.phases[id]={...structuredClone(source.definition.phases.intake),label:id,
      artifact:{path:'artifacts/'+id+'/report.md'}};
    source.definition.workTypes.simple.phases=['intake','planning','followup'];source.agents[0].phases.push('planning','followup');source.agents[0].defaultFor.push('planning','followup');
  }});
  f.control.permissions.push('upstream.raise','upstream.list','upstream.decide');
  await f.bootstrap();for(const phase of ['intake','planning']){await f.author(phase);await f.review(phase);}f.asAuthor();
  await f.engine.run('phase.prepare',{phaseId:'followup'});
  let edits=0;async function write(text){const draft=await f.engine.run('phase.draft.read',{phaseId:'followup'}),
    content=(await f.local.content.put(f.scope,'local',Buffer.from(text))).reference;
    await f.engine.run('phase.draft.write',{operationId:'authored-report-'+(++edits),workId:f.workId,phaseId:'followup',expectedRevision:draft.manifest.draft.revision,
      content,reason:'Record the actual upstream discrepancies without changing approved producers.'});}
  const report='# Current report\n\n## Upstream discrepancies\n\n'
    +'- intake: The approved document omits the actual deployment consequence for this capability.\n'
    +'- planning: The approved plan omits a required operational dependency for its verification.\n'
    +'- The reviewed documents disagree, but this item does not identify its producer.\n';
  await write(report);return {...f,write,report};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+': artifact filing preserves exact owners, deduplicates and replays without the old laptop',{timeout:120000},async t=>{
  const f=await fixture(t,backend),input={operationId:'file-actual-report',fromArtifact:true,authored:'human',proposed:'accept-risk'},
    raised=await f.engine.run('upstream.raise',input);
  assert.equal(raised.status,'recorded');assert.deepEqual(raised.records.map(row=>row.phase),['intake','planning']);assert.equal(raised.unowned.length,1);
  assert.ok(raised.records.every(row=>row.source.path.endsWith('/artifacts/followup/report.md')&&/^[a-f0-9]{64}$/u.test(row.source.itemSha256)));
  assert.deepEqual(await f.engine.run('upstream.raise',input),raised);
  const unchanged=await f.engine.run('upstream.raise',{...input,operationId:'inspect-same-report'});assert.equal(unchanged.status,'unchanged');
  assert.equal(unchanged.unowned.length,1);assert.equal((await f.capture()).workflow.upstreamIssues.length,2);
  await assert.rejects(f.engine.run('upstream.raise',{...input,proposed:'unknown'}),{code:'ENGINE_OPERATION_ID_REUSED'});
  f.asReviewer();await assert.rejects(f.engine.run('upstream.raise',input),{code:'ENGINE_ACTOR_CHANGED'});f.asAuthor();
  await f.author('followup');await f.review('followup');f.asAuthor();
  const before=await f.capture(),remote=f.make({working:null});assert.deepEqual(await remote.run('upstream.raise',input),raised);assert.deepEqual(await f.capture(),before);
  assert.equal((await remote.run('upstream.list',{})).issues.length,2);
});
test('a lost batch acknowledgement preserves the exact error and resumes the remaining item once',{timeout:120000},async t=>{
  const f=await fixture(t),lost=Object.freeze(Object.assign(Error('Actual shared response was lost.'),{code:'ETIMEDOUT',details:{deadlineMs:1234}}));let fail=true;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(fail&&args[1].events.some(row=>row.payload?.operation==='upstream.raise')){fail=false;throw lost;}return result;}};
  const input={operationId:'resume-report-prefix',fromArtifact:true},engine=f.make({records});
  await assert.rejects(engine.run('upstream.raise',input),error=>error===lost);assert.equal(fail,false);
  const result=await engine.run('upstream.raise',input);assert.equal(result.records.length,2);assert.equal((await f.capture()).workflow.upstreamIssues.length,2);
  assert.deepEqual(await f.engine.run('upstream.raise',input),result);
});
test('overlong and mixed manual inputs refuse before any issue, while original private read errors survive',{timeout:120000},async t=>{
  const f=await fixture(t),input={operationId:'bounded-report',fromArtifact:true},before=await f.capture();
  await assert.rejects(f.engine.run('upstream.raise',{...input,phaseId:'intake'}),{code:'UPSTREAM_ISSUE_OPTIONS_INVALID'});
  await f.write(f.report+'- intake: '+('x'.repeat(UPSTREAM_ISSUE_PROBLEM_MAXIMUM+20))+'\n');
  await assert.rejects(f.engine.run('upstream.raise',input),{code:'UPSTREAM_ISSUE_PROBLEM_TOO_LONG'});assert.deepEqual(await f.capture(),before);
  const denied=Object.freeze(Object.assign(Error('Original report read denied.'),{code:'EACCES',path:'/private/report'})),engine=f.make({
    working:{records:f.local.records,content:{...f.local.content,read(){throw denied;}}}});
  await assert.rejects(engine.run('upstream.raise',input),error=>error===denied);assert.deepEqual(await f.capture(),before);
});
test('an authored report changed after preparation cannot create an issue from the old body',{timeout:120000},async t=>{
  const f=await fixture(t);let changed=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);
    if(!changed&&args[1].changes.some(row=>row.namespace==='runtime'&&row.value?.operation==='upstream.raise')){
      changed=true;await f.write(f.report.replace('actual deployment consequence','a different reviewed consequence'));}return result;}};
  await assert.rejects(f.make({records}).run('upstream.raise',{operationId:'changed-report',fromArtifact:true}),{code:'ENGINE_CONTEXT_CHANGED'});
  assert.equal(changed,true);assert.equal((await f.capture()).workflow.upstreamIssues?.length??0,0);
});
test('published report filing also replays without any private working store',{timeout:120000},async t=>{
  const f=await fixture(t);await f.engine.run('phase.publish',{phaseId:'followup',authored:'governed-agent',channel:'copilot-host'});
  const engine=f.make({working:null}),input={operationId:'file-published-report',fromArtifact:true};
  const raised=await engine.run('upstream.raise',input);assert.equal(raised.records.length,2);assert.deepEqual(await engine.run('upstream.raise',input),raised);
});
