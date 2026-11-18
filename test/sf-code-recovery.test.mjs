/**
 * A code step recovers on its own (owner, 2026-11-18: "the sf-code issues are too difficult to recover"). Each test here
 * replays one stop of Story new-ash-graph's real /sf-code run, shaped like that Story:
 *   F: version 2, opened on the person's yes to fix version 1's review finding about its tests, was refused as having no
 *      product source and sent to an appeal, a read-only preflight and the doctor, round and round.
 *   C: a refused test run recorded where the step stopped, the CLI exited without deriving the turn again, and the next
 *      tool call ended the turn as stale (PHASE_MUTATION_CONTRACT_STALE): /sf-decide and /sf-code again, about 66 minutes.
 *   Node: Node 26 breaks Vitest's DOM localStorage, Node 22 was installed, and the same question was a person's three times.
 *   D: the refusal named SFlow's own Node 26, not the Node 22 the tests ran on, and `tests base` ran on Node 26 and matched
 *      failures by name, so it said every failure was there before the change.
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

/** A Node that says it is `version` and runs as this Node: PATH's, or a version manager's. */
async function fakeNode(bin, version) {
  const { chmod } = await import('node:fs/promises');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'node'), `#!/bin/sh\nif [ "$1" = --version ]; then echo v${version}; exit 0; fi\nexec '${process.execPath}' "$@"\n`);
  await chmod(path.join(bin, 'node'), 0o755);
}

test('Node: a known clash with an earlier Node installed is settled, never asked; no engines field needed', { skip: process.platform === 'win32' ? 'the fake Nodes are shell scripts' : false }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-sfc-clash-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  await fakeNode(path.join(base, 'path-bin'), '26.12.0');
  await fakeNode(path.join(home, '.nvm', 'versions', 'node', 'v22.14.0', 'bin'), '22.14.0');
  const environment = { ...process.env, HOME: home, NVM_DIR: path.join(home, '.nvm'), PATH: `${path.join(base, 'path-bin')}${path.delimiter}${process.env.PATH}` };
  const root = path.join(base, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
  // new-ash-graph's calculator: Vitest in a DOM environment, code that uses localStorage, and no engines field.
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'vitest run' }, devDependencies: { vitest: '4' } }));
  await writeFile(path.join(root, 'node_modules', '.bin', 'vitest'), '');
  await writeFile(path.join(root, 'vite.config.js'), "export default { test: { environment: 'jsdom' } };\n");
  await writeFile(path.join(root, 'src', 'history.js'), "export const clear = () => localStorage.clear();\n");
  const { fileReads, nodeVersionChecks } = await import('../src/test-plan.mjs');
  const commands = [{ id: '.-node-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', affectedRoots: ['.'], result: { adapter: 'vitest-json', path: 'r.json' } }];
  const pin = (await nodeVersionChecks(root, commands, { environment, reads: fileReads(root) })).find((entry) => entry.pin)?.pin;
  assert.ok(pin, 'Node 26 with Vitest\'s DOM localStorage is a known clash');
  assert.ok(Number(pin.version) < 25, pin.version);
  assert.equal(pin.clash, 'vitest-dom-storage');
  const { settleableNodePin } = await import('../src/settled-decisions.mjs');
  const { nodeSettlement } = await import('../src/node-version-settle.mjs');
  const phase = { id: 'implementation', label: 'Implementation' };
  const workflow = { workItem: { id: W }, settledDecisions: [] };
  assert.equal(settleableNodePin(workflow, phase, { ...pin, running: '26.12.0' }), true, 'settled before the tests run, never a person\'s question');
  const settled = nodeSettlement(phase, { ...pin, running: '26.12.0' });
  assert.match(settled.answer, new RegExp(`^Pinned Node ${pin.version} in \\.nvmrc for Implementation's tests: Node 26\\.12\\.0 here breaks tests that use localStorage under Vitest`, 'u'));
  assert.ok(settled.evidence.length >= 2 && settled.evidence.every((entry) => entry.what && entry.where));
  // A person who undid it once has it as their question again.
  workflow.settledDecisions = [{ id: 'STL-001', kind: 'node-version', subject: `Node ${pin.version} for implementation's tests`, answer: 'x', evidence: [{ what: 'a', where: 'b' }], by: 'sflow', at: 'now' },
    { id: 'STL-002', undoes: 'STL-001', actor: 'person', at: 'later' }];
  assert.equal(settleableNodePin(workflow, phase, pin), false);
});

