import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withWorkflowIntentCatalog } from '../src/workflow-intent-catalog.mjs';
import { compileWorkflowMarkup, lowerWorkflowMarkup } from '../src/workflow-markup.mjs';
import { markupCompilerError } from '../src/workflow-markup-parser.mjs';
import { remapMarkupPhase, remapMarkupWorkflow } from '../src/workflow-markup-references.mjs';
import { resolveWorkType } from '../src/config.mjs';
import { SingularityFlowError } from '../src/util.mjs';
import { normalizeApprovalPolicy } from '../src/approval-authority.mjs';
import { refusalEnvelope } from '../src/refusal-remediation.mjs';
import * as patterns from '../src/workflow-intent-patterns.mjs';
import { workflowMarkupCandidate } from './helpers/workflow-markup-candidate.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('every installed workflow contract compiles and reviews with its effective policy preserved', async t => {
  const fixtures = await withWorkflowIntentCatalog(null, { source: 'installed' }, catalog =>
    Object.keys(catalog.definition.workTypes).map(workflowId => ({
      workflowId, definition: catalog.definition, expected: resolveWorkType(catalog.definition, workflowId),
      source: workflowMarkupCandidate(catalog, workflowId)
    })));
  assert.ok(fixtures.length >= 17, 'The corpus must include every installed contract, not a selected happy path.');
  for (const { workflowId, definition, expected, source } of fixtures) await t.test(workflowId, async () => {
    const result = await compileWorkflowMarkup(source, { designReview: true });
    assert.equal(result.status, 'portable-ready');
    assert.ok(Array.isArray(result.workflow.decisions));
    assert.equal(result.routeSimulation.status, 'passed');
    const map = new Map(expected.phases.map((phase, index) => [phase.id, result.workflow.phases[index].id]));
    const candidate = resolveWorkType({ ...definition, ...result.bundle.objects.story }, result.workflow.id);
    assert.equal(candidate.phases.length, expected.phases.length);
    for (const [index, phase] of candidate.phases.entries()) {
      const original = expected.phases[index];
      assert.equal(phase.generation.task, original.generation.task);
      assert.equal(phase.writeScope, original.writeScope);
      assert.equal(phase.sourceBoundary, original.sourceBoundary);
      assert.deepEqual(phase.inputs.map(input => [input.phase, input.optional]), original.inputs.map(input => [map.get(input.phase), input.optional]));
      assert.equal(phase.testEvidenceFrom, original.testEvidenceFrom ? map.get(original.testEvidenceFrom) : undefined);
      assert.deepEqual(phase.approval, { ...original.approval, rejectTo: original.approval.rejectTo.map(id => map.get(id)) });
      assert.deepEqual(phase.repairBudget, original.repairBudget ? { ...original.repairBudget,
        resetOnPhase: original.repairBudget.resetOnPhase ? map.get(original.repairBudget.resetOnPhase) : null } : null);
      assert.deepEqual(phase.qualityCommands, original.qualityCommands);
    }
    assert.deepEqual(result.effects, { configurationChanged: false, storyChanged: false, approvalRecorded: false, bundleWritten: false });
    if (!(expected.decisions ?? []).length) {
      assert.deepEqual(result.workflow.decisions, []);
      assert.deepEqual(result.designReview.edges.map(edge => [edge.from, edge.to]), candidate.phases.map((phase, index) => [phase.id, candidate.phases[index + 1]?.id ?? 'end']));
    }
  });
});

test('publication authority correction reaches native design review without losing its required group or repair budget', async () => {
  const candidates = await withWorkflowIntentCatalog(null, { source: 'installed' }, catalog => ({
    invalid: workflowMarkupCandidate(catalog, 'poc-workflow', { approvalGroup: () => 'architecture-reviewers' }),
    corrected: workflowMarkupCandidate(catalog, 'poc-workflow', { approvalGroup: phase => phase === 'poc-publication-review' ? 'quality-reviewers' : 'architecture-reviewers' })
  }));
  await assert.rejects(compileWorkflowMarkup(candidates.invalid, { designReview: true }), error =>
    error.code === 'WORKFLOW_MARKUP_INVALID' && /requiredAuthorities.*quality-reviewers/u.test(error.message));
  const result = await compileWorkflowMarkup(candidates.corrected, { designReview: true });
  const ordinary = await compileWorkflowMarkup(candidates.corrected);
  assert.equal(result.status, 'portable-ready');
  assert.deepEqual(result.bundle, ordinary.bundle);
  const last = result.designReview.phases.at(-1);
  assert.deepEqual(last.approval.requiredAuthorities, ['quality-reviewers']);
  assert.deepEqual(last.approval.authorities, ['quality-reviewers']);
  const phases = result.bundle.objects.story.phases;
  assert.equal(phases['candidate-poc-workflow-step-5'].repairBudget.maxAttempts, 2);
  assert.equal(phases['candidate-poc-workflow-step-5'].repairBudget.resetOnPhase, 'candidate-poc-workflow-step-1');
});

