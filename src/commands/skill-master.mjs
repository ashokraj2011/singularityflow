/**
 * The skill master from the command line: list, show, create, edit, attach, detach and remove the
 * named skills any agent can use. Each change is a Workflow Studio change set, checked the same
 * way and applied through the repository's configuration authority: a reviewed proposal with
 * `--propose`, a local edit where local authoring is allowed, or only a preview with `--dry-run`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SingularityFlowError } from '../util.mjs';
import { SKILL_MASTER_READS } from './skill.mjs';
const AUTHORING = ['json', 'dry-run', 'propose', 'expected-authority-kind', 'expected-authority-commit',
  'expected-authority-remote-fingerprint', 'expected-authority-source-commit'];
const OPTIONS = Object.freeze({
  list: ['json'], show: ['json'],
  create: [...AUTHORING, 'label', 'description', 'instructions', 'from'],
  edit: [...AUTHORING, 'label', 'description', 'instructions', 'from'],
  attach: [...AUTHORING, 'agent', 'phases', 'use'],
  detach: [...AUTHORING, 'agent'],
  remove: AUTHORING
});
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message, code) { throw new SingularityFlowError(message, { code }); }

function text(options, key) {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`--${key} takes a value.`, 'SKILL_MASTER_OPTION_INVALID');
  return value;
}

export function validateSkillMasterRequest({ positionals, options }) {
  const action = positionals[1];
  if (action === 'list') {
    if (positionals.length !== 2) fail('skill list takes no skill ID.', 'SKILL_MASTER_ID_INVALID');
  } else if (positionals.length !== 3 || !ID.test(positionals[2] ?? '')) {
    fail(`skill ${action} takes one skill ID in lower-case kebab-case.`, 'SKILL_MASTER_ID_INVALID');
  }
  for (const key of Object.keys(options)) {
    if (!OPTIONS[action].includes(key)) fail(`skill ${action} does not support '--${key}'.`, 'SKILL_MASTER_OPTION_UNSUPPORTED');
  }
  for (const key of ['json', 'dry-run', 'propose']) {
    if (options[key] !== undefined && options[key] !== true) fail(`--${key} does not take a value.`, 'SKILL_MASTER_OPTION_UNSUPPORTED');
  }
  if (['attach', 'detach'].includes(action) && !text(options, 'agent')) fail(`skill ${action} needs --agent <AGENT>.`, 'SKILL_MASTER_AGENT_REQUIRED');
  return action;
}

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
    return { op: 'skill.create', id, label: text(options, 'label'), description: text(options, 'description'), instructions };
  }
  if (action === 'edit') {
    const change = { op: 'skill.update', id };
    for (const key of ['label', 'description']) if (text(options, key) != null) change[key] = text(options, key);
    const instructions = await instructionsFrom(options);
    if (instructions != null) change.instructions = instructions;
    if (Object.keys(change).length === 2) fail('Say what to change: --label, --description, --instructions or --from.', 'SKILL_MASTER_OPTION_INVALID');
    return change;
  }
  if (action === 'attach') {
    const phases = (text(options, 'phases') ?? '').split(',').map((phase) => phase.trim()).filter(Boolean);
    return { op: 'skill.attach', skill: id, agent: text(options, 'agent'), phases, use: text(options, 'use') ?? '' };
  }
  if (action === 'detach') return { op: 'skill.detach', skill: id, agent: text(options, 'agent') };
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
    console.log(`  Used by: ${skill.usedBy.length ? skill.usedBy.map((use) => `${labels.get(use.agent) ?? use.agent}${use.phases.length ? ` in ${use.phases.join(', ')}` : ''}`).join('; ') : 'no agent yet'}`);
  }
  for (const problem of model.skillProblems ?? []) console.log(`Problem: ${problem.message}`);
}

function printSkill(model, skill) {
  const labels = new Map(model.agents.map((agent) => [agent.id, agent.label]));
  console.log(`${skill.label} (${skill.id}) · ${skill.path}`);
  console.log(skill.description);
  console.log('');
  console.log(skill.instructions);
  console.log('');
  if (!skill.usedBy.length) console.log('No agent uses it yet. Attach it with: singularity-flow skill attach ' + skill.id + ' --agent <AGENT> [--phases a,b] [--use "<when>"]');
  for (const use of skill.usedBy) {
    console.log(`Used by ${labels.get(use.agent) ?? use.agent} ${use.phases.length ? `in ${use.phases.join(', ')}` : 'in every step it drafts'}${use.use ? `: ${use.use}` : ''}`
      + (use.origin === 'attachments' ? ` (kept in ${model.skillAttachmentsPath})` : ''));
  }
}

/**
 * `applyChangeSet(root, changeSet, { subject, message })` applies or previews a Studio change set
 * through the CLI's configuration authority, and `printResult(result, { dryRun })` reports it.
 */
export async function runSkillMaster({ positionals, options, applyChangeSet, printResult }) {
  const action = validateSkillMasterRequest({ positionals, options });
  const [{ repoRoot }, { withApprovedConfigurationRead }, { buildStudioModel, STUDIO_CHANGE_SET_SCHEMA }] = await Promise.all([
    import('../git.mjs'), import('../approved-configuration-reader.mjs'), import('../workflow-studio.mjs')
  ]);
  const root = repoRoot();
  const json = options.json === true;
  if (SKILL_MASTER_READS.includes(action)) {
    const model = await withApprovedConfigurationRead(root, () => buildStudioModel(root), { preferAuthority: true });
    if (action === 'list') {
      if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'skill-master', skills: model.skills, problems: model.skillProblems ?? [] }, null, 2));
      return printSkills(model);
    }
    const skill = model.skills.find((entry) => entry.id === positionals[2]);
    if (!skill) fail(`There is no skill '${positionals[2]}' in the skill master. List them with: singularity-flow skill list`, 'SKILL_MASTER_UNKNOWN');
    if (json) return console.log(JSON.stringify({ schemaVersion: 1, resultType: 'skill-master-skill', skill }, null, 2));
    return printSkill(model, skill);
  }
  const id = positionals[2];
  const changeSet = { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [await changeFor(action, id, options)] };
  const result = await applyChangeSet(root, changeSet, { subject: id, message: `[configuration] skill ${action}: ${id}` });
  if (json) return console.log(JSON.stringify(result, null, 2));
  return printResult(result, { dryRun: options['dry-run'] === true });
}
