/**
 * The specification library on the state branch (SPEC-SPA v1.3 §8; v1.2 REQ-015 to REQ-020).
 *
 * A revision is one directory, `singularity/specifications/<SPEC-ID>/<NNNNNN>/`, holding exactly
 * manifest.json, spec.md, gaps.json, research.json and quality.json. It is published in one commit
 * through `publishToStateBranch`, with the manifest path as an `absent` precondition and the exact
 * SHA-256 of every file, so a revision is never rewritten. There is no catalog file: the library is
 * the directory listing at one pinned state commit, so publications of different specifications
 * touch disjoint paths and never contend on a shared index.
 *
 * A read pins one state commit and reads every file of a revision from it, verifying the manifest's
 * digests. It tells apart: no such specification or revision, the state branch unreachable, and a
 * missing or altered file. It never shows a partial revision, and never reports "no specifications"
 * when the branch could not be read.
 */
import { createHash } from 'node:crypto';

import { committedFileBytes, committedTreePaths, refCommit } from '../git.mjs';
import { normalizeLedgerConfig } from '../ledger-config.mjs';
import { canonicalJson } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import { LIBRARY_ROOT, REVISION_FILES, revisionDirectory } from './ids.mjs';

export const MANIFEST_FAMILY = 'spec-manifest';
export const GAP_LEDGER_FAMILY = 'spec-gap-ledger';
export const RESEARCH_FAMILY = 'spec-research';
export const QUALITY_FAMILY = 'spec-quality';
export const REVIEW_STATES = Object.freeze(['reviewed', 'draft']);
// SF Guard's seal for a revision (SPEC-PSS-v1 §10.9): beside its files, never one of REVISION_FILES.
export const REVISION_SEAL_FILE = 'presence.json';
const PUBLISH_ATTEMPTS = 3;
const REVISION_PATH = new RegExp(`^${LIBRARY_ROOT}/(SPEC-[A-Z0-9]+(?:-[A-Z0-9]+)*)/(\\d{6})/manifest\\.json$`, 'u');

const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = (message, code, details = {}) => { throw new SingularityFlowError(message, { code, details }); };

function unavailable(ledger, detail, result = null) {
  return new SingularityFlowError(`The specification library on the ${ledger.branch} branch of ${ledger.remote} cannot be read: ${detail}. Nothing is shown rather than an empty library; try again once the remote answers.`, {
    code: 'SPEC_LIBRARY_UNAVAILABLE', details: { branch: ledger.branch, remote: ledger.remote, ...(result ? { diagnostic: { status: result.status, signal: result.signal ?? null, errorCode: result.error?.code ?? null, timeout: result.timedOut === true || result.error?.code === 'ETIMEDOUT' } } : {}), nextAction: 'singularity-flow spec author list' }
  });
}

/**
 * Pin the library: refresh the configured state branch from its remote (or read the local branch when
 * the repository has no such remote) and list every revision at that one commit.
 */
export async function libraryView(root, config, { env = process.env, refresh = true } = {}) {
  const ledger = normalizeLedgerConfig(config?.ledger ?? {});
  let ref = `refs/heads/${ledger.branch}`;
  const [{ configuredRemoteIdentity, frozenRemoteTransport }, { runRemoteGitAsync }] = await Promise.all([
    import('../git-remote-diagnostics.mjs'), import('../git-execution.mjs')]);
  const identity = configuredRemoteIdentity(root, ledger.remote, { direction: 'fetch', env });
  if (identity.configured) {
    if (identity.ambiguous) throw unavailable(ledger, 'the remote has more than one fetch URL');
    // The frozen transport's environment carries an attestation the Git boundary checks: pass it as is.
    const transport = frozenRemoteTransport(identity.url, { env });
    ref = `refs/remotes/${ledger.remote}/${ledger.branch}`;
    if (refresh) {
      const fetched = await runRemoteGitAsync(['fetch', '--no-tags', '--', transport.remote, `+refs/heads/${ledger.branch}:${ref}`],
        { cwd: root, operation: 'remote-configuration', env: transport.env });
      if (fetched.status !== 0) {
        const listed = await runRemoteGitAsync(['ls-remote', '--heads', '--', transport.remote, `refs/heads/${ledger.branch}`],
          { cwd: root, operation: 'remote-configuration', env: transport.env });
        if (listed.status === 0 && !listed.stdout.trim()) return { ledger, ref, commit: null, status: 'absent', specs: new Map() };
        throw unavailable(ledger, String(fetched.stderr || fetched.stdout || 'the fetch failed').trim().split(/\r?\n/u).at(-1), fetched);
      }
    }
  }
  const commit = refCommit(root, ref, { env });
  if (!commit) return { ledger, ref, commit: null, status: identity.configured && !refresh ? 'not-fetched' : 'absent', specs: new Map() };
  const specs = new Map();
  for (const file of committedTreePaths(root, commit, [LIBRARY_ROOT], { env })) {
    const match = REVISION_PATH.exec(file);
    if (!match) continue;
    if (!specs.has(match[1])) specs.set(match[1], []);
    specs.get(match[1]).push(Number(match[2]));
  }
  for (const list of specs.values()) list.sort((left, right) => left - right);
  return { ledger, ref, commit, status: 'available', specs };
}

