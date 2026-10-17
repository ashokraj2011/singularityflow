/** Extracted command implementation; governance remains in the existing kernel APIs. */
import { optionBoolean, SingularityFlowError, optionString, requirePositional, secureRepositoryPath, optionNumber, posix, table } from '../util.mjs';
import { discoverRemoteStoryCandidatesByUrl } from '../session-remote-url-discovery.mjs';
import { workspaceRegistryFile, activeWorkspaceFile, activateWorkspaceContext, workspacePromptLabel, resolveWorkspaceExecutionContext, readActiveWorkspaceContext, activateWorkspaceStoryContext, buildWorkspaceContext } from '../workspace-context.mjs';
import path from 'node:path';
import { sessionRepositoryAuthority } from './shared/session-repository-authority.mjs';
import { sessionDiscoveryConfiguration } from './shared/session-discovery-configuration.mjs';
import { existsSync } from 'node:fs';
import { WORKFLOW_PATH, validateDefinition } from '../config.mjs';
import { loadStoryAggregate } from '../story-aggregate-read.mjs';
import { loadConfig, validateId } from '../state-stores.mjs';
import { requireCopilotWorkItemSelection, agentSessionStatus, loadSession, activateWorkItemSession, loadCopilotSession } from '../session.mjs';
import { branch, head, gitDir, gitCommonDir, repoRoot, fetchRemote, refHead, isAncestor, assertClean, changes, checkout, fastForwardTo, removeCleanAttachStagingWorktree } from '../git.mjs';
import { printCommandRoutes } from './shared/print-command-routes.mjs';
import { samePlatformPath } from '../story-worktree.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { repairWorkspace, readWorkspace, workspaceRepositoryPath } from '../workspace.mjs';
import { compileObservation } from '../observation-compiler.mjs';
import { readFile } from 'node:fs/promises';
import { composeContextBrief } from '../context-broker.mjs';
import { discoverRemoteStoryCandidates, validatedRemoteStoryDefinition } from '../session-story-discovery.mjs';
import { configuredRemoteIdentity } from '../git-remote-diagnostics.mjs';
import { renderChangeDirectoryCommand } from '../safe-command-guidance.mjs';
import { acceptedStoryExecutionIfPresent } from './shared/accepted-story-execution-if-present.mjs';
import { runRemoteGitAsync } from '../git-execution.mjs';
import YAML from 'yaml';
import { readRecord } from '../schema-migrations.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { resolveSessionRepository } from './shared/session-repository-selection.mjs';
export { resolveSessionRepository };

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => sessionCommand(positionals, options)));
}

export async function selectedSessionRemote(context) {
  const workspace = await readWorkspace(context.workspacePath);
  if (workspace.id !== context.workspaceId) throw new SingularityFlowError(
    'The selected workspace identity changed before Story discovery. Select the workspace again.',
    { code: 'SESSION_WORKSPACE_CHANGED' }
  );
  const member = workspace.repositories?.[context.repositoryId];
  if (!member || !samePlatformPath(
    workspaceRepositoryPath(workspace, member), context.canonicalRepositoryPath
  )) {
    throw new SingularityFlowError(
      'The selected workspace repository changed before Story discovery. Select it again.',
      { code: 'SESSION_WORKSPACE_CHANGED' }
    );
  }
  const lead = workspace.repositories?.[workspace.leadRepository];
  const configurationUrl = workspace.capabilityAuthority?.url ?? lead?.url;
  if (!member.url || !configurationUrl) throw new SingularityFlowError(
    'The selected workspace does not identify both Story and approved configuration Git authorities.',
    { code: 'SESSION_REMOTE_CONFIGURATION_REQUIRED' }
  );
  return { url: member.url, configurationUrl };
}

export function exactDiscoveredStory(discovery, reference) {
  const matches = discovery.items.filter((item) => item.id === reference || item.branch === reference || item.aliases?.includes(reference));
  if (matches.length !== 1) throw new SingularityFlowError(
    matches.length ? `Story reference '${reference}' is ambiguous on the selected remote.`
      : `No governed Story matches '${reference}' on the selected remote. Refresh Story candidates and choose an exact ID or branch.`,
    { code: matches.length ? 'SESSION_STORY_AMBIGUOUS' : 'SESSION_STORY_NOT_FOUND' }
  );
  if (discovery.unavailable?.some((entry) => entry.claimedId === matches[0].id
      || entry.branch === matches[0].branch)) throw new SingularityFlowError(
    `Story '${matches[0].id}' has conflicting or unreadable claims on the selected remote. Repair its governed state before attaching.`,
    { code: 'SESSION_STORY_INVALID' }
  );
  return matches[0];
}

export const SESSION_METADATA_BLOB_LIMIT = 1024 * 1024;

