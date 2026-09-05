import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { run } from '../src/util.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { normalizeLedgerConfig } from '../src/ledger-config.mjs';
import {
  appendLedgerIntent,
  archiveLedger,
  canonicalJson,
  createLedgerIntent,
  initializeLedger,
  isStateBranchConcurrencyFailure,
  ledgerDoctor,
  ledgerLog,
  ledgerShow,
  ledgerStatus,
  materializeStateBranchPublicationAuthority,
  persistLedgerIntent,
  publishToStateBranch,
  reconcileLedger,
  repairLedgerPins,
  sha256,
  verifyLedger
} from '../src/ledger.mjs';

function git(root, args) {
  return run('git', args, { cwd: root });
}

test('Git incorrect-old-value lease rejections are classified as concurrent publication', () => {
  assert.equal(isStateBranchConcurrencyFailure(
    "! [remote rejected] HEAD -> state (incorrect old value provided)"
  ), true);
  assert.equal(isStateBranchConcurrencyFailure('authentication failed'), false);
});

async function repository() {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-ledger-test-'));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  await mkdir(root);
  run('git', ['init', '--bare', remote]);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Ledger Tester']);
  git(root, ['config', 'user.email', 'ledger@example.com']);
  await writeFile(path.join(root, 'README.md'), '# application\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'application root']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-u', 'origin', 'main']);
  return { parent, remote, root };
}

const enabled = {
  enabled: true,
  branch: 'state',
  remote: 'origin',
  behind: 'block',
  enforcement: 'shadow',
  signing: 'off',
  trustTier: 'T0',
  maxRetries: 3
};

test('ledger configuration is opt-in and rejects dishonest signed trust tiers', () => {
  assert.equal(normalizeLedgerConfig().enabled, false);
  assert.equal(normalizeLedgerConfig().branch, 'state');
  assert.equal(normalizeLedgerConfig().publication, 'warn');
  assert.throws(() => normalizeLedgerConfig({ publication: 'sometimes' }), /off, warn, or required/);
  assert.throws(() => normalizeLedgerConfig({ enabled: true, trustTier: 'T2' }), /requires ledger.signing/);
  assert.throws(() => normalizeLedgerConfig({ behind: 'continue' }), /warn or block/);
});

test('canonical ledger JSON is stable across object key order', () => {
  const left = canonicalJson({ z: 1, a: { y: 2, b: 3 } });
  const right = canonicalJson({ a: { b: 3, y: 2 }, z: 1 });
  assert.equal(left, right);
  assert.equal(sha256(left), sha256(right));
});

test('ledger status performs one asynchronous remote refresh and keeps nested reads cache-only', async () => {
  const { root } = await repository();
  await initializeLedger(root, enabled);
  const timer = commandTimer('ledger-status', { commandClass: 'read' });
  const status = await withCommandTiming(timer, () => ledgerStatus(root, enabled));
  assert.equal(status.initialized, true);
  assert.equal(status.remoteView, 'refreshed');
  const counters = timer.finish().counters;
  assert.equal(counters['git.remote.command.fetch'], 1);
  assert.equal(counters['git.remote.total'], 1);
});

test('capability ledger is an orphan branch and verifies its content-addressed chain', async () => {
  const { root } = await repository();
  const initialized = await initializeLedger(root, enabled);
  assert.equal(initialized.created, true);
  assert.match(git(root, ['config', '--get-all', 'remote.origin.fetch']).stdout, /refs\/singularity\/pins/);
  const doctor = await ledgerDoctor(root, enabled);
  assert.equal(doctor.valid, true);
  assert.equal(doctor.checks.find((check) => check.id === 'orphan').status, 'pass');
  run('git', ['fetch', 'origin', 'state:refs/remotes/origin/state'], { cwd: root });
  const mergeBase = run('git', ['merge-base', 'main', 'origin/state'], { cwd: root, allowFailure: true });
  assert.notEqual(mergeBase.status, 0);

  const intent = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-1',
    subject: { workId: 'WORK-1', phase: 'design', generation: 1 },
    actor: { name: 'Reviewer', email: 'reviewer@example.com' },
    workingLens: 'architect',
    authorityGroup: 'architecture-reviewers',
    payload: { bundleHash: 'a'.repeat(64) }
  });
  const appended = await appendLedgerIntent(root, enabled, intent, git(root, ['rev-parse', 'HEAD']).stdout.trim());
  assert.equal(appended.sequence, 1);
  const duplicate = await appendLedgerIntent(root, enabled, intent, git(root, ['rev-parse', 'HEAD']).stdout.trim());
  assert.equal(duplicate.duplicate, true);
  const sameOperation = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-1',
    subject: { workId: 'WORK-1', phase: 'design', generation: 1 },
    actor: { name: 'Reviewer', email: 'reviewer@example.com' }
  });
  const idempotent = await appendLedgerIntent(root, enabled, sameOperation, git(root, ['rev-parse', 'HEAD']).stdout.trim());
  assert.equal(idempotent.duplicate, true);

  const verified = await verifyLedger(root, enabled);
  assert.equal(verified.valid, true);
  assert.equal(verified.entries, 1);
  assert.equal(verified.sequence, 1);
  const log = await ledgerLog(root, enabled);
  assert.equal(log[0].eventId, intent.eventId);
  assert.equal((await ledgerShow(root, enabled, intent.eventId)).entry.eventType, 'phase-approved');

  const offline = await verifyLedger(root, enabled, { offline: true });
  assert.equal(offline.valid, true);
  const archive = await archiveLedger(root, enabled, 'archives/capability-ledger.bundle');
  assert.equal(archive.signature, 'unsigned');
  assert.match(archive.sha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(await readFile(archive.manifestPath, 'utf8')).sha256, archive.sha256);
  assert.equal(git(root, ['bundle', 'verify', archive.path]).status, 0);
  await assert.rejects(
    archiveLedger(root, enabled, 'archives/capability-ledger.bundle'),
    /will not be replaced/
  );
});

