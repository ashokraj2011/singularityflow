/**
 * SF Guard's card on SFlow's own cards (owner, 2026-11-19, reversing M5's "the sign card never signs"): the VS Code
 * Decide card and approval page show the card a signature covers, and the command they start signs with Touch ID from
 * the extension host's process, with no terminal.
 *
 * The host reads the card from the engine (`guard card`), shows it, and starts the record with
 * `--presence-card <surface> --card-sha256 <digest>`. The command rebuilds the same card from the same Story, answers
 * and key, and refuses with nothing written when its digest differs (PSS_CARD_CHANGED). Only a card matched that way
 * lets a signer run without a terminal, and only for the command that matched it (`withCardSurface`).
 *
 * The flags are a courtesy, never the boundary. An agent's shell still carries Copilot's marker and is refused
 * (person-records.mjs `personCardShown`), the Copilot hook refuses the flags in every turn, and a process that hides
 * both still needs the person's touch, as `ssh-keygen -Y sign` run by hand always did. The touch, the pinned key and
 * the remote check are unchanged, and so is every verifier: a record counts only when its signature verifies.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';

export const CARD_SCHEMA = 'sf-guard-card@1';
/** The hosts' cards that may show SF Guard's card: VS Code's Decide card and approval page, and the self-test. */
export const CARD_SURFACES = Object.freeze(['vscode-card', 'vscode-approval', 'self-test']);
/** What a person reads under every SF Guard card, in their terminal or on SFlow's own card. */
export const PRESENCE_RULE = 'Touch the sensor only for a command you started yourself, right after its card. A prompt you did not start is an agent asking: decline it.';
/** The one line that offers SF Guard where a person records a decision without it (offered, never forced). */
export const SF_GUARD_OFFER = 'SF Guard is off here, so this is recorded without your Touch ID. To turn it on for this repository, run in your own terminal: singularity-flow guard setup';

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const sha256 = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };
const surfaces = new AsyncLocalStorage();

/**
 * The card a host shows, with its digest: the title, the lines and the key the person reads, the rule, and `bound`, the
 * facts the lines stand for (the decision list's or the review packet's digest), which a person never has to read.
 */
export function guardCard({ title, lines, keyId, bound = {} }) {
  const card = { schema: CARD_SCHEMA, title, lines: [...lines], keyId, rule: PRESENCE_RULE, bound };
  return { ...card, cardSha256: sha256(canonicalJson(card)) };
}

/** The card for decisions recorded from an answers file: the summary `decisions record` confirms. */
export function decisionsCardFields({ workId, summary, packetSha256 }) {
  return { title: `record ${summary.length === 1 ? 'a decision' : `${summary.length} decisions`} on ${workId}`, lines: [...summary],
    bound: { decisionList: packetSha256 ?? null } };
}

/** The card for an approval (or a return): what its record will say, as its terminal card says it, without the record's digest. */
export function approvalCardFields({ verb = 'approve', workId, phaseId, phaseLabel, generation, decision = 'approved', target = null, reviewPacketSha256 = null, cardLines = [] }) {
  return {
    title: `${verb} ${workId} / ${phaseId}`,
    lines: [`Step: ${phaseLabel}, generation ${generation}`, `Decision: ${decision}${target ? ` (back to ${target})` : ''}`, ...cardLines],
    bound: { reviewPacket: reviewPacketSha256 ?? null }
  };
}

/** The approval card for `phase`'s current generation, from the packet it was submitted with, or null when there is none. */
export async function approvalCardFieldsFor(root, { config, workflow, phase }) {
  const entry = [...(workflow?.lineage?.submissions ?? [])].reverse()
    .find((submission) => submission.phase === phase.id && Number(submission.generation) === Number(phase.generation));
  if (!entry) return null;
  const packet = await (await import('../story-lineage.mjs')).readStoryReviewPacket(root, config, workflow, entry.packetSha256);
  const cardLines = packet?.attribution ? (await import('./attribution.mjs')).attributionCardLines(packet.attribution) : [];
  return approvalCardFields({ workId: workflow.workItem.id, phaseId: phase.id, phaseLabel: phase.label ?? phase.id,
    generation: phase.generation, reviewPacketSha256: packet?.packetSha256 ?? entry.packetSha256, cardLines });
}

async function holdsKey(keyId) {
  const { ctkIdentities, presenceIdentityStanding } = await import('./local-keys.mjs');
  return presenceIdentityStanding(ctkIdentities(), keyId).ok;
}

/**
 * SF Guard's card for `fields` on `workflow` and `actor`, as a host shows it before the person records:
 * `{ required, signs, keyId, card, cardSha256 }` when this Mac signs it; `{ required, signs: false, bypass | code,
 * reason }` when SF Guard requires it but it is not signed here (a per-person exception records it labelled, any
 * other reason names the route the record would refuse with); `{ required: false, state, offer }` when the Story
 * does not require it, with the offer only where the repository never opted in and this Mac could sign.
 */
