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


import {executeTestDecision} from './shared/test-decision-operation.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';

import { testRunCauseWords } from '../test-run-cause.mjs';
import { optionBoolean, optionString } from '../util.mjs';

import {testRunRiskDecisionPart,recordTestRunRiskDecision} from '../engine-compatibility/native-test-risk-decisions.mjs';
export {testRunRiskDecisionPart,recordTestRunRiskDecision};

// Pure, so the decision list can say who decides without loading this command.
export { testRunRiskAuthorities } from '../test-run-risk.mjs';

export async function decisionTestRiskCommand(positionals, options) {
  // Its sibling decision on a test run, routed here so the CLI's dispatch keeps one line for both.
  if (positionals[1] === 'test-narrowing') return (await import('./decision-test-narrowing.mjs')).decisionTestNarrowingCommand(positionals, options);
  const {receipt,context,publication}=await executeTestDecision('decision.test-risk',
    positionals[2]??optionString(options,'work-id')??null,options,()=>({phaseId:optionString(options,'phase')??null,commandId:optionString(options,'command')??null,argvSha256:optionString(options,'argv-sha256')??null,causeClass:optionString(options,'cause-class')??null,cause:optionString(options,'cause')??'',revoke:optionString(options,'revoke')??null,reason:optionString(options,'reason')??'',expires:optionString(options,'expires')??null}));
  const {workflow}=context,id=receipt.subject.id,record=receipt.record;
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
