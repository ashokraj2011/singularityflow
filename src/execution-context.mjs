/**
 * The shared workspace/repository/clone/worktree/Story model.
 *
 * This is an immutable projection, never a second lifecycle database. Git owns HEAD and worktree
 * identity, the validated workspace owns membership, and the accepted Story owns lifecycle state.
 * A command scope loads the projection lazily: unrelated/model-free commands pay no extra Git IO.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { SingularityFlowError } from './util.mjs';

import { executionContextRoot, executionContextScope } from './execution-context-scope.mjs';
import { findWorkspaceMembership } from './workspace-membership.mjs';
export { findWorkspaceMembership } from './workspace-membership.mjs';
export { executionContextArguments, surfaceContext, withExecutionContextScope,
  executionContextRoot, boundExecutionContextRoot, SURFACE_CONTEXT_ENV } from './execution-context-scope.mjs';
export const EXECUTION_CONTEXT_VERSION = 1;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const immutable = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
};

/** Pure assembly shared by shell, agent responses, snapshots, takeover and checkout inventory. */
export function projectExecutionContext({ identity, workspace = null, workflow = null,
  configurationPin = null, remote = null, observedAt = new Date().toISOString() }) {
  if (!identity?.root || !identity.commonDir || !identity.gitDir
      || !identity.repositoryInstanceId || !identity.worktreeInstanceId) {
    throw new SingularityFlowError('Git clone/worktree identity is unavailable.', {
      code: 'EXECUTION_CONTEXT_IDENTITY_REQUIRED'
    });
  }
  const work = workflow?.workItem ?? null;
  const repositoryId = workspace?.repositoryId ?? workflow?.resolution?.capability?.repositoryId ?? null;
  // The approved remote fingerprint remains stable when this clone is registered in a different
  // local workspace. Local clone IDs and the configured portable repository name stay separate.
  const logicalRepository = remote ? `repository-${digest([remote]).slice(0, 24)}` : null;
  const binding = work ? {
    repositoryId, logicalRepositoryId: logicalRepository,
    storyId: work.id, storyRef: work.branch ?? workflow?.lineage?.canonicalBranch ?? null,
    baseRef: work.baseBranch ?? null, baseCommit: work.baseCommit ?? null
  } : null;
  const facts = {
    workspace: workspace ? { id: workspace.workspaceId, path: workspace.workspacePath,
      manifestSha256: workspace.workspaceManifestSha256 ?? null } : null,
    repository: { id: repositoryId, logicalId: logicalRepository, remote },
    clone: { id: identity.repositoryInstanceId, commonDirectory: identity.commonDir },
    worktree: { id: identity.worktreeInstanceId, path: identity.root, gitDirectory: identity.gitDir,
      branch: identity.branch ?? null, head: identity.head ?? null,
      detached: identity.detached === true, bare: identity.bare === true },
    story: work ? { id: work.id, phase: workflow.currentPhase ?? null, status: workflow.status,
      revision: `sha256:${digest(workflow)}`,
      repositoryBindings: [...new Set([repositoryId,
        ...(workflow.resolution?.capability?.deliveries ?? []).flatMap(delivery => delivery.repositories ?? (delivery.repository ? [delivery.repository] : []))].filter(Boolean))]
        .map(id => id === repositoryId ? binding : { repositoryId: id, storyId: work.id,
          storyRef: workflow.lineage?.canonicalBranch ?? work.branch, baseRef: null, baseCommit: null }),
      configurationPin: structuredClone(configurationPin), binding } : null
  };
  return immutable({ schemaVersion: EXECUTION_CONTEXT_VERSION, resultType: 'execution-context',
    contextId: `context-${digest(facts)}`, ...facts,
    observation: { observedAt, remoteCheckedAt: null, remoteStatus: 'not-checked', mutationAuthority: false } });
}

export async function captureExecutionContext(root, { workspace = undefined, workflow = undefined,
  configurationPin = null, identity: suppliedIdentity = null, fresh = false, observedAt = undefined, revision = null } = {}) {
  const selected = path.resolve(root ?? executionContextRoot() ?? process.cwd());
  const scope = executionContextScope();
  // Passed lifecycle state belongs to one captured revision and must never be mixed with a later
  // state loaded by another slice. Only the root-only projection is invocation-memoized.
  const cacheable = !fresh && !workflow && workspace === undefined && !suppliedIdentity;
  if (cacheable && scope?.pending.has(selected)) return scope.pending.get(selected);
  const load = async () => {
    const { createRepoContext, repositoryInstanceIdentity } = await import('./repo-context.mjs');
    let identity = suppliedIdentity;
    if (!identity && revision) {
      const paths = await createRepoContext(selected).observe('repository.paths');
      identity = { ...paths, ...await repositoryInstanceIdentity(paths), root: selected,
        head: revision.head ?? null, branch: revision.branch ?? null, bare: false,
        detached: Boolean(revision.head && !revision.branch) };
    }
    identity ??= await createRepoContext(selected, { cache: false }).identity();
    let acceptedWorkflow = workflow, pin = configurationPin;
    if (acceptedWorkflow === undefined && identity.branch) {
      const { buildRepositorySubjectIndex, resolveContext } = await import('./repository-subject-index.mjs');
      let index;
      try { index = await buildRepositorySubjectIndex(identity.root); }
      catch (error) {
        if (error.code !== 'WORKFLOW_CONFIGURATION_MISSING'
            && !(error.code === 'ENOENT' && String(error.path).endsWith(`${path.sep}workflow.yml`))) throw error;
      }
      const subject = index ? resolveContext(index, { reference: identity.branch, kind: 'story', required: false }) : null;
      if (subject) {
        const accepted = await (await import('./accepted-story-execution.mjs')).loadAcceptedStoryExecution(identity.root, subject.id);
        acceptedWorkflow = accepted.workflow;
        pin ??= accepted.workflow.resolution?.configurationSource ?? null;
      }
    }
    let member = workspace;
    if (member === undefined) {
      member = await findWorkspaceMembership(identity.root, { identity });
    }
    const { configuredRemoteIdentity } = await import('./git-remote-diagnostics.mjs');
    const remote = configuredRemoteIdentity(identity.root, 'origin', { direction: 'fetch' }).url ?? null;
    const result = projectExecutionContext({ identity, workspace: member, workflow: acceptedWorkflow, configurationPin: pin, remote,
      ...(observedAt !== undefined ? { observedAt } : {}) });
    // A snapshot is not permission to route into an ancestor repository or a replaced checkout.
    const canonical = await realpath(selected);
    if (canonical !== await realpath(identity.root)) throw new SingularityFlowError(
      'The selected execution location is not its own Git worktree.', { code: 'EXECUTION_CONTEXT_ROOT_MISMATCH' });
    return result;
  };
  const pending = load();
  if (cacheable && scope) scope.pending.set(selected, pending);
  return pending;
}
