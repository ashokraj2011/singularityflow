/**
 * Inert collaborative authoring data, serialized by an exact remote Git ref lease.
 * Repository ACLs are the only access policy here. Git's presentation identity is not an
 * authenticated provider principal, and none of these records approve or activate anything.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  exactFileAtObject, exactRemoteBranchObservationAsync, exactRemoteHeadsObservationAsync, exactTreePathsAtObject,
  resolveGitCommitIdentity, withIsolatedGitObjectRepository, writeExactGitObjectCommit,
  pushIsolatedGitDraftCommit
} from './git.mjs';
import { assertCredentialFreeRemote, isPortableAbsoluteGitPath } from './git-remote-diagnostics.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { scanEntries } from './secrets.mjs';
import { consumeActionAuthorization } from './action-authorization.mjs';
import { nowIso, SingularityFlowError } from './util.mjs';
import { processResultCompleted } from './process-result.mjs';
import { canonicalEnvironmentDeclaration, matchEnvironmentLocalPath, parseEnvironmentDeclaration } from './environment-declaration.mjs';

export const WCA_GIT_DRAFT_LIMITS = Object.freeze({
  drafts: 64, revisions: 256, operations: 1024, assets: 64,
  payloadBytes: 1024 * 1024, revisionAssetBytes: 8 * 1024 * 1024,
  stateBytes: 32 * 1024 * 1024, closureBytes: 256 * 1024 * 1024,
  treeFiles: 16_384, page: 64, jsonDepth: 32, jsonNodes: 100_000
});
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const ID = /^WFD-[A-Z0-9]{6,32}$/u;
const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const STATE_FAMILY = 'workflow-authoring-git-draft-store';
const REVISION_FAMILY = 'workflow-authoring-draft-revision';
const TOMBSTONE_FAMILY = 'workflow-authoring-draft-tombstone';
const MANIFEST_FAMILY = 'workflow-authoring-asset-manifest';

function fail(message, code = 'WCA_DRAFT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail('Draft record has an unsupported shape.');
}
function requestShape(value, allowed, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).some((key) => !allowed.includes(key))
      || required.some((key) => !Object.hasOwn(value, key))) fail('Draft request has an unsupported shape.');
}
function wellFormed(value) { return Buffer.from(value, 'utf8').toString('utf8') === value; }
function digest(value) { return `sha256:${recordSha256(value)}`; }
function bytesDigest(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function sealed(value, field) { return { ...value, [field]: digest(value) }; }
function verified(value, field) {
  const copy = { ...value }; delete copy[field];
  if (!SHA.test(value[field] ?? '') || digest(copy) !== value[field]) fail('Draft record integrity check failed.');
}
function registered(family, value) {
  // Migration owner supplies version admission; this owner validates the closed semantic shape.
  if (readRecord(family, value).storedVersion !== 1) fail('Unsupported draft record version.');
  return value;
}
function validateId(value) { if (typeof value !== 'string' || !ID.test(value)) fail('A bounded WFD draft ID is required.'); return value; }
function validateOperation(value) { if (typeof value !== 'string' || !OPERATION.test(value)) fail('A bounded operation ID is required.'); return value; }
function validateHead(value) { if (value !== null && (typeof value !== 'string' || !OID.test(value))) fail('An exact expected remote head is required.'); return value; }
function displayName(value) {
  if (typeof value !== 'string' || !wellFormed(value) || !value.trim() || Buffer.byteLength(value) > 512 || /[\0\r\n]/u.test(value)) fail('Draft display name is invalid.');
  admit([{ path: 'draft-display-name.txt', content: value, forceScan: true }]);
  return value;
}
function safeJson(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > WCA_GIT_DRAFT_LIMITS.jsonNodes || depth > WCA_GIT_DRAFT_LIMITS.jsonDepth) fail('Draft payload exceeds its structural budget.', 'WCA_DRAFT_LIMIT');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (!wellFormed(item)) fail('Draft text must retain exact well-formed Unicode.');
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item) && item.length <= 4096) return item.map((child) => visit(child, depth + 1));
    if (item && typeof item === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const entries = Object.entries(item);
      if (entries.length > 4096) fail('Draft payload has too many fields.', 'WCA_DRAFT_LIMIT');
      return Object.fromEntries(entries.map(([key, child]) => {
        if (!wellFormed(key) || Buffer.byteLength(key) > 256 || /\0/u.test(key)
            || /^(?:authorizationToken|confirmationToken|actionAuthorization|refreshToken|accessToken)$/iu.test(key)) fail('Draft content may not retain authorization credentials.', 'WCA_DRAFT_CONTENT_BLOCKED');
        return [key, visit(child, depth + 1)];
      }));
    }
    fail('Draft payload must be bounded JSON data.');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('A partial authoring payload object is required.');
  const copy = visit(value, 0);
  const bytes = Buffer.from(canonicalJson(copy));
  if (bytes.length > WCA_GIT_DRAFT_LIMITS.payloadBytes) fail('Draft payload exceeds its byte budget.', 'WCA_DRAFT_LIMIT');
  admit([{ path: 'draft-payload.json', content: bytes.toString('utf8'), forceScan: true }]);
  return { value: copy, bytes };
}
function admit(entries) {
  const scanned = scanEntries(entries);
  if (!scanned.clean) fail('Draft storage admission blocked possible credentials; no shared content was written.', 'WCA_DRAFT_CONTENT_BLOCKED', { findingCount: scanned.blocking.length });
}
function logicalPath(value) {
  if (typeof value !== 'string' || !wellFormed(value) || Buffer.byteLength(value) > 512
      || !value || value.startsWith('/') || value.includes('\\') || /[\0\r\n]/u.test(value)
      || value.split('/').some((part) => !part || part === '.' || part === '..' || /[:]/u.test(part))) fail('Draft asset path is invalid.');
  admit([{ path: 'draft-asset-path.txt', content: value, forceScan: true }]);
  return value;
}
function refuseEnvironmentLocalAsset(environmentDeclaration, assetPath) {
  if (matchEnvironmentLocalPath(environmentDeclaration, assetPath)) fail('Environment-local assets cannot enter shared draft storage.', 'WCA_DRAFT_CONTENT_BLOCKED');
}
function captureAssets(values = [], environmentDeclaration = null) {
  if (!Array.isArray(values) || values.length > WCA_GIT_DRAFT_LIMITS.assets) fail('Draft asset count exceeds its budget.', 'WCA_DRAFT_LIMIT');
  const paths = new Set(); const blobs = new Map(); let total = 0;
  const assets = values.map((value) => {
    exact(value, ['path', 'content']);
    const assetPath = logicalPath(value.path);
    refuseEnvironmentLocalAsset(environmentDeclaration, assetPath);
    const portable = assetPath.normalize('NFC').toLowerCase();
    if (paths.has(portable)) fail('Draft asset paths must be portable and unique.');
    paths.add(portable);
    if (typeof value.content !== 'string' && !Buffer.isBuffer(value.content)) fail('Draft assets require exact literal bytes.');
    if (typeof value.content === 'string' && !wellFormed(value.content)) fail('Draft asset text must retain exact well-formed Unicode.');
    const bytes = Buffer.from(value.content);
    total += bytes.length;
    if (total > WCA_GIT_DRAFT_LIMITS.revisionAssetBytes) fail('Draft assets exceed their byte budget.', 'WCA_DRAFT_LIMIT');
    // Always scan, including binary-looking or discoverable skill filenames. Bytes are never run.
    admit([{ path: assetPath, content: bytes.toString('utf8'), forceScan: true }]);
    const sha256 = bytesDigest(bytes); blobs.set(sha256, bytes);
    return { path: assetPath, sha256, bytes: bytes.length };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const manifest = sealed({ schemaVersion: currentSchemaVersion(MANIFEST_FAMILY), kind: MANIFEST_FAMILY, assets }, 'assetManifestSha256');
  const bytes = Buffer.from(canonicalJson(manifest));
  blobs.set(bytesDigest(bytes), bytes);
  return { manifest, manifestBlobSha256: bytesDigest(bytes), blobs };
}
function validateManifest(value, environmentDeclaration = null) {
  registered(MANIFEST_FAMILY, value);
  exact(value, ['schemaVersion', 'kind', 'assets', 'assetManifestSha256']);
  if (value.kind !== MANIFEST_FAMILY || !Array.isArray(value.assets) || value.assets.length > WCA_GIT_DRAFT_LIMITS.assets) fail('Draft manifest is invalid.');
  verified(value, 'assetManifestSha256');
  let total = 0; let previous = null; const portablePaths = new Set();
  for (const asset of value.assets) {
    exact(asset, ['path', 'sha256', 'bytes']); logicalPath(asset.path);
    refuseEnvironmentLocalAsset(environmentDeclaration, asset.path);
    const portable = asset.path.normalize('NFC').toLowerCase();
    if (portablePaths.has(portable)) fail('Draft manifest asset paths collide.');
    portablePaths.add(portable);
    if ((previous !== null && asset.path <= previous) || !SHA.test(asset.sha256 ?? '')
        || !Number.isSafeInteger(asset.bytes) || asset.bytes < 0) fail('Draft manifest entry is invalid.');
    previous = asset.path; total += asset.bytes;
  }
  if (total > WCA_GIT_DRAFT_LIMITS.revisionAssetBytes) fail('Draft assets exceed their budget.', 'WCA_DRAFT_LIMIT');
  return value;
}
function validateRevision(value, workspaceId, draftId, previous) {
  registered(REVISION_FAMILY, value);
  exact(value, ['schemaVersion', 'kind', 'draftId', 'workspaceId', 'visibility', 'lifecycle', 'lifecycleEpoch', 'revision', 'displayName', 'parentRevisionSha256', 'content', 'lastEdit', 'revisionSha256']);
  exact(value.content, ['kind', 'payloadSha256', 'assetManifestSha256']);
  exact(value.lastEdit, ['operationId', 'recordedAt']);
  if (value.kind !== REVISION_FAMILY || value.workspaceId !== workspaceId || value.draftId !== draftId
      || value.visibility !== 'repository-shared' || value.lifecycle !== 'live' || value.lifecycleEpoch !== 1
      || value.revision !== (previous?.revision ?? 0) + 1
      || value.parentRevisionSha256 !== (previous?.revisionSha256 ?? null)
      || value.content.kind !== 'partial-workflow-package'
      || !SHA.test(value.content.payloadSha256 ?? '') || !SHA.test(value.content.assetManifestSha256 ?? '')
      || !Number.isFinite(Date.parse(value.lastEdit.recordedAt))) fail('Draft revision lineage or content binding is invalid.');
  displayName(value.displayName); validateOperation(value.lastEdit.operationId); verified(value, 'revisionSha256');
}
function validateTombstone(value, workspaceId, draftId, last) {
  registered(TOMBSTONE_FAMILY, value);
  exact(value, ['schemaVersion', 'kind', 'draftId', 'workspaceId', 'lastLiveRevisionSha256', 'lifecycleEpoch', 'status', 'operationId', 'recordedAt', 'retentionDisposition', 'tombstoneSha256']);
  if (value.kind !== TOMBSTONE_FAMILY || value.workspaceId !== workspaceId || value.draftId !== draftId
      || value.lastLiveRevisionSha256 !== last.revisionSha256 || value.lifecycleEpoch !== 2
      || value.status !== 'deleted' || value.retentionDisposition !== 'retain-referenced-submission-evidence'
      || !Number.isFinite(Date.parse(value.recordedAt))) fail('Draft tombstone is invalid.');
  validateOperation(value.operationId); verified(value, 'tombstoneSha256');
}
function validateState(value, workspaceId) {
  registered(STATE_FAMILY, value);
  exact(value, ['schemaVersion', 'kind', 'workspaceId', 'generation', 'drafts', 'operations', 'stateSha256']);
  if (value.kind !== STATE_FAMILY || value.workspaceId !== workspaceId
      || !Array.isArray(value.drafts) || value.drafts.length > WCA_GIT_DRAFT_LIMITS.drafts
      || !Array.isArray(value.operations) || value.operations.length > WCA_GIT_DRAFT_LIMITS.operations
      || value.generation !== value.operations.length) fail('Draft store is invalid or exceeds its budget.');
  verified(value, 'stateSha256');
  const ids = new Set(); const identities = new Map();
  for (const draft of value.drafts) {
    exact(draft, ['draftId', 'revisions', 'tombstone']); validateId(draft.draftId);
    if (ids.has(draft.draftId) || !Array.isArray(draft.revisions) || !draft.revisions.length
        || draft.revisions.length > WCA_GIT_DRAFT_LIMITS.revisions) fail('Draft store lineage is invalid.');
    ids.add(draft.draftId); let previous = null;
    for (const revision of draft.revisions) {
      validateRevision(revision, workspaceId, draft.draftId, previous);
      identities.set(revision.revisionSha256, draft.draftId); previous = revision;
    }
    if (draft.tombstone !== null) validateTombstone(draft.tombstone, workspaceId, draft.draftId, previous);
  }
  const operations = new Set();
  const draftOperations = new Map();
  for (let index = 0; index < value.operations.length; index += 1) {
    const operation = value.operations[index];
    exact(operation, ['operationId', 'requestSha256', 'draftId', 'kind', 'generation', 'parentHead', 'revisionSha256', 'tombstoneSha256']);
    validateOperation(operation.operationId); validateHead(operation.parentHead);
    if (operations.has(operation.operationId) || !SHA.test(operation.requestSha256 ?? '')
        || operation.generation !== index + 1 || (index === 0) !== (operation.parentHead === null)
        || !['create', 'append', 'delete'].includes(operation.kind)
        || identities.get(operation.revisionSha256) !== operation.draftId) fail('Draft operation journal is invalid.');
    const tombstone = value.drafts.find((draft) => draft.draftId === operation.draftId).tombstone;
    if (operation.kind === 'delete'
      ? !tombstone || operation.tombstoneSha256 !== tombstone.tombstoneSha256 || operation.operationId !== tombstone.operationId
      : operation.tombstoneSha256 !== null) fail('Draft operation result binding is invalid.');
    operations.add(operation.operationId);
    if (!draftOperations.has(operation.draftId)) draftOperations.set(operation.draftId, []);
    draftOperations.get(operation.draftId).push(operation);
  }
  for (const draft of value.drafts) {
    const journal = draftOperations.get(draft.draftId) ?? [];
    if (!journal.length || journal[0].kind !== 'create'
        || journal.filter((operation) => operation.kind === 'create').length !== 1
        || Boolean(draft.tombstone) !== (journal.at(-1).kind === 'delete')
        || journal.slice(0, -1).some((operation) => operation.kind === 'delete')) fail('Draft lifecycle operation lineage is invalid.');
    let currentRevision = 0;
    for (const operation of journal) {
      const selected = draft.revisions.find((revision) => revision.revisionSha256 === operation.revisionSha256);
      if (selected.revision < currentRevision || selected.revision > currentRevision + 1
          || (operation.kind === 'delete' && selected.revision !== currentRevision)) fail('Draft operation revision order is invalid.');
      currentRevision = selected.revision;
    }
    for (const revision of draft.revisions) {
      const authored = journal.find((operation) => operation.operationId === revision.lastEdit.operationId);
      if (!authored || authored.revisionSha256 !== revision.revisionSha256
          || authored.kind !== (revision.revision === 1 ? 'create' : 'append')) fail('Draft authoring operation binding is invalid.');
    }
  }
  return value;
}
function emptyState(workspaceId) {
  return { schemaVersion: currentSchemaVersion(STATE_FAMILY), kind: STATE_FAMILY, workspaceId, generation: 0, drafts: [], operations: [] };
}
function blobPath(sha256) { if (!SHA.test(sha256 ?? '')) fail('Invalid content address.'); return `assets/${sha256.slice(7)}`; }
function blobAt(root, head, sha256, maximumBytes, files = null) {
  const bytes = files?.get(blobPath(sha256)) ?? exactFileAtObject(root, head, blobPath(sha256), { maximumBytes: maximumBytes + 1024 });
  if (!bytes || bytes.length > maximumBytes || bytesDigest(bytes) !== sha256) fail('A complete exact draft asset closure is unavailable.', 'WCA_DRAFT_ASSET_MISSING');
  return bytes;
}
function parseJson(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { fail('Draft content is not valid JSON.'); } }
function revisionContent(root, head, record, files = null, environmentDeclaration = null) {
  const blobPaths = [blobPath(record.content.payloadSha256), blobPath(record.content.assetManifestSha256)];
  const payloadBytes = blobAt(root, head, record.content.payloadSha256, WCA_GIT_DRAFT_LIMITS.payloadBytes, files);
  const payload = parseJson(payloadBytes);
  if (!Buffer.from(canonicalJson(safeJson(payload).value)).equals(payloadBytes)) fail('Draft payload is not canonical.');
  const manifestBytes = blobAt(root, head, record.content.assetManifestSha256, 128 * 1024, files);
  const manifest = validateManifest(parseJson(manifestBytes), environmentDeclaration);
  if (!Buffer.from(canonicalJson(manifest)).equals(manifestBytes)) fail('Draft manifest is not canonical.');
  const assets = manifest.assets.map((asset) => {
    blobPaths.push(blobPath(asset.sha256));
    const content = blobAt(root, head, asset.sha256, asset.bytes, files);
    if (content.length !== asset.bytes) fail('Draft asset length does not match its manifest.');
    admit([{ path: asset.path, content: content.toString('utf8'), forceScan: true }]);
    return { path: asset.path, content };
  });
  return { payload, assets, blobPaths };
}
function page(items, limit = 20, cursor = 0) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WCA_GIT_DRAFT_LIMITS.page
      || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > items.length) fail('Draft page bounds are invalid.');
  const selected = items.slice(cursor, cursor + limit);
  return { items: selected, nextCursor: cursor + selected.length < items.length ? cursor + selected.length : null };
}
function operationResult(state, head, operation) {
  const draft = state.drafts.find((item) => item.draftId === operation.draftId);
  const record = draft.revisions.find((item) => item.revisionSha256 === operation.revisionSha256);
  return {
    status: 'shared-acknowledged', head,
    operationHead: state.operations[operation.generation]?.parentHead ?? head,
    operationId: operation.operationId, requestSha256: operation.requestSha256,
    currentLifecycle: draft.tombstone ? 'deleted' : 'live',
    currentLifecycleEpoch: draft.tombstone ? 2 : 1,
    record: structuredClone(record), tombstone: operation.kind === 'delete' ? structuredClone(draft.tombstone) : null
  };
}

/** Exact review subject consumed by the existing local human-action authorization owner. */
export function draftDeletePlan({ remote, workspaceId, draftId, expectedHead, epoch, revisionSha256 }) {
  assertCredentialFreeRemote(remote);
  if (!isPortableAbsoluteGitPath(remote) && !/^[a-z][a-z0-9+.-]*:\/\//iu.test(remote)
      && !/^(?:[^/@:\s]+@)?(?:\[[^\]]+\]|[^/:\s]+):.+$/u.test(remote)) fail('An exact anchored draft repository is required for deletion.', 'WCA_DRAFT_REMOTE_INVALID');
  if (typeof workspaceId !== 'string' || !WORKSPACE.test(workspaceId)) fail('Draft workspace ID is invalid.');
  validateId(draftId); validateHead(expectedHead);
  if (!expectedHead || epoch !== 1 || typeof revisionSha256 !== 'string' || !SHA.test(revisionSha256)) fail('A live exact draft revision is required for deletion.');
  const subject = { kind: 'workflow-authoring-draft', repository: remote, workspaceId, draftId, expectedHead, lifecycleEpoch: epoch, revisionSha256 };
  const planHash = recordSha256({ operation: 'workflow.draft.delete', subject });
  const action = { actionId: `workflow.draft.delete:${draftId}:${planHash.slice(0, 12)}`, confirmation: { required: true } };
  return { plan: { planId: `wca-delete-${planHash.slice(0, 24)}`, planHash, subject, revision: revisionSha256 }, action };
}

