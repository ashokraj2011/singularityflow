import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run } from '../src/util.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { activateCapabilityProposal, mapCapability } from '../src/organisation.mjs';
import {
  CAPABILITY_AUTHORITY_LINK_PATH, createCapabilityAuthorityLink, publishCapabilityAuthorityLink
} from '../src/capability-authority-link.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { resolveGitCommitIdentity } from '../src/git.mjs';
import { createLedgerIntent, initializeLedger, prepareLedgerAppend, publishToStateBranch } from '../src/ledger.mjs';

const ledger = { enabled: true, branch: 'state', remote: 'origin', signing: 'off', publication: 'required' };
const git = (cwd, args, options = {}) => run('git', args, { cwd, ...options });
const readGit = (cwd, args) => git(cwd, args).stdout.trim();

async function fixture(t, { objectFormat = 'sha1' } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-activation-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const application = path.join(directory, 'application');
  const lead = path.join(directory, 'lead.git'), delivery = path.join(directory, 'delivery.git');
  await mkdir(application);
  git(application, ['init', '-q', '-b', 'main', ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : [])]);
  git(application, ['config', 'user.name', 'Activation contract']);
  git(application, ['config', 'user.email', 'activation@example.invalid']);
  await writeFile(path.join(application, 'application.txt'), 'Application bytes must never enter the state publication store.\n');
  git(application, ['add', '.']); git(application, ['commit', '-qm', 'Application baseline']);
  git(directory, ['clone', '-q', '--bare', application, lead]);
  git(directory, ['clone', '-q', '--bare', application, delivery]);
  git(application, ['remote', 'add', 'origin', delivery]);
  const environment = {
    NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Activation reviewer',
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(directory, 'leads.json'),
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(directory, 'organisation-cache'),
    SINGULARITY_FLOW_AUTHORITY_CACHE: path.join(directory, 'authority-cache'),
    SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(directory, 'outbox')
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const env = { ...process.env };
  const commitIdentity = resolveGitCommitIdentity(application, { env });
  const main = readGit(application, ['rev-parse', 'HEAD']);
  const link = ids => createCapabilityAuthorityLink({ authorityRemote: lead, repositoryRemote: delivery, capabilityIds: ids });
  const publish = (ids = ['service'], options = {}) => publishCapabilityAuthorityLink(delivery, link(ids), {
    env, commitIdentity, ...options
  });
  return { directory, application, lead, delivery, env, commitIdentity, main, link, publish };
}

async function timed(action) {
  const timer = commandTimer('onboarding-activation-contract', { commandClass: 'mutation' });
  const result = await withCommandTiming(timer, action);
  return { result, counters: timer.finish().counters };
}

async function activate(f, proposed) {
  return activateCapabilityProposal(f.lead, proposed.branch, {
    confirm: proposed.commit, acknowledgeUnprotected: true,
    initiatingRoot: f.application, initiatingEnv: f.env
  });
}

test('first activation publishes root, audit and projection together without cloning application history', async t => {
  const f = await fixture(t);
  const proposed = await mapCapability(f.lead, { capabilityId: 'service', kind: 'delivery', repositoryUrl: f.delivery });
  const { result, counters } = await timed(() => activate(f, proposed));
  assert.equal(result.status, 'activated');
  assert.equal(result.audit.recorded, true);
  assert.equal(result.audit.sequence, 1);
  assert.equal(result.projection.published, true);
  assert.equal(result.portability.portable, true);
  assert.equal(result.proposalCleanup.status, 'deleted');
  assert.equal(counters['git.remote.command.clone'], 1, 'only the approved configuration checkout is cloned');
  assert.equal(counters['git.remote.command.push'], 4,
    'configuration, combined audit/mirror, delivery link, then exact proposal retirement');
  assert.ok(counters['git.spawns'] <= 145, `unexpected Git process fan-out: ${counters['git.spawns']}`);
  const tip = readGit(f.lead, ['rev-parse', 'state']);
  const audit = readGit(f.lead, ['rev-parse', `${tip}^`]);
  assert.equal(audit, result.audit.ledgerCommit);
  const rootHead = JSON.parse(readGit(f.lead, ['show', `${audit}^:ledger/head.json`]));
  assert.equal(rootHead.sequence, 0);
  assert.equal(readGit(f.lead, ['rev-list', '--parents', '-n', '1', `${audit}^`]).split(' ').length, 1);
  for (const remote of [f.lead, f.delivery]) assert.equal(readGit(remote, ['rev-parse', 'main']), f.main);
});

