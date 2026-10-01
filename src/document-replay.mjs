/**
 * Recover a document upload that lost a publication race.
 *
 * Two clones of one Story can each add a document before either pushes. Both take the next free
 * `DOC-nnn`; the first push lands and the second is rejected, leaving its commit retained locally
 * behind a pending-publication marker that blocks every later change, while `sync` can only retry
 * the same, now diverged, commit. This replays that upload instead: the same files, names, phases,
 * storage and kind are added again on top of the published Story, so they take the next IDs free
 * there, and the result is published as one new governed commit.
 *
 * Only a plain upload replays. Anything else in the retained commit (a provider fetch, a detach, a
 * phase change) is left for a person, and nothing moves. The retained commit is kept under
 * `refs/sflow-replayed/<WORK-ID>/<commit>`; if the replayed upload cannot be recorded, the branch
 * and the pending marker are put back exactly as they were.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { addDocuments } from './documents.mjs';
import { documentNameKey } from './document-identity.mjs';
import { documentSetLifecycleBinding } from './document-publication.mjs';
import { isLocalDocument, readLocalDocument } from './document-storage.mjs';
import {
  assertClean, exactFileAtObject, fetchRemote, gitCommonDir, head, isAncestor, moveCheckedOutBranch,
  preserveCommitRef, refHead
} from './git.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { clearPendingPublication, readPendingPublication } from './publication-pending.mjs';
import { readRecord } from './schema-migrations.mjs';
import { commitAndPublish, loadStoryAggregate, workDir, workDirRelative } from './state-stores.mjs';
import { SingularityFlowError } from './util.mjs';

const MAXIMUM_DOCUMENT_BYTES = 256 * 1024 * 1024;

function catalogAt(root, config, workId, commit) {
  const relative = `${workDirRelative(config, workId)}/documents.json`;
  const bytes = exactFileAtObject(root, commit, relative, { maximumBytes: 64 * 1024 * 1024 });
  if (!bytes) return { documents: [], packages: [] };
  const record = readRecord('document-manifest', bytes).record;
  return { documents: record.documents ?? [], packages: record.packages ?? [] };
}

/** The top-level inputs one upload was made of, in the order its documents were numbered. */
function uploadInputs(added, packages) {
  const inputs = [];
  const seenPackages = new Set();
  for (const record of added) {
    if (record.packageId) {
      if (seenPackages.has(record.packageId)) continue;
      seenPackages.add(record.packageId);
      const pkg = packages.find((entry) => entry.id === record.packageId);
      inputs.push({ type: 'package', package: pkg ?? null, members: added.filter((entry) => entry.packageId === record.packageId) });
    } else {
      inputs.push({ type: record.type === 'url' ? 'url' : 'file', record });
    }
  }
  return inputs;
}

function inputNames(input) {
  if (input.type === 'package') return [input.package?.name, ...input.members.map((member) => member.name)].filter(Boolean);
  return [input.record.name].filter(Boolean);
}

/**
 * What a replay would do, changing nothing: `{ replayable, reason, commit, parent, remoteTip,
 * documents, collisions }`. It fetches the Story's remote branch to see where it now is.
 */
