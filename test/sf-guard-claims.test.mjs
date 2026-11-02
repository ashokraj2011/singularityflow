import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import { applicabilityDecision } from '../src/evidence/applicability.mjs';
import {
  approverId, foldPresenceChain, nextPresenceEvent, PRESENCE_CHAIN_PATH, presenceEventStatement
} from '../src/presence/chain.mjs';
import { believedProducer, forgetPersonCounts, presencePinKey, registerPersonCounts } from '../src/presence/counted.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { authorshipClaimVerdict, forgetPresenceContexts, loadPresenceContext, PRESENCE_RECORD_SCHEMA } from '../src/presence/person-records.mjs';
import { setPersonStepPresenceDependencies } from '../src/presence/person-steps.mjs';
import { presenceNonce, statementText } from '../src/presence/statement.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { CLI, specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard (SPEC-PSS-v1 §10.5): an authorship claim is a person's step. On a Story SF Guard requires,
// `phase publish --authored human|external-tool` is believed only with its author's presence
// signature, from any registered person (approver or author); an unsigned claim is recorded and
// checked as the agent's, and refused by nothing but the agent checks. Withdrawals are read by signed
// decision order, never from the unsigned `withdrawnAt`. Software stand-ins for the Secure Enclave
// are passed in-process; no environment switch reaches signing or verification.

const WORK = 'PSS-5';
const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };
const THREE = { email: 'author.three@example.com', githubLogin: 'author-three' };

function members(configuration) {
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [ONE, TWO];
}

function guardPerson(email, keys) {
  const byId = new Map(keys.map((key) => [key.keyId, key]));
  return {
    identify: () => ({ email, login: null }),
    listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(ctkListing(keys.map((key) => ({ keyId: key.keyId })))) }),
    readableCopies: () => [],
    publicKeyOf: async (keyId) => byId.get(keyId)?.line ?? null,
    githubKeys: async () => ({ status: 'listed', keys: keys.map((key) => ({ keyId: key.keyId, line: key.line })), snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString(), reason: null }),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => ({ signature: byId.get(keyId).sign(statementText(statement)), userVerification: false })
  };
}

function signer(key, overrides = {}) {
  const shown = [];
  return {
    shown,
    personTerminal: () => ({ person: true, reason: null }),
    signerAvailability: () => ({ available: true, reason: null }),
    holdsKey: async (keyId) => keyId === key.keyId,
    card: async (fields) => { shown.push(fields); return JSON.stringify(fields); },
    sign: async ({ statement }) => ({ signature: key.sign(statementText(statement)), userVerification: false }),
    ...overrides
  };
}

async function inRoot(root, action) {
  const previous = process.cwd();
  const log = console.log;
  const warn = console.warn;
  const lines = [];
  process.chdir(root);
  console.log = (line) => lines.push(String(line));
  console.warn = (line) => lines.push(String(line));
  try { return { value: await action(), lines }; }
  catch (error) { return { error, lines }; }
  finally { console.log = log; console.warn = warn; process.chdir(previous); }
}

async function sfGuard(root, words, options, deps) {
  const outcome = await inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps));
  assert.equal(outcome.error, undefined, outcome.error?.message);
}

const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

