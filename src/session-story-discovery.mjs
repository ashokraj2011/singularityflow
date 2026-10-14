import path from 'node:path';
import YAML from 'yaml';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { committedFilesAtRevisions, fileAtRef, hasRemote } from './git.mjs';
import { ledgerStoryPointers } from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { configuredRemoteIdentity } from './git-remote-diagnostics.mjs';
import { discoverRemoteStoryCandidatesByUrl, isStoryDiscoveryBranch } from './session-remote-url-discovery.mjs';
import { readRecord } from './schema-migrations.mjs';
import { storyLifecycleProgress } from './session-roster.mjs';
import { validateId } from './state-stores.mjs';
import { posix, SingularityFlowError } from './util.mjs';

/**
 * Prove that a remote ref contains the Story it claims, under its own pinned definition.
 *
 * `files` holds bytes discovery already read, by `<commit>:<path>`, and `definitions` the
 * definitions already validated, by their exact text; both only save repeating the same work for
 * the same bytes. Anything absent from them is read from the ref as before.
 */
export function validatedRemoteStoryDefinition(root, remoteRef, subject, { files = null, definitions = null } = {}) {
  const at = (relative) => files?.get(`${subject.location?.commit}:${relative}`) ?? fileAtRef(root, remoteRef, relative);
  const source = at(WORKFLOW_PATH);
  if (source == null) throw new Error(`missing ${WORKFLOW_PATH}`);
  let definition = definitions?.get(source);
  if (!definition) {
    definition = YAML.parse(source);
    validateDefinition(definition);
    definitions?.set(source, definition);
  }
  validateId(definition, subject.id);
  const expectedPath = posix(path.join(
    definition.workItemRoot ?? 'singularity/work-items', subject.id, 'workflow.json'
  ));
  if (subject.location.path !== expectedPath) {
    throw new Error(`state path '${subject.location.path}' does not match pinned root '${expectedPath}'`);
  }
  const retainedWorkflow = JSON.parse(at(expectedPath) ?? 'null');
  const workflow = readRecord('story-workflow', retainedWorkflow).record;
  if (workflow?.workItem?.id !== subject.id) throw new Error('identity mismatch');
  return { definition, workflow, retainedWorkflow, itemPath: expectedPath };
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
  // Story lifecycle entries are owned by the ledger, even if World Model uses a different ref.
  const authority = normalizeLedgerConfig(definition.ledger ?? {});
  let roster;
  try {
    roster = await ledgerStoryPointers(root, authority, { offline: !fetch });
  } catch (error) {
    throw new SingularityFlowError(
      `Story discovery requires the governed '${authority.branch}' state index. Refresh or reconcile the ledger; no application branches were scanned. ${error.message}`,
      { code: error.code ?? 'SESSION_STATE_INDEX_UNAVAILABLE' }
    );
  }
  const pointers = roster.items.filter(item => isStoryDiscoveryBranch(item.branch));
  const unavailable = [];
  const items = [];
  const legacyPointers = [];
  for (const pointer of pointers) {
    if (pointer.story) {
      items.push({
        id: pointer.story.id,
        branch: pointer.story.branch,
        title: pointer.story.title,
        status: pointer.story.status,
        phase: pointer.story.phase,
        progress: pointer.story.progress,
        commit: pointer.story.commit,
        commitOid: pointer.story.commitOid,
        aliases: pointer.story.aliases
      });
    } else {
      legacyPointers.push(pointer);
    }
  }
  const definitions = new Map();
  const files = new Map();
  const configurationBytes = legacyPointers.length
    ? committedFilesAtRevisions(root, legacyPointers.map(item => ({
      key: `${item.commitOid}:${WORKFLOW_PATH}`, ref: item.commitOid, path: WORKFLOW_PATH
    })), { maximumObjectBytes: 1024 * 1024, maximumBytes: 64 * 1024 * 1024, requireCompleteRead: true })
    : new Map();
  const requested = [];
  for (const pointer of legacyPointers) {
    const source = configurationBytes.get(`${pointer.commitOid}:${WORKFLOW_PATH}`)?.toString('utf8');
    if (!source) {
      unavailable.push({ code: 'SUBJECT_STATE_UNAVAILABLE', claimedId: pointer.id, branch: pointer.branch,
        ref: pointer.commitOid, path: WORKFLOW_PATH, reason: 'The state-indexed configuration object is unavailable locally.' });
      continue;
    }
    try {
      let pinned = definitions.get(source);
      if (!pinned) { pinned = YAML.parse(source); validateDefinition(pinned); definitions.set(source, pinned); }
      validateId(pinned, pointer.id);
      const relative = posix(path.join(pinned.workItemRoot ?? 'singularity/work-items', pointer.id, 'workflow.json'));
      files.set(`${pointer.commitOid}:${WORKFLOW_PATH}`, source);
      requested.push({ key: `${pointer.commitOid}:${relative}`, ref: pointer.commitOid, path: relative, pointer });
    } catch (error) {
      unavailable.push({ code: 'SESSION_STORY_INVALID', claimedId: pointer.id, branch: pointer.branch,
        ref: pointer.commitOid, path: WORKFLOW_PATH, reason: error.message });
    }
  }
  const stateBytes = requested.length
    ? committedFilesAtRevisions(root, requested, {
      maximumObjectBytes: 1024 * 1024, maximumBytes: 64 * 1024 * 1024, requireCompleteRead: true
    })
    : new Map();
  for (const { pointer, path: relative, key } of requested) {
    const bytes = stateBytes.get(key);
    if (!bytes) {
      unavailable.push({ code: 'SUBJECT_STATE_UNAVAILABLE', claimedId: pointer.id, branch: pointer.branch,
        ref: pointer.commitOid, path: relative, reason: 'The state-indexed Story object is unavailable locally.' });
      continue;
    }
    files.set(key, bytes.toString('utf8'));
    const subject = { id: pointer.id, location: { commit: pointer.commitOid, ref: pointer.commitOid, path: relative } };
    try {
      const { workflow, retainedWorkflow } = validatedRemoteStoryDefinition(root, subject.location.ref, subject,
        { files, definitions });
      const canonicalBranch = workflow.lineage?.canonicalBranch ?? workflow.workItem.branch ?? workflow.workItem.id;
      if (canonicalBranch !== pointer.branch || !workflow.phases || !Array.isArray(workflow.phaseOrder)) throw new Error('Story ownership does not match its state-ledger location.');
      items.push({
        id: subject.id,
        branch: canonicalBranch,
        title: workflow.workItem.title,
        status: workflow.status,
        phase: workflow.currentPhase,
        progress: storyLifecycleProgress(retainedWorkflow),
        commit: subject.location.commit?.slice(0, 8) ?? '',
        commitOid: subject.location.commit,
        aliases: [workflow.lineage?.planId, workflow.lineage?.jiraIssueId, workflow.lineage?.sourceStableId,
          workflow.workItem?.source?.stableId, workflow.lineage?.initialJiraKey, workflow.lineage?.currentJiraKey,
          ...(workflow.lineage?.aliases ?? []).map(entry => typeof entry === 'string' ? entry : entry?.value ?? entry?.key)].filter(Boolean)
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
  items.sort((left, right) => left.id.localeCompare(right.id));
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
    source: 'state-ledger', stateRef: roster.ref,
    repositoryPath: path.resolve(root), remote, fetched: fetch,
    count: items.length, items,
    unavailableCount: unavailable.length, unavailable
  };
}
