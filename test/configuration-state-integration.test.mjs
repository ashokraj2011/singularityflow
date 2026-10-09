import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, mkdir, chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { run } from '../src/util.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { proposeConfigurationChange, activateWorkflowConfigurationProposal,
  listWorkflowConfigurationProposals, configurationTransactions, reconcileConfigurationTransaction } from '../src/configuration-proposal.mjs';
import { CONFIGURATION_STATE_PATH, readConfigurationState } from '../src/configuration-state-contract.mjs';
import { remoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { saveConfigurationFile, deleteConfigurationFile } from '../src/editor.mjs';
import { openConfigurationStateService } from '../src/configuration-state-service.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-state-integration-'));
  const seed = path.join(base, 'seed'), remote = path.join(base, 'remote.git'), story = path.join(base, 'story');
  run('git', ['init', '-q', '-b', 'main', seed]);
  run('git', ['config', 'user.name', 'Config Author'], { cwd: seed });
  run('git', ['config', 'user.email', 'config@example.test'], { cwd: seed });
  await initializeDefinition(seed);
  await writeFile(path.join(seed, 'app.txt'), 'User application bytes\n');
  run('git', ['add', '-A'], { cwd: seed });
  run('git', ['commit', '-qm', 'baseline'], { cwd: seed });
  run('git', ['init', '-q', '--bare', remote]);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true']);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  run('git', ['remote', 'add', 'origin', remote], { cwd: seed });
  run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], { cwd: seed });
  run('git', ['clone', '-q', '-b', 'sflow/config', remote, story]);
  run('git', ['config', 'user.name', 'Config Author'], { cwd: story });
  run('git', ['config', 'user.email', 'config@example.test'], { cwd: story });
  const env = { ...process.env, NODE_ENV: 'test', NO_COLOR: '1',
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json') };
  return { base, seed, remote, story, env };
}
async function propose(f, label, phase = 'spec-driven-standard') {
  return proposeConfigurationChange(f.story, { operation: 'edit-workflow', subject: phase,
    async mutate(root) {
      const file = path.join(root, 'singularity/workflow.yml');
      const definition = YAML.parse(await readFile(file, 'utf8'));
      definition.workTypes[phase].label = label;
      await writeFile(file, YAML.stringify(definition));
      return { id: phase };
    }
  }, { env: f.env });
}
function remoteText(f, relative) { return run('git', ['--git-dir', f.remote, 'show', `sflow/config:${relative}`]).stdout; }
const activate = (f, proposal) => activateWorkflowConfigurationProposal(f.story, proposal.branch, { confirm: proposal.commit, acknowledgeUnprotected: true });

