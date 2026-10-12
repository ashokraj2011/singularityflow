import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { setAgentSession } from '../src/session.mjs';
import { snapshot } from '../src/util.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { inputRestorePlan } from '../src/commands/input-restore.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin/singularity-flow.mjs');
const SPEC = 'team/stories/RESTORE-1/artifacts/specification/spec.md';
const WORKFLOW = 'team/stories/RESTORE-1/workflow.json';
const APPROVED = '# Approved specification\n\n[RESTORE-1:REQ-001] Restore exact approved bytes.\n';
const EDITED = `${APPROVED}\nAn unreviewed edit made while planning.\n`;

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** A Story at planning whose approved specification is an enforced input. */
async function fixture(t, { approved = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-input-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'Restore Tester');
  git(root, 'config', 'user.email', 'restore@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Restore fixture\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const source = YAML.parse(await readFile(file, 'utf8'));
  source.workItemRoot = 'team/stories';
  source.session.workItemSelection = 'reuse';
  source.workTypes['spec-driven-standard'].phaseOverrides.planning.inputs = [
    { phase: 'specification', projection: 'full' }
  ];
  await writeFile(file, YAML.stringify(source));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture authority');
  git(root, 'switch', '-c', 'RESTORE-1');
  const config = await loadConfig(root);
  const workflow = await createWorkflow(root, config, {
    id: 'RESTORE-1', title: 'Restore approved upstream bytes', baseBranch: 'main',
    workType: 'spec-driven-standard', agent: 'product-owner', resolved: resolveWorkType(config, 'spec-driven-standard'),
    source: { type: 'manual', key: 'RESTORE-1', title: 'Restore approved upstream bytes',
      description: 'A changed approved input is put back exactly, never re-approved implicitly.',
      acceptanceCriteria: ['Restore previews, checkpoints, then writes the approved bytes.'] }
  });
  // Internal fixture state, not an approval operation: the Story starts at an approved input boundary.
  await writeFile(path.join(root, SPEC), APPROVED);
  Object.assign(workflow.phases.specification, { status: approved ? 'approved' : 'awaiting_approval', generation: 1,
    artifacts: [{ path: SPEC, status: approved ? 'approved' : 'pending', ...await snapshot(path.join(root, SPEC)) }] });
  workflow.currentPhase = 'planning';
  workflow.phases.planning.status = 'in_progress';
  await writeFile(path.join(root, WORKFLOW), `${JSON.stringify(workflow, null, 2)}\n`);
  await setAgentSession(root, config, { name: 'Restore Tester', email: 'restore@example.invalid' },
    workflow.phases.planning.defaultAgent, 'RESTORE-1', { phaseId: 'planning', source: 'test' });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'accepted Story at planning');
  const env = { ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(root, '.git/mode-not-set.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/no-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/no-registry.json') };
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000
  });
  const json = (...args) => {
    const result = invoke(...args, '--json');
    return { status: result.status, stderr: result.stderr, value: JSON.parse(result.stdout) };
  };
  return { root, workflow, config, invoke, json };
}

test('restore is registered as a read-only preview and a confirmed mutation', () => {
  const resolve = (positionals, options) => resolveOperation({ requestedCommand: 'inputs', positionals, options });
  assert.equal(resolve(['inputs', 'restore', 'planning'], { json: true }).id, 'inputs.restore.preview');
  assert.equal(resolve(['inputs', 'restore', 'planning'], {}).classification, 'read');
  const apply = resolve(['inputs', 'restore', 'planning'], { confirm: `sha256:${'a'.repeat(64)}` });
  assert.equal(apply.id, 'inputs.restore.apply');
  assert.equal(apply.classification, 'mutation');
  assert.equal(resolve(['inputs', 'planning'], { 'dry-run': true }).id, 'inputs.dry-run');
});