test('a fresh clone self-heals its local custom pin cache from the exact recorded remote ref', async () => {
  const { parent, remote, root } = await repository();
  await initializeLedger(root, enabled);
  const expectedCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const intent = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-FRESH-PIN',
    subject: { workId: 'WORK-FRESH-PIN', phase: 'specification', generation: 1 },
    actor: { email: 'reviewer@example.com' }
  });
  await appendLedgerIntent(root, enabled, intent, expectedCommit);
  const pinRef = (await ledgerShow(root, enabled, intent.eventId)).entry.transport.pinRef;

  const fresh = path.join(parent, 'fresh-pin');
  run('git', ['clone', remote, fresh]);
  git(fresh, ['config', 'user.name', 'Fresh Machine']);
  git(fresh, ['config', 'user.email', 'fresh@example.com']);
  git(fresh, ['fetch', 'origin', 'state:refs/remotes/origin/state']);
  assert.notEqual(run('git', ['rev-parse', '--verify', pinRef], { cwd: fresh, allowFailure: true }).status, 0);

  const verified = await verifyLedger(fresh, enabled);
  assert.equal(verified.valid, true);
  assert.equal(verified.pinDiagnostics[0].fetchStatus, 'fetched');
  assert.equal(git(fresh, ['rev-parse', pinRef]).stdout.trim(), expectedCommit);
});

test('joining an existing workspace ledger installs its refspec and runs safe local pin repair', async () => {
  const { parent, remote, root } = await repository();
  await initializeLedger(root, enabled);
  const expectedCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const intent = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-WORKSPACE-PIN',
    subject: { workId: 'WORK-WORKSPACE-PIN', phase: 'specification', generation: 1 },
    actor: { email: 'reviewer@example.com' }
  });
  await appendLedgerIntent(root, enabled, intent, expectedCommit);
  const pinRef = (await ledgerShow(root, enabled, intent.eventId)).entry.transport.pinRef;

  const fresh = path.join(parent, 'workspace-join');
  run('git', ['clone', remote, fresh]);
  git(fresh, ['config', 'user.name', 'Workspace Joiner']);
  git(fresh, ['config', 'user.email', 'joiner@example.com']);
  const joined = await initializeLedger(fresh, enabled);
  assert.equal(joined.created, false);
  assert.equal(joined.refspecInstalled, true);
  assert.equal(joined.pinRepair.valid, true);
  assert.match(git(fresh, ['config', '--get-all', 'remote.origin.fetch']).stdout, /refs\/singularity\/pins/);
  assert.equal(git(fresh, ['rev-parse', pinRef]).stdout.trim(), expectedCommit);
});

test('a missing remote pin needs a hash-bound preview and restores only the recorded ref', async () => {
  const { parent, remote, root } = await repository();
  await initializeLedger(root, enabled);
  const expectedCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const intent = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-RESTORE-PIN',
    subject: { workId: 'WORK-RESTORE-PIN', phase: 'specification', generation: 1 },
    actor: { email: 'reviewer@example.com' }
  });
  await appendLedgerIntent(root, enabled, intent, expectedCommit);
  const pinRef = (await ledgerShow(root, enabled, intent.eventId)).entry.transport.pinRef;
  run('git', ['--git-dir', remote, 'update-ref', '-d', pinRef]);

  const fresh = path.join(parent, 'restore-pin');
  run('git', ['clone', remote, fresh]);
  git(fresh, ['config', 'user.name', 'Repair Operator']);
  git(fresh, ['config', 'user.email', 'repair@example.com']);
  git(fresh, ['fetch', 'origin', 'state:refs/remotes/origin/state']);
  const broken = await verifyLedger(fresh, enabled);
  assert.equal(broken.valid, false);
  assert.match(broken.errors.join('\n'), /origin does not advertise the recorded ref/);

  const preview = await repairLedgerPins(fresh, enabled, { dryRun: true, restoreRemote: true });
  assert.equal(preview.pins[0].remote.status, 'missing');
  assert.equal(preview.pins[0].restoreCandidate, true);
  assert.match(preview.confirmation, /^RESTORE LEDGER PINS [0-9a-f]{64}$/);
  await assert.rejects(
    repairLedgerPins(fresh, enabled, { restoreRemote: true, confirmation: 'RESTORE LEDGER PINS wrong' }),
    (error) => error.code === 'LEDGER_PIN_RESTORE_CONFIRMATION_REQUIRED'
  );
  assert.notEqual(run('git', ['--git-dir', remote, 'show-ref', '--verify', pinRef], { allowFailure: true }).status, 0);

  const restored = await repairLedgerPins(fresh, enabled, {
    restoreRemote: true,
    confirmation: preview.confirmation
  });
  assert.equal(restored.valid, true);
  assert.deepEqual(restored.restored, [{ pinRef, commit: expectedCommit, remote: 'origin' }]);
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', pinRef]).stdout.trim(), expectedCommit);
});

