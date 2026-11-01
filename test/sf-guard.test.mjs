import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { ownTerminalStep, skillForCommandLine } from '../src/command-skills.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import {
  approverId, approverStanding, emptyPresenceChain, foldPresenceChain, nextPresenceEvent, presenceChainText,
  presenceEventStatement, PRESENCE_CHAIN_PATH
} from '../src/presence/chain.mjs';
import { parseCtkListing, presenceIdentityStanding } from '../src/presence/local-keys.mjs';
import { verifyPresenceSignature, PRESENCE_NAMESPACE, SK_ECDSA_KEY_TYPE } from '../src/presence/sshsig.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { readPresencePolicy } from '../src/presence/store.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';

// SF Guard M1 (SPEC-PSS-v1): the presence-signature verifier, the signed policy chain and every
// `guard` route, with software stand-ins for the Secure Enclave passed in-process. No environment
// switch reaches signing or verification.

const engine = fileURLToPath(new URL('..', import.meta.url));
const bin = path.join(engine, 'bin', 'singularity-flow.mjs');
const ONE = { name: 'Guard One', email: 'guard.one@example.com', githubLogin: 'guard-one' };
const TWO = { name: 'Guard Two', email: 'guard.two@example.com', githubLogin: 'guard-two' };
const WINDOWS = { name: 'Windows Three', email: 'windows.three@example.com' };

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sf-guard-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Guard One');
  git(root, 'config', 'user.email', ONE.email);
  await writeFile(path.join(root, 'README.md'), '# Guarded\n');
  const init = spawnSync(process.execPath, [bin, 'init'], { cwd: root, encoding: 'utf8', timeout: childTimeout(120_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' } });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const configPath = path.join(root, 'singularity', 'workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.approvalAuthorities['product-approvers'].members = [ONE, TWO, WINDOWS];
  config.approvalAuthorities['engineering-reviewers'].members = [ONE];
  await writeFile(configPath, YAML.stringify(config));
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'Configured');
  return root;
}

/** A person at a Mac: their software stand-in keys, GitHub's listing of them, and the guard's other readers. */
function person(email, keys, { github = 'listed', listed = keys, identities, copies = [] } = {}) {
  const byId = new Map(keys.map((key) => [key.keyId, key]));
  return {
    identify: () => ({ email, login: null }),
    listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(identities ?? ctkListing(keys.map((key) => ({ keyId: key.keyId })))) }),
    readableCopies: (keyId) => copies.filter((copy) => copy.keyId === keyId),
    publicKeyOf: async (keyId) => byId.get(keyId)?.line ?? null,
    githubKeys: async () => (github === 'unavailable'
      ? { status: 'unavailable', keys: [], snapshotSha256: null, fetchedAt: new Date().toISOString(), reason: 'GitHub answered 503' }
      : { status: 'listed', keys: listed.map((key) => ({ keyId: key.keyId, line: key.line })), snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString(), reason: null }),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => {
      const key = byId.get(keyId);
      assert.ok(key, `asked to sign with ${keyId}, which this person does not hold`);
      return { signature: key.sign(statementText(statement)), userVerification: false };
    }
  };
}

/** Run one guard action in `root`, returning its JSON result or its refusal. */
async function sfGuard(root, words, deps, options = {}) {
  const previous = process.cwd();
  const log = console.log;
  const lines = [];
  process.chdir(root);
  console.log = (line) => lines.push(String(line));
  try {
    await guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps);
    return { result: JSON.parse(lines.join('\n')) };
  } catch (error) {
    return { error };
  } finally {
    console.log = log;
    process.chdir(previous);
  }
}

const refusedWith = (outcome, code) => {
  assert.ok(outcome.error, `expected ${code}, got ${JSON.stringify(outcome.result)}`);
  assert.equal(outcome.error.code, code, outcome.error.message);
  return outcome.error;
};

const chainFile = async (root) => JSON.parse(await readFile(path.join(root, PRESENCE_CHAIN_PATH), 'utf8'));

