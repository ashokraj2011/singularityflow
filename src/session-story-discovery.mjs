import path from 'node:path';
import YAML from 'yaml';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { fetchRemote, fileAtRef, hasRemote, remoteBranches } from './git.mjs';
import { buildRepositorySubjectIndexFromRefs } from './repository-subject-index.mjs';
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
  return {
    repositoryPath: path.resolve(root), remote, fetched: fetch,
    count: items.length, items,
    unavailableCount: unavailable.length, unavailable
  };
}
