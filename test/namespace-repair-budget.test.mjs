import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,rm} from 'node:fs/promises';import path from 'node:path';
import {namespaceReleaseFixture,releasePublish,releaseReport} from './helpers/namespace-release-fixture.mjs';
import {specificationText,planText} from './helpers/namespace-specification-fixture.mjs';
import {createNamespaceRepairBudgetReader} from '../src/engine-storage/namespace-repair-budget-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {createNamespaceReadSession} from '../src/engine-storage/namespace-read-session.mjs';
const reason='The independent reviewer returns this exact candidate for a separately executed correction.';
const configuration=source=>{source.definition.phases.build.repairBudget={maxAttempts:1,resetOnPhase:'intake'};
  source.definition.phases.release.approval.rejectTo=['intake','build','release'];
  source.definition.workTypes.simple.reworkLoops=[{from:'release',to:'build',maxAttempts:1,resetOnPhase:'intake'}];};
// This is a complete four-generation Story, not one SDK/package request. Package gates stay 120/60s.
for(const backend of ['filesystem','sqlite','application'])test(backend+': actual Code repairs consume one authenticated budget, exhaust, reset on new independent approval and replay',{timeout:600000},async t=>{
  const started=performance.now(),note=stage=>process.stdout.write(JSON.stringify({backend,stage,elapsedMs:Math.round(performance.now()-started)})+'\n');
  const f=await namespaceReleaseFixture(t,{backend,configure:configuration}),access={current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['phase.reject','phase.review']})},reviewer=f.make({checks:f.checks,access});let round=0;
  async function submittedRelease(verdict='partial'){f.control.agentId='release-reviewer';await f.write('release',releaseReport(verdict));
    await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.engine.run('phase.submit',{phaseId:'release'});
    const {manifest}=await reviewer.run('phase.review',{phaseId:'release'});process.stdout.write(backend+': reviewed release generation '+manifest.generation+'\n');
    return {phaseId:'release',target:'build',reason,confirm:manifest.reviewBinding.packetSha256};}
  async function repairBuild(){note('prepare Code repair '+(round+1));f.control.agentId='analyst';await f.write('build','# Revalidated implementation\n\n## Agent brief\n\nRetain the exact approved converter and execute another real boundary regression.\n');
    const file=path.join(f.root,'test/converter.test.js');await writeFile(file,(await readFile(file,'utf8'))+"\ntest('repair boundary "+(++round)+"',()=>assert.equal(convert(256),'100'));\n");
    await f.engine.run('phase.source.retain',{operationId:'budget-source-'+round,workId:f.inputs.workId,phaseId:'build'});
    const run=await f.engine.run('phase.checks.run',{operationId:'budget-tests-'+round,workId:f.inputs.workId,phaseId:'build'});assert.equal(run.checks[0].tests.failed,0);
    note('publish Code repair '+round);await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});note('approve Code repair '+round);await f.approve('build');process.stdout.write(backend+': independently approved repair '+round+'\n');}
  const input=await submittedRelease(),originalError=Object.assign(Error('The committed return acknowledgement exceeded its deadline.'),{code:'ETIMEDOUT',details:{deadlineMs:8765}});let lost=false;
  const records={...f.records,async transact(...args){const result=await f.records.transact(...args);if(!lost&&args[1].events.some(row=>row.payload?.operation==='phase.reject')){lost=true;throw originalError;}return result;}},
    interrupted=f.make({checks:f.checks,access,records});
  await assert.rejects(interrupted.run('phase.reject',input),error=>error===originalError);assert.equal(lost,true);
  const first=await reviewer.run('phase.reject',input),before=await f.capture();assert.equal(first.repairBudget.consumed,1);assert.equal(before.workflow.repairBudgets.build.resetGeneration,1);
  assert.equal(before.workflow.namespaceRepairBudgetHistory.length,1);assert.equal(before.workflow.changeRequests.length,1);
  const link=before.workflow.namespaceHumanDecisionReceipts.at(-1),wire=await f.json(link.record);assert.equal(wire.schemaVersion,2);assert.equal(wire.source.repairBudget.reset.generation,1);
  const reads=createNamespaceReadSession(f.common),reader=createNamespaceRepairBudgetReader({observer:createNamespaceStoryObserver({...f.common,records:reads.records,content:reads.content}),scope:f.scope,workId:f.inputs.workId});
  await reads.run(async()=>{for(const mutate of [w=>{w.repairBudgets.build.attempts=[];},w=>{w.namespaceRepairBudgetHistory=[];},w=>{w.namespaceHumanDecisionReceipts=[];},
    w=>{w.repairBudgets={};w.namespaceRepairBudgetHistory=[];}]){
    const forged=structuredClone(before);mutate(forged.workflow);await assert.rejects(reader.admitted(forged),{code:'ENGINE_STORAGE_CORRUPT'});}});
  assert.deepEqual(await reviewer.run('phase.reject',input),first);assert.deepEqual(await f.capture(),before);
  await repairBuild();const exhausted=await submittedRelease(),head=await f.head();
  await assert.rejects(reviewer.run('phase.reject',exhausted),error=>{assert.equal(error.code,'REPAIR_BUDGET_EXHAUSTED');assert.equal(error.details.consumed,1);
    assert.equal(error.details.actions.find(row=>row.operation==='phase.reject').inputs.target,'intake');return true;});assert.deepEqual(await f.head(),head);
  note('return for approved reset');const resetInput={...exhausted,target:'intake'},reset=await reviewer.run('phase.reject',resetInput);assert.equal(reset.repairBudget.consumed,1);
  const reopened=await f.capture();assert.equal(reopened.workflow.repairBudgets.build.resetGeneration,1);
  // Merely opening a reset generation does not reset a counter or supply human approval.
  const copied=structuredClone(reopened);copied.workflow.phases.intake.generation=2;copied.workflow.phases.intake.status='in_progress';
  const notReset=await reads.run(()=>reader.inspect(copied,'release','build'));assert.equal(notReset.selection.resetGeneration,1);
  note('author reset scope');f.control.agentId='analyst';await f.write('intake',specificationText);await f.engine.run('phase.publish',{phaseId:'intake',...releasePublish});await f.approve('intake');
  note('author replacement plan');await f.write('design',planText);await f.engine.run('phase.publish',{phaseId:'design',...releasePublish});await f.approve('design');
  await repairBuild();const afterReset=await submittedRelease(),again=await reviewer.run('phase.reject',afterReset);
  assert.equal((await f.capture()).workflow.repairBudgets.build.resetGeneration,2);assert.equal(again.repairBudget.consumed,1);assert.equal((await f.capture()).workflow.namespaceRepairBudgetHistory.length,3);
  await repairBuild();f.control.agentId='release-reviewer';await f.write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');
  assert.equal((await f.capture()).workflow.status,'closed');assert.equal(f.starts(),4);
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,access,clock:{now(){throw Error('A replay cannot consume another repair or change its time.');}}});
  assert.deepEqual(await replay.run('phase.reject',input),first);
});
