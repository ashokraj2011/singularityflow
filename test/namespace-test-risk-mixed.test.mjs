import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceTestRiskFixture} from './helpers/namespace-test-risk-fixture.mjs';
import {createNodeCommandExecutionUnit} from '../src/sgos/node-check-execution-unit.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
for(const failingCompiler of [false,true])test('an environment risk '+(failingCompiler?'cannot waive a genuine compiler failure':'retains separate passing compiler facts without claiming tests passed'),{timeout:120000},async t=>{
  const command={id:'compile',argv:failingCompiler?['node','--input-type=module','-e','const = ;']:['node','--check','case.test.mjs'],kind:'compile',modelPolicy:'never',requirement:'required'},
    f=await namespaceTestRiskFixture(t,{configure(source){source.definition.phases.intake.qualityCommands.push(command);}}),template=f.checks.bindings[0],
    raw=await createNodeCommandExecutionUnit({id:'actual-risk-compiler',projectId:f.scope.projectId,repositoryId:'app',root:f.root,content:f.content,
      commandKind:'compile',command:{executable:process.execPath,executableSha256:template.executableSha256,arguments:command.argv.slice(1),environment:{}},
      authorizeCommand:manifest=>manifest.manifestSha256}),
    checks={...f.checks,bindings:[...f.checks.bindings,{...template,commandId:'compile',environment:{},unit:{...raw,start(task){f.control.starts++;return raw.start(task);}}}]},engine=f.make({checks});
  f.human();await engine.run('decision.test-risk',f.request);f.author();await f.rebase('rebase-mixed-risk');
  const run=await engine.run('phase.checks.run',f.input);assert.equal(run.verdict,'failed');assert.equal(run.checks[0].tests.failed,1);
  assert.equal(run.checks[1].tests,null);assert.equal(run.checks[1].status,failingCompiler?'failed':'passed');
  const proof=await createNamespacePhaseCheckReader(f.common).accepted(f.input);assert.equal(proof.plan.schemaVersion,4);
  if(failingCompiler)await assert.rejects(engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),{code:'TEST_RUN_RISK_NOT_ELIGIBLE'});
  else assert.equal((await engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'})).status,'published');
  assert.equal(f.control.starts,2);
});
