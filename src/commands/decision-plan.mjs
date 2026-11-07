/** CLI plan amendments and correction routing. Registry operations own admission and effects. */
import {repoRoot} from '../git.mjs';
import {optionBoolean,optionString,optionStrings,SingularityFlowError} from '../util.mjs';
import {createGitEngine} from '../engine-compatibility/git-publication.mjs';
import {planCorrectionRequested,runPlanCorrection} from './plan-correction.mjs';
import {commandResult,effects,succeeded} from '../narration/command-result.mjs';
import {emitCommandResult} from '../narration/emit.mjs';

function amendmentRequest(options) {
  const split = (entry, flag) => {
    const separator = String(entry).indexOf('=');
    if (separator < 1) throw new SingularityFlowError(`${flag} must be <left>=<right>; got '${entry}'.`, { code: 'PLAN_AMENDMENT_INVALID' });
    return [String(entry).slice(0, separator).trim(), String(entry).slice(separator + 1).trim()];
  };
  const reasons = optionStrings(options, 'supporting-reason');
  let next = 0;
  const changes = [
    ...optionStrings(options, 'add-location').map((entry) => { const [clauseId, file] = split(entry, '--add-location'); return { kind: 'add-location', clauseId, path: file }; }),
    ...optionStrings(options, 'add-supporting').map((entry) => { const [file, kind] = split(entry, '--add-supporting'); return { kind: 'add-supporting', path: file, class: kind, reason: reasons[next++] ?? null }; })
  ];
  return {changes,reason:optionString(options,'reason')??''};
}

export async function decisionPlanCommand(positionals,options) {
  const root=repoRoot(),workId=positionals[2]??optionString(options,'work-id')??null;
  if(planCorrectionRequested(options))return runPlanCorrection({root,workId,options});
  const binding=createGitEngine({root,decisionRecordInteraction:{prepare:()=>amendmentRequest(options)}});
  const receipt=await binding.engine.run('decision.plan',{workId,fetch:optionBoolean(options,'fetch')});
  const {workflow}=binding.presentation(),id=receipt.subject.id,amendment=receipt.record;
  const publication={sha:receipt.revision,pushed:receipt.effects.pushed};
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded plan amendment ${amendment.id} for ${id} through ${amendment.authorityGroup}.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.plan', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.plan.succeeded', { amendment: amendment.id, changes: String(amendment.changes.length) }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, amendment }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
