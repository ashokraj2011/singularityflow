/** A typed, read-only session projection. No nested CLI, global stream capture or cwd changes. */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadAcceptedStoryExecution } from './accepted-story-execution.mjs';
import { composeContextBriefFromState } from './context-broker.mjs';
import { agentSessionStatus, loadCopilotSession } from './session.mjs';
import { gitDir, gitCommonDir } from './git.mjs';
import { readLocalGitAsync, withVerifiedReadHead } from './git-execution.mjs';
import { gitReadScheduler } from './read-scheduler.mjs';
import { operationContext, withOperationContext } from './operation-context.mjs';
import { resolveOperation } from './command-registry.mjs';
import { withFreshReadScope } from './read-scope.mjs';
import { withoutConfigurationReadScope } from './configuration-read-scope.mjs';
import { copilotModeFile } from './copilot-mode.mjs';
import { activeWorkspaceFile, workspaceRegistryFile } from './workspace-context.mjs';
import { STATE_REVISION } from './state-revision-read.mjs';
import { withStableRead } from './stable-read.mjs';
import { incrementCommandCounter, measureCommandSpan } from './dx-timing-context.mjs';
import { SingularityFlowError } from './util.mjs';
import { storyRequiresStepActions } from './step-actions.mjs';
import { localPendingPublicationPath, readPendingPublication } from './publication-pending.mjs';
import { publicationJournalPath } from './publication-journal.mjs';
import { BUILD_INFO } from './build-info.mjs';

/** Optimization eligibility only: called after the accepted aggregate owner verifies the Story. */
export function sharedSessionReadEligible(workflow) {
  const phase = workflow.phases?.[workflow.currentPhase];
  return Boolean(workflow.workflowSnapshot && phase?.status === 'in_progress'
    && Number(phase.generation ?? 0) === 0 && !phase.remoteOutputs?.length
    && !storyRequiresStepActions(workflow));
}

function isolatedReads() { incrementCommandCounter('session.snapshot.fallbacks'); return null; }

function readOperation(root, positionals, callback) {
  const operation = resolveOperation({ requestedCommand: positionals[0], positionals, options: { json: true } });
  if (operation.classification !== 'read' || operation.modelPolicy !== 'never') throw new SingularityFlowError(
    'The session projection requires a registered model-free read.', { code: 'SESSION_READ_OPERATION_INVALID' });
  const parent = operationContext();
  return withOperationContext({ ...parent, root, operation,
    modelMode: parent?.modelMode ?? { enabled: false, source: 'read-only-service' }
  }, callback);
}

