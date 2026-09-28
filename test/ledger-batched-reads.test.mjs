/**
 * Ledger reads that grow with history — pin verification, pinned-configuration hashes and remote
 * intent discovery — use a bounded number of Git processes and keep their exact answers.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import {
  appendLedgerIntent, createLedgerIntent, findLedgerEvents, initializeLedger, ledgerShow,
  ledgerStatus, persistLedgerIntent, verifyLedger
} from '../src/ledger.mjs';
import { run } from '../src/util.mjs';

const enabled = {
  enabled: true, branch: 'state', remote: 'origin', behind: 'block', enforcement: 'shadow',
  signing: 'off', trustTier: 'T0', maxRetries: 3
};

function git(root, args, options = {}) {
  return run('git', args, { cwd: root, ...options });
}

async function repository(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sflow-ledger-batch-'));
  t.after(() => run('rm', ['-rf', parent], { allowFailure: true }));
  const remote = path.join(parent, 'remote.git');
  const root = path.join(parent, 'repo');
  await mkdir(root);
  run('git', ['init', '--bare', remote]);
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.name', 'Ledger Batch']);
  git(root, ['config', 'user.email', 'ledger-batch@example.com']);
  await writeFile(path.join(root, 'README.md'), '# application\n');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'version: 1\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'application root']);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-u', 'origin', 'main']);
  return { parent, remote, root };
}

async function appendEntries(root, count, prefix) {
  const commit = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const pins = [];
  for (let index = 0; index < count; index += 1) {
    const intent = createLedgerIntent({
      eventType: 'phase-approved',
      capabilityId: `story-${prefix}-${index}`,
      subject: { workId: `${prefix}-${index}`, phase: 'specification', generation: 1 },
      actor: { email: 'reviewer@example.com' },
      payload: { configPath: 'singularity/workflow.yml', configSha256: 'a'.repeat(64) }
    });
    await appendLedgerIntent(root, enabled, intent, commit);
    pins.push((await ledgerShow(root, enabled, intent.eventId)).entry.transport.pinRef);
  }
  return { commit, pins };
}

async function verifiedOffline(root) {
  const timer = commandTimer('ledger-verify-batched', { commandClass: 'read' });
  const result = await withCommandTiming(timer, () => verifyLedger(root, enabled, { offline: true }));
  return { result, spawns: timer.finish().counters['git.spawns'] ?? 0 };
}

test('offline ledger verification reports every local pin state exactly from one listing', async (t) => {
  const { parent, remote, root } = await repository(t);
  await initializeLedger(root, enabled);
  const { commit, pins } = await appendEntries(root, 5, 'WORK-PIN');

  const fresh = path.join(parent, 'fresh');
  run('git', ['clone', remote, fresh]);
  git(fresh, ['config', 'user.name', 'Fresh']);
  git(fresh, ['config', 'user.email', 'fresh@example.com']);
  git(fresh, ['fetch', 'origin', 'state:refs/remotes/origin/state']);
  const other = git(fresh, ['rev-parse', 'refs/remotes/origin/state']).stdout.trim();
  assert.notEqual(other, commit);
  // Five pins, five states: expected, live symbolic, dangling symbolic, mismatch, and absent.
  git(fresh, ['update-ref', pins[0], commit]);
  git(fresh, ['symbolic-ref', pins[1], 'refs/remotes/origin/main']);
  git(fresh, ['symbolic-ref', pins[2], 'refs/heads/no-such-pin-target']);
  git(fresh, ['update-ref', pins[3], other]);

  const { result } = await verifiedOffline(fresh);
  const statuses = new Map(result.pinDiagnostics.map((entry) => [entry.pinRef, entry.localStatus]));
  assert.equal(statuses.get(pins[0]), 'expected');
  assert.equal(statuses.get(pins[1]), 'symbolic');
  assert.equal(statuses.get(pins[2]), 'symbolic', 'a dangling symbolic pin is never reported absent');
  assert.equal(statuses.get(pins[3]), 'mismatch');
  assert.equal(statuses.get(pins[4]), 'missing');
  assert.equal(result.valid, false);
  // The pinned configuration exists but its recorded hash is fabricated, for every entry.
  assert.equal(result.errors.filter((line) => /pinned configuration hash does not match/u.test(line)).length, 5);
  assert.ok(result.errors.some((line) => /symbolic ref/u.test(line)));
});

test('offline ledger verification does not spawn Git per entry', async (t) => {
  const small = await repository(t);
  await initializeLedger(small.root, enabled);
  await appendEntries(small.root, 2, 'WORK-SMALL');
  const large = await repository(t);
  await initializeLedger(large.root, enabled);
  await appendEntries(large.root, 12, 'WORK-LARGE');

  const few = await verifiedOffline(small.root);
  const many = await verifiedOffline(large.root);
  assert.equal(many.result.entries, 12);
  // Six times the entries costs at most a couple of extra processes, not four or five per entry.
  assert.ok(many.spawns - few.spawns <= 3,
    `verification spawned ${few.spawns} processes for 2 entries and ${many.spawns} for 12`);
});

test('remote intent discovery reads shared trees once and keeps the per-ref answer', async (t) => {
  const { parent, remote, root } = await repository(t);
  await initializeLedger(root, enabled);
  const expected = new Set();
  // Several Story branches carry intents; many configuration-like branches carry none.
  for (const workId of ['STORY-A', 'STORY-B', 'STORY-C']) {
    git(root, ['checkout', '-q', '-b', workId, 'main']);
    for (let index = 0; index < 3; index += 1) {
      const intent = createLedgerIntent({
        eventType: 'phase-approved',
        capabilityId: `story-${workId}`,
        subject: { workId, phase: 'specification', generation: index + 1 },
        actor: { email: 'reviewer@example.com' }
      });
      const relative = await persistLedgerIntent(root, path.join('singularity', 'work-items', workId), intent);
      expected.add(`${relative}@origin/${workId}`);
    }
    git(root, ['add', '-A']);
    git(root, ['commit', '-qm', `${workId} intents`]);
    git(root, ['push', '-q', 'origin', workId]);
  }
  // An intent under a directory Git quotes in a plain listing was never admitted; it stays out.
  git(root, ['checkout', '-q', '-b', 'quoted-story', 'main']);
  const quoted = createLedgerIntent({
    eventType: 'phase-approved', capabilityId: 'story-quoted',
    subject: { workId: 'quoted', phase: 'specification', generation: 1 },
    actor: { email: 'reviewer@example.com' }
  });
  await persistLedgerIntent(root, path.join('singularity', 'work-items', 'café'), quoted);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'quoted path intent']);
  git(root, ['push', '-q', 'origin', 'quoted-story']);
  for (let index = 0; index < 20; index += 1) {
    git(root, ['checkout', '-q', '-b', `sflow/config-history/h${index}`, 'main']);
    await writeFile(path.join(root, 'singularity', 'workflow.yml'), `version: ${index + 2}\n`);
    git(root, ['commit', '-qam', `configuration ${index}`]);
    git(root, ['push', '-q', 'origin', `sflow/config-history/h${index}`]);
  }
  git(root, ['checkout', '-q', 'main']);

  const fresh = path.join(parent, 'reader');
  run('git', ['clone', '-q', remote, fresh]);
  git(fresh, ['config', 'user.name', 'Reader']);
  git(fresh, ['config', 'user.email', 'reader@example.com']);
  git(fresh, ['fetch', '-q', 'origin', 'state:refs/remotes/origin/state']);

  const timer = commandTimer('ledger-status-batched', { commandClass: 'read' });
  const status = await withCommandTiming(timer, () => ledgerStatus(fresh, enabled, { offline: true }));
  const spawns = timer.finish().counters['git.spawns'] ?? 0;
  assert.deepEqual(new Set(status.pending.map((entry) => `${entry.path}@${entry.source}`)), expected);
  assert.ok(!status.pending.some((entry) => entry.workId === 'quoted'), 'a quoted-path intent stays unadmitted');
  // 25 remote refs, 9 intents: a per-ref read cost ~3 processes per ref plus one per intent.
  assert.ok(spawns < 45, `ledger status spawned ${spawns} processes for 25 remote refs`);
});

test('a state refresh does not fetch again when the tracking ref already names the observed tip', async (t) => {
  const { parent, remote, root } = await repository(t);
  await initializeLedger(root, enabled);
  await appendEntries(root, 1, 'WORK-REFRESH');
  const reader = path.join(parent, 'refresh-reader');
  run('git', ['clone', '-q', remote, reader]);
  const remoteCommands = async () => {
    const timer = commandTimer('ledger-refresh', { commandClass: 'read' });
    const found = await withCommandTiming(timer, () => findLedgerEvents(reader, enabled, {
      eventType: 'phase-approved', workId: 'WORK-REFRESH-0'
    }));
    const { counters } = timer.finish();
    return {
      found: found.entries.length,
      fetches: counters['git.remote.command.fetch'] ?? 0,
      advertisements: counters['git.remote.command.ls-remote'] ?? 0
    };
  };
  const tip = () => git(reader, ['rev-parse', 'refs/remotes/origin/state']).stdout.trim();

  // The first read has no tracking ref yet; the second has the exact observed tip locally.
  git(reader, ['update-ref', '-d', 'refs/remotes/origin/state']);
  const first = await remoteCommands();
  assert.deepEqual(first, { found: 1, fetches: 1, advertisements: 1 });
  const second = await remoteCommands();
  assert.deepEqual(second, { found: 1, fetches: 0, advertisements: 1 },
    'every refresh still observes the remote, but an unchanged tip is not fetched again');

  // A moved remote tip is fetched and tracked as before.
  await appendEntries(root, 1, 'WORK-REFRESH-MOVED');
  const moved = await remoteCommands();
  assert.equal(moved.fetches, 1);
  assert.equal(tip(), git(remote, ['rev-parse', 'refs/heads/state']).stdout.trim());

  // A tracking ref naming a commit the object store lacks is not trusted as materialized.
  const observed = tip();
  git(reader, ['update-ref', '-d', 'refs/remotes/origin/state']);
  git(reader, ['reflog', 'expire', '--expire=now', '--all']);
  git(reader, ['gc', '--prune=now', '--quiet']);
  assert.notEqual(git(reader, ['cat-file', '-e', `${observed}^{commit}`], { allowFailure: true }).status, 0);
  // gc packed every remote ref; with no loose origin/HEAD left, it also removed their directory.
  const looseRef = path.join(reader, '.git', 'refs', 'remotes', 'origin', 'state');
  await mkdir(path.dirname(looseRef), { recursive: true });
  await writeFile(looseRef, `${observed}\n`);
  const missing = await remoteCommands();
  assert.equal(missing.fetches, 1, 'a missing object is fetched even when the tracking ref matches');
  assert.equal(git(reader, ['cat-file', '-e', `${observed}^{commit}`], { allowFailure: true }).status, 0);
});
