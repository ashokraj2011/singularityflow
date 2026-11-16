/**
 * SPEC-SCF stage 4: a sflow/config that is missing or does not load is repaired by a person-approved restore
 * [SCF:REQ-002, D7], and doctor and configuration validate check sflow/config, never the application checkout's
 * own singularity/ files (finding ER-F5). The upgrade's local pass removes the upload refs a published sflow/config
 * already holds (finding CH-F9).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import YAML from 'yaml';
import { run } from '../src/util.mjs';
import { initializeDefinition, validateDefinition } from '../src/config.mjs';
import { previewConfigurationRestore, applyConfigurationRestore } from '../src/configuration-restore.mjs';
import { activateWorkflowConfigurationProposal } from '../src/configuration-proposal.mjs';
import { pruneLocalSupersededConfigurationRefs } from '../src/configuration-local-history-prune.mjs';
import { writeLegacyStateCopy } from './helpers/legacy-state-copy.mjs';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'singularity-flow.mjs');
const WORKFLOW = 'singularity/workflow.yml';
const ALICE = { name: 'Alice Example', email: 'alice@example.test' };

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-scf4-'));
  const seed = path.join(base, 'seed'), remote = path.join(base, 'remote.git');
  run('git', ['init', '-q', '-b', 'main', seed]);
  run('git', ['config', 'user.name', 'Seed Author'], { cwd: seed });
  run('git', ['config', 'user.email', 'seed@example.test'], { cwd: seed });
  await initializeDefinition(seed);
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'baseline'], { cwd: seed });
  run('git', ['init', '-q', '--bare', remote]);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true']);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/main', 'HEAD:refs/heads/sflow/config'], { cwd: seed });
  const clone = (name, args) => {
    const target = path.join(base, name);
    run('git', ['clone', '-q', ...args, remote, target]);
    run('git', ['config', 'user.name', ALICE.name], { cwd: target });
    run('git', ['config', 'user.email', ALICE.email], { cwd: target });
    return target;
  };
  const env = { ...process.env, NODE_ENV: 'test', NO_COLOR: '1',
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json') };
  const previous = process.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX;
  process.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX = env.SINGULARITY_FLOW_TRANSPORT_OUTBOX;
  return { base, seed, remote, clone, env, async done() {
    if (previous == null) delete process.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX;
    else process.env.SINGULARITY_FLOW_TRANSPORT_OUTBOX = previous;
    await rm(base, { recursive: true, force: true });
  } };
}

const tip = (f) => run('git', ['--git-dir', f.remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/sflow/config'], { allowFailure: true }).stdout.trim();
const authorityWorkflow = (f) => run('git', ['--git-dir', f.remote, 'show', `sflow/config:${WORKFLOW}`]).stdout;

/** An edit merged on the Git host, past SFlow: one unknown step in chore, so sflow/config does not load. */
async function breakOutsideSflow(f) {
  const work = f.clone(`outside-${Math.random().toString(16).slice(2)}`, ['-b', 'sflow/config']);
  const file = path.join(work, WORKFLOW);
  const definition = YAML.parse(await readFile(file, 'utf8'));
  definition.workTypes.chore.phases = [...definition.workTypes.chore.phases, 'no-such-step'];
  await writeFile(file, YAML.stringify(definition));
  run('git', ['commit', '-qam', 'edit merged on the Git host'], { cwd: work });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: work });
  assert.throws(() => validateDefinition(YAML.parse(authorityWorkflow(f))), 'the authority no longer loads');
}

test('an outside edit that breaks sflow/config is repaired by a restore proposal a person approves (ER-F5, REQ-002)', async () => {
  const f = await fixture();
  try {
    const app = f.clone('app', ['-b', 'main']);
    const good = tip(f);
    await breakOutsideSflow(f);
    const broken = tip(f);
    const preview = await previewConfigurationRestore(app, { env: f.env });
    assert.equal(preview.status, 'unloadable');
    assert.equal(preview.commit, broken);
    assert.equal(preview.source.commit, good, 'the newest commit in its own history that loads');
    assert.match(preview.problem, /no-such-step/u);
    assert.deepEqual(preview.files, [WORKFLOW]);
    assert.equal(tip(f), broken, 'a preview changes nothing');
    await assert.rejects(applyConfigurationRestore(app, { confirm: broken, identity: () => ALICE, env: f.env }),
      { code: 'CONFIGURATION_RESTORE_CONFIRMATION_MISMATCH' });
    await assert.rejects(applyConfigurationRestore(app, { confirm: preview.source.id, identity: () => ALICE, agent: () => true, env: f.env }),
      { code: 'PSS_CARD_NOT_SHOWN' }, 'an agent never restores');
    const proposed = await applyConfigurationRestore(app, { confirm: preview.source.id, identity: () => ALICE, env: f.env });
    assert.equal(proposed.proposed, true);
    assert.equal(tip(f), broken, 'a repair is a proposal: nothing lands until it is approved');
    const approved = await activateWorkflowConfigurationProposal(app, proposed.proposal.branch,
      { confirm: proposed.proposal.commit, acknowledgeUnprotected: true });
    assert.equal(approved.activated, true);
    validateDefinition(YAML.parse(authorityWorkflow(f)));
    assert.equal(run('git', ['--git-dir', f.remote, 'merge-base', '--is-ancestor', broken, 'sflow/config'], { allowFailure: true }).status, 0,
      'sflow/config only moved forward');
  } finally { await f.done(); }
});

