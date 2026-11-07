/** Compatibility signature: every entry still executes the registered SDK operation. */
export async function completePhaseEntry(entry,_base,{compose=false,modelEnabled=true}={}) {
  const {createGitPhaseEntryEngine}=await import('./engine-compatibility/git-phase-entry.mjs');
  const binding=createGitPhaseEntryEngine({root:entry.root,modelEnabled});
  await binding.engine.run('phase.enter',{workId:entry.workflow.workItem.id,phaseId:entry.phase.id,compose});
  return binding.presentation().result;
}