test('the verifier accepts only a touched security-key signature of the exact statement, and agrees with OpenSSH', async () => {
  const key = softwarePresenceKey();
  const message = '{"schema":"pss-statement/1"}\n';
  const good = key.sign(message);
  assert.deepEqual(verifyPresenceSignature({ message, armored: good, publicKey: key.line }).valid, true);
  for (const [why, check] of [
    ['a changed statement', { message: `${message} `, armored: good, publicKey: key.line }],
    ['another key', { message, armored: good, publicKey: softwarePresenceKey().line }],
    ['no touch (UP flag clear)', { message, armored: key.sign(message, { flags: 0 }), publicKey: key.line }],
    ['another namespace', { message, armored: key.sign(message, { namespace: 'git' }), publicKey: key.line }],
    ['an ordinary SSH key', { message, armored: good, publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' }],
    ['garbage', { message, armored: 'not a signature', publicKey: key.line }]
  ]) assert.equal(verifyPresenceSignature(check).valid, false, why);
  assert.match(verifyPresenceSignature({ message, armored: key.sign(message, { flags: 0 }), publicKey: key.line }).reason, /no user presence/u);
  assert.equal(verifyPresenceSignature({ message, armored: key.sign(message, { flags: 0x05 }), publicKey: key.line }).userVerification, true);
  // OpenSSH reads the same bytes: a good signature verifies there too, a tampered one does not. It
  // ignores the flags (it accepts a signature nobody touched), which is why this verifier decides.
  if (!existsSync('/usr/bin/ssh-keygen')) return;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-sf-guard-sshsig-'));
  try {
    await writeFile(path.join(directory, 'allowed'), `p namespaces="${PRESENCE_NAMESPACE}" ${key.line}\n`);
    const openssh = async (armored, text) => {
      await writeFile(path.join(directory, 'sig'), armored);
      return spawnSync('/usr/bin/ssh-keygen', ['-Y', 'verify', '-f', path.join(directory, 'allowed'), '-I', 'p', '-n', PRESENCE_NAMESPACE, '-s', path.join(directory, 'sig')],
        { input: text, encoding: 'utf8' }).status;
    };
    assert.equal(await openssh(good, message), 0);
    assert.notEqual(await openssh(good, `${message} `), 0);
    assert.equal(await openssh(key.sign(message, { flags: 0 }), message), 0, 'OpenSSH does not require user presence; SF Guard does');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('sc_auth listings: only a non-exportable, Touch ID protected, unexpired identity is a presence key', () => {
  const rows = parseCtkListing(ctkListing([{ keyId: 'SHA256:aaa' }, { keyId: 'SHA256:bbb', protection: 'none' }, { keyId: 'SHA256:ccc', keyType: 'p-256' },
    { keyId: 'SHA256:ddd', valid: 'NO', validTo: '11/1/26, 9:42 PM' }]));
  const listing = { available: true, reason: null, identities: rows };
  assert.deepEqual(rows.map((row) => [row.keyId, row.keyType, row.protection, row.valid]),
    [['SHA256:aaa', 'p-256-ne', 'bio', true], ['SHA256:bbb', 'p-256-ne', 'none', true], ['SHA256:ccc', 'p-256', 'bio', true], ['SHA256:ddd', 'p-256-ne', 'bio', false]]);
  assert.equal(presenceIdentityStanding(listing, 'SHA256:aaa').ok, true);
  assert.equal(presenceIdentityStanding(listing, 'SHA256:bbb').code, 'PSS_KEY_NOT_PRESENCE');
  assert.equal(presenceIdentityStanding(listing, 'SHA256:ccc').code, 'PSS_KEY_NOT_PRESENCE');
  assert.equal(presenceIdentityStanding(listing, 'SHA256:ddd').code, 'PSS_KEY_EXPIRED');
  assert.equal(presenceIdentityStanding(listing, 'SHA256:zzz').code, 'PSS_KEY_NOT_PRESENCE');
  assert.equal(presenceIdentityStanding({ available: false, reason: 'not macOS', identities: [] }, 'SHA256:aaa').code, 'PSS_SIGNER_UNAVAILABLE');
});

/** A chain built directly, as an agent writing the file by hand would. */
function signedEvent(chain, fields, signers) {
  const event = nextPresenceEvent(chain, fields);
  for (const { signer, key } of signers) {
    const entry = { signer, keyId: key.keyId, nonce: 'f'.repeat(32) };
    event.signatures.push({ ...entry, signature: key.sign(statementText(presenceEventStatement(chain.chainId, event, entry))) });
  }
  return { ...chain, events: [...chain.events, event] };
}

test('the policy chain counts only signed, authorized events, and an invalid one never removes what came before', () => {
  const one = approverId(ONE);
  const two = approverId(TWO);
  const keyOne = softwarePresenceKey();
  const keyTwo = softwarePresenceKey();
  const agent = softwarePresenceKey();
  const github = { listed: true, snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: '2026-11-01T00:00:00.000Z' };
  let chain = emptyPresenceChain();
  chain = signedEvent(chain, { kind: 'register', approver: one, key: keyOne.line, keyId: keyOne.keyId, github }, [{ signer: one, key: keyOne }]);
  chain = signedEvent(chain, { kind: 'register', approver: two, key: keyTwo.line, keyId: keyTwo.keyId, github }, [{ signer: two, key: keyTwo }]);
  chain = signedEvent(chain, { kind: 'enable', remoteCheck: 'sf-guard-verify', exceptions: [{ id: 'EXC-001', approver: approverId(WINDOWS), reason: 'Windows: no presence signer yet' }] },
    [{ signer: one, key: keyOne }]);
  let folded = foldPresenceChain(chain);
  assert.deepEqual([folded.problems, folded.enabled, folded.validLength, folded.pins.size], [[], true, 3, 2]);
  assert.equal(approverStanding(folded, approverId(WINDOWS)).label, 'bypass: per-person exception EXC-001');
  assert.equal(approverStanding(folded, one).state, 'signed');
  // An agent's own key signs a "disable": it is no one's pinned key, so SF Guard stays on.
  const forged = signedEvent(chain, { kind: 'disable', reason: 'Turned off.' }, [{ signer: one, key: agent }]);
  folded = foldPresenceChain(forged);
  assert.deepEqual([folded.enabled, folded.validLength, folded.problems[0].code], [true, 3, 'PSS_POLICY_UNSIGNED']);
  // Nor can it pin itself for an approver who has a key, or add an exception.
  for (const attempt of [
    signedEvent(chain, { kind: 'register', approver: one, key: agent.line, keyId: agent.keyId, github }, [{ signer: one, key: agent }]),
    signedEvent(chain, { kind: 'exception', exception: { id: 'EXC-002', approver: one, reason: 'Windows: no presence signer yet' } }, [{ signer: one, key: agent }])
  ]) {
    const result = foldPresenceChain(attempt);
    assert.equal(result.enabled, true);
    assert.equal(result.pins.get(one).keyId, keyOne.keyId);
    assert.ok(result.problems.length);
  }
  // An event edited in place no longer verifies; the approved history keeps the original (store test).
  const edited = foldPresenceChain({ ...chain, events: chain.events.map((event, index) => (index === 2 ? { ...event, remoteCheck: null } : event)) });
  assert.deepEqual([edited.validLength, edited.problems[0].code], [2, 'PSS_POLICY_UNSIGNED']);
  // Rotating needs the old and the new key; recovering records that GitHub dropped the lost one.
  const next = softwarePresenceKey();
  const rotateFields = { kind: 'rotate', approver: one, key: next.line, keyId: next.keyId, previousKeyId: keyOne.keyId, github };
  assert.equal(foldPresenceChain(signedEvent(chain, rotateFields, [{ signer: one, key: next }])).problems[0].code, 'PSS_POLICY_UNSIGNED');
  assert.equal(foldPresenceChain(signedEvent(chain, rotateFields, [{ signer: one, key: keyOne }, { signer: one, key: next }])).pins.get(one).keyId, next.keyId);
  const recoverFields = { kind: 'recover', approver: one, key: next.line, keyId: next.keyId, previousKeyId: keyOne.keyId, github: { ...github, delisted: [keyOne.keyId] } };
  const recovered = foldPresenceChain(signedEvent(chain, recoverFields, [{ signer: one, key: next }]));
  assert.deepEqual([recovered.problems, recovered.pins.get(one).recovered], [[], true]);
  assert.ok(foldPresenceChain(signedEvent(chain, { ...recoverFields, github }, [{ signer: one, key: next }])).problems.length);
  // Another approver revokes a lost key; nobody else's key moves.
  const revoked = foldPresenceChain(signedEvent(chain, { kind: 'revoke', approver: one, keyId: keyOne.keyId, reason: 'Lost the Mac.' }, [{ signer: two, key: keyTwo }]));
  assert.deepEqual([revoked.problems, revoked.pins.has(one), revoked.pins.has(two)], [[], false, true]);
  // A signed disable turns it off.
  assert.equal(foldPresenceChain(signedEvent(chain, { kind: 'disable', reason: 'Back to unsigned.' }, [{ signer: two, key: keyTwo }])).enabled, false);
});

test('guard: off by default, registration refuses every unproven key and records a GitHub-listed Secure Enclave one', async (t) => {
  const root = await repository(t);
  const key = softwarePresenceKey();
  const status = await sfGuard(root, ['status'], person(ONE.email, [key]));
  assert.equal(status.result.status, 'off');
  assert.equal(existsSync(path.join(root, PRESENCE_CHAIN_PATH)), false, 'reading writes nothing');
  assert.ok(status.result.approvers.every((row) => row.standing === 'person steps unsigned in this repository'));
  // Each route a refusal names is one a person can take today.
  const unavailable = refusedWith(await sfGuard(root, ['register'], person(ONE.email, [key], { github: 'unavailable' })), 'PSS_ANCHOR_UNAVAILABLE');
  assert.match(unavailable.message, /Nothing was recorded; run the same command again/u);
  assert.match(refusedWith(await sfGuard(root, ['register'], person(ONE.email, [key], { listed: [] })), 'PSS_KEY_NOT_LISTED').message, /settings\/ssh\/new \(Key type: Signing Key\)/u);
  refusedWith(await sfGuard(root, ['register'], person(ONE.email, [key], { copies: [{ keyId: key.keyId, where: 'file', path: '/home/x/.ssh/id' }] })), 'PSS_KEY_READABLE');
  refusedWith(await sfGuard(root, ['register'], person(ONE.email, [key], { identities: ctkListing([{ keyId: key.keyId, protection: 'none' }]) })), 'PSS_KEY_NOT_PRESENCE');
  refusedWith(await sfGuard(root, ['register'], person(ONE.email, [key], { identities: ctkListing([{ keyId: key.keyId, valid: 'NO' }]) })), 'PSS_KEY_EXPIRED');
  refusedWith(await sfGuard(root, ['register'], person('stranger@example.com', [key])), 'PSS_NOT_AN_APPROVER');
  assert.match(refusedWith(await sfGuard(root, ['register'], person(WINDOWS.email, [key])), 'PSS_KEY_NOT_LISTED').message, /guard exception add approver-/u);
  assert.equal(existsSync(path.join(root, PRESENCE_CHAIN_PATH)), false, 'no refusal wrote anything');
  const registered = await sfGuard(root, ['register'], person(ONE.email, [key]));
  assert.equal(registered.error, undefined, registered.error?.message);
  assert.deepEqual(registered.result.event, { seq: 0, kind: 'register' });
  const chain = await chainFile(root);
  assert.equal(chain.events[0].keyId, key.keyId);
  assert.equal(chain.events[0].approver, approverId(ONE));
  assert.doesNotMatch(await readFile(path.join(root, PRESENCE_CHAIN_PATH), 'utf8'), /@example\.com|guard-one/u, 'the chain names no person');
  refusedWith(await sfGuard(root, ['register'], person(ONE.email, [key])), 'PSS_KEY_ALREADY_PINNED');
});

test('guard: the signed opt-in, a labelled per-person exception, and nothing an agent writes by hand turns it off', async (t) => {
  const root = await repository(t);
  const keyOne = softwarePresenceKey();
  const keyTwo = softwarePresenceKey();
  const one = person(ONE.email, [keyOne]);
  const two = person(TWO.email, [keyTwo]);
  assert.equal((await sfGuard(root, ['register'], one)).error, undefined);
  assert.equal((await sfGuard(root, ['register'], two)).error, undefined);
  const windows = approverId(WINDOWS);
  const enabled = await sfGuard(root, ['enable'], one, { 'remote-check': 'sf-guard-verify', exception: [windows] });
  assert.equal(enabled.error, undefined, enabled.error?.message);
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'SF Guard on');
  const status = (await sfGuard(root, ['status'], one)).result;
  assert.deepEqual([status.status, status.remoteCheck, status.problems], ['required', 'sf-guard-verify', []]);
  const row = (id) => status.approvers.find((entry) => entry.approver === id);
  assert.equal(row(windows).standing, 'bypass: per-person exception EXC-001');
  assert.equal(row(approverId(ONE)).state, 'signed');
  // An agent appends a "disable" signed with its own key, then deletes the file in a commit: SF Guard stays on.
  const agent = softwarePresenceKey();
  const chain = await chainFile(root);
  await writeFile(path.join(root, PRESENCE_CHAIN_PATH), presenceChainText(signedEvent(chain, { kind: 'disable', reason: 'Off.' }, [{ signer: approverId(ONE), key: agent }])));
  let policy = (await sfGuard(root, ['status'], one)).result;
  assert.deepEqual([policy.status, policy.problems[0].code], ['required', 'PSS_POLICY_UNSIGNED']);
  // Editing the signed opt-in in place is a rewrite of the committed chain: it stays on.
  const edited = { ...chain, events: chain.events.map((event) => (event.kind === 'enable' ? { ...event, remoteCheck: null } : event)) };
  await writeFile(path.join(root, PRESENCE_CHAIN_PATH), presenceChainText(edited));
  policy = (await sfGuard(root, ['status'], one)).result;
  assert.equal(policy.status, 'required');
  assert.ok(policy.problems.some((entry) => entry.code === 'PSS_POLICY_REWRITTEN'), JSON.stringify(policy.problems));
  git(root, 'rm', '-qf', PRESENCE_CHAIN_PATH);
  git(root, 'commit', '-qm', 'Remove SF Guard');
  policy = (await sfGuard(root, ['status'], one)).result;
  assert.equal(policy.status, 'required');
  assert.ok(policy.problems.some((entry) => entry.code === 'PSS_POLICY_REWRITTEN'), JSON.stringify(policy.problems));
  // Nor can Workflow Studio write a chain that drops events or carries one that does not verify.
  const { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } = await import('../src/workflow-studio.mjs');
  git(root, 'revert', '--no-edit', 'HEAD');
  const shorter = { ...chain, events: chain.events.slice(0, 1) };
  const plan = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'presence.set', chain: shorter }] });
  assert.equal(plan.valid, false);
  assert.equal(plan.problems[0].code, 'PSS_POLICY_REWRITTEN');
  const unsigned = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'presence.set',
    chain: signedEvent(chain, { kind: 'disable', reason: 'Off.' }, [{ signer: approverId(ONE), key: agent }]) }] });
  assert.equal(unsigned.problems[0].code, 'PSS_POLICY_UNSIGNED');
  // The person's own signed steps: revoke the exception, then turn SF Guard off.
  assert.equal((await sfGuard(root, ['exception', 'revoke', 'EXC-001'], two, { reason: 'Now on a Mac.' })).error, undefined);
  assert.equal((await sfGuard(root, ['disable'], two, { reason: 'Pilot finished.' })).error, undefined);
  const after = (await sfGuard(root, ['status'], one)).result;
  assert.deepEqual([after.status, after.problems, after.exceptions[0].active], ['off', [], false]);
});