export async function planDocumentReplay(root, config, workflow) {
  const workId = workflow.workItem.id;
  const pending = await readPendingPublication(root, {
    kind: 'story', id: workId, legacyPath: path.join(workDir(root, config, workId), 'publication-pending.json')
  });
  const refuse = (reason, extra = {}) => ({ replayable: false, reason, pending, ...extra });
  if (!pending) return refuse('no-pending-publication');
  const record = pending.record ?? {};
  const commit = record.commit;
  if (record.event?.type !== LIFECYCLE_EVENT.EVIDENCE_RECORDED || record.event?.payload?.operation !== 'document-upload') {
    return refuse('not-a-document-upload', { commit, operation: record.event?.payload?.operation ?? record.event?.type ?? null });
  }
  if (!/^[0-9a-f]{40,64}$/u.test(String(commit ?? '')) || head(root) !== commit) return refuse('branch-moved', { commit });
  const parent = refHead(root, `${commit}^`);
  if (!parent || refHead(root, `${commit}^2`)) return refuse('not-a-single-parent-commit', { commit });
  const remote = record.remote ?? config.git?.remote ?? 'origin';
  const branch = record.branch ?? workflow.workItem.branch ?? workId;
  await fetchRemote(root, remote);
  const remoteTip = refHead(root, `refs/remotes/${remote}/${branch}`);
  if (!remoteTip) return refuse('remote-branch-missing', { commit, remote, branch });
  if (remoteTip === commit || isAncestor(root, commit, remoteTip)) return refuse('already-published', { commit, remoteTip });
  if (remoteTip === parent || !isAncestor(root, parent, remoteTip)) {
    // Not a lost race: the remote either has not moved (sync retries the push) or was rewritten.
    return refuse(remoteTip === parent ? 'remote-not-advanced' : 'remote-history-rewritten', { commit, parent, remoteTip });
  }
  const before = catalogAt(root, config, workId, parent);
  const mine = catalogAt(root, config, workId, commit);
  const theirs = catalogAt(root, config, workId, remoteTip);
  const previous = new Set(before.documents.map((entry) => entry.id));
  const added = mine.documents.filter((entry) => !previous.has(entry.id));
  if (!added.length) return refuse('no-documents-added', { commit, parent, remoteTip });
  if (added.some((entry) => entry.remote)) return refuse('provider-fetch', { commit, parent, remoteTip });
  const inputs = uploadInputs(added, mine.packages);
  const taken = new Map(theirs.documents.map((entry) => [documentNameKey(entry.name ?? entry.label ?? entry.id), entry.id]));
  const collisions = inputs.flatMap(inputNames)
    .filter((name) => taken.has(documentNameKey(name)))
    .map((name) => ({ name, takenBy: taken.get(documentNameKey(name)) }));
  return {
    replayable: collisions.length === 0,
    reason: collisions.length ? 'name-taken' : null,
    pending, commit, parent, remoteTip, remote, branch, inputs, collisions,
    documents: added.map((entry) => ({ id: entry.id, name: entry.name ?? null, storage: entry.storage?.kind ?? (entry.type === 'url' ? null : 'git') }))
  };
}

async function documentBytes(root, workId, commit, record) {
  if (isLocalDocument(record)) return (await readLocalDocument(root, workId, record)).bytes;
  const bytes = exactFileAtObject(root, commit, record.path, { maximumBytes: MAXIMUM_DOCUMENT_BYTES });
  if (!bytes) throw new SingularityFlowError(`The retained commit no longer holds ${record.id} (${record.path}).`, { code: 'DOCUMENT_REPLAY_UNAVAILABLE' });
  return bytes;
}

/** Recreate each input's files under `directory` and return the addDocuments options for each. */
async function materializeInputs(root, workId, commit, inputs, directory) {
  const options = [];
  for (const [index, input] of inputs.entries()) {
    const slot = path.join(directory, String(index));
    if (input.type === 'url') {
      const { record } = input;
      options.push({ url: record.url, names: [record.name ?? record.label], kind: record.kind ?? null, phases: record.phases ?? null });
      continue;
    }
    if (input.type === 'file') {
      const { record } = input;
      const file = path.join(slot, path.basename(record.sourceName ?? record.path ?? record.id));
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, await documentBytes(root, workId, commit, record), { mode: 0o600 });
      options.push({
        files: [file], names: [record.name ?? record.label], kind: record.kind ?? null,
        phases: record.phases ?? null, store: record.storage?.kind ?? 'git'
      });
      continue;
    }
    const folder = path.join(slot, input.package?.sourceName ?? input.members[0]?.sourcePackage ?? 'package');
    for (const member of input.members) {
      const file = path.join(folder, ...String(member.sourceRelativePath ?? member.sourceName).split('/'));
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, await documentBytes(root, workId, commit, member), { mode: 0o600 });
    }
    const first = input.members[0] ?? {};
    options.push({
      files: [folder], names: [input.package?.name ?? first.sourcePackage],
      kind: first.kind === 'directory-import' ? null : first.kind ?? null, phases: first.phases ?? null, store: 'git'
    });
  }
  return options;
}

