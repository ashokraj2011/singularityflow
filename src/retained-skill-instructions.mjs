/** Optional procedures expand only from the verified Story closure, never a current URL/library. */
import { nextPhaseGeneration } from './phase-generation.mjs';
import { parseLibrarySkill, recordedStoryValues, skillAppliesToStory } from './skill-library.mjs';
import { SingularityFlowError } from './util.mjs';
import { composeSkillInstructions } from './skill-instruction-composition.mjs';

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

/** The retained procedure `skillId` composes to for `phase`, as `skill show` returns it (skill.composedText), or null. */
export function retainedProcedure(phase, context, skillId) {
  if (context?.identity?.mode !== 'workflow-snapshot') return null;
  const entries = (context.dependencies ?? []).filter(entry => entry.source === 'library' && entry.id === skillId
    && matches(phase?.id, entry.phases) && entry.inclusion === 'included' && entry.text);
  if (!entries.length) return null;
  const skill = parseLibrarySkill(entries[0].text, { id: entries[0].id });
  const composition = composeSkillInstructions([{ ...skill, referencedInstructions: entries[0].referencedInstructions ?? [] }]);
  return { id: skill.id, label: skill.label, sha256: skill.sha256,
    text: [composition.bodies.get(skill.id), composition.tail].filter(Boolean).join('\n\n') };
}

/**
 * Each retained procedure `ids` names, written as a file in the checkout's output folder (.sflow/out/procedures/) from
 * the same verified Story closure `skill show` reads, when the step's prompt is composed. A file tool reads it on every
 * host; the shell command stays a second way. On test-sflow (2026-11-23) a VS Code agent's `skill show` was refused for
 * how it was typed, the read gateway has no such read, and the agent, told a refusal means unavailable, stopped before
 * drafting. Returns id -> { path, ranges }; a procedure not written is simply absent.
 */
export async function writeRetainedProcedures(root, phase, context, ids) {
  const files = new Map();
  try {
    const [{ mkdir, writeFile }, path, { agentOutputDirectory, AGENT_OUTPUT_FOLDER, lineRanges }] = await Promise.all([
      import('node:fs/promises'), import('node:path'), import('./agent-output-folder.mjs')]);
    const directory = path.join(await agentOutputDirectory(root), 'procedures');
    await mkdir(directory, { recursive: true });
    for (const id of ids) {
      const procedure = retainedProcedure(phase, context, id);
      if (!procedure) continue;
      const name = `${id}-${digest(procedure.sha256).slice(0, 12)}.md`;
      const text = `<!-- retained procedure: ${procedure.id} sha256=${digest(procedure.sha256)} -->\n\n# ${procedure.label ?? procedure.id}\n\n${procedure.text.trim()}\n`;
      await writeFile(path.join(directory, name), text);
      files.set(id, { path: `${AGENT_OUTPUT_FOLDER}/procedures/${name}`, ranges: lineRanges(text) });
    }
  } catch { /* the retrieval command stays the way to it */ }
  return files;
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
  const composition = composeSkillInstructions([{ ...skill, referencedInstructions: entries[0].referencedInstructions ?? [] }]);
  return {
    schemaVersion: 1, resultType: 'retained-skill-instructions', status: 'ready',
    workId: request.workId, phase: phase.id, generation: request.generation, agent: context.agentId,
    snapshotSha256: context.identity.snapshotHash, skill: {
      id: skill.id, label: skill.label, sha256: skill.sha256, description: skill.description,
      loading: skill.loading, instructions: skill.instructions,
      composedText: [composition.bodies.get(skill.id), composition.tail].filter(Boolean).join('\n\n'),
      instructionRefs: skill.instructionRefs,
      referencedInstructions: entries[0].referencedInstructions ?? [],
      referencedInstructionText: composition.tail,
      attachments: entries.map(entry => ({ scope: entry.scope ?? 'agent',
        phases: entry.phases, use: entry.use ?? '' }))
    },
    effects: { filesChanged: false, testsRun: false, storyAdvanced: false },
    authority: 'verified-story-snapshot', providerUsage: 'not-observed'
  };
}

/**
 * Every on-demand skill retained for this phase and agent, composed in full, for a run that cannot
 * fetch one. Auto may not run Singularity Flow commands, so the `skill show` command the catalog
 * names is unreachable there and an on-demand procedure silently never applied. The bytes come from
 * the same verified Story closure `skill show` reads. Empty when there are none, so a prompt without
 * on-demand skills is unchanged.
 */
export function expandedOnDemandSkills(phase, context, workflow = null) {
  if (context?.identity?.mode !== 'workflow-snapshot') return '';
  const skills = [];
  const values = recordedStoryValues(workflow); // as agents.mjs renderAgentSkills chooses
  for (const entry of context.dependencies ?? []) {
    if (entry.source !== 'library' || entry.inclusion !== 'included' || !entry.text || !matches(phase.id, entry.phases)) continue;
    if (!skillAppliesToStory(entry.use, values)) continue;
    const skill = parseLibrarySkill(entry.text, { id: entry.id });
    if (skill.loading !== 'on-demand' || skills.some(known => known.id === skill.id)) continue;
    skills.push({ ...skill, use: entry.use ?? '', referencedInstructions: entry.referencedInstructions ?? [] });
  }
  if (!skills.length) return '';
  const composition = composeSkillInstructions(skills);
  return ['# On-demand skills, expanded for this run', '',
    'This run cannot fetch on-demand skills with `singularity-flow skill show`, so the retained bytes of each one the skill catalog above lists are given here. Apply each only under its own "When to use it" condition.', '',
    ...skills.flatMap(skill => [`<!-- skill: ${skill.id} sha256=${digest(skill.sha256)} -->`, '',
      `## Skill: ${skill.label} (\`${skill.id}\`)`, '', ...(skill.use ? [`When to use it: ${skill.use}`, ''] : []),
      composition.bodies.get(skill.id).trim(), '']),
    composition.tail].filter(line => line != null).join('\n').trimEnd();
}
