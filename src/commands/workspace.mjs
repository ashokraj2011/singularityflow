import path from 'node:path';

import {
  activeWorkspaceFile, discardUnsupportedWorkflowWorkspaces, readActiveWorkspaceContext,
  workspacePromptLabel, workspaceRegistryFile
} from '../workspace-context.mjs';
import { readWorkspaceRegistry } from '../workspace.mjs';
import { optionBoolean, table } from '../util.mjs';

const HOT_READS = new Set(['list', 'current', 'prompt']);
let legacy = null;

function subcommand(context = {}) {
  return context.positionals?.[1] ?? 'list';
}

async function loadLegacy() {
  legacy ??= await import('./legacy.mjs');
  await legacy.load();
  return legacy;
}

/** Keep timing attribution accurate for non-hot workspace commands that still use the monolith. */
export async function load(context = {}) {
  if (!HOT_READS.has(subcommand(context))) await loadLegacy();
}

export async function run(argv, context = {}) {
  const action = subcommand(context);
  if (!HOT_READS.has(action)) return (await loadLegacy()).run(argv);

  const { options = {} } = context;
  const registry = workspaceRegistryFile();
  const selectionFile = activeWorkspaceFile();
  await discardUnsupportedWorkflowWorkspaces(registry, selectionFile);

  if (action === 'list') {
    const workspaces = await readWorkspaceRegistry(registry);
    const active = await readActiveWorkspaceContext(selectionFile, registry, { refresh: false }).catch(() => null);
    const result = workspaces.map((workspace) => {
      const selected = workspace.id === active?.workspaceId
        && (!active?.workspacePath || path.resolve(workspace.path) === path.resolve(active.workspacePath));
      return {
        ...workspace,
        active: selected ? 'yes' : '',
        repositoryState: selected ? active?.repositoryState ?? null : null
      };
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    return console.log(table(result, [
      { key: 'active', label: 'ACTIVE' },
      { key: 'anchorKey', label: 'JIRA' },
      { key: 'anchorType', label: 'TYPE' },
      { key: 'name', label: 'WORKSPACE' },
      { key: 'path', label: 'PATH', kind: 'path' }
    ]));
  }

  const current = await readActiveWorkspaceContext(selectionFile, registry);
  if (!current) {
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ active: false }, null, 2));
    if (action === 'prompt') return console.log('');
    return console.log('No active workspace. Run singularity-flow workspace use <WORKSPACE>.');
  }
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ active: true, ...current }, null, 2));
  if (action === 'prompt') return console.log(workspacePromptLabel(current));
  console.log(`\n${workspacePromptLabel(current)}`);
  console.log(`Workspace: ${current.workspacePath}`);
  console.log(`Repository: ${current.repositoryId} · ${current.repositoryPath}`);
  console.log(`Branch: ${current.branch ?? '—'}`);
  console.log(`Story: ${current.storyId ?? '—'}`);
}