export async function exactStoryMetadataAtRef(root, remote, item, expectedCommit = null) {
  const ref = `${remote}/${item.branch}`;
  const commit = refHead(root, `refs/remotes/${ref}`);
  if (!commit || (expectedCommit && commit !== expectedCommit)) throw new SingularityFlowError(
    `Story branch '${item.branch}' changed after discovery. Refresh candidates and retry.`,
    { code: 'SESSION_REMOTE_CHANGED' }
  );
  const identity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
  if (!identity.configured || identity.ambiguous) throw new SingularityFlowError(
    `Story remote '${remote}' has no single configured fetch authority.`,
    { code: 'GIT_REMOTE_CONFIG_INVALID' }
  );
  const readMetadata = async (relative) => {
    const oid = refHead(root, `${ref}:${relative}`, {
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' }
    });
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid ?? '')) throw new SingularityFlowError(
      `Story branch '${item.branch}' is missing required metadata '${relative}'.`,
      { code: 'SESSION_STORY_INVALID' }
    );
    // The exact tree path fixes the immutable blob OID. In a partial clone this may fetch only
    // that promised blob, never the application tree. The registered remote executor bounds the
    // network wait/output and disables interactive credential prompts.
    const observed = await runRemoteGitAsync(['cat-file', 'blob', oid], {
      cwd: root, operation: 'remote-configuration', maxBuffer: SESSION_METADATA_BLOB_LIMIT + 1
    });
    if (observed.status !== 0 || Buffer.byteLength(observed.stdout ?? '', 'utf8') > SESSION_METADATA_BLOB_LIMIT) {
      throw new SingularityFlowError(
        `Story branch '${item.branch}' has unavailable or oversized metadata '${relative}'.`,
        { code: 'SESSION_STORY_METADATA_UNAVAILABLE' }
      );
    }
    return observed.stdout;
  };
  let definition;
  try {
    definition = YAML.parse(await readMetadata(WORKFLOW_PATH));
    validateDefinition(definition);
    validateId(definition, item.id);
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`Story '${item.id}' has an invalid pinned workflow definition.`, {
      code: 'SESSION_STORY_INVALID'
    });
  }
  const itemPath = posix(path.join(
    definition.workItemRoot ?? 'singularity/work-items', item.id, 'workflow.json'
  ));
  let state;
  try { state = readRecord('story-workflow', JSON.parse(await readMetadata(itemPath))).record; }
  catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    throw new SingularityFlowError(`Story '${item.id}' has invalid governed state.`, {
      code: 'SESSION_STORY_INVALID'
    });
  }
  const canonical = state.lineage?.canonicalBranch ?? state.workItem?.branch ?? item.id;
  if (state.workItem?.id !== item.id || !state.phases || !Array.isArray(state.phaseOrder)
      || canonical !== item.branch) throw new SingularityFlowError(
    `Story '${item.id}' does not own branch '${item.branch}' in its pinned state.`,
    { code: 'SESSION_STORY_INVALID' }
  );
  return {
    id: item.id, kind: 'story', canonicalBranch: canonical, selectedBranch: item.branch,
    location: { source: 'ref', ref, branch: item.branch, path: itemPath, commit },
    state
  };
}

export async function printSessionCandidateResult(discovered, options, scope = {}) {
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(
    optionBoolean(options, 'diagnostics') ? discovered : discovered.items, null, 2
  ));
  if (optionBoolean(options, 'table')) {
    const { renderStoryRoster } = await import('../session-roster.mjs');
    return console.log(renderStoryRoster(discovered, { scope }));
  }
  if (!discovered.items.length) return console.log(`No Stories are indexed in the verified state ledger on ${discovered.remote}.`);
  return console.log(table(discovered.items, [
    { key: 'id', label: 'WORK/JIRA ID' }, { key: 'title', label: 'TITLE' },
    { key: 'phase', label: 'PHASE' }, { key: 'status', label: 'STATUS' },
    { key: 'commit', label: 'REMOTE COMMIT' }
  ]));
}

