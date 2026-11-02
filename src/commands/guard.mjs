/**
 * `singularity-flow guard <action>`: SF Guard, presence-signed person steps (SPEC-PSS-v1 M1).
 *
 * `status` reads. Every other action is a person's own step: it shows its card in the person's
 * terminal, takes one Touch ID signature from their Secure Enclave key, and records a signed event in
 * the approved configuration's `singularity/presence.json` (written here, or proposed for review
 * with --propose when an approved configuration branch exists). The Copilot guard refuses each of them
 * for agents in every turn (OWN_TERMINAL_STEPS `sf-guard-person-step`), and a forged event never
 * verifies, because it needs the person's touch.
 *
 * `remote-check` reads too (M4): whether the remote check the opt-in named is a required status check
 * of the default branch, and the CI recipe that runs it. A repository that never opts in has no file
 * and behaves exactly as before.
 *
 * The signer, GitHub, the key readers and the configuration writer are parameters (`dependencies`),
 * so tests run every route with software keys and no environment switch.
 */
import path from 'node:path';

import { identity, repoRoot } from '../git.mjs';
import { GITHUB_KEYS_PAGE, GITHUB_SIGNING_KEY_PAGE, githubListsKey, githubSigningKeys } from '../presence/anchor.mjs';
import {
  activeException, approverId, approverStanding, emptyPresenceChain, foldPresenceChain, nextExceptionId,
  nextPresenceEvent, PRESENCE_CHAIN_PATH, presenceApprovers, presenceEventStatement, WINDOWS_EXCEPTION_REASON
} from '../presence/chain.mjs';
import { ctkIdentities, presenceIdentityStanding, readableCopies } from '../presence/local-keys.mjs';
import { presenceNonce } from '../presence/statement.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

export const GUARD_ACTIONS = Object.freeze(['status', 'reconcile', 'report', 'remote-check', 'register', 'rotate', 'recover', 'revoke', 'enable', 'disable', 'exception', 'stamp-agents']);
export const GUARD_READ_ACTIONS = Object.freeze(['status', 'reconcile', 'report', 'remote-check']);
/** The person's own steps: refused for agents, whatever the turn. */
export const GUARD_PERSON_ACTIONS = Object.freeze(GUARD_ACTIONS.filter((action) => !GUARD_READ_ACTIONS.includes(action)));
const USAGE = 'Usage: singularity-flow guard <status|reconcile|report|remote-check|register|rotate|recover|revoke|enable|disable|exception add|exception revoke|stamp-agents> …  (singularity-flow help guard)';
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

function print(options, json, text) {
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({ schemaVersion: 1, resultType: 'sflow-guard', ...json }, null, 2)); // schema-transient: command result
  else console.log(text);
}


/** The approver the person running this is, from their Git identity. */
function currentApprover(root, approvers, { identify = identity } = {}) {
  const who = identify(root, { offline: true });
  const email = String(who?.email ?? '').trim().toLowerCase();
  const login = String(who?.login ?? '').trim().toLowerCase();
  const match = [...approvers.values()].find((entry) => (email && entry.email === email) || (login && entry.githubLogin === login));
  if (!match) {
    fail(`SF Guard: your Git identity${email ? ` (${email})` : ''} is not an approver in the approved configuration, so it has no presence key to record. `
      + 'Ask an approver to add you as a member (singularity-flow configuration people), then run this again.', 'PSS_NOT_AN_APPROVER');
  }
  return match;
}

/**
 * The person running this as an author (SPEC-PSS-v1 §10.5): someone who is not an approver, pinning a
 * key only to sign their own authorship claims (`phase publish --authored human|external-tool`). Their
 * ID is their Git email's; GitHub must still list the key, under the login they name.
 */
function currentAuthor(root, approvers, options, { identify = identity } = {}) {
  const who = identify(root, { offline: true });
  const email = String(who?.email ?? '').trim().toLowerCase();
  const login = String(optionString(options, 'github-login') ?? who?.login ?? '').trim().toLowerCase();
  if ([...approvers.values()].some((entry) => (email && entry.email === email) || (login && entry.githubLogin === login))) {
    fail('SF Guard: you are an approver in the approved configuration, so register your presence key as one: singularity-flow guard register (without --author).', 'PSS_ARGUMENT_INVALID');
  }
  const id = email.includes('@') ? approverId({ email }) : null;
  if (!id) fail('SF Guard: your Git identity has no email to register an author key under. Set git config user.email, then run this again.', 'PSS_NOT_AN_APPROVER');
  return { approver: id, label: email, githubLogin: login || null, email, groups: [], role: 'author' };
}

async function readState(root, { verify } = {}) {
  const [{ withApprovedConfigurationRead }, { loadDefinition }, { readPresencePolicy }] = await Promise.all([
    import('../approved-configuration-reader.mjs'), import('../config.mjs'), import('../presence/store.mjs')]);
  return withApprovedConfigurationRead(root, async () => {
    const definition = await loadDefinition(root);
    const policy = await readPresencePolicy(root, { verify });
    return { definition, policy, approvers: presenceApprovers(definition) };
  }, { preferAuthority: true });
}

/** The chain an event is appended to: the valid prefix, so an invalid tail never strands anyone. */
function baseChain(policy) {
  const chain = policy.chain ?? emptyPresenceChain();
  return { ...chain, events: chain.events.slice(0, policy.folded.validLength) };
}

/**
 * Sign `event` (appended to `chain`) once per `signers` entry (`{ approver, keyId, publicKey, title,
 * lines }`): the card, then one Touch ID touch each.
 */
