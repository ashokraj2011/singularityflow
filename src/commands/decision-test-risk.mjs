/**
 * `decision test-risk`: a person in the group that approves a step accepts the risk that one of its
 * test commands cannot run in this environment, or revokes such a decision. See src/test-run-risk.mjs.
 *
 *   singularity-flow decision test-risk [WORK-ID] --phase PHASE [--command ID] --cause TEXT --reason TEXT --expires YYYY-MM-DD
 *   singularity-flow decision test-risk [WORK-ID] --revoke TRR-001 --reason TEXT
 *
 * Only a recorded run that failed or was blocked before any test executed can be accepted. The
 * Copilot guard refuses this command, like approve: an agent may name the route, never decide it.
 */
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { branch, checkout, repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory, workDirRelative } from '../state-stores.mjs';
import { recordTestRunRisk, recordTestRunRiskRevocation, testRunRiskIneligibility } from '../test-run-risk.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { stepAttempts } from '../verification/attempts.mjs';
import { actionActor } from './kernel.mjs';

/**
 * Who may accept the risk of a step's test commands: the step's approval groups. A step nobody
 * approves (quick-fix's implement) is answered for by the next step on the route that has
 * approvers, since they review its evidence.
 */
export function testRunRiskAuthorities(workflow, phaseId) {
  const groups = (id) => {
    const policy = workflow?.phases?.[id]?.approvalPolicy ?? {};
    return [...new Set([...(policy.authorities ?? []), ...(policy.requiredAuthorities ?? [])])].sort();
  };
  const own = groups(phaseId);
  if (own.length) return own;
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  for (const id of order.slice(order.indexOf(phaseId) + 1)) {
    const next = groups(id);
    if (next.length) return next;
  }
  return [];
}

/** The latest recorded run of each test command of a step, by command. */
async function latestAttempts(root, config, workflow, phaseId) {
  const latest = new Map();
  for (const attempt of await stepAttempts(root, workDirRelative(config, workflow.workItem.id), workflow.workItem.id, phaseId)) {
    latest.set(attempt.commandId, attempt);
  }
  return latest;
}

function chooseAttempt(latest, commandId, phaseId) {
  if (commandId) return latest.get(commandId) ?? null;
  const candidates = [...latest.values()].filter((attempt) => !testRunRiskIneligibility(attempt));
  if (candidates.length === 1) return candidates[0];
  const names = [...latest.keys()].sort();
  throw new SingularityFlowError(candidates.length
    ? `More than one test command of ${phaseId} could not run; name one with --command (${candidates.map((entry) => entry.commandId).sort().join(', ')}).`
    : names.length
      ? `No test command of ${phaseId} has a latest run that failed or was blocked before any test executed (${names.join(', ')}).`
      : `No run of a test command of ${phaseId} is recorded yet; publish or submit the step first so its failure is recorded.`,
  { code: candidates.length ? 'TEST_RUN_RISK_COMMAND_REQUIRED' : 'TEST_RUN_RISK_NOT_ELIGIBLE' });
}