test('first activation retains sequential recovery when the server does not advertise atomic push', async t => {
  const f = await fixture(t);
  const proposed = await mapCapability(f.lead, { capabilityId: 'service', kind: 'delivery', repositoryUrl: f.delivery });
  git(f.lead, ['config', 'receive.advertiseAtomic', 'false']);
  const { result, counters } = await timed(() => activate(f, proposed));
  assert.equal(result.status, 'activated');
  assert.equal(result.audit.recorded, true);
  assert.equal(result.projection.published, true);
  assert.equal(result.portability.portable, true);
  assert.ok(counters['git.remote.command.push'] > 4, 'the real unsupported server used sequential recovery');
  const before = readGit(f.lead, ['rev-parse', 'state']);
  const retry = await activate(f, proposed);
  assert.equal(retry.audit.duplicate, true);
  assert.equal(readGit(f.lead, ['rev-parse', 'state']), before, 'acknowledgement does not append a second event');
});

test('preparing the first audit and deferred mirror neither publishes nor installs state refs', async t => {
  const f = await fixture(t);
  const intent = createLedgerIntent({ eventType: 'phase-approved', capabilityId: 'service',
    subject: { workId: 'fixture', phase: 'intake', generation: 1 }, actor: { email: 'reviewer@example.invalid' } });
  const { result: audit, counters } = await timed(() => prepareLedgerAppend(f.application, ledger, intent, f.main, {
    env: f.env, commitIdentity: f.commitIdentity, initializeIfAbsent: true
  }));
  assert.equal(audit.expectedRemoteSha, null);
  assert.equal(audit.sequence, 1);
  assert.equal(counters['git.remote.total'] ?? 0, 0);
  const projection = await publishToStateBranch(f.application, ledger, { 'configuration/fixture.json': '{}' }, 'Deferred first mirror', {
    env: f.env, commitIdentity: f.commitIdentity, deferPush: true, refreshRemote: false,
    baseRef: audit.ledgerCommit, expectedRemoteSha: null
  });
  assert.equal(projection.changed, true);
  for (const repository of [f.application, f.delivery]) {
    assert.equal(git(repository, ['show-ref', '--verify', '--quiet', 'refs/heads/state'], { allowFailure: true }).status, 1);
  }
  assert.equal(readGit(f.application, ['rev-parse', 'HEAD']), f.main);
});

test('first-audit preparation refuses a dangling symbolic local authority', async t => {
  const f = await fixture(t);
  git(f.application, ['symbolic-ref', 'refs/heads/state', 'refs/heads/missing']);
  const intent = createLedgerIntent({ eventType: 'phase-approved', capabilityId: 'service',
    subject: { workId: 'fixture', phase: 'intake', generation: 1 }, actor: { email: 'reviewer@example.invalid' } });
  await assert.rejects(() => prepareLedgerAppend(f.application, ledger, intent, f.main, {
    env: f.env, commitIdentity: f.commitIdentity, initializeIfAbsent: true
  }), error => error.code === 'state_branch.ref_symbolic');
  assert.equal(readGit(f.application, ['symbolic-ref', 'refs/heads/state']), 'refs/heads/missing');
});

test('the first object-built ledger root and audit match the worktree fallback', async t => {
  const f = await fixture(t);
  const intent = createLedgerIntent({ eventType: 'phase-approved', capabilityId: 'service',
    subject: { workId: 'fixture', phase: 'intake', generation: 1 }, actor: { email: 'reviewer@example.invalid' } });
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-17T00:00:00.000Z') });
  const options = { env: f.env, commitIdentity: f.commitIdentity, initializeIfAbsent: true };
  const objects = await prepareLedgerAppend(f.application, ledger, intent, f.main, options);
  const worktree = await prepareLedgerAppend(f.application, ledger, intent, f.main, {
    ...options, env: { ...options.env, SINGULARITY_FLOW_LEDGER_APPEND_WORKTREE: '1' }
  });
  t.mock.timers.reset();
  assert.equal(objects.entryHash, worktree.entryHash);
  // The identity boundary intentionally drops ambient Git dates. Native Git's wall clock is
  // not mocked by Node, so compare the root and its single child structurally rather than
  // requiring independently created root hashes (and therefore parent hashes) to match.
  const header = commit => readGit(f.application, ['cat-file', '-p', commit])
    .replace(/ \d+ [+-]\d{4}$/gmu, '').replace(/^parent [a-f0-9]+$/gmu, 'parent <verified-root>');
  for (const suffix of ['^', '']) {
    assert.equal(readGit(f.application, ['rev-parse', `${objects.ledgerCommit}${suffix}^{tree}`]),
      readGit(f.application, ['rev-parse', `${worktree.ledgerCommit}${suffix}^{tree}`]));
    assert.equal(header(`${objects.ledgerCommit}${suffix}`), header(`${worktree.ledgerCommit}${suffix}`));
  }
});

