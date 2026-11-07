/** Human file-review CLI grammar and projection. The registered operation owns recording. */
import {repoRoot} from '../git.mjs';
import {optionBoolean,optionString,optionStrings,SingularityFlowError} from '../util.mjs';
import {createGitEngine} from '../engine-compatibility/git-publication.mjs';
import {commandResult,effects,succeeded} from '../narration/command-result.mjs';
import {emitCommandResult} from '../narration/emit.mjs';

export async function decisionWitnessCommand(positionals,options) {
  const binding=createGitEngine({root:repoRoot(),decisionRecordInteraction:{prepare:()=>{
    const confirm=optionStrings(options,'confirm'),deny=optionStrings(options,'deny');
    if(confirm.some(item=>deny.includes(item)))throw new SingularityFlowError(
      'A checklist item cannot be both confirmed and denied.',{code:'WITNESS_RECORD_INVALID'});
    return {clauseId:optionString(options,'criterion')??'',slotName:optionString(options,'slot')??'',
      file:optionString(options,'file')??'',reason:optionString(options,'reason')??'',
      expectedContext:optionString(options,'expected-context-sha256')??null,
      expectedFile:optionString(options,'expected-file-sha256')??null,
      answers:{...Object.fromEntries(confirm.map(item=>[item,'yes'])),...Object.fromEntries(deny.map(item=>[item,'no']))}};
  }}});
  const receipt=await binding.engine.run('decision.witness',{
    workId:positionals[2]??optionString(options,'work-id')??null,fetch:optionBoolean(options,'fetch')});
  const {workflow}=binding.presentation(),id=receipt.subject.id,record=receipt.record;
  const publication={sha:receipt.revision,pushed:receipt.effects.pushed};
  if (!optionBoolean(options, 'json')) {
    console.log(`Recorded ${record.id}: the ${record.method} of ${record.file} ${record.outcome === 'met' ? 'witnesses' : 'does not witness'} ${record.clauseId} slot ${record.slot}, bound to its current bytes.`);
    console.log(publication.pushed
      ? `Decision committed ${publication.sha.slice(0, 8)} and pushed.`
      : `Decision committed ${publication.sha.slice(0, 8)} locally; push is disabled by git.publish: off.`);
  }
  emitCommandResult(commandResult({
    operation: { id: 'decision.witness', classification: 'mutation' },
    subject: { kind: 'story', id },
    outcome: succeeded('decision.witness.succeeded', { record: record.id, criterion: record.clauseId }),
    effects: effects({ stateChanged: true, filesChanged: true, publicationCreated: true }),
    data: { commit: publication.sha, pushed: publication.pushed, record }
  }), { json: optionBoolean(options, 'json'), postState: workflow });
}
