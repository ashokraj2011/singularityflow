/** Host composition and legacy result projection; the registry owns admission and effects. */
import {repoRoot} from '../../git.mjs';
import {optionBoolean} from '../../util.mjs';
import {createGitEngine} from '../../engine-compatibility/git-publication.mjs';

export async function executeTestDecision(operation,workId,options,prepare) {
  const binding=createGitEngine({root:repoRoot(),decisionRecordInteraction:{prepare}});
  const receipt=await binding.engine.run(operation,{workId,fetch:optionBoolean(options,'fetch')});
  return {receipt,context:binding.presentation(),
    publication:receipt.effects.committed?{sha:receipt.revision,pushed:receipt.effects.pushed}:null};
}
