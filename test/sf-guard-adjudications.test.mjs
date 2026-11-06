import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { run as guard } from '../src/commands/guard.mjs';
import {
  advancementBlocked, assertConvergenceIntegrity, assertConvergencePublishable, convergenceProjection,
  decodeConvergenceRecord, findingAdjudication, adjudicatedConvergenceProjection, replacedAnswers
} from '../src/convergence.mjs';
import { countedConvergence } from '../src/presence/counted-convergence.mjs';
import { recordSha256 } from '../src/records.mjs';
import { convergenceSealCore } from '../src/schema-migrations.mjs';
import { approverId, PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts, loadPresenceContext } from '../src/presence/person-records.mjs';
import { setPersonStepPresenceDependencies, signPersonRecords } from '../src/presence/person-steps.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard (SPEC-PSS-v1 §10.10): a convergence adjudication keeps its approver's presence block inside
// the sealed projection (family v4). On a Story SF Guard requires, a finding counts only while its
// signature verifies; an unsigned or edited one reads as undisposed, so the Story cannot advance or
// publish past it and the route is adjudicating again in the person's own terminal. Older projections
// still replay as v4. Software stand-ins for the Secure Enclave are
// passed in-process; no environment switch reaches signing.

const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };
const OLD = '2020-01-01T00:00:00.000Z';

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
  process.chdir(root);
  console.log = () => {};
  try { return { value: await action() }; }
  catch (error) { return { error }; }
  finally { console.log = log; process.chdir(previous); }
}

async function sfGuard(root, words, options, deps) {
  const outcome = await inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps));
  assert.equal(outcome.error, undefined, outcome.error?.message);
}

