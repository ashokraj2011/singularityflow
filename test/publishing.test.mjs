import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { storyPublicationPending } from '../src/state.mjs';
import { loadDefinition } from '../src/config.mjs';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import {
  capabilityPublicationPlanSha256
} from '../src/capability-publication-recovery.mjs';
import { configuredRemoteFingerprint } from '../src/git-remote-diagnostics.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');
function run(command, args, cwd, { fail = false, actor = 'Publisher' } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: actor, SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env }); if (!fail && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`); return result;
}
function flow(root, args, options) { return run(process.execPath, [bin, ...args], root, options); }

test('failed required push blocks transitions until sync publishes the retained commit', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-push-')); const root = path.join(base, 'repo'); const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base); run('git', ['init', '-b', 'main', root], base); run('git', ['config', 'user.name', 'Publisher'], root); run('git', ['config', 'user.email', 'publisher@example.com'], root); run('git', ['remote', 'add', 'origin', remote], root);
  await writeFile(path.join(root, 'README.md'), '# publish\n'); flow(root, ['init']); const configPath = path.join(root, 'singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8')); config.worldModel.grounding = 'off'; await writeFile(configPath, YAML.stringify(config)); run('git', ['add', '.'], root); run('git', ['commit', '-m', 'init'], root); run('git', ['push', '-u', 'origin', 'main'], root);
  flow(root, ['start', 'PUSH-1', '--from-branch', 'main']); const artifact = path.join(root, 'singularity/work-items/PUSH-1/artifacts/intake/intake.md'); await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete publication recovery evidence for the required remote branch.'));
  const expectedRemoteSha = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const rejectHook = path.join(remote, 'hooks/pre-receive');
  await writeFile(rejectHook, '#!/bin/sh\nexit 1\n');
  await chmod(rejectHook, 0o755);
  const failed = flow(root, ['phase', 'publish', 'intake'], { fail: true }); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /push failed/);
  const pendingRecord = JSON.parse(await readFile(path.join(root, '.git/singularity-flow/pending-publication/story--PUSH-1.json'), 'utf8'));
  assert.equal(pendingRecord.expectedRemoteSha, expectedRemoteSha,
    'ordinary Story updates retain their exact remote parent lease');
  assert.equal(run('git', ['status', '--porcelain'], root).stdout.trim(), '');
  const blocked = flow(root, ['submit'], { fail: true }); assert.equal(blocked.status, 2); assert.match(blocked.stderr, /Out of sequence/); assert.match(blocked.stderr, /Publication is pending/); assert.match(blocked.stderr, /singularity-flow sync/);
  await rm(rejectHook, { force: true });
  const plan = JSON.parse(flow(root, ['recover', 'PUSH-1', '--json']).stdout);
  assert.equal(plan.pendingPublication, true);
  assert.ok(plan.actions.some((entry) => entry.id === 'publish' && entry.automatic));
  const unconfirmed = flow(root, ['recover', 'PUSH-1', '--apply', '--json'], { fail: true });
  assert.equal(unconfirmed.status, 1);
  assert.match(unconfirmed.stderr, /exact reviewed plan hash/);
  const applied = JSON.parse(flow(root, [
    'recover', 'PUSH-1', '--apply', '--confirm', plan.planId, '--json'
  ]).stdout);
  assert.equal(applied.postconditionsMet, true);
  assert.deepEqual(applied.postconditions.map((entry) => entry.id), ['publication-cleared']);
  const local = run('git', ['rev-parse', 'HEAD'], root).stdout.trim(); const published = run('git', ['ls-remote', 'origin', 'refs/heads/PUSH-1'], root).stdout.split(/\s+/)[0]; assert.equal(published, local);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout.trim(), '');
});

test('sync completes an exact pending capability sibling branch publication', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-sync-'));
  const root = path.join(base, 'lead');
  const remote = path.join(base, 'lead.git');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  run('git', ['config', 'user.name', 'Publisher'], root);
  run('git', ['config', 'user.email', 'publisher@example.com'], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  await writeFile(path.join(root, 'README.md'), '# capability sync\n');
  flow(root, ['init']);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'init'], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  flow(root, ['start', 'CAPSYNC-1', '--from-branch', 'main']);
  const siblingRemote = path.join(base, 'sibling.git');
  const sibling = path.join(base, 'sibling');
  run('git', ['init', '--bare', siblingRemote], base);
  run('git', ['init', '-b', 'main', sibling], base);
  run('git', ['config', 'user.name', 'Publisher'], sibling);
  run('git', ['config', 'user.email', 'publisher@example.com'], sibling);
  run('git', ['remote', 'add', 'origin', siblingRemote], sibling);
  run('git', ['commit', '--allow-empty', '-m', 'sibling base'], sibling);
  run('git', ['push', '-u', 'origin', 'main'], sibling);
  run('git', ['switch', '-c', 'CAPSYNC-1'], sibling);
  const siblingCommit = run('git', ['rev-parse', 'HEAD'], sibling).stdout.trim();
  const siblingPublication = {
    schemaVersion: 1, repository: 'sibling', root: sibling, remote: 'origin',
    branch: 'CAPSYNC-1', commit: siblingCommit, destinationRef: 'refs/heads/CAPSYNC-1',
    remoteFingerprint: configuredRemoteFingerprint(sibling, 'origin'),
    expectedRemoteSha: null,
    pushOutcome: 'not-attempted'
  };
  const subject = { kind: 'story', id: 'CAPSYNC-1', branch: 'CAPSYNC-1' };
  const rootExpectedRemoteSha = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  await new GitPublicationUnitOfWork(root).execute({
    subject,
    event: lifecycleEvent({
      type: 'binding', subject,
      payload: { capabilityPublicationPlanSha256: capabilityPublicationPlanSha256([siblingPublication]) }
    }),
    commit: { message: '[CAPSYNC-1] retain authenticated sibling publication' },
    publication: {
      mode: 'required', remote: 'origin', branch: 'CAPSYNC-1',
      expectedRemoteSha: rootExpectedRemoteSha
    },
    allowedPaths: ['capability-tail.json'],
    state: { write: () => writeFile(path.join(root, 'capability-tail.json'), '{"pending":true}\n') },
    pendingMetadata: {
      recoveryStage: 'capability-publication-pending',
      capabilityPublicationPlan: [siblingPublication],
      capabilityPublications: [siblingPublication],
      error: 'Capability Story branch publication is in progress.'
    },
    retainPendingOnSuccess: true
  });
  const siblingRejectHook = path.join(siblingRemote, 'hooks/pre-receive');
  await writeFile(siblingRejectHook, '#!/bin/sh\nexit 1\n');
  await chmod(siblingRejectHook, 0o755);
  const failed = flow(root, ['sync'], { fail: true });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Capability Story publication still fails for 'sibling'/);

  await rm(siblingRejectHook, { force: true });
  flow(root, ['sync']);
  assert.equal(
    run('git', ['ls-remote', siblingRemote, 'refs/heads/CAPSYNC-1'], sibling).stdout.split(/\s+/)[0],
    siblingCommit
  );
  assert.equal(await storyPublicationPending(root, await loadDefinition(root), 'CAPSYNC-1'), false);
});

test('every approval creates and pushes its own atomic decision commit', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-approval-push-'));
  const root = path.join(base, 'repo'); const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  run('git', ['config', 'user.name', 'Publisher'], root);
  run('git', ['config', 'user.email', 'publisher@example.com'], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  await writeFile(path.join(root, 'README.md'), '# approval publication\n');
  flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8')); config.worldModel.grounding = 'off';
  config.approvalAuthorities['product-approvers'].members = [{
    name: 'Independent Reviewer', email: 'independent.reviewer@example.com'
  }];
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', '.'], root); run('git', ['commit', '-m', 'init'], root); run('git', ['push', '-u', 'origin', 'main'], root);

  flow(root, ['start', 'APPROVAL-1', '--from-branch', 'main']);
  const artifact = path.join(root, 'singularity/work-items/APPROVAL-1/artifacts/intake/intake.md');
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete independently reviewable approval publication evidence and scope.'));
  flow(root, ['phase', 'publish', 'intake']);
  flow(root, ['submit']);
  const approval = flow(root, ['next', '--yes'], { actor: 'Independent Reviewer' });
  // The command leads; the Copilot skill is the note under it.
  assert.match(approval.stdout, /Run: singularity-flow approve intake --work-id APPROVAL-1 --fetch/);
  assert.match(approval.stdout, /In Copilot: \/sf-approve intake/);
  assert.match(approval.stdout, /Approval decision committed [0-9a-f]{8} and pushed to origin\/APPROVAL-1/);

  const local = run('git', ['rev-parse', 'HEAD'], root).stdout.trim();
  const published = run('git', ['ls-remote', 'origin', 'refs/heads/APPROVAL-1'], root).stdout.split(/\s+/)[0];
  assert.equal(published, local);
  const subject = run('git', ['--git-dir', remote, 'log', '-1', '--format=%s', 'refs/heads/APPROVAL-1'], base).stdout.trim();
  assert.equal(subject, '[APPROVAL-1][phase:intake][approve] product-approvers');
});