/** Called only after the existing local-open/attach mutation has completed and been reported. */
export async function readOpenedSession(root, { workId, signal = null } = {}) {
  root = path.resolve(root);
  const privateRoot = gitDir(root), common = gitCommonDir(root);
  let observedHead = null;
  const files = [...new Set([
    path.join(root, 'singularity/workflow.yml'), path.join(root, 'singularity/portfolio.yml'),
    path.join(root, 'singularity/configuration-source.json'), path.join(privateRoot, 'index'),
    path.join(common, 'config'), path.join(privateRoot, 'config.worktree'),
    path.join(privateRoot, 'singularity-flow/session.json'), path.join(privateRoot, 'singularity-flow/copilot-session.json'),
    activeWorkspaceFile(), workspaceRegistryFile(), copilotModeFile()
  ])];
  try {
    return await withoutConfigurationReadScope(() => withStableRead({ files, signal,
      freshScope: withFreshReadScope,
      identity: async () => {
        const observed = await gitReadScheduler.run(root,
          () => readLocalGitAsync('repository.identity', root, { signal }), { signal }).catch(error => {
          // Git refusing this read (unborn HEAD, ownership, configuration) leaves the original reads.
          if (['LOCAL_GIT_READ_FAILED', 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE'].includes(error?.code)) throw new SingularityFlowError(
            'The local Git identity is unavailable for a shared read.', { code: 'READ_SNAPSHOT_UNAVAILABLE' });
          throw error;
        });
        const values = observed.stdout.trimEnd().split(/\r?\n/u);
        if (values.length !== 4 || !/^[a-f0-9]{40,64}$/iu.test(values[2])) {
          throw new SingularityFlowError('The local Git identity cannot be projected safely.', { code: 'READ_SNAPSHOT_UNAVAILABLE' });
        }
        if (path.resolve(values[0]) !== path.resolve(common) || path.resolve(values[1]) !== path.resolve(privateRoot)) {
          throw new SingularityFlowError('The repository identity changed while opening this session.', { code: 'READ_SNAPSHOT_STALE' });
        }
        observedHead = values[2];
        return JSON.stringify({ root, values, build: BUILD_INFO, environment: createHash('sha256')
          .update(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)))).digest('hex') });
      }
    }, ({ watch }) => withVerifiedReadHead(root, observedHead, async () => {
      // Workspace-only selection must retain the original status path; never adopt its candidate.
      if ((await loadCopilotSession(root))?.workItemSelectionRequired === true) return isolatedReads();
      incrementCommandCounter('session.snapshot.state-loads');
      const accepted = await measureCommandSpan('session.snapshot.load', () => loadAcceptedStoryExecution(root, workId));
      const { definition, workflow } = accepted;
      if (!workId || workflow.workItem.id !== workId) throw new SingularityFlowError(
        'The opened Story does not match the requested session.', { code: 'SESSION_OPEN_BINDING_MISMATCH' });
      const revision = workflow[STATE_REVISION];
      if (!revision?.statePath || !revision.stateSha256) return isolatedReads();
      const state = await watch(revision.statePath);
      if (!state.endsWith(`:${revision.stateSha256}`)) throw new SingularityFlowError(
        'The Story changed during loading. Refresh the session.', { code: 'READ_SNAPSHOT_STALE' });
      const phase = workflow.phases?.[workflow.currentPhase];
      // Keep the reference path for exceptional review/recovery/delivery states until their
      // larger mutable dependency closures have an exact observer contract too.
      if (!sharedSessionReadEligible(workflow)) return isolatedReads();
      const rootPath = path.join(root, definition.workItemRoot, workflow.workItem.id);
      const observeRelative = async relative => {
        if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')
            || relative.split('/').some(part => part === '..' || !part)) throw new SingularityFlowError(
          'A read dependency is not a bounded repository path.', { code: 'READ_SNAPSHOT_UNAVAILABLE' });
        await watch(path.join(root, relative));
      };
      for (const target of [localPendingPublicationPath(root, 'story', workId), publicationJournalPath(root, 'story', workId)]) {
        await watch(target);
        await watch(path.join(privateRoot, path.relative(common, target)));
      }
      await watch(path.join(rootPath, 'publication-pending.json'));
      await watch(path.join(root, 'singularity/work-items', workId, 'publication-pending.json'));
      if (await readPendingPublication(root, { kind: 'story', id: workId, roots: { workItemRoot: definition.workItemRoot }, migrate: false })) return isolatedReads();
      for (const producer of Object.values(workflow.phases ?? {})) {
        for (const brief of producer.agentBriefs ?? []) if (brief.consumerPhase === phase?.id && brief.renderedPath) {
          await observeRelative(brief.renderedPath);
        }
      }
      for (const artifact of phase?.artifacts ?? []) await observeRelative(artifact.path);
      if (phase?.id) {
        await watch(path.join(rootPath, 'context', `${phase.id}-gen${Number(phase.generation ?? 0) + 1}.json`));
      }
      const session = await readOperation(root, ['session', 'status'], () => agentSessionStatus(root, definition, workflow));
      if (session.ready !== true) return { session: { ...session, repositoryPath: root,
        resolvedFrom: 'working-directory', workspaceId: null }, context: null, nextsteps: null };
      // Live/unpinned remote-agent checks have additional mutable dependencies. Until those have
      // an exact observer contract too, keep their original isolated read path.
      if (session.activeAgent && !accepted.executionCatalog?.agents?.[session.activeAgent]) return isolatedReads();
      const context = await readOperation(root, ['session', 'context'], () => composeContextBriefFromState(root, definition, workflow));
      const nextsteps = await readOperation(root, ['nextsteps', workId], async () => {
        const { resolveStorySnapshot } = await import('./commands/nextsteps.mjs');
        return resolveStorySnapshot(root, accepted, { observeFile: observeRelative, publicationPending: false });
      });
      incrementCommandCounter('session.snapshot.projections', 3);
      return { session: { ...session, repositoryPath: root, resolvedFrom: 'working-directory', workspaceId: null }, context, nextsteps };
    })));
  } catch (error) {
    if (error.code !== 'READ_SNAPSHOT_UNAVAILABLE') {
      if (['READ_SNAPSHOT_STALE', 'READ_CANCELLED', 'READ_QUEUE_FULL', 'LOCAL_GIT_READ_FAILED'].includes(error.code)) {
        error.details = { ...error.details, repositoryPath: root,
          effects: { localSessionOpened: true, publicationRecorded: false, approvalRecorded: false },
          actions: [{ label: 'The local session was opened, but a coherent read could not complete. Preserve work; refresh its verified session before authoring.',
            command: `singularity-flow session open ${JSON.stringify(workId)} --json` }] };
      }
      throw error;
    }
    return isolatedReads(); // Only an unavailable optimization uses the original isolated read path.
  }
}
