/**
 * `decision witness-defer`: an approver of the step that delivers a criterion names a later step to give
 * its inspection or visual sign-off [PHR:REQ-007], owner decision 2. See src/witness-deferrals.mjs.
 *
 *   singularity-flow decision witness-defer [WORK-ID] --criterion CLAUSE --slot SLOT --to STEP --reason TEXT
 *
 * Only to a later step that can perform and repair the sign-off; that step then holds it at its own
 * approval. The Copilot guard refuses this command, like a dated risk: an agent may name the route, never
 * decide it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { riskAuthorities } from '../evidence/risk-decisions.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { activeWitnessDeferral, recordWitnessDeferral } from '../witness-deferrals.mjs';
import { actionActor } from './kernel.mjs';

/** The criterion's open sign-off slot and the step that answers for it now, from the evaluation every reader uses. */
async function openSlot(root, config, workflow, clauseId, slotName) {
  const { evidenceGraphFromAggregate } = await import('../evidence/graph.mjs');
  const { evaluateEvidence } = await import('../evidence/evaluate.mjs');
  const row = evaluateEvidence(await evidenceGraphFromAggregate(root, config, workflow)).rows.find((entry) => entry.id === clauseId) ?? null;
  const slot = row?.type === 'AC' ? (row.verification?.contract?.slots ?? []).find((entry) => entry.slot === slotName) ?? null : null;
  if (!slot || !['inspection', 'visual'].includes(slot.method)) {
    throw new SingularityFlowError(`${clauseId || 'That criterion'} has no inspection or visual slot ${slotName || '(none given)'}; see singularity-flow evidence matrix.`, { code: 'WITNESS_DEFERRAL_INVALID' });
  }
  if (slot.status === 'met') throw new SingularityFlowError(`${clauseId}'s slot ${slotName} is already signed off; there is nothing to defer.`, { code: 'WITNESS_DEFERRAL_INVALID' });
  const verify = row.obligations.find((entry) => entry.responsibility === 'verify');
  const implement = row.obligations.find((entry) => entry.responsibility === 'implement');
  const from = activeWitnessDeferral(workflow, clauseId, slotName)?.to
    ?? (verify?.owningSteps?.length ? verify.owningSteps : implement?.owningSteps ?? []).at(-1) ?? null;
  if (!from) throw new SingularityFlowError(`No step delivers ${clauseId}, so its sign-off cannot be deferred from one.`, { code: 'WITNESS_DEFERRAL_INVALID' });
  return { method: slot.method, from };
}

export async function decisionWitnessDeferCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${id} is ${workflow.status}; a sign-off is deferred while it is in progress.`, { code: 'WITNESS_DEFERRAL_INVALID' });
  }
  const clauseId = String(optionString(options, 'criterion') ?? '').toUpperCase();
  const slot = optionString(options, 'slot') ?? '';
  const to = optionString(options, 'to') ?? '';
  const { method, from } = await openSlot(root, config, workflow, clauseId, slot);
  // Whoever would give the sign-off decides to have a later step give it instead.
  const groups = riskAuthorities(workflow, { owningSteps: [from] });
  if (!groups.length) throw new SingularityFlowError(`${from} has no approval group, so nobody can defer its sign-off.`, { code: 'WITNESS_DEFERRAL_INVALID' });
  const actor = actionActor(root);
  const authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const request = { clauseId, slot, method, from, to, reason: optionString(options, 'reason') ?? '',
    actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null };
  // Checked before anything is written, so a refusal changes nothing.
  recordWitnessDeferral(structuredClone(workflow), { ...request, at: nowIso() });
  const { value: record, publication } = await transactStory(root, config, workflow, {
    type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
    actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'witness-defer' }
  }, `[${id}][witness-defer] ${clauseId} ${slot} to ${to}`, async (aggregate) => {
    await assertNoPendingPublication(root, config, aggregate, 'defer a sign-off');
    const recorded = recordWitnessDeferral(aggregate, { ...request, at: nowIso() });
    aggregate.history.push({ at: recorded.at, actor: recorded.actor, agent, event: 'witness_deferred', phase: aggregate.currentPhase ?? null,
      detail: `${recorded.id}: ${recorded.clauseId}'s ${recorded.method} sign-off of slot ${recorded.slot} is given at ${recorded.to}, not ${recorded.from}. ${recorded.reason}` });
    return recorded;
  }, {
    exactWorkItemPaths: [],
    eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
      payload: { decision: 'witness-defer', record: recorded.id, reviewPacketSha256: null } })
  });
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded ${record.id}: ${record.to} gives ${record.clauseId}'s ${record.method} sign-off of slot ${record.slot}, and holds it at its approval; decided through ${record.authorityGroup}.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.witness-defer', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.witness-defer.succeeded', { record: record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