const REASONS = Object.freeze({
  'no-pending-publication': 'this Story has no retained commit to replay',
  'not-a-document-upload': 'the retained commit is not a document upload, so it cannot be replayed automatically',
  'branch-moved': 'the checked-out branch is no longer at the retained commit',
  'not-a-single-parent-commit': 'the retained commit is not a single-parent governed commit',
  'remote-branch-missing': 'the Story branch is not on its remote',
  'already-published': 'the retained commit is already on the remote; run singularity-flow sync',
  'remote-not-advanced': 'nobody else has published to the Story; run singularity-flow sync to retry the push',
  'remote-history-rewritten': 'the remote branch no longer contains the commit this one was made on',
  'no-documents-added': 'the retained commit adds no documents',
  'provider-fetch': 'it holds a document fetched from a provider, which only documents fetch can record',
  'name-taken': 'a document on the published Story already uses one of its names'
});

export function documentReplayReason(plan) {
  const base = REASONS[plan.reason] ?? plan.reason;
  return plan.reason === 'name-taken'
    ? `${base}: ${plan.collisions.map((entry) => `'${entry.name}' (${entry.takenBy})`).join(', ')}`
    : base;
}

/**
 * Replay the retained document upload onto the published Story, or with `dryRun` say what would
 * happen. Returns `{ replayed, from, publication, documents }`.
 */
export async function replayPendingDocumentUpload(root, config, workflow, { dryRun = false } = {}) {
  const plan = await planDocumentReplay(root, config, workflow);
  if (dryRun) return { dryRun: true, ...plan, pending: undefined, inputs: undefined };
  if (!plan.replayable) {
    throw new SingularityFlowError(`The retained commit cannot be replayed: ${documentReplayReason(plan)}. Nothing was changed.`, {
      code: 'DOCUMENT_REPLAY_REFUSED', details: { reason: plan.reason, commit: plan.commit ?? null, collisions: plan.collisions ?? [] }
    });
  }
  assertClean(root);
  const workId = workflow.workItem.id;
  const markerBytes = await readFile(plan.pending.path);
  preserveCommitRef(root, `refs/sflow-replayed/${workId}/${plan.commit}`, plan.commit);
  const directory = path.join(gitCommonDir(root), 'singularity-flow', `document-replay-${randomUUID()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const options = await materializeInputs(root, workId, plan.commit, plan.inputs, directory);
    moveCheckedOutBranch(root, plan.remoteTip);
    await clearPendingPublication(root, {
      kind: 'story', id: workId, legacyPath: path.join(workDir(root, config, workId), 'publication-pending.json')
    });
    try {
      const published = await loadStoryAggregate(root, config, workId);
      let created = [];
      const publication = await commitAndPublish(
        root, config, published,
        { type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, payload: { operation: 'document-upload' } },
        `[${workId}][documents][upload] governed evidence (replayed from ${plan.commit.slice(0, 8)})`,
        [],
        {
          beforeStateWrite: async () => {
            created = [];
            for (const option of options) created.push(...await addDocuments(root, config, published, option));
            return created;
          },
          eventFromResult: (records) => ({ payload: { operation: 'document-upload', ...documentSetLifecycleBinding(records ?? []) } })
        }
      );
      return {
        replayed: true, from: plan.commit, preservedRef: `refs/sflow-replayed/${workId}/${plan.commit}`, publication,
        documents: plan.documents.map((entry) => ({
          previousId: entry.id, id: created.find((candidate) => candidate.name === entry.name)?.id ?? null, name: entry.name
        }))
      };
    } catch (error) {
      // Nothing new was committed: put the branch and its marker back exactly as they were.
      if (head(root) === plan.remoteTip) {
        moveCheckedOutBranch(root, plan.commit);
        await mkdir(path.dirname(plan.pending.path), { recursive: true });
        await writeFile(plan.pending.path, markerBytes);
      }
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
