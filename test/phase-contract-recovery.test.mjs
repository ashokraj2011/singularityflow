import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { assertWorkTypeStartable, resolveWorkType } from '../src/config.mjs';
import { generationSkillForPhase } from '../src/code-delivery-policy.mjs';
import { currentConvergenceContext, missingConvergenceProjectionError } from '../src/convergence-context.mjs';
import { phaseHandoff, workflowGuide } from '../src/guide.mjs';
import { assertWorkflowReadinessChanges } from '../src/editor.mjs';
import { conformancePhaseOf, isConvergencePhase, sourceReviewKind, stepResponsibilities,
  visualVerificationPhaseOf } from '../src/phase-roles.mjs';
import { installAcceptedPhaseInterpretation, PHASE_SEMANTICS_PROFILE, phaseTopologyFindings } from '../src/phase-semantics.mjs';
import { sequenceGuidance } from '../src/sequence.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { submitPhase } from '../src/state.mjs';
import { resolveStoryExecutionCatalog } from '../src/story-execution-context.mjs';
import { submissionReadinessSnapshot } from '../src/submission-readiness.mjs';
import { evaluateVisualCoverage } from '../src/visual-coverage.mjs';
import { simulateResolvedWorkflowLifecycle } from '../src/workflow-lifecycle-simulation.mjs';
import { captureWorkflowSnapshot } from '../src/workflow-snapshots.mjs';
import { run } from '../src/util.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const referenceHash = `sha256:${'a'.repeat(64)}`;

function phase(id, kind, task = 'analyze') {
  return { id, order: 0, label: id, artifact: { kind, path: `artifacts/${id}/report.md` },
    template: 'spec-driven/convergence.md', defaultTemplate: 'spec-driven/convergence.md',
    defaultAgent: 'developer', inputs: [], qualityCommands: [],
    generation: { requirement: 'required', task, defaultProducer: task === 'code' ? 'governed-agent' : 'deterministic',
      allowedProducers: [task === 'code' ? 'governed-agent' : 'deterministic'] },
    writeScope: task === 'code' ? 'source-and-artifact' : 'artifact-only',
    approval: { mode: 'required', authorities: ['reviewers'], minimum: 1, rejectTo: [id] } };
}

function liveWorkflow(phases, { workId = 'ROLE-1', current = phases.at(-1).id } = {}) {
  return { schemaVersion: 13, workItem: { id: workId, title: 'Contract recovery', workType: 'custom',
    createdAt: '2026-10-05T00:00:00.000Z' }, status: 'in_progress', currentPhase: current,
    phaseOrder: phases.map((entry) => entry.id), history: [],
    resolution: { id: 'custom', workItemRoot: 'singularity/work-items', phases,
      templates: {}, sequenceGates: { default: 'hard' } },
    phases: Object.fromEntries(phases.map((entry) => [entry.id, { id: entry.id, label: entry.label,
      status: entry.id === current ? 'in_progress' : 'approved', generation: 2,
      generationPolicy: structuredClone(entry.generation), approvalPolicy: structuredClone(entry.approval),
      requiredArtifact: structuredClone(entry.artifact), writeScope: entry.writeScope,
      generationPublications: [{ generation: 2, record: {
        path: `singularity/work-items/${workId}/context/publications/${entry.id}-gen2.json`, sha256: referenceHash } }] }])) };
}

