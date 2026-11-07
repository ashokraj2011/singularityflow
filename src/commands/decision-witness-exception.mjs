/**
 * `decision witness-exception`: a person in the group that approves a step renews a witness
 * exception that step's approval recorded, once it lapsed or before it does. See
 * src/witness-exception-renewals.mjs.
 *
 *   singularity-flow decision witness-exception [WORK-ID] --phase STEP --mapping sha256:... --expires YYYY-MM-DD --reason TEXT
 *
 * The final check then reads the renewed expiry in place of the approval's. The Copilot guard
 * refuses this command, like approve: an agent may name the route, never decide it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../kernel/approval-policy.mjs';
import { fallbackAuthorities, stepGroups } from '../kernel/approval-fallback.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { recordWitnessExceptionRenewal, witnessException } from '../witness-exception-renewals.mjs';
import { actionActor } from './kernel.mjs';

export async function decisionWitnessExceptionCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${id} is ${workflow.status}; reopen it at its final step to renew a witness exception.`, { code: 'WITNESS_EXCEPTION_STORY_CLOSED' });
  }
  const phaseId = optionString(options, 'phase');
  const mappingSha256 = optionString(options, 'mapping');
  if (!phaseId || !/^sha256:[a-f0-9]{64}$/u.test(mappingSha256 ?? '')) {
    throw new SingularityFlowError('Name the step and the exact exception with --phase STEP --mapping sha256:... (the final check lists both).', { code: 'WITNESS_EXCEPTION_RENEWAL_INVALID' });
  }
  if (!witnessException(workflow, phaseId, mappingSha256)) {
    throw new SingularityFlowError(`${phaseId}'s current approval recorded no witness exception for ${mappingSha256}.`, { code: 'WITNESS_EXCEPTION_UNKNOWN' });
  }
  // The groups that approve the step that recorded it; a step nobody approves is answered for by the nearest one that has approvers.
  const groups = stepGroups(workflow, phaseId).length ? [...new Set(stepGroups(workflow, phaseId))] : fallbackAuthorities(workflow, [phaseId]);
  if (!groups.length) throw new SingularityFlowError(`No step of Story ${id} has an approval group, so nobody can renew this exception.`, { code: 'WITNESS_EXCEPTION_AUTHORITY_UNAVAILABLE' });
  const actor = actionActor(root);
  const authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const request = { phaseId, mappingSha256, expires: optionString(options, 'expires'), reason: optionString(options, 'reason') ?? '',
    actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null };
  // Checked before anything is written, so a refusal changes nothing.
  recordWitnessExceptionRenewal(structuredClone(workflow), { ...request, at: nowIso() });
  const { value: record, publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId, generation: null,
    actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'witness-exception' }
  }, `[${id}][witness-exception:renew] ${phaseId} ${mappingSha256.slice(7, 19)}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'renew a witness exception');
    const recorded = recordWitnessExceptionRenewal(aggregate, { ...request, at: nowIso() });
    aggregate.history.push({ at: recorded.at, actor: recorded.actor, agent, event: 'witness_exception_renewed', phase: phaseId,
      detail: `${recorded.id}: ${phaseId}'s witness exception for ${recorded.clauseId} now expires ${recorded.expiresAt.slice(0, 10)} (was ${String(recorded.previousExpiresAt ?? 'unknown').slice(0, 10)}). ${recorded.reason}` });
    return recorded;
  }, {
    exactWorkItemPaths: [],
    eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
      payload: { decision: 'witness-exception', record: recorded.id, reviewPacketSha256: null } })
  });
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded ${record.id}: ${phaseId}'s witness exception for ${record.clauseId} now expires ${record.expiresAt.slice(0, 10)}, decided through ${record.authorityGroup}.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.witness-exception', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.witness-exception.succeeded', { record: record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