test('pin repair never overwrites a conflicting remote ref', async () => {
  const { remote, root } = await repository();
  await initializeLedger(root, enabled);
  const expectedCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const intent = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-CONFLICT-PIN',
    subject: { workId: 'WORK-CONFLICT-PIN', phase: 'specification', generation: 1 },
    actor: { email: 'reviewer@example.com' }
  });
  await appendLedgerIntent(root, enabled, intent, expectedCommit);
  const pinRef = (await ledgerShow(root, enabled, intent.eventId)).entry.transport.pinRef;
  const conflictingCommit = git(root, ['rev-parse', 'refs/remotes/origin/state']).stdout.trim();
  assert.notEqual(conflictingCommit, expectedCommit);
  run('git', ['--git-dir', remote, 'update-ref', pinRef, conflictingCommit]);

  const preview = await repairLedgerPins(root, enabled, { dryRun: true, restoreRemote: true });
  assert.equal(preview.pins[0].remote.status, 'mismatch');
  assert.equal(preview.pins[0].restoreCandidate, false);
  await assert.rejects(
    repairLedgerPins(root, enabled, {
      restoreRemote: true,
      confirmation: preview.confirmation
    }),
    (error) => error.code === 'LEDGER_PIN_REMOTE_MISMATCH'
  );
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', pinRef]).stdout.trim(), conflictingCommit);
});

test('remote restoration refuses an unavailable target before changing the local pin', async () => {
  const { parent, root } = await repository();
  await initializeLedger(root, enabled);
  const expectedCommit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const intent = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-OFFLINE-PIN',
    subject: { workId: 'WORK-OFFLINE-PIN', phase: 'specification', generation: 1 },
    actor: { email: 'reviewer@example.com' }
  });
  await appendLedgerIntent(root, enabled, intent, expectedCommit);
  const pinRef = (await ledgerShow(root, enabled, intent.eventId)).entry.transport.pinRef;
  git(root, ['update-ref', '-d', pinRef]);
  git(root, ['remote', 'set-url', 'origin', path.join(parent, 'unavailable.git')]);

  const preview = await repairLedgerPins(root, enabled, { dryRun: true, restoreRemote: true });
  assert.equal(preview.pins[0].remote.status, 'unavailable');
  await assert.rejects(
    repairLedgerPins(root, enabled, { restoreRemote: true, confirmation: preview.confirmation }),
    (error) => error.code === 'LEDGER_PIN_REMOTE_UNAVAILABLE'
  );
  assert.notEqual(run('git', ['rev-parse', '--verify', pinRef], { cwd: root, allowFailure: true }).status, 0);
});

test('a failed first ledger push retains the orphan root locally for safe retry', async () => {
  const { root, parent } = await repository();
  git(root, ['remote', 'set-url', 'origin', path.join(parent, 'unavailable.git')]);
  await assert.rejects(initializeLedger(root, enabled), /retained locally but push failed/);
  assert.match(git(root, ['rev-parse', '--verify', 'refs/heads/state']).stdout.trim(), /^[0-9a-f]{40}$/);
  const mergeBase = run('git', ['merge-base', 'main', 'state'], { cwd: root, allowFailure: true });
  assert.notEqual(mergeBase.status, 0);
});

test('first ledger publication is deadline-supervised and returns no hook diagnostics', {
  skip: process.platform === 'win32'
}, async () => {
  const { root, remote } = await repository();
  const secret = 'office-hook-secret-must-not-leak';
  const hook = path.join(remote, 'hooks/pre-receive');
  await writeFile(hook, [
    '#!/bin/sh',
    `echo '${secret}' >&2`,
    "trap '' TERM",
    'while :; do sleep 1; done',
    ''
  ].join('\n'));
  await chmod(hook, 0o755);
  const env = {
    ...process.env,
    SINGULARITY_FLOW_GIT_PUSH_TIMEOUT_MS: '40',
    SINGULARITY_FLOW_GIT_TERMINATION_GRACE_MS: '40'
  };
  let eventLoopAdvanced = false;
  const tick = setTimeout(() => { eventLoopAdvanced = true; }, 5);
  const startedAt = performance.now();
  let refusal;
  try {
    await initializeLedger(root, enabled, { env, transportRemote: remote });
  } catch (error) {
    refusal = error;
  } finally {
    clearTimeout(tick);
  }
  assert.equal(refusal?.code, 'REMOTE_NETWORK_TRANSIENT');
  assert.doesNotMatch(refusal?.message ?? '', new RegExp(secret));
  assert.match(refusal?.message ?? '', /diagnostic sha256:[0-9a-f]{16}/);
  assert.equal(eventLoopAdvanced, true, 'ledger publication blocked the event loop');
  assert.ok(performance.now() - startedAt < 1_000, 'ledger publication escaped its deadline and grace');
});

