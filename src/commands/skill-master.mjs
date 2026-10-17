/**
 * The skill master from the command line: list, show, create, edit, attach, detach and remove the
 * named skills any agent can use. Each change is a Workflow Studio change set, checked the same
 * way and applied through the repository's configuration authority: a reviewed proposal with
 * `--propose`, a local edit where local authoring is allowed, or only a preview with `--dry-run`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError } from '../util.mjs';
import { SKILL_MASTER_READS, validateSkillMasterRequest, skillMasterOptionText as text } from './skill-request.mjs';
export { validateSkillMasterRequest } from './skill-request.mjs';
const fail = (message, code) => { throw new SingularityFlowError(message, { code }); };

async function instructionsFrom(options) {
  const inline = text(options, 'instructions');
  const file = text(options, 'from');
  if (inline != null && file != null) fail('Give the instructions with --instructions or --from, not both.', 'SKILL_MASTER_OPTION_INVALID');
  return file != null ? readFile(path.resolve(file), 'utf8') : inline;
}

async function changeFor(action, id, options) {
  if (action === 'create') {
    const instructions = await instructionsFrom(options);
    if (!text(options, 'description')) fail('skill create needs --description "<what it does and when to use it>".', 'SKILL_MASTER_OPTION_INVALID');
    if (!instructions?.trim()) fail('skill create needs its instructions: --from <FILE> or --instructions "<TEXT>".', 'SKILL_MASTER_OPTION_INVALID');
    return { op: 'skill.create', id, label: text(options, 'label'), description: text(options, 'description'), instructions, loading: text(options, 'loading'),
      instructionRefs: text(options, 'instruction-refs')?.split(',').map(id => id.trim()).filter(Boolean) };
  }
  if (action === 'edit') {
    const change = { op: 'skill.update', id };
    for (const key of ['label', 'description', 'loading']) if (text(options, key) != null) change[key] = text(options, key);
    const instructions = await instructionsFrom(options);
    if (instructions != null) change.instructions = instructions;
    if (text(options, 'instruction-refs') != null) change.instructionRefs = options['instruction-refs'].split(',').map(id => id.trim()).filter(Boolean);
    if (Object.keys(change).length === 2) fail('Say what to change: --label, --description, --instructions, --from, --loading or --instruction-refs.', 'SKILL_MASTER_OPTION_INVALID');
    return change;
  }
  if (action === 'attach') {
    const phases = (text(options, 'phases') ?? '').split(',').map((phase) => phase.trim()).filter(Boolean);
    return { op: 'skill.attach', skill: id, ...(text(options, 'workflow') ? { workflow: text(options, 'workflow') } : { agent: text(options, 'agent') }), phases, use: text(options, 'use') ?? '' };
  }
  if (action === 'detach') return { op: 'skill.detach', skill: id, ...(text(options, 'workflow') ? { workflow: text(options, 'workflow') } : { agent: text(options, 'agent') }) };
  return { op: 'skill.remove', id };
}

function printSkills(model) {
  const labels = new Map(model.agents.map((agent) => [agent.id, agent.label]));
  if (!model.skills.length) {
    console.log('The skill master has no skills yet. Create one with:');
    console.log('  singularity-flow skill create <ID> --description "<what it does and when to use it>" --from <FILE>');
  }
  for (const skill of model.skills) {
    console.log(`${skill.label} (${skill.id}): ${skill.description}`);
    console.log(`  Used by: ${skill.usedBy.length ? skill.usedBy.map((use) => `${use.workflow ? `workflow ${use.workflow}` : labels.get(use.agent) ?? use.agent}${use.phases.length ? ` in ${use.phases.join(', ')}` : ''}`).join('; ') : 'no attachment yet'}`);
  }
  for (const problem of model.skillProblems ?? []) console.log(`Problem: ${problem.message}`);
}

function printSkill(model, skill) {
  const labels = new Map(model.agents.map((agent) => [agent.id, agent.label]));
  console.log(`${skill.label} (${skill.id}) · ${skill.path}`);
  console.log(skill.description);
  if (skill.instructionRefs?.length) console.log(`Reusable instructions: ${skill.instructionRefs.join(', ')}`);
  console.log('');
  console.log(skill.instructions);
  console.log('');
  if (!skill.usedBy.length) console.log('No attachment yet. Use: singularity-flow skill attach ' + skill.id + ' (--agent <AGENT> | --workflow <WORKFLOW>) [--phases a,b] [--use "<when>"]');
  for (const use of skill.usedBy) {
    console.log(`Used by ${use.workflow ? `workflow ${use.workflow}` : labels.get(use.agent) ?? use.agent} ${use.phases.length ? `in ${use.phases.join(', ')}` : use.workflow ? 'in every workflow step' : 'in every step it drafts'}${use.use ? `: ${use.use}` : ''}`
      + (use.origin === 'attachments' ? ` (kept in ${model.skillAttachmentsPath})` : ''));
  }
}

/**
 * `applyChangeSet(root, changeSet, { subject, message })` applies or previews a Studio change set
 * through the CLI's configuration authority, and `printResult(result, { dryRun })` reports it.
 */
