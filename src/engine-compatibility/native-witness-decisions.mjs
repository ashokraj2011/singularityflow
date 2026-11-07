/** Native human witness recording. The existing binding, presence, authority and transaction checks are retained. */
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {riskAuthorities} from '../evidence/risk-decisions.mjs';
import {recordPublishedWitness,assertWitnessReviewBinding} from '../verification/witness-records.mjs';
import {mergePlannedClaimRecords} from '../specifications.mjs';
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {fallbackAuthorities,stepGroups} from '../kernel/approval-fallback.mjs';
import {actionActor} from '../git.mjs';
import {loadSession} from '../session.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {actorKey,assertNoPendingPublication,transactStory} from '../state-stores.mjs';
import {nowIso,secureRepositoryPath,SingularityFlowError} from '../util.mjs';
import {recordWitnessExceptionRenewal,witnessException} from '../witness-exception-renewals.mjs';
import {nativeDecisionRecordActor} from './record-decision-context.mjs';

export async function commitWitnessDecision(context,input) {
  const {root,config,workflow}=context,id=workflow.workItem.id;
  const {clauseId,slotName,file,answers,reason,expectedContext,expectedFile}=input;
  const { evidenceGraphFromAggregate } = await import('../evidence/graph.mjs');
  const { evaluateEvidence } = await import('../evidence/evaluate.mjs');
  const graph = await evidenceGraphFromAggregate(root, config, workflow);
  const evaluation = evaluateEvidence(graph);
  const row = evaluation.rows.find((entry) => entry.id === clauseId) ?? null;
  if (!row || row.type !== 'AC') {
    throw new SingularityFlowError(`The evidence matrix of ${id} has no acceptance criterion ${clauseId || '(none given)'}; see singularity-flow evidence matrix.`, { code: 'WITNESS_CRITERION_UNKNOWN' });
  }
  const { mergedVerificationContracts } = await import('../verification/contracts.mjs');
  const plans = graph.records.planned ?? [];
  const contract = mergedVerificationContracts(plans).get(clauseId) ?? null;
  const slot = contract?.slots.find((entry) => entry.slot === slotName) ?? null;
  // Whoever approves the step that delivers or verifies the criterion may witness it.
  const owning = row.obligations.filter((entry) => ['verify', 'implement'].includes(entry.responsibility)).flatMap((entry) => entry.owningSteps);
  const groups = riskAuthorities(workflow, { owningSteps: [...new Set(owning)] });
  if (!groups.length) {
    throw new SingularityFlowError(`No step delivering ${clauseId} has an approval group, so nobody can witness it.`, { code: 'WITNESS_AUTHORITY_UNAVAILABLE' });
  }
  const {actor,agent}=await nativeDecisionRecordActor(context);
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const secured = await secureRepositoryPath(root, file, { label: 'Witnessed file', mustExist: true, type: 'file' });
  const sha256 = `sha256:${createHash('sha256').update(await readFile(secured.absolute)).digest('hex')}`;
  const decide = async (aggregate) => {
    const current = await secureRepositoryPath(root, file, { label: 'Witnessed file', mustExist: true, type: 'file' });
    const actualFile = `sha256:${createHash('sha256').update(await readFile(current.absolute)).digest('hex')}`;
    assertWitnessReviewBinding(aggregate, { expectedContext: expectedContext,
      expectedFile: expectedFile ?? sha256, actualFile, clauseId, slot: slotName, file: current.relative ?? file });
    return recordPublishedWitness(root, aggregate, {
      clauseId, slot, file: secured.relative ?? file, sha256, answers, reason: reason,
      actor: actorKey(actor), authorityGroup: authority.authorityGroup, identityAssurance: authority.identityAssurance ?? null, at: nowIso(),
      plannedClaim: mergePlannedClaimRecords(plans)[clauseId] ?? null
    });
  };
  await decide(structuredClone(workflow));
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: workflow.currentPhase ?? null, generation: null,
      actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'witness' }
    },
    `[${id}][witness] ${clauseId} ${slotName}`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a witness');
      const recorded = await decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'witness_recorded', phase: aggregate.currentPhase ?? null,
        detail: `${recorded.id}: ${recorded.method} of ${recorded.file} for ${recorded.clauseId} slot ${recorded.slot} ${recorded.outcome === 'met' ? 'satisfies it' : 'does not satisfy it'}. ${recorded.reason}`
      });
      return recorded;
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'witness', record: recorded.id, reviewPacketSha256: null }
      })
    }
  );
  return {record,publication};
}

export async function commitWitnessExceptionRenewal(context,input) {
  const {root,config,workflow}=context,id=workflow.workItem.id;
  const {phaseId,mappingSha256}=input;
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
  context.who={actor,agent};
  const request = { phaseId, mappingSha256, expires: input.expires, reason: input.reason,
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
  return {record,publication};
}
