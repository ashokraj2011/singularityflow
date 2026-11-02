import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { run as guard } from '../src/commands/guard.mjs';
import { approverId, PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { countedRecords } from '../src/presence/counted.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts, loadPresenceContext, personRecordVerdict, sealedPresence } from '../src/presence/person-records.mjs';
import {
  familyRecords, isPersonStepRecord, PERSON_STEP_FAMILIES, setPersonStepPresenceDependencies, signNewPersonRecords
} from '../src/presence/person-steps.mjs';
import { personRecordRoute, storyPersonRecords } from '../src/presence/story-verify.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { assertSignedTestCommandAmendments } from '../src/story-test-command-amendment.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard (SPEC-PSS-v1 §10.8): a test-policy amendment, an approver refresh, a test selection and a
// test-run risk review keep their person's presence signature: the two immutable summaries as a seal in
// `personSeals`, found again by the summary's digest; the two test-recovery entries on the entry itself.
// Readers count only a verified one, and the remote check lists them with the Story's other person
// records. Software stand-ins for the Secure Enclave and GitHub are passed in-process.

const WORK = 'PSS-SS';
const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };
const sha = (letter) => `sha256:${letter.repeat(64)}`;

function members(configuration) {
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [ONE, TWO];
}

const snapshot = (keys) => ({ status: 'listed', keys: keys.map((key) => ({ keyId: key.keyId, line: key.line })),
  snapshotSha256: sha('a'), fetchedAt: new Date().toISOString(), reason: null });

function guardPerson(email, keys) {
  const byId = new Map(keys.map((key) => [key.keyId, key]));
  return {
    identify: () => ({ email, login: null }),
    listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(ctkListing(keys.map((key) => ({ keyId: key.keyId })))) }),
    readableCopies: () => [],
    publicKeyOf: async (keyId) => byId.get(keyId)?.line ?? null,
    githubKeys: async () => snapshot(keys),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => ({ signature: byId.get(keyId).sign(statementText(statement)), userVerification: false }),
    requiredCheck: async () => ({ status: 'not-required', contexts: ['build'], reason: null })
  };
}

function signer(key, email = ONE.email) {
  const shown = [];
  return {
    shown,
    identify: async () => ({ email, login: null }),
    personTerminal: () => ({ person: true, reason: null }),
    signerAvailability: () => ({ available: true, reason: null }),
    holdsKey: async (keyId) => keyId === key.keyId,
    card: async (fields) => { shown.push(fields); return JSON.stringify(fields); },
    sign: async ({ statement }) => ({ signature: key.sign(statementText(statement)), userVerification: false })
  };
}

async function inRoot(root, action) {
  const previous = process.cwd();
  const log = console.log;
  process.chdir(root);
  console.log = () => {};
  try { return { value: await action() }; }
  catch (error) { return { error }; }
  finally { console.log = log; process.chdir(previous); }
}

async function guardRun(root, words, deps, options = {}) {
  const outcome = await inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps));
  assert.equal(outcome.error, undefined, outcome.error?.message);
}