test('Node: a pin an earlier Story of the repository chose is evidence; earlier pins that differ stay the person\'s choice', async (t) => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-sfc-earlier-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'raj-calc');
  await mkdir(root);
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'SFC'); git('config', 'user.email', 'sfc@example.test');
  await writeFile(path.join(root, 'README.md'), 'calc\n');
  git('add', '.'); git('commit', '-qm', 'base');
  // Two earlier Stories checked out beside this one, as new-graph-plot and new-grapj were; the one being opened has no pin yet.
  for (const branch of ['new-graph-plot', 'new-ash-graph']) git('worktree', 'add', '-q', '-b', branch, path.join(base, branch));
  await writeFile(path.join(base, 'new-graph-plot', '.nvmrc'), '22\n');
  const here = path.join(base, 'new-ash-graph');
  const { earlierStoryNodePins, keepNodePin } = await import('../src/node-pin-history.mjs');
  const found = await earlierStoryNodePins(here, { workId: 'new-ash-graph', branch: 'new-ash-graph' });
  assert.deepEqual(found, [{ version: '22', workId: 'new-graph-plot', where: '.nvmrc on branch new-graph-plot' }]);
  const { withEarlierPin, nodeSettlement } = await import('../src/node-version-settle.mjs');
  const { settleableNodePin } = await import('../src/settled-decisions.mjs');
  const workflow = { workItem: { id: 'new-ash-graph', branch: 'new-ash-graph' }, settledDecisions: [] };
  const phase = { id: 'implementation', label: 'Implementation' };
  // The tests failed on the toolchain here (no file names the Node): the newest other installed Node is what was offered.
  const offered = { file: '.nvmrc', version: '24', node: '24.1.0', running: '26.12.0', stage: 'failed', commandId: '.-node-tests', words: 'The latest run stopped on the toolchain.' };
  assert.equal(settleableNodePin(workflow, phase, offered), false, 'nothing names the Node on its own');
  const installedOfMajor = async (major) => ({ 22: '22.14.0', 24: '24.1.0' })[major] ?? null;
  const pin = await withEarlierPin(here, workflow, offered, { installedOfMajor });
  assert.deepEqual([pin.version, pin.node, pin.earlier.map((entry) => entry.workId)], ['22', '22.14.0', ['new-graph-plot']]);
  assert.equal(settleableNodePin(workflow, phase, pin), true);
  assert.match(nodeSettlement(phase, pin).evidence[0].what, /^Story new-graph-plot pinned Node 22$/u);
  // A person's choice kept by another Story counts the same way, and earlier pins that differ answer nothing.
  await keepNodePin(here, { version: '20', workId: 'new-grapj', by: 'person' });
  assert.equal(await withEarlierPin(here, workflow, offered, { installedOfMajor }), offered, 'Node 20 and Node 22 differ: the person chooses');
  // Never the Node the tests just failed on.
  assert.equal((await withEarlierPin(here, workflow, { ...offered, running: '22.14.0' }, { earlier: [found[0]], installedOfMajor })).version, '24');
});

