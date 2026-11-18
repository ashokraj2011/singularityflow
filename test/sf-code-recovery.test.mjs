/**
 * A code step recovers on its own (owner, 2026-11-18: "the sf-code issues are too difficult to recover"). Each test here
 * replays one stop of Story new-ash-graph's real /sf-code run, shaped like that Story:
 *   F: version 2, opened on the person's yes to fix version 1's review finding about its tests, was refused as having no
 *      product source and sent to an appeal, a read-only preflight and the doctor, round and round.
 *   C: a refused test run recorded where the step stopped, the CLI exited without deriving the turn again, and the next
 *      tool call ended the turn as stale (PHASE_MUTATION_CONTRACT_STALE): /sf-decide and /sf-code again, about 66 minutes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeCodeDeliveryPolicy } from '../src/code-delivery-policy.mjs';
import { captureMutationTurn, mutationPostToolGuard, mutationToolGuard, recordPhaseTaskProgress } from '../src/copilot-mutation-guard.mjs';
import { recordRepositoryBoundaryTurn, repositoryAgentStop, repositoryDiscoveryGuard, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { evaluateCodeDeliveryPreflight } from '../src/delivery-evidence.mjs';
import { phaseTaskCompletion } from '../src/phase-authoring-progress.mjs';
import { recordSha256 } from '../src/records.mjs';
import { safeCommandGuidance } from '../src/safe-command-guidance.mjs';
import { run } from '../src/util.mjs';
import { ensureWorkIntervalBaseline } from '../src/work-intervals.mjs';
import { outcomeCode } from '../src/workflow-task-outcome.mjs';
import { observeWorkflowTask } from '../src/workflow-task-store.mjs';
import { acceptOpening } from './helpers/accepted-opening.mjs';

const W = 'SFC-GRAPH';
const ITEM = `singularity/work-items/${W}`;

function git(root, args) {
  const result = run('git', args, { cwd: root, allowFailure: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

/**
 * A Story at its code step `implementation`: version 1 published (its tests passed at the gate, its submission tests still
 * pending, as on new-ash-graph), its retained review holding `findings`, and version 2 opened by SFlow's own rollover for
 * the review's corrections on the person's yes. Nothing else: no change request, no rejection.
 */
async function storyAfterReview(t, findings) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sfc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', W]);
  git(root, ['config', 'user.name', 'SFC Test']);
  git(root, ['config', 'user.email', 'sfc@example.invalid']);
  const source = 'export function App() { return null; }\n';
  const spec = "import { expect, test } from '@playwright/test';\n// @ac:SFC-GRAPH:AC-001\ntest('plots a circle', async () => {});\n";
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'src', 'App.jsx'), source);
  await writeFile(path.join(root, 'tests', 'graph-plotter.spec.js'), spec);
  await writeFile(path.join(root, '.nvmrc'), '22\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'published implementation version 1']);
  // Version 1's retained review, committed as review-source submit retains it.
  const report = { schemaVersion: 1, kind: 'code', findings };
  const reportSha256 = recordSha256(report);
  const reviews = path.join(root, ITEM, 'context', 'reviews', 'implementation', 'gen-1');
  await mkdir(reviews, { recursive: true });
  const body = { schemaVersion: 1, phase: 'implementation', generation: 1, reportSha256, lifecycleEventId: 'event-1', report,
    provenance: { reviewerAgentId: 'sflow-source-reviewer', authorAgentId: 'developer', readOnly: true }, submittedAt: '2026-11-18T13:17:34.420Z' };
  await writeFile(path.join(reviews, `${reportSha256}.json`), `${JSON.stringify({ ...body, recordSha256: recordSha256(body) }, null, 2)}\n`);
  const pointer = { schemaVersion: 1, phase: 'implementation', generation: 1, reportSha256 };
  await writeFile(path.join(reviews, 'current.json'), `${JSON.stringify({ ...pointer, recordSha256: recordSha256(pointer) }, null, 2)}\n`);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'review of version 1 retained']);
  const published = git(root, ['rev-parse', 'HEAD']);
  const phase = {
    id: 'implementation', generation: 1, status: 'in_progress', writeScope: 'source-and-artifact', sourceBoundary: 'unrestricted',
    generationPolicy: { task: 'code' }, requiredArtifact: { kind: 'implementation-summary' }, approvals: [],
    // Published, its submission tests not yet run: no generation commit or receipt yet.
    generationCommit: null,
    generationPublications: [{ generation: 1, publishedAt: '2026-11-18T13:13:08.356Z',
      record: { path: `${ITEM}/context/generation-publications/implementation-gen1.json`, sha256: `sha256:${'b'.repeat(64)}` } }],
    versionOpening: { operationId: 'vo-1', version: 2, highWatermark: 2, reason: 'review-corrections', openedAt: '2026-11-18T13:27:57.188Z' },
    generationIntent: { id: 'gi-2', generation: 2, status: 'open',
      baseline: { commit: published, mode: 'clean', previousGenerationCommit: published } },
    deliveryEvidence: {
      status: 'pending-tests', sourcePaths: ['src/App.jsx'], testPaths: ['tests/graph-plotter.spec.js'],
      paths: [
        { path: '.nvmrc', kind: 'configuration', fileKind: 'regular-file', exists: true, sha256: digest('22\n') },
        { path: 'src/App.jsx', kind: 'source', fileKind: 'regular-file', exists: true, sha256: digest(source) },
        { path: 'tests/graph-plotter.spec.js', kind: 'test', fileKind: 'regular-file', exists: true, sha256: digest(spec) }
      ]
    }
  };
  const workflow = {
    workItem: { id: W, workType: 'classic-delivery', branch: W },
    currentPhase: 'implementation', phaseOrder: ['planning', 'implementation'],
    phases: { planning: { id: 'planning', status: 'approved', generation: 1, approvals: [] }, implementation: phase },
    changeRequests: [],
    resolution: {
      configSha256: 'c'.repeat(64), sourceSha256: 's'.repeat(64), templates: {},
      capability: { policy: { protectedPaths: [] } }, codeDelivery: normalizeCodeDeliveryPolicy(),
      sourceReview: { mode: 'enforce', phases: ['implementation'], kinds: { implementation: 'code' }, reviewerAgent: 'sflow-source-reviewer' }
    },
    lineage: { canonicalBranch: W, requiredChecks: [] }, history: []
  };
  const config = { workItemRoot: 'singularity/work-items', governance: { requireAcceptanceCriteriaTags: false }, workTypes: { 'classic-delivery': {} } };
  await ensureWorkIntervalBaseline(root, config, workflow, { phaseId: 'implementation', itemDirectory: path.join(root, ITEM), itemRelative: ITEM });
  return { root, config, workflow, phase, spec, source };
}

