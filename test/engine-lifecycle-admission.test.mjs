import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import * as native from '../src/sequence.mjs';
import * as actor from '../src/phase-actor-policy.mjs';
import * as review from '../src/source-review-policy.mjs';
import * as rolePresentation from '../src/phase-transition-routes.mjs';
import * as core from '../src/kernel/lifecycle-transitions.mjs';
import * as admission from '../src/kernel/phase-admission.mjs';
import { admissionWorkflow, lifecycleAdmissionCases, observeLifecycleAdmission } from './helpers/lifecycle-admission-cases.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
test('56 original sequence, role and review-policy outcomes retain exact serialized values and errors', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-lifecycle-admission/native-v1.json', import.meta.url), 'utf8'));
  for (const [index, entry] of lifecycleAdmissionCases().entries()) {
    assert.equal(entry.name, baseline.cases[index].name);
    assert.equal(hash(JSON.stringify(observeLifecycleAdmission({ ...native, ...actor, ...review }, entry))), baseline.cases[index].sha256, entry.name);
  }
});

test('six moved rule bodies are unchanged and compatibility exports bind the same kernel functions', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/engine-lifecycle-admission/native-v1.json', import.meta.url), 'utf8'));
  const seen = new Set();
  for (const file of ['lifecycle-transitions','phase-admission']) {
    const text = await readFile(new URL(`../src/kernel/${file}.mjs`, import.meta.url), 'utf8');
    const ast = ts.createSourceFile(file + '.mjs', text, ts.ScriptTarget.Latest, true);
    for (const node of ast.statements.filter(ts.isFunctionDeclaration)) {
      const expected = baseline.functions[node.name.text];
      if (expected) { assert.equal(hash(node.body.getText(ast)), expected, node.name.text); seen.add(node.name.text); }
    }
  }
  assert.deepEqual([...seen].sort(), Object.keys(baseline.functions).sort());
  assert.equal(native.sequenceGateMode, core.sequenceGateMode); assert.equal(actor.readOnlyAgent, admission.readOnlyAgent);
  assert.equal(actor.phaseAgentMutationRestriction, rolePresentation.phaseAgentMutationRestriction);
  assert.equal(actor.assertPhaseAgentMayMutate, rolePresentation.assertPhaseAgentMayMutate);
  assert.equal(review.normalizeSourceReviewPolicy, admission.normalizeSourceReviewPolicy);
  assert.equal(review.assertSourceReviewerAvailable, admission.assertSourceReviewerAvailable);
});

test('semantic sequence admission is read-only and never treats soft mode as authorization', () => {
  const workflow = admissionWorkflow(); workflow.resolution.sequenceGates = { default: 'soft' };
  const before = structuredClone(workflow), decision = core.sequenceAdmission(workflow, { requestedPhase: 'delivery' });
  assert.equal(decision.allowed, false); assert.equal(decision.effect, 'switch'); assert.equal(decision.reason.kind, 'current-phase-only');
  assert.equal(typeof decision.reason, 'object'); assert.deepEqual(workflow, before);
  for (const status of ['in_progress','approved','cancelled','closed']) {
    workflow.status = status; workflow.pendingDecision = { after: 'draft', label: 'Human choice', by: ['reviewers'] };
    assert.deepEqual(core.sequenceAdmission(workflow), { allowed: false, gate: 'decision', targetPhase: 'draft', invalid: true,
      reason: { kind: 'pending-decision', label: 'Human choice', workId: workflow.workItem.id } });
  }
});

test('confirmed state reconciliation retains published bytes and history while invalidating the appropriate old approvals', () => {
  const workflow = admissionWorkflow(), before = structuredClone(workflow);
  const decision = core.sequenceAdmission(workflow, { requestedPhase: 'delivery' });
  const next = structuredClone(workflow), selected = next.phases.delivery;
  core.applyConfirmedSequenceState(next, selected, decision, 'confirmed-time');
  assert.deepEqual(workflow, before); assert.equal(next.currentPhase, 'delivery'); assert.equal(next.status, 'in_progress');
  assert.equal(selected.startedAt, 'confirmed-time'); assert.equal(selected.approvedAt, null); assert.equal(selected.approvalDisposition, undefined);
  assert.equal(next.phases.finish.approvals[0].invalidatedAt, 'confirmed-time');
  assert.equal(next.phases.finish.approvals[1].invalidatedAt, 'earlier');
  assert.deepEqual(next.history, before.history); assert.deepEqual(selected.artifacts, before.phases.delivery.artifacts);
  assert.throws(() => core.applyConfirmedSequenceState(next, next.phases.finish, decision, 'later'), { code: 'LIFECYCLE_TRANSITION_INVALID' });
});

