import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceSelectiveTestRecoveryFixture} from './helpers/namespace-selective-test-recovery-fixture.mjs';
const runner="import {run} from 'node:test';import {junit} from 'node:test/reporters';\nconst stream=run({files:process.argv.slice(4),concurrency:1});stream.on('test:fail',()=>{process.exitCode=1;});stream.compose(junit).pipe(process.stdout);\n";
test('a real pinned repository script selects whole files and retains independently observed native JUnit cases',{timeout:180000},async t=>{
  const f=await namespaceSelectiveTestRecoveryFixture(t,{runner}),{view}=await f.confirm();assert.equal(view.manifest.schemaVersion,2);assert.equal(view.manifest.executionMode,'reviewed-file-selection');
  assert.deepEqual(view.manifest.rows[0].argv,['node','test-runner.mjs','--test-reporter=junit','--','test/first.test.js']);
  await f.rebase();const result=await f.run();assert.equal(result.verdict,'passed');assert.equal(result.execution.mode,'reviewed-file-selection');assert.equal(result.checks.find(row=>row.id==='legacy-tests').tests.discovered,1);
  await f.engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  const p=await f.json((await f.capture()).workflow.phases.build.publicationBindings[0].record);assert.ok(p.policyEvidence.some(row=>row.kind==='code-delivery/v40'));
  const recovery=await f.json((await f.json(p.policyEvidence.find(row=>row.kind==='test-recovery/v4').record)).report);assert.equal(recovery.executionMode,'reviewed-file-selection');
});
