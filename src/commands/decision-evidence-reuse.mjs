/**
 * `decision evidence-reuse`: a person in the group that approves a step decides that a test run an
 * earlier step of the Story recorded stands for this step, or revokes such a decision. See
 * src/evidence-reuse.mjs for the source binding and how the reuse is shown.
 *
 *   singularity-flow decision evidence-reuse [WORK-ID] --phase PHASE --from-attempt TA-... --reason TEXT [--expires YYYY-MM-DD]
 *   singularity-flow decision evidence-reuse [WORK-ID] --revoke ERU-001 --reason TEXT
 *
 * Only a retained, passed, structured attempt of an earlier step can be named, and only while the
 * application source is byte-identical to the one it ran on. The reusing step is never said to
 * have run anything. The Copilot guard refuses this command, like approve: an agent may name the
 * route, never decide it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { evidenceReuseDecision, evidenceReuseLabel, prepareEvidenceReuse, recordEvidenceReuse,
  recordEvidenceReuseRevocation } from '../evidence-reuse.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { actionActor } from './kernel.mjs';
import { testRunRiskAuthorities } from './decision-test-risk.mjs';

/**
 * Who may reuse evidence for a step: the groups that approve the step consuming it, exactly as
 * for a test-run risk (a step nobody approves is answered for by the next approving step).
 */
export function evidenceReuseAuthorities(workflow, phaseId) {
  return testRunRiskAuthorities(workflow, phaseId);
}

/**
 * One evidence-reuse decision for `phaseId` (the attempt verified against the current source first),
 * or the revocation named by `revoke`, checked and ready to write into a transaction. Its own commit
 * and an approval's both write it [SPEC-OAP M4], so the source binding, authority and record are the same.
 */
export async function evidenceReuseDecisionPart(root, config, workflow, {
  phaseId, attemptId = null, revoke = null, reason = '', expires = null
}, { actor, agent = null }) {
  const id = workflow.workItem.id;
  // Verified before authority, so a refusal names what is wrong with the evidence first.
  const prepared = revoke ? null : await prepareEvidenceReuse(root, config, workflow, { phaseId, attemptId });
  const groups = evidenceReuseAuthorities(workflow, phaseId);
  if (!groups.length) {
    throw new SingularityFlowError(`Step ${phaseId} has no approval group, so nobody can approve reusing evidence for it.`, { code: 'EVIDENCE_REUSE_AUTHORITY_UNAVAILABLE' });
  }
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const common = { reason: reason ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const decide = (aggregate) => revoke
    ? recordEvidenceReuseRevocation(aggregate, { reuseId: revoke, ...common })
    : recordEvidenceReuse(aggregate, { phaseId, candidate: prepared, expires: expires ?? null, ...common });
  decide(structuredClone(workflow));
  return {
    decision: 'evidence-reuse', phaseId, authority,
    message: `[${id}][evidence-reuse:${revoke ? 'revoke' : 'accept'}] ${revoke ?? `${phaseId} ${attemptId}`}`,
    write(aggregate) {
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'evidence_reuse_decided', phase: phaseId,
        detail: recorded.revokes
          ? `${recorded.revokes} (${recorded.attemptId} for ${recorded.phase}) revoked. ${recorded.reason}`
          : `${recorded.id} ${evidenceReuseLabel(recorded)}${recorded.expiresAt ? `, until ${recorded.expiresAt.slice(0, 10)}` : ''}. ${recorded.reason}`
      });
      return recorded;
    },
    record: (recorded) => recorded.revokes ?? recorded.id
  };
}

/**
 * Record one evidence-reuse decision for `phaseId` (the attempt verified against the current source
 * first), or the revocation named by `revoke`, and commit it. The command and the decision list
 * both record through this; an approval writes the same part into its own commit [SPEC-OAP M4].
 */
export async function recordEvidenceReuseDecision(root, config, workflow, request, { actor, agent = null }) {
  const part = await evidenceReuseDecisionPart(root, config, workflow, request, { actor, agent });
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: part.phaseId, generation: null,
      actor, agent, authorityGroup: part.authority.authorityGroup, payload: { decision: 'evidence-reuse' }
    },
    part.message,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record an evidence-reuse decision');
      return part.write(aggregate);
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'evidence-reuse', record: recorded.revokes ?? recorded.id, revoked: Boolean(recorded.revokes), reviewPacketSha256: null }
      })
    }
  );
  return { record, publication };
}

export async function decisionEvidenceReuseCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  // The Story's own branch, which need not be named after its ID.
  if (requestedId) await checkoutStoryBranch(root, config, requestedId, { fetch: optionBoolean(options, 'fetch') });
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${id} is ${workflow.status}; evidence reuse is decided while it is in progress.`, { code: 'EVIDENCE_REUSE_STORY_CLOSED' });
  }
  const revoke = optionString(options, 'revoke') ?? null;
  const requestedPhase = optionString(options, 'phase') ?? null;
  const attemptId = optionString(options, 'from-attempt') ?? null;
  if (!revoke === !requestedPhase || (revoke && (attemptId || optionString(options, 'expires')))) {
    throw new SingularityFlowError('Name the step with --phase PHASE --from-attempt TA-..., or a decision to revoke with --revoke ERU-...', { code: 'EVIDENCE_REUSE_INVALID' });
  }
  if (!revoke && !attemptId) {
    throw new SingularityFlowError('Name the recorded run to reuse with --from-attempt TA-... (an earlier step\'s retained attempt).', { code: 'EVIDENCE_REUSE_INVALID' });
  }
  const target = revoke ? evidenceReuseDecision(workflow, revoke) : null;
  if (revoke && !target) throw new SingularityFlowError(`This Story has no evidence-reuse decision ${revoke}.`, { code: 'EVIDENCE_REUSE_UNKNOWN' });
  const phaseId = revoke ? target.phase : requestedPhase;
  if (!workflow.phases?.[phaseId] || workflow.phases[phaseId].status === 'skipped') {
    throw new SingularityFlowError(`Story ${id} has no step ${phaseId} that is on its route.`, { code: 'EVIDENCE_REUSE_INVALID' });
  }
  const actor = actionActor(root);
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const { record, publication } = await recordEvidenceReuseDecision(root, config, workflow, {
    phaseId, attemptId, revoke, reason: optionString(options, 'reason') ?? '', expires: optionString(options, 'expires') ?? null
  }, { actor, agent });
  if (!optionBoolean(options, 'json')) {
    console.log(record.revokes
      ? `Revoked ${record.revokes}: ${record.attemptId} no longer stands for ${record.phase}.`
      : `Recorded ${record.id}, ${evidenceReuseLabel(record)}. Accepted through ${record.authorityGroup}${record.expiresAt ? ` until ${record.expiresAt.slice(0, 10)}` : ''}; it lapses as soon as the application source changes.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.evidence-reuse', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.evidence-reuse.succeeded', { record: record.revokes ? `the revocation of ${record.revokes}` : record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record,
      ...(record.revokes ? {} : { label: evidenceReuseLabel(record) }) }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
