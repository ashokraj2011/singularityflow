/**
 * `rules [--offline] [--json]`: the team's rules for tasks in plain when and then, the built-in ones, those waiting for review,
 * the ID prefix and how a task is composed; and `rules preview --change-set <FILE|-> [--json]`: what a change to them does to
 * each kind of task [FPL:REQ-019 to REQ-026]. Both read only: a rule changes through Workflow Studio's reviewed path
 * (`workflow studio apply --change-set - --propose`, the `tasks.*` operations), never here.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { commandLineFile, optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

// `timings` and `no-model` are every command's (cli-entry.mjs reads them).
const LIST_OPTIONS = new Set(['offline', 'json', 'help', 'timings', 'no-model']);
const PREVIEW_OPTIONS = new Set(['change-set', 'json', 'help', 'timings', 'no-model']);

export const RULES_USAGE = [
  'Usage: singularity-flow rules [--offline] [--json]',
  'Usage: singularity-flow rules preview --change-set <FILE|-> [--json]',
  'The team\'s rules for tasks, from the approved configuration: the built-in ones, every tasks: rule as when and then',
  'with its because, the ones waiting for review, the ID prefix and how SFlow composes each kind of task. --offline reads',
  'no proposals. `preview` reads a Studio change set of tasks.* operations and says what it would add to each kind of',
  'task, and every problem with where it is; nothing is written. A rule changes in VS Code (Rules), or as a proposed',
  'change to singularity/workflow.yml.'
].join('\n');

function refuse(message, code) {
  throw new SingularityFlowError(message, { code, details: { nextAction: { command: 'singularity-flow rules --help', label: 'See how rules is used' } } });
}

async function repositoryRoot() {
  const { repoRoot } = await import('../git.mjs');
  try { return repoRoot(); } catch {
    throw new SingularityFlowError('Run this inside the repository whose rules you want to read.', { code: 'RULES_REPOSITORY_UNKNOWN',
      details: { nextAction: { command: 'singularity-flow workspace list', label: 'See the workspaces and their repositories, then open one.' } } });
  }
}

export async function run(argv, { positionals = argv, options = {} } = {}) {
  const preview = positionals[1] === 'preview';
  if (options.help === true) return console.log(RULES_USAGE);
  const allowed = preview ? PREVIEW_OPTIONS : LIST_OPTIONS;
  for (const key of Object.keys(options)) if (!allowed.has(key)) refuse(`rules${preview ? ' preview' : ''} has no --${key} option.`, 'RULES_OPTIONS_INVALID');
  if (positionals.length > 2 || (positionals.length === 2 && !preview)) refuse(`rules takes no ${positionals.at(-1)}: run singularity-flow rules, or rules preview --change-set <FILE>.`, 'RULES_OPTIONS_INVALID');
  const json = optionBoolean(options, 'json');
  const root = await repositoryRoot();
  const rules = await import('../task-rules.mjs');
  if (!preview) {
    const result = await rules.rulesRead(root, { offline: optionBoolean(options, 'offline') });
    if (json) return console.log(JSON.stringify(result, null, 2));
    return process.stdout.write(rules.rulesText(result));
  }
  const source = optionString(options, 'change-set');
  if (!source) refuse('Name the change: singularity-flow rules preview --change-set <FILE>, or --change-set - with it on stdin.', 'RULES_CHANGE_SET_REQUIRED');
  let changeSet;
  try {
    const text = source === '-' ? await (await import('../read-stdin.mjs')).readStdinText() : await readFile(commandLineFile(root, source, { reads: true }), 'utf8');
    changeSet = JSON.parse(text);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    refuse(`The change set could not be read as JSON: ${String(error?.message ?? error).split('\n')[0]}`, 'RULES_CHANGE_SET_INVALID');
  }
  const [{ withApprovedConfigurationRead, INSPECTION_READ }, { loadDefinition, WORKFLOW_PATH }, { configurationReadRoot }] = await Promise.all([
    import('../approved-configuration-reader.mjs'), import('../config.mjs'), import('../configuration-read-scope.mjs')]);
  // The configuration a proposal would be made on: the approved one as this clone last read it, once, in memory, with no
  // fetch, so a preview makes no network call [FPL:REQ-021]; the proposal itself is made on the newest.
  const { definition, text } = await withApprovedConfigurationRead(root, async () => ({
    definition: await loadDefinition(root), text: await readFile(path.join(configurationReadRoot(root), WORKFLOW_PATH), 'utf8') }),
  { preferAuthority: true, ...INSPECTION_READ, refreshAuthority: false });
  const result = await rules.previewRuleChanges(definition, text, changeSet);
  if (json) return console.log(JSON.stringify(result, null, 2));
  process.stdout.write(rules.rulesPreviewText(result));
  if (!result.valid) process.exitCode = 1;
}