test('D: a base run of the Story\'s tests uses its pinned Node, and a failure counts as the same only with the same message', async (t) => {
  const { baseComparison, runOnBase } = await import('../src/verification/base-run.mjs');
  const here = ['keeps the history', 'plots a circle'];
  // new-ash-graph: here the gate ran on Node 22 and failed on its own assertion; the base, on PATH's Node 26, failed on localStorage.
  const onBase = { commandId: '.-node-tests', baseCommit: 'a'.repeat(40), nodeVersion: '26.12.0', status: 'failed', exitCode: 1,
    tests: { discovered: 31, passed: 14, failed: 17, skipped: 0 }, failed: here,
    messages: { 'keeps the history': "TypeError: Cannot read properties of undefined (reading 'clear')", 'plots a circle': "TypeError: Cannot read properties of undefined (reading 'clear')" } };
  const otherNode = baseComparison(onBase, { here, hereNode: '22.14.0',
    hereMessages: { 'keeps the history': 'AssertionError: expected 2 to be 3', 'plots a circle': "TypeError: Cannot read properties of undefined (reading 'clear')" } });
  assert.notEqual(otherNode.verdict, 'fails-on-base');
  assert.doesNotMatch(otherNode.words, /Every failure here also fails without this change|A person decides/u);
  const sameNode = baseComparison({ ...onBase, nodeVersion: '22.14.0' }, { here, hereNode: '22.14.0',
    hereMessages: { 'keeps the history': 'AssertionError: expected 2 to be 3 at src/history.test.js:12:5', 'plots a circle': "TypeError: Cannot read properties of undefined (reading 'clear')\n    at src/a.js:3:1" } });
  assert.deepEqual([sameNode.verdict, sameNode.alsoOnBase, sameNode.onlyHere], ['partly-on-base', ['plots a circle'], ['keeps the history']]);

  // The base commit has no .nvmrc (it came with the Story); its run gets the Story's.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sfc-base-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-q', '-b', 'main']); git(root, ['config', 'user.name', 'SFC']); git(root, ['config', 'user.email', 'sfc@example.test']);
  await writeFile(path.join(root, 'package.json'), '{}\n');
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'base']);
  const baseCommit = git(root, ['rev-parse', 'HEAD']);
  let seen = null;
  const { readFile: read } = await import('node:fs/promises');
  const result = await runOnBase(root, { id: '.-node-tests', argv: ['npm', 'test'], workingDirectory: '.', result: { adapter: 'vitest-json' } },
    { baseCommit, nodeVersion: '22.14.0', versionFile: { name: '.nvmrc', text: '22\n' }, gateRun: async (workspace) => {
      seen = await read(path.join(workspace, '.nvmrc'), 'utf8').catch(() => null);
      return { check: { status: 'passed', exitCode: 0 }, parsed: null };
    } });
  assert.equal(seen, '22\n', 'the base runs on the Story\'s pinned Node');
  assert.equal(result.status, 'passed');
});

test('D: a refused test run names the Node it ran on, not the Node SFlow runs on', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sfc-ran-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { attachRequiredTestExecution } = await import('../src/state.mjs');
  const { SingularityFlowError } = await import('../src/util.mjs');
  const check = { id: '.-node-tests', status: 'failed', exitCode: 1, stdout: '', stderr: '' };
  // The gate's run environment, kept on the check as the gate keeps it (test-run-environment.mjs).
  Object.defineProperty(check, 'runEnvironment', { value: { toolchain: { node: '22.14.0' }, nodeVersion: { file: '.nvmrc', wanted: '22', status: 'selected', node: '22.14.0' } } });
  const command = { id: '.-node-tests', kind: 'test', argv: ['npm', 'test'], workingDirectory: '.', provenance: 'inferred', result: { adapter: 'vitest-json', path: 'r.json' } };
  const refusal = await attachRequiredTestExecution(new SingularityFlowError('Required test failed.', { code: 'CODE_TEST_FAILED' }), root, command, check, { workId: W });
  assert.match(refusal.message, /^Required test command '\.-node-tests' failed on Node 22\.14\.0 \(exit 1\)\./u);
  assert.equal(refusal.details.requiredTestExecution.ranOnNode, '22.14.0');
  assert.equal(refusal.details.requiredTestExecution.hostRuntime.node, process.version, 'SFlow\'s own Node stays named as the host\'s');
});