// Version 1's only blocking finding on new-ash-graph: the review read the summary written before the gate ran.
const REGRESSION_FINDING = { id: 'test-plan-req-001-regression-run', severity: 'blocking', check: 'tests', clauseId: 'SFC-GRAPH:REQ-001',
  sourceId: 'code:tests:graph-plotter.spec.js', line: 3, quote: "test('plots a circle', async () => {});",
  message: 'The implementation summary reports that the post-repair run failed on Node 26 and a rerun is pending: run the planned suite on Node 22.' };

test('F: a version opened to fix the review\'s test finding carries the published source, never an appeal', async (t) => {
  const f = await storyAfterReview(t, [REGRESSION_FINDING,
    { id: 'design-note', severity: 'advisory', check: 'design', message: 'An advisory note never decides the route.' }]);
  // The change new-ash-graph's version 2 made: test lines only (4+/1-).
  await writeFile(path.join(f.root, 'tests', 'graph-plotter.spec.js'), f.spec.replace('// @ac:SFC-GRAPH:AC-001',
    '// @ac:SFC-GRAPH:AC-001 The browser test checks the circle\'s cardinal points.'));
  const evidence = await evaluateCodeDeliveryPreflight(f.root, f.config, f.workflow, f.phase);
  assert.deepEqual(evidence.sourcePaths, ['src/App.jsx'], 'version 1\'s exact source is carried');
  assert.deepEqual(evidence.testPaths, ['tests/graph-plotter.spec.js']);
  assert.deepEqual(evidence.reviewCorrection, { priorGeneration: 1, priorReceiptSha256: null,
    findingIds: ['test-plan-req-001-regression-run'], reusedSourcePaths: ['src/App.jsx'] });

  // Nothing changed at all: the gate's own run on the published code answers the finding.
  await writeFile(path.join(f.root, 'tests', 'graph-plotter.spec.js'), f.spec);
  const unchanged = await evaluateCodeDeliveryPreflight(f.root, f.config, f.workflow, f.phase);
  assert.deepEqual([unchanged.sourcePaths, unchanged.testPaths], [['src/App.jsx'], ['tests/graph-plotter.spec.js']]);
  assert.equal(unchanged.reviewCorrection.priorGeneration, 1);

  // A product-source change is an ordinary version: it carries nothing.
  await writeFile(path.join(f.root, 'src', 'App.jsx'), `${f.source}export const radius = 6;\n`);
  const product = await evaluateCodeDeliveryPreflight(f.root, f.config, f.workflow, f.phase);
  assert.equal(product.reviewCorrection, undefined);
  await writeFile(path.join(f.root, 'src', 'App.jsx'), f.source);

  // Carried source must be version 1's exact bytes.
  await writeFile(path.join(f.root, 'src', 'App.jsx'), f.source.replace('null', 'undefined'));
  const reverted = await evaluateCodeDeliveryPreflight(f.root, f.config, f.workflow, f.phase);
  assert.equal(reverted.reviewCorrection, undefined, 'a changed source file is this version\'s own change');
});