test('state projection push failures expose only a digest of hook diagnostics', {
  skip: process.platform === 'win32'
}, async () => {
  const { root, remote } = await repository();
  await initializeLedger(root, enabled);
  const secret = 'state-hook-secret-must-not-leak';
  const hook = path.join(remote, 'hooks/pre-receive');
  await writeFile(hook, `#!/bin/sh\necho '${secret}' >&2\nexit 1\n`);
  await chmod(hook, 0o755);

  let refusal;
  try {
    await publishToStateBranch(root, enabled, {
      'singularity/sgos/authority-stores/example/current.json': '{"safe":true}\n'
    }, 'Publish exact state projection');
  } catch (error) {
    refusal = error;
  }
  assert.equal(refusal?.code, 'state_branch.publication_failed');
  assert.doesNotMatch(JSON.stringify({
    message: refusal?.message, details: refusal?.details
  }), new RegExp(secret));
  assert.match(refusal?.message ?? '', /diagnostic sha256:[0-9a-f]{16}/u);
});

test('state authority observation failures never expose remote diagnostics', async () => {
  const { root, parent } = await repository();
  const secret = 'office-remote-token-must-not-leak';
  const unavailable = path.join(parent, secret, 'missing.git');
  git(root, ['remote', 'set-url', 'origin', unavailable]);
  let refusal;
  try {
    materializeStateBranchPublicationAuthority(root, enabled, {
      expectedRemoteSha: '0'.repeat(40), transportRemote: unavailable
    });
  } catch (error) {
    refusal = error;
  }
  assert.equal(refusal?.code, 'state_branch.publication_observation_unavailable');
  assert.doesNotMatch(JSON.stringify({
    message: refusal?.message, details: refusal?.details
  }), new RegExp(secret));
  assert.match(refusal?.message ?? '', /diagnostic sha256:[0-9a-f]{16}/u);
});

test('state worktree creation failures never expose checkout filter diagnostics', {
  skip: process.platform === 'win32'
}, async () => {
  const { root, parent } = await repository();
  await initializeLedger(root, enabled);
  await publishToStateBranch(root, enabled, {
    '.gitattributes': 'filtered.txt filter=sflow-secret-filter\n',
    'filtered.txt': 'checked-in bytes\n'
  }, 'Install adversarial state filter fixture');
  const secret = 'office-filter-token-must-not-leak';
  const filter = path.join(parent, 'secret-filter.sh');
  await writeFile(filter, `#!/bin/sh\necho '${secret}' >&2\nexit 1\n`);
  await chmod(filter, 0o755);
  git(root, ['config', 'filter.sflow-secret-filter.required', 'true']);
  git(root, ['config', 'filter.sflow-secret-filter.smudge', filter]);
  git(root, ['config', 'filter.sflow-secret-filter.clean', 'cat']);

  let refusal;
  try {
    await publishToStateBranch(root, enabled, {
      'unrelated.txt': 'new bytes\n'
    }, 'Trigger guarded state worktree creation');
  } catch (error) {
    refusal = error;
  }
  assert.equal(refusal?.code, 'state_branch.worktree_unavailable');
  assert.doesNotMatch(JSON.stringify({
    message: refusal?.message, details: refusal?.details
  }), new RegExp(secret));
  assert.match(refusal?.message ?? '', /diagnostic sha256:[0-9a-f]{16}/u);
});

test('durable work-branch intents reconcile from Git without relying on the local outbox', async () => {
  const { root } = await repository();
  await initializeLedger(root, enabled);
  const intent = createLedgerIntent({
    eventType: 'work-completed',
    capabilityId: 'story-WORK-2',
    subject: { workId: 'WORK-2', phase: 'conformance', generation: 1 },
    actor: { email: 'owner@example.com' }
  });
  const relative = await persistLedgerIntent(root, 'singularity/work-items/WORK-2', intent);
  git(root, ['add', relative]);
  git(root, ['commit', '-m', '[WORK-2][finalize] ready']);
  git(root, ['push', 'origin', 'main']);

  const reconciled = await reconcileLedger(root, enabled, { workId: 'WORK-2' });
  assert.equal(reconciled.appended.length, 1);
  assert.equal(reconciled.failed.length, 0);
  const second = await reconcileLedger(root, enabled, { workId: 'WORK-2' });
  assert.equal(second.existing.length, 1);
  const status = await ledgerStatus(root, enabled);
  assert.equal(status.pending.length, 0);
  const committed = JSON.parse(await readFile(path.join(root, relative), 'utf8'));
  assert.equal(committed.eventId, intent.eventId);
});

