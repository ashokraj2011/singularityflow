/**
 * Investigation: a disposable bisection, and records that never blur. `[INT:AC-014]` `[INT:AC-015]`
 *
 * Part of the P3 release gate `[INT:CON-162]`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { createHostGateway } from '../src/gateway/host.mjs';
import { cliMutationExecutors } from '../src/gateway/planners/executors.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import {
  CONFIDENCE_LABELS, EVIDENCE_SEQUENCE, INVESTIGATION_RECORD_TYPES, problemInvestigate, problemInvestigateAssisted
} from '../src/gateway/planners/problem-investigate.mjs';
import { message } from '../src/gateway/messages.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

/** Six commits; the fourth makes the contract test fail. A configured test command checks it. */
async function regression(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-int-investigation-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'dev@example.test');
  git(root, 'config', 'user.name', 'Dev');
  assert.equal(spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8', timeout: 120_000 }).status, 0);
  const configPath = path.join(root, 'singularity', 'workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.phases.implementation.qualityCommands = [{
    id: 'checkout-contract', kind: 'test', argv: [process.execPath, 'contract.mjs'], workingDirectory: '.', affectedRoots: ['.'],
    modelPolicy: 'never', result: { adapter: 'node-tap', path: '.sflow/results/contract.tap' }
  }];
  await writeFile(configPath, YAML.stringify(config));
  await writeFile(path.join(root, 'contract.mjs'), "import { postalRequired } from './postal.mjs';\nif (postalRequired) process.exit(1);\n");
  const commits = [];
  for (let step = 1; step <= 6; step += 1) {
    await writeFile(path.join(root, 'postal.mjs'), `export const postalRequired = ${step >= 4};\nexport const step = ${step};\n`);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', `step ${step}`);
    commits.push(git(root, 'rev-parse', 'HEAD'));
  }
  return { root, commits };
}

test('bisect-proves-boundary-safely', { timeout: 300_000 }, async (t) => {
  const { root, commits } = await regression(t);
  // The developer's own work in progress, which bisection must never touch.
  await writeFile(path.join(root, 'notes.txt'), 'local edits in progress\n');
  const before = { head: git(root, 'rev-parse', 'HEAD'), worktrees: git(root, 'worktree', 'list', '--porcelain') };
  const temporary = new Set(await readdir(os.tmpdir()));
  const { kernel } = createHostGateway({
    root, hostSessionId: 'sess-bisect', planners: gatewayPlanners(), mutationExecutors: cliMutationExecutors(), readOnly: false
  });

  // Only a configured test command is accepted; conversational text never becomes argv.
  const unknown = await kernel.resolve({ utterance: 'bisect this regression', arguments: { good: commits[0], bad: commits[5], testCommandId: 'rm-rf' } });
  assert.deepEqual([unknown.kind, unknown.why[0].slots.code], ['refusal', 'BISECT_TEST_COMMAND_UNKNOWN']);
  const backwards = await kernel.resolve({ utterance: 'bisect this regression', arguments: { good: commits[5], bad: commits[0], testCommandId: 'checkout-contract' } });
  assert.equal(backwards.why[0].slots.code, 'BISECT_RANGE_INVALID');

  // The plan names everything the person confirms.
  const planned = await kernel.resolve({ utterance: 'bisect this regression', arguments: { good: commits[0], bad: commits[5], testCommandId: 'checkout-contract' } });
  assert.equal(planned.kind, 'plan');
  const { preview } = planned.data.plan.review;
  assert.equal(planned.data.plan.confirmation, 'host-confirm');
  assert.deepEqual([preview.good.commit, preview.bad.commit, preview.testCommand.id], [commits[0], commits[5], 'checkout-contract']);
  for (const field of ['signal', 'maxSteps', 'disposableWorktrees', 'networkPolicy', 'cleanup', 'repository']) assert.ok(preview[field], field);
  assert.equal((await kernel.run({ planId: planned.data.plan.handle })).why[0].code, 'gateway.confirmation-required');

  const review = kernel.planReview(planned.data.plan.handle);
  const receipt = kernel.confirmPlan({ planId: review.planId, planHash: review.planHash });
  const result = await kernel.run({ planId: review.planId }, { confirmationReceiptId: receipt.receiptId, confirmationValue: receipt.value });

  // A reproduced pass/fail boundary under the same pinned command is a verified introducing commit.
  assert.equal(result.data.verdict, 'verified', JSON.stringify(result.data));
  assert.deepEqual(result.data.boundary, { lastPassing: commits[2], firstFailing: commits[3] });
  assert.ok(result.data.observations.length <= preview.maxSteps);
  assert.equal(result.why[0].code, 'investigation.boundary-verified');
  // Historical commits never touched the developer's worktree, and nothing disposable was left behind.
  assert.equal(git(root, 'rev-parse', 'HEAD'), before.head);
  assert.equal(git(root, 'worktree', 'list', '--porcelain'), before.worktrees);
  assert.equal(await readFile(path.join(root, 'notes.txt'), 'utf8'), 'local edits in progress\n');
  assert.ok((await readdir(os.tmpdir())).every((name) => temporary.has(name) || !name.startsWith('sflow-bisect-')));

  // Endpoints that contradict the claim give no verdict, and say why.
  const contradicted = await kernel.resolve({ utterance: 'find the introducing commit', arguments: { good: commits[3], bad: commits[5], testCommandId: 'checkout-contract' } });
  const second = kernel.planReview(contradicted.data.plan.handle);
  const confirmed = kernel.confirmPlan({ planId: second.planId, planHash: second.planHash });
  const unknownVerdict = await kernel.run({ planId: second.planId }, { confirmationReceiptId: confirmed.receiptId, confirmationValue: confirmed.value });
  assert.deepEqual([unknownVerdict.data.verdict, unknownVerdict.data.contradiction], ['unknown', { goodPasses: false, badFails: true }]);
});

