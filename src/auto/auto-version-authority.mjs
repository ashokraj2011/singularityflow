/**
 * An Auto flight and the step versions it writes [SPEC-OSA v1.1 §7, D3, OSA:REQ-030, REQ-034].
 *
 * - A repair of a step Auto already published starts the step's next version. The Repair Plan the person reviews names that
 *   version ("Start version N of <step>?"), so their confirmation of the plan's exact hash is their informed yes to it. The
 *   executor opens the version through the one opening operation with a consent receipt bound to that confirmation. The
 *   ratified Auto policy, a default or the model never gives that yes: without the person's confirmation nothing opens.
 * - A flight the person continues on another checkout (a fresh-clone recovery they resume, or a repair they authorize there)
 *   writes the step's open version from that checkout. Their resume or repair is the verified takeover that moves the
 *   version's writer fence here, with its own leased commit; the earlier checkout is fenced.
 */
import { SingularityFlowError } from '../util.mjs';

const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

/** The successor a repair of `phase` would start (`{ phase, step, version, from, question }`), or null when one is open or none published. */
export async function repairVersionOpening(workflow, phase) {
  if (!workflow || !phase) return null;
  const [{ stepDecisionOf }, { versionProposal }] = await Promise.all([import('../step-decision.mjs'), import('../story-version-proposal.mjs')]);
  // The step's versions as the kernel's decision reads them: never re-derived here [OSA:REQ-001].
  const version = stepDecisionOf(workflow, phase)?.version;
  if (!version || version.writing !== null || !(version.published >= 1)) return null;
  const { proposal, question } = versionProposal(workflow, phase, { reason: 'own-correction' });
  return { phase: phase.id, step: proposal.step, version: proposal.version, from: proposal.from.published, question };
}

/** The sentence a Repair Plan's objective ends with when confirming it starts the step's next version. */
export const repairVersionSentence = (opening) => ` Confirming this plan is the yes to start version ${opening.version} of ${opening.step}; `
  + `published version ${opening.from} stays unchanged.`;

/**
 * Open the next version of the flight's step for the authorized repair, on the person's yes to its Repair Plan, through the
 * one opening operation on the Story as `phase begin` loads it [D3, OSA:REQ-030]. Null when the step needs no new version.
 * Refused when the repair's authorization is not the person's, or names another version.
 */
export async function openAuthorizedRepairVersion(root, state) {
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const { definition: config, workflow } = await loadAcceptedStoryExecution(root, state.story.workId);
  const phase = workflow.phases?.[state.story.phase];
  const needed = await repairVersionOpening(workflow, phase);
  if (!needed) return null;
  const repair = state.activeRepair ?? null;
  const authorized = repair?.versionOpening ?? null;
  // The way out is the person's own review of a Repair Plan that names the version.
  const review = { command: `singularity-flow auto repair ${state.flightId} --refusal ${state.activeRefusalId ?? '<REFUSAL-ID>'}` };
  if (repair?.authorizationSource !== 'human-confirmation' || authorized?.phase !== phase.id
      || Number(authorized.version) !== needed.version || Number(authorized.from) !== needed.from) {
    fail(`Starting version ${needed.version} of ${needed.step} needs the person's yes, and this repair's authorization does not give it. Nothing was opened.`,
      'VERSION_CONSENT_REQUIRED', { phase: phase.id, version: needed.version, nextAction: review });
  }
  const [{ proposalNow, codeOpening, documentOpening }, { consentReceipt }, { gitDirectories }, { actionActor, gitCommonDir },
    { machineLocalPublicationIntegrityKey }, { openVersion }, { phaseRequiresCodeDelivery }] = await Promise.all([
    import('../commands/phase-opening.mjs'), import('../story-version-consent.mjs'), import('../story-version-acceptance.mjs'),
    import('../git.mjs'), import('../publication-machine-integrity.mjs'), import('../story-version-opening.mjs'),
    import('../code-delivery-policy.mjs')]);
  const { proposal, digest, question } = await proposalNow(root, workflow, phase, { reason: 'own-correction' });
  if (proposal.version !== needed.version) fail(`${phase.id} changed after the repair was authorized; nothing was opened.`, 'VERSION_OPENING_STALE',
    { phase: phase.id, authorizedVersion: needed.version, currentVersion: proposal.version, nextAction: review });
  await machineLocalPublicationIntegrityKey(root, { create: true });
  const commonDir = gitDirectories(root)?.commonDir ?? gitCommonDir(root);
  const principal = actionActor(root);
  const receipt = consentReceipt(commonDir, { proposal, digest, surface: 'auto-repair', question, principal: authorized.principal ?? principal,
    assurance: 'auto-repair-plan', host: 'auto', authorization: authorized.authorization ?? null });
  if (!receipt) fail('This clone cannot seal the consent receipt for the repair\'s version.', 'VERSION_OPENING_STORAGE_UNAVAILABLE',
    { nextAction: { command: 'singularity-flow doctor --json' } });
  return openVersion(root, config, workflow, phase, { proposal, digest, receipt, principal,
    open: phaseRequiresCodeDelivery(phase) ? codeOpening(root, config) : documentOpening() });
}