test('an author\'s key signs only their own key events and claims, never a policy event', async (t) => {
  const approver = softwarePresenceKey();
  const author = softwarePresenceKey();
  let chain = null;
  await startedSpecificationStory(t, 'PSS-6', {
    configure: members,
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      await sfGuard(root, ['register'], {}, guardPerson(ONE.email, [approver]));
      // Someone who is not an approver registers a key as an author, under their Git email.
      await sfGuard(root, ['register'], { author: true, 'github-login': THREE.githubLogin }, guardPerson(THREE.email, [author]));
      // An approver registering with --author is refused: their key is an approver's.
      const refused = await inRoot(root, () => guard(['guard', 'register'], { positionals: ['guard', 'register'], options: { json: true, author: true } }, guardPerson(ONE.email, [author])));
      assert.equal(refused.error?.code, 'PSS_ARGUMENT_INVALID');
      chain = JSON.parse(await readFile(path.join(root, PRESENCE_CHAIN_PATH), 'utf8'));
    }
  });
  const folded = foldPresenceChain(chain);
  const authorId = approverId({ email: THREE.email });
  assert.equal(folded.problems.length, 0, JSON.stringify(folded.problems));
  assert.equal(folded.pins.has(approverId(ONE)), true);
  assert.equal(folded.authorPins.get(authorId)?.keyId, author.keyId, 'the author\'s key is pinned as an author\'s');
  assert.equal(folded.pins.has(authorId), false, 'and never as an approver\'s');
  assert.equal(chain.events.at(-1).role, 'author');
  assert.equal(chain.events.at(-1).githubLogin, THREE.githubLogin, 'an author\'s key event names the login GitHub lists it under');

  // An exception, or turning SF Guard on, signed with the author's key does not verify: authors sign no policy event.
  for (const fields of [{ kind: 'exception', exception: { id: 'EXC-001', approver: approverId(TWO), reason: 'Windows: no presence signer yet' } },
    { kind: 'enable', remoteCheck: null, exceptions: [] }]) {
    const event = nextPresenceEvent(chain, fields);
    const entry = { signer: authorId, keyId: author.keyId, nonce: presenceNonce() };
    event.signatures.push({ ...entry, signature: author.sign(statementText(presenceEventStatement(chain.chainId, event, entry))) });
    const forged = foldPresenceChain({ ...chain, events: [...chain.events, event] });
    assert.equal(forged.validLength, chain.events.length, `${fields.kind} signed by an author does not count`);
    assert.equal(forged.problems[0].code, 'PSS_POLICY_UNSIGNED');
  }
  // An approver can revoke an author's key.
  const revoke = nextPresenceEvent(chain, { kind: 'revoke', approver: authorId, keyId: author.keyId, reason: 'Left the project.' });
  const entry = { signer: approverId(ONE), keyId: approver.keyId, nonce: presenceNonce() };
  revoke.signatures.push({ ...entry, signature: approver.sign(statementText(presenceEventStatement(chain.chainId, revoke, entry))) });
  const revoked = foldPresenceChain({ ...chain, events: [...chain.events, revoke] });
  assert.equal(revoked.problems.length, 0, JSON.stringify(revoked.problems));
  assert.equal(revoked.authorPins.has(authorId), false);
});