/** A repository with SF Guard on (ONE's key pinned, TWO under an exception), and a Story pinned required. */
async function guardedStory(t, key) {
  return startedSpecificationStory(t, WORK, {
    configure: members,
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      await guardRun(root, ['register'], guardPerson(ONE.email, [key]));
      await guardRun(root, ['enable'], guardPerson(ONE.email, [key]), { exception: [approverId(TWO)], 'remote-check': 'sf-guard-verify' });
      git('add', PRESENCE_CHAIN_PATH, '.github/agents');
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
}

const amendment = (id, phaseId = 'specification') => ({ schemaVersion: 1, kind: 'test-command-adoption-summary', id, phaseId, status: 'approved',
  decisionPath: `singularity/work-items/${WORK}/context/test-command-amendments/${id}/decision.json`, decisionSha256: sha('b'),
  reviewPath: `singularity/work-items/${WORK}/context/test-command-amendments/${id}/review.json`, reviewSha256: sha('c'),
  from: { validationEpoch: 0 }, to: { validationEpoch: 1, commandInventorySha256: sha('d') }, decidedAt: new Date().toISOString() });
const refresh = (id) => ({ schemaVersion: 1, kind: 'approver-refresh-summary', id, status: 'approved',
  decisionPath: `singularity/work-items/${WORK}/context/approver-refreshes/${id}.json`, decisionSha256: sha('e'),
  from: { revision: 1 }, to: { revision: 2 }, additions: [{ group: 'product-approvers', members: ['new.member@example.com'] }], decidedAt: new Date().toISOString() });
const riskReview = (letter) => ({ action: 'accepted', planDigest: sha(letter), record: { recordSha256: sha(letter) },
  authorityReceipt: { recordSha256: sha('f') }, reviewedAt: new Date().toISOString() });
const selection = (letter) => ({ planDigest: sha(letter), phaseId: 'implementation', generation: 1, validationEpoch: 0,
  confirmedAt: new Date().toISOString(), selection: { recordSha256: sha(letter) }, authorityReceipt: { recordSha256: sha('f') } });

test('the four lists are person-step families, found where they live', () => {
  const byList = new Map(PERSON_STEP_FAMILIES.map((family) => [family.list, family]));
  assert.equal(byList.get('testCommandAmendments').sealed, true, 'an immutable summary keeps its signature as a seal');
  assert.equal(byList.get('approverRefreshes').sealed, true);
  assert.equal(isPersonStepRecord('testCommandAmendments', amendment('TCA-001')), true);
  assert.equal(isPersonStepRecord('approverRefreshes', refresh('APR-001')), true);
  assert.equal(isPersonStepRecord('testRecovery.riskReviews', riskReview('a')), true);
  assert.equal(isPersonStepRecord('testRecovery.selectionConfirmations', selection('a')), true);
  const workflow = { testRecovery: { riskReviews: [riskReview('a')], selectionConfirmations: [selection('b')] } };
  assert.equal(familyRecords(workflow, byList.get('testRecovery.riskReviews')).length, 1, 'a nested list is read through its path');
  assert.deepEqual(familyRecords({}, byList.get('testRecovery.riskReviews')), [], 'and an absent one is empty');
});

test('SF Guard on: each summary and entry is signed once at save, and counts only while it verifies', async (t) => {
  const key = softwarePresenceKey();
  const { root, item } = await guardedStory(t, key);
  t.after(() => { setPersonStepPresenceDependencies({}); forgetPresenceContexts(); });
  forgetPresenceContexts();
  const file = path.join(item, 'workflow.json');
  const workflow = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(workflow.resolution.presence.status, 'required');
  await loadPresenceContext(root, workflow);

  workflow.testCommandAmendments = [amendment('TCA-001')];
  workflow.approverRefreshes = [refresh('APR-001')];
  workflow.testRecovery = { ...(workflow.testRecovery ?? {}), riskReviews: [riskReview('a')], selectionConfirmations: [selection('b')] };
  const deps = signer(key);
  setPersonStepPresenceDependencies(deps);
  await signNewPersonRecords(root, workflow, file);
  assert.equal(deps.shown.length, 1, 'one card and one touch for every record the command added');
  assert.equal(deps.shown[0].lines.filter((line) => !line.startsWith('Records:')).length, 4);

  const [tca] = workflow.testCommandAmendments;
  const [apr] = workflow.approverRefreshes;
  assert.equal(tca.presence, undefined, 'an immutable summary is left exactly as its family defines it');
  assert.equal(apr.presence, undefined);
  assert.equal(workflow.personSeals.length, 2, 'their signatures are seals beside them');
  assert.deepEqual(workflow.personSeals.map((seal) => seal.list).sort(), ['approverRefreshes', 'testCommandAmendments']);
  assert.equal(sealedPresence(workflow, tca).approver, approverId(ONE), 'a record that names no actor is its signer\'s decision');
  assert.equal(workflow.testRecovery.riskReviews[0].presence.approver, approverId(ONE), 'a test-recovery entry keeps its own block');

  forgetPresenceContexts();
  await loadPresenceContext(root, workflow);
  for (const list of [workflow.testCommandAmendments, workflow.approverRefreshes, workflow.testRecovery.riskReviews, workflow.testRecovery.selectionConfirmations]) {
    assert.equal(countedRecords(workflow, list).length, 1, 'a signed record counts');
  }
  await assertSignedTestCommandAmendments(workflow);

  assert.deepEqual(countedRecords(workflow, [{ ...tca, to: { ...tca.to, validationEpoch: 9 } }]), [], 'an edited summary no longer matches its seal');
  assert.deepEqual(countedRecords(workflow, [amendment('TCA-002')]), [], 'a summary written by hand has no seal');
  assert.deepEqual(countedRecords(workflow, [{ ...riskReview('z'), presence: workflow.testRecovery.riskReviews[0].presence }]), [],
    'a signature carried to another entry breaks');
  const context = await loadPresenceContext(root, workflow);
  assert.equal(personRecordVerdict(context, amendment('TCA-003'), { workflow }).code, 'PSS_RECORD_UNSIGNED');

  // The person record list the final check and the remote check read includes all four.
  const listed = storyPersonRecords(workflow).map((entry) => entry.list);
  for (const list of ['testCommandAmendments', 'approverRefreshes', 'testRecovery.riskReviews', 'testRecovery.selectionConfirmations']) {
    assert.ok(listed.includes(list), `${list} is re-verified with the Story's other person records`);
  }
  assert.match(personRecordRoute(workflow, { list: 'testCommandAmendments', record: tca }), /story test-policy amend --work-id PSS-SS/u);
  assert.match(personRecordRoute(workflow, { list: 'testRecovery.riskReviews', record: riskReview('a') }), /story test-policy accept-risk/u);

  // An unsigned amendment refuses publication and submission, with the person's route.
  workflow.testCommandAmendments.push(amendment('TCA-004'));
  await assert.rejects(assertSignedTestCommandAmendments(workflow), (error) => error.code === 'PSS_RECORD_UNSIGNED'
    && /TCA-004/u.test(error.message) && /test-policy amend --work-id PSS-SS --phase specification/u.test(error.details.nextAction.command));

  // Under a per-person exception the summary is sealed unsigned, labelled as a bypass, and counts.
  forgetPresenceContexts();
  await loadPresenceContext(root, workflow);
  const prior = path.join(item, 'prior-state.json');
  await writeFile(prior, JSON.stringify(workflow));
  workflow.testCommandAmendments.push(amendment('TCA-005'));
  setPersonStepPresenceDependencies(signer(key, TWO.email));
  await signNewPersonRecords(root, workflow, prior);
  const bypass = sealedPresence(workflow, workflow.testCommandAmendments.at(-1));
  assert.equal(bypass.bypass.startsWith('EXC-'), true, 'an exception seal carries its exception, never a signature');
  assert.equal(countedRecords(workflow, [workflow.testCommandAmendments.at(-1)]).length, 1);
});

test('SF Guard off, or no pin: nothing is signed, sealed or refused', async () => {
  const workflow = { workItem: { id: WORK }, resolution: {}, testCommandAmendments: [amendment('TCA-001')],
    testRecovery: { riskReviews: [riskReview('a')] } };
  assert.equal(countedRecords(workflow, workflow.testCommandAmendments).length, 1, 'no pin: every record counts, as before');
  await assertSignedTestCommandAmendments(workflow);
  await signNewPersonRecords('/nonexistent', { ...workflow, resolution: {} }, '/nonexistent/workflow.json').catch(() => {});
  assert.equal(workflow.personSeals, undefined);
});

test('each review asks for one touch, at the record, and its reader counts only a signed one', async () => {
  const read = (file) => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  for (const [file, label] of [['commands/story-test-selection.mjs', 'Confirm test scope'], ['story-test-risk.mjs', 'Accept Story test risk'],
    ['story-baseline-admission.mjs', 'Re-review baseline admission'], ['story-test-command-amendment.mjs', 'Amend test command'],
    ['story-approver-refresh.mjs', 'Refresh approvers']]) {
    assert.match(await read(file), new RegExp(`label: '${label}', presenceInRecord: true`, 'u'), `${label} skips the card-only touch`);
  }
  assert.match(await read('story-test-risk.mjs'), /'Revoke Story test risk', presenceInRecord: true/u);
  assert.match(await read('trp-delivery-selection.mjs'), /countedRecords\(workflow, workflow\.testRecovery\.selectionConfirmations \?\? \[\]\)\.findLast/u);
  assert.match(await read('test-recovery-runtime.mjs'), /reviewed\(record\)\.some\(review => signedReviews\.has\(review\)\)/u);
  const approval = await read('approval-check.mjs');
  assert.match(approval, /'publicationProjections', 'personSeals'\]\);/u, 'a refresh commit may add its seal and stay review-safe');
  const state = await read('state.mjs');
  assert.equal((state.match(/assertSignedTestCommandAmendments\(workflow\)/gu) ?? []).length, 2, 'publication and submission refuse an unsigned amendment');
});