/**
 * A repair authorized without the person's yes to the version it now starts, under which nothing ran: an older build's
 * authorization, given before Repair Plans named that version, then stopped before its repair. Its reservation is still
 * `planned`, so no model call and no version opening happened under it. The executor gives the flight back to the person
 * on the same refusal, then `close()` marks the reservation superseded, never spent; `auto repair` plans the repair anew
 * naming the version, and confirming that plan is their yes [D3, OSA:REQ-030]. Returns `{ nextAction, close }`, or null
 * when the authorization gives that yes or its repair ran.
 */
export async function unnamedRepairAuthorization(root, worktree, state, reservation) {
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const { workflow } = await loadAcceptedStoryExecution(worktree, state.story.workId);
  const needed = await repairVersionOpening(workflow, workflow.phases?.[state.story.phase]);
  const authorized = state.activeRepair?.versionOpening ?? null;
  if (!needed || (state.activeRepair?.authorizationSource === 'human-confirmation' && authorized?.phase === needed.phase
      && Number(authorized.version) === needed.version && Number(authorized.from) === needed.from)) return null;
  const { readAutoP1Record, updateAutoAttempt } = await import('./auto-p1-records.mjs');
  const attempt = reservation?.attemptId
    ? await readAutoP1Record(root, 'auto-attempt', state.flightId, reservation.attemptId).catch(() => null) : null;
  if (attempt?.status !== 'planned' || attempt.reason !== `repair-authorization:${state.activeRepairPlanId}`) return null;
  return { nextAction: `Review the repair again: singularity-flow auto repair ${state.flightId} --refusal ${state.activeRefusalId} plans it again naming `
    + `version ${needed.version} of ${needed.step}, and confirming that plan is your yes to it. Nothing ran under the earlier authorization.`,
  close: () => updateAutoAttempt(root, state.flightId, attempt.attemptId, { status: 'failed', result: { status: 'failed',
    code: 'AUTO_REPAIR_AUTHORIZATION_SUPERSEDED', message: `Nothing ran: this authorization was not the person's yes to version ${needed.version} of ${needed.step}.` } },
  { expectedRecordSha256: attempt.recordSha256 }) };
}

/**
 * Move the open version of the flight's step to this checkout's writer when another checkout holds it [§7.3, OSA:REQ-034].
 * Returns the takeover (`{ commit, fence }`), or null when nothing is open or this checkout already writes it.
 */
export async function takeOverFlightVersionWriter(worktree, definition, workflow, phaseId) {
  const phase = workflow?.phases?.[phaseId];
  if (!phase?.versionOpening || workflow.currentPhase !== phaseId) return null;
  const { observeOpening } = await import('../story-version-acceptance.mjs');
  if (observeOpening(worktree, workflow, phase)?.writer !== 'other') return null;
  const [{ takeOverWriter }, { actionActor }] = await Promise.all([import('../story-version-opening.mjs'), import('../git.mjs')]);
  const taken = await takeOverWriter(worktree, definition, workflow, phase, { principal: actionActor(worktree) });
  if (!taken || taken.current) return null;
  if (!taken.taken) fail(`Version ${phase.versionOpening.version} of ${phaseId} was taken over here, but the shared Story branch has not accepted it yet. `
    + 'Publish it, then continue the flight.', 'VERSION_WRITER_TAKEOVER_PENDING', { phase: phaseId, commit: taken.commit ?? null,
    nextAction: { command: `singularity-flow sync ${workflow.workItem.id}` } });
  return { commit: taken.commit, fence: taken.fence };
}