function invalid(specId, revision, detail) {
  return new SingularityFlowError(`${specId}@${revision} in the specification library is damaged: ${detail}. Nothing of it is shown.`, {
    code: 'SPEC_LIBRARY_REVISION_INVALID', details: { specId, revision, nextAction: `singularity-flow spec author list` }
  });
}

function requireListed(view, specId, revision) {
  if (!view.commit || !(view.specs.get(specId) ?? []).includes(revision)) {
    fail(`${specId}@${revision} is not in the specification library.`, 'SPEC_LIBRARY_NOT_FOUND',
      { specId, revision, nextAction: `singularity-flow spec author show ${specId}` });
  }
}

function parsedManifest(specId, revision, bytes) {
  if (!bytes) throw invalid(specId, revision, 'its manifest is missing');
  let manifest;
  try { manifest = readRecord(MANIFEST_FAMILY, bytes).record; }
  catch (error) { if (error?.code === 'SCHEMA_VERSION_FUTURE') throw error; throw invalid(specId, revision, `its manifest cannot be read (${error.message})`); }
  if (manifest.specId !== specId || manifest.revision !== revision) throw invalid(specId, revision, 'its manifest names a different revision');
  return manifest;
}

/** One revision's manifest only, from the pinned commit. */
export function readManifest(root, view, specId, revision, { env = process.env } = {}) {
  requireListed(view, specId, revision);
  const bytes = committedFileBytes(root, view.commit, `${revisionDirectory(specId, revision)}/manifest.json`, { env });
  return { specId, revision, manifest: parsedManifest(specId, revision, bytes), manifestSha256: bytes ? digest(bytes) : null };
}

/** A revision's SF Guard seal file at the pinned commit, or null when it has none. */
export function readRevisionSeal(root, view, specId, revision, { env = process.env } = {}) {
  return committedFileBytes(root, view.commit, `${revisionDirectory(specId, revision)}/${REVISION_SEAL_FILE}`, { env }) ?? null;
}

/** One whole revision from the pinned commit, every file verified against the manifest. */
export function readRevision(root, view, specId, revision, { env = process.env } = {}) {
  requireListed(view, specId, revision);
  const directory = revisionDirectory(specId, revision);
  const bytes = Object.fromEntries(REVISION_FILES.map((name) => [name, committedFileBytes(root, view.commit, `${directory}/${name}`, { env })]));
  const manifest = parsedManifest(specId, revision, bytes['manifest.json']);
  for (const name of REVISION_FILES.slice(1)) {
    if (!bytes[name]) throw invalid(specId, revision, `${name} is missing`);
    if (digest(bytes[name]) !== manifest.files?.[name]) throw invalid(specId, revision, `${name} does not match its manifest digest`);
  }
  const record = (family, name) => {
    try { return readRecord(family, bytes[name]).record; }
    catch (error) { if (error?.code === 'SCHEMA_VERSION_FUTURE') throw error; throw invalid(specId, revision, `${name} cannot be read (${error.message})`); }
  };
  return {
    specId, revision, commit: view.commit, manifest, manifestSha256: digest(bytes['manifest.json']),
    spec: bytes['spec.md'].toString('utf8'),
    gaps: record(GAP_LEDGER_FAMILY, 'gaps.json'),
    research: record(RESEARCH_FAMILY, 'research.json'),
    quality: record(QUALITY_FAMILY, 'quality.json')
  };
}