export async function decisionTestRiskCommand(positionals, options) {
  const root = repoRoot();
  const requestedId = positionals[2] ?? optionString(options, 'work-id') ?? null;
  let config = await loadConfig(root);
  if (requestedId && (requestedId !== branch(root) || optionBoolean(options, 'fetch'))) {
    await checkout(root, requestedId, {
      base: config.defaultBaseBranch, fetch: optionBoolean(options, 'fetch'), existingOnly: true, remote: config.git?.remote ?? 'origin'
    });
  }
  const accepted = await loadAcceptedStoryExecution(root, requestedId ?? undefined);
  config = accepted.definition;
  const workflow = accepted.workflow;
  const id = workflow.workItem.id;
  if (workflow.status !== 'in_progress') {
    throw new SingularityFlowError(`Story ${id} is ${workflow.status}; risks are decided while it is in progress.`, { code: 'RISK_STORY_CLOSED' });
  }
  const revoke = optionString(options, 'revoke') ?? null;
  const requestedPhase = optionString(options, 'phase') ?? null;
  if (!revoke === !requestedPhase) {
    throw new SingularityFlowError('Name the step with --phase PHASE, or a decision to revoke with --revoke TRR-...', { code: 'TEST_RUN_RISK_INVALID' });
  }
  const target = revoke ? (workflow.testRunRisks ?? []).find((entry) => !entry.revokes && entry.id === revoke) ?? null : null;
  const phaseId = revoke ? target?.phase ?? null : requestedPhase;
  if (revoke && !target) throw new SingularityFlowError(`This Story has no test-run risk decision ${revoke}.`, { code: 'TEST_RUN_RISK_UNKNOWN' });
  if (!workflow.phases?.[phaseId]) {
    throw new SingularityFlowError(`Story ${id} has no step ${phaseId}.`, { code: 'TEST_RUN_RISK_INVALID' });
  }
  const attempt = revoke ? null
    : chooseAttempt(await latestAttempts(root, config, workflow, phaseId), optionString(options, 'command') ?? null, phaseId);
  const groups = testRunRiskAuthorities(workflow, phaseId);
  if (!groups.length) {
    throw new SingularityFlowError(`Step ${phaseId} has no approval group, so nobody can accept the risk of its tests.`, { code: 'RISK_AUTHORITY_UNAVAILABLE' });
  }
  const actor = actionActor(root);
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const authority = requireApprovalAuthority(
    workflow.resolution.approvalAuthorities ?? config.approvalAuthorities,
    { mode: 'required', authorities: groups, requiredAuthorities: [], minimum: 1 },
    actor
  );
  const common = { reason: optionString(options, 'reason') ?? '', actor: actorKey(actor), authorityGroup: authority.authorityGroup,
    identityAssurance: authority.identityAssurance ?? null, at: nowIso() };
  const decide = (aggregate) => revoke
    ? recordTestRunRiskRevocation(aggregate, { riskId: revoke, ...common })
    : recordTestRunRisk(aggregate, { phaseId, attempt, cause: optionString(options, 'cause') ?? '',
      expires: optionString(options, 'expires') ?? null, ...common });
  decide(structuredClone(workflow));
  const { value: record, publication } = await transactStory(
    root, config, workflow,
    {
      type: LIFECYCLE_EVENT.DECISION_MADE, phaseId, generation: null,
      actor, agent, authorityGroup: authority.authorityGroup, payload: { decision: 'test-risk' }
    },
    `[${id}][test-risk:${revoke ? 'revoke' : 'accept'}] ${revoke ?? `${phaseId} ${attempt.commandId}`}`,
    async (aggregate) => {
      await assertNoPendingPublication(root, config, aggregate, 'record a test-run risk decision');
      const recorded = decide(aggregate);
      aggregate.history.push({
        at: recorded.at, actor: recorded.actor, agent, event: 'risk_decided', phase: phaseId,
        detail: recorded.revokes
          ? `${recorded.revokes} on ${recorded.phase} ${recorded.commandId} revoked. ${recorded.reason}`
          : `${recorded.id} accepts that ${recorded.phase} test command ${recorded.commandId} cannot run here (${recorded.cause}) until ${recorded.expiresAt.slice(0, 10)}. ${recorded.reason}`
      });
      return recorded;
    },
    {
      eventFromResult: (recorded) => ({
        actor, agent, authorityGroup: recorded.authorityGroup, identityAssurance: recorded.identityAssurance,
        payload: { decision: 'test-risk', record: recorded.revokes ?? recorded.id, revoked: Boolean(recorded.revokes), reviewPacketSha256: null }
      })
    }
  );
  if (!optionBoolean(options, 'json')) {
    console.log(record.revokes
      ? `Revoked ${record.revokes} on ${record.phase} ${record.commandId}.`
      : `Recorded ${record.id}: ${record.phase} test command ${record.commandId} may publish and submit without running a test until ${record.expiresAt.slice(0, 10)}, accepted through ${record.authorityGroup}. It still runs every time; a run in which tests execute and fail is never covered.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.test-risk', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.test-risk.succeeded', { record: record.revokes ? `the revocation of ${record.revokes}` : record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
