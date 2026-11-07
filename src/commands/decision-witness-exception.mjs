/**
 * `decision witness-exception`: a person in the group that approves a step renews a witness
 * exception that step's approval recorded, once it lapsed or before it does. See
 * src/witness-exception-renewals.mjs.
 *
 *   singularity-flow decision witness-exception [WORK-ID] --phase STEP --mapping sha256:... --expires YYYY-MM-DD --reason TEXT
 *
 * The final check then reads the renewed expiry in place of the approval's. The Copilot guard
 * refuses this command, like approve: an agent may name the route, never decide it.
 */
import { repoRoot } from '../git.mjs';
import {createGitEngine} from '../engine-compatibility/git-publication.mjs';
import { commandResult, effects, succeeded } from '../narration/command-result.mjs';
import { emitCommandResult } from '../narration/emit.mjs';
import { optionBoolean, optionString } from '../util.mjs';

export async function decisionWitnessExceptionCommand(positionals, options) {
  const binding=createGitEngine({root:repoRoot(),decisionRecordInteraction:{prepare:()=>({
    phaseId:optionString(options,'phase')??null,mappingSha256:optionString(options,'mapping')??null,
    expires:optionString(options,'expires')??null,reason:optionString(options,'reason')??''
  })}});
  const receipt=await binding.engine.run('decision.witness-exception',{
    workId:positionals[2]??optionString(options,'work-id')??null,fetch:optionBoolean(options,'fetch')});
  const {workflow}=binding.presentation(),id=receipt.subject.id,record=receipt.record,phaseId=receipt.phase;
  const publication={sha:receipt.revision,pushed:receipt.effects.pushed};
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded ${record.id}: ${phaseId}'s witness exception for ${record.clauseId} now expires ${record.expiresAt.slice(0, 10)}, decided through ${record.authorityGroup}.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.witness-exception', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.witness-exception.succeeded', { record: record.id }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
