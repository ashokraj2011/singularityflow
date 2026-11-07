/** Binding-first native entry; the registered SDK operation owns coordination and admission. */
export {phaseEntryContext} from './phase-entry-context.mjs';

export async function enterPhase({cwd=process.cwd(),phaseId=null,workId=null,compose=false,modelEnabled=true}={}) {
  const {createGitPhaseEntryEngine}=await import('./engine-compatibility/git-phase-entry.mjs');
  const binding=createGitPhaseEntryEngine({cwd,modelEnabled});
  await binding.engine.run('phase.enter',{phaseId,workId,compose});
  return binding.presentation().result;
}
