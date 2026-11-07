/** Native decision-test-narrowing recording. Existing authority, record and transaction semantics are retained. */
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {narrowingWords,recordTestNarrowing,recordTestNarrowingRevocation,testNarrowingIneligibility} from '../test-narrowing.mjs';
import {latestStepAttempts} from '../verification/attempts.mjs';
import {workDirRelative} from '../story-paths.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {actorKey,assertNoPendingPublication,transactStory} from '../state-stores.mjs';
import {nowIso,SingularityFlowError} from '../util.mjs';
const fail=(message,code='TEST_NARROWING_INVALID')=>{throw new SingularityFlowError(message,{code});};

function chooseAttempt(latest, commandId, phaseId) {
  if (commandId) return latest.get(commandId) ?? null;
  const candidates = [...latest.values()].filter((attempt) => !testNarrowingIneligibility(attempt));
  if (candidates.length === 1) return candidates[0];
  throw new SingularityFlowError(candidates.length
    ? `More than one test command of ${phaseId} ran narrowed; name one with --command (${candidates.map((entry) => entry.commandId).sort().join(', ')}).`
    : `No test command of ${phaseId} has a latest run that passed narrowed${latest.size ? ` (${[...latest.keys()].sort().join(', ')})` : ''}.`,
  { code: candidates.length ? 'TEST_NARROWING_COMMAND_REQUIRED' : 'TEST_NARROWING_NOT_ELIGIBLE' });
}

/**
 * Record one test-narrowing decision, or the revocation named by `revoke`, and commit it. The
 * command and the decision list both record through this, so authority and the record are the same.
 */
export async function recordTestNarrowingDecision(root, config, workflow, { phaseId, revoke = null, commandId = null, reason = '', expires = null }, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const attempt = revoke ? null : chooseAttempt(await latestStepAttempts(root, workDirRelative(config, id), id, phaseId), commandId, phaseId);
  const groups = testRunRiskAuthorities(workflow, phaseId);
  if (!groups.length) fail(`Step ${phaseId} has no approval group, so nobody can accept a narrowed run of its tests.`, 'RISK_AUTHORITY_UNAVAILABLE');
  const authority = requireApprovalAuthority(workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 }, actor);
  const common = { reason: reason ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const decide = (aggregate) => revoke ? recordTestNarrowingRevocation(aggregate, { narrowingId: revoke, ...common })
    : recordTestNarrowing(aggregate, { phaseId, attempt, expires, ...common });
  decide(structuredClone(workflow));
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    { type: LIFECYCLE_EVENT.DECISION_MADE, phaseId, generation: null, actor, agent, authorityGroup: authority.authorityGroup,
      payload: { decision: 'test-narrowing' } },
    `[${id}][test-narrowing:${revoke ? 'revoke' : 'accept'}] ${revoke ?? `${phaseId} ${attempt.commandId}`}`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a test-narrowing decision');
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'narrowing_decided', phase: phaseId,
        detail: recorded.revokes ? `${recorded.revokes} on ${recorded.phase} ${recorded.commandId} revoked. ${recorded.reason}`
          : `${recorded.id} accepts that ${recorded.phase} test command ${recorded.commandId} ran narrowed (${narrowingWords(recorded.narrowing)})`
            + `${recorded.expiresAt ? ` until ${recorded.expiresAt.slice(0, 10)}` : ''}. ${recorded.reason}`
      });
      return recorded;
    },
    { eventFromResult: (recorded) => ({ actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
      payload: { decision: 'test-narrowing', record: recorded.revokes ?? recorded.id, revoked: Boolean(recorded.revokes), reviewPacketSha256: null } }) }
  );
  return { record, publication };
}