test('uncommitted drift previews, refuses a stale confirmation, then checkpoints and restores the approved bytes', async t => {
  const item = await fixture(t);
  await writeFile(path.join(item.root, SPEC), EDITED);
  const workflowBefore = await readFile(path.join(item.root, WORKFLOW), 'utf8');
  const head = git(item.root, 'rev-parse', 'HEAD');

  const preview = item.json('inputs', 'restore', 'planning');
  assert.equal(preview.status, 0, preview.stderr);
  const plan = preview.value;
  assert.equal(plan.status, 'preview');
  assert.equal(plan.restorable, 1);
  assert.match(plan.planSha256, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(plan.confirmCommand, `singularity-flow inputs restore planning --confirm ${plan.planSha256}`);
  const [entry] = plan.entries;
  assert.equal(entry.phase, 'specification');
  assert.equal(entry.path, SPEC);
  assert.equal(entry.status, 'hash_mismatch');
  assert.equal(entry.drift, 'uncommitted');
  assert.deepEqual(entry.source, { kind: 'head', commit: head });
  assert.equal(entry.approvedSha256, item.workflow.phases.specification.artifacts[0].sha256);
  assert.equal(await readFile(path.join(item.root, SPEC), 'utf8'), EDITED, 'a preview changes nothing');
  const human = item.invoke('inputs', 'restore', 'planning');
  assert.match(human.stdout, /RESTORE team\/stories\/RESTORE-1\/artifacts\/specification\/spec\.md \(from specification, hash_mismatch\)/);
  assert.match(human.stdout, /Restore with: singularity-flow inputs restore planning --confirm sha256:/);

  const stale = item.json('inputs', 'restore', 'planning', '--confirm', `sha256:${'0'.repeat(64)}`);
  assert.notEqual(stale.status, 0);
  assert.equal(stale.value.error.code, 'INPUT_RESTORE_PLAN_CHANGED');
  assert.equal(stale.value.remediationPlan.steps[0].command, 'singularity-flow inputs restore planning --json');
  assert.equal(await readFile(path.join(item.root, SPEC), 'utf8'), EDITED);

  const applied = item.json('inputs', 'restore', 'planning', '--confirm', plan.planSha256);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.value.status, 'restored');
  assert.deepEqual(applied.value.restored.map(({ phase, path: file }) => ({ phase, path: file })), [{ phase: 'specification', path: SPEC }]);
  assert.match(applied.value.checkpoint.id, /^PCP-[a-f0-9]{64}$/u);
  assert.equal(applied.value.effects.storyStateChanged, false);
  assert.equal(await readFile(path.join(item.root, SPEC), 'utf8'), APPROVED);
  assert.equal(await readFile(path.join(item.root, WORKFLOW), 'utf8'), workflowBefore, 'Story state is untouched');
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(git(item.root, 'diff', '--cached', '--name-only'), '', 'nothing is staged');

  // The private checkpoint holds the edited copy and verifies without restoring anything.
  const shown = item.json('appeal', 'checkpoint-show', applied.value.checkpoint.id, '--work-id', 'RESTORE-1', '--phase', 'planning');
  assert.equal(shown.status, 0, shown.stderr);
  const kept = JSON.stringify(shown.value);
  assert.match(kept, /artifacts\/specification\/spec\.md/);

  const ready = item.json('inputs', 'planning', '--dry-run');
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.value.readiness.ready, true);
  const nothing = item.json('inputs', 'restore', 'planning');
  assert.equal(nothing.value.restorable, 0);
  assert.equal(nothing.value.entries.length, 0);
});

test('a deleted approved input is restored from the committed approved copy', async t => {
  const item = await fixture(t);
  await unlink(path.join(item.root, SPEC));
  const plan = item.json('inputs', 'restore').value;
  assert.equal(plan.phase, 'planning', 'the current phase is the default');
  assert.equal(plan.entries[0].status, 'missing');
  assert.equal(plan.entries[0].restorable, true);
  const applied = item.json('inputs', 'restore', '--confirm', plan.planSha256);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(await readFile(path.join(item.root, SPEC), 'utf8'), APPROVED);
});

test('committed drift is refused with its own code and the producer route, never restored behind the branch', async t => {
  const item = await fixture(t);
  await writeFile(path.join(item.root, SPEC), EDITED);
  git(item.root, 'add', SPEC);
  git(item.root, 'commit', '-qm', 'an unreviewed commit to an approved artifact');
  const plan = await inputRestorePlan(item.root, item.config, item.workflow, 'planning');
  assert.equal(plan.restorable, 0);
  assert.equal(plan.confirmCommand, null);
  assert.equal(plan.entries[0].drift, 'committed');
  assert.equal(plan.entries[0].code, 'INPUT_RESTORE_COMMITTED_DRIFT');
  assert.equal(plan.entries[0].source.kind, 'commit');
  assert.match(plan.entries[0].reason, /would leave this phase's publication refused/);
  const refused = item.json('inputs', 'restore', 'planning', '--confirm', plan.planSha256);
  assert.notEqual(refused.status, 0);
  assert.equal(refused.value.error.code, 'INPUT_RESTORE_COMMITTED_DRIFT');
  assert.deepEqual(refused.value.error.details.upstreamPhases, ['specification']);
  const commands = refused.value.remediationPlan.steps.map(step => step.command);
  assert.equal(commands[0], 'singularity-flow inputs planning --dry-run --json');
  assert.ok(!commands.some(command => command?.startsWith('singularity-flow inputs restore')), JSON.stringify(commands));
  assert.equal(refused.value.remediationPlan.context.strategy, 'upstream-input');
  assert.equal(await readFile(path.join(item.root, SPEC), 'utf8'), EDITED);
});

test('staged drift and an unapproved producer are not restored', async t => {
  const item = await fixture(t);
  await writeFile(path.join(item.root, SPEC), EDITED);
  git(item.root, 'add', SPEC);
  const staged = await inputRestorePlan(item.root, item.config, item.workflow, 'planning');
  assert.equal(staged.entries[0].code, 'INPUT_RESTORE_STAGED_DRIFT');
  assert.equal(staged.entries[0].restorable, false);
  const refused = item.json('inputs', 'restore', 'planning', '--confirm', staged.planSha256);
  assert.equal(refused.value.error.code, 'INPUT_RESTORE_STAGED_DRIFT');
  assert.match(refused.value.remediationPlan.steps[0].label, /Unstage that file/);

  const pending = await fixture(t, { approved: false });
  await writeFile(path.join(pending.root, SPEC), EDITED);
  const unapproved = await inputRestorePlan(pending.root, pending.config, pending.workflow, 'planning');
  assert.equal(unapproved.entries[0].status, 'unapproved');
  assert.equal(unapproved.entries[0].code, 'INPUT_RESTORE_NOT_APPROVED_BYTES');
  assert.match(unapproved.entries[0].reason, /only an approved phase has bytes to restore/);
});
