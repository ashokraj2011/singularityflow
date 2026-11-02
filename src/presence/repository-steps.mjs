/**
 * SF Guard (SPEC-PSS-v1 §10.6): a person's steps that belong to the repository, not to a Story.
 *
 * Spec Studio's person steps, a split's publication, a configuration approval, the Epic, goal, SGOS,
 * intent, lease, host-policy and agents-lock decisions have no Story to pin SF Guard's policy, so they
 * follow the repository's current signed policy: while the approved configuration's
 * `singularity/presence.json` says SF Guard is on, each needs its approver's presence signature (their
 * card in their own terminal, then one Touch ID touch) before it writes anything; while it is off or
 * absent, behaviour is exactly as before. M2's checks run in M2's order, every refusal names a route
 * the person can take today, and nothing is written. A per-person exception lets the step proceed
 * unsigned, labelled as a bypass.
 *
 * The signature covers a digest of the record the step writes (when the step has one), so the
 * `presence` block it returns can travel with that record.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { activeException } from './chain.mjs';
import { actorApproverId, personTerminal, PRESENCE_RECORD_SCHEMA } from './person-records.mjs';
import { personStepPresenceDependencies } from './person-steps.mjs';
import { presenceNonce, presenceStatement } from './statement.mjs';

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

function quoted(value) {
  return /^[\w@%+=:,./-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** The command line the person runs again in their own terminal. */
function thisCommand(argv = process.argv) {
  return ['singularity-flow', ...argv.slice(2).map((value) => quoted(String(value)))].join(' ');
}

async function holdsKey(keyId) {
  const { ctkIdentities, presenceIdentityStanding } = await import('./local-keys.mjs');
  return presenceIdentityStanding(ctkIdentities(), keyId).ok;
}

/** The repository's current SF Guard policy and approval authorities, from the approved configuration. */
async function repositoryPolicy(root, verify) {
  const [{ withApprovedConfigurationRead }, { loadDefinition }, { readPresencePolicy }] = await Promise.all([
    import('../approved-configuration-reader.mjs'), import('../config.mjs'), import('./store.mjs')]);
  return withApprovedConfigurationRead(root, async () => ({
    policy: await readPresencePolicy(root, { verify }),
    authorities: (await loadDefinition(root).catch(() => null))?.approvalAuthorities ?? {}
  }), { preferAuthority: true });
}

/** The statement a repository step's presence signature covers. */
export function repositoryStepStatement(presence) {
  return presenceStatement({
    repository: `presence:${presence.chainId}`, subject: { kind: 'repository', id: presence.chainId }, step: null, generation: null,
    action: presence.action, decision: { recordSha256: presence.recordSha256 }, reviewed: {}, actor: { approver: presence.approver },
    authorityGroup: null, at: presence.at, nonce: presence.nonce, keyId: presence.keyId
  });
}

/** The digest a repository step's signature covers: the record without its own `presence` block. */
export function repositoryRecordSha256(record) {
  if (!record || typeof record !== 'object') return null;
  const { presence: _presence, ...rest } = record;
  return sha256(canonicalJson(rest));
}

/**
 * Before a repository-level person step writes anything: null while SF Guard is off here; else its
 * `presence` block (signed, or labelled as a bypass under a per-person exception), attached to `record`
 * when one is given. `actor` is the person's Git identity (`{ email, login }`); `action` names the step
 * (`spec.publish`, `configuration.approve`, …); `title` and `lines` are its card.
 */
