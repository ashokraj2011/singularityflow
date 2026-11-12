import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceTargetedRepairFixture,targetedReport} from './helpers/namespace-targeted-repair-fixture.mjs';
import {releasePublish} from './helpers/namespace-release-fixture.mjs';
for(const backend of ['sqlite','application','filesystem'])test(backend+': unchanged targeted Code needs fresh execution and preserves absence of an unconfigured repair budget',{timeout:600000},async t=>{
  const f=await namespaceTargetedRepairFixture(t,{backend,budget:false}),returned=await f.reviewer.run('phase.reject',f.request);assert.equal(returned.repairBudget,null);
  f.control.agentId='analyst';await f.write('build','# Revalidated converter\n\n## Agent brief\n\nRe-execute the actual converter and identity regressions without claiming another source edit.\n');
  const entry=await f.engine.run('phase.enter',{phaseId:'build'});assert.equal(entry.manifest.schemaVersion,4);
  await f.engine.run('phase.source.retain',{operationId:'unchanged-targeted-source',workId:f.inputs.workId,phaseId:'build'});
  const result=await f.runChecks('unchanged-targeted-fresh-tests');assert.equal(result.checks[0].tests.passed,2);
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.approve('build');const {report}=await f.published('build');
  assert.equal(report.preflight.history.profile,'sflow-namespace-code-history/v8');assert.equal(report.preflight.history.mode,'revalidated');
  assert.ok(report.preflight.history.repositories.every(row=>row.changes.length===0));
  const snapshot=await f.capture();assert.equal(Object.hasOwn(snapshot.workflow,'repairBudgets'),false);assert.equal(Object.hasOwn(snapshot.workflow,'namespaceRepairBudgetHistory'),false);
  f.control.agentId='release-reviewer';await f.write('release',targetedReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),2);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});assert.deepEqual(await f.reviewer.run('phase.reject',f.request),returned);
});
