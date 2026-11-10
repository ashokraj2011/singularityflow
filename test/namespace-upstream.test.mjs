/** Earlier producer authority and original upstream receipts across all three storage hosts. */
import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceEngineFixture} from './helpers/namespace-engine-fixture.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': upstream issues retain producer ownership, exact human disposition and replay', {timeout:120000},async t=>{
  const f=await namespaceEngineFixture(t,{backend,configure(source){
    source.definition.phases.followup={...structuredClone(source.definition.phases.intake),label:'Followup'};
    source.definition.workTypes.simple.phases=['intake','followup'];
    source.agents[0].phases.push('followup');source.agents[0].defaultFor.push('followup');
  }});
  f.control.permissions.push('upstream.raise','upstream.decide','upstream.list');
  await f.bootstrap();await f.author();await f.review();f.asAuthor();
  const input={operationId:'raise-real-upstream',workId:f.workId,phaseId:'intake',about:'retained document',
    problem:'The approved document omitted the concrete operational consequence.',proposed:'accept-risk',authored:'human'};
  const raised=await f.engine.run('upstream.raise',input);
  assert.equal(raised.status,'recorded');assert.equal(raised.records[0].id,'UPI-001');
  const listed=await f.engine.run('upstream.list',{workId:f.workId,open:true});
  assert.equal(listed.issues.length,1);assert.equal(listed.issues[0].phase,'intake');
  const decision={operationId:'decide-real-upstream',workId:f.workId,issueId:'UPI-001',outcome:'accept-risk',
    expires:'2099-01-01',reason:'The reviewer accepts the bounded documented limitation.'};
  await assert.rejects(f.engine.run('upstream.decide',decision),error=>error.code==='UPSTREAM_ISSUE_RISK_EXPIRY_REQUIRED');
  const at=await f.clock.now();decision.expires=new Date(Date.parse(at)+86400000).toISOString();
  f.asReviewer();const decided=await f.engine.run('upstream.decide',decision);
  assert.equal(decided.status,'recorded');assert.equal(decided.records[0].authorityGroup,'reviewers');
  assert.equal((await f.engine.run('upstream.list',{open:true})).issues.length,0);
  assert.equal((await f.engine.run('upstream.raise',input).catch(error=>error)).code,'ENGINE_ACTOR_CHANGED');
  f.asAuthor();assert.deepEqual(await f.engine.run('upstream.raise',input),raised);
  assert.equal((await f.capture()).workflow.upstreamIssues.length,1);
  f.asReviewer();assert.deepEqual(await f.engine.run('upstream.decide',decision),decided);
  assert.equal((await f.capture()).workflow.upstreamIssueDecisions.length,1);
});
