import {namespaceEngineFixture} from './namespace-engine-fixture.mjs';
import {generateConstitution} from '../../src/constitution.mjs';
export const constitutionMarkdown='---\narticles:\n  - id: ART-001\n    type: enforced\n    policy: phases.intake.approval.minimum\n  - id: ART-002\n    type: judged\n    level: must\n    evidenceRequired: true\n---\n# Team rules\n\n## [ART-001] Independent review\nUse the pinned approval threshold.\n\n## [ART-002] Reversible work\nDocument how to reverse this change.\n';
export async function namespaceConstitutionFixture(t,backend='filesystem',{mode='enforce',markdown=undefined}={}){
  const f=await namespaceEngineFixture(t,{backend,configure(source){source.definition.workTypes.simple.constitution={mode,path:'singularity/constitution.md'};}});
  const text=markdown===undefined?generateConstitution(constitutionMarkdown,{phases:[{id:'intake',approval:{minimum:1}}]}).markdown:markdown;
  if(text!==null)f.source.files.push({path:'singularity/constitution.md',body:await f.putText(text)});
  f.control.permissions.push('phase.prepublish');return f;
}
export async function authorConstitutionDraft(f,{citation='ART-002',operationId='author-constitution-proof'}={}){
  f.asAuthor();await f.engine.run('phase.prepare',{phaseId:'intake'});
  const draft=await f.engine.run('phase.draft.read',{phaseId:'intake'}),content=(await f.local.content.put(f.scope,'local',Buffer.from(
    '# Actual reviewed result\n\nThe reviewed work is observable and can be reversed using the documented procedure.\n\n## Constitution articles\n'+citation+'\n'))).reference;
  return f.engine.run('phase.draft.write',{operationId,workId:f.workId,phaseId:'intake',expectedRevision:draft.manifest.draft.revision,content,
    reason:'Retain the actual result and its cited approved rule.'});
}
