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
 * In M1 nothing else reads the policy: opting in records it, and person steps start requiring
 * signatures in M2. A repository that never opts in has no file and behaves exactly as before.
 *
 * The signer, GitHub, the key readers and the configuration writer are parameters (`dependencies`),
 * so tests run every route with software keys and no environment switch.
 */
import { identity, repoRoot } from '../git.mjs';
import { GITHUB_KEYS_PAGE, GITHUB_SIGNING_KEY_PAGE, githubListsKey, githubSigningKeys } from '../presence/anchor.mjs';
import {
  activeException, approverId, approverStanding, emptyPresenceChain, foldPresenceChain, nextExceptionId,
  nextPresenceEvent, PRESENCE_CHAIN_PATH, presenceEventStatement, WINDOWS_EXCEPTION_REASON
} from '../presence/chain.mjs';
import { ctkIdentities, presenceIdentityStanding, readableCopies } from '../presence/local-keys.mjs';
import { presenceNonce } from '../presence/statement.mjs';
import { optionBoolean, optionString, optionStrings, SingularityFlowError } from '../util.mjs';

export const GUARD_ACTIONS = Object.freeze(['status', 'register', 'rotate', 'recover', 'revoke', 'enable', 'disable', 'exception']);
export const GUARD_READ_ACTIONS = Object.freeze(['status']);
/** The person's own steps: refused for agents, whatever the turn. */
export const GUARD_PERSON_ACTIONS = Object.freeze(GUARD_ACTIONS.filter((action) => !GUARD_READ_ACTIONS.includes(action)));
const USAGE = 'Usage: singularity-flow guard <status|register|rotate|recover|revoke|enable|disable|exception add|exception revoke> …  (singularity-flow help guard)';
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

function print(options, json, text) {
  if (optionBoolean(options, 'json')) console.log(JSON.stringify({ schemaVersion: 1, resultType: 'sflow-guard', ...json }, null, 2)); // schema-transient: command result
  else console.log(text);
}

/** Every approver the approved configuration names, once each, with their approver id. */
function approversOf(definition) {
  const byId = new Map();
  for (const [group, authority] of Object.entries(definition?.approvalAuthorities ?? {})) {
    for (const member of authority.members ?? []) {
      const id = approverId(member);
      if (!id) continue;
      const known = byId.get(id) ?? { approver: id, label: member.name || member.githubLogin || member.email, githubLogin: member.githubLogin ?? null, email: member.email ?? null, groups: [] };
      known.groups.push(group);
      byId.set(id, known);
    }
  }
  return byId;
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

async function readState(root, { verify } = {}) {
  const [{ withApprovedConfigurationRead }, { loadDefinition }, { readPresencePolicy }] = await Promise.all([
    import('../approved-configuration-reader.mjs'), import('../config.mjs'), import('../presence/store.mjs')]);
  return withApprovedConfigurationRead(root, async () => {
    const definition = await loadDefinition(root);
    const policy = await readPresencePolicy(root, { verify });
    return { definition, policy, approvers: approversOf(definition) };
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

async function writeChain(root, chain, options, summary, deps) {
  const { STUDIO_CHANGE_SET_SCHEMA } = await import('../workflow-studio.mjs');
  const result = await deps.write(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'presence.set', chain }] }, options,
    { subject: 'sf-guard', message: `[configuration] SF Guard: ${summary}` });
  if (result?.valid === false) fail(`SF Guard did not record it: ${result.problems?.[0]?.message ?? 'the configuration change was refused'}.`, result.problems?.[0]?.code ?? 'PSS_CHAIN_INVALID');
  return result;
}

function writtenLines(result) {
  if (result?.reviewRequired) return [`Proposed for review as ${result.branch}. It takes effect once approved: singularity-flow configuration approve ${result.branch}`];
  return [`Written to ${PRESENCE_CHAIN_PATH}. Review the diff and commit it with the rest of the configuration.`];
}

function standingRows(state) {
  const { folded } = state.policy;
  const rows = [...state.approvers.values()].map((entry) => ({ ...entry, standing: approverStanding(folded, entry.approver) }));
  // Pinned or excepted approvers the configuration no longer lists are still shown.
  for (const approver of new Set([...folded.pins.keys(), ...[...folded.exceptions.values()].filter((entry) => entry.active).map((entry) => entry.approver)])) {
    if (!state.approvers.has(approver)) rows.push({ approver, label: '(not in the approved configuration)', groups: [], standing: approverStanding(folded, approver) });
  }
  return rows;
}

function statusResult(state) {
  const { folded, problems, historyChecked } = state.policy;
  return {
    status: folded.enabled ? 'required' : 'off',
    chainId: folded.chainId, events: folded.length, validEvents: folded.validLength, historyChecked, remoteCheck: folded.remoteCheck,
    approvers: standingRows(state).map(({ approver, label, groups, standing }) => ({
      approver, label, groups, state: standing.state, standing: standing.label, keyId: standing.pin?.keyId ?? null,
      recovered: Boolean(standing.pin?.recovered), exception: standing.exception?.id ?? null
    })),
    exceptions: [...folded.exceptions.values()],
    retired: folded.retired,
    problems
  };
}

function statusText(result) {
  const lines = [`SF Guard: ${result.status === 'required' ? 'on — person steps are presence-signed (enforced from M2)' : 'off — person steps unsigned in this repository'}`];
  if (result.chainId) lines.push(`  Policy chain ${result.chainId}: ${result.validEvents} of ${result.events} event(s) verify${result.historyChecked ? '' : ' (history not checked: not available in this clone)'}.`);
  if (result.remoteCheck) lines.push(`  Remote check: ${result.remoteCheck}`);
  for (const row of result.approvers) lines.push(`  ${row.label} [${row.approver}]: ${row.standing}${row.recovered ? ' (recovered)' : ''}`);
  for (const problem of result.problems) lines.push(`  Problem (${problem.code}): ${problem.message}`);
  if (result.status === 'off' && !result.chainId) lines.push('  Opt in: singularity-flow guard register, then singularity-flow guard enable (both in your own terminal, with Touch ID).');
  return lines.join('\n');
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
  verify: undefined
});