test('a deferred first mirror still requires its explicit local base and absent-ref lease', async t => {
  const f = await fixture(t);
  await assert.rejects(() => publishToStateBranch(f.application, ledger, { 'configuration/fixture.json': '{}' }, 'No invented base', {
    env: f.env, commitIdentity: f.commitIdentity, deferPush: true, refreshRemote: false, expectedRemoteSha: null
  }), error => error.code === 'state_branch.publication_base_unavailable');
});

test('paired ledger reads preserve remote authority priority over an unrelated local state prefix', async t => {
  const f = await fixture(t);
  await publishToStateBranch(f.application, ledger, { 'configuration/fixture.json': '{}' }, 'Existing state', {
    env: f.env, commitIdentity: f.commitIdentity
  });
  const current = readGit(f.application, ['rev-parse', 'refs/heads/state']);
  git(f.application, ['update-ref', '-d', 'refs/heads/state', current]);
  git(f.application, ['update-ref', 'refs/heads/state/unrelated', f.main]);
  const result = await initializeLedger(f.application, ledger, {
    env: f.env, refreshRemote: false, repairPins: false, commitIdentity: f.commitIdentity
  });
  assert.equal(result.created, false);
  assert.equal(result.ref, 'refs/remotes/origin/state');
  assert.equal(readGit(f.application, ['rev-parse', 'refs/heads/state/unrelated']), f.main);
});

test('first delivery discovery publication makes one push and needs no application branch checkout', async t => {
  const f = await fixture(t);
  const operations = [];
  const { result, counters } = await timed(() => f.publish(['service'], {
    defaultBranch: 'branch-that-does-not-exist',
    async runRemoteCommand(args, options) {
      operations.push(args);
      return runRemoteGitAsync(args, options);
    }
  }));
  assert.equal(result.published, true);
  assert.equal(counters['git.remote.command.push'], 1, 'the root and locator land in one absent-ref CAS');
  assert.equal(counters['git.remote.command.clone'] ?? 0, 0);
  assert.ok(operations.every(args => !['clone', 'fetch'].includes(args[0])), 'no application object is fetched');
  assert.equal(readGit(f.delivery, ['rev-parse', 'main']), f.main);
  assert.equal(git(f.delivery, ['merge-base', '--is-ancestor', f.main, 'state'], { allowFailure: true }).status, 1);
});

test('changed delivery links fetch only state objects and preserve unrelated state bytes', async t => {
  const f = await fixture(t);
  await f.publish();
  await publishToStateBranch(f.application, ledger, { 'unrelated/retained.txt': 'retained bytes\n' }, 'Retain independent state', {
    env: f.env, commitIdentity: f.commitIdentity
  });
  let stateStoreChecked = false;
  const result = await f.publish(['service', 'other-service'], { async runRemoteCommand(args, options) {
    const observed = await runRemoteGitAsync(args, options);
    if (args[0] === 'fetch' && args.some(arg => arg.startsWith('refs/heads/state:refs/remotes/'))) {
      assert.notEqual(git(options.cwd, ['cat-file', '-e', `${f.main}^{commit}`], {
        env: options.env, allowFailure: true
      }).status, 0, 'the publication store does not contain the application commit');
      stateStoreChecked = true;
    }
    return observed;
  } });
  assert.equal(result.published, true);
  assert.equal(stateStoreChecked, true);
  assert.equal(readGit(f.delivery, ['show', 'state:unrelated/retained.txt']), 'retained bytes');
  assert.deepEqual(JSON.parse(readGit(f.delivery, ['show', `state:${CAPABILITY_AUTHORITY_LINK_PATH}`])).subject.capabilityIds,
    ['other-service', 'service']);
});

test('unchanged delivery links freshly observe state and do not publish again', async t => {
  const f = await fixture(t);
  await f.publish();
  const tip = readGit(f.delivery, ['rev-parse', 'state']);
  const { result, counters } = await timed(() => f.publish());
  assert.equal(result.current, true);
  assert.equal(result.commit, tip);
  assert.equal(counters['git.remote.command.ls-remote'], 1);
  assert.equal(counters['git.remote.command.push'] ?? 0, 0);
  assert.equal(counters['git.remote.command.clone'] ?? 0, 0);
  assert.equal(readGit(f.delivery, ['rev-parse', 'state']), tip);
});

