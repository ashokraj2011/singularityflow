import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { run as guard } from '../src/commands/guard.mjs';
import { specAuthorCommand } from '../src/commands/spec-author.mjs';
import { approveProposal } from '../src/configuration-drafts.mjs';
import { committedFileBytes, refCommit } from '../src/git.mjs';
import { approverId, PRESENCE_CHAIN_PATH } from '../src/presence/chain.mjs';
import {
  configurationApprovalStanding, configurationSealPath, publishConfigurationSeal, signConfigurationApproval
} from '../src/presence/configuration-seal.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts } from '../src/presence/person-records.mjs';
import { setPersonStepPresenceDependencies } from '../src/presence/person-steps.mjs';
import { sfGuardVerifyWorkflowText } from '../src/presence/remote-recipe.mjs';
import {
  enabledIntervals, forgetRepositorySealPolicies, parseSeal, repositorySealPolicy, repositorySealVerdict, sealedRecord, wasOn
} from '../src/presence/repository-seals.mjs';
import { repositoryPersonStep } from '../src/presence/repository-step-routes.mjs';
import { gateRepositoryPersonStep } from '../src/presence/repository-steps.mjs';
import { remoteStateCheck } from '../src/presence/state-check.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { readDraft } from '../src/spec-library/draft-store.mjs';
import { libraryView, publishRevision, readManifest } from '../src/spec-library/library.mjs';
import { libraryPresence } from '../src/spec-library/presence.mjs';
import { resolveSlices } from '../src/spec-library/slice.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard (SPEC-PSS-v1 §10.9): a repository-level person step keeps its presence seal beside its
// record. A specification revision or split published while SF Guard is on carries `presence.json`, a
// configuration approval's seal is published to the state branch, and every reader counts a record
// only when its seal verifies against the approver's pinned key; one recorded while SF Guard was off
// reads `pre-signing`. The state branch's remote check fails an unsigned record a push adds and a seal
// a push removes. Software stand-ins for the Secure Enclave are passed in-process; no environment
// switch reaches signing.

const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };
const SPEC = 'SPEC-SEAL-001';

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

async function sfGuard(root, words, options, deps) {
  const outcome = await inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps));
  assert.equal(outcome.error, undefined, outcome.error?.message);
}

function specText(extra = '') {
  return `# Order discount threshold\n\n## Outcome\n\nThe discount applies only above INR 5000.00.\n\n## Actors\n\n- Shopper: places INR orders.\n\n## User scenarios\n\n1. A shopper with an INR 6000.00 cart sees a discount.\n\n## Scope\n\nIn scope: the discount rule. Out of scope: tax.\n\n## Requirements\n\nWHEN an INR order total is strictly greater than INR 5000.00, the cart SHALL apply a 10 percent order discount. [${SPEC}:REQ-001]\n\n## Acceptance\n\nAn INR 5000.01 cart gets INR 500.00 off, as ${SPEC}:REQ-001 states. [${SPEC}:AC-001]\n\n## Decisions and open questions\n\n- GAP-001: only totals strictly above INR 5000.00 qualify.${extra}\n`;
}

/**
 * A repository whose specification library holds SPEC@1, published while SF Guard was off, and then
 * SF Guard on: ONE's key pinned, TWO under a per-person exception.
 */
