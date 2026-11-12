/**
 * `singularity-flow capability projects <GIT-URL> | --path <CHECKOUT> [--branch NAME] [--lead URL] [--json]`: the projects
 * a repository holds (repository-projects.mjs), each proposed as a capability with its exact `capability map`
 * command: its folder as source root, the folders it depends on inside the repository as shared roots, and both
 * as its sparse clone. A read: it maps nothing; the person chooses, and each map is a reviewed proposal.
 */
import path from 'node:path';

import { listLeadRepositories } from '../lead-repositories.mjs';
import { detectRepositoryProjects } from '../repository-projects.mjs';
import { checkoutProjectFiles, remoteProjectFiles } from '../repository-projects-source.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const OPTIONS = new Set(['path', 'branch', 'lead', 'json']);
const USAGE = 'singularity-flow capability projects <GIT-URL> [--branch NAME] [--lead URL] [--json], or capability projects --path <CHECKOUT> [--lead URL] [--json]';

/** The `capability map` argv that proposes `project` as a delivery capability of `repositoryUrl`. */
export function projectMapArgv(project, { lead, repositoryUrl }) {
  const safeName = typeof project.name === 'string' && /^[A-Za-z0-9 ._@/-]{1,80}$/u.test(project.name) && project.name !== project.id;
  return ['capability', 'map', project.id, '--lead', lead ?? '<LEAD-URL>', '--kind', 'delivery', '--repository', repositoryUrl ?? '<REPOSITORY-URL>',
    ...(safeName ? ['--name', project.name] : []),
    '--source-roots', project.root, ...(project.sharedRoots.length ? ['--shared-roots', project.sharedRoots.join(',')] : []),
    '--clone-mode', 'blobless-sparse', '--sparse-cone', project.sparseCone.join(','), '--clone-fallback', 'refuse', '--json'];
}

const shellWord = (value) => (/^[A-Za-z0-9_./:@,=<>+-]+$/u.test(value) ? value : `'${value.replace(/'/gu, "'\\''")}'`);

async function mapRoute(argv) {
  const { safeCommandGuidance } = await import('../safe-command-guidance.mjs');
  const guidance = argv.some((value) => /^<[A-Z-]+>$/u.test(value)) ? null : safeCommandGuidance({ argv });
  if (guidance) return { command: guidance.command, copilotCommand: guidance.copilotCommand, modelFreeCommand: guidance.modelFreeCommand ?? null };
  // A lead or repository still to name: the command to fill in, shown but not run.
  return { command: `singularity-flow ${argv.map(shellWord).join(' ')}`, copilotCommand: '/sf-capability-map', fill: argv.filter((value) => /^<[A-Z-]+>$/u.test(value)) };
}

export async function runCapabilityProjects({ positionals = [], options = {} } = {}) {
  const unknown = Object.keys(options).filter((key) => !OPTIONS.has(key)).sort();
  const url = positionals[2] ?? null;
  const directory = optionString(options, 'path', null);
  if (unknown.length || positionals.length > 3 || Boolean(url) === Boolean(directory) || (directory && optionString(options, 'branch', null))) {
    throw new SingularityFlowError(`Use ${USAGE}.${unknown.length ? ` Not an option here: ${unknown.map((key) => `--${key}`).join(', ')}.` : ''}`,
      { code: 'CAPABILITY_PROJECTS_USAGE', details: { nextAction: 'singularity-flow help capability' } });
  }
  const source = directory ? checkoutProjectFiles(path.resolve(directory))
    : await remoteProjectFiles(url, { branch: optionString(options, 'branch', null) });
  const detected = detectRepositoryProjects(source);
  const lead = optionString(options, 'lead', null) ?? (await listLeadRepositories().catch(() => []))[0]?.url ?? null;
  const projects = [];
  for (const project of detected.projects) projects.push({ ...project, map: await mapRoute(projectMapArgv(project, { lead, repositoryUrl: source.repositoryUrl })) });
  const whole = detected.projects.length === 0
    ? await mapRoute(['capability', 'map', '<CAPABILITY-ID>', '--lead', lead ?? '<LEAD-URL>', '--kind', 'delivery', '--repository', source.repositoryUrl ?? '<REPOSITORY-URL>', '--json'])
    : null;
  const result = {
    schemaVersion: 1, resultType: 'sflow-repository-projects',
    repository: source.repositoryUrl, ...(source.root ? { checkout: source.root } : {}), ...(source.branch ? { branch: source.branch } : {}),
    layout: detected.layout, tools: detected.tools, projects, ...(whole ? { wholeRepository: whole } : {}),
    notes: detected.notes, truncated: detected.truncated, lead,
    instruction: projects.length > 1
      ? 'Ask the person which of these projects to map as capabilities (several may be chosen) and confirm each ID, name and parent; run each chosen project\'s map.command once. Nothing is mapped until they choose.'
      : projects.length === 1 ? 'One project: confirm its ID, name and parent with the person, then run its map.command once.'
        : 'No workspace of projects was found: the repository is one capability. Ask for its ID, name and parent, then run wholeRepository.command with them.'
  };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
  const where = source.repositoryUrl ?? source.root;
  console.log(detected.layout === 'workspace'
    ? `${where}: ${projects.length} projects (${detected.tools.join(', ')}). Each can be its own capability; nothing was mapped.`
    : projects.length === 1 ? `${where}: one project (${detected.tools.join(', ')}).` : `${where}: one project, the whole repository.`);
  const { formatCommandRouteLines } = await import('../model-free-commands.mjs');
  for (const project of projects) {
    console.log(`\n  ${project.id} — ${project.root}${project.sharedRoots.length ? ` (uses ${project.sharedRoots.join(', ')})` : ''}`);
    for (const line of formatCommandRouteLines(project.map, { indent: '    ' })) console.log(line);
  }
  if (whole) for (const line of formatCommandRouteLines(whole, { indent: '  ' })) console.log(line);
  for (const note of detected.notes) console.log(`\nNote: ${note}`);
  if (!lead) console.log('\nNo capability-map repository is known on this machine: replace <LEAD-URL> with the one that holds your capability map.');
}
