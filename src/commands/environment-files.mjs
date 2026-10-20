/**
 * `singularity-flow env files …` [ENVF]: where each environment's files are on this machine, model-free
 * and the same for the Shell, VS Code and Copilot. Reads show paths, statuses and locations, never a
 * file's contents; changes write only private machine state, the checkout's placed links and the
 * clone's `.git/info/exclude`.
 */
import path from 'node:path';

import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

export const ENV_FILES_ACTIONS = Object.freeze(['create', 'link', 'unlink', 'adopt', 'add', 'remove', 'path', 'root', 'place', 'suggest']);
const OPTIONS = Object.freeze({
  list: ['repository', 'workspace'], create: ['from-template', 'repository', 'workspace'], link: ['to', 'clear', 'repository', 'workspace'],
  unlink: ['repository', 'workspace'],
  adopt: ['repository', 'workspace'], add: ['personal', 'repository', 'workspace'], remove: ['personal', 'repository', 'workspace'],
  path: ['repository', 'workspace'], root: ['clear'], place: ['capability', 'workspace'], suggest: ['repository']
});
const USAGE = Object.freeze({
  list: 'env files [ENV] [--repository ID | --workspace] [--json]',
  create: 'env files create <ENV> <PATH> [--from-template] [--repository ID | --workspace] [--json]',
  link: 'env files link <ENV> <PATH> --to <FILE> [--repository ID | --workspace] [--json]',
  unlink: 'env files unlink <ENV> <PATH> [--repository ID | --workspace] [--json]',
  adopt: 'env files adopt <ENV> <PATH> [--repository ID | --workspace] [--json]',
  add: 'env files add <ENV> <PATH> --personal [--repository ID | --workspace] [--json]',
  remove: 'env files remove <ENV> <PATH> --personal [--repository ID | --workspace] [--json]',
  path: 'env files path <ENV> <PATH> [--repository ID | --workspace] [--json]',
  root: 'env files root <ENV> <DIR> | --clear [--json]',
  place: 'env files place <ENV> [--capability ID | --workspace] [--json]',
  suggest: 'env files suggest [--repository ID] [--json]'
});

function fail(message, code = 'ENV_FILES_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function checkOptions(action, options) {
  const allowed = new Set([...OPTIONS[action], 'json', 'timings']);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key)).sort();
  if (unknown.length) {
    fail(`${USAGE[action]}: ${unknown.map((key) => `--${key}`).join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not accepted.`, 'ENV_FILES_INVALID',
      { action, unknown, usage: USAGE[action] });
  }
  if (options.workspace !== undefined && options.workspace !== true) {
    fail(`--workspace takes no value; put the environment first, as in: singularity-flow ${USAGE[action]}.`, 'ENV_FILES_INVALID');
  }
  if (optionString(options, 'repository', null) && options.workspace) fail('Name either --repository ID or --workspace, not both.');
}

function words(action, positionals, { minimum, maximum }) {
  const values = positionals.slice(action === 'list' ? 2 : 3);
  if (values.length < minimum || values.length > maximum) fail(`Usage: singularity-flow ${USAGE[action]}`, 'ENV_FILES_INVALID', { usage: USAGE[action] });
  return values;
}

function fileLine(file) {
  const where = file.status === 'missing' ? `missing (expected at ${file.location})` : `${file.status} · ${file.source} · ${file.location}`;
  const notes = [file.kind === 'personal' ? 'personal' : null, file.template ? `template ${file.template}` : null,
    file.excluded ? null : 'not excluded yet', file.placedFor && file.placedFor !== file.environment && file.status !== 'placed-here' ? `placed for ${file.placedFor}` : null,
    file.problem].filter(Boolean);
  return `${file.path}: ${where}${notes.length ? ` (${notes.join(', ')})` : ''}`;
}