async function signEvent(chain, event, signers, deps) {
  for (const signer of signers) {
    const entry = { signer: signer.approver, keyId: signer.keyId, nonce: presenceNonce() };
    const statement = presenceEventStatement(chain.chainId, event, entry);
    const card = await deps.card({
      title: signer.title,
      lines: [...signer.lines, `Records: ${PRESENCE_CHAIN_PATH} event ${event.seq} (${event.kind}) in policy chain ${chain.chainId}`],
      keyId: signer.keyId
    });
    const signed = await deps.sign({ statement, keyId: signer.keyId, publicKey: signer.publicKey, card });
    event.signatures.push({ ...entry, signature: signed.signature });
  }
  return { ...chain, events: [...chain.events, event] };
}

/** This Mac's presence identity for `keyId` (or its only one), checked as REQ-025 asks, with its public key. */
async function presenceKey(deps, { keyId = null, purpose }) {
  const listing = deps.listIdentities();
  if (!listing.available) fail(`SF Guard cannot ${purpose} on this computer: ${listing.reason}. Use a Mac with macOS 26 or later, or ask another approver to record a per-person exception for you (singularity-flow guard exception add <APPROVER-ID>).`, 'PSS_SIGNER_UNAVAILABLE');
  const usable = listing.identities.filter((row) => row.keyType === 'p-256-ne' && row.protection === 'bio');
  const chosen = keyId ?? (usable.length === 1 ? usable[0].keyId : null);
  if (!chosen) {
    fail(usable.length
      ? `This Mac has ${usable.length} Touch ID presence identities; name one with --key: ${usable.map((row) => `${row.keyId} (${row.label})`).join(', ')}.`
      : 'This Mac has no Touch ID presence identity yet. Create one in your own terminal: /usr/sbin/sc_auth create-ctk-identity -l sf-guard -k p-256-ne -t bio',
    'PSS_KEY_NOT_PRESENCE', { identities: usable.map((row) => ({ keyId: row.keyId, label: row.label })) });
  }
  const copies = deps.readableCopies(chosen);
  if (copies.length) {
    fail(`SF Guard will not pin ${chosen}: a copy an agent could use is readable (${copies.map((copy) => copy.path ?? copy.where).join(', ')}). Pin a Secure Enclave identity instead: /usr/sbin/sc_auth create-ctk-identity -l sf-guard -k p-256-ne -t bio`,
      'PSS_KEY_READABLE', { keyId: chosen, copies });
  }
  const standing = presenceIdentityStanding(listing, chosen);
  if (!standing.ok) {
    const route = standing.code === 'PSS_KEY_EXPIRED'
      ? 'Create a new identity (/usr/sbin/sc_auth create-ctk-identity -l sf-guard -k p-256-ne -t bio), list it on GitHub as a Signing Key, then run singularity-flow guard rotate --key <NEW-KEY-ID> (or guard recover --key <NEW-KEY-ID> if the old one no longer signs).'
      : 'Pin a non-exportable Touch ID identity: /usr/sbin/sc_auth create-ctk-identity -l sf-guard -k p-256-ne -t bio';
    fail(`SF Guard will not use ${chosen}: ${standing.reason}. ${route}`, standing.code, { keyId: chosen });
  }
  const publicKey = await deps.publicKeyOf(chosen);
  if (!publicKey) fail(`This Mac's Secure Enclave does not give a public key for ${chosen}. Check with /usr/sbin/sc_auth list-ctk-identities -t ssh.`, 'PSS_KEY_NOT_PRESENCE');
  return { keyId: chosen, publicKey, row: standing.row };
}

/** GitHub's listing for `approver`, refusing unreachable or unlisted rather than guessing. */
async function githubListing(approver, keyId, deps) {
  if (!approver.githubLogin) {
    fail(`SF Guard pins a key only while the approver's GitHub account lists it, and ${approver.label} has no GitHub login in the approved configuration. `
      + 'Add their githubLogin to their member entry (singularity-flow configuration people), or have another approver record a per-person exception: '
      + `singularity-flow guard exception add ${approver.approver}`, 'PSS_KEY_NOT_LISTED', { approver: approver.approver });
  }
  const snapshot = await deps.githubKeys(approver.githubLogin);
  if (snapshot.status === 'unavailable') {
    fail(`SF Guard could not reach GitHub to confirm ${keyId} (${snapshot.reason}). Nothing was recorded; run the same command again when GitHub answers.`, 'PSS_ANCHOR_UNAVAILABLE', { keyId });
  }
  if (!githubListsKey(snapshot, keyId)) {
    fail(`GitHub does not list ${keyId} as a signing key of ${approver.label}. Add it at ${GITHUB_SIGNING_KEY_PAGE} (Key type: Signing Key), paste the public key, and check its fingerprint matches /usr/sbin/sc_auth list-ctk-identities -t ssh; then run this again.`,
      'PSS_KEY_NOT_LISTED', { keyId, approver: approver.approver });
  }
  return snapshot;
}

function requirePin(folded, approver, purpose) {
  const pin = folded.pins.get(approver.approver);
  if (!pin) {
    fail(`SF Guard: ${approver.label} has no presence key pinned, so it cannot ${purpose}. Register one first: singularity-flow guard register`, 'PSS_KEY_NOT_REGISTERED', { approver: approver.approver });
  }
  return pin;
}

function pinSigner(approver, pin, title, lines) {
  return { approver: approver.approver, keyId: pin.keyId, publicKey: pin.key, title, lines };
}

async function writeChain(root, chain, options, summary, deps, stamps = []) {
  const { STUDIO_CHANGE_SET_SCHEMA } = await import('../workflow-studio.mjs');
  const changes = [...(chain ? [{ op: 'presence.set', chain }] : []), ...stamps.map((id) => ({ op: 'agent.stamp', id }))];
  const result = await deps.write(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes }, options,
    { subject: 'sf-guard', message: `[configuration] SF Guard: ${summary}` });
  if (result?.valid === false) fail(`SF Guard did not record it: ${result.problems?.[0]?.message ?? 'the configuration change was refused'}.`, result.problems?.[0]?.code ?? 'PSS_CHAIN_INVALID');
  return result;
}

