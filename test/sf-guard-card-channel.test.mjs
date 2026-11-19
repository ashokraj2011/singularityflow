/**
 * SF Guard's card on SFlow's own cards [owner, 2026-11-19: "the Decide card and the approval page may sign directly
 * with Touch ID"]. The host reads the card (`guard card`), shows it, and starts the record with its digest; the CLI
 * rebuilds the card, refuses with nothing written when it differs, and only then signs without a terminal. An agent's
 * marker still refuses, as does a record with no card, and the Copilot hook refuses the flags in any chat.
 *
 * Every signer here is a software stand-in passed in-process (test/helpers/presence-keys.mjs): no test reaches
 * ssh-keygen, sc_auth, Touch ID or the Keychain. The real signer is exercised with a stand-in for ssh-keygen.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveOperation } from '../src/command-registry.mjs';
import { ownTerminalStep } from '../src/command-skills.mjs';
import { main } from '../src/cli.mjs';
import { approveFromCard } from '../src/commands/approve.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import { personStepDenial } from '../src/copilot-mutation-guard.mjs';
import {
  cardSurface, decisionsCardFields, guardCard, guardCardFor, matchCard, PRESENCE_RULE, SF_GUARD_OFFER, withCardSurface
} from '../src/presence/card-channel.mjs';
import { PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts, personBatchStatement, personCardShown } from '../src/presence/person-records.mjs';
import { setPersonStepPresenceDependencies } from '../src/presence/person-steps.mjs';
import { signWithPresence } from '../src/presence/signer.mjs';
import { PRESENCE_NAMESPACE, verifyPresenceSignature } from '../src/presence/sshsig.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const MARKERS = ['COPILOT_CLI', 'AI_AGENT'];
const ZERO = `sha256:${'0'.repeat(64)}`;

/** No Copilot marker in this process, as in the VS Code extension host; restored after the test. */
function withoutAgentMarkers(t) {
  const saved = Object.fromEntries(MARKERS.map((name) => [name, process.env[name]]));
  for (const name of MARKERS) delete process.env[name];
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
}

const terminal = (isTTY) => {
  const written = [];
  return { isTTY, written, write: (text) => { written.push(String(text)); return true; } };
};

/** A stand-in for /usr/bin/ssh-keygen: `-K` writes the key's stub, `-Y sign` signs with the software key. Nothing real runs. */
function fakeKeygen(key) {
  const calls = [];
  const exec = (program, args, options) => {
    calls.push(args[0]);
    if (args.includes('-K')) {
      writeFileSync(path.join(options.cwd, 'id_ecdsa_sk_rk.pub'), `${key.line} sf-guard\n`);
      writeFileSync(path.join(options.cwd, 'id_ecdsa_sk_rk'), 'stub\n');
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: key.sign(options.input), stderr: '' };
  };
  return { exec, calls };
}

