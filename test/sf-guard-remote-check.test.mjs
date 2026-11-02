import assert from 'node:assert/strict';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { main } from '../src/cli.mjs';
import { approveCommand } from '../src/commands/approve.mjs';
import { run as guard } from '../src/commands/guard.mjs';
import { loadDefinition } from '../src/config.mjs';
import { reviewFacet } from '../src/evidence/evaluate.mjs';
import { runGovernanceGate } from '../src/governance.mjs';
import { receiptPresenceText } from '../src/evidence-receipt.mjs';
import {
  approverId, foldPresenceChain, nextPresenceEvent, PRESENCE_CHAIN_PATH, presenceEventStatement
} from '../src/presence/chain.mjs';
import { countedApprovals, markSyntheticApproval } from '../src/presence/counted.mjs';
import { githubRepository, hostReview, requiredStatusCheck } from '../src/presence/host.mjs';
import { parseCtkListing } from '../src/presence/local-keys.mjs';
import { forgetPresenceContexts, loadPresenceContext } from '../src/presence/person-records.mjs';
import { setPersonStepPresenceDependencies } from '../src/presence/person-steps.mjs';
import { remotePresenceCheck, remotePresenceText } from '../src/presence/remote-check.mjs';
import { sfGuardRecipeIncomplete, sfGuardVerifyWorkflowText } from '../src/presence/remote-recipe.mjs';
import { statementText } from '../src/presence/statement.mjs';
import { presenceHistoryProblems, storyPresenceReport } from '../src/presence/story-verify.mjs';
import { ctkListing, softwarePresenceKey } from './helpers/presence-keys.mjs';
import { specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

// SF Guard M4 (SPEC-PSS-v1 REQ-021, REQ-030, REQ-042, AC-011, AC-013): the final check, the evidence
// receipt and the required remote check verify every person record again, never trusting a flag.
// Software stand-ins for the Secure Enclave and for GitHub are passed in-process; no environment
// switch reaches signing or verification.

const WORK = 'PSS-M4';
const ONE = { name: 'History Tester', email: 'history.tester@example.com', githubLogin: 'history-tester' };
const TWO = { name: 'Windows Two', email: 'windows.two@example.com' };
const THREE = { name: 'Third Approver', email: 'third.approver@example.com', githubLogin: 'third-approver' };

function members(configuration) {
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.members = [ONE, TWO, THREE];
}

const snapshot = (keys) => ({ status: 'listed', keys: keys.map((key) => ({ keyId: key.keyId, line: key.line })),
  snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString(), reason: null });

function guardPerson(email, keys, { requiredCheck } = {}) {
  const byId = new Map(keys.map((key) => [key.keyId, key]));
  return {
    identify: () => ({ email, login: null }),
    listIdentities: () => ({ available: true, reason: null, identities: parseCtkListing(ctkListing(keys.map((key) => ({ keyId: key.keyId })))) }),
    readableCopies: () => [],
    publicKeyOf: async (keyId) => byId.get(keyId)?.line ?? null,
    githubKeys: async () => snapshot(keys),
    card: (fields) => JSON.stringify(fields),
    sign: async ({ statement, keyId }) => ({ signature: byId.get(keyId).sign(statementText(statement)), userVerification: false }),
    requiredCheck: requiredCheck ?? (async () => ({ status: 'not-required', contexts: ['build'], reason: null }))
  };
}

function signer(key) {
  return {
    personTerminal: () => ({ person: true, reason: null }),
    signerAvailability: () => ({ available: true, reason: null }),
    holdsKey: async (keyId) => keyId === key.keyId,
    card: async (fields) => JSON.stringify(fields),
    sign: async ({ statement }) => ({ signature: key.sign(statementText(statement)), userVerification: false })
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

async function guardRun(root, words, deps, options = {}) {
  return inRoot(root, () => guard(['guard', ...words], { positionals: ['guard', ...words], options: { json: true, ...options } }, deps));
}

const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
const writeWorkflow = (item, workflow) => writeFile(path.join(item, 'workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`);

/** GitHub for the remote check: every listed key, and nothing known about pushes or reviews. */
function githubWith(listing, overrides = {}) {
  return {
    signingKeys: async (login) => listing(login),
    firstPushTime: async () => ({ status: 'unavailable', at: null, reason: 'not asked in this test' }),
    hostReview: async () => ({ status: 'unavailable', pullRequest: null, reviewer: null, reason: 'not asked in this test' }),
    ...overrides
  };
}

async function remote(root, base, deps, extra = {}) {
  forgetPresenceContexts();
  const outcome = await inRoot(root, () => remotePresenceCheck(root, { base, ...extra }, deps));
  assert.equal(outcome.error, undefined, outcome.error?.stack);
  return outcome.value;
}

test('SF Guard M4: the final check, the receipt and the remote check verify every person record again', async (t) => {
  const key = softwarePresenceKey();
  const story = await startedSpecificationStory(t, WORK, {
    configure: members,
    beforeStart: async ({ root, git }) => {
      git('config', 'user.email', ONE.email);
      assert.equal((await guardRun(root, ['register'], guardPerson(ONE.email, [key]))).error, undefined);
      const enabled = await guardRun(root, ['enable'], guardPerson(ONE.email, [key]), { exception: [approverId(TWO)], 'remote-check': 'sf-guard-verify' });
      assert.equal(enabled.error, undefined, enabled.error?.message);
      // Opting in reads the default branch's protection and says the check is not required yet.
      assert.equal(enabled.lines.length > 0 && JSON.parse(enabled.lines.join('\n')).remote.status, 'not-required');
      git('add', PRESENCE_CHAIN_PATH, '.github/agents');
      git('commit', '-qm', 'Turn SF Guard on');
      git('push', '-q', 'origin', 'main');
    }
  });
  const { root, git, cli, item } = story;
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(WORK, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  // A person's authorship claim on this Story is believed only with its author's signature (SPEC-PSS-v1 §10.5).
  forgetPresenceContexts();
  setPersonStepPresenceDependencies(signer(key));
  const published = await inRoot(root, () => main(['phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place', '--json']));
  setPersonStepPresenceDependencies({});
  assert.equal(published.error, undefined, `${published.error?.message}\n${published.lines.join('\n')}`);
  cli('submit', 'specification', '--skip-checks');
  const beforeApproval = git('rev-parse', 'HEAD');
  forgetPresenceContexts();
  const approved = await inRoot(root, () => approveCommand(['approve', 'specification'], { yes: true }, { presence: signer(key) }));
  assert.equal(approved.error, undefined, `${approved.error?.message}\n${approved.lines.join('\n')}`);
  if (git('status', '--porcelain')) { git('add', '-A'); git('commit', '-qm', 'Approval recorded'); }
  const approvedHead = git('rev-parse', 'HEAD');
  const listed = githubWith(() => snapshot([key]));

  // The remote check passes the signed approval, and re-verifies the Story within AC-013's 50 ms.
  let check = await remote(root, beforeApproval, listed);
  assert.equal(check.status, 'passed', remotePresenceText(check));
  const row = check.stories.find((entry) => entry.workId === WORK);
  assert.deepEqual([row.required, row.signed >= 1, row.invalid], [true, true, 0]);
  forgetPresenceContexts();
  const signedWorkflow = await workflowOf(item);
  await inRoot(root, () => loadPresenceContext(root, signedWorkflow));
  const report = await inRoot(root, () => storyPresenceReport(root, signedWorkflow));
  assert.ok(report.value.elapsedMs < 50, `re-verifying the Story took ${report.value.elapsedMs} ms`);
  assert.match(receiptPresenceText({ status: 'required', signed: report.value.summary.signed, bypass: 0, preSigning: 0, notCounted: 0 }), /signed · every signature re-verified/u);

  // AC-011: a clone whose verifier was patched writes an unsigned approval. The final check's counting
  // and the review facet leave it out, and the remote check fails, naming the person's route.
  const signedRecord = signedWorkflow.phases.specification.approvals.at(-1);
  const { presence: _presence, ...stripped } = signedRecord;
  const forgedRecord = { ...stripped, at: new Date(Date.parse(signedRecord.at) + 1000).toISOString(), identityAssurance: 'configured-local', actor: { ...signedRecord.actor } };
  const forgedWorkflow = structuredClone(signedWorkflow);
  forgedWorkflow.phases.specification.approvals = [forgedRecord];
  forgetPresenceContexts();
  await inRoot(root, () => loadPresenceContext(root, forgedWorkflow));
  assert.deepEqual(countedApprovals(forgedWorkflow, forgedWorkflow.phases.specification.approvals), [], 'the forged approval does not count');
  assert.equal(reviewFacet(forgedWorkflow.phases.specification, forgedWorkflow), 'pending');
  assert.notEqual(reviewFacet(signedWorkflow.phases.specification, signedWorkflow), 'pending', 'the signed approval counts');
  // The final check's own in-memory preview decision still counts; a record claiming it on disk does not.
  const preview = markSyntheticApproval({ decision: 'approved', preview: true, actor: null });
  assert.deepEqual(countedApprovals(forgedWorkflow, [preview, { ...forgedRecord, preview: true }]), [preview]);
  // The final check counts only the verified approval: with the forged one alone, the threshold is
  // unmet, the refusal says why and names the person's route, and the record itself is named.
  forgetPresenceContexts();
  const gate = await inRoot(root, async () => runGovernanceGate(root, await loadDefinition(root), forgedWorkflow));
  assert.equal(gate.error, undefined, gate.error?.stack);
  const threshold = gate.value.findings.find((finding) => finding.code === 'gate.approval.threshold' && finding.phase === 'specification');
  assert.ok(threshold, JSON.stringify(gate.value.findings.map((finding) => finding.code)));
  assert.match(threshold.details.message, /SF Guard did not count 1 approval\(s\): it carries no presence signature[\s\S]*singularity-flow approve specification --work-id PSS-M4/u);
  assert.ok(gate.value.warnings.some((line) => /SF Guard: specification approved .* does not count/u.test(line)), gate.value.warnings.join('\n'));
  const withForgery = structuredClone(signedWorkflow);
  withForgery.phases.specification.approvals.push(forgedRecord);
  await writeWorkflow(item, withForgery);
  git('commit', '-qam', 'A patched clone adds an approval');
  check = await remote(root, approvedHead, listed);
  assert.equal(check.status, 'failed');
  assert.equal(check.failures[0].code, 'PSS_RECORD_UNSIGNED', remotePresenceText(check));
  assert.match(check.failures[0].route, /singularity-flow approve specification --work-id PSS-M4/u);
  // The same record already on the base is named, never failing an unrelated change.
  check = await remote(root, git('rev-parse', 'HEAD'), listed);
  assert.equal(check.status, 'passed', remotePresenceText(check));
  assert.ok(check.warnings.some((line) => /already on the base and counts for nothing/u.test(line)));
  git('reset', '-q', '--hard', approvedHead);

  // A signed record may never disappear, and a withdrawal or invalidation is never taken back.
  const removed = structuredClone(signedWorkflow);
  removed.phases.specification.approvals = removed.phases.specification.approvals.filter((entry) => !entry.presence);
  await writeWorkflow(item, removed);
  git('commit', '-qam', 'Drop the signed approval');
  check = await remote(root, approvedHead, listed);
  assert.equal(check.failures[0]?.code, 'PSS_RECORD_REMOVED', remotePresenceText(check));
  git('reset', '-q', '--hard', approvedHead);
  const invalidated = structuredClone(signedWorkflow);
  invalidated.phases.specification.approvals.at(-1).invalidatedAt = new Date().toISOString();
  await writeWorkflow(item, invalidated);
  git('commit', '-qam', 'The engine invalidates the approval');
  const invalidatedHead = git('rev-parse', 'HEAD');
  check = await remote(root, approvedHead, listed);
  assert.equal(check.status, 'passed', remotePresenceText(check));
  assert.ok(check.warnings.some((line) => /gains invalidatedAt/u.test(line)), 'an added invalidation is shown');
  await writeWorkflow(item, signedWorkflow);
  git('commit', '-qam', 'Take the invalidation back');
  check = await remote(root, invalidatedHead, listed);
  assert.equal(check.failures[0]?.code, 'PSS_WITHDRAWAL_REMOVED', remotePresenceText(check));
  git('reset', '-q', '--hard', approvedHead);

  // The policy file only grows, and every event it adds verifies.
  const chainPath = path.join(root, PRESENCE_CHAIN_PATH);
  const chain = JSON.parse(await readFile(chainPath, 'utf8'));
  const forgedDisable = nextPresenceEvent(chain, { kind: 'disable', reason: 'An agent turns it off.' });
  forgedDisable.signatures.push({ signer: approverId(ONE), keyId: key.keyId, nonce: 'f'.repeat(32), signature: 'not a signature' });
  await writeFile(chainPath, JSON.stringify({ ...chain, events: [...chain.events, forgedDisable] }, null, 2));
  git('commit', '-qam', 'Turn SF Guard off without a signature');
  check = await remote(root, approvedHead, listed);
  assert.equal(check.failures[0]?.code, 'PSS_POLICY_UNSIGNED', remotePresenceText(check));
  git('reset', '-q', '--hard', approvedHead);
  await writeFile(chainPath, JSON.stringify({ ...chain, events: chain.events.slice(0, 1) }, null, 2));
  git('commit', '-qam', 'Shorten the policy');
  check = await remote(root, approvedHead, listed);
  assert.ok(check.failures.some((entry) => entry.code === 'PSS_POLICY_REWRITTEN'), remotePresenceText(check));
  git('reset', '-q', '--hard', approvedHead);

  // A key event a change adds must be on the approver's GitHub account now. An agent registering its
  // own key for an approver with none folds locally (it is self-signed), and only GitHub refuses it.
  const agent = softwarePresenceKey();
  const register = nextPresenceEvent(chain, { kind: 'register', approver: approverId(THREE), key: agent.line, keyId: agent.keyId,
    github: { listed: true, snapshotSha256: `sha256:${'b'.repeat(64)}`, fetchedAt: new Date().toISOString() } });
  const entry = { signer: approverId(THREE), keyId: agent.keyId, nonce: 'e'.repeat(32) };
  register.signatures.push({ ...entry, signature: agent.sign(statementText(presenceEventStatement(chain.chainId, register, entry))) });
  const withRegister = { ...chain, events: [...chain.events, register] };
  assert.equal(foldPresenceChain(withRegister).validLength, withRegister.events.length, 'it folds locally');
  await writeFile(chainPath, JSON.stringify(withRegister, null, 2));
  git('commit', '-qam', 'An agent registers its own key');
  check = await remote(root, approvedHead, githubWith((login) => (login === THREE.githubLogin ? snapshot([]) : snapshot([key]))));
  assert.equal(check.failures[0]?.code, 'PSS_KEY_NOT_LISTED', remotePresenceText(check));
  // GitHub unreachable: unconfirmed, never failing for that alone.
  check = await remote(root, approvedHead, githubWith(() => ({ status: 'unavailable', keys: [], snapshotSha256: null, fetchedAt: null, reason: 'offline' })));
  assert.equal(check.status, 'passed', remotePresenceText(check));
  assert.match(check.unconfirmed.join('\n'), /GitHub could not be read \(offline\)/u);
  git('reset', '-q', '--hard', approvedHead);

  // A Story created after the opt-in whose record reads as made before it: its pin was forged.
  const forgedItem = path.join(root, 'singularity/work-items', 'PSS-M4B');
  await cp(item, forgedItem, { recursive: true });
  const forgedStory = structuredClone(signedWorkflow);
  forgedStory.workItem.id = 'PSS-M4B';
  delete forgedStory.resolution.presence;
  await writeWorkflow(forgedItem, forgedStory);
  git('add', '-A');
  git('commit', '-qm', 'A Story with no pin');
  check = await remote(root, approvedHead, listed);
  const pinFailure = check.failures.find((failure) => failure.code === 'PSS_PIN_FORGED');
  assert.ok(pinFailure, remotePresenceText(check));
  assert.match(pinFailure.message, /descends from the opt-in/u);
  git('reset', '-q', '--hard', approvedHead);

  // guard status lists where the remote check stands; guard remote-check prints its CI recipe.
  const standing = await guardRun(root, ['status'], guardPerson(ONE.email, [key], { requiredCheck: async () => ({ status: 'required', contexts: ['sf-guard-verify'], reason: null }) }));
  assert.equal(standing.error, undefined, standing.error?.message);
  assert.equal(JSON.parse(standing.lines.join('\n')).remote.status, 'required');
  const recipe = await guardRun(root, ['remote-check'], guardPerson(ONE.email, [key]));
  assert.equal(recipe.error, undefined, recipe.error?.message);
  const recipeResult = JSON.parse(recipe.lines.join('\n'));
  assert.deepEqual([recipeResult.path, recipeResult.incomplete], ['.github/workflows/sf-guard-verify.yml', true]);
  assert.match(recipeResult.recipe, /name: sf-guard-verify/u);
});

test('a repository that never opted in passes the remote check with nothing to verify', async (t) => {
  const { root, cli } = await startedSpecificationStory(t, 'PSS-OFF');
  const check = await remote(root, null, githubWith(() => snapshot([])));
  assert.equal(check.status, 'not-opted-in');
  assert.match(remotePresenceText(check), /has not opted in/u);
  // The command a CI job runs: routed, its flags parsed, read only, exit 0.
  const ran = cli('governance', 'verify', '--presence', '--base', 'HEAD', '--json');
  assert.equal(JSON.parse(ran.stdout).status, 'not-opted-in');
  assert.equal(cli('guard', 'remote-check', '--recipe').stdout.includes('pull_request_target:'), true);
});

test('the lone-approver fallback: a host-reviewed exception folds only with no other approver to sign it', () => {
  const key = softwarePresenceKey();
  const other = softwarePresenceKey();
  const chain = { schema: 'sflow-presence-chain@1', chainId: 'c'.repeat(32), events: [] };
  const signed = (base, fields, signerId, signingKey) => {
    const event = nextPresenceEvent(base, fields);
    const entry = { signer: signerId, keyId: signingKey.keyId, nonce: 'd'.repeat(32) };
    event.signatures.push({ ...entry, signature: signingKey.sign(statementText(presenceEventStatement(base.chainId, event, entry))) });
    return { ...base, events: [...base.events, event] };
  };
  const registerFields = (who, signingKey) => ({ kind: 'register', approver: approverId(who), key: signingKey.line, keyId: signingKey.keyId,
    github: { listed: true, snapshotSha256: `sha256:${'a'.repeat(64)}`, fetchedAt: new Date().toISOString() } });
  const lone = signed(chain, registerFields(ONE, key), approverId(ONE), key);
  const hostException = (base, who) => ({ ...base, events: [...base.events, nextPresenceEvent(base, { kind: 'exception',
    exception: { id: 'EXC-001', approver: approverId(who), reason: 'Lost the only Mac.' }, authorization: { kind: 'host-review', reason: 'Lost the only Mac.' } })] });
  const accepted = foldPresenceChain(hostException(lone, ONE));
  assert.deepEqual([accepted.validLength, accepted.problems], [2, []]);
  assert.equal(accepted.exceptions.get('EXC-001').hostReview, true);
  // With another approver holding a key, they must sign it: the unsigned event stops the fold.
  const two = signed(lone, registerFields(THREE, other), approverId(THREE), other);
  const refused = foldPresenceChain(hostException(two, ONE));
  assert.equal(refused.validLength, 2);
  assert.match(refused.problems[0].message, /another approver has a pinned key/u);
  // Any other unsigned event still stops the fold, as before.
  const unsigned = { ...lone, events: [...lone.events, nextPresenceEvent(lone, { kind: 'disable', reason: 'x' })] };
  assert.equal(foldPresenceChain(unsigned).problems[0].code, 'PSS_CHAIN_INVALID');
});

test('history: a person record may gain a withdrawal but never disappear or be revived', () => {
  const signed = (id, extra = {}) => ({ id, decision: 'accept', presence: { schema: 'sflow-presence-record@1', signature: `sig-${id}`, nonce: `n-${id}` }, ...extra });
  const base = { phaseOrder: [], phases: {}, riskDecisions: [signed('RISK-1'), signed('RISK-2', { withdrawnAt: '2026-11-02T00:00:00Z' })], scopeDispositions: [{ id: 'old', decision: 'x' }] };
  const head = { phaseOrder: [], phases: {}, riskDecisions: [signed('RISK-1', { withdrawnAt: '2026-11-02T01:00:00Z' }), signed('RISK-2')], scopeDispositions: [] };
  const problems = presenceHistoryProblems(base, head);
  assert.deepEqual(problems.removed, [], 'a record made before SF Guard has no stable identity and is not compared');
  assert.deepEqual(problems.revived.map((entry) => [entry.name, entry.field]), [['riskDecisions RISK-2', 'withdrawnAt']]);
  assert.deepEqual(problems.withdrawn.map((entry) => entry.name), ['riskDecisions RISK-1']);
  assert.deepEqual(presenceHistoryProblems(base, { ...head, riskDecisions: [] }).removed.map((entry) => entry.name), ['riskDecisions RISK-1', 'riskDecisions RISK-2']);
});

test('the host: GitHub remotes, required checks, reviews, and the CI recipe', async () => {
  const host = ['github', 'com'].join('.');
  assert.deepEqual(githubRepository(`git@${host}:acme/flow.git`), { owner: 'acme', repo: 'flow' });
  assert.deepEqual(githubRepository(`https://${host}/acme/flow`), { owner: 'acme', repo: 'flow' });
  assert.equal(githubRepository('https://example.test/acme/flow.git'), null);
  const repository = { owner: 'acme', repo: 'flow' };
  const answer = (body, status = 200) => async () => ({ status, body: JSON.stringify(body), link: null });
  assert.equal((await requiredStatusCheck(repository, 'main', 'sf-guard-verify', { request: answer({ protected: true, protection: { required_status_checks: { contexts: ['sf-guard-verify'] } } }) })).status, 'required');
  assert.equal((await requiredStatusCheck(repository, 'main', 'sf-guard-verify', { request: answer({ protected: true, protection: { required_status_checks: { contexts: ['build'] } } }) })).status, 'not-required');
  assert.equal((await requiredStatusCheck(repository, 'main', 'sf-guard-verify', { request: answer({ protected: false }) })).status, 'unprotected');
  assert.equal((await requiredStatusCheck(repository, 'main', 'sf-guard-verify', { request: answer({}, 404) })).status, 'unavailable');
  assert.equal((await requiredStatusCheck(repository, 'main', 'sf-guard-verify', { request: async () => { throw new Error('offline'); } })).status, 'unavailable');
  const reviews = (list) => async (pathname) => (pathname.endsWith('/pulls/7')
    ? { status: 200, body: JSON.stringify({ number: 7, user: { login: 'author' } }), link: null }
    : { status: 200, body: JSON.stringify(list), link: null });
  assert.equal((await hostReview(repository, { pullRequest: 7 }, { request: reviews([{ state: 'APPROVED', user: { login: 'author' }, author_association: 'OWNER' }]) })).status, 'not-reviewed', 'the author cannot approve their own change');
  assert.equal((await hostReview(repository, { pullRequest: 7 }, { request: reviews([{ state: 'APPROVED', user: { login: 'reviewer' }, author_association: 'MEMBER' }]) })).status, 'reviewed');
  assert.equal((await hostReview(repository, { pullRequest: 7 }, { request: reviews([{ state: 'APPROVED', user: { login: 'stranger' }, author_association: 'NONE' }]) })).status, 'not-reviewed');
  const recipe = sfGuardVerifyWorkflowText({ checkName: 'sf-guard-verify', branch: 'main' });
  assert.match(recipe, /pull_request_target:/u, 'the default branch\'s file runs, so a pull request cannot change it');
  assert.match(recipe, /sha256sum --check --strict/u);
  assert.match(recipe, /singularity-flow governance verify --presence "\$@"/u);
  assert.match(recipe, /persist-credentials: false/u);
  assert.equal(sfGuardRecipeIncomplete(recipe), true);
  const pinned = sfGuardVerifyWorkflowText({ packageUrl: 'https://example.test/singularity-flow-1.0.0.tgz', packageSha256: '0'.repeat(64) });
  assert.equal(sfGuardRecipeIncomplete(pinned), false);
});
