import test from 'node:test';import assert from 'node:assert/strict';import {rm} from 'node:fs/promises';
import {namespaceReleaseFixture,releasePublish,releaseReport} from './helpers/namespace-release-fixture.mjs';
import {createNamespaceRepairBudgetReader} from '../src/engine-storage/namespace-repair-budget-reader.mjs';
import {createNamespaceStoryObserver} from '../src/engine-storage/namespace-story-reader.mjs';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': an upstream owner consumes the same real repair budget without a fabricated review packet',{timeout:120000},async t=>{
  const f=await namespaceReleaseFixture(t,{backend,configure(source){source.definition.phases.build.repairBudget={maxAttempts:1,resetOnPhase:'intake'};
    source.definition.workTypes.simple.reworkLoops=[{from:'release',to:'build',maxAttempts:1,resetOnPhase:'intake'}];}});
  f.control.permissions.push('upstream.raise');const access={current:()=>({projectId:f.scope.projectId,principalId:'independent-reviewer',actorKind:'human',agentId:null,
    identity:{name:'Independent reviewer',email:'independent@example.test',login:null},permissions:['upstream.decide']})},reviewer=f.make({access,checks:f.checks}),
    request={operationId:'actual-budgeted-upstream-return',issueId:'UPI-001',outcome:'return',reason:'Execute a new reviewed Code generation before relying on this exact producer.'};
  const raise=id=>f.engine.run('upstream.raise',{operationId:'raise-budget-'+id,phaseId:'build',about:'the actual converter boundary '+id,
    problem:'The actual producer needs another independently reviewed retained boundary execution '+id+'.',authored:'human',proposed:'return'});
  await raise(1);const returned=await reviewer.run('upstream.decide',request),snapshot=await f.capture();
  assert.equal(snapshot.workflow.repairBudgets.build.attempts.length,1);assert.equal(snapshot.workflow.namespaceRepairBudgetHistory[0].phase,'build');
  const reader=createNamespaceRepairBudgetReader({observer:createNamespaceStoryObserver(f.common),scope:f.scope,workId:f.inputs.workId});await reader.admitted(snapshot);
  f.control.agentId='analyst';await f.write('build','# Revalidated converter\n\n## Agent brief\n\nExecute the unchanged approved converter under this exact human-authorized return.\n');
  await f.engine.run('phase.source.retain',{operationId:'budget-upstream-source',workId:f.inputs.workId,phaseId:'build'});
  const result=await f.engine.run('phase.checks.run',{operationId:'budget-upstream-test',workId:f.inputs.workId,phaseId:'build'});assert.equal(result.checks[0].tests.passed,1);
  await f.engine.run('phase.publish',{phaseId:'build',...releasePublish});await f.approve('build');f.control.agentId='release-reviewer';
  await raise(2);const head=await f.head();await assert.rejects(reviewer.run('upstream.decide',{...request,operationId:'exhausted-budget-upstream',issueId:'UPI-002'}),error=>{
    assert.equal(error.code,'REPAIR_BUDGET_EXHAUSTED');assert.ok(error.details.actions.some(row=>row.operation==='upstream.decide'));return true;});assert.deepEqual(await f.head(),head);
  // The original issue owner can explicitly dismiss the second finding; no risk or approval is invented.
  await reviewer.run('upstream.decide',{operationId:'owner-dismiss-budget-upstream',issueId:'UPI-002',outcome:'dismiss',
    reason:'The independent fixture reviewer inspected the retained execution and confirms this second observation is redundant.'});
  await f.write('release',releaseReport());await f.engine.run('phase.publish',{phaseId:'release',...releasePublish});await f.approve('release');assert.equal((await f.capture()).workflow.status,'closed');
  for(const root of f.roots)await rm(root,{recursive:true,force:true});
  const replay=createNamespaceEngine({...f.common,access,clock:{now(){throw Error('A shared-only return replay cannot consume another attempt.');}}});
  assert.deepEqual(await replay.run('upstream.decide',request),returned);assert.equal((await f.capture()).workflow.repairBudgets.build.attempts.length,1);
});