function listText(result) {
  const lines = [];
  for (const repository of result.repositories) {
    lines.push(`${repository.id ? `Repository ${repository.id}` : 'This repository'} (${repository.checkout}) · declaration ${repository.declaration}`);
    if (!repository.apps.length) lines.push('  No environment files: declare exact paths in localFiles (singularity-flow env files suggest) or add your own with env files add <ENV> <PATH> --personal.');
    for (const app of repository.apps) {
      lines.push(`  ${app.id ? `App ${app.id}${app.sourceRoots.length ? ` (${app.sourceRoots.join(', ')})` : ''}` : 'Repository files'}`);
      for (const environment of app.environments) {
        lines.push(`    ${environment.name}`);
        for (const file of environment.files) lines.push(`      ${fileLine({ ...file, environment: environment.name })}`);
      }
    }
  }
  if (result.workspace?.files) {
    lines.push(`Workspace ${result.workspace.id} (${result.workspace.path})`);
    for (const file of result.workspace.files) lines.push(`  ${file.environment}: ${fileLine(file)}`);
    for (const [environment, folder] of Object.entries(result.workspace.roots ?? {})) lines.push(`  Folder for ${environment}: ${folder}`);
  }
  const missing = result.repositories.flatMap((repository) => repository.apps.flatMap((app) => app.environments.flatMap((environment) => environment.files
    .filter((file) => file.status === 'missing').map((file) => ({ environment: environment.name, file })))));
  if (missing.length) {
    const { environment, file } = missing[0];
    lines.push(`Create a missing file with singularity-flow env files create ${environment} ${file.path}${file.template ? ' --from-template' : ''}, or use one you have with env files link ${environment} ${file.path} --to <FILE>.`);
  }
  return lines.join('\n');
}

function changeText(result) {
  const lines = [];
  const subject = `${result.path} (${result.environment})`;
  if (result.resultType === 'sflow-env-file-created') {
    lines.push(`Created ${subject}${result.fromTemplate ? ` from ${result.fromTemplate}` : ''}. Open it to fill in the values: ${result.location}`);
  } else if (result.resultType === 'sflow-env-file-linked') lines.push(`${subject} now uses ${result.location}.`);
  else if (result.resultType === 'sflow-env-file-unlinked') lines.push(`${subject} no longer uses ${result.previous ?? 'a linked file'}; it resolves to ${result.location}${result.exists ? '' : ' (missing)'}.`);
  else if (result.resultType === 'sflow-env-file-adopted') lines.push(`Moved ${subject} into the private store at ${result.location} and linked it back.`);
  else if (result.resultType === 'sflow-env-file-added') {
    lines.push(`${result.added ? 'Added' : 'Already recorded:'} personal file ${subject}; it is excluded locally and refused by this machine's gates.`);
    for (const command of result.next ?? []) lines.push(`  ${command}`);
  } else if (result.resultType === 'sflow-env-file-removed') {
    lines.push(`Removed personal file ${subject}.${result.removedLink ? ' Its link here was removed.' : ''}${result.kept ? ` The real file was kept at ${result.kept}.` : ''}`);
  }
  if (result.placement?.placed.length) lines.push(`Placed: ${result.placement.placed.join(', ')}`);
  for (const note of result.placement?.notes ?? []) lines.push(note);
  return lines.join('\n');
}

function placedText(result) {
  const lines = [];
  for (const entry of [...result.repositories, ...(result.workspace ? [{ ...result.workspace, workspace: true }] : [])]) {
    const label = entry.workspace ? `Workspace ${entry.id}` : entry.id ? `Repository ${entry.id}` : 'This repository';
    if (!entry.files.length) { lines.push(`${label}: no '${result.environment}' environment file.`); continue; }
    lines.push(`${label}: ${entry.placed.length} placed, ${entry.unchanged.length} already in place, ${entry.unmanaged.length} unmanaged.`);
    for (const note of entry.notes) lines.push(`  ${note}`);
  }
  return lines.join('\n');
}

function emit(result, json, text) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(text(result));
  return result;
}