test('a fresh machine reconciles durable intents discovered on remote work branches', async () => {
  const { parent, remote, root } = await repository();
  await initializeLedger(root, enabled);
  git(root, ['switch', '-c', 'WORK-REMOTE']);
  const intent = createLedgerIntent({
    eventType: 'phase-approved',
    capabilityId: 'story-WORK-REMOTE',
    subject: { workId: 'WORK-REMOTE', phase: 'requirements', generation: 1 },
    actor: { email: 'remote-reviewer@example.com' }
  });
  const relative = await persistLedgerIntent(root, 'singularity/work-items/WORK-REMOTE', intent);
  git(root, ['add', relative]);
  git(root, ['commit', '-m', '[WORK-REMOTE][phase:requirements][approve]']);
  git(root, ['push', '-u', 'origin', 'WORK-REMOTE']);

  const fresh = path.join(parent, 'fresh');
  run('git', ['clone', remote, fresh]);
  git(fresh, ['config', 'user.name', 'Fresh Machine']);
  git(fresh, ['config', 'user.email', 'fresh@example.com']);
  const result = await reconcileLedger(fresh, enabled, { workId: 'WORK-REMOTE' });
  assert.equal(result.appended.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.appended[0].eventId, intent.eventId);
  assert.equal((await ledgerStatus(fresh, enabled)).pending.length, 0);
});

test('a governed file can be published to the state branch, and republishing the same bytes is a no-op', async () => {
  // The state-branch copy is the one `resolveWorldModelSource` and every organisation-level read
  // prefer. Nothing wrote it until now, which made the preference inert.
  const { root } = await repository();
  await initializeLedger(root, enabled);

  const first = await publishToStateBranch(root, enabled, {
    'singularity/capabilities.yml': 'version: 1\ncapabilities: {}\n'
  }, 'Publish the capability map');
  assert.equal(first.changed, true);
  assert.equal(first.branch, 'state');
  assert.deepEqual(first.published, ['singularity/capabilities.yml']);

  // Readable from the branch without a checkout, which is how the readers reach it.
  const shown = run('git', ['show', `${enabled.branch}:singularity/capabilities.yml`], { cwd: root }).stdout;
  assert.match(shown, /^version: 1$/m);
  // And it did not touch the working tree it was published from.
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout.trim(), '');

  // Publishing runs on every capability edit and most edits change one file out of several, so
  // identical bytes must not leave an empty commit behind.
  const again = await publishToStateBranch(root, enabled, {
    'singularity/capabilities.yml': 'version: 1\ncapabilities: {}\n'
  }, 'Publish the capability map');
  assert.equal(again.changed, false);
  assert.equal(again.commit, null);

  const changed = await publishToStateBranch(root, enabled, {
    'singularity/capabilities.yml': 'version: 1\ncapabilities: { commerce: { name: Commerce } }\n'
  }, 'Update capability commerce');
  assert.equal(changed.changed, true);
  assert.notEqual(changed.commit, first.commit);
});

test('state publication never moves a concurrently refreshed remote-tracking authority backwards', async () => {
  const { parent, remote, root } = await repository();
  await initializeLedger(root, enabled);
  const stateBefore = git(root, ['rev-parse', 'refs/remotes/origin/state']).stdout.trim();
  const tree = git(root, ['rev-parse', `${stateBefore}^{tree}`]).stdout.trim();
  const concurrent = git(root, [
    'commit-tree', tree, '-p', stateBefore, '-m', 'Concurrent state authority'
  ]).stdout.trim();
  git(root, ['push', '-q', 'origin', `${concurrent}:refs/heads/concurrent-state-object`]);

  // Interpose at the exact boundary after push has returned (and Git has updated its normal
  // tracking ref) but before the publisher synchronizes its authority cache. This is the same
  // window as a concurrent fetch observing a later publication.
  const shimDirectory = path.join(parent, 'git-shim');
  await mkdir(shimDirectory);
  const shim = path.join(shimDirectory, 'git');
  const realGit = run('which', ['git']).stdout.trim();
  await writeFile(shim, `#!/bin/sh
"$SFLOW_REAL_GIT" "$@"
status=$?
if [ "$status" -eq 0 ] && [ "$1" = "push" ]; then
  case " $* " in
    *refs/heads/state*)
      observed=$("$SFLOW_REAL_GIT" --git-dir="$SFLOW_TEST_REMOTE" rev-parse refs/heads/state) || exit 1
      "$SFLOW_REAL_GIT" --git-dir="$SFLOW_TEST_REMOTE" update-ref refs/heads/state "$SFLOW_TEST_CONCURRENT" "$observed" || exit 1
      "$SFLOW_REAL_GIT" --git-dir="$SFLOW_TEST_ROOT/.git" update-ref refs/remotes/origin/state "$SFLOW_TEST_CONCURRENT" || exit 1
      ;;
  esac
fi
exit "$status"
`);
  await chmod(shim, 0o755);
  const env = {
    ...process.env,
    PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
    SFLOW_REAL_GIT: realGit,
    SFLOW_TEST_REMOTE: remote,
    SFLOW_TEST_ROOT: root,
    SFLOW_TEST_CONCURRENT: concurrent
  };

  const published = await publishToStateBranch(root, enabled, {
    'singularity/world-model/manifest.json': '{"format":"registered-v4"}\n'
  }, 'Publish World Model projection', { expectedRemoteSha: stateBefore, env });
  assert.equal(published.changed, true);
  assert.notEqual(published.commit, concurrent);
  assert.equal(git(root, ['rev-parse', 'refs/remotes/origin/state']).stdout.trim(), concurrent,
    'the local authority cache must retain the concurrently observed remote tip');
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/state']).stdout.trim(), concurrent,
    'the remote must retain the concurrent publication');
});

