import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { assertCredentialFreeRemote, sanitizeRemote } from './git-remote-diagnostics.mjs';
import {
  SingularityFlowError, posix, readJson, secureRepositoryPath, writeBytes, writeJson
} from './util.mjs';

const SNAPSHOT_FAMILY = 'workflow-snapshot';
const SNAPSHOT_REFERENCE_FAMILY = 'workflow-snapshot-reference';
const MAXIMUM_ASSET_BYTES = 1024 * 1024;
const MAXIMUM_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ASSETS = 2048;

function fail(message, code = 'WFA_SNAPSHOT_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function qualified(value) {
  return `sha256:${value}`;
}

function domainHash(domain, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonicalJson(value));
  return qualified(createHash('sha256').update(`${domain}\0`).update(bytes).digest('hex'));
}

function digestHex(value, label) {
  const digest = String(value ?? '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) fail(`${label} has an invalid SHA-256 digest.`);
  return digest;
}

function storyRelative(config, workId, child = '') {
  const root = posix(path.join(config.workItemRoot ?? 'singularity/work-items', workId));
  return child ? `${root}/${child}` : root;
}

function clonePolicy(resolution) {
  // Internal symbols/caches never enter JSON. The policy digest is already part of the effective
  // resolution and intentionally remains in the captured policy bytes.
  return JSON.parse(JSON.stringify(resolution));
}

async function stableFile(file, label) {
  const before = await lstat(file).catch((error) => {
    if (error?.code === 'ENOENT') fail(`${label} is unavailable.`, 'WFA_DEPENDENCY_UNAVAILABLE');
    throw error;
  });
  if (!before.isFile() || before.isSymbolicLink()) {
    fail(`${label} must be an ordinary non-symlink file.`, 'WFA_PATH_REFUSED');
  }
  if (before.size > MAXIMUM_ASSET_BYTES) {
    fail(`${label} exceeds the 1 MiB workflow-snapshot asset limit.`, 'WFA_LIMIT_REACHED');
  }
  let handle;
  let bytes;
  try {
    handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino
        || before.size !== opened.size || before.mtimeMs !== opened.mtimeMs) {
      fail(`${label} changed while its Story snapshot was being opened.`, 'WFA_SOURCE_STALE');
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size
        || opened.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
      fail(`${label} changed while its Story snapshot was being captured.`, 'WFA_SOURCE_STALE');
    }
  } catch (error) {
    if (error instanceof SingularityFlowError) throw error;
    if (['ELOOP', 'EMLINK'].includes(error?.code)) {
      fail(`${label} changed to a symbolic link.`, 'WFA_PATH_REFUSED');
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
  const rebound = await lstat(file).catch(() => null);
  if (!rebound || rebound.isSymbolicLink() || before.dev !== rebound.dev || before.ino !== rebound.ino
      || before.size !== rebound.size || before.mtimeMs !== rebound.mtimeMs) {
    fail(`${label} changed while its Story snapshot was being verified.`, 'WFA_SOURCE_STALE');
  }
  return { bytes, sha256: sha256(bytes), size: bytes.byteLength };
}

async function installBlob(root, config, workId, captured) {
  const relative = storyRelative(config, workId, `config/wfa/blobs/sha256/${captured.sha256}`);
  const target = await secureRepositoryPath(root, relative, {
    label: 'Workflow snapshot blob'
  });
  if (target.exists) {
    const current = await stableFile(target.absolute, 'Existing workflow snapshot blob');
    if (current.sha256 !== captured.sha256 || current.size !== captured.size) {
      fail('A content-addressed workflow snapshot blob contains different bytes.');
    }
  } else {
    await mkdir(path.dirname(target.absolute), { recursive: true });
    await writeBytes(target.absolute, captured.bytes);
  }
  return {
    sha256: qualified(captured.sha256), bytes: captured.size,
    mediaType: captured.mediaType, path: relative
  };
}

async function captureRepositoryAsset(root, config, workId, {
  logicalId, purpose, relativePath, expectedSha256, dependencies = []
}) {
  const safe = await secureRepositoryPath(root, relativePath, {
    label: `Workflow snapshot asset '${logicalId}'`, mustExist: true, type: 'file'
  });
  const captured = await stableFile(safe.absolute, `Workflow snapshot asset '${logicalId}'`);
  if (expectedSha256 && captured.sha256 !== digestHex(expectedSha256, `Asset '${logicalId}'`)) {
    fail(`Workflow snapshot asset '${logicalId}' differs from its approved digest.`, 'WFA_SOURCE_STALE');
  }
  const blob = await installBlob(root, config, workId, {
    ...captured, mediaType: 'text/markdown; charset=utf-8'
  });
  return {
    logicalId, purpose, dependencies, blob,
    source: { kind: 'repository-path', path: posix(relativePath), sha256: blob.sha256 }
  };
}

async function captureInstalledAgent(root, config, workId, agent) {
  const captured = await stableFile(agent.file, `Governed agent '${agent.id}'`);
  if (captured.sha256 !== digestHex(agent.sha256, `Governed agent '${agent.id}'`)) {
    fail(`Governed agent '${agent.id}' differs from its selected digest.`, 'WFA_SOURCE_STALE');
  }
  const blob = await installBlob(root, config, workId, {
    ...captured, mediaType: 'text/markdown; charset=utf-8'
  });
  return {
    logicalId: `agent:${agent.id}`, purpose: 'governed-agent', dependencies: [], blob,
    source: {
      kind: agent.scope === 'repository' ? 'repository-agent' : 'installed-reviewed-agent',
      scope: agent.scope,
      source: agent.scope === 'repository' ? agent.source : null,
      sourceId: domainHash('wfa.agent-source.v1', `${agent.scope}:${agent.source}`),
      sha256: blob.sha256
    }
  };
}

function manifestCore(manifest) {
  const core = structuredClone(manifest);
  delete core.snapshotHash;
  return core;
}

/**
 * Capture the exact declarative bytes a newly created Story needs to interpret its pinned policy.
 * This is part of the Story-start draft transaction: a failure leaves no accepted Story commit.
 */
export async function captureWorkflowSnapshot(root, config, workflow) {
  const workId = workflow.workItem.id;
  const assets = [];
  for (const [phaseId, template] of Object.entries(workflow.resolution.templates ?? {})) {
    const sourcePath = template?.source === 'workflow-snapshot'
      ? template.sourcePath
      : template?.path;
    if (!sourcePath || !template?.sha256) {
      fail(`Phase '${phaseId}' has no capturable template dependency.`, 'WFA_DEPENDENCY_UNAVAILABLE');
    }
    const asset = await captureRepositoryAsset(root, config, workId, {
      logicalId: `template:${phaseId}`, purpose: 'phase-template',
      relativePath: sourcePath, expectedSha256: template.sha256
    });
    assets.push(asset);
    // Future phase rendering must resolve the accepted bytes, never the live configuration file.
    // The old path remains provenance only and is not an executable dependency.
    const capturedTemplate = {
      ...template,
      source: 'workflow-snapshot',
      sourcePath: posix(sourcePath),
      path: asset.blob.path,
      sha256: digestHex(asset.blob.sha256, `Template '${phaseId}'`)
    };
    workflow.resolution.templates[phaseId] = capturedTemplate;
    const resolvedPhase = (workflow.resolution.phases ?? []).find((phase) => phase.id === phaseId);
    if (resolvedPhase) resolvedPhase.templateSnapshot = structuredClone(capturedTemplate);
  }

  const selectedAgentIds = new Set((workflow.resolution.phases ?? [])
    .map((phase) => phase.defaultAgent).filter(Boolean));
  const agents = new Map((config.agentCatalog ?? []).map((agent) => [agent.id, agent]));
  const executionDependencies = [];
  for (const agentId of [...selectedAgentIds].sort()) {
    const agent = agents.get(agentId);
    if (!agent?.file || !agent?.sha256) {
      fail(`Selected governed agent '${agentId}' is unavailable for snapshot capture.`, 'WFA_DEPENDENCY_UNAVAILABLE');
    }
    assets.push(await captureInstalledAgent(root, config, workId, agent));
    for (const dependency of agent.dependencies ?? []) {
      executionDependencies.push({
        id: `agent:${agentId}:${dependency.id}`, kind: dependency.type,
        availability: dependency.optional ? 'remote-optional' : 'remote-required',
        referenceSha256: domainHash('wfa.dependency-reference.v1', dependency.url),
        contentSha256: null, executable: dependency.type !== 'template'
      });
    }
  }
  if (assets.length > MAXIMUM_ASSETS) fail('Workflow snapshot has too many assets.', 'WFA_LIMIT_REACHED');
  const policyForDigest = clonePolicy(workflow.resolution);
  delete policyForDigest.policySha256;
  workflow.resolution.policySha256 = qualified(sha256(Buffer.from(canonicalJson(policyForDigest))));
  const policyBytes = Buffer.from(canonicalJson(clonePolicy(workflow.resolution)));
  if (policyBytes.byteLength > MAXIMUM_BUNDLE_BYTES) {
    fail('The effective workflow policy exceeds the workflow-snapshot bundle limit.', 'WFA_LIMIT_REACHED');
  }
  const policyBlob = await installBlob(root, config, workId, {
    bytes: policyBytes, size: policyBytes.byteLength, sha256: sha256(policyBytes),
    mediaType: 'application/json; profile=singularity-flow-effective-policy-v1'
  });
  const totalBytes = policyBlob.bytes + assets.reduce((sum, asset) => sum + asset.blob.bytes, 0);
  if (totalBytes > MAXIMUM_BUNDLE_BYTES) {
    fail('Workflow snapshot exceeds the 16 MiB aggregate bundle limit.', 'WFA_LIMIT_REACHED');
  }

  const configurationSource = workflow.resolution.configurationSource ?? null;
  if (configurationSource?.repository) assertCredentialFreeRemote(configurationSource.repository);
  const createdAt = workflow.workItem.createdAt;
  const manifest = {
    schemaVersion: currentSchemaVersion(SNAPSHOT_FAMILY), kind: SNAPSHOT_FAMILY,
    story: {
      repositoryId: domainHash('wfa.repository.v1', configurationSource?.repository ?? 'local-authority'),
      workId
    },
    revision: 1, parentSnapshotHash: null,
    policy: policyBlob,
    assets: assets.sort((left, right) => left.logicalId.localeCompare(right.logicalId)),
    executionDependencies: executionDependencies.sort((left, right) => left.id.localeCompare(right.id)),
    provenance: {
      configuration: configurationSource ? {
        repository: sanitizeRemote(configurationSource.repository) || null,
        commit: configurationSource.commit ?? null,
        filesSha256: configurationSource.filesSha256 ?? null
      } : null,
      workType: workflow.workItem.workType,
      foldProfile: 'singularity-flow-resolution-v1'
    },
    semantics: {
      snapshot: 'wfa-snapshot-v1', canonicalJson: 'singularity-flow-canonical-json-v1',
      policyReaderMinimum: 5
    },
    configFoldHash: domainHash('wfa.fold.v1', clonePolicy(workflow.resolution)),
    createdAt,
    limits: { assets: assets.length, bytes: totalBytes },
    snapshotHash: null
  };
  manifest.snapshotHash = domainHash('wfa.snapshot.v1', manifestCore(manifest));
  const manifestPath = storyRelative(config, workId, 'config/wfa/snapshots/000001/manifest.json');
  const target = await secureRepositoryPath(root, manifestPath, { label: 'Workflow snapshot manifest' });
  if (target.exists) fail('Workflow snapshot revision 1 already exists.', 'WFA_REVISION_CONFLICT');
  await mkdir(path.dirname(target.absolute), { recursive: true });
  await writeJson(target.absolute, manifest);
  return {
    enrollment: 'wfa', schemaVersion: currentSchemaVersion(SNAPSHOT_REFERENCE_FAMILY), revision: 1,
    snapshotHash: manifest.snapshotHash, manifestPath,
    genesisSnapshotHash: manifest.snapshotHash
  };
}

/**
 * Seal the last in-memory creation additions at the first governed commit boundary.
 *
 * `createWorkflow` is a draft builder: callers may still bind an accepted Auto plan, Change Flight
 * Plan, or other creation-only policy before their transaction commits. An unaccepted revision-one
 * directory may therefore be replaced inside that same locked transaction. Callers must prove
 * separately that no creation commit exists; this function is never an amendment mechanism.
 */
export async function finalizeDraftWorkflowSnapshot(root, config, workflow) {
  try {
    const verification = await verifyWorkflowSnapshot(root, config, workflow);
    if (verification.enrolled) return workflow.workflowSnapshot;
  } catch {
    // Any incomplete or inconsistent draft is replaceable before its first accepted commit. The
    // caller proves that boundary; accepted snapshots never enter this function.
  }
  const relative = storyRelative(config, workflow.workItem.id, 'config/wfa');
  const target = await secureRepositoryPath(root, relative, {
    label: 'Unaccepted workflow snapshot draft'
  });
  if (target.exists && !target.entry.isDirectory()) {
    fail('Unaccepted workflow snapshot draft is not a directory.', 'WFA_PATH_REFUSED');
  }
  if (target.exists) await rm(target.absolute, { recursive: true, force: true });
  delete workflow.workflowSnapshot;
  workflow.workflowSnapshot = await captureWorkflowSnapshot(root, config, workflow);
  return workflow.workflowSnapshot;
}

async function verifyBlob(root, blob, label) {
  if (!blob || typeof blob !== 'object') fail(`${label} has no blob reference.`);
  const digest = digestHex(blob.sha256, `${label} blob`);
  const expectedPath = `/config/wfa/blobs/sha256/${digest}`;
  if (!String(blob.path ?? '').endsWith(expectedPath)) {
    fail(`${label} points outside the content-addressed snapshot store.`, 'WFA_PATH_REFUSED');
  }
  const safe = await secureRepositoryPath(root, blob.path, {
    label: `${label} blob`, mustExist: true, type: 'file'
  });
  const captured = await stableFile(safe.absolute, `${label} blob`);
  if (captured.sha256 !== digest || captured.size !== blob.bytes) {
    fail(`${label} blob bytes do not match the accepted snapshot.`);
  }
  return captured;
}

export async function verifyWorkflowSnapshot(root, config, workflow) {
  const storedReference = workflow.workflowSnapshot ?? null;
  if (!storedReference) return {
    status: 'legacy', enrolled: false, closure: 'unproven', reason: 'snapshot-reference-absent'
  };
  const reference = readRecord(SNAPSHOT_REFERENCE_FAMILY, storedReference).record;
  if (reference.enrollment !== 'wfa'
      || !Number.isSafeInteger(reference.revision) || reference.revision < 1
      || !/^sha256:[a-f0-9]{64}$/.test(reference.snapshotHash ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(reference.genesisSnapshotHash ?? '')) {
    fail('Story workflow snapshot reference is malformed.');
  }
  const expectedPrefix = `${storyRelative(config, workflow.workItem.id)}/config/wfa/snapshots/`;
  if (!String(reference.manifestPath ?? '').startsWith(expectedPrefix)) {
    fail('Story workflow snapshot manifest is outside the configured Story root.', 'WFA_PATH_REFUSED');
  }
  const safe = await secureRepositoryPath(root, reference.manifestPath, {
    label: 'Workflow snapshot manifest', mustExist: true, type: 'file'
  });
  let manifest;
  try { manifest = readRecord(SNAPSHOT_FAMILY, await readJson(safe.absolute)).record; }
  catch (error) {
    if (error instanceof SingularityFlowError && String(error.code ?? '').startsWith('WFA_')) throw error;
    fail('Workflow snapshot manifest cannot be read with this runtime.', 'WFA_RUNTIME_INCOMPATIBLE');
  }
  if (manifest.kind !== SNAPSHOT_FAMILY || manifest.story?.workId !== workflow.workItem.id
      || manifest.revision !== reference.revision
      || manifest.snapshotHash !== reference.snapshotHash
      || domainHash('wfa.snapshot.v1', manifestCore(manifest)) !== manifest.snapshotHash) {
    fail('Workflow snapshot manifest identity does not match its accepted Story reference.');
  }
  if (manifest.revision === 1 && manifest.parentSnapshotHash !== null) {
    fail('Workflow snapshot genesis has an unexpected parent.');
  }
  const policy = await verifyBlob(root, manifest.policy, 'Effective workflow policy');
  let capturedPolicy;
  try { capturedPolicy = JSON.parse(policy.bytes.toString('utf8')); }
  catch { fail('Captured workflow policy is not valid JSON.'); }
  if (canonicalJson(capturedPolicy) !== canonicalJson(clonePolicy(workflow.resolution))
      || manifest.configFoldHash !== domainHash('wfa.fold.v1', capturedPolicy)) {
    fail('Workflow compatibility projection differs from its accepted snapshot policy.');
  }
  if (!Array.isArray(manifest.assets) || manifest.assets.length > MAXIMUM_ASSETS) {
    fail('Workflow snapshot asset manifest is invalid.', 'WFA_LIMIT_REACHED');
  }
  let totalBytes = policy.size;
  const logicalIds = new Set();
  for (const asset of manifest.assets) {
    if (!asset?.logicalId || logicalIds.has(asset.logicalId)) fail('Workflow snapshot asset identities are invalid.');
    logicalIds.add(asset.logicalId);
    const captured = await verifyBlob(root, asset.blob, `Workflow snapshot asset '${asset.logicalId}'`);
    totalBytes += captured.size;
  }
  if (totalBytes > MAXIMUM_BUNDLE_BYTES || manifest.limits?.bytes !== totalBytes
      || manifest.limits?.assets !== manifest.assets.length) {
    fail('Workflow snapshot closure does not match its accepted resource accounting.', 'WFA_LIMIT_REACHED');
  }
  return {
    status: 'ready', enrolled: true, closure: 'verified', revision: manifest.revision,
    snapshotHash: manifest.snapshotHash, genesisSnapshotHash: reference.genesisSnapshotHash,
    manifestPath: reference.manifestPath, assets: manifest.assets.length,
    bytes: totalBytes, executionDependencies: manifest.executionDependencies ?? [],
    provenance: manifest.provenance, semantics: manifest.semantics
  };
}

export async function workflowSnapshotDrift(root, config, workflow, observedConfiguration = null) {
  const snapshot = await verifyWorkflowSnapshot(root, config, workflow);
  if (!snapshot.enrolled) return { ...snapshot, drift: 'unknown', reason: 'legacy-closure-unproven' };
  const pinned = snapshot.provenance?.configuration ?? null;
  if (!observedConfiguration) return { ...snapshot, drift: 'unavailable', observed: null };
  const revisionChanged = pinned?.commit !== observedConfiguration.commit
    || pinned?.repository !== (sanitizeRemote(observedConfiguration.repository) || null);
  const effectiveChanged = pinned?.filesSha256 && observedConfiguration.filesSha256
    ? canonicalJson(pinned.filesSha256) !== canonicalJson(observedConfiguration.filesSha256)
    : null;
  return {
    ...snapshot,
    drift: !revisionChanged ? 'unchanged'
      : effectiveChanged === false ? 'revision-changed/effective-policy-unchanged' : 'changed',
    observed: {
      repository: sanitizeRemote(observedConfiguration.repository) || null,
      commit: observedConfiguration.commit ?? null,
      filesSha256: observedConfiguration.filesSha256 ?? null
    }
  };
}
