/** Shared projections for Workflow Studio and narrow CLI catalog readers. */
import { effectiveLibrarySkills } from './skill-library.mjs';

export function skillUses(agent) {
  const own = new Set((agent.librarySkills ?? []).map(entry => entry.id));
  return effectiveLibrarySkills(agent).map(entry => ({
    id: entry.id, phases: [...entry.phases], use: entry.use, origin: own.has(entry.id) ? 'agent' : 'attachments'
  }));
}

export function projectSkills(library, discovered, workflowAttachments) {
  return [...library.skills.values()].map(skill => ({
    id: skill.id, label: skill.label, description: skill.description, instructions: skill.instructions,
    loading: skill.loading, path: skill.path, instructionRefs: [...skill.instructionRefs],
    usedBy: discovered.flatMap(agent => skillUses(agent).filter(entry => entry.id === skill.id)
      .map(entry => ({ agent: agent.id, phases: entry.phases, use: entry.use, origin: entry.origin })))
      .concat(workflowAttachments.filter(entry => entry.id === skill.id)
        .map(entry => ({ workflow: entry.workflow, phases: [...entry.phases], use: entry.use, origin: 'attachments' })))
  }));
}

export function projectInstructions(library, instructionLibrary) {
  return [...instructionLibrary.instructions.values()].map(item => ({
    id: item.id, label: item.label, description: item.description, instructions: item.instructions,
    path: item.path, sha256: item.sha256,
    usedBy: [...library.skills.values()].filter(skill => skill.instructionRefs.includes(item.id)).map(skill => skill.id)
  }));
}