export async function signRepositoryStep(root, { action, title, lines = [], record = null, actor = null }) {
  const dependencies = personStepPresenceDependencies();
  let read;
  try { read = await repositoryPolicy(root, dependencies.verify); }
  catch (error) {
    // A repository that never opted in has no policy file: nothing changes. One whose file cannot be
    // read here may have SF Guard on, so the step waits for a readable policy, with routes.
    const { existsSync } = await import('node:fs');
    const path = await import('node:path');
    if (!existsSync(path.join(root, 'singularity', 'presence.json'))) return null;
    fail(`SF Guard: ${action} may need your presence signature, and this repository's policy (singularity/presence.json) cannot be read here: ${error?.message ?? error}. Nothing was written. Bring the configuration up to date (singularity-flow sync), then run the same command again; or another approver can take this step.`,
      'PSS_POLICY_UNREADABLE', { routes: { command: thisCommand(dependencies.argv) } });
  }
  const { policy, authorities } = read;
  if (!policy?.present || !policy.chain || !policy.folded?.enabled) return null;
  const who = actor ?? (await import('../git.mjs')).identity(root, { offline: true });
  const approver = actorApproverId(authorities, who);
  const command = thisCommand(dependencies.argv);
  const routes = { command, others: 'another approver can take this step in their own terminal' };
  if (!approver) {
    fail(`SF Guard is on in this repository, so ${action} is an approver's signed step, and your identity is not an approver in the approved configuration. Nothing was written; ${routes.others}.`,
      'PSS_NOT_AN_APPROVER', { routes });
  }
  routes.exception = `another approver can record a per-person exception: singularity-flow guard exception add ${approver}`;
  const folded = policy.folded;
  const recordSha256 = repositoryRecordSha256(record);
  const exception = activeException(folded, approver);
  if (exception) {
    const presence = { schema: PRESENCE_RECORD_SCHEMA, chainId: folded.chainId, approver, action, bypass: exception.id, at: new Date().toISOString(), recordSha256 };
    if (record) record.presence = presence;
    return presence;
  }
  const pin = folded.pins.get(approver);
  if (!pin) {
    fail(`SF Guard is on in this repository, so ${action} needs your presence signature, and you have no presence key pinned. Nothing was written. Register one in your own terminal (singularity-flow guard register), or ${routes.others}, or ${routes.exception}.`,
      'PSS_KEY_NOT_REGISTERED', { approver, routes });
  }
  const availability = (dependencies.signerAvailability ?? (await import('./signer.mjs')).signerAvailability)();
  if (!availability.available) {
    fail(`SF Guard cannot sign on this computer: ${availability.reason}. Nothing was written. Run this step on the Mac that holds your presence key (${pin.keyId}), or ${routes.others}, or ${routes.exception}.`,
      'PSS_SIGNER_UNAVAILABLE', { approver, keyId: pin.keyId, routes });
  }
  const terminal = (dependencies.personTerminal ?? personTerminal)();
  if (!terminal.person) {
    fail(`SF Guard: ${action} needs your presence signature, taken in your own terminal (${terminal.reason}). Nothing was written. Run it there: ${command}`,
      'PSS_CARD_NOT_SHOWN', { approver, nextAction: { command, label: `Run in your own terminal: ${command}` }, routes });
  }
  if (!await (dependencies.holdsKey ?? holdsKey)(pin.keyId)) {
    fail(`SF Guard: this Mac does not hold your pinned presence key ${pin.keyId}. Nothing was written. Run this step on the Mac that holds it, rotate to a key on this Mac (singularity-flow guard rotate --key <NEW-KEY-ID>), or ${routes.others}. If you never registered ${pin.keyId}, revoke it: singularity-flow guard revoke ${approver} --reason "not my key".`,
      'PSS_SIGNER_UNAVAILABLE', { approver, keyId: pin.keyId, routes });
  }
  const presence = { schema: PRESENCE_RECORD_SCHEMA, chainId: folded.chainId, approver, keyId: pin.keyId, action,
    at: new Date().toISOString(), nonce: presenceNonce(), recordSha256 };
  const card = dependencies.card ?? (async (fields) => (await import('./signer.mjs')).presenceCard(fields));
  const sign = dependencies.sign ?? (async (request) => (await import('./signer.mjs')).signWithPresence(request));
  const shown = await card({ title, lines: [...lines, ...(recordSha256 ? [`Record: ${recordSha256}`] : [])], keyId: pin.keyId });
  const result = await sign({ statement: repositoryStepStatement(presence), keyId: pin.keyId, publicKey: pin.key, card: shown });
  const signed = { ...presence, signature: result.signature, userVerification: Boolean(result.userVerification) };
  if (record) record.presence = signed;
  return signed;
}

const SIGNED = Symbol.for('singularity-flow.repository-person-step-signed');

/**
 * The CLI's gate for repository-level person steps (repository-step-routes.mjs): signs the step named
 * by `positionals` before its handler runs, once per command, however the command was dispatched.
 */
export async function gateRepositoryPersonStep(root, positionals, options) {
  const { repositoryPersonStep } = await import('./repository-step-routes.mjs');
  const step = repositoryPersonStep(positionals, options);
  if (!step) return null;
  const key = positionals.join('\0');
  if (globalThis[SIGNED] === key) return null;
  const presence = await signRepositoryStep(root, { action: step.action, title: step.label,
    lines: [`Step: ${step.label}`, `Command: singularity-flow ${positionals.join(' ')}`] });
  globalThis[SIGNED] = key;
  return presence;
}

/**
 * A live terminal review (an appeal's decision, a quality risk, an evidence or plan correction, a test
 * attestation or selection, a test-policy amendment, an approver refresh) also takes the person's
 * presence signature over the exact card they confirmed (SPEC-PSS-v1 §10.6): on its Story's pin when the
 * card names one, else while the repository's policy has SF Guard on. Its typed confirmation alone is
 * something a program can fake; the touch is not. Returns the presence block, or null when SF Guard does
 * not apply.
 */
export async function signTerminalReview(root, plan, action) {
  const cardSha256 = sha256(canonicalJson({ plan, action }));
  const label = String(action?.label ?? action?.actionId ?? 'reviewed action');
  const workId = plan?.subject?.workId ?? (plan?.subject?.kind === 'story' ? plan.subject.id ?? null : null);
  if (workId) {
    const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
    const workflow = (await loadAcceptedStoryExecution(root, workId).catch(() => null))?.workflow ?? null;
    if (!workflow?.resolution?.presence) return null;
    const who = (await import('../git.mjs')).identity(root, { offline: true });
    const record = { planId: plan.planId ?? null, planHash: plan.planHash ?? null, actionId: action?.actionId ?? null, cardSha256,
      actor: { email: who?.email ?? null, login: who?.login ?? null }, at: new Date().toISOString() };
    await (await import('./person-steps.mjs')).signPersonRecords(root, workflow, [{ label: `Reviewed: ${label}`, action: `review.${action?.actionId ?? 'action'}`, record }]);
    return record.presence ?? null;
  }
  return signRepositoryStep(root, { action: `review.${action?.actionId ?? 'action'}`, title: label,
    lines: [`Reviewed card: ${cardSha256}`], record: { planId: plan?.planId ?? null, planHash: plan?.planHash ?? null, cardSha256 } });
}
