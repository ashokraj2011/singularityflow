/** Optional procedures expand only from the verified Story closure, never a current URL/library. */
import { nextPhaseGeneration } from './phase-generation.mjs';
import { parseLibrarySkill } from './skill-library.mjs';
import { SingularityFlowError } from './util.mjs';
import { renderReferencedInstructions } from './instruction-library.mjs';

const digest = value => String(value ?? '').replace(/^sha256:/, '');
const matches = (phase, phases) => !phases?.length || phases.includes(phase);

export function retainedSkillExpansion(workflow, phase, context, skill) {
  if (skill.loading !== 'on-demand' || context?.identity?.mode !== 'workflow-snapshot') return null;
  const args = ['skill', 'show', skill.id, '--work-id', workflow.workItem.id, '--phase', phase.id,
    '--agent', context.agentId, '--generation', String(nextPhaseGeneration(phase)),
    '--snapshot-sha256', context.identity.snapshotHash, '--expected-sha256', skill.sha256, '--json'];
  // Values are shell-quoted; the command is identical on the current platform and has no writes.
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `singularity-flow ${args.map(quote).join(' ')}`;
}

/** Pure selector consumes an owner-verified execution context; the CLI verifies that owner first. */
export function selectRetainedSkillInstructions(workflow, phase, context, request) {
  const fail = message => { throw new SingularityFlowError(message, { code: 'SKILL_RETAINED_BINDING_STALE' }); };
  if (context?.identity?.mode !== 'workflow-snapshot'
      || digest(context.identity.snapshotHash) !== digest(request.snapshotSha256)
      || request.workId !== workflow.workItem.id || request.phaseId !== workflow.currentPhase
      || request.phaseId !== phase?.id || request.agentId !== context.agentId
      || request.generation !== nextPhaseGeneration(phase)) fail('The retained skill request no longer matches this Story, phase, generation, agent or snapshot. Re-read the current prompt catalog.');
  const entries = context.dependencies.filter(entry => entry.source === 'library'
    && entry.id === request.skillId && matches(phase.id, entry.phases));
  if (!entries.length || entries.some(entry => entry.inclusion !== 'included' || !entry.text)) fail('This skill is not retained and available in the selected phase scope.');
  const skills = entries.map(entry => parseLibrarySkill(entry.text, { id: entry.id }));
  if (skills.some((skill, index) => digest(skill.sha256) !== digest(request.expectedSha256)
      || digest(entries[index].sha256) !== digest(skill.sha256))) fail('Retained skill bytes do not match the exact catalog digest.');
  const skill = skills[0];
  return {
    schemaVersion: 1, resultType: 'retained-skill-instructions', status: 'ready',
    workId: request.workId, phase: phase.id, generation: request.generation, agent: context.agentId,
    snapshotSha256: context.identity.snapshotHash, skill: {
      id: skill.id, label: skill.label, sha256: skill.sha256, description: skill.description,
      loading: skill.loading, instructions: skill.instructions,
      instructionRefs: skill.instructionRefs,
      referencedInstructions: entries[0].referencedInstructions ?? [],
      referencedInstructionText: renderReferencedInstructions([{ ...skill,
        referencedInstructions: entries[0].referencedInstructions ?? [] }]),
      attachments: entries.map(entry => ({ scope: entry.scope ?? 'agent',
        phases: entry.phases, use: entry.use ?? '' }))
    },
    effects: { filesChanged: false, testsRun: false, storyAdvanced: false },
    authority: 'verified-story-snapshot', providerUsage: 'not-observed'
  };
}