test('guard: rotate needs both keys, recover needs GitHub to drop the lost one, and another approver can revoke', async (t) => {
  const root = await repository(t);
  const old = softwarePresenceKey();
  const fresh = softwarePresenceKey();
  const keyTwo = softwarePresenceKey();
  assert.equal((await sfGuard(root, ['register'], person(ONE.email, [old]))).error, undefined);
  assert.equal((await sfGuard(root, ['register'], person(TWO.email, [keyTwo]))).error, undefined);
  // Recovering while GitHub still lists the lost key is refused: whoever holds it could still sign.
  assert.match(refusedWith(await sfGuard(root, ['recover'], person(ONE.email, [fresh], { listed: [old, fresh] }), { key: fresh.keyId }), 'PSS_KEY_STILL_LISTED').message,
    /Remove it from your GitHub account first/u);
  const recovered = await sfGuard(root, ['recover'], person(ONE.email, [fresh], { listed: [fresh] }), { key: fresh.keyId });
  assert.equal(recovered.error, undefined, recovered.error?.message);
  let status = (await sfGuard(root, ['status'], person(ONE.email, [fresh]))).result;
  assert.deepEqual([status.approvers.find((row) => row.approver === approverId(ONE)).recovered, status.problems], [true, []]);
  const third = softwarePresenceKey();
  assert.equal((await sfGuard(root, ['rotate'], person(ONE.email, [fresh, third]), { key: third.keyId })).error, undefined);
  const chain = await chainFile(root);
  assert.equal(chain.events.at(-1).signatures.length, 2, 'the old and the new key both signed');
  assert.equal((await sfGuard(root, ['revoke', approverId(ONE)], person(TWO.email, [keyTwo]), { reason: 'Left the team.' })).error, undefined);
  status = (await sfGuard(root, ['status'], person(TWO.email, [keyTwo]))).result;
  assert.equal(status.approvers.find((row) => row.approver === approverId(ONE)).state, 'not-required');
  assert.equal(status.approvers.find((row) => row.approver === approverId(ONE)).keyId, null);
});

