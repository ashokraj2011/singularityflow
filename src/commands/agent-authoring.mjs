/**
 * `agents create | edit`: a governed agent from the command line, through the same Workflow Studio
 * change set as every other configuration change, so it is checked the same way and is saved as a
 * draft, previewed with `--dry-run`, or proposed with `--propose`.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { nearestNames, SingularityFlowError } from '../util.mjs';

export const AGENT_AUTHORING_SUBCOMMANDS = Object.freeze(['create', 'edit']);
const ROLES = Object.freeze(['analyst', 'product-owner', 'architect', 'developer', 'tester', 'designer', 'reviewer', 'blank']);
const AUTHORING = ['json', 'dry-run', 'propose', 'background-sync'];
const OPTIONS = Object.freeze({
  create: [...AUTHORING, 'label', 'description', 'role', 'from-agent', 'tools', 'instructions', 'from'],
  edit: [...AUTHORING, 'label', 'description', 'tools', 'instructions', 'from']
});
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function fail(message, code = 'AGENT_AUTHORING_INVALID') { throw new SingularityFlowError(message, { code }); }

function text(options, key) {
  const value = options[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`--${key} takes a value.`);
  return value;
}

export function validateAgentAuthoringRequest({ positionals, options }) {
  const action = positionals[1];
  if (positionals.length !== 3 || !ID.test(positionals[2] ?? '')) fail(`agents ${action} takes one agent ID in lower-case kebab-case, for example qa-reviewer.`);
  for (const key of Object.keys(options)) {
    if (!OPTIONS[action].includes(key)) {
      const near = nearestNames(key, OPTIONS[action], { limit: 1 });
      fail(`agents ${action} does not take --${key}.${near.length ? ` Did you mean --${near[0]}?` : ''}`, 'AGENT_AUTHORING_OPTION_UNSUPPORTED');
    }
  }
  for (const key of ['json', 'dry-run', 'propose', 'background-sync']) if (options[key] !== undefined && options[key] !== true) fail(`--${key} does not take a value.`);
  if (options.role !== undefined && !ROLES.includes(text(options, 'role'))) fail(`--role must be one of: ${ROLES.join(', ')}.`);
  if (options.instructions !== undefined && options.from !== undefined) fail('Give the instructions with --instructions or --from <FILE>, not both.');
  return action;
}

const list = (value) => value?.split(',').map((entry) => entry.trim()).filter(Boolean);

async function changeFor(action, id, options) {
  const file = text(options, 'from');
  const instructions = file != null ? await readFile(path.resolve(file), 'utf8') : text(options, 'instructions');
  if (action === 'create') {
    if (!text(options, 'label')) fail('agents create needs --label "<the name people see>".');
    if (!text(options, 'description')) fail('agents create needs --description "<what the agent does, in one sentence>".');
    return { op: 'agent.create', id, label: text(options, 'label'), description: text(options, 'description'),
      role: text(options, 'role') ?? 'blank', from: text(options, 'from-agent') ?? null,
      ...(options.tools !== undefined ? { tools: list(text(options, 'tools')) } : {}),
      ...(instructions != null ? { instructions } : {}) };
  }
  const change = { op: 'agent.update', id };
  for (const key of ['label', 'description']) if (text(options, key) != null) change[key] = text(options, key);
  if (options.tools !== undefined) change.tools = list(text(options, 'tools'));
  if (instructions != null) change.instructions = instructions;
  if (Object.keys(change).length === 2) fail('Say what to change: --label, --description, --tools, --instructions or --from <FILE>.');
  return change;
}

export async function run({ positionals, options, applyChangeSet, printResult }) {
  const action = validateAgentAuthoringRequest({ positionals, options });
  const [{ repoRoot }, { STUDIO_CHANGE_SET_SCHEMA }] = await Promise.all([import('../git.mjs'), import('../workflow-studio.mjs')]);
  const id = positionals[2];
  const changeSet = { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [await changeFor(action, id, options)] };
  const result = await applyChangeSet(repoRoot(), changeSet, { subject: id, message: `[configuration] agent ${action}: ${id}` });
  if (options.json === true) return console.log(JSON.stringify(result, null, 2));
  return printResult(result, { dryRun: options['dry-run'] === true });
}