/** `SPEC-ID@N` exactly, or without a revision the highest reviewed one (the highest of any with `anyState`). */
export function resolveRevision(root, view, specId, revision = null, { anyState = false, env = process.env } = {}) {
  const revisions = view.specs.get(specId) ?? [];
  if (!revisions.length) {
    fail(`${specId} is not in the specification library${view.status === 'absent' ? ' (nothing has been published yet)' : ''}.`, 'SPEC_LIBRARY_NOT_FOUND',
      { specId, nextAction: 'singularity-flow spec author list' });
  }
  if (revision !== null) return readRevision(root, view, specId, revision, { env });
  for (const candidate of [...revisions].reverse()) {
    if (anyState || readManifest(root, view, specId, candidate, { env }).manifest.reviewState === 'reviewed') {
      return readRevision(root, view, specId, candidate, { env });
    }
  }
  fail(`${specId} has no reviewed revision yet; its revisions are drafts (${revisions.map((entry) => `@${entry}`).join(', ')}).`, 'SPEC_LIBRARY_NOT_REVIEWED',
    { specId, nextAction: `singularity-flow spec author show ${specId}@${revisions.at(-1)}` });
}

/** The exact files of the next revision, built from a draft head and its check report. */
export function revisionFiles({ specId, revision, parent, reviewState, operationId, actor, recordedAt, head, report }) {
  const stamp = (family, value) => ({ schemaVersion: currentSchemaVersion(family), ...value });
  const spec = Buffer.from(head.draft.spec, 'utf8');
  const gaps = Buffer.from(canonicalJson(stamp(GAP_LEDGER_FAMILY, { specId, revision, events: head.draft.gaps })), 'utf8');
  const research = Buffer.from(canonicalJson(stamp(RESEARCH_FAMILY, { specId, revision, items: head.draft.research })), 'utf8');
  const quality = Buffer.from(canonicalJson(stamp(QUALITY_FAMILY, { ...report, specId, revision })), 'utf8');
  const manifest = stamp(MANIFEST_FAMILY, {
    specId, revision, title: head.draft.title, kind: head.draft.kind ?? null, reviewState, operationId,
    ...(head.draft.origins?.length ? { origins: head.draft.origins, originCoverage: report.originCoverage ?? [] } : {}),
    ...(head.draft.sources?.length ? { sources: head.draft.sources } : {}),
    parentRevision: parent?.revision ?? null, parentManifestSha256: parent?.manifestSha256 ?? null,
    // A split's child (split.mjs).
    ...(head.draft.derivedFrom ? { derivedFrom: head.draft.derivedFrom } : {}),
    publishedBy: actor ? { name: actor.name ?? null, email: actor.email ?? null } : null, recordedAt,
    draft: { sequence: head.sequence, snapshotSha256: head.snapshotSha256 },
    quality: { d: report.counts.d, a: report.counts.a, h: report.counts.h, blocking: report.blocking.length },
    files: { 'spec.md': digest(spec), 'gaps.json': digest(gaps), 'research.json': digest(research), 'quality.json': digest(quality) }
  });
  const files = { 'manifest.json': Buffer.from(canonicalJson(manifest), 'utf8'), 'spec.md': spec, 'gaps.json': gaps, 'research.json': research, 'quality.json': quality };
  return { manifest, files };
}

async function ownSnapshot(root, specId, draft, snapshotSha256) {
  const history = draft.historyChecked === false ? await (await import('./draft-store.mjs')).readDraft(root, specId) : draft;
  return (history?.snapshots ?? []).some((snapshot) => snapshot.snapshotSha256 === snapshotSha256);
}

/**
 * Publish the draft head as the next revision. Retries a bounded number of times when another
 * publication moved the branch first; refuses a revision of this specification someone else
 * published since this draft was based; returns the revision already published by this same
 * operation (a lost acknowledgement) instead of publishing twice.
 */