export async function run(_argv, { positionals, options = {} }) {
  const action = ENV_FILES_ACTIONS.includes(positionals[2]) ? positionals[2] : 'list';
  checkOptions(action, options);
  const json = optionBoolean(options, 'json');
  const { repoRoot } = await import('../git.mjs');
  const root = repoRoot(process.cwd());
  const engine = await import('../environment-files.mjs');
  const repository = optionString(options, 'repository', null);
  const workspace = options.workspace === true;

  if (action === 'list') {
    const [environment = null] = words(action, positionals, { minimum: 0, maximum: 1 });
    return emit(await engine.environmentFilesReport(root, { environment, repository, workspace }), json, listText);
  }
  if (action === 'suggest') {
    words(action, positionals, { minimum: 0, maximum: 0 });
    const scope = await engine.commandScope(root, { repository });
    const { suggestEnvironmentFiles, suggestionText } = await import('../environment-files-suggest.mjs');
    return emit(await suggestEnvironmentFiles(scope), json, suggestionText);
  }
  if (action === 'root') {
    const values = words(action, positionals, { minimum: 1, maximum: 2 });
    const clear = optionBoolean(options, 'clear');
    if (clear === (values.length === 2)) fail(`Usage: singularity-flow ${USAGE.root}`);
    const result = await engine.setEnvironmentRoot(root, engine.environmentArgument(values[0]), values[1] ?? null, { clear });
    return emit(result, json, (value) => (value.cleared ? `Cleared the folder for '${value.environment}' in workspace ${value.workspace.id}.`
      : `Workspace ${value.workspace.id} keeps '${value.environment}' files in ${value.root}: ${value.layout.repository} (workspace-level files in ${value.layout.workspace}).`));
  }
  if (action === 'place') {
    const [environment] = words(action, positionals, { minimum: 1, maximum: 1 });
    if (optionString(options, 'capability', null) && workspace) fail('Name either --capability ID or --workspace, not both.');
    return emit(await engine.placeForCommand(root, engine.environmentArgument(environment), {
      capability: optionString(options, 'capability', null), workspace }), json, placedText);
  }

  const [environmentWord, pathWord] = words(action, positionals, { minimum: 2, maximum: 2 });
  const environment = engine.environmentArgument(environmentWord);
  const relative = engine.filePathArgument(pathWord);
  if (['add', 'remove'].includes(action) && !optionBoolean(options, 'personal')) {
    fail(`env files ${action} changes personal files only: add --personal. A file for the whole team is declared in singularity/environments.yml localFiles through a configuration proposal (env files suggest drafts it).`,
      'ENV_FILES_PERSONAL_REQUIRED');
  }
  const scope = await engine.commandScope(root, { repository, workspace });
  if (action === 'path') {
    return emit(await engine.environmentFilePath(scope, environment, relative), json,
      (value) => `${value.location}${value.exists ? '' : ` (missing: singularity-flow env files create ${environment} ${relative})`}`);
  }
  if (action === 'create') {
    return emit(await engine.createEnvironmentFile(scope, environment, relative, { fromTemplate: optionBoolean(options, 'from-template') }), json, changeText);
  }
  if (action === 'link') {
    const clear = optionBoolean(options, 'clear');
    const to = optionString(options, 'to', null);
    if (clear === Boolean(to)) fail(`Usage: singularity-flow ${USAGE.link}, or singularity-flow ${USAGE.unlink}`);
    return emit(await engine.linkEnvironmentFile(scope, environment, relative, { to: to ? path.resolve(process.cwd(), to) : null, clear }), json, changeText);
  }
  // `link --clear` stays an alias of unlink.
  if (action === 'unlink') return emit(await engine.unlinkEnvironmentFile(scope, environment, relative), json, changeText);
  if (action === 'adopt') return emit(await engine.adoptEnvironmentFile(scope, environment, relative), json, changeText);
  if (action === 'add') return emit(await engine.addPersonalEnvironmentFile(scope, environment, relative), json, changeText);
  return emit(await engine.removePersonalEnvironmentFile(scope, environment, relative), json, changeText);
}
