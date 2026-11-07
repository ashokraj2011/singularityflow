import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { run } from '../src/util.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { createGitCompatibilityAdapter } from '../src/sda/git-compatibility-adapter.mjs';
import { configurationReadRoot } from '../src/configuration-read-scope.mjs';
import { CONFIGURATION_STATE_PATH, readConfigurationState } from '../src/configuration-state-contract.mjs';
import { inspectWorkflowConfigurationProposal, listWorkflowConfigurationProposals,
  configurationTransactions } from '../src/configuration-proposal.mjs';
import { withApprovedConfigurationRead, withRepositoryConfigurationCommitRead } from '../src/approved-configuration-reader.mjs';

const scope = Object.freeze({ projectId: 'configuration-project' });
const workflowPath = 'singularity/workflow.yml';
const git = (cwd, args) => run('git', args, { cwd }).stdout;

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-git-compat-config-'));
  t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(parent, 'story');
  const remote = path.join(parent, 'remote.git');
  run('git', ['init', '-q', '-b', 'main', root]);
  git(root, ['config', 'user.name', 'Configuration Reviewer']);
  git(root, ['config', 'user.email', 'reviewer@example.test']);
  await initializeDefinition(root);
  await writeFile(path.join(root, 'app.txt'), 'Original application\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'fixture baseline']);
  run('git', ['init', '-q', '--bare', remote]);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowFilter', 'true']);
  run('git', ['--git-dir', remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config']);
  git(root, ['switch', '-q', '-c', 'STORY-1']);
  const originalCommit = git(root, ['rev-parse', 'HEAD']).trim();
  const adapter = createGitCompatibilityAdapter({ root, scope });
  const config = await adapter.open(scope, { namespace: 'config', role: 'configuration' });
  const read = async () => readFile(path.join(configurationReadRoot(root), workflowPath), 'utf8');
  return { root, remote, originalCommit, config, read,
    remoteText: relative => run('git', ['--git-dir', remote, 'show', `sflow/config:${relative}`]).stdout };
}

function change(label) {
  return { operation: 'edit-workflow', subject: 'spec-driven-standard', async mutate(root) {
    const file = path.join(root, workflowPath);
    const definition = YAML.parse(await readFile(file, 'utf8'));
    definition.workTypes['spec-driven-standard'].label = label;
    await writeFile(file, YAML.stringify(definition));
    return { id: 'spec-driven-standard' };
  } };
}

test('configuration compatibility preserves exact reads, reviewed authority, transactions and dirty application work', async t => {
  const f = await fixture(t);
  const { root, config, read, originalCommit } = f;
  const before = f.remoteText(workflowPath);
  assert.equal(await config.withRead(read), await withApprovedConfigurationRead(root, read));
  assert.equal(await config.withCommitRead({ commit: originalCommit }, read),
    await withRepositoryConfigurationCommitRead(root, { commit: originalCommit }, read));
  const proposal = await config.propose(change('Reviewed through compatibility'));
  assert.equal(f.remoteText(workflowPath), before, 'proposing never activates configuration');
  assert.deepEqual(await config.inspectProposal(proposal.branch), await inspectWorkflowConfigurationProposal(root, proposal.branch));
  assert.deepEqual(await config.listProposals(), await listWorkflowConfigurationProposals(root));

  await writeFile(path.join(root, 'app.txt'), 'Staged work\n');
  git(root, ['add', 'app.txt']);
  await writeFile(path.join(root, 'app.txt'), 'Unstaged work\n');
  const status = git(root, ['status', '--porcelain=v1']);
  for (const options of [{ confirm: originalCommit, acknowledgeUnprotected: true }, { confirm: proposal.commit }]) {
    await assert.rejects(config.activateProposal(proposal.branch, options), error => {
      const expected = options.acknowledgeUnprotected
        ? 'WORKFLOW_PROPOSAL_CONFIRMATION_MISMATCH' : 'WORKFLOW_CONFIGURATION_UNPROTECTED';
      return error.code === expected && error.details.nextAction.includes(proposal.commit);
    });
    assert.equal(f.remoteText(workflowPath), before, 'a refused review cannot advance authority');
    assert.equal(git(root, ['status', '--porcelain=v1']), status);
  }

  const activated = await config.activateProposal(proposal.branch, {
    confirm: proposal.commit, acknowledgeUnprotected: true
  });
  assert.equal(activated.activated, true);
  assert.equal(activated.activationMethod, 'semantic-transaction');
  const state = readConfigurationState(f.remoteText(CONFIGURATION_STATE_PATH));
  assert.equal(state.transactions[0].proposalRevision, proposal.commit);
  assert.equal(YAML.parse(f.remoteText(workflowPath)).workTypes['spec-driven-standard'].label,
    'Reviewed through compatibility');
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), originalCommit, 'the Story checkout is not switched or repinned');
  assert.equal(git(root, ['status', '--porcelain=v1']), status);
  assert.equal(git(root, ['show', ':app.txt']), 'Staged work\n');
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'Unstaged work\n');
  assert.equal(await config.withRead(read), before, 'existing Story configuration still reads its working-tree pin');
  assert.equal(await config.withCommitRead({ commit: originalCommit }, read), before,
    'an immutable configuration commit keeps its exact bytes after activation');
  const authorityOptions = { preferAuthority: true, freshOwnerCapture: true };
  assert.equal(await config.withRead(read, authorityOptions), await withApprovedConfigurationRead(root, read, authorityOptions));
  assert.equal(await config.withRead(read, authorityOptions), f.remoteText(workflowPath));
  const retained = await config.transactions();
  assert.deepEqual(retained, await configurationTransactions(root));
  assert.equal(retained.authorityEligible, false);
  assert.equal(retained.transactions.length, 1);
  assert.equal((await config.reconcileTransaction(retained.transactions[0].transaction.id)).activated, true);
});

test('configuration owner input and recovery errors retain their original code and details', async t => {
  const { config } = await fixture(t);
  await assert.rejects(config.propose({ operation: 'edit-workflow', subject: 'test' }),
    { code: 'CONFIGURATION_PROPOSAL_MUTATION_REQUIRED' });
  await assert.rejects(config.withCommitRead({ commit: 'not-a-revision' }, () => null),
    { code: 'STORY_BASE_INVALID' });
  await assert.rejects(config.reconcileTransaction('not-retained'), { code: 'CONFIGURATION_TRANSACTION_UNKNOWN' });
});
