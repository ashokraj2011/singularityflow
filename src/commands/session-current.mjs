/** The existing current-session projection, without attach/materialization/publication handlers. */
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { SingularityFlowError, optionBoolean, optionString } from '../util.mjs';
import { activeWorkspaceFile, workspaceRegistryFile, resolveWorkspaceExecutionContext } from '../workspace-context.mjs';
import { branch, head, gitDir, gitCommonDir } from '../git.mjs';
import { loadStoryAggregate } from '../story-aggregate-read.mjs';
import { loadAcceptedStoryExecution } from '../accepted-story-execution.mjs';
import { agentSessionStatus } from '../session.mjs';
import { sessionRepositoryAuthority } from './shared/session-repository-authority.mjs';
import { sessionDiscoveryConfiguration } from './shared/session-discovery-configuration.mjs';
import { resolveSessionRepository } from './shared/session-repository-selection.mjs';
import { workspaceMaterializeCommand } from '../workspace-manifest.mjs';
import { printCommandRoutes } from './shared/print-command-routes.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withUnansweredRemoteReuse } from '../git-child-groups.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => withUnansweredRemoteReuse(async () => {
      const agentEntry = options['for-agent'] != null ? await import('../session-agent-entry.mjs') : null;
      const paused = agentEntry?.sessionAgentEntryGuard(positionals, options);
      if (paused) return console.log(JSON.stringify(paused));
      return sessionCurrent(options, { agentEntry });
    })));
}

/**
 * Selectors carried from `session open` name the binding this read reports; they never choose
 * another one. A workspace is named by its ID or its folder, a repository by its ID.
 */
async function assertSelectorsNameBinding(options, context) {
  const workspace = optionString(options, 'workspace');
  const repository = optionString(options, 'repository');
  if (!workspace && !repository) return;
  const real = (value) => realpath(path.resolve(value)).catch(() => path.resolve(value));
  const workspaceNamed = !workspace || workspace === context.workspaceId
    || Boolean(context.workspacePath) && await real(workspace) === await real(context.workspacePath);
  if (workspaceNamed && (!repository || repository === context.repositoryId)) return;
  throw new SingularityFlowError(`The current session is workspace ${context.workspaceId ?? 'none'}, repository ${context.repositoryId ?? 'none'}, not the ones named. Nothing was changed.`, {
    code: 'SESSION_SELECTORS_MISMATCH',
    details: { workspaceId: context.workspaceId ?? null, repositoryId: context.repositoryId ?? null,
      requested: { workspace: workspace ?? null, repository: repository ?? null },
      nextCommand: 'singularity-flow session open --for-agent --json' }
  });
}

export async function sessionCurrent(options, { agentEntry = null } = {}) {
  let context = null;
  let discoveryAuthority = null;
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
  if (['deferred', 'missing'].includes(context?.repositoryState)) {
    // Not cloned yet, or its clone failed (C7): report the selection and its repair, never a Git
    // read in a checkout that is not there.
    const materialize = workspaceMaterializeCommand(context.workspacePath, context.repositoryId);
    const deferred = context.repositoryState === 'deferred';
    const detail = deferred
      ? `Repository '${context.repositoryId}' is not cloned yet; a Story attach or start clones it, or run ${materialize}.`
      : `Repository '${context.repositoryId}' is not cloned here: its checkout is missing (an earlier clone failed or it was removed). Run ${materialize} once its remote answers.`;
    return console.log(optionBoolean(options, 'json') ? JSON.stringify({ ready: false, workId: null,
      workspaceId: context.workspaceId, repositoryId: context.repositoryId, repositoryPath: null,
      reason: deferred ? 'workspace-repository-deferred' : 'workspace-repository-missing', detail, materialize }, null, 2) : detail);
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
    discoveryAuthority = resolved.authority;
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
  await assertSelectorsNameBinding(options, context);
  const executionRoot = path.resolve(context.repositoryPath);
  const authority = discoveryAuthority ?? await sessionRepositoryAuthority(executionRoot);
  const discovery = await sessionDiscoveryConfiguration(executionRoot, authority, { storyBootstrap: true });
  let definition = discovery.definition;
  let workflow = null;
  try {
    if (['working-tree', 'approved-configuration-overlay'].includes(discovery.source)) {
      // An accepted Story owns its agents/phases. Do not validate an unrelated live catalog
      // first, or discard and reconstruct the exact closure the aggregate owner just verified.
      const accepted = await loadAcceptedStoryExecution(executionRoot);
      workflow = accepted.workflow;
      definition = accepted.definition;
    } else workflow = await loadStoryAggregate(executionRoot, definition);
  } catch (error) {
    if (error.code !== 'STORY_NOT_FOUND') throw error;
    // No accepted Story is present: keep the ordinary full current-definition validation.
    definition = (await sessionDiscoveryConfiguration(executionRoot, authority)).definition;
  }
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
  const { captureExecutionContext, agentExecutionContext } = await import('../execution-context.mjs');
  result.executionContext = await captureExecutionContext(executionRoot, {
    // Reuse this read's exact verified checkout/revision, rather than joining a second HEAD
    // observation to the result above. This is a projection, never mutation authority.
    workflow, configurationPin: workflow?.resolution?.configurationSource ?? null, fresh: true,
    revision: { head: result.head, branch: result.branch }
  });
  // Every Story skill turn starts here: the binding, never the pinned configuration's file catalog.
  // An SFlow older than main says so once (build-currency.mjs reads a cached answer; never the network).
  if (agentEntry) return console.log(JSON.stringify(agentEntry.sessionAgentResult(
    { ...result, executionContext: agentExecutionContext(result.executionContext) }, definition.workItemRoot,
    { update: (await import('../build-currency.mjs')).buildCurrency() })));
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
