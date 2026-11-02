/**
 * SF Guard (SPEC-PSS-v1 §10.5): an authorship claim is a person's step.
 *
 * `phase publish --authored human` (or `external-tool`) says a person, or a tool outside the agent,
 * wrote the step, and such a generation skips the checks an agent's draft gets (its clarification
 * record, its agent session, its briefs). So on a Story SF Guard requires, the claim is believed only
 * with its author's presence signature: their card, then one Touch ID touch. Any person with a
 * registered key may sign one, approver or not (`guard register --author`).
 *
 * The user's rule: an unsigned claim is not believed, and nothing is refused for it. Without a valid
 * signature the generation is recorded and checked as the agent's (`governed-agent`), with every agent
 * check, and the output says how to sign next time. A signer who declines the touch stops the command
 * (their own cancel); a claim that cannot become the agent's (an import with --from, or a step only a
 * person may author) is refused with the person's route instead, since there is no agent reading of it.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { SingularityFlowError } from '../util.mjs';
import { activeException } from './chain.mjs';
import {
  AUTHORSHIP_CLAIM_PRODUCERS, authorshipClaimStatement, claimantIds, loadPresenceContext, personTerminal, PRESENCE_RECORD_SCHEMA
} from './person-records.mjs';
import { personStepPresenceDependencies } from './person-steps.mjs';
import { presenceNonce } from './statement.mjs';

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

async function holdsKey(keyId) {
  const { ctkIdentities, presenceIdentityStanding } = await import('./local-keys.mjs');
  return presenceIdentityStanding(ctkIdentities(), keyId).ok;
}

/** The pin `id` holds in the folded chain: an approver's or an author's. */
function pinOf(folded, id) {
  return folded.pins.get(id) ?? folded.authorPins?.get(id) ?? null;
}

/**
 * Before `phase publish` writes a person's or an external tool's claim on a Story SF Guard requires:
 * the options to publish with. Unchanged when SF Guard does not apply or the producer claims nothing;
 * with the author's signed (or excepted) `presence` when they can sign here; else the agent's own
 * authorship, with `notice` saying why and how to sign. `asAgent(phase)` returns the agent's
 * authorship options, or throws when the step does not allow it.
 */
export async function prepareAuthorshipClaim(root, { workflow, phase, options, generation, artifactSha256 = null, actor, sourcePath = null, asAgent }) {
  if (!AUTHORSHIP_CLAIM_PRODUCERS.includes(options.producer)) return { options };
  const dependencies = personStepPresenceDependencies();
  const context = await loadPresenceContext(root, workflow, { verify: dependencies.verify });
  if (!context.required) return { options };
  const ids = claimantIds(workflow.resolution?.approvalAuthorities, actor);
  // The in-place artifact the person read is bound (checked against the published source); an import's
  // file is recorded as it was when signed.
  const claim = {
    workId: workflow.workItem.id, phase: phase.id, generation, producer: options.producer, channel: options.channel,
    artifactSha256: sourcePath ? null : artifactSha256, importSha256: sourcePath ? await fileSha256(sourcePath) : null
  };
  const signHow = `register a presence key (singularity-flow guard register${isApprover(workflow, actor) ? '' : ' --author'}), then publish from your own terminal on that Mac; or ask an approver for a per-person exception (singularity-flow guard exception add ${ids[0] ?? '<APPROVER-ID>'})`;
  const unbelieved = (why) => {
    if (sourcePath) {
      fail(`SF Guard: this Story believes an imported ${options.producer} claim only with its author's presence signature, and ${why}. Nothing was written. To sign it, ${signHow}.`,
        'PSS_CLAIM_UNSIGNED', { routes: { sign: signHow } });
    }
    let agent;
    try { agent = asAgent(phase); }
    catch {
      fail(`SF Guard: this Story believes a ${options.producer} claim only with its author's presence signature, and ${why}; this step does not allow the agent's authorship either. Nothing was written. To sign it, ${signHow}.`,
        'PSS_CLAIM_UNSIGNED', { routes: { sign: signHow } });
    }
    return { options: agent, unbelieved: options.producer,
      notice: `SF Guard: this Story believes a ${options.producer} authorship claim only with its author's presence signature, and ${why}. It is recorded and checked as the agent's (governed-agent), with every agent check. To claim it next time, ${signHow}.` };
  };
  if (!context.chain) return unbelieved(`its policy (singularity/presence.json) cannot be read here${context.unreadable ? `: ${context.unreadable}` : ''}`);
  const excepted = ids.map((id) => activeException(context.folded, id)).find(Boolean);
  const action = `authorship.${options.producer}`;
  if (excepted) {
    // Unsigned, and never read as signed: the exception travels with the claim and labels it.
    return { options: { ...options, presence: { schema: PRESENCE_RECORD_SCHEMA, chainId: context.chainId, approver: excepted.approver,
      action, bypass: excepted.id, at: new Date().toISOString(), claim } } };
  }
  const id = ids.find((candidate) => pinOf(context.folded, candidate));
  if (!id) return unbelieved('you have no presence key pinned');
  const pin = pinOf(context.folded, id);
  const availability = (dependencies.signerAvailability ?? (await import('./signer.mjs')).signerAvailability)();
  if (!availability.available) return unbelieved(`this computer cannot sign (${availability.reason})`);
  const terminal = (dependencies.personTerminal ?? personTerminal)();
  if (!terminal.person) return unbelieved(`it was not published from your own terminal (${terminal.reason})`);
  if (!await (dependencies.holdsKey ?? holdsKey)(pin.keyId)) return unbelieved(`this Mac does not hold your pinned key ${pin.keyId}`);
  const presence = { schema: PRESENCE_RECORD_SCHEMA, chainId: context.chainId, approver: id, keyId: pin.keyId, action,
    at: new Date().toISOString(), nonce: presenceNonce(), claim };
  const statement = authorshipClaimStatement(presence, { chainId: context.chainId });
  const card = dependencies.card ?? (async (fields) => (await import('./signer.mjs')).presenceCard(fields));
  const sign = dependencies.sign ?? (async (request) => (await import('./signer.mjs')).signWithPresence(request));
  const shown = await card({
    title: `claim authorship of ${workflow.workItem.id} / ${phase.id}`,
    lines: [`Producer: ${options.producer} (${options.channel})`, `Step: ${phase.label ?? phase.id}, generation ${generation}`,
      `Artifact: ${claim.artifactSha256 ?? '(read when published)'}`, 'A signed claim skips the checks an agent\'s draft gets.'],
    keyId: pin.keyId
  });
  const result = await sign({ statement, keyId: pin.keyId, publicKey: pin.key, card: shown });
  return { options: { ...options, presence: { ...presence, signature: result.signature, userVerification: Boolean(result.userVerification) } } };
}

function isApprover(workflow, actor) {
  const email = String(actor?.email ?? '').trim().toLowerCase();
  const login = String(actor?.login ?? '').trim().toLowerCase();
  return Object.values(workflow.resolution?.approvalAuthorities ?? {}).some((authority) => (authority?.members ?? []).some((member) =>
    (email && String(member?.email ?? '').toLowerCase() === email) || (login && String(member?.githubLogin ?? '').toLowerCase() === login)));
}

async function fileSha256(file) {
  try { return `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`; }
  catch { return null; }
}