test('a deleted sflow/config is recreated from a clone\'s copy, then from the old state copy, each approved by a person (D7)', async () => {
  const f = await fixture();
  try {
    const app = f.clone('app', ['-b', 'main', '--no-single-branch']);
    const last = tip(f);
    await writeLegacyStateCopy(f.remote, { env: f.env });
    const original = authorityWorkflow(f);
    run('git', ['--git-dir', f.remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
    assert.equal(tip(f), '');

    const fromClone = await previewConfigurationRestore(app, { env: f.env });
    assert.equal(fromClone.status, 'missing');
    assert.equal(fromClone.source.kind, 'clone');
    assert.equal(fromClone.source.commit, last);
    assert.ok(fromClone.files.includes(WORKFLOW));
    const restored = await applyConfigurationRestore(app, { confirm: fromClone.source.id, identity: () => ALICE, env: f.env });
    assert.equal(restored.restored, true);
    assert.equal(run('git', ['--git-dir', f.remote, 'rev-parse', 'sflow/config^']).stdout.trim(), last, 'its history is kept');
    assert.match(run('git', ['--git-dir', f.remote, 'log', '-1', '--format=%B', 'sflow/config']).stdout,
      /Sflow-Restored-From: clone [0-9a-f]{40}\nApproved-by: Alice Example <alice@example\.test>/u);
    assert.equal(authorityWorkflow(f), original);

    // A machine with no copy of its own falls back to the copy an earlier build kept on the state branch.
    run('git', ['--git-dir', f.remote, 'update-ref', '-d', 'refs/heads/sflow/config']);
    const stranger = f.clone('stranger', ['-b', 'main', '--single-branch']);
    const fromState = await previewConfigurationRestore(stranger, { env: f.env });
    assert.equal(fromState.status, 'missing');
    assert.equal(fromState.source.kind, 'state-copy');
    assert.ok(fromState.files.includes(WORKFLOW));
    const recreated = await applyConfigurationRestore(stranger, { confirm: fromState.source.id, identity: () => ALICE, env: f.env });
    assert.equal(recreated.restored, true);
    assert.equal(authorityWorkflow(f), original, 'the copy\'s files, checked against its own manifest');
  } finally { await f.done(); }
});

test('doctor and configuration validate check sflow/config, not the application checkout, and name it (ER-F5)', async () => {
  const f = await fixture();
  try {
    const app = f.clone('app', ['-b', 'main', '--no-single-branch']);
    await breakOutsideSflow(f);
    const runCli = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: app, encoding: 'utf8', env: f.env });
    // The checkout's own singularity/workflow.yml still loads; the authority does not.
    validateDefinition(YAML.parse(await readFile(path.join(app, WORKFLOW), 'utf8')));
    const validated = runCli(['configuration', 'validate', '--json']);
    assert.notEqual(validated.status, 0, validated.stdout);
    assert.match(`${validated.stdout}${validated.stderr}`, /On sflow\/config \([0-9a-f]{12}\)/u);
    assert.match(`${validated.stdout}${validated.stderr}`, /no-such-step/u);
    const doctor = runCli(['doctor', '--json']);
    const report = JSON.parse(doctor.stdout);
    const configuration = report.checks.find((entry) => entry.id === 'configuration');
    assert.equal(configuration.status, 'fail', configuration.message);
    assert.match(configuration.message, /^On sflow\/config \([0-9a-f]{12}\): /u);
    assert.match(configuration.fix, /configuration restore/u);
    // workflow fix reads the same sflow/config as it is, and drafts its repair instead of refusing first [SCF:REQ-002].
    const fixed = runCli(['workflow', 'fix', '--json']);
    const drafted = JSON.parse(fixed.stdout);
    assert.ok(drafted.configurationFiles.length || drafted.changes.length || drafted.questions.length,
      `workflow fix drafted nothing: ${fixed.stdout.slice(0, 400)} ${fixed.stderr.slice(0, 400)}`);
  } finally { await f.done(); }
});

test('the upgrade\'s local pass removes the upload refs a published sflow/config already holds (CH-F9)', async () => {
  const f = await fixture();
  try {
    const app = f.clone('app', ['-b', 'sflow/config']);
    const landed = tip(f);
    run('git', ['update-ref', `refs/singularity/transport/configuration/${landed}`, landed], { cwd: app });
    // A commit sflow/config does not hold stays: its upload may still be needed.
    run('git', ['commit', '-q', '--allow-empty', '-m', 'not published'], { cwd: app });
    const pending = run('git', ['rev-parse', 'HEAD'], { cwd: app }).stdout.trim();
    run('git', ['update-ref', `refs/singularity/transport/configuration-proposals/${pending}`, pending], { cwd: app });
    const result = pruneLocalSupersededConfigurationRefs([app], f.remote, { configurationCommit: landed, env: f.env });
    assert.equal(result.pruned.transportRefs, 1);
    const left = run('git', ['for-each-ref', '--format=%(refname)', 'refs/singularity/transport'], { cwd: app }).stdout.trim().split('\n');
    assert.deepEqual(left, [`refs/singularity/transport/configuration-proposals/${pending}`]);
  } finally { await f.done(); }
});