async function guardedLibrary(t, key) {
  return startedSpecificationStory(t, 'PSS-SEAL-1', {
    configure: members,
    beforeStart: async ({ directory, root, git, cli }) => {
      git('config', 'user.email', ONE.email);
      const file = path.join(directory, 'library-spec.md');
      await writeFile(file, specText());
      cli('spec', 'author', 'new', SPEC, '--title', 'Order discount threshold');
      cli('spec', 'author', 'edit', SPEC, '--file', file, '--expected-seq', '1');
      cli('spec', 'author', 'gap', SPEC, '--kind', 'vague-term', '--question', 'Is INR 5000.00 itself discounted?');
      cli('spec', 'author', 'decide', SPEC, 'GAP-001', '--choice', 'Only totals strictly above INR 5000.00 qualify.', '--reason', 'Finance.');
      cli('spec', 'author', 'settle', SPEC, '--all-articles', 'satisfied');
      cli('spec', 'author', 'publish', SPEC, '--reviewed');
      await sfGuard(root, ['register'], {}, guardPerson(ONE.email, [key]));
      await sfGuard(root, ['enable'], { exception: [approverId(TWO)], 'remote-check': 'sf-guard-verify' }, guardPerson(ONE.email, [key]));
      git('add', PRESENCE_CHAIN_PATH, '.github/agents');
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
}

function stateCommit(root) {
  return refCommit(root, 'refs/remotes/origin/state') ?? refCommit(root, 'refs/heads/state');
}

test('the seal rules: when SF Guard was on, and what a repository record\'s seal must bind', () => {
  const chain = { chainId: 'c', events: [{ kind: 'enable', at: '2026-11-01T10:00:00.000Z' }, { kind: 'disable', at: '2026-11-01T12:00:00.000Z' }, { kind: 'enable', at: '2026-11-02T08:00:00.000Z' }] };
  const intervals = enabledIntervals(chain, { validLength: 3 });
  assert.equal(intervals.length, 2);
  assert.equal(wasOn(intervals, '2026-11-01T09:00:00.000Z'), false);
  assert.equal(wasOn(intervals, '2026-11-01T11:00:00.000Z'), true);
  assert.equal(wasOn(intervals, '2026-11-01T13:00:00.000Z'), false);
  assert.equal(wasOn(intervals, '2026-11-03T00:00:00.000Z'), true);
  assert.equal(wasOn(intervals, 'not a time'), true, 'a time that cannot be read counts as on while SF Guard is on');
  assert.equal(parseSeal(null), null);
  assert.deepEqual(parseSeal(Buffer.from('not json')), { invalid: true });
  // A repository that never opted in reads every record as before, seal or not.
  assert.equal(repositorySealVerdict(null, { record: sealedRecord('spec-revision', `${SPEC}@1`, {}) }).state, 'not-required');
  assert.equal(repositorySealVerdict({ present: false }, { record: sealedRecord('spec-revision', `${SPEC}@1`, {}), seal: { invalid: true } }).counts, true);
  // The routes: configuration approval keeps its seal where it records, so the dispatch gate asks no touch.
  assert.equal(repositoryPersonStep(['configuration', 'approve', 'sflow/config-change/x']).inRecord, true);
  const recipe = sfGuardVerifyWorkflowText({ branch: 'main', stateBranch: 'state' });
  assert.match(recipe, /branches: \["main", "state"\]/u);
  assert.match(recipe, /if \[ "\$GITHUB_REF" = "refs\/heads\/state" \]; then set -- "\$@" --state-records; fi/u);
});

test('SF Guard on: a published revision keeps its seal, only counted revisions attach, and the state check fails an unsigned one', async (t) => {
  const key = softwarePresenceKey();
  const { root, directory } = await guardedLibrary(t, key);
  const person = signer(key);
  setPersonStepPresenceDependencies(person);
  t.after(() => { setPersonStepPresenceDependencies({}); forgetPresenceContexts(); forgetRepositorySealPolicies(); });
  const author = async (...words) => {
    const outcome = await inRoot(root, () => specAuthorCommand(['spec', 'author', ...words], { json: true }));
    assert.equal(outcome.error, undefined, outcome.error?.message);
    return outcome;
  };
  const config = (await import('../src/state-stores.mjs')).loadConfig;
  const libraryConfig = await inRoot(root, () => config(root)).then((outcome) => outcome.value);
  const beforeSigned = stateCommit(root);

  // @2, published with SF Guard on: one card and one touch, over the exact manifest it records.
  const file = path.join(directory, 'library-spec-2.md');
  await writeFile(file, specText(' A second sentence.'));
  const draft = await readDraft(root, SPEC);
  await inRoot(root, () => specAuthorCommand(['spec', 'author', 'edit', SPEC], { json: true, file, 'expected-seq': String(draft.head.sequence) }));
  const shownBefore = person.shown.length;
  const published = await inRoot(root, () => specAuthorCommand(['spec', 'author', 'publish', SPEC], { json: true, draft: true }));
  assert.equal(published.error, undefined, published.error?.message);
  assert.equal(person.shown.length - shownBefore, 1, 'publishing takes one touch');
  assert.match(person.shown.at(-1).lines.join('\n'), new RegExp(`Revision: @2 \\(draft\\)[\\s\\S]*Record: sha256:`, 'u'));
  const afterSigned = stateCommit(root);
  assert.ok(committedFileBytes(root, afterSigned, `singularity/specifications/${SPEC}/000002/presence.json`), '@2 keeps its seal beside its files');

  forgetRepositorySealPolicies();
  let view = await libraryView(root, libraryConfig);
  let presence = await libraryPresence(root);
  assert.equal(presence.revision(view, readManifest(root, view, SPEC, 1)).state, 'pre-signing', '@1 was published while SF Guard was off');
  const signed = presence.revision(view, readManifest(root, view, SPEC, 2));
  assert.equal(signed.state, 'signed', signed.reason);

  // @3, written to the state branch with no seal, as an agent's script would: it counts for nothing.
  const forged = await readDraft(root, SPEC);
  await publishRevision(root, libraryConfig, { specId: SPEC, reviewState: 'reviewed', operationId: 'spp-forged-0000000000-reviewed', actor: { name: 'Script', email: 'script@example.test' },
    command: 'x', report: { counts: { d: 0, a: 0, h: 0 }, blocking: [] },
    draft: { ...forged, head: { ...forged.head, snapshotSha256: `sha256:${'f'.repeat(64)}`, draft: { ...forged.head.draft, basedOn: { revision: 2 } } } } });
  view = await libraryView(root, libraryConfig);
  presence = await libraryPresence(root);
  const unsigned = presence.revision(view, readManifest(root, view, SPEC, 3));
  assert.equal(unsigned.counts, false);
  assert.equal(unsigned.code, 'PSS_RECORD_UNSIGNED');

  // Story start attaches only a counted reviewed revision: @3 is refused with the route, and with no
  // revision named the highest counted reviewed one (@1) is taken.
  await assert.rejects(inRoot(root, () => resolveSlices(root, libraryConfig, [`${SPEC}@3=REQ-001`])).then((outcome) => { if (outcome.error) throw outcome.error; }),
    (error) => error.code === 'PSS_RECORD_UNSIGNED' && /spec author publish SPEC-SEAL-001 --reviewed/u.test(error.message));
  const [slice] = (await inRoot(root, () => resolveSlices(root, libraryConfig, [`${SPEC}=REQ-001`]))).value;
  assert.equal(slice.revision, `${SPEC}@1`);

  // `spec author show` names the standing.
  const shown = await author('show', `${SPEC}@3`);
  assert.equal(JSON.parse(shown.lines.join('\n')).presence.counts, false);

  // The state branch's remote check: the forged revision this push adds fails; the signed one passes.
  const head = stateCommit(root);
  const deps = (ref) => ({ head: async () => ref });
  const pushed = await remoteStateCheck(root, { base: afterSigned }, deps(head));
  assert.equal(pushed.status, 'failed');
  assert.deepEqual(pushed.failures.map((entry) => entry.code), ['PSS_RECORD_UNSIGNED']);
  assert.match(pushed.failures[0].message, /revision SPEC-SEAL-001@3/u);
  const earlier = await remoteStateCheck(root, { base: beforeSigned }, deps(afterSigned));
  assert.equal(earlier.status, 'passed', JSON.stringify(earlier.failures));
  // Already on the base: a note, never a hold.
  const later = await remoteStateCheck(root, { base: head }, deps(head));
  assert.equal(later.status, 'passed');
  assert.ok(later.warnings.some((line) => /SPEC-SEAL-001@3 does not verify/u.test(line)));
  // A push that removes a seal fails.
  const removed = await remoteStateCheck(root, { base: afterSigned }, { head: async () => beforeSigned });
  assert.ok(removed.failures.some((entry) => entry.code === 'PSS_RECORD_REMOVED' && /000002\/presence\.json/u.test(entry.message)), JSON.stringify(removed.failures));
});

test('SF Guard on: a configuration approval takes one touch over the exact proposal, and its seal on the state branch makes the approved commit read signed', async (t) => {
  const key = softwarePresenceKey();
  const { root, git } = await guardedLibrary(t, key);
  const person = signer(key);
  setPersonStepPresenceDependencies(person);
  t.after(() => { setPersonStepPresenceDependencies({}); forgetPresenceContexts(); forgetRepositorySealPolicies(); });
  const base = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-qm', 'A proposal');
  const proposal = git('rev-parse', 'HEAD');
  const reviewed = { proposalCommit: proposal, targetCommit: base, changedFiles: [], workflows: [], valid: true };

  // The dispatch gate asks nothing: the touch is taken where the approval records.
  assert.equal((await inRoot(root, () => gateRepositoryPersonStep(root, ['configuration', 'approve', 'sflow/config-change/p'], {}))).value, null);
  assert.equal(person.shown.length, 0);

  const outcome = await inRoot(root, () => approveProposal(root, 'sflow/config-change/p', {
    yes: true, print: () => {}, list: async () => [], inspect: async () => ({ ...reviewed, branch: 'sflow/config-change/p' }),
    activate: async () => ({ activated: true, status: 'activated' })
  }));
  assert.equal(outcome.error, undefined, outcome.error?.message);
  assert.equal(person.shown.length, 1, 'one touch');
  assert.match(person.shown[0].lines.join('\n'), new RegExp(`Proposal commit: ${proposal}`, 'u'));
  assert.equal(outcome.value.presence.status, 'published');
  const state = stateCommit(root);
  const sealBytes = committedFileBytes(root, state, configurationSealPath(proposal));
  assert.ok(sealBytes, 'the seal is on the state branch');

  const policy = await repositorySealPolicy(root);
  const readSeal = (file) => committedFileBytes(root, state, file);
  const at = new Date().toISOString();
  const standing = (commit, parents = []) => configurationApprovalStanding(policy, commit, { readSeal, parents: () => parents, committedAt: () => at });
  assert.equal(standing(proposal).state, 'signed', standing(proposal).reason);
  // The activation commit a reviewed merge makes: the proposal is its second parent.
  const merge = 'b'.repeat(40);
  assert.equal(standing(merge, [base, proposal]).state, 'signed');
  // A commit the approval did not bring in: no seal, recorded while SF Guard is on.
  const other = 'c'.repeat(40);
  assert.equal(standing(other, [base]).code, 'PSS_RECORD_UNSIGNED');
  // The seal moved to another commit's path counts for nothing.
  const moved = configurationApprovalStanding(policy, other, { readSeal: (file) => (file === configurationSealPath(other) ? sealBytes : null), parents: () => [], committedAt: () => at });
  assert.equal(moved.counts, false);

  // Publishing the same seal again finds it there; the approval is never undone for a seal.
  const again = await signConfigurationApproval(root, { ...reviewed, branch: 'sflow/config-change/p' });
  assert.equal((await publishConfigurationSeal(root, again)).status, 'present');
});
