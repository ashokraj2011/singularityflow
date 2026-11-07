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

import { repoRoot } from '../git.mjs';

import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { loadSession } from '../session.mjs';

import { loadConfig } from '../state-stores.mjs';
import { testRunCauseCategory, testRunCauseWords } from '../test-run-cause.mjs';
import { testRunRiskAuthorities } from '../test-run-risk.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

import { actionActor } from './kernel.mjs';
import {testRunRiskDecisionPart,recordTestRunRiskDecision} from '../engine-compatibility/native-test-risk-decisions.mjs';
export {testRunRiskDecisionPart,recordTestRunRiskDecision};

// Pure, so the decision list can say who decides without loading this command.
export { testRunRiskAuthorities } from '../test-run-risk.mjs';

export async function decisionTestRiskCommand(positionals, options) {
  // Its sibling decision on a test run, routed here so the CLI's dispatch keeps one line for both.
  if (positionals[1] === 'test-narrowing') return (await import('./decision-test-narrowing.mjs')).decisionTestNarrowingCommand(positionals, options);
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
