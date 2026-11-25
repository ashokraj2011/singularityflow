import { createHash } from 'node:crypto';
import path from 'node:path';
import { open } from 'node:fs/promises';
import { recordSha256 } from '../records.mjs';
import { secureRepositoryPath, SingularityFlowError } from '../util.mjs';

const commitId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const sourceError = (code, message) => new SingularityFlowError(message, { code });
const missing = () => sourceError('ASK_EVIDENCE_UNAVAILABLE', 'The exact evidence is unavailable in this checkout.');
const stale = () => sourceError('ASK_EVIDENCE_STALE', 'The source no longer matches the saved evidence revision.');

function evidenceEntry(ref) {
  return { id: 'ev-' + createHash('sha256').update(JSON.stringify(ref)).digest('hex').slice(0, 24), ref };
}

export function referencesFor(value, { emit = true } = {}) {
  const refs = [];
  const add = (row, ref) => {
    const link = evidenceEntry(ref);
    if (emit) row.evidenceId = link.id;
    refs.push(link);
  };
  if (value.work) add(value.work, {
    kind: 'work', workKind: value.work.kind, workId: value.work.id,
    commit: value.work.recordCommit ?? null, path: value.work.recordPath ?? null, sha256: value.work.recordSha256 ?? null
  });
  for (const spec of value.specifications ?? []) add(spec, {
    kind: 'spec', reference: spec.reference, stateCommit: spec.stateCommit,
    manifestSha256: spec.manifestSha256, contentSha256: spec.contentSha256
  });
  if (value.help) add(value.help, { kind: 'help', topic: value.help.id, sha256: value.help.sha256 });
  for (const row of value.history?.rows ?? []) {
    const scope = value.history.scope;
    if (value.history.provider === 'git') add(row, { kind: 'commit', commit: row.commit });
    else add(row, {
      kind: 'event', workKind: row.kind, workId: row.id, commit: row.commit, namespace: scope.namespace,
      snapshot: scope.snapshot, entryHash: row.entryHash, path: row.entryPath
    });
  }
  for (const row of value.comparison?.rows ?? []) add(row, {
    kind: 'diff', left: value.comparison.left.revision, right: value.comparison.right.revision,
    path: row.path, oldPath: row.oldPath ?? null, status: row.status
  });
  return refs;
}

async function exactWorkState(root, ref) {
  if (!ref.path || !ref.sha256) throw missing();
  let entry;
  if (ref.commit) {
    const { retainedSubjectAtCommit } = await import('./retained-history.mjs');
    const proof = retainedSubjectAtCommit(root, { kind: ref.workKind, id: ref.workId, commit: ref.commit });
    if (proof.status !== 'present') throw missing();
    entry = proof.entry;
  } else {
    const source = await secureRepositoryPath(root, ref.path, { label: 'Work evidence', type: 'file' });
    if (!source.exists) throw missing();
    const { parseSubjectStateRecord } = await import('../repository-subject-index.mjs');
    const file = await open(source.absolute, 'r');
    try {
      if ((await file.stat()).size > 4 * 1024 * 1024) throw missing();
      entry = parseSubjectStateRecord(ref.path, await file.readFile('utf8'), { directory: path.posix.basename(path.posix.dirname(ref.path)) });
    } finally { await file.close(); }
  }
  if (entry?.kind !== ref.workKind || entry.id !== ref.workId || entry.location.path !== ref.path ||
      recordSha256(entry.state) !== ref.sha256) throw stale();
  return entry.state;
}