test('absent-lease recreation advances an older cached tracking ref with an exact CAS', async () => {
  const { remote, root } = await repository();
  await initializeLedger(root, enabled);
  const removed = git(root, ['rev-parse', 'refs/remotes/origin/state']).stdout.trim();
  run('git', ['--git-dir', remote, 'update-ref', '-d', 'refs/heads/state']);

  const published = await publishToStateBranch(root, enabled, {
    'singularity/world-model/manifest.json': '{"format":"registered-v4"}\n'
  }, 'Recreate removed World Model authority', {
    expectedRemoteSha: null,
    baseRef: removed,
    refreshRemote: false
  });
  assert.equal(published.changed, true);
  assert.equal(git(root, ['rev-parse', 'refs/remotes/origin/state']).stdout.trim(), published.commit);
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/state']).stdout.trim(), published.commit);
});

test('remote publication preserves a divergent unpublished local state branch', async () => {
  const { remote, root } = await repository();
  await initializeLedger(root, enabled);
  const remoteBase = git(root, ['rev-parse', 'refs/remotes/origin/state']).stdout.trim();
  const tree = git(root, ['rev-parse', `${remoteBase}^{tree}`]).stdout.trim();
  const unpublished = git(root, [
    'commit-tree', tree, '-p', remoteBase, '-m', 'Unpublished local state'
  ]).stdout.trim();
  git(root, ['update-ref', 'refs/heads/state', unpublished, remoteBase]);

  const published = await publishToStateBranch(root, enabled, {
    'singularity/world-model/manifest.json': '{"format":"registered-v4"}\n'
  }, 'Publish remote World Model without hiding local history', {
    expectedRemoteSha: remoteBase,
    baseRef: remoteBase,
    refreshRemote: false
  });
  assert.equal(published.changed, true);
  assert.equal(git(root, ['rev-parse', 'refs/heads/state']).stdout.trim(), unpublished,
    'unique unpublished local history must remain reachable');
  assert.equal(git(root, ['rev-parse', 'refs/remotes/origin/state']).stdout.trim(), published.commit);
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/state']).stdout.trim(), published.commit);
});

test('local-only state publication refuses changed and no-op candidates built from an obsolete base', async () => {
  const { root } = await repository();
  git(root, ['remote', 'remove', 'origin']);
  await initializeLedger(root, enabled);
  await publishToStateBranch(root, enabled, {
    'singularity/world-model/manifest.json': '{"format":"registered-v4"}\n'
  }, 'Publish initial local World Model');
  const reviewedBase = git(root, ['rev-parse', 'refs/heads/state']).stdout.trim();
  const tree = git(root, ['rev-parse', `${reviewedBase}^{tree}`]).stdout.trim();
  const concurrent = git(root, [
    'commit-tree', tree, '-p', reviewedBase, '-m', 'Advance local state concurrently'
  ]).stdout.trim();
  git(root, ['update-ref', 'refs/heads/state', concurrent, reviewedBase]);

  for (const contents of [
    '{"format":"registered-v4"}\n',
    '{"format":"registered-v4","revision":2}\n'
  ]) {
    await assert.rejects(
      () => publishToStateBranch(root, enabled, {
        'singularity/world-model/manifest.json': contents
      }, 'Publish obsolete local candidate', {
        baseRef: reviewedBase,
        refreshRemote: false
      }),
      (error) => error?.code === 'state_branch.concurrent_publication'
        && error?.details?.expectedLocalSha === reviewedBase
        && error?.details?.observedLocalSha === concurrent
    );
    assert.equal(git(root, ['rev-parse', 'refs/heads/state']).stdout.trim(), concurrent);
  }
});