/** Run one guard action. `dependencies` replaces the signer, readers and writer (tests only pass them in-process). */
export async function run(argv, { positionals, options }, dependencies = {}) {
  const deps = { ...defaultDependencies(), ...dependencies };
  const action = positionals[1] ?? 'status';
  if (!GUARD_ACTIONS.includes(action)) fail(`Unknown guard action '${action}'. ${USAGE}`, 'PSS_ACTION_UNKNOWN');
  const root = repoRoot();
  const state = await readState(root, { verify: deps.verify });
  if (action === 'status') {
    if (positionals.length > 2) fail(`guard status takes no further arguments. ${USAGE}`, 'PSS_ARGUMENT_UNEXPECTED');
    const result = statusResult(state);
    return print(options, result, statusText(result));
  }
  const { folded } = state.policy;
  const me = currentApprover(root, state.approvers, { identify: deps.identify });
  const chain = baseChain(state.policy);
  const sign = (event, signers) => signEvent(chain, event, signers, deps);
  let summary;
  let next;
  if (action === 'register' || action === 'recover' || action === 'rotate') {
    if (positionals.length > 2) fail(`guard ${action} takes no positional arguments. ${USAGE}`, 'PSS_ARGUMENT_UNEXPECTED');
    const current = folded.pins.get(me.approver) ?? null;
    if (action === 'register' && current) fail(`SF Guard: ${me.label} already has ${current.keyId} pinned. To change it: singularity-flow guard rotate --key <NEW-KEY-ID>, or guard recover --key <NEW-KEY-ID> if the old key is lost.`, 'PSS_KEY_ALREADY_PINNED');
    if (action !== 'register') requirePin(folded, me, action);
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
    const event = nextPresenceEvent(chain, { kind: action, approver: me.approver, key: key.publicKey, keyId: key.keyId,
      ...(current ? { previousKeyId: current.keyId } : {}), github });
    const signers = [];
    if (action === 'rotate') signers.push(pinSigner(me, current, `rotate ${me.label}'s presence key (old key)`, [`Old key: ${current.keyId}`, `New key: ${key.keyId}`]));
    signers.push({ approver: me.approver, keyId: key.keyId, publicKey: key.publicKey, title: `${action} ${me.label}'s presence key`,
      lines: [`Approver: ${me.label} [${me.approver}]`, `Key: ${key.keyId} (GitHub lists it)`] });
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
      [`Remote check: ${remoteCheck ?? '(none named yet)'}`, ...entries.map((entry) => `Exception ${entry.id}: ${entry.approver} — ${entry.reason} (labelled as a bypass)`)])]) };
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
    if (!['add', 'revoke'].includes(verb) || positionals.length !== 4) fail('Usage: singularity-flow guard exception add <APPROVER-ID> [--reason "<why>"] | guard exception revoke <EXC-ID> --reason "<why>"', 'PSS_ARGUMENT_REQUIRED');
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
  const result = await writeChain(root, next.chain, options, summary, deps);
  const event = next.chain.events.at(-1);
  return print(options, { action, event: { seq: event.seq, kind: event.kind }, chainId: next.chain.chainId, written: result.written ?? null,
    branch: result.branch ?? null, reviewRequired: Boolean(result.reviewRequired) },
  [`SF Guard recorded ${summary} (event ${event.seq}).`, ...writtenLines(result)].join('\n'));
}