/** A repository with SF Guard on: ONE's key pinned, TWO under a per-person exception. */
async function guardedRepository(t, work, key) {
  return startedSpecificationStory(t, work, {
    configure: members,
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      await sfGuard(root, ['register'], {}, guardPerson(ONE.email, [key]));
      await sfGuard(root, ['enable'], { exception: [approverId(TWO)], 'remote-check': 'sf-guard-verify' }, guardPerson(ONE.email, [key]));
      git('add', PRESENCE_CHAIN_PATH, '.github/agents');
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
}

const FACTS = [
  { id: 'CF-000000000001', kind: 'unclaimed-change', path: 'src/a.mjs', clauseIds: [] },
  { id: 'CF-000000000002', kind: 'unclaimed-change', path: 'src/b.mjs', clauseIds: [] }
];

function projection(adjudications) {
  return { ...convergenceProjection({ workId: 'PSS-CV-1', bindings: { iteration: 1 }, facts: FACTS, adjudications }), candidateSnapshot: [] };
}

/** A v3 projection as an older build sealed it. */
function v3(record) {
  // No v3 record has a settled list: family v5 added it.
  const { convergenceSha256: _sha, candidateSnapshot, settledByPlan: _settled, ...core } = { ...record, schemaVersion: 3 };
  return { ...core, convergenceSha256: recordSha256(core), candidateSnapshot };
}

/** As `story adjudicate` does: project, sign each new decision exactly as its finding records it, then keep the block. */
async function adjudicate(root, workflow, existing, decisions) {
  const kept = existing.findings.filter((finding) => !decisions.some((entry) => entry.itemId === finding.itemId)).map(findingAdjudication);
  const first = adjudicatedConvergenceProjection(existing, [...kept, ...decisions]);
  const signed = first.findings.filter((finding) => decisions.some((entry) => entry.itemId === finding.itemId)).map(findingAdjudication);
  await signPersonRecords(root, workflow, signed.map((record) => ({ label: 'Convergence adjudication', action: 'decision.adjudicate', record })));
  const presence = new Map(signed.map((record) => [record.itemId, record.presence]));
  return adjudicatedConvergenceProjection(existing, [...kept, ...decisions.map((entry) => ({ ...entry, presence: presence.get(entry.itemId) }))]);
}

test('SF Guard required: an adjudication keeps its signature in the sealed projection, and only a verified one disposes of its item', async (t) => {
  const key = softwarePresenceKey();
  const { root, item } = await guardedRepository(t, 'PSS-CV-1', key);
  const person = signer(key);
  setPersonStepPresenceDependencies(person);
  t.after(() => { setPersonStepPresenceDependencies({}); forgetPresenceContexts(); });
  const previous = process.cwd();
  process.chdir(root);
  t.after(() => process.chdir(previous));
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  await loadPresenceContext(root, workflow);

  const at = new Date().toISOString();
  const empty = projection([]);
  const signed = await adjudicate(root, workflow, empty, [
    { itemId: 'CF-000000000001', disposition: 'dismissed', reason: 'Refactor noise; no clause claims it.', clauseIds: [], actor: ONE.email, at }
  ]);
  assert.equal(person.shown.length, 1, 'one card, one touch');
  assert.equal(signed.schemaVersion, 6);
  assert.ok(signed.findings[0].decision.presence?.signature, 'the presence block is kept in the decision');
  assertConvergenceIntegrity(signed);
  assert.equal(countedConvergence(workflow, signed), signed, 'every finding counts: the projection as recorded');

  // A changed answer is signed with what it replaced on it, and the earlier answer keeps its own signature.
  const changed = await adjudicate(root, workflow, signed, [{ itemId: 'CF-000000000001', disposition: 'deferred', reason: 'Another Story owns this one.',
    clauseIds: [], actor: ONE.email, at, replaced: replacedAnswers(findingAdjudication(signed.findings[0])) }]);
  assert.ok(changed.findings[0].decision.presence?.signature);
  assert.equal(changed.findings[0].decision.replaced[0].presence.signature, signed.findings[0].decision.presence.signature);
  assertConvergenceIntegrity(changed);
  assert.equal(countedConvergence(workflow, changed), changed, 'it counts, with its trace on it');

  // A decision written without the touch, sealed by hand, counts for nothing: its item reads undisposed.
  const forged = adjudicatedConvergenceProjection(signed, [...signed.findings.map(findingAdjudication),
    { itemId: 'CF-000000000002', disposition: 'dismissed', reason: 'Written by a script.', clauseIds: [], actor: ONE.email, at }]);
  assertConvergenceIntegrity(forged);
  const view = countedConvergence(workflow, forged);
  assert.equal(view.uncountedFindings.length, 1);
  assert.ok(view.allowedNext.includes('adjudicate'));
  assert.ok(!view.allowedNext.includes('advance-to-verification'));
  assert.match(advancementBlocked(view).join('\n'), /CF-000000000002/u);
  assert.equal(forged.allowedNext.includes('advance-to-verification'), true, 'the sealed projection itself is unchanged');
  assert.throws(() => assertConvergencePublishable(view, ''), (error) => error.code === 'CONVERGENCE_REVIEW_REQUIRED'
    && error.details.uncountedFindings.length === 1, 'the view refuses on review, never on its seal');

  // An edited decision (its reason changed after signing, the seal recomputed) does not verify.
  const edited = structuredClone(signed);
  edited.findings[0].decision.reason = 'Changed after signing.';
  edited.convergenceSha256 = recordSha256(convergenceSealCore(edited));
  assertConvergenceIntegrity(edited);
  assert.equal(countedConvergence(workflow, edited).uncountedFindings.length, 1);
  // A presence block stripped without resealing breaks the hash contract.
  const stripped = structuredClone(signed);
  delete stripped.findings[0].decision.presence;
  assert.throws(() => assertConvergenceIntegrity(stripped), (error) => error.code === 'CONVERGENCE_RECORD_HASH_MISMATCH');

  // Adjudicating the item again, in the person's terminal, records it signed.
  const again = await adjudicate(root, workflow, forged, [
    { itemId: 'CF-000000000002', disposition: 'dismissed', reason: 'Reviewed: refactor noise.', clauseIds: [], actor: ONE.email, at: new Date().toISOString() }
  ]);
  assert.equal(countedConvergence(workflow, again), again);
  assert.ok(again.allowedNext.includes('advance-to-verification'));
  // From an agent's shell: refused with the route, nothing signed.
  setPersonStepPresenceDependencies(signer(key, { personTerminal: () => ({ person: false, reason: 'an agent started this command' }) }));
  await assert.rejects(adjudicate(root, workflow, empty, [{ itemId: 'CF-000000000001', disposition: 'rework', clauseIds: [], actor: ONE.email, at }]),
    (error) => error.code === 'PSS_CARD_NOT_SHOWN');
});

test('older convergence projections still replay at the current version, and a Story SF Guard does not require counts them as recorded', () => {
  const older = v3(projection([{ itemId: 'CF-000000000001', disposition: 'rework', clauseIds: [], actor: ONE.email, at: '2026-01-01T00:00:00.000Z' }]));
  assert.equal(older.schemaVersion, 3);
  const decoded = decodeConvergenceRecord(Buffer.from(JSON.stringify(older)));
  assert.equal(decoded.schemaVersion, 6);
  assert.deepEqual(decoded.findings, older.findings);
  assert.deepEqual(decoded.unresolvedBlockers, older.unresolvedBlockers);
  assert.equal(projection([]).schemaVersion, 6, 'every new projection is v6; an unsigned decision simply has no block');
  assert.equal(countedConvergence({ resolution: {} }, decoded), decoded);
  assert.equal(countedConvergence({ resolution: { presence: { status: 'off' } }, workItem: { id: 'X' } }, decoded), decoded);
});