test('the card a host shows has one digest for its words, its key and the facts they stand for', () => {
  const fields = decisionsCardFields({ workId: 'CC-1', summary: ['d1. Approve AMD-001: Approve. Records: the amendment.'], packetSha256: `sha256:${'1'.repeat(64)}` });
  assert.equal(fields.title, 'record a decision on CC-1');
  assert.equal(decisionsCardFields({ workId: 'CC-1', summary: ['a', 'b'], packetSha256: null }).title, 'record 2 decisions on CC-1');
  const card = guardCard({ ...fields, keyId: 'SHA256:one' });
  assert.equal(card.rule, PRESENCE_RULE);
  assert.match(card.cardSha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(guardCard({ ...fields, keyId: 'SHA256:one' }).cardSha256, card.cardSha256, 'the same card, the same digest');
  for (const changed of [{ ...fields, keyId: 'SHA256:two' }, { ...fields, keyId: 'SHA256:one', lines: [...fields.lines, 'more'] },
    { ...fields, keyId: 'SHA256:one', bound: { decisionList: ZERO } }]) {
    assert.notEqual(guardCard(changed).cardSha256, card.cardSha256);
  }
});

test('a host card applies to the one command started with it, and only once its card matched', async () => {
  assert.equal(cardSurface(), null);
  await assert.rejects(() => withCardSurface({ 'presence-card': 'chat', 'card-sha256': ZERO }, async () => {}), { code: 'PSS_ARGUMENT_INVALID' });
  await assert.rejects(() => withCardSurface({ 'presence-card': 'vscode-card', 'card-sha256': 'abc' }, async () => {}), { code: 'PSS_ARGUMENT_INVALID' });
  assert.equal(await withCardSurface({}, async () => cardSurface()), null, 'no flags: nothing changes');
  const card = guardCard({ title: 't', lines: ['l'], keyId: 'SHA256:k' });
  await withCardSurface({ 'presence-card': 'vscode-card', 'card-sha256': card.cardSha256 }, async () => {
    assert.deepEqual(cardSurface(), { surface: 'vscode-card', cardSha256: card.cardSha256, matched: false });
    assert.throws(() => matchCard(guardCard({ title: 't', lines: ['other'], keyId: 'SHA256:k' })), { code: 'PSS_CARD_CHANGED' });
    assert.equal(cardSurface().matched, false);
    assert.equal(matchCard(card), true);
    assert.equal(cardSurface().matched, true);
  });
  assert.equal(cardSurface(), null, 'never outlives its command');
});

test('an agent\'s marker refuses a host card as it refuses a terminal; an unmatched card never stands in for one', (t) => {
  withoutAgentMarkers(t);
  const noTerminal = { stdin: { isTTY: false }, stderr: { isTTY: false } };
  const matched = { surface: 'vscode-card', cardSha256: ZERO, matched: true };
  assert.deepEqual(personCardShown({ ...noTerminal, env: {}, surface: matched }), { person: true, reason: null, surface: 'vscode-card' });
  for (const marker of MARKERS) {
    assert.deepEqual(personCardShown({ ...noTerminal, env: { [marker]: '1' }, surface: matched }), { person: false, reason: 'an agent started this command' });
  }
  assert.equal(personCardShown({ ...noTerminal, env: {}, surface: { ...matched, matched: false } }).person, false);
  assert.match(personCardShown({ ...noTerminal, env: {}, surface: null }).reason, /no terminal/u);
  assert.equal(personCardShown({ stdin: { isTTY: true }, stderr: { isTTY: true }, env: {}, surface: null }).person, true, 'the person\'s own terminal, as before');
});

test('the real signer takes a matched host card in place of a terminal, with the card on stderr, and nothing else', async () => {
  const key = softwarePresenceKey();
  const statement = { schema: 'pss-statement/1', repository: 'presence:test', subject: { kind: 'self-test', id: 'card' }, step: null, generation: null,
    action: 'self-test', decision: {}, reviewed: {}, actor: { approver: 'approver-000000000000' }, authorityGroup: null, at: new Date().toISOString(), nonce: '0'.repeat(32), keyId: key.keyId };
  const request = { statement, keyId: key.keyId, publicKey: key.line, card: '\nSF Guard: self-test\n', availability: { available: true, reason: null } };
  // No terminal and no card: refused before ssh-keygen runs.
  const none = fakeKeygen(key);
  await assert.rejects(() => signWithPresence({ ...request, terminal: terminal(false), exec: none.exec, surface: null }), { code: 'PSS_CARD_NOT_SHOWN' });
  await assert.rejects(() => signWithPresence({ ...request, terminal: terminal(false), exec: none.exec, surface: { surface: 'vscode-card', cardSha256: ZERO, matched: false } }), { code: 'PSS_CARD_NOT_SHOWN' });
  assert.deepEqual(none.calls, []);
  // A matched card: one JSON line on stderr carries the card, then the signature, verified.
  const host = terminal(false);
  const keygen = fakeKeygen(key);
  const signed = await signWithPresence({ ...request, terminal: host, exec: keygen.exec, surface: { surface: 'vscode-card', cardSha256: ZERO, matched: true } });
  assert.deepEqual(keygen.calls, ['-w', '-Y']);
  assert.equal(host.written.length, 1);
  assert.deepEqual(JSON.parse(host.written[0]), { sfGuardCard: { surface: 'vscode-card', cardSha256: ZERO, text: request.card } });
  assert.equal(verifyPresenceSignature({ message: statementText(statement), armored: signed.signature, publicKey: key.line }).valid, true);
  // The person's own terminal: the card itself, as before.
  const own = terminal(true);
  await signWithPresence({ ...request, terminal: own, exec: fakeKeygen(key).exec, surface: null });
  assert.deepEqual(own.written, [request.card]);
});

test('the Copilot hook refuses the card flags in any chat; guard card reads and guard setup is the person\'s own step', (t) => {
  withoutAgentMarkers(t);
  const cwd = os.tmpdir();
  for (const command of [`singularity-flow decisions record CC-1 --answers /tmp/a.json --presence-card vscode-card --card-sha256 ${ZERO}`,
    `singularity-flow approve specification --work-id CC-1 --card-sha256=${ZERO} --presence-card=vscode-approval`]) {
    const refused = personStepDenial({ cwd, toolName: 'bash', toolArgs: { command, cwd } });
    assert.equal(refused?.permissionDecision, 'deny', command);
    assert.match(refused.permissionDecisionReason, /--presence-card and --card-sha256 are for SFlow's own Decide card and approval page/u, command);
    assert.doesNotMatch(JSON.stringify(refused.next ?? []), /presence-card|card-sha256/u, 'the route given is the person\'s own command, without the card\'s flags');
  }
  assert.equal(resolveOperation({ requestedCommand: 'guard', positionals: ['guard', 'card', 'decisions', 'CC-1'] }).classification, 'read');
  assert.equal(resolveOperation({ requestedCommand: 'guard', positionals: ['guard', 'setup'] }).classification, 'mutation');
  assert.equal(ownTerminalStep('singularity-flow guard setup'), 'sf-guard-person-step');
});

test('a Story SF Guard does not require has no card; where the repository never opted in, a Mac that signs is offered it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-card-off-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  forgetPresenceContexts();
  const workflow = { workItem: { id: 'OFF-1' }, resolution: {} };
  const fields = () => { throw new Error('nothing is read for a card that does not exist'); };
  const mac = await guardCardFor(root, workflow, { actor: ONE, fields, dependencies: { signerAvailability: () => ({ available: true, reason: null }) } });
  assert.deepEqual(mac, { required: false, signs: false, state: 'off', offer: SF_GUARD_OFFER });
  forgetPresenceContexts();
  const linux = await guardCardFor(root, workflow, { actor: ONE, fields, dependencies: { signerAvailability: () => ({ available: false, reason: 'presence signing needs macOS' }) } });
  assert.equal(linux.offer, null, 'never offered where it cannot sign');
  assert.match(SF_GUARD_OFFER, /singularity-flow guard setup/u);
});

// SF Guard's readers for one person at a Mac holding `key`, in this process.
function guardPerson(email, keys) {
  const byId = new Map(keys.map((key) => [key.keyId, key]));
  return {
    identify: () => ({ email, login: null }),
    listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(ctkListing(keys.map((key) => ({ keyId: key.keyId })))) }),
    readableCopies: () => [], publicKeyOf: async (keyId) => byId.get(keyId)?.line ?? null,
    githubKeys: async () => ({ status: 'listed', keys: keys.map((key) => ({ keyId: key.keyId, line: key.line })), snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString(), reason: null }),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => ({ signature: byId.get(keyId).sign(statementText(statement)), userVerification: false }),
    requiredCheck: async () => ({ status: 'unavailable', contexts: [], reason: 'not read in this test' })
  };
}