for (const rejected of [false, true]) test(`an unconfirmed state-only fetch (${rejected ? 'rejected runner' : 'timeout'}) preserves its exact private store`, async t => {
  const f = await fixture(t);
  await f.publish();
  const before = readGit(f.delivery, ['rev-parse', 'state']);
  let retainedStore;
  await assert.rejects(() => f.publish(['service', 'other-service'], { async runRemoteCommand(args, options) {
    if (args[0] === 'fetch' && args.some(arg => arg.startsWith('refs/heads/state:refs/remotes/'))) {
      if (rejected) throw new Error('Injected unknown process outcome');
      return { status: 0, stdout: '', stderr: '', timedOut: true };
    }
    return runRemoteGitAsync(args, options);
  } }), error => {
    retainedStore = error.details?.retainedStore;
    return error.code === 'CAPABILITY_AUTHORITY_LINK_PUBLICATION_FAILED' && Boolean(retainedStore);
  });
  // The injected runner never starts a child. Dispose this test-owned retained store explicitly.
  t.after(() => rm(retainedStore, { recursive: true, force: true }));
  assert.equal((await lstat(retainedStore)).isDirectory(), true);
  assert.equal(readGit(f.delivery, ['rev-parse', 'state']), before);
});

test('a delivery state move during materialization preserves the concurrent update', async t => {
  const f = await fixture(t);
  await f.publish();
  let moved = false;
  await assert.rejects(() => f.publish(['service', 'other-service'], { async runRemoteCommand(args, options) {
    if (!moved && args[0] === 'fetch' && args.some(arg => arg.startsWith('refs/heads/state:refs/remotes/'))) {
      moved = true;
      await publishToStateBranch(f.application, ledger, { 'concurrent/retained.txt': 'concurrent bytes\n' }, 'Concurrent state update', {
        env: f.env, commitIdentity: f.commitIdentity
      });
    }
    return runRemoteGitAsync(args, options);
  } }), error => error.code === 'state_branch.concurrent_publication');
  assert.equal(moved, true);
  assert.equal(readGit(f.delivery, ['show', 'state:concurrent/retained.txt']), 'concurrent bytes');
  assert.deepEqual(JSON.parse(readGit(f.delivery, ['show', `state:${CAPABILITY_AUTHORITY_LINK_PATH}`])).subject.capabilityIds, ['service']);
});

test('state-only delivery publication preserves the SHA-256 repository object format', async t => {
  const f = await fixture(t, { objectFormat: 'sha256' });
  const result = await f.publish();
  assert.equal(result.commit.length, 64);
  assert.equal(readGit(f.delivery, ['rev-parse', 'main']), f.main);
  assert.equal(JSON.parse(readGit(f.delivery, ['show', `state:${CAPABILITY_AUTHORITY_LINK_PATH}`])).linkSha256,
    f.link(['service']).linkSha256);
});

test('a symbolic delivery state ref is refused without moving its application target', async t => {
  const f = await fixture(t);
  git(f.delivery, ['symbolic-ref', 'refs/heads/state', 'refs/heads/main']);
  await assert.rejects(() => f.publish(), error => error.code === 'REMOTE_SYMBOLIC_REF_UNSUPPORTED');
  assert.equal(readGit(f.delivery, ['rev-parse', 'main']), f.main);
});

test('delivery publication refuses wildcard branch patterns before any Git request', async t => {
  const f = await fixture(t);
  for (const invalid of ['main*', 'main?', 'main[0]']) {
    const { counters } = await timed(async () => {
      await assert.rejects(() => f.publish(['service'], { defaultBranch: invalid }),
        error => error.code === 'CAPABILITY_AUTHORITY_LINK_INVALID');
    });
    assert.equal(counters['git.requests'] ?? 0, 0);
  }
});

test('activation dispatch stays independent of the legacy CLI handler', async () => {
  const command = await import('../src/commands/capability.mjs');
  // The engine's load-only phase must remain valid outside any onboarded application checkout.
  await command.load({ positionals: ['capability', 'activate'] });
  const source = await readFile(new URL('../src/commands/capability.mjs', import.meta.url), 'utf8');
  assert.match(source, /'test-setup', 'activate'/);
  assert.match(source, /if \(subcommand === 'activate'\) return runActivation\(context\)/);
});