export async function publishRevision(root, config, { specId, draft, report, reviewState, operationId, actor, command, seal = null, env = process.env }) {
  const { assertFilesShareable, publishCheckedFiles } = await import('./share-check.mjs');
  const shipping = { specId, verb: 'published', code: 'SPEC_PUBLISH_SECRET' };
  const head = draft.head;
  // The revision's files and its SF Guard seal are made once: a retry after another specification
  // moved the branch publishes the same bytes, so the person is asked for one touch.
  let prepared = null;
  for (let attempt = 1; attempt <= PUBLISH_ATTEMPTS; attempt += 1) {
    const view = await libraryView(root, config, { env });
    const revisions = view.specs.get(specId) ?? [];
    let latest = null;
    for (const candidate of [...revisions].reverse()) {
      const read = readManifest(root, view, specId, candidate, { env });
      if (read.manifest.operationId === operationId) {
        if (read.manifest.draft?.snapshotSha256 !== head.snapshotSha256 || read.manifest.reviewState !== reviewState) {
          fail(`Operation ${operationId} already published ${specId}@${candidate} from different content; nothing was published. Use a new operation ID.`,
            'SPEC_LIBRARY_OPERATION_REUSED', { specId, revision: candidate, nextAction: `singularity-flow spec author show ${specId}@${candidate}` });
        }
        return { revision: candidate, manifest: read.manifest, manifestSha256: read.manifestSha256, commit: view.commit, replayed: true };
      }
      latest ??= read;
    }
    const basedOn = head.draft.basedOn?.revision ?? null;
    if (!latest && basedOn) {
      fail(`This draft is based on ${specId}@${basedOn}, which the specification library no longer holds. Nothing was published.`, 'SPEC_LIBRARY_NOT_FOUND',
        { specId, revision: basedOn, nextAction: 'singularity-flow spec author list' });
    }
    // A revision published from one of this draft's own snapshots is this draft's own, even when
    // the acknowledgement that should have recorded it here was lost.
    // Only this rare path reads the whole history; publishing itself needs the head.
    if (latest && latest.revision !== basedOn && !await ownSnapshot(root, specId, draft, latest.manifest.draft?.snapshotSha256)) {
      fail(`${specId}@${latest.revision} was published by ${latest.manifest.publishedBy?.name ?? 'someone else'} after this draft was ${basedOn ? `based on @${basedOn}` : 'started'}. Nothing was published and your draft is unchanged: read @${latest.revision}, bring your changes over, then publish again.`,
        'SPEC_LIBRARY_REVISION_CONFLICT', { specId, latest: latest.revision, basedOn, nextAction: `singularity-flow spec author show ${specId}@${latest.revision}` });
    }
    const revision = (latest?.revision ?? 0) + 1;
    if (prepared && prepared.revision !== revision) {
      fail(`${specId}@${prepared.revision} was taken while this revision was being published. Nothing was published and your draft is unchanged; run the same command again.`,
        'SPEC_LIBRARY_REVISION_CONFLICT', { specId, latest: revision - 1, nextAction: command });
    }
    if (!prepared) {
      const built = revisionFiles({ specId, revision, parent: latest, reviewState, operationId, actor, recordedAt: new Date().toISOString(), head, report });
      // Before the person's touch: a signature is not asked for a revision that cannot leave.
      assertFilesShareable(specId, built.files, shipping);
      const sealFile = seal ? await seal({ specId, revision, manifestSha256: digest(built.files['manifest.json']), reviewState }) : null;
      prepared = { revision, ...built, sealFile };
    }
    const { manifest, files, sealFile } = prepared;
    const directory = revisionDirectory(specId, revision);
    const entries = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [`${directory}/${name}`, bytes]));
    if (sealFile) entries[`${directory}/${REVISION_SEAL_FILE}`] = sealFile;
    try {
      const published = await publishCheckedFiles(root, view.ledger, entries, `[${specId}][spec:publish] revision ${revision} (${reviewState})`, {
        exactBlobSha256: Object.fromEntries(Object.entries(entries).map(([file, bytes]) => [file, digest(bytes)])),
        pathPreconditions: { [`${directory}/manifest.json`]: { condition: 'absent' } },
        env
      }, shipping);
      return { revision, manifest, manifestSha256: digest(files['manifest.json']), commit: published.commit, replayed: false };
    } catch (error) {
      if (error?.concurrent || error?.code === 'state_branch.path_precondition_failed') continue;
      if (error?.code === 'state_branch.publication_failed') {
        throw new SingularityFlowError(`Publishing ${specId} reached the remote, but its answer was lost or refused, so whether revision ${revision} landed is unknown. Run the same command again with the same operation ID: it returns the revision if it landed and publishes it once if it did not.`, {
          code: 'SPEC_LIBRARY_PUBLISH_UNKNOWN', details: { specId, revision, operationId, nextAction: command }, cause: error
        });
      }
      throw error;
    }
  }
  fail(`Other publications kept moving the ${config?.ledger?.branch ?? 'state'} branch; ${specId} was not published after ${PUBLISH_ATTEMPTS} attempts. Nothing changed; run the same command again.`,
    'SPEC_LIBRARY_BUSY', { specId, operationId, nextAction: command });
}
