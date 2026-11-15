/**
 * Whose GitHub account a command records (2026-11-15).
 *
 * `identity()` cached `gh api user` in the repository's Git directory, keyed by the file alone. A
 * real run signed in to one account first; from then on every command in that repository recorded
 * that account's login and name, including a different person's in another HOME with no `gh`
 * sign-in, and commands run after signing out. The records then paired that login with the other
 * person's Git email, and self-approval and distinct-approver checks compared against it.
 *
 * Every `gh` here is a stub on PATH that answers from its own configuration directory, as the real
 * one does: signed in while hosts.yml exists. Nothing runs the real `gh` or touches the network.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sameApprover } from '../src/approval-authority.mjs';
import { GITHUB_LOOKUP, accountEnvironmentDigest, identity, resetGitProcessCaches } from '../src/git.mjs';
import { enforceSequenceGate, withConfirmationPort } from '../src/sequence.mjs';
import { loadSession, setAgentSession } from '../src/session.mjs';
import { actingDecision } from '../src/story-publication-service.mjs';

const POSIX = { skip: process.platform === 'win32' ? 'the gh stub is a POSIX shell script' : false };
const STUB = `#!/bin/sh
dir="\${GH_CONFIG_DIR:-\${XDG_CONFIG_HOME:+$XDG_CONFIG_HOME/gh}}"
dir="\${dir:-$HOME/.config/gh}"
echo "$HOME" >> "$SFLOW_GH_STUB_CALLS"
if [ -f "$dir/hosts.yml" ]; then cat "$dir/account.json"; exit 0; fi
echo 'You are not logged into any GitHub hosts. To log in, run: gh auth login' >&2
exit 4
`;
// Variables a developer's or the runner's shell could carry that choose another gh or account.
const AMBIENT = ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN', 'SINGULARITY_FLOW_NO_NETWORK', 'SINGULARITY_FLOW_TEST_IDENTITY', 'SINGULARITY_FLOW_GITHUB_ACTOR'];

/** One repository, and a shared `gh` stub every environment runs. */
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-gh-account-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repository');
  const bin = path.join(base, 'bin');
  await mkdir(root);
  await mkdir(bin);
  await writeFile(path.join(bin, 'gh'), STUB);
  await chmod(path.join(bin, 'gh'), 0o755);
  // No repository-local user: each person's Git identity is their own global configuration.
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  const calls = path.join(base, 'gh-calls');
  await writeFile(calls, '');
  resetGitProcessCaches();
  /** A person's environment: their HOME, Git identity and gh configuration, signed in or not. */
  const person = async (id, { name, email, account = null }) => {
    const home = path.join(base, id);
    const config = path.join(home, '.config', 'gh');
    await mkdir(config, { recursive: true });
    await writeFile(path.join(home, '.gitconfig'), `[user]\n\tname = ${name}\n\temail = ${email}\n`);
    if (account) {
      await writeFile(path.join(config, 'hosts.yml'), `git.example.invalid:\n  user: ${account.login}\n`);
      await writeFile(path.join(config, 'account.json'), JSON.stringify(account));
    }
    const env = { ...process.env, HOME: home, USERPROFILE: home, GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`, SFLOW_GH_STUB_CALLS: calls };
    for (const variable of AMBIENT) delete env[variable];
    return { env, home, config, gitconfig: path.join(home, '.gitconfig') };
  };
  const asked = async () => (await readFile(calls, 'utf8')).split('\n').filter(Boolean);
  return { base, root, person, asked };
}

/** Run `fn` with the process in `env`, as a command started there would be. */
async function within(env, fn) {
  const saved = { ...process.env };
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

const A_ACCOUNT = { login: 'person-a-login', name: 'Person A Account' };
const people = (value) => Promise.all([
  value.person('home-a', { name: 'Person A', email: 'person.a@example.invalid', account: A_ACCOUNT }),
  value.person('home-b', { name: 'Person B', email: 'person.b@example.invalid' })
]);

test('two environments sharing one repository each record only their own account', POSIX, async (t) => {
  const value = await fixture(t);
  const [a, b] = await people(value);

  const first = identity(value.root, { env: a.env });
  assert.deepEqual(first, { name: 'Person A Account', email: 'person.a@example.invalid', login: 'person-a-login',
    githubLookup: GITHUB_LOOKUP.RESOLVED });
  // The repository's cache now holds A's answer. B, in another HOME with no gh sign-in, is not given it.
  const other = identity(value.root, { env: b.env });
  assert.deepEqual(other, { name: 'Person B', email: 'person.b@example.invalid', login: null,
    githubLookup: GITHUB_LOOKUP.UNAVAILABLE });
  assert.equal(identity(value.root, { env: b.env, offline: true }).githubLookup, GITHUB_LOOKUP.NOT_CHECKED,
    'a read in B finds no answer of its own, and declares it did not look');
  // A's own answer is still reused, without asking gh again.
  assert.equal(identity(value.root, { env: a.env, offline: true }).login, 'person-a-login');
  assert.deepEqual(await value.asked(), [a.home, b.home], 'each environment asked its own gh once');

  // Neither the token-free cache nor the digest that keys it names anyone.
  const cache = await readFile(path.join(value.root, '.git', 'singularity-flow', 'github-account.json'), 'utf8');
  assert.doesNotMatch(cache, /person\.a@example\.invalid|home-a/u);

  // The agent session A chose stays A's in A, and is B's own in B: B's records never carry A.
  const definition = { agents: { developer: { label: 'Developer', phases: [], sha256: 'sha256:agent', scope: 'repository' } } };
  await within(a.env, async () => {
    await setAgentSession(value.root, definition, identity(value.root), 'developer', 'WORK-1');
    assert.equal((await loadSession(value.root)).actor.login, 'person-a-login');
  });
  const gate = () => withConfirmationPort(async () => true, async () => {
    const workflow = { workItem: { id: 'WORK-1' }, currentPhase: 'implementation', status: 'active',
      phases: { implementation: { id: 'implementation', status: 'in_progress', generation: 1 } },
      resolution: { sequenceGates: { phaseStatus: 'soft' } }, history: [] };
    await enforceSequenceGate(value.root, workflow, 'phaseStatus', 'continue past the soft gate', { requestedPhase: 'implementation' });
    return workflow.sequenceOverrides[0].actor;
  });
  await within(b.env, async () => {
    const session = await loadSession(value.root);
    assert.equal(session.actor.email, 'person.b@example.invalid');
    assert.equal(session.actor.login, null);
    assert.equal(session.actor.name, 'Person B');
    assert.equal(session.agent, 'developer', 'only the actor is the environment\'s own; the session is kept');
    const override = await gate();
    assert.deepEqual([override.name, override.email, override.login], ['Person B', 'person.b@example.invalid', null]);
  });
  await within(a.env, async () => assert.equal((await gate()).login, 'person-a-login'));
});

test('signing out after a cached success leaves no login, for identities and sessions alike', POSIX, async (t) => {
  const value = await fixture(t);
  const [a] = await people(value);
  const definition = { agents: { developer: { label: 'Developer', phases: [], sha256: 'sha256:agent', scope: 'repository' } } };
  await within(a.env, () => setAgentSession(value.root, definition, identity(value.root), 'developer', 'WORK-1'));
  assert.equal(identity(value.root, { env: a.env, offline: true }).login, 'person-a-login');

  // `gh auth logout` rewrites hosts.yml; the cached answer is no longer this environment's.
  await rm(path.join(a.config, 'hosts.yml'));
  const offline = identity(value.root, { env: a.env, offline: true });
  assert.deepEqual([offline.login, offline.name, offline.githubLookup], [null, 'Person A', GITHUB_LOOKUP.NOT_CHECKED]);
  const online = identity(value.root, { env: a.env });
  assert.deepEqual([online.login, online.name, online.githubLookup], [null, 'Person A', GITHUB_LOOKUP.UNAVAILABLE]);
  await within(a.env, async () => {
    const { actor } = await loadSession(value.root);
    assert.deepEqual([actor.login, actor.name, actor.email], [null, 'Person A', 'person.a@example.invalid']);
  });
});

test('a different Git identity in the same environment is a miss, and so is another token', POSIX, async (t) => {
  const value = await fixture(t);
  const [a] = await people(value);
  assert.equal(identity(value.root, { env: a.env }).login, 'person-a-login');
  assert.equal((await value.asked()).length, 1);

  await writeFile(a.gitconfig, '[user]\n\tname = Person C\n\temail = person.c@example.invalid\n');
  const changed = identity(value.root, { env: a.env, offline: true });
  assert.deepEqual([changed.login, changed.name, changed.email, changed.githubLookup],
    [null, 'Person C', 'person.c@example.invalid', GITHUB_LOOKUP.NOT_CHECKED]);
  identity(value.root, { env: a.env });
  assert.equal((await value.asked()).length, 2, 'the new Git identity asks gh for itself');

  // A token variable chooses the account too; only a digest of it is kept.
  const tokenEnv = { ...a.env, GH_TOKEN: 'environment-token-value' };
  assert.equal(identity(value.root, { env: tokenEnv, offline: true }).githubLookup, GITHUB_LOOKUP.NOT_CHECKED);
  identity(value.root, { env: tokenEnv });
  assert.equal((await value.asked()).length, 3);
  assert.doesNotMatch(await readFile(path.join(value.root, '.git', 'singularity-flow', 'github-account.json'), 'utf8'),
    /environment-token-value/u);
  assert.notEqual(accountEnvironmentDigest(tokenEnv), accountEnvironmentDigest(a.env));
});

test('self-approval and distinct-approver checks still recognise a genuinely identical approver', POSIX, async (t) => {
  const value = await fixture(t);
  const [a, b] = await people(value);
  // A proposes signed in; approves from a warm read; then from another HOME with no gh sign-in.
  const proposer = identity(value.root, { env: a.env });
  const approver = identity(value.root, { env: a.env, offline: true });
  const unsignedHome = await value.person('home-a2', { name: 'Person A', email: 'person.a@example.invalid' });
  const elsewhere = identity(value.root, { env: unsignedHome.env });
  assert.equal(elsewhere.login, null);
  assert.equal(sameApprover(proposer, approver), true);
  assert.equal(sameApprover(proposer, elsewhere), true, 'the same Git email is the same person without a login');
  // B is never A, though B asked after A's answer was cached in the same repository.
  const other = identity(value.root, { env: b.env });
  assert.equal(sameApprover(proposer, other), false);
  assert.equal(sameApprover({ ...proposer, email: null }, other), false, 'no stale login joins them either');

  // A lifecycle event without an actor is the acting person's: A's own earlier decision speaks for A, never for B.
  const decision = { actor: proposer, decision: 'approved', authorityGroup: 'reviewers' };
  await within(a.env, () => assert.equal(actingDecision(value.root, decision), decision));
  await within(b.env, () => assert.equal(actingDecision(value.root, decision), null));
  assert.equal(actingDecision(value.root, decision, { actor: other }), null);
  assert.equal(actingDecision(value.root, decision, { actor: approver }), decision);
});