export async function runSkillMaster({ positionals, options, applyChangeSet, printResult }) {
  const action = validateSkillMasterRequest({ positionals, options });
  const [{ repoRoot }, { withApprovedConfigurationRead }] = await Promise.all([
    import('../git.mjs'), import('../approved-configuration-reader.mjs')
  ]);
  const root = repoRoot();
  const json = options.json === true;
  if (action === 'show' && options['work-id'] !== undefined) {
    const [{ loadAcceptedStoryExecution }, { resolveStoryExecutionContext },
      { selectRetainedSkillInstructions }] = await Promise.all([
      import('../accepted-story-execution.mjs'), import('../story-execution-context.mjs'),
      import('../retained-skill-instructions.mjs')
    ]);
    const accepted = await loadAcceptedStoryExecution(root, options['work-id']);
    const context = await resolveStoryExecutionContext(root, accepted.definition, accepted.workflow, {
      agentId: options.agent, phaseId: options.phase, executionCatalog: accepted.executionCatalog
    });
    const result = selectRetainedSkillInstructions(accepted.workflow,
      accepted.workflow.phases?.[options.phase], context, {
        skillId: positionals[2], workId: options['work-id'], phaseId: options.phase, agentId: options.agent,
        generation: Number(options.generation), snapshotSha256: options['snapshot-sha256'],
        expectedSha256: options['expected-sha256']
      });
    return console.log(json ? JSON.stringify(result, null, 2) : result.skill.composedText);
  }
  if (SKILL_MASTER_READS.includes(action)) {
    const { readAssetCatalog } = await import('../asset-catalog.mjs');
    const model = await withApprovedConfigurationRead(root, () => readAssetCatalog(root), { preferAuthority: true });
    if (action === 'list') {
      const notice = await import('../configuration-drafts.mjs').then(({ draftNotice }) => draftNotice(root, 'skill'));
      if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'skill-master', skills: model.skills, problems: model.skillProblems ?? [], drafts: notice.entries }, null, 2));
      printSkills(model);
      for (const line of notice.lines) console.log(line);
      return;
    }
    const skill = model.skills.find((entry) => entry.id === positionals[2]);
    if (!skill) fail(`There is no skill '${positionals[2]}' in the skill master. List them with: singularity-flow skill list`, 'SKILL_MASTER_UNKNOWN');
    const { composeSkillInstructions } = await import('../skill-instruction-composition.mjs');
    const selected = { ...skill, referencedInstructions: skill.instructionRefs.map(id => {
      const item = model.instructions.find(entry => entry.id === id);
      if (!item) fail(`Skill '${skill.id}' references missing instruction '${id}'.`, 'INSTRUCTION_REFERENCE_MISSING');
      return item;
    }) };
    const composition = composeSkillInstructions([selected]);
    skill.composedText = [composition.bodies.get(skill.id), composition.tail].filter(Boolean).join('\n\n');
    if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'skill-master-skill', skill }, null, 2));
    return printSkill(model, { ...skill, instructions: skill.composedText });
  }
  const id = positionals[2];
  const { STUDIO_CHANGE_SET_SCHEMA } = await import('../workflow-studio.mjs');
  const changeSet = { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [await changeFor(action, id, options)] };
  const result = await applyChangeSet(root, changeSet, { subject: id, message: `[configuration] skill ${action}: ${id}` });
  if (json) return console.log(JSON.stringify(result, null, 2));
  return printResult(result, { dryRun: options['dry-run'] === true });
}