test('SF Guard required: a person\'s authorship claim is believed only when its author signs it', async (t) => {
  const approver = softwarePresenceKey();
  const author = softwarePresenceKey();
  const story = await startedSpecificationStory(t, WORK, {
    configure: members,
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      await sfGuard(root, ['register'], {}, guardPerson(ONE.email, [approver]));
      await sfGuard(root, ['register'], { author: true, 'github-login': THREE.githubLogin }, guardPerson(THREE.email, [author]));
      await sfGuard(root, ['enable'], { exception: [approverId(TWO)], 'remote-check': 'sf-guard-verify' }, guardPerson(ONE.email, [approver]));
      git('add', PRESENCE_CHAIN_PATH, '.github/agents');
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
  const { root, git, cli, item } = story;
  assert.equal((await workflowOf(item)).resolution.presence.status, 'required');
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(WORK, 1));
  cli('artifact', 'scan', '--phase', 'specification');

  // From a script, the claim is unsigned: not believed, and nothing refuses it but the agent checks,
  // which an agent's draft without its clarification record fails. Nothing is written.
  const before = git('rev-parse', 'HEAD');
  const scripted = spawnSync(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place'],
    { cwd: root, encoding: 'utf8', timeout: childTimeout(60_000), env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: ONE.name } });
  assert.notEqual(scripted.status, 0, scripted.stdout);
  assert.match(scripted.stderr + scripted.stdout, /believes a human authorship claim only with its author's presence signature[\s\S]*recorded and checked as the agent's \(governed-agent\)/u);
  assert.match(scripted.stderr + scripted.stdout, /clarification/u, 'the agent checks ran');
  assert.equal(git('rev-parse', 'HEAD'), before);
  assert.equal((await workflowOf(item)).phases.specification.generation ?? 0, 0);

  // The author, who is not an approver, signs the claim in their own terminal: one card, one touch.
  git('config', 'user.email', THREE.email);
  const person = signer(author);
  forgetPresenceContexts();
  setPersonStepPresenceDependencies(person);
  const published = await inRoot(root, () => main(['phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place', '--json']));
  setPersonStepPresenceDependencies({});
  git('config', 'user.email', ONE.email);
  assert.equal(published.error, undefined, `${published.error?.message}\n${published.lines.join('\n')}`);
  assert.equal(person.shown.length, 1);
  assert.match(person.shown[0].title, /claim authorship of PSS-5 \/ specification/u);
  const workflow = await workflowOf(item);
  const authorship = workflow.phases.specification.authorship.at(-1);
  assert.equal(authorship.producer, 'human');
  assert.equal(authorship.presence.approver, approverId({ email: THREE.email }));
  assert.equal(authorship.presence.claim.artifactSha256, authorship.source.sha256, 'the claim binds the artifact the author published');
  forgetPresenceContexts();
  const context = await loadPresenceContext(root, workflow);
  const where = { workflow, phase: 'specification', generation: workflow.phases.specification.generation };
  assert.equal(authorshipClaimVerdict(context, authorship, where).state, 'signed');
  assert.equal(believedProducer(workflow, authorship, where), 'human');

  // Changed after signing, or written by hand without one, the claim is read as the agent's.
  assert.equal(believedProducer(workflow, { ...authorship, producer: 'external-tool' }, where), 'governed-agent');
  assert.equal(believedProducer(workflow, { ...authorship, presence: { ...authorship.presence, claim: { ...authorship.presence.claim, generation: 9 } } }, where), 'governed-agent');
  const { presence: _presence, ...unsigned } = authorship;
  assert.equal(authorshipClaimVerdict(context, unsigned, where).state, 'unsigned');
  assert.equal(believedProducer(workflow, unsigned, where), 'governed-agent');
  // An agent's own record claims nothing, and is read as it is.
  assert.equal(believedProducer(workflow, { ...unsigned, producer: 'governed-agent' }, where), 'governed-agent');

  // A per-person exception covers its author's claim unsigned, labelled as a bypass.
  const excepted = { producer: 'human', channel: 'manual-in-place', actor: { email: TWO.email }, source: null,
    presence: { schema: PRESENCE_RECORD_SCHEMA, chainId: context.chainId, approver: approverId(TWO), action: 'authorship.human', bypass: 'EXC-001',
      at: new Date().toISOString(), claim: { workId: WORK, phase: 'specification', generation: where.generation, producer: 'human', channel: 'manual-in-place', artifactSha256: null, importSha256: null } } };
  const bypass = authorshipClaimVerdict(context, excepted, where);
  assert.deepEqual([bypass.state, bypass.label], ['bypass', 'bypass: per-person exception EXC-001']);
});

test('withdrawals are read by signed decision order on a Story SF Guard requires', () => {
  const pin = { schema: 'sflow-presence-pin@1', status: 'required' };
  const base = { workItem: { id: 'PSS-W' }, resolution: { presence: pin } };
  const older = { responsibility: 'deploy', reason: 'Older decision.', actor: 'a@example.com', at: '2026-11-01T10:00:00.000Z' };
  const newer = { responsibility: 'deploy', reason: 'Newer decision.', actor: 'a@example.com', at: '2026-11-02T10:00:00.000Z' };
  forgetPersonCounts();
  const tampered = { ...base, applicability: [{ ...newer, withdrawnAt: '2026-11-03T00:00:00.000Z' }, older] };
  registerPersonCounts(presencePinKey(tampered), () => true);
  // Removing the older record's withdrawal and adding one to the newer, and moving the older last,
  // revives nothing: the newer signed decision stands.
  assert.equal(applicabilityDecision(tampered, 'deploy')?.reason, 'Newer decision.');
  forgetPersonCounts();
  // Without SF Guard the field is read as before.
  const plain = { workItem: { id: 'PSS-W' }, resolution: {}, applicability: [{ ...older, withdrawnAt: '2026-11-02T10:00:00.000Z' }, newer] };
  assert.equal(applicabilityDecision(plain, 'deploy')?.reason, 'Newer decision.');
  assert.equal(applicabilityDecision({ ...plain, applicability: [{ ...newer, withdrawnAt: '2026-11-03T00:00:00.000Z' }] }, 'deploy'), null);
});
