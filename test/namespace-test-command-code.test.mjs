/** Real Code source, approved traceability and executed tests use the retained human command overlay. */
import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {readFile,rm} from 'node:fs/promises';
import {namespaceTestWitnessFixture} from './helpers/namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNodeCheckExecutionUnit} from '../src/sgos/node-check-execution-unit.mjs';
const reason='The independent reviewer approves this exact Story command; all approved tests and assertions remain required.';
for(const backend of ['filesystem','sqlite','application'])test(backend+': amended commands carry real Code acceptance through independent approval and takeover',{timeout:120000},async t=>{
  const f=await namespaceTestWitnessFixture(t,{backend,run:false}),permissions=['test-command.context','test-command.request','phase.review','phase.submit'];
  f.control.permissions.push(...permissions);const view=await f.engine.run('test-command.context',{phaseId:'build'}),entry=view.manifest.commands[0],
    command={...entry.command,argv:[entry.command.argv[0],'--test-concurrency=1',...entry.command.argv.slice(1)]},
    request={phaseId:'build',command:{profile:'sflow-namespace-story-command/v1',command,replaces:{id:command.id,sha256:entry.sha256}},reason},
    decision={accept:'TCD-001',reason},human=createNamespaceEngine({...f.common,access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',
      actorKind:'human',identity:{name:'Independent reviewer',email:'independent@example.test',login:null},agentId:null,permissions:['test-command.decide','phase.review','phase.approve']})}});
  await f.engine.run('test-command.request',request);await human.run('test-command.decide',decision);
  const draft=await f.engine.run('phase.draft.read',{phaseId:'build'});await f.engine.run('phase.draft.rebase',{operationId:'continue-code-with-human-command',workId:f.inputs.workId,phaseId:'build',
    expectedRevision:draft.manifest.draft.revision,confirm:draft.manifest.draft.bodySha256,reason});
  const prior=f.checks.bindings[0],executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
    unit=await createNodeCheckExecutionUnit({id:'real-amended-code-command',root:f.root,projectId:f.scope.projectId,repositoryId:'app',content:f.content,
      command:{executable:process.execPath,executableSha256,arguments:command.argv.slice(1),environment:prior.environment},report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256}),
    engine=createNamespaceEngine({...f.options,checks:{...f.checks,bindings:[{...prior,unit}]}});
  await engine.run('phase.source.retain',{operationId:'retain-code-under-amended-command',workId:f.inputs.workId,phaseId:'build'});
  const input={operationId:'execute-human-amended-code-command',workId:f.inputs.workId,phaseId:'build'},executed=await engine.run('phase.checks.run',input);
  assert.equal(executed.checks[0].tests.passed,1);assert.equal(executed.verdict,'passed');
  const witnesses=await engine.run('phase.test-witnesses.inspect',{phaseId:'build'});assert.equal(witnesses.manifest.totals.met,1);
  await engine.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'});
  await engine.run('phase.submit',{phaseId:'build'});
  await assert.rejects(engine.run('test-command.request',{...request,reason:'Request a different successor while the submitted packet is still awaiting its original approval.'}),
    error=>error.code==='TEST_COMMAND_DECISION_DURING_REVIEW'&&error.details.actions.some(row=>row.operation==='phase.reject'&&row.inputs.target==='design'));
  const review=await human.run('phase.review',{phaseId:'build'}),binding=review.manifest.reviewBinding;
  assert.equal((await human.run('phase.approve',{phaseId:'build',confirmation:{workId:f.inputs.workId,phase:'build',generation:binding.generation,reviewPacketSha256:binding.packetSha256}})).approval.selfApproval,false);
  assert.equal((await f.capture()).workflow.status,'closed');await rm(f.root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,clock:{now(){throw Error('Historical replay must keep the actual accepted command and execution.');}}});
  assert.equal((await replay.run('phase.publish',{phaseId:'build',authored:'governed-agent',channel:'copilot-host'})).status,'retained');
  const accepted=await human.run('test-command.decide',decision);assert.equal(accepted.record.accepts,'TCD-001');
});