test('a state projection is not reported current when its source authority already moved', async () => {
  const { parent, remote, root } = await repository();
  await initializeLedger(root, enabled);
  const approved = git(root, ['rev-parse', 'main']).stdout.trim();
  const stateBefore = git(root, ['rev-parse', 'state']).stdout.trim();

  const concurrent = path.join(parent, 'concurrent-source');
  run('git', ['clone', '-q', '--branch', 'main', remote, concurrent]);
  git(concurrent, ['config', 'user.name', 'Concurrent Configurer']);
  git(concurrent, ['config', 'user.email', 'concurrent@example.com']);
  await writeFile(path.join(concurrent, 'README.md'), '# concurrently advanced application\n');
  git(concurrent, ['add', 'README.md']);
  git(concurrent, ['commit', '-m', 'Advance source authority']);
  git(concurrent, ['push', 'origin', 'main']);
  const advanced = git(concurrent, ['rev-parse', 'HEAD']).stdout.trim();

  await assert.rejects(
    () => publishToStateBranch(root, enabled, {
      'configuration/manifest.json': `${JSON.stringify({ source: approved })}\n`
    }, 'Publish stale projection', {
      guardedRemoteRefs: { 'refs/heads/main': approved }
    }),
    (error) => error?.code === 'state_branch.source_authority_changed'
  );
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'main']).stdout.trim(), advanced);
  assert.notEqual(run('git', ['--git-dir', remote, 'rev-parse', 'state']).stdout.trim(), stateBefore,
    'the exact state lease can succeed, but the stale projection must still be reported as failure');
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:configuration/manifest.json'
  ]).stdout, `${JSON.stringify({ source: approved })}\n`);
});

