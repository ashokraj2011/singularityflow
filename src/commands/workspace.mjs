import path from 'node:path';

import {
  activateWorkspaceContext, activeWorkspaceFile, discardUnsupportedWorkflowWorkspaces,
  readActiveWorkspaceContext, workspacePromptLabel, workspaceRegistryFile
} from '../workspace-context.mjs';
import { optionBoolean, optionString, table } from '../util.mjs';

const HOT_ACTIONS = new Set(['list', 'current', 'prompt', 'use', 'switch']);
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
  if (!HOT_ACTIONS.has(subcommand(context))) await loadLegacy();
}

export async function run(argv, context = {}) {
  const action = subcommand(context);
  if (!HOT_ACTIONS.has(action)) return (await loadLegacy()).run(argv);

  const { options = {} } = context;
  const registry = workspaceRegistryFile();
  const selectionFile = activeWorkspaceFile();
  // List/current/prompt are also the first surfaces an older checkout reaches after installing a
  // newer SFlow build. Keep an obsolete-but-readable registration visible so Configuration can
  // offer the explicit refresh/reinitialize path; a read-only hot command must never turn an
  // upgrade candidate into an apparently missing workspace.
  await discardUnsupportedWorkflowWorkspaces(registry, selectionFile, {
    preserveForRecovery: true
  });

  if (action === 'use' || action === 'switch') {
    const { actionCommandLines, copilotAction } = await import('../copilot-guidance.mjs');
    const { renderChangeDirectoryCommand, renderPlatformCommand } = await import('../safe-command-guidance.mjs');
    const activeContext = await activateWorkspaceContext(registry, selectionFile, context.positionals?.[2], {
      repositoryId: optionString(options, 'repository'),
      storyId: optionString(options, 'story')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(activeContext, null, 2));
    console.log(`\nActive context: ${workspacePromptLabel(activeContext)}`);
    console.log(`Repository: ${activeContext.repositoryPath}`);
    if (activeContext.repositoryState !== 'ready') {
      console.log(`Repository state: ${activeContext.repositoryState}. Run workspace repair before starting Copilot.`);
      const repairArgv = ['singularity-flow', 'workspace', 'repair', activeContext.workspacePath,
        ...(activeContext.repositoryId ? ['--repository', activeContext.repositoryId] : [])];
      const repairLines = actionCommandLines({
        command: renderPlatformCommand(repairArgv, process.platform === 'win32' ? 'linux' : process.platform),
        skill: '/sf-workspace'
      }, 'Repair');
      if (process.platform === 'win32') {
        repairLines[1] = repairLines[1].replace(/^Shell:/u, 'Shell (Git Bash):');
        repairLines.splice(2, 0, `Shell (PowerShell): ${renderPlatformCommand(repairArgv, 'win32')}`);
      }
      for (const line of repairLines) console.log(line);
    }
    for (const line of actionCommandLines(copilotAction({
      command: 'singularity-flow workspace copilot'
    }), 'Start Copilot here')) console.log(line);
    console.log(`Shell directory: ${renderChangeDirectoryCommand(activeContext.repositoryPath)}`);
    return;
  }

  if (action === 'list') {
    const { readWorkspaceRegistry } = await import('../workspace.mjs');
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

  const gitShadow = action === 'current' && optionBoolean(options, 'git-shadow');
  const gitShadowObservations = [];
  const current = await readActiveWorkspaceContext(selectionFile, registry, gitShadow ? {
    gitReadMode: 'shadow',
    onGitShadowComparison(value) { gitShadowObservations.push(value); }
  } : undefined);
  if (!current) {
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({ active: false }, null, 2));
    if (action === 'prompt') return console.log('');
    const { actionCommandLines, copilotAction } = await import('../copilot-guidance.mjs');
    console.log('No active workspace.');
    for (const line of actionCommandLines(copilotAction({
      command: 'singularity-flow workspace use <WORKSPACE>'
    }), 'Select one')) console.log(line);
    return;
  }
  let gitShadowSummary = null;
  if (gitShadow) {
    const { summarizeFosGitShadowObservations } = await import('../fos-git-shadow.mjs');
    gitShadowSummary = summarizeFosGitShadowObservations(gitShadowObservations);
  }
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify({
    active: true,
    ...current,
    ...(gitShadowSummary ? { gitShadow: gitShadowSummary } : {})
  }, null, 2));
  if (action === 'prompt') return console.log(workspacePromptLabel(current));
  console.log(`\n${workspacePromptLabel(current)}`);
  console.log(`Workspace: ${current.workspacePath}`);
  console.log(`Repository: ${current.repositoryId} · ${current.repositoryPath}`);
  console.log(`Branch: ${current.branch ?? '—'}`);
  console.log(`Story: ${current.storyId ?? '—'}`);
  if (gitShadowSummary) {
    console.log(`Git shadow: ${gitShadowSummary.equivalent}/${gitShadowSummary.comparisons} equivalent · reference remains authoritative`);
  }
}
