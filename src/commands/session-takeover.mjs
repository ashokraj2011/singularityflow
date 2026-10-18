/** Explicit synchronized handoff. Local open, remote synchronization and human approval differ. */
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { step, stop } from '../cli-steps.mjs';
import { optionString, requirePositional, SingularityFlowError } from '../util.mjs';
import { captureExecutionContext, boundExecutionContextRoot } from '../execution-context.mjs';
import { readCopilotMode, copilotModePresentation } from '../copilot-mode.mjs';

export function validateSessionTakeoverRequest({ positionals, options }) {
  const allowed = new Set(['workspace', 'repository', 'json', 'for-agent', 'timings']);
  if (positionals.length !== 3 || Object.keys(options).some(key => !allowed.has(key))
      || options['for-agent'] !== undefined && (options['for-agent'] !== true || options.json !== true)) {
    throw new SingularityFlowError('Use session takeover <ID> [--workspace <PATH> --repository <ID>] --json.', { code: 'STORY_TAKEOVER_OPTIONS_INVALID' });
  }
}

export async function run(_argv, { positionals, options }) {
  validateSessionTakeoverRequest({ positionals, options });
  if (options['for-agent'] && readCopilotMode().paused) return console.log(JSON.stringify(copilotModePresentation(readCopilotMode())));
  const id = requirePositional(positionals, 2, 'Story ID');
  const selectors = [...(options.workspace ? ['--workspace', optionString(options, 'workspace')] : []),
    ...(options.repository ? ['--repository', optionString(options, 'repository')] : [])];
  const cwd = boundExecutionContextRoot() ?? process.cwd();
  const attached = await step(['session', 'attach', id, ...selectors, '--isolated-worktree', '--json'], cwd);
  if (!attached.ok) stop(attached, 'Story takeover attachment', 'STORY_TAKEOVER_FAILED');
  const root = attached.value.repositoryPath;
  const { loadAcceptedStoryExecution } = await import('../accepted-story-execution.mjs');
  const accepted = await loadAcceptedStoryExecution(root, id);
  const { workflow } = accepted;
  const contexts = await import('../workspace-context.mjs');
  const member = await contexts.workspaceMemberContextForRepository(root,
    contexts.activeWorkspaceFile(), contexts.workspaceRegistryFile(), { strict: true });
  const bindings = [];
  const primary = await captureExecutionContext(root, { workspace: member, workflow,
    configurationPin: workflow.resolution?.configurationSource ?? null, fresh: true });
  bindings.push(primary);
  const required = [...new Set((workflow.resolution?.capability?.deliveries ?? [])
    .flatMap(delivery => delivery.repositories ?? (delivery.repository ? [delivery.repository] : [])))];
  const primaryRepositoryId = member?.repositoryId ?? workflow.resolution?.capability?.repositoryId
    ?? (required.length === 1 ? required[0] : null);
  const completed = [root];
  try {
    if (required.some(repository => repository !== primaryRepositoryId) && !member?.workspace) {
      throw new SingularityFlowError('This multi-repository Story needs its mapped workspace before takeover.', { code: 'STORY_TAKEOVER_WORKSPACE_REQUIRED' });
    }
    const { configuredRemoteIdentity } = await import('../git-remote-diagnostics.mjs');
    const { fetchRemote, refHead, checkout, fastForwardTo, branch, gitCommonDir } = await import('../git.mjs');
    const { prepareStoryWorktree, storyWorktreeForBranch, completeStoryWorktree } = await import('../story-worktree.mjs');
    const { withRepositoryMutationLease } = await import('../subject-lock.mjs');
    const { workspaceRepositoryPath } = await import('../workspace-manifest.mjs');
    if (required.some(repository => repository !== primaryRepositoryId)) {
      const pin = workflow.resolution?.configurationSource;
      const source = await (await import('../configuration-branch.mjs')).readConfigurationSource(root, { verify: true });
      if (!pin || !source || ['repository', 'branch', 'commit', 'filesSha256'].some(key => pin[key] !== source[key])) {
        throw new SingularityFlowError('The delivery repository catalog is not bound to this Story’s exact configuration pin.', {
          code: 'STORY_TAKEOVER_CONFIGURATION_UNBOUND'
        });
      }
      const portfolio = await (await import('../initiative-config.mjs')).loadPortfolio(root, { required: true });
      const repositories = required.map(id => ({ ...member.workspace.repositories[id], id }));
      (await import('../capability-start.mjs')).assertApprovedCapabilityRepositoryPlan(
        repositories, workflow.resolution.capability, null, { portfolio });
    }
    for (const repositoryId of required) {
      if (repositoryId === primaryRepositoryId) continue;
      const repository = member.workspace.repositories[repositoryId];
      if (!repository) throw new SingularityFlowError(`Story repository '${repositoryId}' is missing from this workspace.`, { code: 'STORY_TAKEOVER_REPOSITORY_REQUIRED' });
      const storyRef = workflow.lineage?.canonicalBranch ?? workflow.workItem.branch;
      let source = workspaceRepositoryPath(member.workspace, repository);
      if (!(await lstat(path.join(source, '.git')).catch(() => null))) {
        source = (await (await import('../workspace-branch-checkout.mjs')).prepareWorkspaceBranch(
          member.workspace, repositoryId, storyRef, { reuse: true })).repositoryPath;
      }
      if (configuredRemoteIdentity(source, 'origin', { direction: 'fetch' }).url !== repository.url) {
        throw new SingularityFlowError(`Repository '${repositoryId}' no longer matches its approved remote.`, { code: 'WORKSPACE_REPOSITORY_IDENTITY_MISMATCH' });
      }
      await withRepositoryMutationLease(source, 'session.takeover', async () => {
        await fetchRemote(source, 'origin', { branches: [storyRef], respectPartialClone: true });
        const remoteRef = `refs/remotes/origin/${storyRef}`;
        const commit = refHead(source, remoteRef);
        if (!commit) throw new SingularityFlowError(`Story branch '${storyRef}' is unavailable in '${repositoryId}'.`, { code: 'STORY_TAKEOVER_BRANCH_REQUIRED' });
        let target = storyWorktreeForBranch(source, storyRef)?.repositoryPath;
        let prepared = null;
        if (!target && branch(source) === storyRef) target = source;
        if (!target) {
          prepared = await prepareStoryWorktree(path.dirname(gitCommonDir(source)), id, { base: commit, storyBranch: storyRef });
          target = prepared.repositoryPath;
          await checkout(target, storyRef, { existingOnly: true, remote: 'origin', fetch: false });
        }
        const changes = (await import('../git.mjs')).changes(target);
        if (changes.trim()) throw new SingularityFlowError(`Repository '${repositoryId}' has local edits; takeover preserved them.`, { code: 'STORY_TAKEOVER_LOCAL_CHANGES' });
        fastForwardTo(target, `origin/${storyRef}`);
        if (prepared) completeStoryWorktree(prepared);
        bindings.push(await captureExecutionContext(target, { workflow, fresh: true,
          configurationPin: workflow.resolution?.configurationSource ?? null }));
        completed.push(target);
      });
    }
    const references = workflow.resolution?.referenceRepositories ?? [];
    if (references.length) await (await import('../reference-repositories.mjs')).materializeReferenceRepositories(root, references);
    const documents = await step(['documents', 'list', id, '--json'], root);
    if (!documents.ok) stop(documents, 'Story takeover document verification', 'STORY_TAKEOVER_EVIDENCE_UNAVAILABLE');
    const unavailable = (Array.isArray(documents.value) ? documents.value : documents.value?.documents ?? [])
      .filter(document => document.availability === 'unavailable');
    const opened = unavailable.length ? null
      : await (await import('../session-read-service.mjs')).readOpenedSession(root, { workId: id });
    const result = { schemaVersion: 1, resultType: 'story-takeover', ready: unavailable.length === 0 && opened?.session?.ready === true,
      workId: id, repositoryPath: root, phase: workflow.currentPhase, executionContext: primary,
      open: attached.value, session: opened?.session ?? null, context: opened?.context ?? null,
      nextsteps: opened?.nextsteps ?? null,
      repositories: bindings, unavailableDocuments: unavailable.map(document => ({ id: document.id, name: document.name })),
      remoteSynchronized: true, exclusiveOwnership: false,
      effects: { storyAdvanced: false, committed: false, pushed: false, testsRun: false } };
    if (unavailable.length) throw new SingularityFlowError('Takeover synchronized published work, but local-only documents are unavailable. Ask their owner to store them in Git.', {
      code: 'STORY_TAKEOVER_EVIDENCE_UNAVAILABLE', details: result
    });
    console.log(JSON.stringify(result, null, 2));
    return result;
  } catch (error) {
    error.details = { ...(error.details ?? {}), completedRepositoryPaths: completed,
      preservation: 'Existing local edits, unpublished commits and earlier synchronized repositories were retained.' };
    throw error;
  }
}
