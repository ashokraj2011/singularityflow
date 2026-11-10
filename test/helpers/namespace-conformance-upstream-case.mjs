/** A genuine upstream decision is reused by every exactly linked conformance gap. */
import assert from 'node:assert/strict';
import {namespaceReleaseFixture,releaseReport,releasePublish} from './namespace-release-fixture.mjs';
const reason='The actual Code owner accepts this bounded and explicitly disclosed delivery limitation.';
export async function namespaceConformanceUpstreamCase(t,backend){
  const f=await namespaceReleaseFixture(t,{backend});f.control.permissions.push('upstream.raise','upstream.decide','upstream.list','conformance.context','conformance.decide');
  const raised=await f.engine.run('upstream.raise',{operationId:'retained-code-issue',phaseId:'build',about:'STORY-1:REQ-001 and STORY-1:AC-001',
    problem:'The approved implementation has an explicitly disclosed bounded operational limitation.',proposed:'accept-risk',authored:'human'});
  assert.equal(raised.records[0].id,'UPI-001');
  const report=releaseReport('partial').replaceAll('| partial |','| partial (UPI-001) |');
  await f.write('release',report);await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});
  const published=await f.published('release');assert.equal(published.policy.kind,'conformance/v2');assert.equal(published.report.schemaVersion,2);
  assert.ok(published.report.gaps.every(row=>row.issueRefs.length===1&&row.issueRefs[0]==='UPI-001'&&row.owners[0]==='build'));
  Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}});
  const context=await f.engine.run('conformance.context',{phaseId:'release'});assert.ok(context.gaps.every(row=>row.owners[0].choices.every(choice=>choice.operation==='upstream.decide')));
  await assert.rejects(f.engine.run('conformance.decide',{phaseId:'release',expected:context.expected,clauseId:'STORY-1:REQ-001',ownerPhase:'build',
    outcome:'accept-risk',expires:'2026-11-09',reason}),{code:'ENGINE_CONFORMANCE_UPSTREAM_ISSUE_REQUIRED'});
  const input={operationId:'decide-retained-code-issue',issueId:'UPI-001',outcome:'accept-risk',expires:'2026-11-09T00:00:00.000Z',reason},
    accepted=await f.engine.run('upstream.decide',input);
  const complete=await f.engine.run('conformance.context',{phaseId:'release'});
  assert.ok(complete.gaps.every(row=>row.owners[0].decision.active&&row.owners[0].decision.operationId===input.operationId&&row.owners[0].choices.length===0));
  f.control.agentId='release-reviewer';await f.approve('release');f.control.agentId=null;
  const final=await f.capture();assert.equal(final.workflow.status,'closed');assert.equal(final.workflow.upstreamIssueDecisions.length,1);
  assert.equal(final.workflow.namespaceHumanDecisionReceipts?.length??0,0);
  assert.deepEqual(await f.engine.run('upstream.decide',input),accepted);assert.deepEqual(await f.capture(),final);
  assert.deepEqual(await f.json(published.manifest.report),published.report);
}
