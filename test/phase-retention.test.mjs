import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { EQUIVALENCE_RULES, equivalenceRule, retainedByRule } from '../src/evidence/equivalence-rules.mjs';
import { headTreeDigest } from '../src/git.mjs';
import { reopenPhaseRange, resetPhaseRangeForRework } from '../src/lifecycle-transitions.mjs';
import { retainableApprovals } from '../src/phase-retention.mjs';
import { changedUpstream } from '../src/phase-upstream.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin/singularity-flow.mjs');
const W = 'KEEP-1';
const at = '2026-10-03T10:00:00.000Z';

test('evidence is reused only under the product rules, and a record names the rule it relies on', () => {
  assert.deepEqual(Object.keys(EQUIVALENCE_RULES), ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7']);
  assert.equal(equivalenceRule('E1').name, 'identical inputs');
  for (const unknown of ['E8', 'workflow-rule', '__proto__', undefined]) {
    assert.throws(() => equivalenceRule(unknown), (error) => error.code === 'EQUIVALENCE_RULE_UNKNOWN');
  }
  assert.deepEqual(retainedByRule('E1', { approvalAt: at }), { rule: 'E1', approvalAt: at });
  assert.throws(() => retainedByRule('E9'), (error) => error.code === 'EQUIVALENCE_RULE_UNKNOWN');
});

function lifecycle() {
  const phase = (id, status, approvals = []) => ({ id, label: id, status, generation: 1, artifacts: [], checks: [], approvals,
    approvalPolicy: { mode: 'human', minimum: 1, authorities: ['reviewers'] }, approvedAt: status === 'approved' ? '2026-10-01T00:00:00.000Z' : null });
  const approval = (upstream = { sha256: 'sha256:a', refs: [] }) => ({ decision: 'approved', generation: 1, at: '2026-10-01T00:00:00.000Z',
    actor: { name: 'Reviewer', email: 'reviewer@example.test' }, authorityGroup: 'reviewers', upstream });
  return {
    workflow: {
      status: 'closed', currentPhase: null, phaseOrder: ['intake', 'requirements', 'design', 'release'], history: [],
      phases: {
        intake: phase('intake', 'approved', [approval()]),
        requirements: phase('requirements', 'approved', [approval()]),
        design: phase('design', 'approved', [approval()]),
        release: phase('release', 'approved', [{ ...approval(), upstream: undefined }])
      }
    },
    approval
  };
}

test('a rejection or reopen marks the approved phases after its target retainable; a loop and other resets do not', () => {
  const { workflow } = lifecycle();
  reopenPhaseRange(workflow, { targetId: 'requirements', at, actor: 'reviewer@example.test', reason: 'Clarify one requirement.', retain: true });
  assert.deepEqual(workflow.phases.requirements.reworkRevalidation, { generation: 1, invalidatedAt: at }, 'the target always runs again');
  assert.deepEqual(workflow.phases.design.reworkRevalidation, { generation: 1, invalidatedAt: at, retainable: true });
  assert.equal(retainableApprovals(workflow, workflow.phases.design).length, 1);
  assert.equal(retainableApprovals(workflow, workflow.phases.release), null, 'an approval that recorded no upstream cannot be compared');
  assert.equal(retainableApprovals(workflow, workflow.phases.requirements), null);

  const loop = lifecycle().workflow;
  reopenPhaseRange(loop, { targetId: 'requirements', at, actor: 'rule', reason: 'Another round.' });
  assert.equal(loop.phases.design.reworkRevalidation.retainable, undefined, 'each round of a loop gets its own evidence');
  const detached = lifecycle().workflow;
  resetPhaseRangeForRework(detached, { targetId: 'requirements', at });
  assert.equal(detached.phases.design.reworkRevalidation.retainable, undefined);

  // A regenerated phase, one approved after the reset, or one that follows a decision runs again.
  const regenerated = structuredClone(workflow);
  regenerated.phases.design.generation = 2;
  assert.equal(retainableApprovals(regenerated, regenerated.phases.design), null);
  const decided = structuredClone(workflow);
  decided.resolution = { decisions: [{ id: 'route', after: 'design', routes: [] }] };
  decided.phases.design.retention = { rule: 'E1', at, generation: 1 };
  reopenPhaseRange(decided, { targetId: 'requirements', at: '2026-10-03T11:00:00.000Z', actor: 'reviewer@example.test', reason: 'Again.', retain: true });
  assert.equal(Object.hasOwn(decided.phases.design, 'retention'), false, 'a reset clears an earlier retention');
  assert.equal(retainableApprovals(decided, decided.phases.design), null, 'a phase a decision follows takes its decision again');
});

test('a phase that runs again says which of its references changed', () => {
  const decided = { sha256: 'sha256:1', refs: [{ kind: 'input', ref: 'intake', sha256: 'sha256:i' }, { kind: 'documents', ref: 'design', sha256: 'sha256:d' }, { kind: 'decisions', ref: 'story', sha256: 'sha256:s' }] };
  const current = { sha256: 'sha256:2', refs: [{ kind: 'input', ref: 'intake', sha256: 'sha256:j' }, { kind: 'documents', ref: 'design', sha256: 'sha256:d' }, { kind: 'decisions', ref: 'story', sha256: 'sha256:t' }] };
  assert.deepEqual(changedUpstream(decided, current), ['input:intake', 'decisions']);
  assert.deepEqual(changedUpstream(decided, null), ['upstream']);
});

test('the code an approval decided over is HEAD outside the governance root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-head-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run('git', args, root);
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Tree Tester'); git('config', 'user.email', 'tree@example.test');
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'singularity'));
  assert.equal(headTreeDigest(root, { excludedRoot: 'singularity/' }), null, 'no HEAD yet');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'singularity/workflow.json'), '{}\n');
  git('add', '.'); git('commit', '-q', '-m', 'first');
  const first = headTreeDigest(root, { excludedRoot: 'singularity/' });
  assert.match(first, /^sha256:[0-9a-f]{64}$/u);
  await writeFile(path.join(root, 'singularity/workflow.json'), '{"status":"closed"}\n');
  git('commit', '-q', '-am', 'governance only');
  assert.equal(headTreeDigest(root, { excludedRoot: 'singularity/' }), first, 'governance records are not code');
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 2;\n');
  git('commit', '-q', '-am', 'code');
  assert.notEqual(headTreeDigest(root, { excludedRoot: 'singularity/' }), first);
});

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Retention Tester', SINGULARITY_FLOW_NO_MODEL: '1' }
  });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