test('inherited phase dictionary names cannot become transition targets, but an owned configured name works', () => {
  const workflow = admissionWorkflow();
  for (const requestedPhase of ['constructor','toString','__proto__']) {
    const decision = core.sequenceAdmission(workflow, { requestedPhase });
    assert.equal(decision.invalid, true); assert.equal(decision.reason.kind, 'unknown-phase');
    assert.throws(() => native.applySequenceDecision(workflow, { ...decision, effect: 'switch' }, 'now'), error => error.exitCode === 2);
  }
  workflow.phases.constructor = { ...workflow.phases.delivery, id: 'constructor' }; workflow.phaseOrder.push('constructor');
  assert.equal(core.sequenceAdmission(workflow, { requestedPhase: 'constructor' }).effect, 'switch');
});

test('reviewer roles and reviewer/author separation are facts shared with the compiler, not host command strings', () => {
  const workflow = admissionWorkflow(); workflow.resolution.sourceReview = { reviewerAgent: 'independent-reviewer' };
  const result = admission.phaseAgentMutationFacts({}, workflow, workflow.phases.draft, { agent: 'independent-reviewer' }, 'publish');
  assert.equal(result.allowed, false); assert.equal(result.code, 'SOURCE_REVIEW_REVIEWER_CANNOT_PUBLISH');
  assert.equal(result.author, 'phase-author'); assert.equal(Object.hasOwn(result, 'actions'), false); assert.equal(Object.hasOwn(result, 'message'), false);
  assert.throws(() => admission.assertSourceReviewerAvailable({ mode: 'enforce', phases: ['draft'], reviewerAgent: 'reviewer' },
    [{ id: 'reviewer', metadata: { 'sflow-mode': 'read-only-review' }, defaultFor: ['draft'] }]), { code: 'SOURCE_REVIEW_AUTHOR_COLLISION' });
});

test('overlapping host confirmations remain in their own asynchronous operation', async () => {
  let releaseA, releaseB;
  const a = new Promise(resolve => { releaseA = resolve; }), b = new Promise(resolve => { releaseB = resolve; });
  const seen = [];
  const first = native.withConfirmationPort(async (message, gate) => { seen.push(['a',message,gate]); return false; }, async () => {
    await a; return native.confirmOverride({ message: 'author-a', gate: 'currentPhase' });
  });
  const second = native.withConfirmationPort(async (message, gate) => { seen.push(['b',message,gate]); return true; }, async () => {
    await b; return native.confirmOverride({ message: 'author-b', gate: 'phaseStatus' });
  });
  releaseA(); const firstResult = await first; releaseB(); const secondResult = await second;
  assert.equal(firstResult, false); assert.equal(secondResult, true);
  assert.deepEqual(seen, [['a','author-a','currentPhase'],['b','author-b','phaseStatus']]);
});

test('nested and explicit confirmation ports retain their callback and rejection behavior', async () => {
  const result = await native.withConfirmationPort(async () => false, async () => {
    await assert.rejects(native.withConfirmationPort(async () => true, async () => { throw new Error('retained failure'); }), /retained failure/);
    assert.equal(await native.confirmOverride({ message: 'outer', gate: 'currentPhase' }), false);
    return native.confirmOverride({ message: 'explicit', gate: 'currentPhase' }, async () => true);
  });
  assert.equal(result, true);
});

test('kernel admission and confirmed aggregate rules execute with infrastructure refused and an empty PATH', () => {
  const source = `
    import {registerHooks} from 'node:module';
    const hooks=registerHooks({resolve(specifier,context,next){if(specifier.startsWith('node:'))throw new Error('infrastructure '+specifier);return next(specifier,context);}});
    const core=await import(${JSON.stringify(new URL('../src/kernel/lifecycle-transitions.mjs', import.meta.url).href)});
    const admission=await import(${JSON.stringify(new URL('../src/kernel/phase-admission.mjs', import.meta.url).href)});
    const fixture=await import(${JSON.stringify(new URL('./helpers/lifecycle-admission-cases.mjs', import.meta.url).href)});
    for(const input of fixture.lifecycleAdmissionCases()){
      if(input.kind==='sequence')core.sequenceAdmission(input.workflow,input.options);
      if(input.kind==='mode')core.sequenceGateMode(input.workflow,input.gate);
      if(input.kind==='agent')admission.phaseAgentMutationFacts(input.config,input.workflow,input.workflow.phases[input.phaseId],input.session,input.operation);
      if(input.kind==='apply'&&input.decision.targetPhase!=='absent'){
        const selected=input.workflow.phases[input.decision.targetPhase];core.applyConfirmedSequenceState(input.workflow,selected,input.decision,input.at);
      }
    }
    hooks.deregister();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module','-e',source], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PATH: '' } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