/** Accepted Git closure, not caller-supplied role flags or a mutable live template. */
async function acceptedLegacy(t, { reviewId = 'closure-review', templateSuffix = '', profile = null, scopeAndPlan = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const template = await readFile(new URL('../templates/artifacts/spec-driven/convergence.md', import.meta.url), 'utf8') + templateSuffix;
  const agent = '---\nname: developer\ndescription: Contract fixture\nmetadata:\n  sflow-phases: build,closure-review,convergence\n---\n# Developer\nUse accepted inputs.\n';
  const agentPath = '.github/agents/developer.agent.md';
  const templatePath = 'singularity/templates/spec-driven/convergence.md';
  for (const [relative, bytes] of [[agentPath, agent], [templatePath, template]]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), bytes);
  }
  const phases = [phase('build', 'implementation-summary', 'code'), phase(reviewId, 'verification-report')];
  if (scopeAndPlan) phases.unshift(phase('define-scope', 'requirements'), phase('plan-changes', 'delivery-plan'));
  phases.forEach((entry, order) => { entry.order = order; });
  const workflow = liveWorkflow(phases);
  if (scopeAndPlan) {
    workflow.resolution.plannedClaims = { mode: 'required', clausePhases: ['define-scope'], owners: { build: 'plan-changes' } };
    workflow.resolution.sourceReview = { mode: 'enforce', phases: ['define-scope', 'plan-changes'] };
  }
  if (profile) workflow.resolution.phaseSemantics = { profile };
  workflow.resolution.templates = Object.fromEntries(phases.map((entry) => [entry.id, { path: templatePath, sha256: sha(template) }]));
  const config = { workItemRoot: 'singularity/work-items', templatesRoot: 'singularity/templates',
    agentCatalog: [{ id: 'developer', file: path.join(root, agentPath), source: agentPath,
      scope: 'repository', sha256: sha(agent), dependencies: [] }] };
  workflow.workflowSnapshot = await captureWorkflowSnapshot(root, config, workflow);
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Phase Contract Test'], { cwd: root });
  run('git', ['config', 'user.email', 'phase@example.invalid'], { cwd: root });
  const file = path.join(root, config.workItemRoot, workflow.workItem.id, 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(workflow, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'Accept historical phase contract'], { cwd: root });
  // Remove capture's private draft capability; the reader must authenticate committed history.
  return { root, config, workflow: JSON.parse(await readFile(file, 'utf8')), file };
}

test('a verified older pin retains Convergence controls without rewriting its policy or generation', async (t) => {
  const value = await acceptedLegacy(t);
  const before = JSON.stringify(value.workflow);
  const disk = await readFile(value.file, 'utf8');
  assert.equal(isConvergencePhase(value.workflow.phases['closure-review']), false);
  const catalog = await resolveStoryExecutionCatalog(value.root, value.config, value.workflow);
  assert.equal(isConvergencePhase(value.workflow.phases['closure-review']), true);
  assert.equal(value.workflow.phases['closure-review'].requiredArtifact.kind, 'verification-report');
  assert.equal(value.workflow.phases['closure-review'].generation, 2);
  assert.equal(JSON.stringify(value.workflow), before);
  assert.equal(await readFile(value.file, 'utf8'), disk);
  assert.equal(submissionReadinessSnapshot(value.workflow).command, 'singularity-flow story advance --work-id ROLE-1');
  // Reuse of the verified operation rebinds fresh phase objects without new authority or rewriting.
  const reloaded = structuredClone(value.workflow);
  await resolveStoryExecutionCatalog(value.root, catalog.effectiveDefinition, reloaded);
  assert.equal(isConvergencePhase(reloaded.phases['closure-review']), true);
  await assert.rejects(submitPhase(value.root, catalog.effectiveDefinition, reloaded),
    (error) => error.code === 'CONVERGENCE_ADVANCE_CONFIRMATION_REQUIRED');
  assert.equal(await readFile(value.file, 'utf8'), disk);
  assert.equal(run('git', ['status', '--porcelain'], { cwd: value.root }).stdout, '');
});

test('template customization or an unknown interpretation is refused instead of silently losing Convergence', async (t) => {
  for (const options of [{ templateSuffix: '\ncustomized\n' }, { profile: 'sflow-phase-semantics/v99' }]) {
    const value = await acceptedLegacy(t, options);
    await assert.rejects(resolveStoryExecutionCatalog(value.root, value.config, value.workflow),
      (error) => error.code === (options.profile ? 'WFA_RUNTIME_INCOMPATIBLE' : 'WFA_PHASE_SEMANTICS_UNSUPPORTED'));
  }
});

test('a mutable phase name or role flag cannot confer Convergence', () => {
  const workflow = liveWorkflow([phase('convergence', 'verification-report')]);
  workflow.phases.convergence.role = 'convergence';
  assert.equal(isConvergencePhase(workflow.phases.convergence), false);
});