export async function guardCardFor(root, workflow, { actor, fields, dependencies = null }) {
  const deps = dependencies ?? (await import('./person-steps.mjs')).personStepPresenceDependencies();
  const [{ actorApproverId, loadPresenceContext }, { activeException }] = await Promise.all([import('./person-records.mjs'), import('./chain.mjs')]);
  const availability = () => (deps.signerAvailability ? deps.signerAvailability() : import('./signer.mjs').then((signer) => signer.signerAvailability()));
  const context = await loadPresenceContext(root, workflow, { verify: deps.verify });
  if (!context.required) {
    const off = !context.optedIn;
    return { required: false, signs: false, state: off ? 'off' : 'pre-signing', offer: off && (await availability()).available ? SF_GUARD_OFFER : null };
  }
  const refused = (code, reason, extra = {}) => ({ required: true, signs: false, code, reason, ...extra });
  const approver = actorApproverId(workflow.resolution?.approvalAuthorities, actor);
  if (!approver) return refused('PSS_NOT_AN_APPROVER', 'your identity is not an approver in this Story\'s pinned configuration');
  if (!context.chain) return refused('PSS_POLICY_UNREADABLE', `SF Guard's policy cannot be read here${context.unreadable ? `: ${context.unreadable}` : ''}`);
  const exception = activeException(context.folded, approver);
  if (exception) return { required: true, signs: false, bypass: exception.id, reason: `recorded unsigned, labelled "bypass: per-person exception ${exception.id}"` };
  const pin = context.folded.pins.get(approver);
  if (!pin) return refused('PSS_KEY_NOT_REGISTERED', 'you have no presence key pinned (singularity-flow guard register, in your own terminal)');
  const standing = await availability();
  if (!standing.available) return refused('PSS_SIGNER_UNAVAILABLE', standing.reason, { keyId: pin.keyId });
  if (!await (deps.holdsKey ?? holdsKey)(pin.keyId)) return refused('PSS_SIGNER_UNAVAILABLE', `this Mac does not hold your pinned presence key ${pin.keyId}`, { keyId: pin.keyId });
  // What the card says is read only now, where it signs: a decision list or a review packet costs a read.
  const said = typeof fields === 'function' ? await fields() : fields;
  if (!said) return refused('STORY_REVIEW_EVIDENCE_REQUIRED', 'this step has no submitted review for its generation, so there is nothing to sign', { keyId: pin.keyId });
  const card = guardCard({ ...said, keyId: pin.keyId });
  return { required: true, signs: true, keyId: pin.keyId, approver, card, cardSha256: card.cardSha256 };
}

/**
 * Run `action` (one command) with the host's card its flags name, so only that command may sign without a terminal,
 * and only once its card matched. Without the flags it runs as before.
 */
export async function withCardSurface(options, action) {
  if (options?.['presence-card'] === undefined && options?.['card-sha256'] === undefined) return action();
  const name = options['presence-card'];
  const digest = options['card-sha256'];
  if (typeof name !== 'string' || !CARD_SURFACES.includes(name)) {
    fail(`--presence-card names the SFlow card that showed SF Guard's card: ${CARD_SURFACES.join(', ')}. Nothing was written.`, 'PSS_ARGUMENT_INVALID');
  }
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    fail('--card-sha256 takes the digest SFlow gave with the card it showed (singularity-flow guard card). Nothing was written.', 'PSS_ARGUMENT_INVALID');
  }
  return surfaces.run({ surface: name, cardSha256: digest, matched: false }, action);
}

/** The host's card this command runs with, or null: `{ surface, cardSha256, matched }`. */
export const cardSurface = () => surfaces.getStore() ?? null;

/**
 * Match the card this command would sign against the one the host showed. Refuses PSS_CARD_CHANGED, before anything
 * is written, when they differ. Returns false when no host card applies.
 */
export function matchCard(card) {
  const surface = cardSurface();
  if (!surface) return false;
  if (!card || card.cardSha256 !== surface.cardSha256) {
    fail('SF Guard: the card you read is not the one this would sign now (the decisions, the step or your key changed since it was shown). Nothing was written. Open the card again, read it, then record.',
      'PSS_CARD_CHANGED', { surface: surface.surface });
  }
  surface.matched = true;
  return true;
}

/** Match the host's card for an answers file's decisions (`decisions record --answers`), before anything is written. */
export async function matchDecisionsCard(root, workflow, { actor, summary, packetSha256 }) {
  return matchRead(await guardCardFor(root, workflow, { actor, fields: decisionsCardFields({ workId: workflow.workItem.id, summary, packetSha256 }) }));
}

/** Match the host's card for an approval of `phase`, before anything is shown or written. */
export async function matchApprovalCard(root, { config, workflow, phase, actor }) {
  return matchRead(await guardCardFor(root, workflow, { actor, fields: () => approvalCardFieldsFor(root, { config, workflow, phase }) }));
}

function matchRead(read) {
  if (!cardSurface()) return false;
  if (!read.signs) {
    fail(`SF Guard does not sign this here now: ${read.reason ?? 'SF Guard does not apply to this Story'}. Nothing was written. Open the card again.`,
      read.code ?? 'PSS_CARD_CHANGED', { surface: cardSurface().surface });
  }
  return matchCard(read.card);
}

/**
 * The card line a signer writes for a host instead of a terminal: one JSON line on stderr, with the card text the
 * signature follows, so the host's log shows what preceded the touch.
 */
export function surfaceCardLine(text, surface = cardSurface()) {
  return `${JSON.stringify({ sfGuardCard: { surface: surface?.surface ?? null, cardSha256: surface?.cardSha256 ?? null, text } })}\n`;
}