/**
 * The caller selects the configuration authority repository, not a draft-provided destination.
 * Every invocation contacts that frozen destination with native Git credentials; no cached edit
 * handle, author field, creator identity, or JSON ACL bypasses a revoked repository permission.
 */
export function openGitDraftStore({ root, remote, workspaceId, environmentDeclaration = null, fault = null } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('An explicit client repository root is required.');
  assertCredentialFreeRemote(remote);
  if (typeof remote !== 'string' || remote !== remote.trim() || typeof workspaceId !== 'string' || !WORKSPACE.test(workspaceId)) fail('Exact draft repository and workspace identities are required.');
  // A filesystem remote is interpreted relative to the process cwd by Git. Resolve once in the
  // client authority context, before either observation or moving to an isolated scratch cwd.
  // Names here are explicit repository paths/URLs, never mutable configured remote aliases.
  const url = /^[a-z][a-z0-9+.-]*:\/\//iu.test(remote);
  const scp = /^(?:[^/@:\s]+@)?(?:\[[^\]]+\]|[^/:\s]+):.+$/u.test(remote);
  if (/^file:/iu.test(remote) && !/^file:\/\//iu.test(remote)
      || /^[A-Za-z]:/u.test(remote) && !isPortableAbsoluteGitPath(remote)) fail('Use an absolute filesystem remote or canonical file URL.', 'WCA_DRAFT_REMOTE_INVALID');
  if (!url && !scp && !isPortableAbsoluteGitPath(remote)) remote = path.resolve(root, remote);
  // The approved configuration/scope owner supplies this names-only policy; draft content never
  // chooses exclusions or weakens admission. Reparse to capture one closed, immutable rule set.
  if (environmentDeclaration !== null && environmentDeclaration !== undefined) environmentDeclaration = parseEnvironmentDeclaration(Buffer.from(canonicalEnvironmentDeclaration(environmentDeclaration)));
  else environmentDeclaration = null;
  const branch = `sflow/drafts/${workspaceId}`;
  async function observe() {
    const observed = await exactRemoteBranchObservationAsync(root, remote, branch);
    if (!observed.reachable) fail('Shared draft repository is unavailable; local content is not shared.', 'WCA_DRAFT_STORE_UNAVAILABLE');
    if (observed.malformed || (observed.sha !== null && !OID.test(observed.sha))) fail('Shared draft head advertisement is invalid.');
    return observed.sha;
  }
  async function transaction(callback) {
    const head = await observe();
    const commitIdentity = resolveGitCommitIdentity(root);
    let objectFormat = head?.length === 64 ? 'sha256' : 'sha1';
    if (head === null) {
      const heads = await exactRemoteHeadsObservationAsync(root, remote);
      if (!heads.reachable || heads.malformed) fail('Draft repository object format could not be observed.', 'WCA_DRAFT_STORE_UNAVAILABLE');
      const widths = new Set(Object.values(heads.heads).map((oid) => oid.length));
      if (widths.size > 1) fail('Draft repository advertises inconsistent object identities.');
      if (widths.has(64)) objectFormat = 'sha256';
    }
    return withIsolatedGitObjectRepository({ remote, expectedCommit: head, objectFormat, maximumBytes: WCA_GIT_DRAFT_LIMITS.closureBytes + WCA_GIT_DRAFT_LIMITS.stateBytes }, async (scratch, controls) => {
      let state = emptyState(workspaceId);
      const files = new Map();
      if (head !== null) {
        const paths = exactTreePathsAtObject(scratch, head);
        if (!paths || paths.length > WCA_GIT_DRAFT_LIMITS.treeFiles
            || !paths.includes('state.json') || paths.some((file) => file !== 'state.json' && !/^assets\/[a-f0-9]{64}$/u.test(file))) fail('Draft-only repository tree is invalid.');
        const stateBytes = exactFileAtObject(scratch, head, 'state.json', { maximumBytes: WCA_GIT_DRAFT_LIMITS.stateBytes + 1024 });
        if (!stateBytes || stateBytes.length > WCA_GIT_DRAFT_LIMITS.stateBytes) fail('Shared draft state is unavailable or oversized.');
        admit([{ path: 'draft-state.json', content: stateBytes.toString('utf8'), forceScan: true }]);
        state = validateState(parseJson(stateBytes), workspaceId);
        if (!Buffer.from(canonicalJson(state)).equals(stateBytes)) fail('Shared draft state is not canonical.');
        let total = 0;
        for (const file of paths.filter((item) => item.startsWith('assets/'))) {
          const bytes = blobAt(scratch, head, `sha256:${file.slice(7)}`, WCA_GIT_DRAFT_LIMITS.revisionAssetBytes);
          total += bytes.length;
          if (total > WCA_GIT_DRAFT_LIMITS.closureBytes) fail('Shared draft closure exceeds its budget.', 'WCA_DRAFT_LIMIT');
          files.set(file, bytes);
        }
        // Verify every retained revision, not only a selected head. Missing historic bytes do not
        // become an acknowledged shared revision merely because the newest payload is intact.
        const checkedContents = new Map(); const referencedPaths = new Set();
        for (const draft of state.drafts) for (const revision of draft.revisions) {
          const key = digest(revision.content);
          if (!checkedContents.has(key)) checkedContents.set(key, revisionContent(scratch, head, revision, files, environmentDeclaration).blobPaths);
          for (const file of checkedContents.get(key)) referencedPaths.add(file);
        }
        if (files.size !== referencedPaths.size || [...files.keys()].some((file) => !referencedPaths.has(file))) fail('Draft store contains unclaimed bytes outside its exact retained revision closure.');
      }
      return callback({ scratch, state, head, files, commitIdentity, controls });
    });
  }
  function live(state, draftId, epoch) {
    const draft = state.drafts.find((item) => item.draftId === draftId);
    if (!draft) fail('Shared draft does not exist.', 'WCA_DRAFT_NOT_FOUND');
    if (draft.tombstone || epoch !== 1) fail('Deleted draft identities cannot be revived by late saves.', 'WCA_DRAFT_DELETED');
    return draft;
  }
  async function mutate(kind, request) {
    const required = ['draftId', 'expectedHead', 'operationId'];
    requestShape(request,
      kind === 'create' ? [...required, 'displayName', 'payload', 'assets']
        : kind === 'append' ? [...required, 'epoch', 'patch'] : [...required, 'epoch', 'confirmation'],
      kind === 'create' ? [...required, 'displayName', 'payload']
        : kind === 'append' ? [...required, 'epoch', 'patch'] : [...required, 'epoch']);
    // Freeze request metadata before the first remote await. Caller-owned objects are not the
    // operation subject: a UI/autosave buffer may change while observation or authentication runs.
    // Preserve closed-shape admission above; payloads and asset bytes below are also copied
    // synchronously into the captured patch rather than retaining caller-owned nested objects.
    request = Object.freeze({ ...request });
    validateId(request.draftId); validateOperation(request.operationId); validateHead(request.expectedHead);
    let patch = null;
    if (kind === 'create') {
      displayName(request.displayName);
      patch = { displayName: request.displayName, payload: safeJson(request.payload), assets: captureAssets(request.assets, environmentDeclaration) };
    } else if (kind === 'append') {
      if (!request.patch || typeof request.patch !== 'object' || Array.isArray(request.patch)
          || Object.keys(request.patch).some((key) => !['displayName', 'payload', 'assets'].includes(key))) fail('Draft edit is a closed replacement patch, not arbitrary JSON Patch.');
      patch = {
        ...(Object.hasOwn(request.patch, 'displayName') ? { displayName: displayName(request.patch.displayName) } : {}),
        ...(Object.hasOwn(request.patch, 'payload') ? { payload: safeJson(request.patch.payload) } : {}),
        ...(Object.hasOwn(request.patch, 'assets') ? { assets: captureAssets(request.patch.assets, environmentDeclaration) } : {})
      };
    }
    const requestCore = {
      kind, repository: remote, workspaceId, draftId: request.draftId, expectedHead: request.expectedHead,
      epoch: kind === 'create' ? 1 : request.epoch,
      patch: patch === null ? null : {
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.payload ? { payloadSha256: bytesDigest(patch.payload.bytes) } : {}),
        ...(patch.assets ? { assetManifestSha256: patch.assets.manifestBlobSha256 } : {})
      }
    };
    const requestSha256 = digest(requestCore);
    return transaction(async ({ scratch, state, head, files, commitIdentity, controls }) => {
      const prior = state.operations.find((item) => item.operationId === request.operationId);
      if (prior) {
        if (prior.requestSha256 !== requestSha256) fail('Operation ID was already used for a different draft request.', 'WCA_OPERATION_ID_REUSED');
        if (kind !== 'delete' && state.drafts.find((item) => item.draftId === request.draftId)?.tombstone) fail('Deleted draft identities fence queued retries.', 'WCA_DRAFT_DELETED');
        return { ...operationResult(state, head, prior), replayed: true };
      }
      let draft;
      if (kind !== 'create') draft = live(state, request.draftId, request.epoch);
      if (head !== request.expectedHead) fail('Team draft state changed; retain the local candidate and reconcile explicitly.', 'WCA_DRAFT_CONFLICT', { expectedHead: request.expectedHead, head });
      if (state.operations.length >= WCA_GIT_DRAFT_LIMITS.operations) fail('Draft operation retention quota is full.', 'WCA_DRAFT_LIMIT');
      if (kind === 'create') {
        const existing = state.drafts.find((item) => item.draftId === request.draftId);
        if (existing?.tombstone) fail('Deleted draft IDs cannot be recreated.', 'WCA_DRAFT_DELETED');
        if (existing) fail('Draft ID already exists.', 'WCA_DRAFT_CONFLICT');
        if (state.drafts.length >= WCA_GIT_DRAFT_LIMITS.drafts) fail('Draft retention quota is full.', 'WCA_DRAFT_LIMIT');
        draft = { draftId: request.draftId, revisions: [], tombstone: null }; state.drafts.push(draft);
      }
      let record = draft.revisions.at(-1);
      if (kind === 'delete') {
        const review = draftDeletePlan({ remote, workspaceId, draftId: request.draftId, expectedHead: head, epoch: request.epoch, revisionSha256: record.revisionSha256 });
        if (typeof request.confirmation !== 'string') fail('Deletion needs a current exact human action authorization.', 'WCA_NEEDS_HUMAN_INPUT');
        await consumeActionAuthorization(root, request.confirmation, review.plan, review.action, { requireTerminalPresentation: true });
        draft.tombstone = sealed({ schemaVersion: currentSchemaVersion(TOMBSTONE_FAMILY), kind: TOMBSTONE_FAMILY, draftId: request.draftId, workspaceId, lastLiveRevisionSha256: record.revisionSha256, lifecycleEpoch: 2, status: 'deleted', operationId: request.operationId, recordedAt: nowIso(), retentionDisposition: 'retain-referenced-submission-evidence' }, 'tombstoneSha256');
      } else {
        const content = {
          kind: 'partial-workflow-package',
          payloadSha256: patch.payload ? bytesDigest(patch.payload.bytes) : record.content.payloadSha256,
          assetManifestSha256: patch.assets ? patch.assets.manifestBlobSha256 : record.content.assetManifestSha256
        };
        const name = patch.displayName ?? record.displayName;
        const noOp = record && name === record.displayName && canonicalJson(content) === canonicalJson(record.content);
        if (!noOp) {
          if (draft.revisions.length >= WCA_GIT_DRAFT_LIMITS.revisions) fail('Draft revision retention quota is full.', 'WCA_DRAFT_LIMIT');
          record = sealed({ schemaVersion: currentSchemaVersion(REVISION_FAMILY), kind: REVISION_FAMILY, draftId: request.draftId, workspaceId, visibility: 'repository-shared', lifecycle: 'live', lifecycleEpoch: 1, revision: draft.revisions.length + 1, displayName: name, parentRevisionSha256: record?.revisionSha256 ?? null, content, lastEdit: { operationId: request.operationId, recordedAt: nowIso() } }, 'revisionSha256');
          draft.revisions.push(record);
        }
        if (patch.payload) files.set(blobPath(content.payloadSha256), patch.payload.bytes);
        if (patch.assets) for (const [sha256, bytes] of patch.assets.blobs) files.set(blobPath(sha256), bytes);
      }
      const operation = { operationId: request.operationId, requestSha256, draftId: request.draftId, kind, generation: state.generation + 1, parentHead: head, revisionSha256: record.revisionSha256, tombstoneSha256: draft.tombstone?.tombstoneSha256 ?? null };
      state.operations.push(operation); state.generation += 1;
      const core = { ...state }; delete core.stateSha256;
      state = sealed(core, 'stateSha256'); validateState(state, workspaceId);
      const stateBytes = Buffer.from(canonicalJson(state));
      admit([{ path: 'draft-state.json', content: stateBytes.toString('utf8'), forceScan: true }]);
      if (stateBytes.length > WCA_GIT_DRAFT_LIMITS.stateBytes
          || [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0) > WCA_GIT_DRAFT_LIMITS.closureBytes
          || files.size + 1 > WCA_GIT_DRAFT_LIMITS.treeFiles) fail('Draft store quota is full.', 'WCA_DRAFT_LIMIT');
      files.set('state.json', stateBytes);
      const commit = await writeExactGitObjectCommit(scratch, { parentCommit: head, files, commitIdentity, message: `WCA draft ${kind} ${request.draftId}` });
      if (fault) await fault('before-cas', { head, commit, operationId: request.operationId });
      const pushed = await pushIsolatedGitDraftCommit(scratch, { remote, commit, branch, expectedRemoteSha: head });
      if (pushed.status !== 0) {
        if (!processResultCompleted(pushed)) controls.retainTemporaryTree();
        else {
          const observedHead = await observe();
          // A lost receive-pack acknowledgement is not a losing edit. Only the exact commit we
          // created can resolve this operation; another writer's state is never treated as ours.
          if (observedHead === commit) return { ...operationResult(state, commit, operation), replayed: false };
          if (observedHead !== head) fail('Another client won the shared draft compare-and-swap; retain and reconcile the local candidate.', 'WCA_DRAFT_CONFLICT');
        }
        // An interrupted push may already have installed the exact commit. Resolve only through
        // a fresh authenticated operation read; never silently replay a changed request.
        fail('Shared write was not acknowledged; resolve its operation ID before retrying.', 'WCA_DRAFT_WRITE_UNACKNOWLEDGED', { operationId: request.operationId });
      }
      if (fault) await fault('after-cas-before-ack', { head, commit, operationId: request.operationId });
      return { ...operationResult(state, commit, operation), replayed: false };
    });
  }
  return Object.freeze({
    capability: Object.freeze({ backend: 'git', repository: remote, branch, visibility: 'repository-acl', authenticatedPrincipal: 'provider-unavailable', authorization: 'native-provider-repository-acl', conditionalWrite: 'exact-remote-head-lease', acknowledgement: 'remote-ref-transition', readAfterWrite: 'fresh-remote-observation', revocation: 'provider-enforced-on-every-contact', retention: 'no-automatic-eviction; tombstones-and-history-retained', activation: false }),
    create: (request) => mutate('create', request),
    appendRevision: (request) => mutate('append', request),
    delete: (request) => mutate('delete', request),
    async list({ limit = 20, cursor = 0 } = {}) {
      return transaction(({ state, head }) => {
        const result = page(state.drafts.filter((draft) => !draft.tombstone).map((draft) => draft.revisions.at(-1)).sort((a, b) => a.draftId < b.draftId ? -1 : 1), limit, cursor);
        return { head, drafts: structuredClone(result.items), nextCursor: result.nextCursor };
      });
    },
    async readRevision({ draftId, revision = null } = {}) {
      validateId(draftId);
      if (revision !== null && (!Number.isSafeInteger(revision) || revision < 1)) fail('Draft revision selection is invalid.');
      return transaction(({ state, head, scratch, files }) => {
        const draft = state.drafts.find((item) => item.draftId === draftId);
        if (!draft) fail('Shared draft does not exist.', 'WCA_DRAFT_NOT_FOUND');
        if (draft.tombstone && revision === null) fail('Draft was deleted.', 'WCA_DRAFT_DELETED');
        const record = revision === null ? draft.revisions.at(-1) : draft.revisions.find((item) => item.revision === revision);
        if (!record) fail('Draft revision does not exist.', 'WCA_DRAFT_NOT_FOUND');
        const content = revisionContent(scratch, head, record, files, environmentDeclaration);
        return { head, record: structuredClone(record), tombstone: structuredClone(draft.tombstone), payload: structuredClone(content.payload), assets: content.assets.map((asset) => ({ path: asset.path, content: Buffer.from(asset.content) })) };
      });
    },
    async history({ draftId, limit = 20, cursor = 0 } = {}) {
      validateId(draftId);
      return transaction(({ state, head }) => {
        const draft = state.drafts.find((item) => item.draftId === draftId);
        if (!draft) fail('Shared draft does not exist.', 'WCA_DRAFT_NOT_FOUND');
        const result = page(draft.revisions, limit, cursor);
        return { head, revisions: structuredClone(result.items), tombstone: structuredClone(draft.tombstone), nextCursor: result.nextCursor };
      });
    },
    async operationStatus({ operationId } = {}) {
      validateOperation(operationId);
      return transaction(({ state, head }) => {
        const operation = state.operations.find((item) => item.operationId === operationId);
        return operation ? operationResult(state, head, operation) : { status: 'not-found', head, operationId };
      });
    }
  });
}