test('epistemic-types-never-blur', async (t) => {
  const { root, commits } = await regression(t);
  const report = (await problemInvestigate({ root, arguments: { symptom: 'checkout postal validation fails', sinceRef: commits[0] } })).data.report;
  // The evidence sequence, in order, each step accounted for.
  assert.deepEqual(report.steps.map((step) => step.id), [...EVIDENCE_SEQUENCE]);
  // Unknown inputs are recorded as unknown, never filled in.
  assert.ok(report.unknown.includes('expected') && report.records.some((entry) => entry.type === 'unknown' && entry.statement === 'expected'));
  // Every record has one of the declared types and a categorical confidence; none is a number.
  for (const entry of report.records) {
    assert.ok(INVESTIGATION_RECORD_TYPES.includes(entry.type), entry.type);
    assert.ok(CONFIDENCE_LABELS.includes(entry.confidence), entry.confidence);
  }
  assert.doesNotMatch(JSON.stringify(report), /"confidence":\s*[0-9]/);
  // Change candidates without a reproduction are candidates or correlations, never verified.
  assert.ok(report.changeCandidates.length > 0);
  assert.ok(report.changeCandidates.every((entry) => ['candidate', 'correlated'].includes(entry.confidence)));
  // Each type renders with its own catalog wording: a fact is never worded as a hypothesis.
  const wordings = INVESTIGATION_RECORD_TYPES.map((type) => message(`investigation.record.${type}`).label);
  assert.equal(new Set(wordings).size, wordings.length);

  // A model-assisted hypothesis is its own record type, sourced as assisted, citing facts.
  const assisted = await problemInvestigateAssisted({ root, arguments: { symptom: 'checkout postal validation fails', sinceRef: commits[0] } });
  const relay = assisted.data.assisted.relay;
  const answered = await problemInvestigateAssisted({ root, arguments: {
    symptom: 'checkout postal validation fails', sinceRef: commits[0],
    interpretation: JSON.stringify({ factSetHash: relay.factSetHash, interpretations: [
      { kind: 'hypothesis', text: 'Postal codes became required in the range.', cites: [relay.facts[0].id] }
    ] })
  } });
  const [hypothesis] = answered.data.report.hypotheses;
  assert.deepEqual([hypothesis.type, hypothesis.source, hypothesis.code], ['hypothesis', 'assisted', 'investigation.record.hypothesis']);
  assert.ok(answered.data.report.records.every((entry) => entry.type !== 'hypothesis'), 'a hypothesis never lands among the observations');
  // A numeric confidence from a model is not accepted as calibrated anything.
  const numeric = await problemInvestigateAssisted({ root, arguments: {
    symptom: 'checkout postal validation fails', sinceRef: commits[0],
    interpretation: JSON.stringify({ factSetHash: relay.factSetHash, confidence: 0.92, interpretations: [] })
  } });
  assert.equal(numeric.data.assisted.reason, 'interpretation-touches-facts');
});

test('a stopped investigation keeps what was observed and names what did not run', async (t) => {
  // `[INT:REQ-155]` `[INT:REQ-092]`: stopping after a step is the person's choice; failing is not, and
  // both leave the same honest record.
  const { root, commits } = await regression(t);
  const result = await problemInvestigate({ root, arguments: { symptom: 'checkout postal validation fails', sinceRef: commits[0], stopAfter: 'change-range' } });
  const steps = Object.fromEntries(result.data.report.steps.map((step) => [step.id, step.status]));
  assert.equal(steps['change-range'], 'completed');
  for (const id of ['tests', 'ownership-and-active-work', 'deterministic-impact', 'assisted-hypotheses']) assert.equal(steps[id], 'not-run', id);
  assert.ok(result.data.report.changeCandidates.length > 0, 'what the completed steps found is kept');
  assert.equal(steps['incident-facts'], 'completed');
  assert.ok(result.data.report.records.length > 0, 'completed observations were kept');
  assert.ok(result.warnings.some((warning) => warning.code === 'investigation.step-incomplete' && warning.slots.step === 'deterministic-impact'));
  assert.ok(Object.values(result.effects).every((value) => value === false));
});