function writtenLines(result, { chain = true, stamps = 0 } = {}) {
  if (result?.reviewRequired) return [`Proposed for review as ${result.branch}. It takes effect once approved: singularity-flow configuration approve ${result.branch}`];
  const files = [...(chain ? [PRESENCE_CHAIN_PATH] : []), ...(stamps ? ['the stamped agent files in .github/agents'] : [])];
  return [`Written to ${files.join(' and ')}. Review the diff and commit ${stamps ? 'them' : 'it'} with the rest of the configuration.`];
}

/** The agent files SF Guard stamps [SPEC-SFG-v1 D4]: the ones this repository owns, not APM's. */
const stampable = (definition) => (definition?.agentCatalog ?? []).filter((agent) => agent.scope === 'repository' && !agent.apm);

/**
 * Each stampable agent as the approved configuration has it: whether its file carries SF Guard's
 * stamp, and whether the working tree's file still has the approved bytes (any change could let an
 * agent stamp itself as this one, so it is labelled).
 */
async function agentStamps(root, definition) {
  const [{ readFile }, { createHash }, { splitAgentText }, { isSfGuardStamp }] = await Promise.all([import('node:fs/promises'),
    import('node:crypto'), import('../agent-file.mjs'), import('../comprehension/xpl2/sf-guard-recorder.mjs')]);
  const rows = [];
  for (const agent of stampable(definition)) {
    let hooks = null;
    try { hooks = splitAgentText(agent.text, agent.id).document.get('hooks')?.toJSON?.() ?? null; } catch { hooks = null; }
    const stamped = Array.isArray(hooks?.userPromptSubmitted) && hooks.userPromptSubmitted.some((entry) => isSfGuardStamp(entry, agent.id));
    const relative = agent.source ?? path.relative(root, agent.file).split(path.sep).join('/');
    const onDisk = await readFile(path.join(root, relative)).catch(() => null);
    const changed = !onDisk || createHash('sha256').update(onDisk).digest('hex') !== agent.sha256;
    // G4 (AC-011): a stamped file whose stamping hook was removed or edited is labelled as drift.
    const drift = stamped && changed ? await (await import('../presence/agent-drift.mjs')).agentFileDrift(onDisk ? onDisk.toString('utf8') : null, agent.id) : null;
    rows.push({ id: agent.id, path: relative, sha256: agent.sha256, stamped, changed, ...(drift ? { drift } : {}) });
  }
  return rows;
}

