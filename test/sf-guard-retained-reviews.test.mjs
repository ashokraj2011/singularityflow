import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { run as guard } from '../src/commands/guard.mjs';
import { PhaseAppealDecisionSchema } from '../src/phase-appeals.mjs';
import { ArtifactRiskDecisionSchema } from '../src/phase-artifact-risk-schema.mjs';
import { FindingDisputeDecisionSchema } from '../src/phase-finding-dispute-schema.mjs';
import { qualityRiskDecisionCounts } from '../src/phase-quality-risk.mjs';
import { attributionBlock, attributionCardLines, attributionLabels } from '../src/presence/attribution.mjs';
import { approverId, PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { countedRecords } from '../src/presence/counted.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts, loadPresenceContext } from '../src/presence/person-records.mjs';
import { isPersonStepRecord, setPersonStepPresenceDependencies, signPersonRecords } from '../src/presence/person-steps.mjs';
import { remotePresenceCheck } from '../src/presence/remote-check.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { storyRecordFile } from '../src/presence/story-verify.mjs';
import { recordSha256 } from '../src/records.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard (SPEC-PSS-v1 §10.7): a live terminal review's decision keeps its approver's signature in the
// record it writes. A quality risk (also an artifact risk or a disputed finding) and its revocation, an
// appeal decision and the plan amendment it binds, and a source review decision each carry a presence
// block; their readers count only one that verifies, and the remote check verifies the ones a change adds
// and fails a change that removes a signed one. Software stand-ins for the Secure Enclave and GitHub are
// passed in-process; no environment switch reaches signing or verification.

const WORK = 'PSS-RR';
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

function signer(key) {
  const shown = [];
  return {
    shown,
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
  const lines = [];
  process.chdir(root);
  console.log = (line) => lines.push(String(line));
  try { return { value: await action(), lines }; }
  catch (error) { return { error, lines }; }
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

async function signed(root, workflow, key, record, label = 'Decision', action = 'decision.test') {
  setPersonStepPresenceDependencies(signer(key));
  try { await signPersonRecords(root, workflow, [{ label, action, record }]); }
  finally { setPersonStepPresenceDependencies({}); }
  return record;
}

const qualityRisk = (id) => ({ kind: 'phase-quality-risk', gate: 'SPEC_COVERAGE_INCOMPLETE', id, actor: ONE.email, authorityGroup: 'product-approvers',
  identityAssurance: null, authorizationId: `auth-${id}`, reviewAssurance: 'live-terminal-risk-review', reason: 'A reviewed and bounded coverage shortfall.',
  at: new Date().toISOString(), testsWaived: false, phaseApproved: false });

test('the review families are person steps, and their schemas carry a presence block only where they may', () => {
  assert.equal(isPersonStepRecord('qualityRiskDecisions', qualityRisk('PQR-1')), true);
  assert.equal(isPersonStepRecord('qualityRiskDecisions', { kind: 'phase-quality-risk-revocation', revokes: 'PQR-1' }), true, 'a revocation restores a gate: it is a person\'s step too');
  assert.equal(isPersonStepRecord('phaseAppealDecisions', { appealId: 'APL-1', decision: 'account-scope' }), true);
  for (const schema of [ArtifactRiskDecisionSchema, FindingDisputeDecisionSchema]) {
    assert.ok(schema.shape.presence, 'the decision schema names the presence block');
    assert.equal(schema.shape.presence.safeParse(undefined).success, true, 'and an unsigned repository writes none');
  }
  const appeal = { schemaVersion: 1, kind: 'phase-appeal-decision', appealId: `APL-${'a'.repeat(24)}`, packetSha256: sha('b'),
    decision: 'request-changes', reason: 'The exact diff needs a clause the plan does not name yet.', actor: ONE.email, authorityGroup: 'product-approvers',
    identityAssurance: null, reviewAssurance: 'live-terminal-exact-diff-review', authorizationId: 'auth-1', amendmentId: null,
    at: new Date().toISOString(), testsWaived: false, phaseApproved: false };
  const presence = { schema: 'sflow-presence-record@1', chainId: 'c', approver: 'approver-1', action: 'decision.appeal', at: appeal.at };
  assert.equal(PhaseAppealDecisionSchema.safeParse(appeal).success, true, 'a v1 decision without a signature still reads');
  assert.equal(PhaseAppealDecisionSchema.safeParse({ ...appeal, presence }).success, false, 'a v1 decision never carries a presence block');
  assert.equal(PhaseAppealDecisionSchema.safeParse({ ...appeal, schemaVersion: 2, presence }).success, true, 'v2, on a Story with an SF Guard pin, does');
  assert.equal(PhaseAppealDecisionSchema.safeParse({ ...appeal, schemaVersion: 2 }).success, true, 'a pinned-off Story writes v2 unsigned');
});

test('each review asks for one touch, taken where its decision record is written', async () => {
  const read = (file) => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  const risk = await read('phase-quality-risk.mjs');
  for (const label of ['Accept risk', 'Revoke risk']) {
    assert.match(risk, new RegExp(`label: \`${label} \\$\\{id\\}\`, presenceInRecord: true`, 'u'), `${label} skips the card-only touch`);
  }
  assert.match(risk, /signReviewDecision\(root, aggregate, record, 'Quality risk decision'\);\n\s+await consumeAndRetainHumanReview\(root, record/u);
  assert.match(risk, /signReviewDecision\(root, aggregate, revocation, 'Quality risk revocation'\);\n\s+await consumeAndRetainHumanReview\(root, revocation/u);
  const appeals = await read('phase-appeals.mjs');
  assert.match(appeals, /label: `Review \$\{id\}`, presenceInRecord: true/u);
  assert.match(appeals, /signPersonRecords\(root, aggregate, \[[\s\S]{0,400}?\]\);\n\s+\}\n\s+await consumeAndRetainHumanReview\(root, record, card, grant\.token\);\n\s+await immutable\(/u,
    'the decision is signed before both its origin witness and its retained decision.json');
  const lifecycle = await read('source-review-lifecycle.mjs');
  assert.match(lifecycle, /signPersonRecords\(root, workflow,\n\s+\[\{ label: 'Source review decision', action: 'decision\.source-review', record: body \}\]\);\n\s+\}\n\s+const record = \{ \.\.\.body, recordSha256: recordSha256\(body\) \};/u);
  assert.match(lifecycle, /schemaVersion: workflow\.resolution\?\.presence \? currentSchemaVersion\('source-review-decision'\) : 1/u,
    'a repository that never opted in keeps writing v1');
  assert.doesNotMatch(await read('commands/review-source.mjs'), /signPersonRecords/u, 'the pre-transaction touch moved to where the record is written');
  const authorization = await read('action-authorization.mjs');
  assert.match(authorization, /if \(!presenceInRecord\) await \(await import\('\.\/presence\/repository-steps\.mjs'\)\)\.signTerminalReview/u);
});

test('SF Guard on: a signed review decision counts; a hand-written, edited or unsigned one does not', async (t) => {
  const key = softwarePresenceKey();
  const { root, item } = await guardedStory(t, key);
  t.after(() => { setPersonStepPresenceDependencies({}); forgetPresenceContexts(); });
  forgetPresenceContexts();
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.resolution.presence.status, 'required');
  await loadPresenceContext(root, workflow);

  const risk = await signed(root, workflow, key, qualityRisk('PQR-signed'), 'Quality risk decision', 'decision.quality-risk');
  assert.equal(risk.presence.approver, approverId(ONE));
  assert.equal(qualityRiskDecisionCounts(workflow, risk), true, 'a signed risk decision counts');
  assert.equal(qualityRiskDecisionCounts(workflow, qualityRisk('PQR-hand')), false, 'one written by hand counts for nothing');
  assert.equal(qualityRiskDecisionCounts(workflow, { ...risk, reason: 'An edited reason that the approver never saw.' }), false, 'an edit breaks it');
  assert.equal(qualityRiskDecisionCounts(workflow, { ...qualityRisk('PQR-copied'), presence: risk.presence }), false, 'its signature cannot be carried to another record');

  const revocation = await signed(root, workflow, key, { kind: 'phase-quality-risk-revocation', id: 'revoke-1', revokes: 'PQR-signed',
    reason: 'The shortfall is fixed; the gate applies again.', actor: ONE.email, authorityGroup: 'product-approvers', authorizationId: 'auth-r', at: new Date().toISOString() });
  const forged = { kind: 'phase-quality-risk-revocation', id: 'revoke-2', revokes: 'PQR-signed', reason: 'An agent revoking a person\'s accepted risk.',
    actor: ONE.email, authorityGroup: 'product-approvers', authorizationId: 'auth-f', at: new Date().toISOString() };
  assert.deepEqual(countedRecords(workflow, [revocation, forged]), [revocation], 'only a signed revocation restores the gate');

  const appeal = await signed(root, workflow, key, { schemaVersion: 2, kind: 'phase-appeal-decision', appealId: `APL-${'c'.repeat(24)}`, packetSha256: sha('d'),
    decision: 'account-scope', reason: 'The exact diff serves the existing approved criterion.', actor: ONE.email, authorityGroup: 'product-approvers',
    identityAssurance: null, reviewAssurance: 'live-terminal-exact-diff-review', authorizationId: 'auth-a', amendmentId: 'PA-001',
    at: new Date().toISOString(), testsWaived: false, phaseApproved: false }, 'Appeal decision', 'decision.appeal');
  assert.equal(PhaseAppealDecisionSchema.safeParse(appeal).success, true, 'the signed decision is a valid v2 record');
  assert.equal(countedRecords(workflow, [appeal]).length, 1);
  assert.equal(countedRecords(workflow, [{ ...appeal, decision: 'request-changes' }]).length, 0);

  // TWO's per-person exception: the record goes ahead unsigned, labelled as a bypass, and counts.
  const excepted = await signed(root, workflow, key, { ...qualityRisk('PQR-two'), actor: TWO.email });
  assert.match(excepted.presence.bypass, /^EXC-/u);
  assert.equal(excepted.presence.signature, undefined);
  assert.equal(qualityRiskDecisionCounts(workflow, excepted), true);
});

test('SF Guard on: the remote check verifies a source review decision a change adds, and fails removing a signed one', async (t) => {
  const key = softwarePresenceKey();
  const { root, item, git } = await guardedStory(t, key);
  t.after(() => { setPersonStepPresenceDependencies({}); forgetPresenceContexts(); });
  forgetPresenceContexts();
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  await loadPresenceContext(root, workflow);
  const report = 'e'.repeat(64);
  const directory = path.join(item, 'context/reviews/specification/gen-1/decisions', report);
  await mkdir(directory, { recursive: true });
  const body = (id) => ({ schemaVersion: 2, phase: 'specification', generation: 1, reportSha256: report, lifecycleEventId: `event-${id}`,
    id, decision: 'accepted', reason: 'The unreadable document is not needed for this step.', actor: { email: ONE.email, login: null },
    authorityGroup: 'product-approvers', identityAssurance: null, decidedAt: new Date().toISOString() });
  const write = async (record) => {
    const file = path.join(directory, `${record.recordSha256}.json`);
    await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
    return path.posix.relative(item, file).replaceAll('\\', '/');
  };
  const signedBody = await signed(root, workflow, key, body('unreadable:DOC-001'), 'Source review decision', 'decision.source-review');
  const signedRecord = { ...signedBody, recordSha256: recordSha256(signedBody).replace(/^sha256:/u, '') };
  const unsignedBody = body('unreadable:DOC-002');
  const unsignedRecord = { ...unsignedBody, recordSha256: recordSha256(unsignedBody).replace(/^sha256:/u, '') };
  assert.equal(countedRecords(workflow, [signedRecord]).length, 1, 'the retained record, recordSha256 and all, verifies');
  assert.equal(countedRecords(workflow, [unsignedRecord]).length, 0);

  const base = git('rev-parse', 'HEAD');
  const signedPath = await write(signedRecord);
  const unsignedPath = await write(unsignedRecord);
  assert.ok(storyRecordFile(signedPath) && storyRecordFile(unsignedPath), 'both live in the source review decision store');
  git('add', '-A');
  git('commit', '-qm', 'Two source review decisions');
  const github = { signingKeys: async () => snapshot([key]), firstPushTime: async () => ({ status: 'unavailable', at: null, reason: 'not asked' }),
    hostReview: async () => ({ status: 'unavailable', pullRequest: null, reviewer: null, reason: 'not asked' }) };
  forgetPresenceContexts();
  const added = await inRoot(root, () => remotePresenceCheck(root, { base }, github));
  assert.equal(added.error, undefined, added.error?.stack);
  const unsignedFailures = added.value.failures.filter((failure) => failure.code === 'PSS_RECORD_UNSIGNED');
  assert.equal(unsignedFailures.length, 1, JSON.stringify(added.value.failures));
  assert.match(unsignedFailures[0].message, new RegExp(`source review decision ${unsignedRecord.recordSha256}\\.json does not verify`, 'u'));
  assert.match(unsignedFailures[0].route, /review-source decide/u);
  assert.ok(!added.value.failures.some((failure) => failure.message.includes(signedRecord.recordSha256)), 'the signed decision passes');

  // Removing the signed decision fails; removing the unsigned one does not.
  const withBoth = git('rev-parse', 'HEAD');
  await rm(path.join(item, signedPath));
  await rm(path.join(item, unsignedPath));
  git('add', '-A');
  git('commit', '-qm', 'Drop both decisions');
  forgetPresenceContexts();
  const removed = await inRoot(root, () => remotePresenceCheck(root, { base: withBoth }, github));
  assert.equal(removed.error, undefined, removed.error?.stack);
  const removals = removed.value.failures.filter((failure) => failure.code === 'PSS_RECORD_REMOVED');
  assert.equal(removals.length, 1, JSON.stringify(removed.value.failures));
  assert.match(removals[0].message, new RegExp(signedRecord.recordSha256, 'u'));
});

test('G3 labels say whether an authorship claim carries its author\'s signature', () => {
  const report = { counts: { declared: 3, 'outside-workflow': 0, 'unknown-agent': 0, shell: 0, unattributed: 0, 'pre-guard': 0 }, ranges: [], lines: 3, files: 1 };
  const claimed = { producer: 'human' };
  const text = (block) => [...attributionLabels(block), ...attributionCardLines(block)].join('\n');
  assert.match(text(attributionBlock(report, { authorship: claimed, claim: { signed: true, signer: 'approver-1' } })), /Claimed producer: human, claimed, signed by approver-1;/u);
  assert.match(text(attributionBlock(report, { authorship: claimed, claim: { signed: false } })), /Claimed producer: human, claimed, unsigned: treated as agent-written;/u);
  const unread = text(attributionBlock(report, { authorship: claimed }));
  assert.match(unread, /Claimed producer: human; 3 lines recorded/u, 'where SF Guard did not read the claim, the wording is as before');
});
