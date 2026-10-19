import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { lifecycleEvent } from '../src/lifecycle-event.mjs';
import { GitPublicationUnitOfWork } from '../src/publication-unit-of-work.mjs';
import { readPendingPublication } from '../src/publication-pending.mjs';
import { syncPublication } from '../src/state.mjs';
import { publicationPushRefusal } from '../src/publication-retry-refusals.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';

const config = { git: { remote: 'origin' }, ledger: { enabled: false } };

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

async function installHook(remote, script) {
  const hook = path.join(remote, 'hooks/pre-receive');
  await writeFile(hook, `#!/bin/sh\n${script}\n`);
  await chmod(hook, 0o755);
  return () => rm(hook, { force: true });
}

function storyFor(subject) {
  return {
    workItem: { id: subject.id, branch: subject.branch },
    lineage: { canonicalBranch: subject.branch, childBranches: [] },
    resolution: { ledger: { enabled: false } }
  };
}

/** A Story commit the remote refused, retained behind its sealed pending marker. */
async function retained(t, id) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-retry-refusal-'));
  const remote = await mkdtemp(path.join(os.tmpdir(), 'sflow-retry-refusal-origin-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  git(['init', '-b', 'main'], root);
  git(['config', 'user.name', 'Retry Refusal'], root);
  git(['config', 'user.email', 'retry-refusal@example.invalid'], root);
  await writeFile(path.join(root, 'README.md'), '# retry refusal\n');
  git(['add', '.'], root);
  git(['commit', '-m', 'initial'], root);
  git(['init', '--bare', '-q'], remote);
  git(['remote', 'add', 'origin', remote], root);
  git(['push', '-u', 'origin', 'main'], root);
  const subject = { kind: 'story', id, branch: 'main' };
  const baseline = git(['--git-dir', remote, 'rev-parse', 'refs/heads/main'], root);
  const allow = await installHook(remote, 'exit 1');
  await assert.rejects(() => new GitPublicationUnitOfWork(root).execute({
    subject,
    event: lifecycleEvent({ type: 'artifact-generated', subject, phaseId: 'intake', generation: 1 }),
    commit: { message: `[${id}] retained exact publication` },
    publication: { mode: 'required', branch: 'main', remote: 'origin', expectedRemoteSha: baseline },
    allowedPaths: ['story-state.json'],
    state: { write: () => writeFile(path.join(root, 'story-state.json'), '{"status":"pending"}\n') }
  }), /retained locally but push failed/);
  await allow();
  const pending = await readPendingPublication(root, subject);
  return { root, remote, subject, baseline, marker: structuredClone(pending.record) };
}

test('a push-protection refusal names the manual repair first and offers sync only after it', async (t) => {
  const fixture = await retained(t, 'RETRY-POLICY-1');
  await installHook(fixture.remote, [
    'echo "GH013: Repository rule violations found for refs/heads/main." >&2',
    'echo "- Push cannot contain secrets" >&2',
    'exit 1'
  ].join('\n'));
  const error = await syncPublication(fixture.root, config, storyFor(fixture.subject)).then(
    () => assert.fail('the refused commit must not publish'), (failure) => failure
  );
  assert.equal(error.code, 'PUBLICATION_PUSH_FAILED');
  assert.match(error.message, /^Push still fails: .*GH013: Repository rule violations found/u);
  assert.match(error.message, /sending it again fails the same way/u);
  assert.equal(error.details.remoteFailure.classification, 'policy-rejected');
  assert.equal(error.details.retryable, false);
  assert.equal(error.details.commit, fixture.marker.commit);
  assert.deepEqual(error.details.recoveryCommands.map((entry) => entry.command), [
    'singularity-flow recover RETRY-POLICY-1', 'singularity-flow sync RETRY-POLICY-1'
  ]);
  assert.match(error.details.recoveryCommands[1].label, /Only after the provider accepts this exact commit/u);
  assert.match(error.details.actions[0].label, /flagged secret/u);

  // The plan every surface renders puts the person's repair before the retry.
  const plan = refusalRemediationPlan(error, ['sync', 'RETRY-POLICY-1']);
  const ids = plan.steps.map((entry) => entry.command ?? entry.label);
  const repair = ids.findIndex((entry) => /flagged secret/u.test(entry));
  const retry = ids.indexOf('singularity-flow sync RETRY-POLICY-1');
  assert.ok(repair >= 0 && (retry === -1 || repair < retry), JSON.stringify(ids));

  const pending = await readPendingPublication(fixture.root, fixture.subject);
  assert.equal(pending.record.pushOutcome, 'rejected');
  assert.equal(git(['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/main'], fixture.root), fixture.baseline);
});

test('a transient push failure keeps the retry first', () => {
  const error = publicationPushRefusal({
    result: { status: 128, stderr: 'fatal: unable to access: Could not resolve host: git.example.invalid' },
    outcome: 'rejected', subject: { kind: 'story', id: 'RETRY-NET-1' },
    retryCommand: 'singularity-flow sync RETRY-NET-1', inspectCommand: 'singularity-flow recover RETRY-NET-1'
  });
  assert.equal(error.code, 'PUBLICATION_PUSH_FAILED');
  assert.equal(error.details.retryable, true);
  assert.equal(error.details.remoteFailure.classification, 'network-transient');
  assert.deepEqual(error.details.recoveryCommands.map((entry) => entry.command), ['singularity-flow sync RETRY-NET-1']);
  assert.equal(error.details.actions, undefined);
});

test('a remote moved to a new URL is named and rebinds only with its exact confirmation', async (t) => {
  const fixture = await retained(t, 'RETRY-REBIND-1');
  // The same repository under a different spelling, as an HTTPS-to-SSH move is.
  const moved = `file://${fixture.remote}`;
  git(['remote', 'set-url', 'origin', moved], fixture.root);
  git(['remote', 'add', 'previous', fixture.remote], fixture.root);

  const refused = await syncPublication(fixture.root, config, storyFor(fixture.subject)).then(
    () => assert.fail('a changed remote must not receive the commit unconfirmed'), (failure) => failure
  );
  assert.equal(refused.code, 'PENDING_PUBLICATION_REMOTE_CHANGED');
  assert.match(refused.message, /publication remote 'origin' changed after the commit was retained/u);
  assert.ok(refused.message.includes(`now points to ${moved}`), refused.message);
  assert.match(refused.message, /still configured as remote 'previous'/u);
  const change = refused.details.remoteChange;
  assert.equal(change.change, 'url-changed');
  assert.equal(change.matchingRemote, 'previous');
  assert.match(change.rebindConfirmation, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(refused.details.recoveryCommands.map((entry) => entry.command), [
    `singularity-flow sync RETRY-REBIND-1 --rebind-remote ${change.rebindConfirmation}`
  ]);
  assert.equal(git(['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/main'], fixture.root), fixture.baseline);

  const stale = await syncPublication(fixture.root, config, storyFor(fixture.subject), {
    rebindRemote: `sha256:${'0'.repeat(64)}`
  }).then(() => assert.fail('a wrong confirmation must not rebind'), (failure) => failure);
  assert.equal(stale.code, 'PENDING_PUBLICATION_REMOTE_CHANGED');
  assert.match(stale.message, /does not match this marker and remote/u);
  assert.equal((await readPendingPublication(fixture.root, fixture.subject)).record.remoteFingerprint,
    fixture.marker.remoteFingerprint);

  const synced = await syncPublication(fixture.root, config, storyFor(fixture.subject), {
    rebindRemote: change.rebindConfirmation
  });
  assert.equal(synced.pushed, fixture.marker.commit);
  assert.equal(git(['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/main'], fixture.root), fixture.marker.commit);
  assert.equal(await readPendingPublication(fixture.root, fixture.subject), null);
});

test('an unsealed marker names the remote change but offers no rebind', async (t) => {
  const fixture = await retained(t, 'RETRY-UNSEALED-1');
  const pending = await readPendingPublication(fixture.root, fixture.subject);
  const raw = JSON.parse(await readFile(pending.path, 'utf8'));
  raw.createdAt = '2026-01-01T00:00:00.000Z';
  await writeFile(pending.path, `${JSON.stringify(raw, null, 2)}\n`);
  git(['remote', 'set-url', 'origin', `file://${fixture.remote}`], fixture.root);
  const refused = await syncPublication(fixture.root, config, storyFor(fixture.subject)).then(
    () => assert.fail('an unsealed marker must not publish to a changed remote'), (failure) => failure
  );
  assert.equal(refused.code, 'PENDING_PUBLICATION_REMOTE_CHANGED');
  assert.deepEqual(refused.details.recoveryCommands, []);
  assert.equal(refused.details.remoteChange.rebindConfirmation, null);
  assert.match(refused.details.actions[0].label, /Point 'origin' back at the URL/u);
  assert.equal(git(['--git-dir', fixture.remote, 'rev-parse', 'refs/heads/main'], fixture.root), fixture.baseline);
});
