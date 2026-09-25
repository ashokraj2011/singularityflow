import path from 'node:path';
import YAML from 'yaml';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { fetchRemote, fileAtRef, hasRemote, remoteBranches } from './git.mjs';
import { configuredRemoteIdentity } from './git-remote-diagnostics.mjs';
import { buildRepositorySubjectIndexFromRefs } from './repository-subject-index.mjs';
import { discoverRemoteStoryCandidatesByUrl, isStoryDiscoveryBranch } from './session-remote-url-discovery.mjs';
import { validateId } from './state.mjs';
import { posix, SingularityFlowError } from './util.mjs';

/** Prove that a remote ref contains the Story it claims, under its own pinned definition. */
export function validatedRemoteStoryDefinition(root, remoteRef, subject) {
  const source = fileAtRef(root, remoteRef, WORKFLOW_PATH);
  if (source == null) throw new Error(`missing ${WORKFLOW_PATH}`);
  const definition = YAML.parse(source);
  validateDefinition(definition);
  validateId(definition, subject.id);
  const expectedPath = posix(path.join(
    definition.workItemRoot ?? 'singularity/work-items', subject.id, 'workflow.json'
  ));
  if (subject.location.path !== expectedPath) {
    throw new Error(`state path '${subject.location.path}' does not match pinned root '${expectedPath}'`);
  }
  const workflow = JSON.parse(fileAtRef(root, remoteRef, expectedPath) ?? 'null');
  if (workflow?.workItem?.id !== subject.id) throw new Error('identity mismatch');
  return { definition, workflow, itemPath: expectedPath };
}

/**
 * Fetch and enumerate published Stories in one already materialized delivery repository.
 * Fetch updates only remote-tracking refs; the checkout, branch and working tree are untouched.
 * A failed fetch is an error, never an empty Story list.
 */
export async function discoverRemoteStoryCandidates(root, definition, {
  fetch = true,
  remote = definition?.git?.remote ?? 'origin'
} = {}) {
  if (!root || !hasRemote(root, remote)) {
    throw new SingularityFlowError(
      `Repository '${root ?? 'unavailable'}' has no configured Story remote '${remote}'. Materialize or repair the delivery repository before refreshing Stories.`,
      { code: 'SESSION_REMOTE_NOT_CONFIGURED' }
    );
  }
  if (fetch) await fetchRemote(root, remote);
  const refs = remoteBranches(root, remote)
    .filter(isStoryDiscoveryBranch)
    .map((branch) => ({ branch, ref: `${remote}/${branch}` }));
  const index = await buildRepositorySubjectIndexFromRefs(root, { definition, refs });
  const unavailable = [...index.unreadable, ...(index.conflicts ?? [])];
  const items = [];
  for (const subject of index.list('story')) {
    try {
      const { workflow } = validatedRemoteStoryDefinition(root, subject.location.ref, subject);
      items.push({
        id: subject.id,
        branch: subject.canonicalBranch,
        title: workflow.workItem.title,
        status: workflow.status,
        phase: workflow.currentPhase,
        commit: subject.location.commit?.slice(0, 8) ?? ''
      });
    } catch (error) {
      unavailable.push({
        code: 'SESSION_STORY_INVALID',
        claimedId: subject.id,
        ref: subject.location.ref ?? null,
        branch: subject.location.branch ?? null,
        path: subject.location.path ?? null,
        reason: error.message
      });
    }
  }
  // A fresh blobless checkout has commits and trees but may not yet hold even workflow.json.
  // Local reads deliberately suppress implicit promisor fetches; recover through the bounded
  // metadata-only remote operation instead of downloading application source or calling an
  // unreadable Story absent. The existing validated local items survive a failed recovery.
  if (fetch && unavailable.some((entry) => (
    entry.branch && ['SUBJECT_STATE_UNAVAILABLE', 'SUBJECT_STATE_PARTIAL'].includes(entry.code)
  ))) {
    try {
      const identity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
      if (!identity.configured || identity.ambiguous) throw new SingularityFlowError(
        'The Story remote has no single configured fetch authority.',
        { code: 'GIT_REMOTE_CONFIG_INVALID' }
      );
      const recovered = await discoverRemoteStoryCandidatesByUrl(identity.url, {
        // The caller loaded this through its selected approved configuration authority. A
        // delivery repository can be separate from that lead and need not own sflow/config.
        approvedDefinition: definition
      });
      const restoredBranches = new Set(recovered.items.map((item) => item.branch));
      const merged = new Map(items.map((item) => [item.id, item]));
      for (const item of recovered.items) merged.set(item.id, item);
      const remaining = unavailable.filter((entry) => !restoredBranches.has(entry.branch)
        && !recovered.unavailable.some((failure) => failure.branch === entry.branch
          && failure.path === entry.path));
      return {
        source: 'materialized-metadata-recovery', repositoryPath: path.resolve(root),
        remote, fetched: fetch,
        count: merged.size, items: [...merged.values()].sort((left, right) => left.id.localeCompare(right.id)),
        unavailableCount: remaining.length + recovered.unavailable.length,
        unavailable: [...remaining, ...recovered.unavailable]
      };
    } catch (error) {
      unavailable.push({
        code: 'SESSION_METADATA_RECOVERY_UNAVAILABLE', claimedId: null, ref: null,
        branch: null, path: null,
        reason: `Bounded metadata-only recovery could not complete (${error.code ?? 'unknown'}).`
      });
    }
  }
  return {
    repositoryPath: path.resolve(root), remote, fetched: fetch,
    count: items.length, items,
    unavailableCount: unavailable.length, unavailable
  };
}
