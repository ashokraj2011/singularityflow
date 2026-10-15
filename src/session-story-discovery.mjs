import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { committedFilesAtRevisions, fileAtRef, gitCommonDir, hasRemote } from './git.mjs';
import { ledgerStoryPointers } from './ledger.mjs';
import { normalizeLedgerConfig } from './ledger-config.mjs';
import { configuredRemoteIdentity } from './git-remote-diagnostics.mjs';
import {
  discoverRemoteStoryCandidatesByUrl, isStoryDiscoveryBranch, ledgerSummaryCandidate
} from './session-remote-url-discovery.mjs';
import { readRecord } from './schema-migrations.mjs';
import { storyLifecycleProgress } from './session-roster.mjs';
import { validateId } from './state-stores.mjs';
import { posix, SingularityFlowError } from './util.mjs';

/**
 * What a Story's exact committed state proved, kept for the next listing. `[perf]`
 *
 * A ledger entry written before Story summaries names only the Story's commit, so every listing
 * proved each such Story from that commit. A blobless clone, the usual office checkout, holds none
 * of those objects, and the bounded remote recovery fetched them into a temporary store it then
 * deleted: every listing (and every attach) paid seven round trips for the same immutable bytes,
 * about 11 s in the office. The proof depends only on the commit, so its row is kept by commit,
 * Story and branch; a pointer that moves is a new key, and a Story published since carries its
 * summary on the ledger. Only rows that passed the full proof are kept, the file holds only the
 * current roster's rows, and an unreadable or malformed file or row is ignored and rewritten.
 */
const PROVEN_FORMAT = 1;
const PROVEN_MAXIMUM_BYTES = 8 * 1024 * 1024;
const provenKey = (row) => `${row.commitOid}\0${row.id}\0${row.branch}`;
const provenText = (value) => typeof value === 'string' && value.length > 0;

function provenRow(item) {
  if (!item || !provenText(item.id) || !provenText(item.branch) || !provenText(item.title) || !provenText(item.status)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(item.commitOid ?? '')
      || !item.progress || typeof item.progress !== 'object' || Array.isArray(item.progress)
      || !(item.phase == null || typeof item.phase === 'string')
      || !(item.createdAt == null || typeof item.createdAt === 'string')
      || !Array.isArray(item.aliases) || !item.aliases.every(provenText)) return null;
  return {
    id: item.id, branch: item.branch, title: item.title, createdAt: item.createdAt ?? null,
    status: item.status, phase: item.phase ?? null, progress: item.progress,
    commit: item.commitOid.slice(0, 8), commitOid: item.commitOid, aliases: item.aliases
  };
}

function provenSummaries(root) {
  let file = null;
  try { file = path.join(gitCommonDir(root), 'singularity-flow', 'story-summaries.json'); } catch { return { file, rows: new Map() }; }
  try {
    const bytes = readFileSync(file);
    const parsed = bytes.length <= PROVEN_MAXIMUM_BYTES ? JSON.parse(bytes.toString('utf8')) : null;
    if (parsed?.format !== PROVEN_FORMAT || !Array.isArray(parsed.items)) return { file, rows: new Map() };
    return { file, rows: new Map(parsed.items.map(provenRow).filter(Boolean).map((row) => [provenKey(row), row])) };
  } catch {
    return { file, rows: new Map() };
  }
}

/** Keep the rows the unsummarized pointers proved; best effort, and unchanged rows are not rewritten. */
function rememberProvenSummaries(cache, kept, pointers, items, unavailable) {
  if (!cache.file) return;
  const rows = new Map(kept);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const pointer of pointers) {
    const item = byId.get(pointer.id);
    // A Story with any unreadable or conflicting claim is proven again, so its refusal stays.
    if (unavailable.some((entry) => entry.claimedId === pointer.id || entry.branch === pointer.branch)) continue;
    const row = item?.branch === pointer.branch && item.commitOid === pointer.commitOid ? provenRow(item) : null;
    if (row) rows.set(provenKey(row), row);
  }
  if (rows.size === cache.rows.size && [...rows.keys()].every((key) => cache.rows.has(key))) return;
  const temporary = `${cache.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(path.dirname(cache.file), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ format: PROVEN_FORMAT, items: [...rows.values()] })}\n`);
    renameSync(temporary, cache.file);
  } catch {
    // A busy file (Windows) or a read-only Git directory only means the next listing proves again.
    try { rmSync(temporary, { force: true }); } catch {}
  }
}

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
  const unavailable = [];
  const items = [];
  const pointers = [];
  const cache = provenSummaries(root);
  const kept = new Map();
  for (const pointer of roster.items.filter(item => isStoryDiscoveryBranch(item.branch))) {
    const summarized = ledgerSummaryCandidate(definition, pointer);
    const known = summarized ? null : cache.rows.get(provenKey(pointer));
    if (summarized) items.push(summarized);
    else if (known) { items.push(known); kept.set(provenKey(known), known); }
    else pointers.push(pointer);
  }
  const definitions = new Map();
  const files = new Map();
  const configurationBytes = committedFilesAtRevisions(root, pointers.map(item => ({
    key: `${item.commitOid}:${WORKFLOW_PATH}`, ref: item.commitOid, path: WORKFLOW_PATH
  })), { maximumObjectBytes: 1024 * 1024, maximumBytes: 64 * 1024 * 1024, requireCompleteRead: true });
  const requested = [];
  for (const pointer of pointers) {
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
  const stateBytes = committedFilesAtRevisions(root, requested, {
    maximumObjectBytes: 1024 * 1024, maximumBytes: 64 * 1024 * 1024, requireCompleteRead: true
  });
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
        createdAt: workflow.workItem.createdAt ?? null,
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
      const restored = [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
      rememberProvenSummaries(cache, kept, pointers, restored, [...remaining, ...recovered.unavailable]);
      return {
        source: 'materialized-metadata-recovery', repositoryPath: path.resolve(root),
        remote, fetched: fetch,
        count: merged.size, items: restored,
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
  rememberProvenSummaries(cache, kept, pointers, items, unavailable);
  return {
    source: 'state-ledger', stateRef: roster.ref,
    repositoryPath: path.resolve(root), remote, fetched: fetch,
    count: items.length, items: items.sort((left, right) => left.id.localeCompare(right.id)),
    unavailableCount: unavailable.length, unavailable
  };
}