test('a source move after advertisement is detected after the exact state CAS', async () => {
  const { parent, remote, root } = await repository();
  await initializeLedger(root, enabled);
  const approved = git(root, ['rev-parse', 'main']).stdout.trim();
  const stateBefore = git(root, ['rev-parse', 'state']).stdout.trim();

  // Put the future source commit in the remote object database without advancing the authority yet.
  // The receive hook below moves `main` only after the state push has received its advertisement,
  // reproducing the window in which Git elides an up-to-date no-op guard refspec.
  const concurrent = path.join(parent, 'source-race');
  run('git', ['clone', '-q', '--branch', 'main', remote, concurrent]);
  git(concurrent, ['config', 'user.name', 'Concurrent Configurer']);
  git(concurrent, ['config', 'user.email', 'concurrent@example.com']);
  await writeFile(path.join(concurrent, 'README.md'), '# moved during state receive\n');
  git(concurrent, ['add', 'README.md']);
  git(concurrent, ['commit', '-m', 'Prepare concurrent source authority']);
  const advanced = git(concurrent, ['rev-parse', 'HEAD']).stdout.trim();
  git(concurrent, ['push', 'origin', 'HEAD:refs/heads/source-race-object']);

  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/state" ]; then
    unset GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
    git --git-dir=${JSON.stringify(remote)} update-ref refs/heads/main ${advanced} ${approved} || exit 1
  fi
done
exit 0
`);
  await chmod(hook, 0o755);

  await assert.rejects(
    () => publishToStateBranch(root, enabled, {
      'configuration/manifest.json': `${JSON.stringify({ source: approved })}\n`
    }, 'Publish projection across source race', {
      expectedRemoteSha: stateBefore,
      guardedRemoteRefs: { 'refs/heads/main': approved }
    }),
    (error) => error?.code === 'state_branch.source_authority_changed'
      && error?.details?.phase === 'during state publication'
  );
  assert.equal(run('git', ['--git-dir', remote, 'rev-parse', 'main']).stdout.trim(), advanced);
  assert.notEqual(run('git', ['--git-dir', remote, 'rev-parse', 'state']).stdout.trim(), stateBefore,
    'the exact state lease succeeded before the cross-ref race was discovered');
  assert.equal(run('git', [
    '--git-dir', remote, 'show', 'state:configuration/manifest.json'
  ]).stdout, `${JSON.stringify({ source: approved })}\n`);
});

test('an explicit state-branch replacement root prunes stale tracked files and preserves unrelated state', async () => {
  const { root } = await repository();
  await initializeLedger(root, enabled);

  await publishToStateBranch(root, enabled, {
    'singularity/world-model/manifest.json': '{"schema_version":"3.0"}\n',
    'singularity/world-model/domains/old.md': '# obsolete\n',
    'singularity/keep.yml': 'preserved: true\n'
  }, 'Seed state');

  const mirrored = await publishToStateBranch(root, enabled, {
    'singularity/world-model/manifest.json': '{"schema_version":"3.0"}\n',
    'singularity/world-model/domains/current.md': '# current\n'
  }, 'Replace the world model', { replaceRoots: ['singularity/world-model'] });

  assert.equal(mirrored.changed, true);
  assert.deepEqual(mirrored.removed, ['singularity/world-model/domains/old.md']);
  assert.equal(run('git', ['show', `${enabled.branch}:singularity/world-model/domains/old.md`], {
    cwd: root, allowFailure: true
  }).status, 128);
  assert.match(run('git', ['show', `${enabled.branch}:singularity/world-model/domains/current.md`], {
    cwd: root
  }).stdout, /current/);
  assert.match(run('git', ['show', `${enabled.branch}:singularity/keep.yml`], { cwd: root }).stdout, /preserved/);

  const unchanged = await publishToStateBranch(root, enabled, {
    'singularity/world-model/manifest.json': '{"schema_version":"3.0"}\n',
    'singularity/world-model/domains/current.md': '# current\n'
  }, 'Replace the world model again', { replaceRoots: ['singularity/world-model'] });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(unchanged.removed, []);
});

test('an explicit replacement root supports deletion-only mirrors', async () => {
  const { root } = await repository();
  await initializeLedger(root, enabled);
  await publishToStateBranch(root, enabled, {
    'singularity/world-model/stale.md': '# stale\n',
    'singularity/keep.yml': 'preserved: true\n'
  }, 'Seed state');

  const cleared = await publishToStateBranch(
    root, enabled, {}, 'Clear the world model', { replaceRoots: ['singularity/world-model'] });
  assert.equal(cleared.changed, true);
  assert.deepEqual(cleared.published, []);
  assert.deepEqual(cleared.removed, ['singularity/world-model/stale.md']);
  assert.match(run('git', ['show', `${enabled.branch}:singularity/keep.yml`], { cwd: root }).stdout, /preserved/);
});

test('an exact managed removal prunes one stale file without replacing its siblings', async () => {
  const { root } = await repository();
  await initializeLedger(root, enabled);
  await publishToStateBranch(root, enabled, {
    'singularity/obsolete.yml': 'obsolete: true\n',
    'singularity/world-model/model.md': '# costly model\n',
    'singularity/keep.yml': 'preserved: true\n'
  }, 'Seed shared state');

  const result = await publishToStateBranch(root, enabled, {
    'configuration/manifest.json': '{"layout":"canonical-paths"}\n'
  }, 'Retire one managed file', { removePaths: ['singularity/obsolete.yml'] });

  assert.equal(result.changed, true);
  assert.deepEqual(result.removed, ['singularity/obsolete.yml']);
  assert.equal(run('git', ['show', `${enabled.branch}:singularity/obsolete.yml`], {
    cwd: root, allowFailure: true
  }).status, 128);
  assert.match(run('git', ['show', `${enabled.branch}:singularity/world-model/model.md`], { cwd: root }).stdout,
    /costly model/);
  assert.match(run('git', ['show', `${enabled.branch}:singularity/keep.yml`], { cwd: root }).stdout,
    /preserved/);
});

test('a state-branch path that climbs out of the branch is refused', async () => {
  // The files are written into a temporary worktree, so `..` writes into the system temp folder.
  const { root } = await repository();
  await initializeLedger(root, enabled);
  await assert.rejects(
    () => publishToStateBranch(root, enabled, { '../escape.yml': 'x' }, 'Escape'),
    /must stay inside the branch/);
  await assert.rejects(
    () => publishToStateBranch(root, enabled, { '/etc/passwd': 'x' }, 'Escape'),
    /must stay inside the branch/);
  await assert.rejects(
    () => publishToStateBranch(root, enabled, {}, 'Escape', { replaceRoots: ['../outside'] }),
    /must stay inside the branch/);
  await assert.rejects(
    () => publishToStateBranch(root, enabled, {}, 'Escape', { replaceRoots: ['C:\\outside'] }),
    /must stay inside the branch/);
  await assert.rejects(
    () => publishToStateBranch(root, enabled, {}, 'Escape', { removePaths: ['../outside'] }),
    /must stay inside the branch/);
});

test('ordinary state publication refuses a symbolic-link ancestor without writing through it', async () => {
  const { parent, root } = await repository();
  await initializeLedger(root, enabled);
  await publishToStateBranch(root, enabled, {
    'singularity/initial.yml': 'initial: true\n'
  }, 'Initialize managed state');
  const outside = path.join(parent, 'outside');
  const worktree = path.join(parent, 'adversarial-state');
  await mkdir(outside);
  git(root, ['worktree', 'add', '--detach', worktree, 'state']);
  await rm(path.join(worktree, 'singularity'), { recursive: true, force: true });
  await symlink(outside, path.join(worktree, 'singularity'));
  git(worktree, ['add', '-A']);
  git(worktree, ['commit', '-m', 'Adversarial state symlink']);
  git(worktree, ['push', '--force', 'origin', 'HEAD:refs/heads/state']);

  await assert.rejects(
    () => publishToStateBranch(root, enabled, {
      'singularity/escaped.yml': 'must-not-escape: true\n'
    }, 'Refuse symlink traversal'),
    (error) => error.code === 'state_branch.path_unsafe'
  );
  assert.equal(await lstat(path.join(outside, 'escaped.yml')).catch((error) =>
    error.code === 'ENOENT' ? null : Promise.reject(error)), null);
});

test('publishing nothing does nothing', async () => {
  const { root } = await repository();
  const result = await publishToStateBranch(root, enabled, {}, 'Nothing');
  assert.equal(result.changed, false);
  assert.deepEqual(result.published, []);
  assert.deepEqual(result.removed, []);
});