export async function readEvidence(root, link, { audience, detail = true }) {
  const { ref, id } = link;
  const result = (value) => ({ id, kind: ref.kind, ...value });
  if (ref.kind === 'spec') {
    const { readPublishedSpecification } = await import('../spec-library/library.mjs');
    const { specificationResult } = await import('./read.mjs');
    const current = await readPublishedSpecification(root, ref.reference);
    if (current.manifestSha256 !== ref.manifestSha256 || current.manifest.files['spec.md'] !== ref.contentSha256) throw stale();
    const pinned = current.commit === ref.stateCommit ? current
      : await readPublishedSpecification(root, ref.reference, { pin: ref });
    let content = detail ? pinned.spec : null;
    let truncated = false;
    if (content !== null && audience !== 'person') {
      const { withholdForModel } = await import('../spec-library/share-check.mjs');
      const bytes = Buffer.from(withholdForModel(content).value);
      truncated = bytes.length > 2400;
      content = bytes.subarray(0, 2400).toString('utf8');
    }
    return result({ title: pinned.manifest.title, revision: pinned.commit, locator: ref.reference,
      specification: specificationResult(pinned), ...(content === null ? {} : { content, truncated }) });
  }
  if (ref.kind === 'help') {
    const { resolveHelp } = await import('../help-service.mjs');
    const help = await resolveHelp(ref.topic, { maxBytes: detail ? 2800 : 1100 });
    if (help.status !== 'resolved' || help.topic.id !== ref.topic) throw missing();
    if (help.topic.sha256 !== ref.sha256) throw stale();
    return result({ title: help.topic.title, revision: ref.sha256, locator: help.handle,
      ...(detail ? { content: help.served.text, truncated: help.served.truncated }
        : { help: { id: help.topic.id, title: help.topic.title, handle: help.handle, citation: help.citation,
          sha256: help.topic.sha256, text: help.served.text, truncated: help.served.truncated } }) });
  }
  if (ref.kind === 'commit') {
    if (!commitId.test(ref.commit)) throw missing();
    const { typedLog } = await import('../git-access.mjs');
    const row = typedLog(root, { revision: ref.commit, max: 1 }).commits[0];
    if (row?.commit !== ref.commit) throw stale();
    return result({ title: row.subject || ref.commit.slice(0, 12), revision: ref.commit, locator: 'commit',
      details: { committedAt: row.committedAt, authoredAt: row.authoredAt } });
  }
  if (ref.kind === 'event') {
    const { retainedEventAtSnapshot } = await import('./retained-history.mjs');
    const row = await retainedEventAtSnapshot(root, ref);
    if (!row) throw missing();
    return result({ title: row.title ?? row.id, revision: ref.snapshot, locator: ref.path,
      details: { workId: row.id, workKind: row.kind, event: row.event, eventAt: row.eventAt,
        sourceCommit: row.commit, entryHash: row.entryHash } });
  }
  if (ref.kind === 'work') {
    const record = await exactWorkState(root, ref);
    return result({ title: record.workItem?.title ?? record.initiative?.title ?? ref.workId,
      revision: ref.commit ?? 'sha256:' + ref.sha256,
      locator: ref.path, details: { id: ref.workId, status: record.status ?? record.state ?? null, phase: record.currentPhase ?? null,
        recordSha256: ref.sha256 } });
  }
  if (ref.kind === 'diff') {
    const { typedEndpointChanges } = await import('../git-access-history.mjs');
    const view = typedEndpointChanges(root, ref.left, ref.right, { relative: ref.path });
    const row = view.entries.find(item => item.path === ref.path);
    if (!row || row.status !== ref.status || (row.oldPath ?? null) !== ref.oldPath) throw stale();
    return result({ title: ref.path, revision: ref.right, locator: ref.path, details: { ...row, left: ref.left, right: ref.right } });
  }
  throw missing();
}

/** Walk an explicit Story-to-Spec binding at the selected work revision. */
export async function linkedSpecifications(root, link, audience) {
  const { ref } = link;
  const absent = () => sourceError('ASK_RELATION_UNAVAILABLE', 'The selected evidence does not establish a link to a specification.');
  if (ref.workKind !== 'story') throw absent();
  let state;
  if (ref.kind === 'work') state = await exactWorkState(root, ref);
  else if (ref.kind === 'event') {
    const { retainedEventAtSnapshot, retainedSubjectAtCommit } = await import('./retained-history.mjs');
    if (!await retainedEventAtSnapshot(root, ref)) throw missing();
    const observed = retainedSubjectAtCommit(root, { kind: 'story', id: ref.workId, commit: ref.commit });
    if (observed.status !== 'present') throw missing();
    state = observed.entry.state;
  } else throw absent();
  const pins = state.workItem?.source?.specification;
  if (!Array.isArray(pins) || !pins.length) throw absent();
  const { readPublishedSpecification } = await import('../spec-library/library.mjs');
  const specifications = [];
  for (const pin of pins.slice(0, 8)) {
    const current = await readPublishedSpecification(root, pin.revision);
    const saved = evidenceEntry({ kind: 'spec', reference: pin.revision, stateCommit: pin.stateCommit,
      manifestSha256: pin.manifestSha256, contentSha256: current.manifest.files['spec.md'] });
    const verified = await readEvidence(root, saved, { audience, detail: false });
    specifications.push(verified.specification);
  }
  return specifications;
}