/** The signer's readers as the extension host has them: no terminal override, so the CLI's own check decides. */
function cardSigner(key) {
  const shown = [];
  const signed = [];
  return {
    shown, signed,
    signerAvailability: () => ({ available: true, reason: null }),
    holdsKey: async (keyId) => keyId === key.keyId,
    card: async (fields) => { shown.push(fields); return JSON.stringify(fields); },
    sign: async ({ statement }) => { signed.push(statement); return { signature: key.sign(statementText(statement)), userVerification: false }; }
  };
}

async function inRoot(root, action) {
  const previous = process.cwd();
  const [log, warn] = [console.log, console.warn];
  const lines = [];
  process.chdir(root);
  console.log = (line) => lines.push(String(line)); console.warn = () => {};
  try { return { value: await action(), lines }; } catch (error) { return { error, lines }; } finally { console.log = log; console.warn = warn; process.chdir(previous); }
}

/** One CLI command in this process, with `presence` as the signer's readers. */
async function asHost(root, presence, argv) {
  forgetPresenceContexts();
  setPersonStepPresenceDependencies({ ...presence, argv: ['node', 'singularity-flow', ...argv] });
  return inRoot(root, () => main([...argv, '--json']));
}

/** `guard card …` in this process, read as the host reads it. */
async function readCard(root, presence, words, options) {
  forgetPresenceContexts();
  setPersonStepPresenceDependencies(presence);
  const outcome = await inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }));
  assert.equal(outcome.error, undefined, outcome.error?.message);
  return JSON.parse(outcome.lines.join('\n'));
}