test('conflicting semantic versions or an unsupported responsibility compiler cannot be guessed', () => {
  const workflow = liveWorkflow([phase('build', 'implementation-summary', 'code')]);
  const policy = { ...workflow.resolution, phaseSemantics: { profile: PHASE_SEMANTICS_PROFILE } };
  assert.throws(() => installAcceptedPhaseInterpretation(workflow, policy, {},
    { phaseSemantics: 'sflow-phase-semantics/v99' }), (error) => error.code === 'WFA_RUNTIME_INCOMPATIBLE');
  assert.throws(() => installAcceptedPhaseInterpretation(workflow,
    { ...policy, obligationGraph: { compilerVersion: 99, nodes: [] } }, {}),
  (error) => error.code === 'WFA_RUNTIME_INCOMPATIBLE');
});

test('missing historical obligation graphs derive scope and planning only from the accepted policy', async (t) => {
  const value = await acceptedLegacy(t, { scopeAndPlan: true });
  await resolveStoryExecutionCatalog(value.root, value.config, value.workflow);
  assert.deepEqual(stepResponsibilities(value.workflow, 'build'), ['implement', 'verify', 'review']);
  assert.equal(sourceReviewKind(value.workflow, 'build'), null);
  assert.equal(sourceReviewKind(value.workflow, 'define-scope'), 'specification');
  assert.equal(sourceReviewKind(value.workflow, 'plan-changes'), 'planning');
  assert.deepEqual(stepResponsibilities(value.workflow, 'define-scope'), ['scope', 'review']);
  assert.deepEqual(stepResponsibilities(value.workflow, 'plan-changes'), ['plan', 'review']);
  assert.equal(value.workflow.resolution.obligationGraph, undefined);
});

test('Convergence routing remains exact under soft gates, rejection, missing or ambiguous receipts', () => {
  const workflow = liveWorkflow([phase('build', 'implementation-summary', 'code'), phase('closure-review', 'convergence-report')]);
  const current = workflow.phases['closure-review'];
  for (const soft of [false, true]) {
    workflow.resolution.sequenceGates = { default: soft ? 'soft' : 'hard' };
    for (const rejected of [false, true]) {
      current.rejectedAt = rejected ? '2026-10-04T00:00:00.000Z' : null;
      workflow.history = rejected ? [{ phase: current.id, event: 'phase_generated', at: '2026-10-05T00:00:00.000Z' }] : [];
      for (const count of [0, 1, 2]) {
        current.generationPublications = Array.from({ length: count }, () => ({ generation: 2,
          record: { path: 'singularity/work-items/ROLE-1/context/publications/review-gen2.json', sha256: referenceHash } }));
        const expected = count === 1 ? 'singularity-flow story advance --work-id ROLE-1'
          : 'singularity-flow recover ROLE-1 --phase closure-review --json';
        assert.equal(submissionReadinessSnapshot(workflow).command, expected);
        assert.equal(phaseHandoff(workflow, current)[0].command, expected);
        assert.equal(workflowGuide(workflow).nextActions[0].command, expected);
        assert.equal(sequenceGuidance(workflow).actions[0].command, expected);
        assert.notEqual(expected, 'singularity-flow submit closure-review');
      }
    }
  }
});

test('a legacy published report without a sealed projection has an exact producer route, never an approval retry', () => {
  const workflow = liveWorkflow([phase('build', 'implementation-summary', 'code'), phase('closure-review', 'convergence-report')]);
  const error = missingConvergenceProjectionError(workflow, { phase: workflow.phases['closure-review'],
    itemRelative: 'singularity/work-items/ROLE-1', iteration: 2 });
  assert.equal(error.code, 'CONVERGENCE_PROJECTION_REQUIRED');
  assert.equal(error.details.path, 'singularity/work-items/ROLE-1/context/convergence/iteration-2.json');
  const plan = refusalRemediationPlan(error, ['story', 'advance', '--work-id', 'ROLE-1', '--json']);
  assert.equal(plan.steps[0].command, 'singularity-flow story converge --work-id ROLE-1');
  assert.equal(plan.steps[0].copilotCommand, '/sf-converge');
  assert.equal(plan.retry.automatic, false);
  assert.doesNotMatch(JSON.stringify(plan.steps), /singularity-flow approve|singularity-flow submit/);
});