test('after rework, a phase whose inputs did not change keeps its approval by rule E1, and one whose inputs changed runs again', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-retention-'));
  const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Retention Tester'], root);
  run('git', ['config', 'user.email', 'retain@example.test'], root);
  await writeFile(path.join(root, 'README.md'), '# Retention fixture\n');
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off';
  config.repositoryReadiness.requiredBeforeStory = false;
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // The design reads only the intake, so reworking the requirements cannot change what it decided over.
  config.workTypes['keep-demo'] = {
    label: 'Retention demo', phases: ['intake', 'requirements', 'design'],
    phaseOverrides: { requirements: { inputs: ['intake'] }, design: { inputs: ['intake'], approval: { rejectTo: ['intake', 'requirements', 'design'] } } },
    omits: ['implement', 'verify'].map((responsibility) => ({ responsibility, reason: 'A document-only fixture that changes no repository code.', authority: 'product-approvers' }))
  };
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'Initialize the retention fixture'], root);
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-q', '-u', 'origin', 'main'], root);

  cli('start', W, '--from-branch', 'main', '--work-type', 'keep-demo', '--title', 'Keep unaffected approvals', '--description', 'Show that rework keeps an approval nothing changed.');
  const item = path.join(root, 'singularity/work-items', W);
  const state = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  const complete = async (phase, text) => {
    cli('prepare', phase);
    const artifact = path.join(item, `artifacts/${phase}/${phase}.md`);
    await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/gu, text).replace(/\bTODO\b/gu, 'the fixture behaviour'));
    cli('wm', 'compose', '--phase', phase);
    cli('clarification', 'record', phase, '--question', `Is the ${phase} complete?`, '--answer', 'Yes, for this fixture.');
    cli('phase', 'publish', phase, '--authored', 'human', '--channel', 'manual-in-place');
    cli('submit', phase);
    return cli('approve', phase, '--yes');
  };
  const prose = (what) => `${what} The fixture describes this section in enough words to pass the minimum size of the artifact for its phase.`;
  await complete('intake', prose('Keep every approval that rework did not affect.'));
  await complete('requirements', prose('The requirements name what changes and what stays.'));
  for (const responsibility of ['implement', 'verify']) {
    cli('decision', 'applicability', '--responsibility', responsibility, '--reason', 'This document-only fixture changes no repository code.');
  }
  await complete('design', prose('The design reads only the intake.'));
  let workflow = await state();
  assert.equal(workflow.status, 'closed');
  const designApproval = workflow.phases.design.approvals.find((entry) => !entry.invalidatedAt && entry.decision === 'approved');
  assert.deepEqual(designApproval.upstream.refs.map((ref) => `${ref.kind}:${ref.ref}`), ['input:intake', 'documents:design', 'decisions:story']);

  // Rework the requirements: the design decided over nothing that changes, so it keeps its approval.
  cli('reopen', W, '--to', 'requirements', '--reason', 'Clarify what the requirements leave unchanged.');
  workflow = await state();
  assert.equal(workflow.phases.design.status, 'not_started');
  assert.equal(workflow.phases.design.reworkRevalidation.retainable, true);
  const approved = await complete('requirements', prose('The requirements now also say what stays unchanged.'));
  workflow = await state();
  assert.equal(workflow.status, 'closed', approved.stdout);
  assert.equal(workflow.phases.design.status, 'approved');
  assert.equal(workflow.phases.design.generation, 1, 'the design was not regenerated');
  assert.deepEqual(workflow.phases.design.retention.rule, 'E1');
  // The reopen itself is recorded on the phase that completed the Story; only approvals authorize it.
  const retained = workflow.phases.design.approvals.filter((entry) => !entry.invalidatedAt && entry.decision === 'approved');
  assert.equal(retained.length, 1);
  assert.equal(retained[0].retained.rule, 'E1');
  assert.equal(retained[0].retained.approvalAt, designApproval.at);
  assert.equal(workflow.phases.design.approvedAt, designApproval.at, 'the design reads as its approval left it');
  assert.ok(workflow.history.some((entry) => entry.event === 'phase_retained' && entry.phase === 'design' && /rule E1/.test(entry.detail)));
  assert.ok(workflow.history.some((entry) => /^phase_(?:self_)?approved$/.test(entry.event) && entry.phase === 'requirements' && /retained design by rule E1/.test(entry.detail)), workflow.history.map((entry) => `${entry.event} ${entry.phase}: ${entry.detail}`).join('\n'));
  const gate = JSON.parse(cli('gate', '--terminal', '--json').stdout);
  assert.deepEqual(gate.errors, []);
  assert.ok(gate.passes.includes('approval integrity: design'), gate.passes.join('\n'));

  // Rework the intake, which the design reads: the design runs again, and the history says why.
  cli('reopen', W, '--to', 'intake', '--reason', 'Narrow the intake to the approvals rework keeps.');
  await complete('intake', prose('Keep only the approvals rework did not affect, and say why.'));
  workflow = await state();
  assert.equal(workflow.currentPhase, 'requirements', 'the requirements read the intake too');
  assert.ok(workflow.history.some((entry) => /^phase_(?:self_)?approved$/.test(entry.event) && entry.phase === 'intake'
    && /requirements runs again because input:intake changed/.test(entry.detail)), workflow.history.map((entry) => entry.detail).join('\n'));
  await complete('requirements', prose('The requirements follow the narrowed intake.'));
  workflow = await state();
  assert.equal(workflow.currentPhase, 'design');
  assert.equal(workflow.phases.design.status, 'in_progress');
  assert.ok(workflow.history.some((entry) => /^phase_(?:self_)?approved$/.test(entry.event) && entry.phase === 'requirements'
    && /design runs again because input:intake changed/.test(entry.detail)));
});