test('from the card: guard setup turns it on, the approval page and the Decide card sign with no terminal once their card matches, and nothing else does',
  { timeout: 300_000 }, async (t) => {
    withoutAgentMarkers(t);
    t.after(() => setPersonStepPresenceDependencies({}));
    const work = 'CC-7';
    const key = softwarePresenceKey();
    let setup = null;
    const { root, git, cli, item } = await startedSpecificationStory(t, work, {
      configure: (configuration) => { for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [ONE]; },
      beforeStart: async ({ root: at, git: inGit }) => {
        inGit('config', 'user.email', ONE.email);
        // One step: the identity and GitHub's listing are read, then register and enable each take one touch.
        setup = await inRoot(at, () => guard(['guard', 'setup'], { positionals: ['guard', 'setup'], options: {} }, guardPerson(ONE.email, [key])));
        assert.equal(setup.error, undefined, setup.error?.message);
        assert.ok(existsSync(path.join(at, '.github/workflows/sf-guard-verify.yml')), 'the CI recipe is written');
        inGit('add', PRESENCE_CHAIN_PATH, 'singularity/agents', '.github');
        inGit('commit', '-qm', 'Turn SF Guard on');
        inGit('push', '-q', 'origin', 'main');
      }
    });
    const said = setup.lines.join('\n');
    assert.match(said, /1\. This Mac signs with Touch ID identity/u);
    assert.match(said, /SF Guard recorded register .* \(event 0\)/u);
    assert.match(said, /SF Guard recorded enable \(event 1\)/u);
    assert.match(said, /make "sf-guard-verify" a required status check/u);
    const chain = JSON.parse(await readFile(path.join(root, PRESENCE_CHAIN_PATH), 'utf8'));
    assert.deepEqual(chain.events.map((event) => event.kind), ['register', 'enable']);
    assert.equal(chain.events[1].remoteCheck, 'sf-guard-verify');

    // Run again, it has nothing left to do.
    const again = await inRoot(root, () => guard(['guard', 'setup'], { positionals: ['guard', 'setup'], options: {} }, guardPerson(ONE.email, [key])));
    assert.equal(again.error, undefined, again.error?.message);
    assert.match(again.lines.join('\n'), /already pinned[\s\S]*already on[\s\S]*already there/u);

    // The specification, published and submitted, waits for its approval.
    await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(work, 1));
    cli('artifact', 'scan', '--phase', 'specification');
    const published = await asHost(root, { ...cardSigner(key), personTerminal: () => ({ person: true, reason: null }) },
      ['phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place']);
    assert.equal(published.error, undefined, published.error?.message);
    cli('submit', 'specification', '--skip-checks');
    const status = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.specification;

    // The approval page's card: the step, its version and the decision, never a digest to read.
    const host = cardSigner(key);
    const approval = await readCard(root, host, ['card', 'approve', work], { phase: 'specification' });
    assert.deepEqual([approval.required, approval.signs, approval.surface, approval.keyId], [true, true, 'vscode-approval', key.keyId]);
    assert.equal(approval.card.title, `approve ${work} / specification`);
    assert.deepEqual(approval.card.lines.slice(0, 2), ['Step: Specification, generation 1', 'Decision: approved']);
    assert.doesNotMatch(approval.card.lines.join('\n'), /sha256:/u);
    const approve = (digest, presence = host) => {
      forgetPresenceContexts();
      setPersonStepPresenceDependencies(presence);
      return inRoot(root, () => approveFromCard(['approve', 'specification'],
        { yes: true, 'presence-card': 'vscode-approval', 'card-sha256': digest }, { presence }));
    };
    const before = git('rev-parse', 'HEAD');
    const stale = await approve(ZERO);
    assert.equal(stale.error?.code, 'PSS_CARD_CHANGED', stale.error?.message);
    assert.equal(git('rev-parse', 'HEAD'), before, 'nothing written');
    assert.equal(host.signed.length, 0, 'nothing signed');
    process.env.AI_AGENT = 'github_copilot_vscode_agent';
    const agent = await approve(approval.cardSha256);
    delete process.env.AI_AGENT;
    assert.equal(agent.error?.code, 'PSS_CARD_NOT_SHOWN', agent.error?.message);
    assert.equal(host.signed.length, 0);
    const approved = await approve(approval.cardSha256);
    assert.equal(approved.error, undefined, approved.error?.message);
    assert.equal(host.signed.length, 1, 'one touch, from the card');
    const record = (await status()).approvals.at(-1);
    assert.equal(record.identityAssurance, 'presence-signed');
    assert.equal(record.presence.keyId, key.keyId);

    // The Decide card: an amendment decided there.
    const candidate = path.join(path.dirname(root), 'amended-spec.md');
    await writeFile(candidate, specification(work, 2));
    cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.');
    const packet = JSON.parse(cli('decisions', work, '--json').stdout).data;
    const decision = packet.items.find((entry) => entry.kind === 'intent-amendment');
    const answers = path.join(path.dirname(root), 'answers.json');
    await writeFile(answers, JSON.stringify({ choose: { [decision.id]: 'approve' }, confirm: packet.packetSha256 }));
    const decide = cardSigner(key);
    const card = await readCard(root, decide, ['card', 'decisions', work], { answers });
    assert.deepEqual([card.required, card.signs, card.surface, card.keyId], [true, true, 'vscode-card', key.keyId]);
    assert.equal(card.card.title, `record a decision on ${work}`);
    assert.match(card.card.lines[0], new RegExp(`^${decision.id}\\. `, 'u'));
    const recordArgv = ['decisions', 'record', work, '--answers', answers];
    const head = git('rev-parse', 'HEAD');
    const amendment = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).intentAmendments[0];

    // A record with no card and no terminal, a card that differs, and an agent's card: each refused, nothing written.
    assert.equal((await asHost(root, decide, recordArgv)).error?.code, 'PSS_CARD_NOT_SHOWN');
    assert.equal((await asHost(root, decide, [...recordArgv, '--presence-card', 'vscode-card', '--card-sha256', ZERO])).error?.code, 'PSS_CARD_CHANGED');
    process.env.COPILOT_CLI = '1';
    const copilot = await asHost(root, decide, [...recordArgv, '--presence-card', 'vscode-card', '--card-sha256', card.cardSha256]);
    delete process.env.COPILOT_CLI;
    assert.equal(copilot.error?.code, 'PSS_CARD_NOT_SHOWN', copilot.error?.message);
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal((await amendment()).status, 'proposed');
    assert.equal(decide.signed.length, 0, 'no touch was asked for');

    // The card the person read: signed with no terminal, one touch, and the signature verifies against the pinned key.
    const recorded = await asHost(root, decide, [...recordArgv, '--presence-card', 'vscode-card', '--card-sha256', card.cardSha256]);
    assert.equal(recorded.error, undefined, recorded.error?.message);
    assert.equal(decide.signed.length, 1);
    const signed = await amendment();
    assert.equal(signed.status, 'approved');
    const presence = signed.decision.presence;
    assert.equal(presence.keyId, key.keyId);
    const statement = personBatchStatement(presence, { chainId: chain.chainId, workId: work });
    assert.equal(verifyPresenceSignature({ message: statementText(statement), armored: presence.signature, publicKey: key.line }).valid, true);
    assert.notEqual(git('rev-parse', 'HEAD'), head, 'committed');
    assert.equal(PRESENCE_NAMESPACE, 'singularity-flow-person-step@1');
  });
