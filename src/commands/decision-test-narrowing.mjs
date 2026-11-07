/**
 * `decision test-narrowing`: a person in the group that approves a step accepts that one of its test
 * commands ran narrowed, or revokes such a decision. See src/test-narrowing.mjs [TCE:REQ-023].
 *
 *   singularity-flow decision test-narrowing [WORK-ID] --phase PHASE [--command ID] --reason TEXT [--expires YYYY-MM-DD]
 *   singularity-flow decision test-narrowing [WORK-ID] --revoke TNR-001 --reason TEXT
 *
 * It accepts the narrowing of the latest recorded run of the command in this checkout: a run that
 * passed and was narrowed (filters, focused tests, skipped tests or fewer tests than its baseline).
 * The decision is bound to the command's pin and that narrowing, and covers later runs whose
 * narrowing is the same or smaller. The Copilot guard refuses this command, like approve: an agent
 * may name the route, never decide it.
 */


import {executeTestDecision} from './shared/test-decision-operation.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';

import { narrowingWords } from '../test-narrowing.mjs';

import { optionBoolean, optionString } from '../util.mjs';

import {recordTestNarrowingDecision} from '../engine-compatibility/native-test-narrowing-decisions.mjs';
export {recordTestNarrowingDecision};


export async function decisionTestNarrowingCommand(positionals, options) {
  const {receipt,context,publication}=await executeTestDecision('decision.test-narrowing',
    positionals[2]??optionString(options,'work-id')??null,options,()=>({phaseId:optionString(options,'phase')??null,commandId:optionString(options,'command')??null,revoke:optionString(options,'revoke')??null,reason:optionString(options,'reason')??'',expires:optionString(options,'expires')??null}));
  const {workflow}=context,id=receipt.subject.id,record=receipt.record;
  if (!optionBoolean(options, 'json')) {
    console.log(record.revokes ? `Revoked ${record.revokes} on ${record.phase} ${record.commandId}.`
      : `Recorded ${record.id}: ${record.phase} test command ${record.commandId} may pass narrowed (${narrowingWords(record.narrowing)})`
        + `${record.expiresAt ? ` until ${record.expiresAt.slice(0, 10)}` : ' until the Story ends'}, accepted through ${record.authorityGroup}. `
        + 'A run narrowed further, or under a changed pin, is refused again.');
    console.log(publication.pushed ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.test-narrowing', classification: 'mutation' },
    subject: { kind: 'story', id },
    // The risk decision's words fit: the narrowed run stays visible, and the decision counts until it expires or is revoked.
    outcome: succeeded('decision.risk.succeeded', { record: record.revokes ? `the revocation of ${record.revokes}` : record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