test('two saves on the same base are immutable revisions of one stable proposal entity', async () => {
  const f = await fixture();
  try {
    const a = await propose(f, 'Revision one'), b = await propose(f, 'Revision two');
    assert.equal(a.proposalId, b.proposalId);
    assert.notEqual(a.branch, b.branch);
    const again = await propose(f, 'Revision two');
    assert.equal(again.commit, b.commit);
    const rows = await listWorkflowConfigurationProposals(f.story);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].proposalId, rows[1].proposalId);
    assert.deepEqual(await listWorkflowConfigurationProposals(f.story), rows, 'exact advertised snapshot is served from SQLite');
    const outcome = await activate(f, b);
    assert.equal(outcome.activated, true);
    assert.equal(outcome.activationMethod, 'semantic-transaction');
    const state = readConfigurationState(remoteText(f, CONFIGURATION_STATE_PATH));
    assert.equal(state.transactions[0].proposalId, b.proposalId);
    assert.equal(state.transactions[0].proposalRevision, b.commit);
    await assert.rejects(() => activate(f, a), error => error.code === 'CONFIGURATION_ENTITY_CONFLICT');
    assert.equal(YAML.parse(remoteText(f, 'singularity/workflow.yml')).workTypes['spec-driven-standard'].label, 'Revision two');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('adjacent unrelated workflow edits activate without Git merges, preserving dirty app bytes and index', async () => {
  const f = await fixture();
  try {
    const a = await propose(f, 'Reviewed specification'), b = await propose(f, 'Reviewed feature', 'feature');
    await writeFile(path.join(f.story, 'app.txt'), 'Uncommitted user work\n');
    run('git', ['add', 'app.txt'], { cwd: f.story });
    await writeFile(path.join(f.story, 'app.txt'), 'More uncommitted user work\n');
    const before = run('git', ['status', '--porcelain=v1'], { cwd: f.story }).stdout;
    await activate(f, b);
    const result = await activate(f, a);
    assert.equal(result.activated, true);
    const definition = YAML.parse(remoteText(f, 'singularity/workflow.yml'));
    assert.equal(definition.workTypes.feature.label, 'Reviewed feature');
    assert.equal(definition.workTypes['spec-driven-standard'].label, 'Reviewed specification');
    assert.equal(readConfigurationState(remoteText(f, CONFIGURATION_STATE_PATH)).revision, 2);
    assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: f.story }).stdout, before);
    assert.equal(await readFile(path.join(f.story, 'app.txt'), 'utf8'), 'More uncommitted user work\n');
    assert.equal(run('git', ['show', ':app.txt'], { cwd: f.story }).stdout, 'Uncommitted user work\n');
    const journal = await configurationTransactions(f.story);
    assert.equal(journal.authorityEligible, false);
    assert.equal(journal.transactions.length, 2);
    assert.equal(journal.transactions.every(row => ['synced', 'sync-pending'].includes(row.state)), true);
    const reconciled = await reconcileConfigurationTransaction(f.story, journal.transactions[0].transaction.id);
    assert.equal(reconciled.activated, true, 'a later authority commit still includes the earlier exact candidate');
    const anotherLocalStore = await openConfigurationStateService(f.seed, f.remote);
    await anotherLocalStore.prepare(journal.transactions[0].transaction, 'f'.repeat(40));
    const wrongCandidate = await reconcileConfigurationTransaction(f.seed, journal.transactions[0].transaction.id);
    assert.equal(wrongCandidate.status, 'not-confirmed', 'a matching receipt and reviewed ancestry cannot prove a different local candidate');
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('kernel transaction receipts cannot be authored in a proposal', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => proposeConfigurationChange(f.story, { operation: 'forge', subject: 'receipt', async mutate(root) {
      await writeFile(path.join(root, CONFIGURATION_STATE_PATH), JSON.stringify({ format: 'sflow.configuration-state', version: 1, revision: 0, transactions: [] }));
      return {};
    } }, { env: f.env }), error => error.code === 'CONFIGURATION_PROPOSAL_SCOPE_INVALID');
    for (const relative of [CONFIGURATION_STATE_PATH, 'Singularity/Configuration-Transactions.json']) {
      await assert.rejects(() => saveConfigurationFile(f.story, relative, '{}'), error => error.code === 'CONFIGURATION_STATE_PROTECTED');
      await assert.rejects(() => deleteConfigurationFile(f.story, relative), error => error.code === 'CONFIGURATION_STATE_PROTECTED');
    }
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('another reviewer installing the exact proposal resolves the earlier pending attempt honestly', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const proposal = await propose(f, 'One intent, two reviewers');
    const hook = path.join(f.remote, 'hooks/pre-receive');
    await writeFile(hook, '#!/bin/sh\nexit 1\n');
    await chmod(hook, 0o755);
    const first = await activate(f, proposal);
    assert.equal(first.activated, false);
    await rm(hook);
    run('git', ['config', 'user.name', 'Other Reviewer'], { cwd: f.story });
    run('git', ['config', 'user.email', 'other@example.test'], { cwd: f.story });
    const second = await activate(f, proposal);
    assert.equal(second.activated, true);
    assert.notEqual(first.transactionId, second.transactionId);
    const reconciled = await reconcileConfigurationTransaction(f.story, first.transactionId);
    assert.equal(reconciled.status, 'superseded');
    assert.equal(reconciled.activated, false, 'the first candidate was not installed');
    assert.equal(reconciled.proposalInstalled, true);
    assert.equal(reconciled.installedTransactionId, second.transactionId);
    const journal = await configurationTransactions(f.story);
    assert.equal(journal.transactions.find(row => row.transaction.id === first.transactionId).state, 'superseded');
    assert.equal(readConfigurationState(remoteText(f, CONFIGURATION_STATE_PATH)).revision, 1);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

for (const position of ['before', 'after']) {
  test(`interruption ${position} the exact push preserves a resumable operation without an invented approval`, { skip: process.platform === 'win32' }, async () => {
    const f = await fixture();
    try {
      const proposal = await propose(f, 'Interrupted activation');
      const realGit = run('which', ['git']).stdout.trim();
      const wrappers = path.join(f.base, 'wrappers');
      await mkdir(wrappers);
      const wrapper = path.join(wrappers, 'git');
      await writeFile(wrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const isPush = args[0] === 'push' && args.includes('HEAD:refs/heads/sflow/config');
if (isPush && ${JSON.stringify(position)} === 'before') { process.kill(process.ppid, 'SIGKILL'); process.exit(1); }
const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
if (isPush && ${JSON.stringify(position)} === 'after' && result.status === 0) { process.kill(process.ppid, 'SIGKILL'); process.exit(1); }
process.exit(result.status == null ? 1 : result.status);
`);
      await chmod(wrapper, 0o755);
      const interrupted = spawnSync(process.execPath, [cli, 'workflow', 'activate', proposal.branch, '--confirm', proposal.commit, '--acknowledge-unprotected', '--json'],
        // Bound the whole fixture, including Node-wrapper startup on a loaded host; individual
        // production Git operations retain their own short deadlines.
        { cwd: f.story, encoding: 'utf8', timeout: 90_000, env: { ...f.env, PATH: `${wrappers}${path.delimiter}${f.env.PATH}` } });
      assert.equal(interrupted.signal, 'SIGKILL', interrupted.stderr);
      const journal = await configurationTransactions(f.story);
      assert.equal(journal.transactions.length, 1);
      const retained = journal.transactions[0];
      assert.equal(retained.state, 'prepared');
      const reconciled = await reconcileConfigurationTransaction(f.story, retained.transaction.id);
      if (position === 'before') {
        assert.equal(reconciled.status, 'not-confirmed');
        assert.equal(reconciled.automaticRetry, false);
        const resumed = await activate(f, proposal);
        assert.equal(resumed.targetCommit, retained.targetCommit, 'the exact candidate is reconstructed, not a new blind attempt');
      } else {
        assert.equal(reconciled.activated, true);
        assert.ok(['synced', 'sync-pending'].includes(reconciled.status));
      }
      assert.equal(readConfigurationState(remoteText(f, CONFIGURATION_STATE_PATH)).revision, 1);
      assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: f.story }).stdout, '');
    } finally { await rm(f.base, { recursive: true, force: true }); }
  });
}

test('a journal write refusal after a verified push discloses recovery without hiding activation', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture();
  try {
    const proposal = await propose(f, 'Retained despite journal refusal');
    const realGit = run('which', ['git']).stdout.trim();
    const wrappers = path.join(f.base, 'wrappers');
    await mkdir(wrappers);
    const wrapper = path.join(wrappers, 'git');
    const lock = path.join(f.story, '.git/singularity-flow/configuration-service', remoteFingerprint(f.remote), 'transactions/writer.lock');
    await writeFile(wrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const result = spawnSync(${JSON.stringify(realGit)}, args, { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
if (result.status === 0 && args[0] === 'push' && args.includes('HEAD:refs/heads/sflow/config')) {
  writeFileSync(${JSON.stringify(lock)}, JSON.stringify({ pid: process.ppid, nonce: 'held-during-activation', createdAtMs: Date.now() }));
}
process.exit(result.status == null ? 1 : result.status);
`);
    await chmod(wrapper, 0o755);
    const completed = spawnSync(process.execPath, [cli, 'workflow', 'activate', proposal.branch, '--confirm', proposal.commit, '--acknowledge-unprotected', '--json'],
      { cwd: f.story, encoding: 'utf8', timeout: 90_000, env: { ...f.env, PATH: `${wrappers}${path.delimiter}${f.env.PATH}` } });
    assert.equal(completed.status, 0, completed.stderr);
    const result = JSON.parse(completed.stdout);
    assert.equal(result.activated, true);
    assert.equal(result.journalWarning.code, 'SGOS_OPERATIONAL_STORE_LOCK_TIMEOUT');
    assert.match(result.nextAction, /^singularity-flow configuration reconcile cft-/u);
    assert.equal(readConfigurationState(remoteText(f, CONFIGURATION_STATE_PATH)).revision, 1);
    await rm(lock);
    const reconciled = await reconcileConfigurationTransaction(f.story, result.transactionId);
    assert.ok(['synced', 'sync-pending'].includes(reconciled.status));
    assert.equal(reconciled.activated, true);
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
