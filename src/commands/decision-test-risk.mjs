/**
 * `decision test-risk`: a person in the group that approves a step accepts the risk that one of its
 * test commands cannot run in this environment, or revokes such a decision. See src/test-run-risk.mjs.
 *
 *   singularity-flow decision test-risk [WORK-ID] --phase PHASE [--command ID [--cause-class CLASS] [--argv-sha256 DIGEST]] --cause TEXT --reason TEXT --expires YYYY-MM-DD
 *   singularity-flow decision test-risk [WORK-ID] --revoke TRR-001 --reason TEXT
 *
 * Only a recorded run whose classified cause is the environment can be accepted, and the decision
 * records that cause class [TCE:REQ-042]. Runs are kept in the private Git storage of the checkout
 * that ran them, so an approver on another machine names the command, the argv digest and the cause
 * class its refusal gave instead; each run the decision lets through is still checked for that same
 * cause. The Copilot guard refuses this command, like approve: an agent may name the route, never
 * decide it.
 */
import { checkoutStoryBranch } from '../story-branch-name.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { requireApprovalAuthority } from '../approval-authority.mjs';
import { repoRoot } from '../git.mjs';
import { LIFECYCLE_EVENT } from '../lifecycle-event.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';
import { workDirRelative } from '../story-paths.mjs';
import { actorKey, assertNoPendingPublication, loadConfig, transactStory } from '../state-stores.mjs';
import { testRunCauseCategory, testRunCauseWords } from '../test-run-cause.mjs';
import { recordTestRunRisk, recordTestRunRiskRevocation, testRunRiskAuthorities, testRunRiskIneligibility } from '../test-run-risk.mjs';
import { nowIso, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { latestStepAttempts } from '../verification/attempts.mjs';
import { actionActor } from './kernel.mjs';

// Pure, so the decision list can say who decides without loading this command.
export { testRunRiskAuthorities } from '../test-run-risk.mjs';

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

export async function decisionTestRiskCommand(positionals, options) {
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
  const commandOption = optionString(options, 'command') ?? null;
  const argvDigest = optionString(options, 'argv-sha256') ?? null;
  if (argvDigest !== null && (revoke || !commandOption || !/^[a-f0-9]{64}$/u.test(argvDigest))) {
    throw new SingularityFlowError('--argv-sha256 takes the 64-character digest a refusal named, with --phase and --command.', { code: 'TEST_RUN_RISK_INVALID' });
  }
  const causeClass = optionString(options, 'cause-class') ?? null;
  if (causeClass !== null && (revoke || testRunCauseCategory(causeClass) !== 'environment')) {
    throw new SingularityFlowError('--cause-class takes the environment cause class a refusal named, with --phase.', { code: 'TEST_RUN_RISK_INVALID' });
  }
  const actor = actionActor(root);
  const loadedSession = await loadSession(root, { required: false });
  const agent = loadedSession?.workId === id ? loadedSession.agent ?? null : null;
  const { record, publication } = await recordTestRunRiskDecision(root, config, workflow, {
    phaseId, revoke, commandId: commandOption, argvSha256: argvDigest, causeClass, cause: optionString(options, 'cause') ?? '',
    reason: optionString(options, 'reason') ?? '', expires: optionString(options, 'expires') ?? null
  }, { actor, agent });
  if (!optionBoolean(options, 'json')) {
    console.log(record.revokes
      ? `Revoked ${record.revokes} on ${record.phase} ${record.commandId}.`
      : `Recorded ${record.id}: ${record.phase} test command ${record.commandId} may publish and submit while ${testRunCauseWords(record.causeClass)} (${record.causeClass}), until ${record.expiresAt.slice(0, 10)}, accepted through ${record.authorityGroup}. It still runs every time; a run with any other cause, or a code cause, is never covered.`);
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