test('sequential native compilation works through CLI JSON, text and phase inspection', async () => {
  const source = await withWorkflowIntentCatalog(null, { source: 'installed' }, catalog => workflowMarkupCandidate(catalog, 'poc-workflow'));
  for (const flags of [[], ['--json'], ['--design-review', '--json'], ['--inspect-phase', 'candidate-poc-workflow-step-6', '--json']]) {
    const result = spawnSync(process.execPath, [CLI, 'workflow', 'markup', 'compile', '-', ...flags], { input: source, encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    if (flags.includes('--json')) {
      const value = JSON.parse(result.stdout);
      assert.deepEqual(value.workflow.decisions, []);
      assert.equal(value.status, 'portable-ready');
      if (flags.includes('--inspect-phase')) assert.equal(value.designReview.inspection.phase, 'candidate-poc-workflow-step-6');
    } else assert.match(result.stdout, /6 phases; 0 decisions/u);
  }
});

test('typed remapping preserves scalar producers, optional inputs, defaults and source bytes without widening invalid references', () => {
  const names = new Map([['intake', 'new-intake'], ['code', 'new-code'], ['verify', 'new-verify'], ['design-intake', 'new-design']]);
  const remap = id => { assert.ok(names.has(id), `Unknown phase ${id}`); return names.get(id); };
  const phase = { inputs: ['intake', { phase: 'code', optional: true }], testEvidenceFrom: 'code',
    approval: { requiredAuthorities: ['quality-reviewers'], rejectTo: ['code'] }, repairBudget: { maxAttempts: 2, resetOnPhase: 'intake' } };
  const before = structuredClone(phase), mapped = remapMarkupPhase(phase, remap);
  assert.deepEqual(phase, before);
  assert.equal(mapped.testEvidenceFrom, 'new-code');
  assert.equal(mapped.inputs[1].optional, true);
  assert.deepEqual(mapped.approval.requiredAuthorities, ['quality-reviewers']);
  for (const stop of ['code', 'published:code', 'submitted:code', 'phase-complete:code']) {
    const workflow = remapMarkupWorkflow({ auto: { defaultUntil: stop }, designSources: { consumeIn: ['verify'] } }, remap);
    assert.equal(workflow.auto.defaultUntil, stop.replace('code', 'new-code'));
    assert.deepEqual(workflow.designSources, { capturePhase: 'new-design', consumeIn: ['new-verify'] });
  }
  for (const stop of ['first-human-boundary', 'story-complete']) assert.equal(remapMarkupWorkflow({ auto: { defaultUntil: stop } }, remap).auto.defaultUntil, stop);
  assert.throws(() => remapMarkupPhase({ testEvidenceFrom: 'outside' }, remap), /Unknown phase outside/u);
});

test('a partial workflow approval override cannot hide the shared phase required authority during markup changes', async () => {
  await withWorkflowIntentCatalog(null, { source: 'installed' }, catalog => {
    const definition = structuredClone(catalog.definition);
    definition.workTypes['poc-workflow'].phaseOverrides['poc-publication-review'].approval = { rejectTo: ['poc-intake'] };
    const source = workflowMarkupCandidate(catalog, 'poc-workflow', { approvalGroup: () => 'architecture-reviewers' });
    const lowered = lowerWorkflowMarkup(source, { definition, agents: catalog.agents, catalog: { ...catalog, ...patterns } });
    const phase = lowered.phases['candidate-poc-workflow-step-6'];
    assert.deepEqual(phase.approval.requiredAuthorities, ['quality-reviewers']);
    assert.deepEqual(lowered.workflow.phaseOverrides['candidate-poc-workflow-step-6'].approval.requiredAuthorities, ['quality-reviewers']);
    assert.throws(() => normalizeApprovalPolicy(phase.approval, definition.approvalAuthorities, 'candidate-poc-workflow-step-6', definition.approvalSecurity), /requiredAuthorities.*quality-reviewers/u);
  });
});

test('future custom phase names use the same effective-override remapping and still reject real dangling references', async () => {
  await withWorkflowIntentCatalog(null, { source: 'installed' }, catalog => {
    const definition = structuredClone(catalog.definition), base = definition.workTypes['poc-workflow'];
    // The shared phase's irrelevant default is overridden by this selected contract.
    definition.phases['poc-impact-analysis'].inputs = ['outside-this-workflow'];
    const source = workflowMarkupCandidate(catalog, 'poc-workflow');
    const lowered = lowerWorkflowMarkup(source, { definition, agents: catalog.agents, catalog: { ...catalog, ...patterns } });
    assert.deepEqual(lowered.phases['candidate-poc-workflow-step-2'].inputs, ['candidate-poc-workflow-step-1']);
    base.phaseOverrides['poc-impact-analysis'].inputs = ['actually-dangling'];
    assert.throws(() => lowerWorkflowMarkup(source, { definition, agents: catalog.agents, catalog: { ...catalog, ...patterns } }), { code: 'WORKFLOW_MARKUP_INVALID' });
  });
});

test('compiler failures have a closed non-correction code, while domain findings and their authority diagnostics stay intact', () => {
  const original = new TypeError('Cannot read properties of undefined; private source bytes');
  const failure = markupCompilerError(original);
  assert.equal(failure.code, 'WORKFLOW_MARKUP_COMPILER_FAILED');
  assert.equal(failure.cause, original);
  assert.match(failure.message, /not a markup correction/u);
  assert.ok(!failure.message.includes('private source bytes'));
  assert.ok(!JSON.stringify(failure).includes('private source bytes'));
  const envelope = refusalEnvelope(failure, ['workflow', 'markup', 'compile', '-', '--design-review', '--json']);
  assert.equal(envelope.error.code, 'WORKFLOW_MARKUP_COMPILER_FAILED');
  assert.equal(envelope.remediationPlan.retry.automatic, false);
  assert.deepEqual(envelope.remediationPlan.steps.filter(step => step.command).map(step => step.argv), [['about', '--json']]);
  const domain = new SingularityFlowError('requiredAuthorities must include quality-reviewers');
  assert.equal(markupCompilerError(domain).code, 'WORKFLOW_MARKUP_INVALID');
  assert.equal(markupCompilerError(domain).message, domain.message);
  const stale = new SingularityFlowError('Catalog changed', { code: 'WORKFLOW_INTENT_CATALOG_STALE' });
  assert.equal(markupCompilerError(stale), stale);
});
