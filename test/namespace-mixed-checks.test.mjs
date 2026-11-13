import test from 'node:test';import assert from 'node:assert/strict';
import {namespacePhaseCheckFixture} from './helpers/namespace-phase-check-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespacePhaseCheckReader} from '../src/engine-storage/namespace-phase-check-reader.mjs';
import {createNodeCommandExecutionUnit,NODE_COMMAND_EXECUTION_PROFILE} from '../src/sgos/node-check-execution-unit.mjs';
async function fixture(t,{backend='sqlite',failing=false,mismatch=false,recovery=false,testOutput=false}={}){
  const command={id:'compile',argv:failing?['node','--input-type=module','-e','const = ;']:testOutput?['node','--test','--test-reporter=tap','case.test.mjs']:['node','--check','case.test.mjs'],kind:'compile',modelPolicy:'never',requirement:'required'},
    f=await namespacePhaseCheckFixture(t,{backend,configure(source){source.definition.phases.intake.qualityCommands.push(command);
      if(recovery)source.definition.testRecovery={enabled:true};
      source.definition.approvalAuthorities.reviewers.members.push({email:'independent@example.test'});source.definition.phases.intake.approval.allowSelfApproval=false;},
      beforePrepare:recovery?async f=>{f.control.permissions.push('test-recovery.context','test-recovery.confirm');
        const {localRecords,localContent,...shared}=f.options,engine=createNamespaceEngine({...shared,working:{records:localRecords,content:localContent}}),
          {manifest}=await engine.run('test-recovery.context',{});
        await engine.run('test-recovery.confirm',{operationId:'agree-mixed-inventory',phaseId:'intake',expectedContext:manifest.expectedContext,
          reason:'The human reviewed the exact test and compiler command inventory and its retained failure policy.'});}:null}),
    template=f.checks.bindings[0],raw=await createNodeCommandExecutionUnit({id:'compile-check',projectId:f.scope.projectId,repositoryId:'app',root:f.root,content:f.content,
      commandKind:'compile',command:{executable:process.execPath,executableSha256:template.executableSha256,arguments:command.argv.slice(1),environment:{}},
      authorizeCommand:manifest=>manifest.manifestSha256});let compilationStarts=0;
  const unit=mismatch?template.unit:{...raw,start(contract){compilationStarts++;return raw.start(contract);}};
  const checks={...f.checks,bindings:[...f.checks.bindings,{...template,commandId:'compile',unit}]},
    {localRecords,localContent,...shared}=f.options,options={...shared,checks,working:{records:localRecords,content:localContent}},engine=createNamespaceEngine(options);
  f.accessControl.permissions.push('phase.publish','phase.submit','phase.approve','story.evidence');
  return {...f,engine,checks,options,shared,compilationStarts:()=>compilationStarts,command};
}
for(const backend of ['filesystem','sqlite','application'])test(backend+' real tests and compilation retain separate facts through publication, independent approval and shared-only replay',async t=>{
  const f=await fixture(t,{backend}),run=await f.engine.run('phase.checks.run',f.input),reader=createNamespacePhaseCheckReader(f.shared),proof=await reader.accepted(f.input);
  assert.equal(run.verdict,'passed');assert.equal(proof.plan.schemaVersion,4);assert.equal(proof.plan.executionProfile,'sflow-namespace-mixed-checks/v1');
  assert.equal(proof.body.checks.find(row=>row.id==='compile').tests,null);assert.equal(proof.body.checks.find(row=>row.id==='node-tests').tests.passed,1);
  const output=proof.body.results[1].candidate.output;assert.equal(output.format,NODE_COMMAND_EXECUTION_PROFILE);assert.equal(output.reports.adapter,null);assert.equal(output.reports.parsed,null);
  assert.equal(f.compilationStarts(),1);assert.equal(f.control.starts,1);
  await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'});await f.engine.run('phase.submit',{phaseId:'intake'});
  const reviewer=createNamespaceEngine({...f.shared,access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reader',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.approve']})}}),
    {manifest}=await reviewer.run('phase.review',{phaseId:'intake'}),binding=manifest.reviewBinding;
  const approved=await reviewer.run('phase.approve',{phaseId:'intake',confirmation:{workId:f.inputs.workId,phase:'intake',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});
  assert.equal(approved.approval.selfApproval,false);
  const shared=createNamespaceEngine({...f.shared,checks:{mode:'retained-only'}});assert.equal((await shared.run('phase.checks.run',f.input)).status,'retained');
  await assert.rejects(shared.run('phase.checks.run',{...f.input,operationId:'new-run-refused'}),error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.mode==='retained-only');
  assert.equal(f.compilationStarts(),1);assert.equal(f.control.starts,1);
});
test('a real compiler failure remains failed and cannot be substituted by the passing tests',async t=>{
  const f=await fixture(t,{failing:true}),result=await f.engine.run('phase.checks.run',f.input),proof=await createNamespacePhaseCheckReader(f.shared).accepted(f.input);
  assert.equal(result.verdict,'failed');assert.equal(proof.body.checks.find(row=>row.id==='node-tests').status,'passed');
  assert.equal(proof.body.checks.find(row=>row.id==='compile').status,'failed');assert.equal(proof.body.checks.find(row=>row.id==='compile').tests,null);
  await assert.rejects(f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'}),{code:'PHASE_CHECKS_NOT_PASSED'});
});
test('a test-report unit cannot be relabelled as the configured compiler',async t=>{
  const f=await fixture(t,{mismatch:true});await assert.rejects(f.engine.run('phase.checks.run',f.input),{code:'ENGINE_CHECK_BINDING_CHANGED'});
  assert.equal(f.control.starts,0);assert.equal(f.compilationStarts(),0);
});
test('TAP-looking output from a declared compiler remains a command observation',async t=>{
  const f=await fixture(t,{testOutput:true});await f.engine.run('phase.checks.run',f.input);
  const proof=await createNamespacePhaseCheckReader(f.shared).accepted(f.input),observed=proof.body.results[1].candidate.output;
  assert.equal(observed.reports.parsed,null);assert.equal(proof.body.checks[1].tests,null);
  assert.match(Buffer.from((await f.content.read(f.scope,observed.stdout)).data).toString(),/TAP version/);
});
test('mixed checks retain the actual confirmed recovery agreement without changing recovery-only check-plan v3',async t=>{
  const f=await fixture(t,{recovery:true});assert.equal((await f.engine.run('phase.checks.run',f.input)).verdict,'passed');
  const proof=await createNamespacePhaseCheckReader(f.shared).accepted(f.input);
  assert.equal(proof.plan.schemaVersion,4);assert.equal(proof.plan.recovery.profile,'sflow-namespace-test-recovery-check/v1');
  assert.equal(proof.plan.recovery.agreements.length,1);
  assert.equal((await f.engine.run('phase.publish',{phaseId:'intake',authored:'governed-agent',channel:'copilot-host'})).status,'published');
});
test('retained-only adapters cannot contain an executor binding or create a new execution',async t=>{
  const f=await fixture(t),engine=createNamespaceEngine({...f.options,checks:{mode:'retained-only'},repairs:{mode:'retained-only'}});
  await assert.rejects(engine.run('phase.checks.run',f.input),error=>error.code==='ENGINE_PORT_UNAVAILABLE'&&error.details.mode==='retained-only');
  assert.equal(f.control.starts,0);assert.equal(f.compilationStarts(),0);
  assert.throws(()=>createNamespaceEngine({...f.options,checks:{...f.checks,mode:'retained-only'}}),{code:'ENGINE_INPUT_INVALID'});
});