export async function sessionCommand(positionals, options) {
  if (positionals[1] === 'open-local') return (await import('./session-open-local.mjs')).openLocalSessionCommand(positionals, options);
  const agentEntry = options['for-agent'] != null ? await import('../session-agent-entry.mjs') : null;
  const paused = agentEntry?.sessionAgentEntryGuard(positionals, options);
  if (paused) return console.log(JSON.stringify(paused));
  const subcommand = positionals[1] ?? 'status';
  if (subcommand === 'open') return (await import('./session-open.mjs')).run({ positionals, options });
  if (optionBoolean(options, 'table') && (subcommand !== 'candidates' || optionBoolean(options, 'json'))) {
    throw new SingularityFlowError('Use --table only with session candidates, without --json.', {
      code: 'SESSION_TABLE_FORMAT_INVALID'
    });
  }
  const repositoryUrl = optionString(options, 'repository-url');
  const configurationUrl = optionString(options, 'configuration-url');
  const workspaceReference = optionString(options, 'workspace');
  const selectedRepositoryId = optionString(options, 'repository');
  if (subcommand !== 'workspace'
      && (workspaceReference != null || selectedRepositoryId != null)
      && !['candidates', 'attach', 'open-local'].includes(subcommand)) throw new SingularityFlowError(
    '--workspace and --repository are supported by session candidates, attach, and open-local.',
    { code: 'SESSION_WORKSPACE_SELECTION_INVALID' }
  );
  if (repositoryUrl != null && workspaceReference != null) throw new SingularityFlowError(
    'Choose either --repository-url or --workspace, not both.',
    { code: 'SESSION_REMOTE_URL_COMMAND_INVALID' }
  );
  if (configurationUrl != null && repositoryUrl == null) throw new SingularityFlowError(
    '--configuration-url requires --repository-url for session candidates.',
    { code: 'SESSION_REMOTE_URL_COMMAND_INVALID' }
  );
  if (repositoryUrl != null) {
    if (subcommand !== 'candidates') throw new SingularityFlowError(
      '--repository-url is available only for session candidates.',
      { code: 'SESSION_REMOTE_URL_COMMAND_INVALID' }
    );
    const discovered = await discoverRemoteStoryCandidatesByUrl(repositoryUrl, { configurationUrl });
    return printSessionCandidateResult(discovered, options, { repositoryUrl });
  }
  if (subcommand === 'workspace') {
    const registry = workspaceRegistryFile();
    const selectionFile = activeWorkspaceFile();
    const reference = requirePositional(positionals, 2, 'workspace ID, name, Jira anchor, or directory');
    const requestedStoryId = optionString(options, 'story');
    const context = await activateWorkspaceContext(registry, selectionFile, reference, {
      repositoryId: optionString(options, 'repository'),
      storyId: requestedStoryId,
      // Selecting a workspace is not selecting whatever Story its lead clone happens to have
      // checked out. Only an explicit --story may pin a Story in this operation.
      detectStory: requestedStoryId != null
    });
    if (context.repositoryState !== 'ready') {
      throw new SingularityFlowError(
        `Workspace '${context.workspaceName}' is selected, but repository '${context.repositoryId}' is ${context.repositoryState}. `
        + `Run 'singularity-flow workspace repair ${context.workspacePath}' before attaching a session.`
      );
    }
    const currentDirectory = path.resolve(process.cwd());
    const repositoryPath = path.resolve(context.repositoryPath);
    // Selected absolute paths route governed commands even when the editor is elsewhere.
    const hostAction = 'ready';
    const editorRooted = currentDirectory === repositoryPath;
    if (!requestedStoryId) {
      const authority = await sessionRepositoryAuthority(repositoryPath);
      const { definition } = await sessionDiscoveryConfiguration(repositoryPath, authority);
      let candidate = null;
      if (existsSync(path.join(repositoryPath, WORKFLOW_PATH))) {
        try { candidate = await loadStoryAggregate(repositoryPath, definition); } catch { /* no Story on this branch */ }
      }
      await requireCopilotWorkItemSelection(repositoryPath, definition, candidate);
    }
    const result = {
      attached: true,
      workspaceId: context.workspaceId,
      workspaceName: context.workspaceName,
      workspacePath: context.workspacePath,
      repositoryId: context.repositoryId,
      repositoryPath: context.repositoryPath,
      storyId: context.storyId,
      prompt: workspacePromptLabel(context),
      hostAction,
      editorRooted,
      commands: {
        openCopilot: `singularity-flow workspace copilot ${JSON.stringify(context.workspaceId)}`
          + ` --repository ${JSON.stringify(context.repositoryId)}`
          + (context.storyId ? ` --story ${JSON.stringify(context.storyId)}` : ''),
        attachStory: context.storyId
          ? `singularity-flow session attach ${JSON.stringify(context.storyId)}`
          : 'singularity-flow session candidates'
      }
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Attached workspace session: ${workspacePromptLabel(context)}`);
    console.log(`Repository: ${context.repositoryId} · ${context.repositoryPath}`);
    console.log(`Story: ${context.storyId ?? 'not selected'}`);
    if (!editorRooted) {
      // Information, not an instruction. Governed commands resolve the repository from this
      // selection; only hand-editing files in the editor needs the folder open.
      console.log(`Governed commands will use ${context.repositoryPath}; this shell is elsewhere.`);
      console.log(`To edit files in this repository directly: ${result.commands.openCopilot}`);
    }
    if (context.storyId) {
      console.log(`Synchronize the Story branch: ${result.commands.attachStory}`);
    } else {
      console.log('The workspace is active. Select a Story with /sf-session before lifecycle work.');
    }
    return;
  }
  if (subcommand === 'current') {
    let context = null;
    try {
      context = await resolveWorkspaceExecutionContext(
        activeWorkspaceFile(), workspaceRegistryFile(), { cwd: process.cwd() }
      );
    } catch (error) {
      if (optionBoolean(options, 'json')) {
        return console.log(JSON.stringify({
          ready: false,
          code: error.code ?? 'ACTIVE_SUBJECT_UNAVAILABLE',
          message: error.message,
          details: error.details ?? null
        }, null, 2));
      }
      throw error;
    }
    if (!context) {
      const resolved = await resolveSessionRepository();
      if (!resolved.root) {
        const empty = {
          ready: false, workId: null, repositoryPath: null,
          selectionSource: null, reason: resolved.reason, detail: resolved.detail
        };
        return console.log(optionBoolean(options, 'json')
          ? JSON.stringify(empty, null, 2)
          : `No Singularity Flow execution context is active. ${resolved.detail}`);
      }
      context = {
        repositoryPath: resolved.root,
        canonicalRepositoryPath: resolved.root,
        checkoutPath: resolved.root,
        workspaceId: resolved.workspaceId,
        workspaceName: null,
        repositoryId: null,
        storyId: null,
        branch: branch(resolved.root),
        head: head(resolved.root),
        selectionSource: resolved.resolvedFrom,
        selectionStatus: 'ready',
        storyWorktree: gitDir(resolved.root) !== gitCommonDir(resolved.root)
      };
    }
    const executionRoot = path.resolve(context.repositoryPath);
    const authority = await sessionRepositoryAuthority(executionRoot);
    const { definition } = await sessionDiscoveryConfiguration(executionRoot, authority);
    let workflow = null;
    try { workflow = await loadStoryAggregate(executionRoot, definition); } catch { /* No Story is a valid workspace context. */ }
    const actualWorkId = workflow?.workItem?.id ?? null;
    if (context.storyId && actualWorkId !== context.storyId) {
      throw new SingularityFlowError(
        `Selected Story '${context.storyId}' does not match checkout Story '${actualWorkId ?? 'none'}'. Nothing was changed.`,
        {
          code: 'ACTIVE_SUBJECT_MISMATCH',
          details: {
            expectedWorkId: context.storyId,
            actualWorkId,
            repositoryPath: executionRoot,
            nextCommand: `singularity-flow session attach ${context.storyId} --json`
          }
        }
      );
    }
    const phaseSession = workflow
      ? await agentSessionStatus(executionRoot, definition, workflow)
      : null;
    const result = {
      ready: context.selectionStatus === 'ready' && (phaseSession?.ready ?? true),
      workspaceId: context.workspaceId ?? null,
      workspaceName: context.workspaceName ?? null,
      repositoryId: context.repositoryId ?? null,
      repositoryPath: executionRoot,
      canonicalRepositoryPath: context.canonicalRepositoryPath ?? executionRoot,
      checkoutPath: context.checkoutPath ?? executionRoot,
      storyWorktree: context.storyWorktree === true,
      workId: actualWorkId,
      branch: branch(executionRoot),
      head: head(executionRoot),
      phase: workflow?.currentPhase ?? null,
      status: workflow?.status ?? null,
      activeAgent: phaseSession?.activeAgent ?? null,
      phaseAgent: phaseSession?.phaseAgent ?? {
        required: false, phaseId: null, expectedAgent: null, sessionPhaseId: null,
        activeAgent: null, valid: true, reason: 'no-active-story', handoff: null
      },
      selectionSource: context.selectionSource ?? null,
      selectionStatus: context.selectionStatus ?? 'ready'
    };
    if (agentEntry) return console.log(JSON.stringify(agentEntry.sessionAgentResult(result, definition.workItemRoot)));
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Repository: ${result.repositoryPath}`);
    console.log(`Story: ${result.workId ?? 'not selected'} · branch ${result.branch}`);
    console.log(`Phase: ${result.phase ?? '—'} · status ${result.status ?? '—'}`);
    if (result.phaseAgent.required) {
      console.log(`Phase agent: ${result.activeAgent ?? 'not ready'} · ${result.phaseAgent.reason}`);
      if (result.phaseAgent.handoff) {
        printCommandRoutes(result.phaseAgent.handoff.command, {
          skill: result.phaseAgent.handoff.copilotCommand,
          label: 'Rebind the phase session'
        });
      }
    } else if (result.phase) console.log('Phase agent: not required (deterministic phase).');
    console.log(`Selection: ${result.selectionSource} · ${result.selectionStatus}`);
    return result;
  }
  if (subcommand === 'doctor') {
    const selected = await readActiveWorkspaceContext(
      activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false }
    ).catch(() => null);
    let execution = null;
    let executionError = null;
    try {
      execution = await resolveWorkspaceExecutionContext(
        activeWorkspaceFile(), workspaceRegistryFile(), { cwd: process.cwd() }
      );
    } catch (error) { executionError = error; }
    let currentRoot = null;
    try { currentRoot = repoRoot(); } catch { /* Outside Git is a reported condition. */ }
    const currentSession = currentRoot
      ? await loadSession(currentRoot, { required: false }).catch(() => null)
      : null;
    const findings = [];
    if (!selected) findings.push({ severity: 'warning', code: 'workspace-selection-missing', message: 'No active workspace is selected.' });
    if (executionError) findings.push({
      severity: 'error', code: executionError.code ?? 'active-subject-unavailable',
      message: executionError.message, details: executionError.details ?? null
    });
    if (selected?.storyId && currentSession?.workId && selected.storyId !== currentSession.workId) {
      findings.push({
        severity: 'warning', code: 'current-directory-session-differs',
        message: `Current directory session '${currentSession.workId}' differs from selected Story '${selected.storyId}'.`
      });
    }
    const result = {
      healthy: !findings.some((finding) => finding.severity === 'error'),
      selected: selected ? {
        workspaceId: selected.workspaceId, repositoryId: selected.repositoryId,
        workId: selected.storyId ?? null, repositoryPath: selected.repositoryPath,
        checkoutPath: selected.checkoutPath ?? null, selectionStatus: selected.selectionStatus ?? null
      } : null,
      execution: execution ? {
        workId: execution.storyId ?? null, repositoryPath: execution.repositoryPath,
        branch: execution.branch ?? null, selectionSource: execution.selectionSource ?? null
      } : null,
      currentDirectory: currentRoot ? {
        repositoryPath: currentRoot, branch: branch(currentRoot), sessionWorkId: currentSession?.workId ?? null
      } : null,
      findings
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Session routing: ${result.healthy ? 'healthy' : 'needs repair'}`);
    for (const finding of findings) console.log(`- ${finding.severity}: ${finding.message}`);
    return result;
  }
  if (subcommand === 'repair-selection') {
    const workId = requirePositional(positionals, 2, 'work ID');
    if (optionString(options, 'confirm') !== workId) {
      throw new SingularityFlowError(
        `Repairing the machine-local Story selection requires --confirm ${workId}. No Git state was changed.`,
        { code: 'ACTIVE_SUBJECT_REPAIR_CONFIRMATION_REQUIRED' }
      );
    }
    const selected = await readActiveWorkspaceContext(
      activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false }
    );
    if (!selected) throw new SingularityFlowError('No active workspace is selected.');
    const canonicalRoot = selected.canonicalRepositoryPath ?? selected.repositoryPath;
    const { storyWorktreeForBranch } = await import('../story-worktree.mjs');
    const managed = storyWorktreeForBranch(canonicalRoot, workId);
    if (!managed) {
      throw new SingularityFlowError(
        `No managed checkout currently owns Story '${workId}'. Reattach it with 'singularity-flow session attach ${workId} --json'.`,
        { code: 'ACTIVE_SUBJECT_UNAVAILABLE' }
      );
    }
    const repaired = await activateWorkspaceStoryContext(
      activeWorkspaceFile(), workspaceRegistryFile(), managed.repositoryPath,
      { storyId: workId, selectionSource: 'session-repair' }
    );
    const result = {
      repaired: true, workId, repositoryPath: repaired.repositoryPath,
      branch: repaired.branch, head: repaired.head, gitChanged: false
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(result, null, 2));
    console.log(`Selected Story ${workId} at ${result.repositoryPath}. No Git state was changed.`);
    return result;
  }
  let resolved = await resolveSessionRepository({ workspaceReference, repositoryId: selectedRepositoryId, remoteProbe: subcommand !== 'context' });
  let root = resolved.root;
  let preflightStory = null;
  if (!root && resolved.workspaceContext && ['candidates', 'attach'].includes(subcommand)) {
    const context = resolved.workspaceContext;
    const authority = await selectedSessionRemote(context);
    const discovered = await discoverRemoteStoryCandidatesByUrl(authority.url, {
      configurationUrl: authority.configurationUrl
    });
    if (subcommand === 'candidates') {
      return printSessionCandidateResult(discovered, options, {
        workspaceReference: workspaceReference ?? context.workspacePath,
        repositoryId: selectedRepositoryId ?? context.repositoryId
      });
    }
    const reference = requirePositional(positionals, 2, 'work, Jira, or branch reference');
    preflightStory = exactDiscoveredStory(discovered, reference);
    // Materialize only the selected, manifest-bound repository after the exact Story has been
    // proven on the remote. A bad/unknown Story must not cause a new application clone.
    await repairWorkspace(context.workspacePath, {
      repositoryIds: [context.repositoryId], returnIfSelectedReady: true,
      statusLevel: 'readiness'
    });
    const refreshed = await buildWorkspaceContext(workspaceRegistryFile(), context.workspaceId, {
      repositoryId: context.repositoryId, detectStory: false
    });
    if (refreshed.repositoryState !== 'ready') throw new SingularityFlowError(
      `Workspace repository '${context.repositoryId}' was not ready after materialization.`,
      { code: 'SESSION_REPOSITORY_REQUIRED' }
    );
    const currentAuthority = await selectedSessionRemote(refreshed);
    if (currentAuthority.url !== authority.url
        || currentAuthority.configurationUrl !== authority.configurationUrl) throw new SingularityFlowError(
      'The selected Story or configuration Git authority changed during materialization. Nothing was attached.',
      { code: 'SESSION_REMOTE_CHANGED' }
    );
    root = refreshed.repositoryPath;
    // A deferred clone may initially track only its default branch. Fetch the reviewed delivery
    // remote before resolving its Story-carried configuration; do not mistake that for an
    // ungoverned repository merely because the Story ref is not yet locally advertised.
    await fetchRemote(root, 'origin', { respectPartialClone: true, branches: [preflightStory.branch] });
    resolved = {
      root, workspaceId: refreshed.workspaceId, workspaceContext: refreshed,
      resolvedFrom: workspaceReference ? 'explicit-workspace' : 'active-workspace',
      authority: await sessionRepositoryAuthority(root)
    };
  }
  if (!root) {
    if (subcommand === 'attach' || subcommand === 'candidates') {
      throw new SingularityFlowError(
        subcommand === 'attach'
          ? `Cannot attach a Story because no governed repository is active. ${resolved.detail}`
          : `Cannot discover Stories because no governed delivery repository is active. ${resolved.detail}`,
        { code: 'SESSION_REPOSITORY_REQUIRED' }
      );
    }
    const empty = {
      initialized: false, workId: null, selectionRequired: false, bound: false, activeAgent: null, choices: [],
      resolvedFrom: null, repositoryPath: null, workspaceId: null,
      // Why there is no repository, so the caller can act instead of guessing at a URL.
      reason: resolved.reason
    };
    return console.log(optionBoolean(options, 'json') ? JSON.stringify(empty, null, 2) : `No Singularity Flow repository is active. ${resolved.detail}`);
  }
  const discovery = await sessionDiscoveryConfiguration(root, resolved.authority, {
    storyBootstrap: subcommand === 'status'
  });
  const config = discovery.definition;
  if (subcommand === 'context') {
    const expandHandle = optionString(options, 'expand-handle');
    const observationKind = optionString(options, 'observation-kind');
    const observationFile = optionString(options, 'observation-file');
    if (Boolean(observationKind) !== Boolean(observationFile)) {
      throw new SingularityFlowError('Observation context requires both --observation-kind and --observation-file.');
    }
    let observation = null;
    if (observationFile) {
      const resolvedObservation = await secureRepositoryPath(root, observationFile, {
        label: 'Observation input', mustExist: true, type: 'file'
      });
      observation = await compileObservation(root, {
        kind: observationKind,
        raw: await readFile(resolvedObservation.absolute),
        commandClass: optionString(options, 'observation-command-class', 'configured-operation'),
        exitCode: optionNumber(options, 'observation-exit-code'),
        binding: {
          workId: optionString(options, 'work-id'),
          flightPlanId: optionString(options, 'flight-plan'),
          sourceRevision: head(root),
          maximumOutputBytes: optionNumber(options, 'max-output-bytes')
        }
      });
    }
    const context = await composeContextBrief(root, {
      workId: optionString(options, 'work-id'),
      slice: optionString(options, 'slice', 'brief'),
      flightPlanId: optionString(options, 'flight-plan'),
      expandHandle,
      observation,
      maxOutputBytes: optionNumber(options, 'max-output-bytes')
    });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(context, null, 2));
    if (context.kind === 'evidence-packet-expansion') {
      console.log(`${context.packetId} · ${context.representation}`);
      console.log(`Included: ${context.accounting.includedContentBytes}/${context.accounting.maximumOutputBytes} bytes · ~${context.accounting.estimatedInputTokens} tokens`);
      console.log(context.content);
      return;
    }
    if (context.kind === 'evidence-packet') {
      console.log(`${context.binding.workId ?? 'preview'} · ${context.binding.phase ?? 'unbound'} · ${context.requestedSlices.join(',')} evidence packet`);
      console.log(`Packet: ${context.packetId} · ${context.status} · revision ${context.binding.sourceRevision.slice(0, 12)}`);
      console.log(`Included: ${context.budget.includedContentBytes}/${context.budget.maximumOutputBytes} bytes · ~${context.budget.estimatedInputTokens} estimated tokens`);
      console.log(`Items: ${context.items.length} · omissions: ${context.omissions.reduce((total, entry) => total + (entry.count ?? 1), 0)} · unavailable: ${context.unavailable.length}`);
      console.log(JSON.stringify({ items: context.items, omissions: context.omissions, unavailable: context.unavailable }, null, 2));
      return;
    }
    console.log(`${context.work.id} · ${context.phase?.id ?? 'closed'} · ${context.slice} context`);
    console.log(`Revision: ${(context.sourceRevision.commit ?? 'unavailable').slice(0, 12)}`);
    console.log(`Included: ${context.accounting.includedContentBytes}/${context.accounting.maximumOutputBytes} bytes · ~${context.accounting.estimatedInputTokens} tokens`);
    if (context.omissions.length) console.log(`Omitted: ${context.omissions.join(', ')}`);
    console.log(JSON.stringify(context.payload, null, 2));
    return;
  }
  if (subcommand === 'candidates') {
    const discovered = await discoverRemoteStoryCandidates(root, config, { remote: discovery.remote });
    return printSessionCandidateResult(discovered, options, {
      workspaceReference: workspaceReference ?? resolved.workspaceContext?.workspacePath ?? null,
      repositoryId: selectedRepositoryId ?? resolved.workspaceContext?.repositoryId ?? null
    });
  }
  if (subcommand === 'attach') {
    const reference = requirePositional(positionals, 2, 'work, Jira, or branch reference');
    // A new Copilot session may begin after the previous session prepared an unpublished
    // generation. Those governed edits must not make the exact, already-synchronized Story
    // branch impossible to select. We still require a clean tree before changing branches or
    // advancing HEAD; the sole exception below only binds local session metadata in place.
    const remote = discovery.remote;
    const discovered = preflightStory ? { items: [preflightStory] }
      : await discoverRemoteStoryCandidates(root, config, { remote });
    const item = exactDiscoveredStory(discovered, reference);
    await fetchRemote(root, remote, { respectPartialClone: true, branches: [item.branch] });
    const subject = await exactStoryMetadataAtRef(root, remote, item);
    if (preflightStory && (subject.id !== preflightStory.id
        || subject.selectedBranch !== preflightStory.branch)) throw new SingularityFlowError(
      'The selected Story changed between remote preflight and local checkout. Refresh candidates and retry.',
      { code: 'SESSION_REMOTE_CHANGED' }
    );
    const id = subject.id;
    const targetBranch = subject.selectedBranch;
    // A Story started from VS Code or a dirty launch checkout owns an isolated managed worktree.
    // Git will not check the same branch out in the canonical clone, so attaching from that clone
    // must resolve and operate on the checkout that already owns it. The managed path is discovered
    // from Git's worktree registry rather than reconstructed from mutable workspace configuration.
    const { completeStoryWorktree, prepareStoryWorktree, storyWorktreeForBranch } = await import('../story-worktree.mjs');
    const managedWorktree = storyWorktreeForBranch(root, targetBranch);
    const remoteName = `${remote}/${targetBranch}`;
    const remoteRef = `refs/remotes/${remote}/${targetBranch}`;
    const remoteSha = refHead(root, remoteRef);
    if (!remoteSha) throw new SingularityFlowError(`No committed lifecycle branch '${targetBranch}' exists on ${remote}. Start it with /sf-start or verify the Story reference.`);
    if (item.commitOid && !isAncestor(root, item.commitOid, remoteSha)) throw new SingularityFlowError(
      `Story branch '${targetBranch}' changed after remote preflight. Refresh candidates and retry.`,
      { code: 'SESSION_REMOTE_CHANGED' }
    );
    const localStoryHead = refHead(root, `refs/heads/${targetBranch}`);
    if (localStoryHead && localStoryHead !== remoteSha
        && !isAncestor(root, localStoryHead, remoteSha)) throw new SingularityFlowError(
      `Local branch '${targetBranch}' contains commits that are not on ${remoteName}. Push them or use a clean clone before attaching; Singularity Flow will not discard local history.`
    );
    let pinned;
    try {
      pinned = validatedRemoteStoryDefinition(root, remoteName, subject);
    } catch {
      throw new SingularityFlowError(
        `Remote branch ${remote}/${targetBranch} is not a valid Singularity Flow Story branch. `
        + `Expected matching state at ${subject.location.path} and a valid pinned ${WORKFLOW_PATH}.`
      );
    }
    // Do not switch an unrelated Story's linked checkout merely because the command was launched
    // there. Start an isolated managed checkout for the selected Story after remote proof succeeds.
    // A normal canonical clone keeps its historical clean-checkout attach behavior.
    let preparedWorktree = null;
    let attachmentRoot = managedWorktree?.repositoryPath ?? root;
    if (!managedWorktree && !samePlatformPath(gitDir(root), gitCommonDir(root))
        && branch(root) !== targetBranch) {
      // A linked Story checkout is nested under story-worktrees; using it as the worktree path
      // anchor would nest another story-worktrees directory inside Story A. Anchor on the shared
      // repository's canonical checkout instead, while leaving A's branch/index untouched.
      const commonDir = gitCommonDir(root);
      if (path.basename(commonDir) !== '.git') throw new SingularityFlowError(
        'Cannot locate the canonical checkout for this linked Story worktree.',
        { code: 'STORY_WORKTREE_RECOVERY_REQUIRED' }
      );
      preparedWorktree = await prepareStoryWorktree(path.dirname(commonDir), id, { base: remoteSha });
      attachmentRoot = preparedWorktree.repositoryPath;
    }
    let materialization;
    try {
      const alreadyCurrent = branch(attachmentRoot) === targetBranch;
      if (!alreadyCurrent) assertClean(attachmentRoot);
      const dirtyInPlace = alreadyCurrent && Boolean(changes(attachmentRoot).trim());
      if (dirtyInPlace) {
        if (head(attachmentRoot) !== remoteSha) {
          throw new SingularityFlowError(
            `Local branch '${targetBranch}' has uncommitted changes and is not at the exact ${remote}/${targetBranch} head. `
            + 'Commit or preserve the changes before synchronizing; Singularity Flow will not merge, rebase, reset, stash, or discard them.'
          );
        }
        materialization = managedWorktree
          ? 'bound-managed-story-worktree-with-local-changes'
          : 'bound-current-with-local-changes';
      } else {
        materialization = managedWorktree
          ? 'reused-managed-story-worktree'
          : await checkout(attachmentRoot, targetBranch, { base: pinned.definition.defaultBaseBranch, existingOnly: true, remote });
        try { fastForwardTo(attachmentRoot, remoteName); }
        catch { throw new SingularityFlowError(`Local branch '${targetBranch}' cannot fast-forward to ${remote}/${targetBranch}. Resolve or preserve the local commits in another clone; Singularity Flow will not merge, rebase, reset, or discard them.`); }
      }
    } catch (error) {
      if (preparedWorktree?.created) removeCleanAttachStagingWorktree(
        root, attachmentRoot, preparedWorktree.stagingBranch
      );
      throw error;
    }
    if (preparedWorktree?.created) {
      completeStoryWorktree(preparedWorktree);
      materialization = 'created-managed-story-worktree';
    }
    if (head(attachmentRoot) !== remoteSha) throw new SingularityFlowError(`Local branch '${targetBranch}' contains commits that are not on ${remote}/${targetBranch}. Push them or use a clean clone before attaching; Singularity Flow will not discard local history.`);
    const attachedConfig = await loadConfig(attachmentRoot);
    const workflow = await loadStoryAggregate(attachmentRoot, attachedConfig, id);
    const session = await activateWorkItemSession(attachmentRoot, attachedConfig, workflow);
    if (workspaceReference && resolved.workspaceContext) await activateWorkspaceContext(
      workspaceRegistryFile(), activeWorkspaceFile(), resolved.workspaceContext.workspaceId,
      { repositoryId: resolved.workspaceContext.repositoryId, detectStory: false }
    );
    await activateWorkspaceStoryContext(
      activeWorkspaceFile(), workspaceRegistryFile(), attachmentRoot,
      { storyId: id, selectionSource: 'session-attach' }
    );
    const result = {
      workId: id, branch: workflow.workItem.branch, remote, commit: remoteSha,
      phase: workflow.currentPhase, status: workflow.status, materialization, agent: session.selectedAgent,
      context: {
        operation: 'context.brief',
        arguments: { workId: id, slice: 'brief', maxOutputBytes: 32768 },
        command: `singularity-flow session context --work-id ${id} --slice brief --max-output-bytes 32768 --json`
      }
    };
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify({
      ...result,
      repositoryPath: attachmentRoot,
      resolvedFrom: managedWorktree || preparedWorktree ? 'managed-story-worktree' : resolved.resolvedFrom,
      ...(managedWorktree || preparedWorktree ? { sourceRepositoryPath: root } : {})
    }, null, 2));
    // This checked out a branch. When the repository came from the selection rather than from where
    // the caller is standing, saying which one is the difference between an attach and a surprise.
    if (resolved.resolvedFrom === 'active-workspace') console.log(`Repository: ${root} (from the active workspace)`);
    if (managedWorktree) console.log(`Story worktree: ${attachmentRoot}`);
    console.log(`Attached to ${id} from ${remote}/${targetBranch} at ${remoteSha.slice(0, 8)}.`);
    console.log(`Current phase: ${workflow.currentPhase ?? 'none'} · status: ${workflow.status}`);
    if (session.selectedAgent) console.log(`Phase agent: ${session.selectedAgent} (activated automatically).`);
    else console.log(`The Story is ${workflow.status}; no phase agent is required for read-only inspection.`);
    if (managedWorktree && path.resolve(process.cwd()) !== path.resolve(attachmentRoot)) {
      console.log(`Continue in the isolated Story checkout: ${renderChangeDirectoryCommand(attachmentRoot)}`);
    }
    console.log(`Bounded Copilot context: ${result.context.command}`);
    return;
  }
  if (subcommand !== 'status') throw new SingularityFlowError(`Unknown session subcommand: ${subcommand}`);
  let workflow;
  let statusConfig = config;
  // A workspace-only handoff records an explicit local gate before this command runs. The branch
  // may still happen to contain a Story candidate, but that is not consent to select it. Inspect
  // the gate before opening the accepted Story closure: besides adopting the candidate, doing the
  // strict read here made an unrelated legacy/damaged Story prevent the user from selecting one.
  // `session attach` clears this flag, after which status resumes the strict saved-closure path.
  const copilotSelection = await loadCopilotSession(root);
  const accepted = copilotSelection?.workItemSelectionRequired === true
    ? null
    : await acceptedStoryExecutionIfPresent(root);
  if (accepted) {
    workflow = accepted.workflow;
    statusConfig = accepted.definition;
  } else workflow = null;
  /**
   * The repository this answer is about, and how it was chosen.
   *
   * Without it the caller cannot tell an answer about the directory it is standing in from an answer
   * about a workspace selected an hour ago in a different window — and those warrant different
   * confidence before anything is written.
   */
  const status = {
    ...await agentSessionStatus(root, statusConfig, workflow),
    repositoryPath: root,
    resolvedFrom: resolved.resolvedFrom,
    workspaceId: resolved.workspaceId
  };
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(status, null, 2));
  if (resolved.resolvedFrom === 'active-workspace') console.log(`Repository: ${root} (from the active workspace, not the working directory)`);
  console.log(`Work item: ${status.workId ?? 'not selected'}${status.candidateWorkId && !status.workId ? ` · current candidate: ${status.candidateWorkId}` : ''}`);
  console.log(`governed agent: ${status.activeAgent ?? 'not selected'}`);
  console.log(`Copilot session: ${status.copilotSessionId ?? 'not bound'}`);
  console.log(`Work-item selection: ${status.workItemSelectionRequired ? 'required' : 'complete'} · governed agent: ${status.activeAgent ?? 'phase default pending'}`);
  console.log(`Policy: work item ${status.policy.workItemSelection ?? 'off'} · phase agent automatic · before tools: ${status.policy.requireBeforeTools ? 'required' : 'not required'}`);
  if (status.workItemSelectionRequired) {
    printCommandRoutes('singularity-flow session attach <WORK-ID>', { label: 'Select the Story' });
  }
}
