import test from 'node:test';import assert from 'node:assert/strict';
import {namespaceReleaseFixture} from './helpers/namespace-release-fixture.mjs';
import {createNamespaceSubmissionEngine} from '../src/engine-storage/namespace-submission.mjs';
import {createNamespaceApprovalEngine} from '../src/engine-storage/namespace-approval.mjs';
import {createNamespaceRepairBudgetReader} from '../src/engine-storage/namespace-repair-budget-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceReadSession} from '../src/engine-storage/namespace-read-session.mjs';
test('repair counters honor actual configured approval authority, including an explicitly allowed and disclosed self-approval',{timeout:120000},async t=>{
  const f=await namespaceReleaseFixture(t,{configure(source){source.definition.phases.intake.approval.allowSelfApproval=true;
    source.definition.phases.build.repairBudget={maxAttempts:1,resetOnPhase:'intake'};
    source.definition.workTypes.simple.reworkLoops=[{from:'release',to:'build',maxAttempts:1,resetOnPhase:'intake'}];},
    async approveScope(f){await createNamespaceSubmissionEngine(f.common).run('phase.submit',{phaseId:'intake'});
      const engine=createNamespaceApprovalEngine(f.common),{manifest}=await engine.run('phase.review',{phaseId:'intake'}),binding=manifest.reviewBinding;
      await engine.run('phase.approve',{phaseId:'intake',confirmation:{workId:f.inputs.workId,phase:'intake',generation:binding.generation,reviewPacketSha256:binding.packetSha256}});}});
  assert.equal((await f.capture()).workflow.phases.intake.approvals[0].selfApproval,true);f.control.permissions.push('upstream.raise');
  await f.engine.run('upstream.raise',{operationId:'scope-policy-budget-request',phaseId:'build',about:'the actual approved boundary',
    problem:'Revalidate this actual Code producer through the configured reviewer return.',authored:'human',proposed:'return'});
  const reviewer=f.make({access:{current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['upstream.decide']})}});
  await reviewer.run('upstream.decide',{operationId:'scope-policy-budget-return',issueId:'UPI-001',outcome:'return',reason:'The actual configured approval threshold authorizes this exact reset anchor.'});
  const snapshot=await f.capture();assert.equal(snapshot.workflow.repairBudgets.build.resetGeneration,1);assert.equal(snapshot.workflow.repairBudgets.build.attempts.length,1);
  const link=snapshot.workflow.namespaceDecisionReceipts.find(row=>row.operation==='upstream.decide'),record=await f.json(link.record),vote=await f.json(record.source.repairBudget.reset.approvals[0]);
  assert.equal(vote.selfApproval,true);assert.equal(vote.thresholdReached,true);
  // A longer history must still be authenticated against the original return, rather than become unreadable at an unrelated count.
  const forged=structuredClone(snapshot);forged.workflow.namespaceRepairBudgetHistory=Array.from({length:129},()=>structuredClone(snapshot.workflow.namespaceRepairBudgetHistory[0]));
  const reads=createNamespaceReadSession(f.common),observer=createNamespaceStoryObserver({...f.common,records:reads.records,content:reads.content}),
    budgets=createNamespaceRepairBudgetReader({observer,scope:f.scope,workId:f.inputs.workId});
  await reads.run(()=>assert.rejects(budgets.admitted(forged),{code:'ENGINE_STORAGE_CORRUPT',message:'Repair counters differ from their last accepted transition.'}));
});