test('F: only a version SFlow opened for the review\'s test or evidence findings carries the published source', async (t) => {
  const refused = async (f, label) => {
    await writeFile(path.join(f.root, 'tests', 'graph-plotter.spec.js'), `${f.spec}test('origin stays unplotted', async () => {});\n`);
    await assert.rejects(() => evaluateCodeDeliveryPreflight(f.root, f.config, f.workflow, f.phase), (error) => {
      assert.equal(error.code, 'CODE_DELIVERY_EVIDENCE_REQUIRED', label);
      assert.match(error.message, /no product source path changed/u, label);
      assert.equal(error.details.deliveryRoute?.kind, 'return-required', label);
      return true;
    }, label);
  };
  // A finding about the implementation itself needs product source.
  await refused(await storyAfterReview(t, [{ ...REGRESSION_FINDING, check: 'plan' }]), 'a plan finding with a cited line');
  const opened = await storyAfterReview(t, [REGRESSION_FINDING]);
  opened.phase.versionOpening.reason = 'change-requested';
  await refused(opened, 'a version opened for another reason');

  // An evidence file the reviewer inspected (no line, an attestation) is evidence-only, as a test finding is.
  const evidence = await storyAfterReview(t, [{ id: 'evidence-shot', severity: 'blocking', check: 'plan', clauseId: 'SFC-GRAPH:AC-002',
    sourceId: 'evidence:shot', attestation: 'The screenshot shows the empty plot.', message: 'The screenshot does not show the circle.' }]);
  assert.equal((await evaluateCodeDeliveryPreflight(evidence.root, evidence.config, evidence.workflow, evidence.phase)).reviewCorrection.findingIds[0], 'evidence-shot');
});

/**
 * A code step `implement` with version 2 open and being written in a Copilot turn of /sf-code, as the guard reads it: a real
 * Git checkout, the turn records in a machine folder of its own (the shape of test/osa-stage5.test.mjs's Story).
 */
async function codeTurnStory(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-sfc-turn-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  git('init', '-q'); git('config', 'user.name', 'SFC Turn'); git('config', 'user.email', 'sfc-turn@example.test');
  await writeFile(path.join(root, 'src', 'App.jsx'), 'export const App = () => null;\n');
  const implement = { id: 'implement', label: 'Implement', status: 'in_progress', generation: 1, writeScope: 'source-and-artifact',
    generationPolicy: { requirement: 'required', task: 'code', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: 'artifacts/implement/summary.md', kind: 'implementation-summary' }, repairBudget: { maxAttempts: 2 },
    generationIntent: { id: 'GI-2', status: 'open', generation: 2 },
    generationPublications: [{ generation: 1, record: { path: `singularity/work-items/${W}/publications/implement-1.json`, sha256: `sha256:${'c'.repeat(64)}` } }] };
  const workflow = { schemaVersion: 13, workItem: { id: W }, status: 'in_progress', currentPhase: 'implement',
    phaseOrder: ['design', 'implement'], history: [{ at: '2026-11-18T11:00:00.000Z', event: 'phase_approved', phase: 'design' }],
    phases: { design: { id: 'design', status: 'approved', generation: 1, writeScope: 'artifact-only', generationPolicy: { requirement: 'required', task: 'document' } },
      implement }, resolution: {} };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy'] } };
  await acceptOpening(root, workflow, implement);
  const workflowFile = path.join(root, ITEM, 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git('add', '.'); git('commit', '-qm', 'fixture');
  const accepted = { definition, workflow };
  const enter = async (skill, sessionId = 'sfc-turn') => {
    const payload = { cwd: root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { now: Date.now(), captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  const write = (turn) => mutationToolGuard({ ...turn, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } });
  const stopAt = (outcome, code, extra = {}) => observeWorkflowTask(root, workflow, implement, { state: 'blocked', ...extra,
    blockedCode: outcomeCode(outcome, code, workflow) });
  return { root, workflow, implement, enter, write, stopAt };
}

test('C: a refused test run that records where the step stopped never cuts the code turn off', async (t) => {
  const f = await codeTurnStory(t);
  const turn = await f.enter('/sf-code');
  assert.deepEqual(await f.write(turn), {}, 'version 2 is written in this turn');
  // Its publication refused with CODE_TEST_FAILED and recorded the step's stop (a person's Node choice on new-ash-graph); the
  // CLI exited before deriving the turn again.
  const publish = { ...turn, toolName: 'bash', toolArgs: { command: 'singularity-flow phase prepublish implement --for-agent --json --publish-if-ready' } };
  assert.deepEqual(await mutationToolGuard(publish), {}, 'the gate is the turn\'s own command');
  await f.stopAt('waiting-person', 'CODE_TEST_FAILED');
  const after = await mutationPostToolGuard(publish);
  assert.doesNotMatch(String(after.additionalContext ?? after.permissionDecisionReason ?? ''), /PHASE_MUTATION_CONTRACT_STALE/u);
  assert.deepEqual(after, {}, 'the refused command does not end the turn');
  assert.deepEqual(await f.write(turn), {}, 'the agent repairs what it can in the same turn while the person decides');
  // A repair within its budget is the turn's own too; a spent one still stops its writes, as every view says.
  await f.stopAt('repair-required', 'CODE_TEST_FAILED', { repairConsumed: 1 });
  assert.deepEqual(await f.write(turn), {});
  await f.stopAt('repair-required', 'CODE_TEST_FAILED', { repairConsumed: 2 });
  assert.equal((await f.write(turn)).permissionDecision, 'deny');
});