test('guard: status reads in any turn; every other action is the person\'s own step', () => {
  assert.equal(resolveOperation({ requestedCommand: 'guard', positionals: ['guard', 'status'] }).classification, 'read');
  assert.equal(resolveOperation({ requestedCommand: 'guard', positionals: ['guard', 'enable'] }).classification, 'mutation');
  assert.equal(ownTerminalStep('singularity-flow guard status --json'), null);
  assert.equal(skillForCommandLine('singularity-flow guard status --json'), 'sf-guard');
  for (const action of ['register', 'rotate --key SHA256:x', 'recover --key SHA256:x', 'revoke approver-0123456789ab --reason x', 'enable', 'disable --reason x', 'exception add approver-0123456789ab']) {
    assert.equal(ownTerminalStep(`singularity-flow guard ${action}`), 'sf-guard-person-step', action);
    assert.equal(skillForCommandLine(`singularity-flow guard ${action}`), null, action);
  }
  assert.equal(SK_ECDSA_KEY_TYPE, 'sk-ecdsa-sha2-nistp256@openssh.com');
});

test('guard: a repository that never opts in reads as off with no file and no problem', async (t) => {
  const root = await repository(t);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const policy = await readPresencePolicy(root);
    assert.deepEqual([policy.present, policy.folded.enabled, policy.problems], [false, false, []]);
  } finally { process.chdir(previous); }
});
