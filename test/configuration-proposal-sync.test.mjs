import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createTransportIntent, readTransportIntent } from '../src/transport-intents.mjs';
import { startConfigurationProposalSync, syncConfigurationProposal } from '../src/configuration-proposal-sync.mjs';
import { run } from '../src/util.mjs';

test('background sync uploads only the retained create-only proposal, never authority or a changed remote', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-proposal-sync-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'), remote = path.join(base, 'remote.git');
  const env = { ...process.env, SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox') };
  run('git', ['init', '-q', '-b', 'main', root]); run('git', ['init', '-q', '--bare', remote]);
  run('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  run('git', ['config', 'user.email', 'fixture@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), 'retained proposal\n');
  run('git', ['add', '.'], { cwd: root }); run('git', ['commit', '-qm', 'base'], { cwd: root });
  run('git', ['remote', 'add', 'origin', remote], { cwd: root });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  const requiredLocalRef = `refs/singularity/transport/configuration-proposals/${sourceCommit}`;
  run('git', ['update-ref', requiredLocalRef, sourceCommit], { cwd: root });
  const input = { repositoryRoot: root, sourceCommit,
    targetRef: 'refs/heads/sflow/config-change/workflow/background-test',
    scope: { operation: 'sflow.configuration.workflow.test', requiredLocalRef } };
  const pending = await createTransportIntent(input, { env });
  assert.equal(pending.status, 'pending');
  assert.equal(run('git', ['--git-dir', remote, 'show-ref'], { allowFailure: true }).status, 1);
  assert.equal(await startConfigurationProposalSync(pending.intentId, { env: { ...env,
    SINGULARITY_FLOW_CONFIGURATION_BACKGROUND_SYNC: 'off' } }), false);
  assert.equal(await startConfigurationProposalSync(pending.intentId, { env }), true);
  let result;
  for (let attempt = 0; attempt < 200; attempt++) {
    result = await readTransportIntent(pending.intentId, { env });
    if (result.status === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(result.status, 'succeeded');
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', input.targetRef]).stdout.trim(), sourceCommit);
  assert.equal((await syncConfigurationProposal(pending.intentId, { env })).status, 'succeeded');
  const authority = await createTransportIntent({ ...input, targetRef: 'refs/heads/sflow/config' }, { env });
  await assert.rejects(syncConfigurationProposal(authority.intentId, { env }), error => error.code === 'CONFIGURATION_BACKGROUND_SYNC_SCOPE');
  const changed = await createTransportIntent({ ...input, targetRef: input.targetRef + '-changed' }, { env });
  run('git', ['remote', 'set-url', 'origin', path.join(base, 'different.git')], { cwd: root });
  await assert.rejects(syncConfigurationProposal(changed.intentId, { env }), error => error.code === 'TRANSPORT_REMOTE_DRIFTED');
  assert.equal((await readTransportIntent(changed.intentId, { env })).status, 'pending');
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, '');
});
