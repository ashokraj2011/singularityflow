/** Native decision-test-risk recording. Existing authority, record and transaction semantics are retained. */
import {requireApprovalAuthority} from '../kernel/approval-policy.mjs';
import {testRunRiskAuthorities} from '../kernel/approval-fallback.mjs';
import {recordTestRunRisk,recordTestRunRiskRevocation,testRunRiskIneligibility} from '../test-run-risk.mjs';
import {latestStepAttempts} from '../verification/attempts.mjs';
import {workDirRelative} from '../story-paths.mjs';
import {LIFECYCLE_EVENT} from '../lifecycle-event.mjs';
import {actorKey,assertNoPendingPublication,transactStory} from '../state-stores.mjs';
import {nowIso,SingularityFlowError} from '../util.mjs';

/** The latest recorded run of each test command of a step, by command. */
function latestAttempts(root, config, workflow, phaseId) {
  return latestStepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phaseId);
}

function chooseAttempt(latest, commandId, phaseId, argvSha256 = null) {
  if (commandId) {
    const attempt = latest.get(commandId) ?? null;
    // A run recorded here with other argv (another platform's wrapper) is not the named command.
    return argvSha256 && attempt && attempt.argvSha256 !== argvSha256 ? null : attempt;
  }
  const candidates = [...latest.values()].filter((attempt) => !testRunRiskIneligibility(attempt));
  if (candidates.length === 1) return candidates[0];
  const names = [...latest.keys()].sort();
  throw new SingularityFlowError(candidates.length
    ? `More than one test command of ${phaseId} could not run; name one with --command (${candidates.map((entry) => entry.commandId).sort().join(', ')}).`
    : names.length
      ? `No test command of ${phaseId} has a latest run that the environment stopped (${names.join(', ')}).`
      : `No run of a test command of ${phaseId} is recorded in this checkout yet; publish or submit the step first so its failure is recorded, or name the command, cause class and digest its refusal gave with --command ID --cause-class CLASS --argv-sha256 DIGEST.`,
  { code: candidates.length ? 'TEST_RUN_RISK_COMMAND_REQUIRED' : 'TEST_RUN_RISK_NOT_ELIGIBLE' });
}

/**
 * One test-run risk decision, or the revocation named by `revoke`, for `phaseId`: checked for
 * eligibility and authority, and ready to write into a transaction. Its own commit and an approval's
 * both write it [SPEC-OAP M4], so the record is the same whichever surface a person used.
 */
export async function testRunRiskDecisionPart(root, config, workflow, {
  phaseId, revoke = null, commandId = null, argvSha256 = null, causeClass = null, cause = '', reason = '', expires = null
}, { actor, agent = null }) {
  const id = workflow.workItem.id;
  const commandOption = commandId;
  const argvDigest = argvSha256;
  const attempt = revoke ? null
    : chooseAttempt(await latestAttempts(root, config, workflow, phaseId), commandOption, phaseId, argvDigest);
  const groups = testRunRiskAuthorities(workflow, phaseId);
  if (!groups.length) {
    throw new SingularityFlowError(`Step ${phaseId} has no approval group, so nobody can accept the risk of its tests.`, { code: 'RISK_AUTHORITY_UNAVAILABLE' });
  }
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const common = { reason: reason ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const decide = (aggregate) => revoke
    ? recordTestRunRiskRevocation(aggregate, { riskId: revoke, ...common })
    : recordTestRunRisk(aggregate, { phaseId, attempt, commandId: commandOption, argvSha256: argvDigest, causeClass, cause: cause ?? '',
      expires: expires ?? null, ...common });
  decide(structuredClone(workflow));
  return {
    decision: 'test-risk', phaseId, authority,
    message: `[${id}][test-risk:${revoke ? 'revoke' : 'accept'}] ${revoke ?? `${phaseId} ${attempt?.commandId ?? commandOption}`}`,
    write(aggregate) {
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'risk_decided', phase: phaseId,
        detail: recorded.revokes
          ? `${recorded.revokes} on ${recorded.phase} ${recorded.commandId} revoked. ${recorded.reason}`
          : `${recorded.id} accepts that ${recorded.phase} test command ${recorded.commandId} cannot run here (${recorded.causeClass}: ${recorded.cause}) until ${recorded.expiresAt.slice(0, 10)}${recorded.boundBy === 'command-digest' ? '; bound by its argv digest, with no run of it recorded in this checkout' : ''}. ${recorded.reason}`
      });
      return recorded;
    },
    record: (recorded) => recorded.revokes ?? recorded.id
  };
}

/**
 * Record one test-run risk decision and commit it. `decision test-risk` and the decision list record
 * through this; an approval writes the same part into its own commit [SPEC-OAP M4].
 */
export async function recordTestRunRiskDecision(root, config, workflow, request, { actor, agent = null }) {
  const part = await testRunRiskDecisionPart(root, config, workflow, request, { actor, agent });
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId: part.phaseId, generation: null,
      actor, agent, authorityGroup: part.authority.authorityGroup, payload: { decision: 'test-risk' }
    },
    part.message,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a test-run risk decision');
      return part.write(aggregate);
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'test-risk', record: recorded.revokes ?? recorded.id, revoked: Boolean(recorded.revokes), reviewPacketSha256: null }
      })
    }
  );
  return { record, publication };
}
