import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { setAgentSession } from '../src/session.mjs';
import { completeAgentResult } from '../src/agent-output.mjs';
import { recordWitness, WITNESS_CHECKLIST } from '../src/verification/witness-records.mjs';
import { WITNESS_DECISIONS_HEADING } from '../src/verification/witness-decisions.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin/singularity-flow.mjs');
const STEP = 'team-release';
const SCREEN = 'evidence/decimal-to-binary.png';
const BYTES = Buffer.from('png-bytes-as-captured');

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A team-owned workflow whose one step writes a conformance report, with a recorded visual witness. */
async function fixture(t, { witness = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-witness-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'Witness Entry Tester');
  git(root, 'config', 'user.email', 'witness@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Witness entry fixture\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const source = YAML.parse(await readFile(file, 'utf8'));
  source.workItemRoot = 'team/stories';
  source.session.workItemSelection = 'reuse';
  source.phases[STEP] = {
    ...structuredClone(source.phases.specification), artifactSet: undefined,
    specificationQuality: undefined, label: 'Team-owned release report',
    artifact: { path: `artifacts/${STEP}/conformance.md`, kind: 'conformance-report', minimumBytes: 100 },
    approval: { authorities: ['product-approvers'], minimum: 1, rejectTo: [STEP] }
  };
  source.workTypes['team-owned-workflow'] = {
    label: 'Team-owned workflow', phases: [STEP],
    omits: ['scope', 'plan', 'implement', 'verify'].map(responsibility => ({ responsibility,
      reason: 'A report-only fixture with no repository delivery.', authority: 'product-approvers' }))
  };
  const agentFile = path.join(root, '.github/agents/product-owner.agent.md');
  await writeFile(agentFile, (await readFile(agentFile, 'utf8'))
    .replace('sflow-phases: "intake,', `sflow-phases: "${STEP},intake,`)
    .replace('sflow-default-for: "intake,', `sflow-default-for: "${STEP},intake,`));
  await writeFile(file, YAML.stringify(source));
  await mkdir(path.join(root, 'evidence'), { recursive: true });
  await writeFile(path.join(root, SCREEN), BYTES);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture authority');
  git(root, 'switch', '-c', 'WIT-ENTRY-1');
  const config = await loadConfig(root);
  const workflow = await createWorkflow(root, config, {
    id: 'WIT-ENTRY-1', title: 'Report recorded visual reviews', baseBranch: 'main',
    workType: 'team-owned-workflow', agent: 'product-owner', resolved: resolveWorkType(config, 'team-owned-workflow'),
    source: { type: 'manual', key: 'WIT-ENTRY-1', title: 'Report recorded visual reviews',
      description: 'A later report must read the recorded witness.',
      acceptanceCriteria: ['The converter screen shows the binary value.'] }
  });
  const statePath = path.join(root, 'team/stories/WIT-ENTRY-1/workflow.json');
  const addWitness = async (story) => {
    // Internal fixture state, written as `decision witness` records it, not a decision operation.
    recordWitness(story, {
      clauseId: 'WIT-ENTRY-1:AC-001', file: SCREEN,
      sha256: `sha256:${createHash('sha256').update(BYTES).digest('hex')}`,
      slot: { slot: 'converter-screenshot', method: 'visual', witness: { target: 'converter screen' } },
      answers: Object.fromEntries(WITNESS_CHECKLIST.map((item) => [item, 'yes'])),
      reason: 'inspected the screenshot and it look fine', actor: 'reviewer@example.invalid',
      authorityGroup: 'product-approvers', at: '2026-10-18T09:30:00.000Z'
    });
    await writeFile(statePath, `${JSON.stringify(story, null, 2)}\n`);
  };
  if (witness) await addWitness(workflow);
  await setAgentSession(root, config, { name: 'Witness Entry Tester', email: 'witness@example.invalid' },
    workflow.phases[workflow.currentPhase].defaultAgent, 'WIT-ENTRY-1', { phaseId: workflow.currentPhase, source: 'test' });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'accepted Story closure');
  const env = { ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(root, '.git/mode-not-set.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/no-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/no-registry.json') };
  delete env.SINGULARITY_FLOW_NO_MODEL;
  const enter = () => {
    const result = spawnSync(process.execPath, [cli, 'phase', 'enter', '--compose', '--for-agent', '--json'], {
      cwd: root, env, encoding: 'utf8', timeout: process.platform === 'win32' ? 180_000 : 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return completeAgentResult(result.stdout);
  };
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: root, env, encoding: 'utf8', timeout: process.platform === 'win32' ? 180_000 : 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return completeAgentResult(result.stdout);
  };
  return { root, statePath, enter, addWitness, run, commit: (message) => { git(root, 'add', '.'); git(root, 'commit', '-qm', message); } };
}

test('a conformance step\'s entry packet and composed prompt carry the recorded visual reviews', async t => {
  const item = await fixture(t);
  const entry = item.enter();
  assert.equal(entry.phase, STEP);
  assert.equal(entry.contextComposition, 'delivered');
  const reviews = entry.recordedVisualReviews;
  assert.equal(reviews.revision, 'recorded-visual-reviews-v1');
  assert.deepEqual(reviews.reviews.map((review) => [review.id, review.clauseId, review.slot, review.file, review.decision, review.binding, review.valid]),
    [['WIT-001', 'WIT-ENTRY-1:AC-001', 'converter-screenshot', SCREEN, 'satisfies', 'bound-file-unchanged', true]]);
  assert.ok(entry.agentGuide.readOrder.includes('recordedVisualReviews'));
  assert.ok(entry.agentGuide.readOrder.includes('evidenceConsistency'));
  assert.equal(entry.evidenceConsistency.visualReviews[0].id, 'WIT-001');
  assert.equal(entry.evidenceConsistency.visualReviews[0].valid, true);
  assert.ok(entry.evidenceConsistency.summary.some((line) => line.includes('WIT-001: WIT-ENTRY-1:AC-001')));
  const text = entry.context.text;
  // One prompt source: the evidence-consistency section carries the review, its details and the rule.
  assert.equal(text.includes(`${WITNESS_DECISIONS_HEADING}\n`), false, 'no second visual-review section');
  const line = `- WIT-001: WIT-ENTRY-1:AC-001, slot converter-screenshot: recorded human review satisfies this slot; file binding bound-file-unchanged, candidate `;
  assert.ok(text.includes(line), text);
  assert.equal(text.split('WIT-001:').length, 2, 'the review is stated once');
  assert.match(text, new RegExp(`visual of \`${SCREEN.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\`[^\n]* satisfies it, recorded `, "u"));
  assert.match(text, /never say that criterion lacks human visual review/u);
  // The retained prompt file holds the same account: it is part of the composed generation.
  assert.ok((await readFile(path.join(item.root, entry.context.file.path), 'utf8')).includes(line));
  const record = JSON.parse(await readFile(path.join(item.root, `team/stories/WIT-ENTRY-1/context/${STEP}-gen${entry.context.generation}.json`), 'utf8'));
  assert.equal(record.promptBudget.visualReviews.projectionSha256, reviews.projectionSha256);
  assert.equal(record.promptBudget.evidenceConsistency.projectionSha256, entry.evidenceConsistency.projectionSha256);
  assert.ok(text.includes(`# Evidence consistency\n`));
});

test('without a witness the entry packet and prompt are unchanged; one recorded after composition is delivered as a refresh', async t => {
  const item = await fixture(t, { witness: false });
  const first = item.enter();
  assert.equal(Object.hasOwn(first, 'recordedVisualReviews'), false);
  assert.equal(first.agentGuide.readOrder.includes('recordedVisualReviews'), false);
  assert.equal(first.context.text.includes(WITNESS_DECISIONS_HEADING), false);
  await item.addWitness(JSON.parse(await readFile(item.statePath, 'utf8')));
  item.commit('witness recorded after composition');
  const reused = item.enter();
  assert.equal(reused.context.renderedSha256, first.context.renderedSha256, 'the retained prompt keeps its exact bytes');
  assert.doesNotMatch(reused.context.text, /# Current recorded visual reviews refresh\n/u, 'one refresh carries the new review');
  assert.ok(reused.context.text.includes('WIT-001: WIT-ENTRY-1:AC-001, slot converter-screenshot: recorded human review satisfies this slot'));
  assert.ok(reused.context.text.includes('visual of'));
  assert.equal(reused.recordedVisualReviews.reviews[0].valid, true);
  assert.match(reused.context.text, /# Current evidence-consistency refresh\n/u);
  assert.equal(reused.evidenceConsistency.visualReviews[0].valid, true);
});

test('draft-check names a report row that denies the recorded review, as an advisory only', async t => {
  const item = await fixture(t);
  const prepared = item.run('prepare', STEP, '--json');
  const draft = path.join(item.root, prepared.data.preparation.path);
  const report = (evidence) => [
    '# Release conformance', '',
    'This report compares each criterion of WIT-ENTRY-1 with the delivered change and its retained evidence.', '',
    '| Clause | Verdict | Evidence |', '|---|---|---|',
    `| WIT-ENTRY-1:AC-001 | matched | ${evidence} |`, ''
  ].join('\n');
  await writeFile(draft, report('Tests pass; this verdict does not claim independent human visual acceptance.'));
  const checked = item.run('phase', 'draft-check', STEP, '--json');
  assert.ok(checked.evidenceConsistency.findings.some((entry) => entry.code === 'conformance.witness-unreported'));
  const advisory = checked.advisories.find((entry) => entry.code === 'conformance.witness-unreported');
  assert.equal(checked.advisories.filter((entry) => entry.code === 'conformance.witness-unreported').length, 1,
    'the shared snapshot and draft display do not duplicate the same visual-review advisory');
  assert.ok(advisory, JSON.stringify(checked.advisories));
  assert.equal(advisory.blocking, false);
  assert.equal(advisory.record, 'WIT-001');
  assert.equal(advisory.path, prepared.data.preparation.path);
  assert.ok(checked.findings.every((entry) => entry.code !== 'conformance.witness-unreported'), 'never a finding');
  await writeFile(draft, report('Human visual acceptance: WIT-001 (bound file unchanged).'));
  const cited = item.run('phase', 'draft-check', STEP, '--json');
  assert.equal(cited.advisories.some((entry) => entry.code === 'conformance.witness-unreported'), false);
});
