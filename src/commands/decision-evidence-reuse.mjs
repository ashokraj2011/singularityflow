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

import { evidenceReuseLabel } from '../evidence-reuse.mjs';

import {executeTestDecision} from './shared/test-decision-operation.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString } from '../util.mjs';

import {evidenceReuseDecisionPart,recordEvidenceReuseDecision,evidenceReuseAuthorities} from '../engine-compatibility/native-evidence-decisions.mjs';
export {evidenceReuseDecisionPart,recordEvidenceReuseDecision,evidenceReuseAuthorities};

export async function decisionEvidenceReuseCommand(positionals, options) {
  const {receipt,context,publication}=await executeTestDecision('decision.evidence-reuse',
    positionals[2]??optionString(options,'work-id')??null,options,()=>({phaseId:optionString(options,'phase')??null,attemptId:optionString(options,'from-attempt')??null,revoke:optionString(options,'revoke')??null,reason:optionString(options,'reason')??'',expires:optionString(options,'expires')??null}));
  const {workflow}=context,id=receipt.subject.id,record=receipt.record;
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