/** The stamp rows as written just now: the bytes on disk are the configuration this change records. */
async function writtenStamps(root, rows) {
  const [{ readFile }, { createHash }, { splitAgentText }, { isSfGuardStamp }] = await Promise.all([import('node:fs/promises'),
    import('node:crypto'), import('../agent-file.mjs'), import('../comprehension/xpl2/sf-guard-recorder.mjs')]);
  const written = [];
  for (const row of rows) {
    const bytes = await readFile(path.join(root, row.path)).catch(() => null);
    if (!bytes) continue;
    let stamped = false;
    try { stamped = (splitAgentText(bytes.toString('utf8'), row.id).document.get('hooks')?.toJSON?.()?.userPromptSubmitted ?? []).some((entry) => isSfGuardStamp(entry, row.id)); } catch { stamped = false; }
    written.push({ ...row, stamped, changed: false, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return written;
}

function standingRows(state) {
  const { folded } = state.policy;
  const rows = [...state.approvers.values()].map((entry) => ({ ...entry, standing: approverStanding(folded, entry.approver) }));
  // Pinned or excepted approvers the configuration no longer lists are still shown.
  for (const approver of new Set([...folded.pins.keys(), ...[...folded.exceptions.values()].filter((entry) => entry.active).map((entry) => entry.approver)])) {
    if (!state.approvers.has(approver)) rows.push({ approver, label: '(not in the approved configuration)', groups: [], standing: approverStanding(folded, approver) });
  }
  // Authors: a key that signs only its own authorship claims (SPEC-PSS-v1 §10.5).
  for (const [author, pin] of folded.authorPins ?? new Map()) {
    rows.push({ approver: author, label: '(author)', groups: [], standing: { state: 'author', pin, exception: null, label: `author: signs their own authorship claims with ${pin.keyId}` } });
  }
  return rows;
}

/**
 * When a pinned key's certificate expires (SPEC-PSS-v1 REQ-014), as this Mac's `sc_auth` listing says,
 * or why it cannot be read here: another computer, or a key this Mac does not hold.
 */
function keyExpiry(listing, keyId) {
  if (!keyId) return null;
  if (!listing?.available) return { here: false, validTo: null, valid: null, reason: listing?.reason ?? 'this computer has no macOS sc_auth' };
  const row = listing.identities.find((entry) => entry.keyId === keyId);
  if (!row) return { here: false, validTo: null, valid: null, reason: 'this Mac does not hold it' };
  return { here: true, validTo: row.validTo, valid: row.valid, reason: null };
}

function statusResult(state, stamps = [], remote = null, recording = null, configuration = null, outside = null, listing = null) {
  const { folded, problems, historyChecked } = state.policy;
  return {
    status: folded.enabled ? 'required' : 'off',
    // Whether this checkout records attribution, and the last time it could not (SPEC-SFG-v1 REQ-023, AC-013).
    ...(recording ? { recording } : {}),
    // G4: the last seven days' recorded Copilot calls outside any Story, by class (guard report has them by agent and skill).
    ...(outside ? { outsideStories: outside } : {}),
    chainId: folded.chainId, events: folded.length, validEvents: folded.validLength, historyChecked, remoteCheck: folded.remoteCheck,
    ...(remote ? { remote } : {}),
    // The approved configuration commit's approval seal (SPEC-PSS-v1 §10.9).
    ...(configuration ? { configuration: { commit: configuration.commit, state: configuration.state, counts: configuration.counts, label: configuration.label, reason: configuration.reason } } : {}),
    agents: stamps.map(({ id, path, stamped, changed, drift }) => ({ id, path, stamp: !stamped ? 'not-stamped' : changed ? 'changed' : 'stamped', ...(drift ? { drift } : {}) })),
    approvers: standingRows(state).map(({ approver, label, groups, standing }) => ({
      approver, label, groups, state: standing.state, standing: standing.label, keyId: standing.pin?.keyId ?? null,
      recovered: Boolean(standing.pin?.recovered), exception: standing.exception?.id ?? null, expiry: keyExpiry(listing, standing.pin?.keyId ?? null)
    })),
    exceptions: [...folded.exceptions.values()],
    retired: folded.retired,
    problems
  };
}

function statusText(result) {
  const lines = [`SF Guard: ${result.status === 'required' ? 'on — person steps are presence-signed (enforced from M2)' : 'off — person steps unsigned in this repository'}`];
  if (result.chainId) lines.push(`  Policy chain ${result.chainId}: ${result.validEvents} of ${result.events} event(s) verify${result.historyChecked ? '' : ' (history not checked: not available in this clone)'}.`);
  if (result.remote) lines.push(`  ${remoteStandingText(result.remote)}`);
  else if (result.remoteCheck) lines.push(`  Remote check: ${result.remoteCheck}`);
  for (const row of result.approvers) {
    const expiry = row.expiry?.here ? `; key ${row.expiry.valid === false ? 'EXPIRED' : 'valid'}${row.expiry.validTo ? ` to ${row.expiry.validTo}` : ''}` : '';
    lines.push(`  ${row.label} [${row.approver}]: ${row.standing}${row.recovered ? ' (recovered)' : ''}${expiry}`);
  }
  for (const problem of result.problems) lines.push(`  Problem (${problem.code}): ${problem.message}`);
  if (result.configuration) {
    lines.push(`  Approved configuration ${String(result.configuration.commit).slice(0, 12)}: ${result.configuration.counts ? result.configuration.label ?? result.configuration.state : `${result.configuration.label}; a person approves it in their own terminal (singularity-flow configuration approve <proposal>), where it takes their Touch ID`}.`);
  }
  const unstamped = result.agents.filter((row) => row.stamp !== 'stamped');
  if (result.status === 'required' && result.agents.length) {
    lines.push(`  Agent stamps: ${result.agents.length - unstamped.length} of ${result.agents.length} agent file(s) stamped${unstamped.length ? `; ${unstamped.map((row) => `${row.id} ${row.drift ? `(drift: ${DRIFT_WORDS[row.drift] ?? row.drift}; its stamps no longer prove which agent ran, and every label says so)` : row.stamp === 'changed' ? '(file changed since approved: its work is labelled)' : '(not stamped: its work reads "agent unknown")'}`).join(', ')}. Stamp them: singularity-flow guard stamp-agents` : ''}.`);
  }
  if (result.outsideStories) {
    const parts = Object.entries(result.outsideStories.totals).filter(([, count]) => count).map(([name, count]) => `${count} ${name}`);
    lines.push(`  Copilot calls outside any Story, last 7 days: ${parts.length ? parts.join(' · ') : 'none recorded'} (by agent and skill: singularity-flow guard report --since 7d).`);
  }
  if (result.recording) {
    lines.push(`  Attribution recording here: ${result.recording.state}${result.recording.lastGap ? `; last gap ${result.recording.lastGap.code} at ${result.recording.lastGap.at} (${result.recording.gaps} recent; the hooks' answers were unchanged)` : '; no gaps recorded'}.`);
  }
  if (result.status === 'off' && !result.chainId) lines.push('  Opt in: singularity-flow guard register, then singularity-flow guard enable (both in your own terminal, with Touch ID).');
  return lines.join('\n');
}

const DRIFT_WORDS = Object.freeze({ 'stamp-removed': 'stamping hook removed', 'stamp-edited': 'stamping hook edited', 'file-removed': 'agent file removed' });

/**
 * The last seven days' recorded calls outside any Story, by class [G4], where this checkout records;
 * no Git read. Null elsewhere or when unreadable: status never fails for it.
 */
async function outsideStoriesSummary(root, state, recording) {
  if (recording?.state !== 'on') return null;
  const { sfGuardReport } = await import('../presence/attribution.mjs');
  const report = await sfGuardReport(root, { definition: state.definition, policy: state.policy, since: '7d', lines: false });
  const subject = report.subjects.find((entry) => entry.scope === 'repository');
  return { since: report.since, totals: subject?.counts ?? Object.fromEntries(Object.keys(report.totals).map((name) => [name, 0])) };
}

/** Whether this checkout records attribution now, and its recent gaps (SPEC-SFG-v1 REQ-023). */
async function recordingHealth(root) {
  const recorder = await import('../comprehension/xpl2/sf-guard-recorder.mjs');
  const repository = await recorder.sfGuardRepository(root);
  const on = repository ? (await recorder.sfGuardOn(repository)).on : false;
  const gaps = await recorder.readSfGuardGaps(root).catch(() => []);
  return { state: on ? 'on' : 'off', gaps: gaps.length, lastGap: gaps.at(-1) ?? null };
}

/**
 * Where the remote check stands (SPEC-PSS-v1 REQ-030): the check the opt-in named and whether branch
 * protection makes it required on the default branch. Read only; SF Guard never changes protection.
 */
async function remoteStanding(root, state, deps) {
  const [{ githubRepository }, { remoteUrl, defaultBranchName }, { SF_GUARD_CHECK_NAME }] = await Promise.all([
    import('../presence/host.mjs'), import('../git.mjs'), import('../presence/remote-recipe.mjs')]);
  const check = state.policy.folded.remoteCheck ?? null;
  const repository = githubRepository(remoteUrl(root, 'origin'));
  const branch = defaultBranchName(root, state.definition ?? {});
  const protection = check ? await deps.requiredCheck(repository, branch, check) : null;
  return { check, suggested: SF_GUARD_CHECK_NAME, branch, repository: repository ? `${repository.owner}/${repository.repo}` : null,
    status: !check ? 'unnamed' : protection.status, contexts: protection?.contexts ?? [], reason: protection?.reason ?? null };
}

function remoteStandingText(remote) {
  if (remote.status === 'unnamed') {
    return `Remote check: none named. Name one when opting in (singularity-flow guard enable --remote-check ${remote.suggested}); singularity-flow guard remote-check prints the CI recipe.`;
  }
  if (remote.status === 'required') return `Remote check: ${remote.check} — a required status check on ${remote.branch}.`;
  if (remote.status === 'not-required' || remote.status === 'unprotected') {
    return `Remote check: ${remote.check} — NOT a required status check on ${remote.branch} yet${remote.reason ? ` (${remote.reason})` : ''}. Until it is, a merge is not held by it: add the CI recipe (singularity-flow guard remote-check) and make "${remote.check}" required in the repository's branch protection.`;
  }
  return `Remote check: ${remote.check} — whether it is required on ${remote.branch} could not be read (${remote.reason}); check the repository's branch protection.`;
}

const defaultDependencies = () => ({
  listIdentities: () => ctkIdentities(),
  readableCopies: (keyId) => readableCopies(keyId),
  publicKeyOf: async (keyId) => {
    const [{ presenceKeyStubs }, { rm }] = await Promise.all([import('../presence/signer.mjs'), import('node:fs/promises')]);
    const { directory, stubs } = await presenceKeyStubs();
    try { return stubs.find((stub) => stub.keyId === keyId)?.publicKey ?? null; }
    finally { await rm(directory, { recursive: true, force: true }); }
  },
  githubKeys: (login) => githubSigningKeys(login),
  card: async (fields) => (await import('../presence/signer.mjs')).presenceCard(fields),
  sign: async (request) => (await import('../presence/signer.mjs')).signWithPresence(request),
  write: async (root, changeSet, options, meta) => (await import('../cli.mjs')).applyImportChangeSet(root, changeSet, options, meta),
  identify: identity,
  verify: undefined,
  requiredCheck: async (repository, branch, check) => (await import('../presence/host.mjs')).requiredStatusCheck(repository, branch, check)
});

/**
 * The verified on/off state, left for the Copilot hooks so they can tell, without Git, whether to
 * record attribution here [SPEC-SFG-v1 REQ-060]. Best effort: it never fails the command.
 */
async function noteLocalState(root, enabled, stamps = null) {
  await import('../comprehension/xpl2/sf-guard-recorder.mjs').then(async (recorder) => {
    await recorder.writeSfGuardLocalState(root, enabled);
    // The approved bytes of each stamped agent file, which the hooks compare the working tree with.
    if (stamps) await recorder.writeSfGuardStampedAgents(root, stamps.filter((row) => row.stamped));
  }).catch(() => {});
}

/**
 * `guard reconcile`: the change set's lines, each with one class [SPEC-SFG-v1 REQ-030]. A Story
 * checkout reconciles the Story against its base, with its step's declared set; anywhere else, the
 * working tree and unpushed commits, with the repository's.
 */
async function reconcileResult(root, state) {
  const story = await import('../accepted-story-execution.mjs').then(({ loadAcceptedStoryExecution }) => loadAcceptedStoryExecution(root), () => null);
  const { reconcileHere } = await import('../presence/attribution.mjs');
  try {
    return await reconcileHere(root, { definition: story?.config ?? state.definition, policy: state.policy, workflow: story?.workflow ?? null });
  } catch (error) {
    if (error?.code) throw error;
    fail(`SF Guard could not read what changed here: ${error.message}`, 'SFG_CHANGE_SET_UNAVAILABLE');
  }
}

function reconcileText(result, driftLabels = []) {
  const scope = result.scope.kind === 'story' ? `Story ${result.scope.workId}, step ${result.scope.step}, since ${String(result.scope.base).slice(0, 12)}` : `this repository since ${String(result.scope.base).slice(0, 12)}`;
  const lines = [`SF Guard reconciliation for ${scope}${result.partial ? ` (partial: stopped at the ${result.partial.limit}-${result.partial.reason} bound)` : ''}:`];
  lines.push(`  ${result.lines} changed line(s) in ${result.files} file(s); ${result.removed} removed line(s) are not classed.`);
  for (const [name, count] of Object.entries(result.counts)) if (count) lines.push(`  ${name}: ${count} line(s)`);
  for (const range of result.ranges.slice(0, 20)) {
    if (range.classification === 'declared') continue;
    lines.push(`    ${range.path}:${range.start}${range.end > range.start ? `-${range.end}` : ''} ${range.classification}${range.agent || range.skill ? ` (agent ${range.agent ?? 'unknown'}, skill ${range.skill ?? 'none'})` : ''}${range.agentFilesChanged ? ' [agent files changed]' : ''}`);
  }
  for (const label of driftLabels) lines.push(`  ${label}`);
  if (result.sfGuard === 'off') lines.push('  SF Guard is off here, so nothing is recorded: work reads unattributed or pre-guard.');
  return lines.join('\n');
}

/** Run one guard action. `dependencies` replaces the signer, readers and writer (tests only pass them in-process). */
/**
 * `guard remote-check [--recipe] [--package-url <URL> --package-sha256 <HEX>]`: where the remote check
 * stands, and the CI recipe that runs it. `--recipe` prints only the workflow, to save as
 * .github/workflows/sf-guard-verify.yml and commit in a reviewed change. Nothing is written.
 */
async function remoteCheckAction(root, state, options, deps) {
  const [{ sfGuardVerifyWorkflowText, sfGuardRecipeIncomplete, SF_GUARD_CHECK_PATH }] = await Promise.all([import('../presence/remote-recipe.mjs')]);
  const remote = await remoteStanding(root, state, deps);
  const sha = optionString(options, 'package-sha256');
  if (sha != null && !/^[0-9a-f]{64}$/u.test(sha)) fail('--package-sha256 takes the release tarball\'s SHA-256 as 64 hex digits.', 'PSS_ARGUMENT_INVALID');
  const stateBranch = (await import('../ledger-config.mjs')).normalizeLedgerConfig(state.definition?.ledger ?? {}).branch;
  const recipe = sfGuardVerifyWorkflowText({ checkName: remote.check ?? remote.suggested, branch: remote.branch, stateBranch,
    packageUrl: optionString(options, 'package-url') ?? null, packageSha256: sha ?? null });
  if (optionBoolean(options, 'recipe')) { process.stdout.write(recipe); return { recipe }; }
  const incomplete = sfGuardRecipeIncomplete(recipe);
  return print(options, { action: 'remote-check', remote, path: SF_GUARD_CHECK_PATH, recipe, incomplete }, [
    remoteStandingText(remote),
    `CI recipe: save it as ${SF_GUARD_CHECK_PATH} and commit it in a reviewed change (singularity-flow guard remote-check --recipe > ${SF_GUARD_CHECK_PATH}).`,
    ...(incomplete ? ['  Pin the SFlow release it installs first: --package-url <release tarball URL> --package-sha256 <its SHA-256>, or edit the two marked lines.'] : []),
    `  Then make "${remote.check ?? remote.suggested}" a required status check of ${remote.branch} in the repository's branch protection; SF Guard reads it, and never changes it.`
  ].join('\n'));
}

export async function run(argv, { positionals, options }, dependencies = {}) {
  const deps = { ...defaultDependencies(), ...dependencies };
  const action = positionals[1] ?? 'status';
  if (!GUARD_ACTIONS.includes(action)) fail(`Unknown guard action '${action}'. ${USAGE}`, 'PSS_ACTION_UNKNOWN');
  const root = repoRoot();
  const state = await readState(root, { verify: deps.verify });
  const stamps = await agentStamps(root, state.definition).catch(() => []);
  await noteLocalState(root, state.policy.folded.enabled, stamps);
  if (GUARD_READ_ACTIONS.includes(action)) {
    if (positionals.length > 2) fail(`guard ${action} takes no further arguments. ${USAGE}`, 'PSS_ARGUMENT_UNEXPECTED');
    if (action === 'reconcile') {
      const [drift, { agentDriftLabels }] = await Promise.all([import('../presence/agent-drift.mjs'), import('../presence/attribution.mjs')]);
      const reconciled = await reconcileResult(root, state);
      const result = reconciled.sfGuard === 'on' ? { ...reconciled, agentDrift: drift.agentDriftEntries(await drift.readAgentDrift(root)) } : reconciled;
      return print(options, result, reconcileText(result, agentDriftLabels(result.agentDrift)));
    }
    if (action === 'report') {
      const { sfGuardReport, sfGuardReportText } = await import('../presence/attribution.mjs');
      const result = await sfGuardReport(root, { definition: state.definition, policy: state.policy,
        since: optionString(options, 'since') ?? null, storyId: optionString(options, 'story') ?? null });
      return print(options, result, sfGuardReportText(result));
    }
    if (action === 'remote-check') return remoteCheckAction(root, state, options, deps);
    // Branch protection is read only where it matters: SF Guard on, with a remote check named.
    const remote = state.policy.folded.enabled ? await remoteStanding(root, state, deps).catch(() => null) : null;
    const configuration = state.policy.folded.enabled
      ? await (await import('../presence/configuration-seal.mjs')).localConfigurationStanding(root, state.policy, state.definition).catch(() => null) : null;
    const recording = await recordingHealth(root).catch(() => null);
    const outside = await outsideStoriesSummary(root, state, recording).catch(() => null);
    // Key expiry is read from this Mac's own listing, only when a key is pinned (no prompt: an inspection).
    const pinned = state.policy.folded.pins.size + (state.policy.folded.authorPins?.size ?? 0) > 0;
    const listing = pinned ? await Promise.resolve().then(() => deps.listIdentities()).catch(() => null) : null;
    const result = statusResult(state, stamps, remote, recording, configuration, outside, listing);
    return print(options, result, statusText(result));
  }
  const { folded } = state.policy;
  const asAuthor = optionBoolean(options, 'author');
  if (asAuthor && !['register', 'rotate', 'recover'].includes(action)) fail(`guard ${action} is an approver's step; --author registers, rotates or recovers an author's own key only.`, 'PSS_ARGUMENT_INVALID');
  const me = asAuthor ? currentAuthor(root, state.approvers, options, { identify: deps.identify }) : currentApprover(root, state.approvers, { identify: deps.identify });
  const chain = baseChain(state.policy);
  const sign = (event, signers) => signEvent(chain, event, signers, deps);
  let summary;
  let next;
  if (action === 'stamp-agents') {
    // A configuration change a person makes: the stamping hook in each agent file this repository
    // owns [SPEC-SFG-v1 D4]. It signs nothing; an agent never runs it (a person's own step).
    if (positionals.length > 2) fail(`guard stamp-agents takes no positional arguments. ${USAGE}`, 'PSS_ARGUMENT_UNEXPECTED');
    const ids = stamps.filter((row) => !row.stamped || row.changed).map((row) => row.id);
    if (!ids.length) return print(options, { action, stamped: [], reviewRequired: false }, 'Every agent file this repository owns already carries SF Guard\'s stamping hook.');
    const result = await writeChain(root, null, options, `stamp ${ids.join(', ')}`, deps, ids);
    if (!result?.reviewRequired) await noteLocalState(root, state.policy.folded.enabled, await writtenStamps(root, stamps));
    return print(options, { action, stamped: ids, written: result.written ?? null, branch: result.branch ?? null, reviewRequired: Boolean(result.reviewRequired) },
      [`SF Guard's stamping hook written for ${ids.join(', ')}.`, ...writtenLines(result, { chain: false, stamps: ids.length })].join('\n'));
  }
  if (action === 'register' || action === 'recover' || action === 'rotate') {
    if (positionals.length > 2) fail(`guard ${action} takes no positional arguments. ${USAGE}`, 'PSS_ARGUMENT_UNEXPECTED');
    const pins = me.role === 'author' ? folded.authorPins : folded.pins;
    const current = pins.get(me.approver) ?? null;
    const flag = me.role === 'author' ? ' --author' : '';
    if (action === 'register' && current) fail(`SF Guard: ${me.label} already has ${current.keyId} pinned. To change it: singularity-flow guard rotate${flag} --key <NEW-KEY-ID>, or guard recover${flag} --key <NEW-KEY-ID> if the old key is lost.`, 'PSS_KEY_ALREADY_PINNED');
    if (action !== 'register' && !current) fail(`SF Guard: ${me.label} has no presence key pinned, so it cannot ${action}. Register one first: singularity-flow guard register${flag}`, 'PSS_KEY_NOT_REGISTERED', { approver: me.approver });
    if (action !== 'register' && !optionString(options, 'key')) fail(`Name the new key: singularity-flow guard ${action} --key <NEW-KEY-ID> (its SHA256: fingerprint in /usr/sbin/sc_auth list-ctk-identities -t ssh)`, 'PSS_ARGUMENT_REQUIRED');
    const key = await presenceKey(deps, { keyId: optionString(options, 'key') ?? null, purpose: `${action} a presence key` });
    if (current && key.keyId === current.keyId) fail(`${key.keyId} is already ${me.label}'s pinned key.`, 'PSS_KEY_ALREADY_PINNED');
    const snapshot = await githubListing(me, key.keyId, deps);
    const github = { listed: true, snapshotSha256: snapshot.snapshotSha256, fetchedAt: snapshot.fetchedAt };
    if (action === 'recover') {
      if (githubListsKey(snapshot, current.keyId)) {
        fail(`GitHub still lists the lost key ${current.keyId}. Remove it from your GitHub account first (${GITHUB_KEYS_PAGE}), so nobody holding it can sign; then run this again. If you still have it, use guard rotate instead.`, 'PSS_KEY_STILL_LISTED', { keyId: current.keyId });
      }
      github.delisted = [current.keyId];
    }
    // An author is in no member entry, so their key event names the GitHub login it is confirmed under (§10.5).
    const event = nextPresenceEvent(chain, { kind: action, ...(me.role === 'author' ? { role: 'author', githubLogin: me.githubLogin } : {}), approver: me.approver, key: key.publicKey, keyId: key.keyId,
      ...(current ? { previousKeyId: current.keyId } : {}), github });
    const signers = [];
    if (action === 'rotate') signers.push(pinSigner(me, current, `rotate ${me.label}'s presence key (old key)`, [`Old key: ${current.keyId}`, `New key: ${key.keyId}`]));
    signers.push({ approver: me.approver, keyId: key.keyId, publicKey: key.publicKey, title: `${action} ${me.label}'s presence key`,
      lines: [`${me.role === 'author' ? 'Author (signs only their own authorship claims)' : 'Approver'}: ${me.label} [${me.approver}]`, `Key: ${key.keyId} (GitHub lists it)`] });
    const updated = await sign(event, signers);
    summary = `${action} ${me.approver} ${key.keyId}`;
    next = { chain: updated };
  } else if (action === 'revoke') {
    const target = positionals[2];
    const reason = optionString(options, 'reason');
    if (!target || positionals.length > 3 || !reason) fail('Name the approver and why: singularity-flow guard revoke <APPROVER-ID> --reason "<why>"', 'PSS_ARGUMENT_REQUIRED');
    const pinned = folded.pins.get(target);
    if (!pinned) fail(`${target} has no presence key pinned.`, 'PSS_KEY_NOT_REGISTERED', { approver: target });
    const pin = requirePin(folded, me, 'revoke a key');
    const event = nextPresenceEvent(chain, { kind: 'revoke', approver: target, keyId: pinned.keyId, reason });
    next = { chain: await sign(event, [pinSigner(me, pin, `revoke ${target}'s presence key`, [`Key: ${pinned.keyId}`, `Reason: ${reason}`])]) };
    summary = `revoke ${target}`;
  } else if (action === 'enable') {
    if (positionals.length > 2) fail(`guard enable takes no positional arguments. ${USAGE}`, 'PSS_ARGUMENT_UNEXPECTED');
    if (folded.enabled) fail('SF Guard is already on in this repository.', 'PSS_POLICY_UNCHANGED');
    const pin = requirePin(folded, me, 'turn SF Guard on');
    const exceptions = optionStrings(options, 'exception').flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
    const entries = exceptions.map((approver, index) => {
      if (!/^approver-[0-9a-f]{12}$/u.test(approver)) fail(`'${approver}' is not an approver ID (singularity-flow guard status lists them).`, 'PSS_ARGUMENT_INVALID');
      return { id: nextExceptionId(folded, index), approver, reason: optionString(options, 'reason') ?? WINDOWS_EXCEPTION_REASON };
    });
    const remoteCheck = optionString(options, 'remote-check') ?? null;
    const event = nextPresenceEvent(chain, { kind: 'enable', remoteCheck, exceptions: entries });
    next = { chain: await sign(event, [pinSigner(me, pin, 'turn SF Guard on: person steps become presence-signed in this repository',
      [`Remote check: ${remoteCheck ?? '(none named yet)'}`, ...entries.map((entry) => `Exception ${entry.id}: ${entry.approver} — ${entry.reason} (labelled as a bypass)`),
        ...(stamps.length ? [`Stamps the agent files this repository owns, so their work is attributed: ${stamps.map((row) => row.id).join(', ')}`] : [])])]),
    // The agents' stamping hooks land in the same reviewed change as the signed opt-in [SPEC-SFG-v1 D4].
    stamps: stamps.map((row) => row.id) };
    summary = 'enable';
  } else if (action === 'disable') {
    const reason = optionString(options, 'reason');
    if (positionals.length > 2 || !reason) fail('Say why: singularity-flow guard disable --reason "<why>"', 'PSS_ARGUMENT_REQUIRED');
    if (!folded.enabled) fail('SF Guard is already off in this repository.', 'PSS_POLICY_UNCHANGED');
    const pin = requirePin(folded, me, 'turn SF Guard off');
    const event = nextPresenceEvent(chain, { kind: 'disable', reason });
    next = { chain: await sign(event, [pinSigner(me, pin, 'turn SF Guard off: person steps stop being presence-signed', [`Reason: ${reason}`])]) };
    summary = 'disable';
  } else {
    const verb = positionals[2];
    if (!['add', 'revoke'].includes(verb) || positionals.length !== 4) fail('Usage: singularity-flow guard exception add <APPROVER-ID> [--reason "<why>"] [--host-review] | guard exception revoke <EXC-ID> --reason "<why>"', 'PSS_ARGUMENT_REQUIRED');
    if (verb === 'add' && optionBoolean(options, 'host-review')) {
      // The lone-approver fallback (REQ-042): no other approver can sign, so the repository owner's
      // reviewed change records it, and the remote check confirms the review on the host.
      const approver = positionals[3];
      const reason = optionString(options, 'reason');
      if (!/^approver-[0-9a-f]{12}$/u.test(approver)) fail(`'${approver}' is not an approver ID (singularity-flow guard status lists them).`, 'PSS_ARGUMENT_INVALID');
      if (!reason) fail('Say why no approver can sign it: singularity-flow guard exception add <APPROVER-ID> --host-review --reason "<why>"', 'PSS_ARGUMENT_REQUIRED');
      if (activeException(folded, approver)) fail(`${approver} already has an active exception.`, 'PSS_POLICY_UNCHANGED');
      const entry = { id: nextExceptionId(folded), approver, reason };
      next = { chain: { ...chain, events: [...chain.events, nextPresenceEvent(chain, { kind: 'exception', exception: entry, authorization: { kind: 'host-review', reason } })] },
        note: `It counts once a member other than its author approves this change on GitHub; the remote check confirms that review before the merge. Commit it on a branch and open a pull request.` };
      summary = `host-reviewed exception ${entry.id} for ${approver}`;
    }
  }
  if (action === 'exception' && !next) {
    const verb = positionals[2];
    const pin = requirePin(folded, me, 'record an exception');
    if (verb === 'add') {
      const approver = positionals[3];
      if (!/^approver-[0-9a-f]{12}$/u.test(approver)) fail(`'${approver}' is not an approver ID (singularity-flow guard status lists them).`, 'PSS_ARGUMENT_INVALID');
      if (activeException(folded, approver)) fail(`${approver} already has an active exception.`, 'PSS_POLICY_UNCHANGED');
      const entry = { id: nextExceptionId(folded), approver, reason: optionString(options, 'reason') ?? WINDOWS_EXCEPTION_REASON };
      const event = nextPresenceEvent(chain, { kind: 'exception', exception: entry });
      next = { chain: await sign(event, [pinSigner(me, pin, `record per-person exception ${entry.id}: ${approver}'s person steps proceed unsigned, labelled as a bypass`, [`Reason: ${entry.reason}`])]) };
      summary = `exception ${entry.id} for ${approver}`;
    } else {
      const id = positionals[3];
      const reason = optionString(options, 'reason');
      if (!reason) fail('Say why: singularity-flow guard exception revoke <EXC-ID> --reason "<why>"', 'PSS_ARGUMENT_REQUIRED');
      if (!folded.exceptions.get(id)?.active) fail(`${id} is not an active exception.`, 'PSS_POLICY_UNCHANGED');
      const event = nextPresenceEvent(chain, { kind: 'exception-revoke', exceptionId: id, reason });
      next = { chain: await sign(event, [pinSigner(me, pin, `revoke per-person exception ${id}`, [`Reason: ${reason}`])]) };
      summary = `exception-revoke ${id}`;
    }
  }
  // The new chain must fold whole before anything is written.
  const checked = foldPresenceChain(next.chain, deps.verify ? { verify: deps.verify } : {});
  if (checked.problems.length) fail(`SF Guard did not record it: ${checked.problems[0].message}.`, checked.problems[0].code);
  const result = await writeChain(root, next.chain, options, summary, deps, next.stamps ?? []);
  if (!result?.reviewRequired) await noteLocalState(root, checked.enabled, next.stamps?.length ? await writtenStamps(root, stamps) : null);
  const event = next.chain.events.at(-1);
  // Opting in reads the default branch's protection and says while the remote check is not required.
  const remote = action === 'enable' ? await remoteStanding(root, { ...state, policy: { ...state.policy, folded: checked } }, deps).catch(() => null) : null;
  return print(options, { action, event: { seq: event.seq, kind: event.kind }, chainId: next.chain.chainId, written: result.written ?? null,
    branch: result.branch ?? null, reviewRequired: Boolean(result.reviewRequired), ...(remote ? { remote } : {}) },
  [`SF Guard recorded ${summary} (event ${event.seq}).`, ...writtenLines(result, { stamps: next.stamps?.length ?? 0 }),
    ...(remote ? [remoteStandingText(remote)] : []), ...(next.note ? [next.note] : [])].join('\n'));
}
