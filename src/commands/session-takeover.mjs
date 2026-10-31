/** Explicit synchronized handoff. Local open, remote synchronization and human approval differ. */
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { step, stop } from '../cli-steps.mjs';
import { optionString, requirePositional, SingularityFlowError } from '../util.mjs';
import { agentExecutionContext, captureExecutionContext, boundExecutionContextRoot } from '../execution-context.mjs';
import { readCopilotMode, copilotModePresentation } from '../copilot-mode.mjs';

/**
 * What a takeover never brings (SDA §11). A publication or push still waiting on the other laptop is
 * published from there, by its own sync: no backup carries it (B5).
 */
export function localWorkNotCarried(id) {
  return Object.freeze({
    message: 'Work saved only on the laptop that worked on this Story before did not come with it: configuration drafts, '
      + 'laptop-local documents, and publications or pushes still waiting there. A publication or push still waiting there is '
      + `published from that laptop: run singularity-flow sync ${id} there (singularity-flow push status there lists saved pushes). `
      + 'The rest is not recoverable here unless it was published, or saved there with singularity-flow backup create '
      + '--out <DIRECTORY> and restored here.',
    restore: 'singularity-flow backup restore <DIRECTORY>',
    syncOnPreviousLaptop: `singularity-flow sync ${id}`
  });
}

/**
 * The session, brief and next steps read one command at a time, as `session open` does when the
 * shared read declines a Story: a published generation, a review or a recovery. Without this, every
 * Story taken over after its first publication came back not ready, with no session. A read that
 * fails leaves its part null, so the takeover is reported not ready rather than failed.
 */
async function sessionReadsOneByOne(root, id) {
  const status = await step(['session', 'status', '--json'], root);
  const context = await step(['session', 'context', '--work-id', id, '--slice', 'brief', '--max-output-bytes', '32768', '--json'], root);
  const next = await step(['nextsteps', id, '--json'], root);
  return { session: status.ok ? status.value : null, context: context.ok ? context.value : null, nextsteps: next.ok ? next.value : null };
}

/**
 * The takeover in plain words, for a person at a terminal; --json keeps the full result. It always
 * ends with its next step: a takeover whose session was not ready ended on that sentence (D9).
 */
export function takeoverText(result, { commandRouteLines, safeCommandGuidance }) {
  const lines = [`Took over ${result.workId} at phase ${result.phase ?? 'closed'}: ${result.repositoryPath}`];
  const handoff = result.session?.phaseAgent?.handoff ?? null;
  const reason = result.session?.workItemSelectionRequired ? 'the Story is not selected for this session'
    : result.session?.phaseAgent?.valid === false ? `phase ${result.phase} needs its agent bound here` : null;
  lines.push(result.documentsToRestore ? result.documentsToRestore.message
    : result.ready ? 'It is ready to continue here.' : `It is here; its session is not ready yet${reason ? `: ${reason}` : ''}.`);
  const next = result.documentsToRestore ? { command: `singularity-flow documents restore ${result.documentsToRestore.documents[0]} --file <LOCAL-FILE> --work-id ${result.workId}` }
    : result.ready ? { command: `singularity-flow nextsteps ${result.workId}` }
      : { command: handoff?.command ?? `singularity-flow session attach ${result.workId} --json`, skill: handoff?.copilotCommand ?? '/sf-session' };
  lines.push('Next:', ...commandRouteLines(safeCommandGuidance(next) ?? {}, ''));
  lines.push(result.localWorkNotCarried.message);
  return lines.join('\n');
}

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
      // One checkout per repository of the Story: one in another clone of this workspace is used,
      // one in another workspace refuses (story-index.mjs).
      const index = await import('../story-index.mjs');
      const other = await index.otherStoryCheckout(source, id);
      if (other && !other.sameWorkspace) throw await index.storyElsewhereError(id, other.entry, { sameWorkspace: false, operation: 'session takeover' });
      if (other) source = other.entry.checkoutPath;
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
    // The index records the Story's checkout in every repository it delivers in; never fails the takeover.
    await import('../story-index.mjs').then((index) => index.recordStoryCheckout(root, { source: 'session-takeover' })).catch(() => {});
    const references = workflow.resolution?.referenceRepositories ?? [];
    if (references.length) await (await import('../reference-repositories.mjs')).materializeReferenceRepositories(root, references);
    const documents = await step(['documents', 'list', id, '--json'], root);
    if (!documents.ok) stop(documents, 'Story takeover document verification', 'STORY_TAKEOVER_EVIDENCE_UNAVAILABLE');
    // A machine-local document stays on the laptop that added it and is never moved into Git. The
    // takeover still completes; only a document the current phase is given has to be uploaded again,
    // under its existing ID, before this phase can use it. One for a later phase waits for that phase.
    const { documentOfferedToPhase } = await import('../document-identity.mjs');
    const phase = workflow.currentPhase ?? null;
    const unavailable = (Array.isArray(documents.value) ? documents.value : documents.value?.documents ?? [])
      .filter(document => document.availability === 'unavailable')
      .map(document => ({ id: document.id, name: document.name,
        phases: Array.isArray(document.phases) ? [...document.phases] : null,
        neededNow: phase != null && documentOfferedToPhase(document, phase),
        restore: `singularity-flow documents restore ${document.id} --file <LOCAL-FILE> --work-id ${id}` }));
    const restoreNow = unavailable.filter(document => document.neededNow);
    const opened = await (await import('../session-read-service.mjs')).readOpenedSession(root, { workId: id })
      ?? await sessionReadsOneByOne(root, id);
    const result = { schemaVersion: 1, resultType: 'story-takeover', ready: restoreNow.length === 0 && opened?.session?.ready === true,
      workId: id, repositoryPath: root, phase: workflow.currentPhase, executionContext: primary,
      open: attached.value, session: opened?.session ?? null, context: opened?.context ?? null,
      nextsteps: opened?.nextsteps ?? null,
      repositories: bindings, unavailableDocuments: unavailable,
      documentsToRestore: restoreNow.length ? { phase, documents: restoreNow.map(document => document.id),
        message: `Phase '${phase}' uses ${restoreNow.length === 1 ? 'a document' : 'documents'} kept only on the laptop that added ${restoreNow.length === 1 ? 'it' : 'them'}. Ask for the same original file and upload it here with ${restoreNow.map(document => document.restore).join('; ')}. This keeps its ID and changes no approval.` } : null,
      // What a takeover can never bring (SDA §11): work saved only on the laptop that had the Story.
      localWorkNotCarried: localWorkNotCarried(id),
      remoteSynchronized: true, exclusiveOwnership: false,
      effects: { storyAdvanced: false, committed: false, pushed: false, testsRun: false } };
    if (options['for-agent']) Object.assign(result, { executionContext: agentExecutionContext(primary),
      repositories: bindings.map(agentExecutionContext) });
    console.log(options.json ? JSON.stringify(result, null, 2)
      : takeoverText(result, await import('../safe-command-guidance.mjs')));
    return result;
  } catch (error) {
    error.details = { ...(error.details ?? {}), completedRepositoryPaths: completed,
      preservation: 'Existing local edits, unpublished commits and earlier synchronized repositories were retained.' };
    throw error;
  }
}