test('unsupported phase topologies are rejected before activation and structural simulation', () => {
  const code = phase('build', 'implementation-summary', 'code');
  const review = phase('closure-review', 'convergence-report');
  const visual = phase('screens', 'visual-test-evidence');
  const none = phase('signoff', 'review-report'); none.generation.requirement = 'none';
  for (const [phases, expected] of [
    [[review], 'WORKFLOW_CONVERGENCE_CODE_SOURCE_MISSING'],
    [[code, review, { ...review, id: 'second-review' }], 'WORKFLOW_CONVERGENCE_MULTIPLE_UNSUPPORTED'],
    [[code, visual, { ...visual, id: 'second-screens' }], 'WORKFLOW_VISUAL_MULTIPLE_UNSUPPORTED'],
    [[none], 'WORKFLOW_REVIEW_RECEIPT_UNSUPPORTED']
  ]) {
    const resolved = { id: 'unsupported', phases, plannedClaims: { mode: 'off' } };
    assert.equal(phaseTopologyFindings(resolved)[0].code, expected);
    assert.throws(() => assertWorkTypeStartable(resolved), (error) => error.code === expected);
    assert.equal(simulateResolvedWorkflowLifecycle(resolved).status, 'invalid');
  }
  assert.equal(generationSkillForPhase(none), null);
});

test('an older multi-Convergence pin cannot credit another stage\'s shared iteration record', async () => {
  const workflow = liveWorkflow([phase('build', 'implementation-summary', 'code'),
    phase('first-review', 'convergence-report'), phase('second-review', 'convergence-report')]);
  await assert.rejects(currentConvergenceContext('/unused', {}, workflow),
    (error) => error.code === 'WORKFLOW_CONVERGENCE_MULTIPLE_UNSUPPORTED');
});

test('terminal conformance excludes skipped stages and visual evidence selects the active producer', async () => {
  const workflow = liveWorkflow([phase('first-report', 'conformance-report'), phase('skipped-report', 'conformance-report'),
    phase('first-screens', 'visual-test-evidence'), phase('second-screens', 'visual-test-evidence')]);
  workflow.phases['skipped-report'].status = 'skipped';
  assert.equal(conformancePhaseOf(workflow).id, 'first-report');
  assert.equal(visualVerificationPhaseOf(workflow).id, 'second-screens');
  assert.equal((await evaluateVisualCoverage('/unused', workflow)).phase, 'second-screens');
});

test('the quality-gates example declares a startable scope and planned-claim contract', async () => {
  const definition = YAML.parse(await readFile(new URL('../examples/workflow-with-quality-gates.yml', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => assertWorkTypeStartable(resolveWorkType(definition, 'feature')));
});

test('authoring refuses newly introduced dead-end topologies while legacy drafts stay repairable', async () => {
  const baseline = YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
  const duplicate = structuredClone(baseline);
  duplicate.phases['extra-convergence'] = structuredClone(duplicate.phases.convergence);
  duplicate.workTypes['spec-driven-standard'].phases.splice(4, 0, 'extra-convergence');
  assert.throws(() => assertWorkflowReadinessChanges(baseline, duplicate),
    (error) => error.code === 'WORKFLOW_CONVERGENCE_MULTIPLE_UNSUPPORTED');
  const labelled = structuredClone(duplicate);
  labelled.workTypes['spec-driven-standard'].label = 'Incomplete draft for correction';
  assert.doesNotThrow(() => assertWorkflowReadinessChanges(duplicate, labelled));
  const fixed = structuredClone(duplicate);
  fixed.workTypes['spec-driven-standard'].phases = structuredClone(baseline.workTypes['spec-driven-standard'].phases);
  assert.doesNotThrow(() => assertWorkflowReadinessChanges(duplicate, fixed));
});
