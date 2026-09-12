import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { readLocalGitBlobs } from './git-blob-batch.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { syncAgent } from './agents.mjs';
import { assertCredentialFreeRemote, sanitizeRemote } from './git-remote-diagnostics.mjs';
import {
  SingularityFlowError, posix, readJson, run, secureRepositoryPath, writeBytes, writeJson
} from './util.mjs';

const SNAPSHOT_FAMILY = 'workflow-snapshot';
const SNAPSHOT_REFERENCE_FAMILY = 'workflow-snapshot-reference';
const MAXIMUM_ASSET_BYTES = 1024 * 1024;
const MAXIMUM_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ASSETS = 2048;
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QUALIFIED_SHA256 = /^sha256:[a-f0-9]{64}$/;
const DEPENDENCY_KINDS = new Set(['skill', 'template', 'generated']);
const DEPENDENCY_AVAILABILITY = new Set(['remote-optional', 'remote-required']);
const CURRENT_DEPENDENCY_FIELDS = Object.freeze([
  'agentId', 'assetLogicalId', 'availability', 'contentSha256', 'dependencyId', 'executable',
  'id', 'inclusion', 'kind', 'optional', 'referenceSha256'
]);
const LEGACY_DEPENDENCY_FIELDS = Object.freeze([
  'availability', 'contentSha256', 'executable', 'id', 'kind', 'referenceSha256'
]);
// Capability token for the one in-memory Story builder that captured these draft bytes. A boolean
// option would let any caller weaken accepted execution; a WeakMap entry cannot survive reload,
// cloning, or process restart and cannot be manufactured outside this module.
const RETAINED_CREATION_DRAFTS = new WeakMap();

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

async function captureAgentExecutionDependencies(root, config, workId, agent) {
  if (!(agent.dependencies ?? []).length) return { assets: [], dependencies: [] };
  let synchronized = null;
  try {
    synchronized = await syncAgent(root, agent.id);
    if (synchronized.agent?.sha256 !== agent.sha256) {
      fail(
        `Governed agent '${agent.id}' changed while its saved dependencies were resolved.`,
        'WFA_SOURCE_STALE'
      );
    }
  } catch (error) {
    if ((agent.dependencies ?? []).some((dependency) => !dependency.optional)) {
      fail(
        `Required saved dependency for governed agent '${agent.id}' is unavailable: ${error.message}`,
        'WFA_DEPENDENCY_UNAVAILABLE'
      );
    }
  }
  const assets = [];
  const dependencies = [];
  for (const declaration of agent.dependencies ?? []) {
    const logicalId = `agent:${agent.id}:${declaration.type}:${declaration.id}`;
    const materialized = synchronized?.dependencies?.find((entry) => (
      entry.id === declaration.id && entry.type === declaration.type
    )) ?? null;
    const referenceSha256 = domainHash(
      'wfa.dependency-reference.v1',
      `${declaration.type}\0${declaration.id}\0${declaration.url}`
    );
    if (declaration.type === 'generated' || materialized?.dynamic) {
      dependencies.push({
        id: logicalId, agentId: agent.id, dependencyId: declaration.id,
        kind: declaration.type, optional: declaration.optional === true,
        availability: declaration.optional ? 'remote-optional' : 'remote-required',
        inclusion: 'external-requirement', assetLogicalId: null,
        referenceSha256, contentSha256: null, executable: true
      });
      continue;
    }
    if (!materialized?.path || materialized.status !== 'ready') {
      if (!declaration.optional) {
        fail(
          `Required ${declaration.type} '${declaration.id}' for governed agent '${agent.id}' is unavailable.`,
          'WFA_DEPENDENCY_UNAVAILABLE'
        );
      }
      dependencies.push({
        id: logicalId, agentId: agent.id, dependencyId: declaration.id,
        kind: declaration.type, optional: true, availability: 'remote-optional', inclusion: 'omitted',
        assetLogicalId: null, referenceSha256, contentSha256: null,
        executable: false
      });
      continue;
    }
    const captured = await stableFile(
      materialized.path, `Saved ${declaration.type} '${agent.id}/${declaration.id}'`
    );
    if (materialized.sha256 && captured.sha256 !== digestHex(
      materialized.sha256, `Saved ${declaration.type} '${agent.id}/${declaration.id}'`
    )) {
      fail(
        `Saved ${declaration.type} '${agent.id}/${declaration.id}' differs from its reviewed lock.`,
        'WFA_SOURCE_STALE'
      );
    }
    const blob = await installBlob(root, config, workId, {
      ...captured, mediaType: 'text/markdown; charset=utf-8'
    });
    assets.push({
      logicalId, purpose: `agent-${declaration.type}`, dependencies: [`agent:${agent.id}`],
      blob,
      source: {
        kind: 'reviewed-agent-dependency', agentId: agent.id,
        dependencyId: declaration.id, referenceSha256, sha256: blob.sha256
      }
    });
    dependencies.push({
      id: logicalId, agentId: agent.id, dependencyId: declaration.id,
      kind: declaration.type, optional: declaration.optional === true,
      availability: declaration.optional ? 'remote-optional' : 'remote-required',
      inclusion: 'included', assetLogicalId: logicalId, referenceSha256,
      contentSha256: blob.sha256, executable: false
    });
  }
  return { assets, dependencies };
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

  // `resolution.agents` is the captured selection catalog. A Story must never advertise a live
  // agent that its portable closure cannot execute. Older callers without that catalog retain the
  // explicitly selected creation agent and every phase default.
  const selectedAgentIds = new Set([
    ...Object.keys(workflow.resolution.agents ?? {}),
    ...(workflow.resolution.phases ?? []).map((phase) => phase.defaultAgent).filter(Boolean),
    ...(workflow.history ?? []).map((entry) => entry.event === 'work_started' ? entry.agent : null)
      .filter(Boolean)
  ]);
  const agents = new Map((config.agentCatalog ?? []).map((agent) => [agent.id, agent]));
  const executionDependencies = [];
  for (const agentId of [...selectedAgentIds].sort()) {
    const agent = agents.get(agentId);
    if (!agent?.file || !agent?.sha256) {
      fail(`Selected governed agent '${agentId}' is unavailable for snapshot capture.`, 'WFA_DEPENDENCY_UNAVAILABLE');
    }
    assets.push(await captureInstalledAgent(root, config, workId, agent));
    const capturedDependencies = await captureAgentExecutionDependencies(
      root, config, workId, agent
    );
    assets.push(...capturedDependencies.assets);
    executionDependencies.push(...capturedDependencies.dependencies);
  }
  if (assets.length > MAXIMUM_ASSETS) fail('Workflow snapshot has too many assets.', 'WFA_LIMIT_REACHED');
  const capturedAssetIndex = new Map();
  for (const asset of assets) {
    if (!asset?.logicalId || capturedAssetIndex.has(asset.logicalId)) {
      fail('Workflow snapshot asset identities are invalid.');
    }
    capturedAssetIndex.set(asset.logicalId, asset);
  }
  // Refuse ambiguous dependency declarations before the Story snapshot can be written or accepted.
  // Reading performs the same validation so a self-rehashed historical payload cannot exploit a
  // different logical ID for the same {agent, kind, dependency} declaration.
  assertDependencyClosure({ executionDependencies }, capturedAssetIndex);
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
      policyReaderMinimum: 5,
      agentDocumentParser: 'sflow-agent-document-v1',
      promptComposer: 'story-snapshot-agent-v1'
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
  const reference = {
    enrollment: 'wfa', schemaVersion: currentSchemaVersion(SNAPSHOT_REFERENCE_FAMILY), revision: 1,
    snapshotHash: manifest.snapshotHash, manifestPath,
    genesisSnapshotHash: manifest.snapshotHash
  };
  RETAINED_CREATION_DRAFTS.set(workflow, Object.freeze(structuredClone(reference)));
  return reference;
}

/** True only before the exact in-memory Story object's first immutable creation commit exists. */
export function hasRetainedWorkflowSnapshotDraft(root, config, workflow) {
  const retained = workflow && RETAINED_CREATION_DRAFTS.get(workflow);
  if (!retained || canonicalJson(retained) !== canonicalJson(workflow.workflowSnapshot)) return false;
  const workflowRelative = storyRelative(config, workflow.workItem.id, 'workflow.json');
  const accepted = run('git', [
    'log', '--format=%H', '--diff-filter=A', '--max-count=1', '--', workflowRelative
  ], { cwd: root, allowFailure: true }).stdout.trim();
  return !accepted;
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

function exactStoryBlobPath(config, workId, digest) {
  return storyRelative(config, workId, `config/wfa/blobs/sha256/${digest}`);
}

function gitTreeEntries(root, commit, paths, label) {
  const entries = new Map();
  for (let offset = 0; offset < paths.length; offset += 256) {
    const selected = paths.slice(offset, offset + 256);
    const listed = run('git', ['ls-tree', '-z', commit, '--', ...selected], {
      cwd: root, encoding: 'buffer', allowFailure: true,
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      maxBuffer: Math.max(64 * 1024, selected.length * 1024)
    });
    if (listed.status !== 0) {
      fail(`${label} cannot be read from the immutable Story creation commit.`,
        'WFA_DEPENDENCY_UNAVAILABLE');
    }
    const output = Buffer.isBuffer(listed.stdout) ? listed.stdout : Buffer.from(listed.stdout ?? '');
    for (const raw of output.toString('utf8').split('\0').filter(Boolean)) {
      const tab = raw.indexOf('\t');
      const match = tab < 0 ? null : raw.slice(0, tab).match(/^(100644|100755|120000|160000) blob ([a-f0-9]{40,64})$/);
      const relative = tab < 0 ? '' : raw.slice(tab + 1);
      if (!match || !selected.includes(relative) || entries.has(relative)) {
        fail(`${label} has an invalid Git object binding.`, 'WFA_SNAPSHOT_INVALID');
      }
      if (!['100644', '100755'].includes(match[1])) {
        fail(`${label} '${relative}' is not an ordinary Git blob.`, 'WFA_PATH_REFUSED');
      }
      entries.set(relative, { mode: match[1], oid: match[2] });
    }
  }
  const missing = paths.filter((relative) => !entries.has(relative));
  if (missing.length) {
    fail(`${label} is missing ${missing[0]} from the immutable Story creation commit.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  const blobs = readLocalGitBlobs(root, [...entries.values()].map((entry) => entry.oid), {
    maximumBytes: MAXIMUM_BUNDLE_BYTES,
    maximumObjectBytes: MAXIMUM_ASSET_BYTES,
    code: 'WFA_DEPENDENCY_UNAVAILABLE',
    label
  });
  return new Map([...entries].map(([relative, entry]) => [relative, blobs.get(entry.oid)]));
}

function initialSnapshotAuthority(root, config, workId) {
  const workflowRelative = storyRelative(config, workId, 'workflow.json');
  const history = run('git', [
    'log', '--format=%H', '--diff-filter=A', '--reverse', '--', workflowRelative
  ], { cwd: root, allowFailure: true }).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (!history.length) {
    fail(
      `Story '${workId}' execution closure has not reached an immutable creation commit.`,
      'WFA_DEPENDENCY_UNAVAILABLE'
    );
  }
  const commit = history[0];
  const bytes = gitTreeEntries(root, commit, [workflowRelative], 'Story creation record')
    .get(workflowRelative);
  let workflow;
  try { workflow = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch {
    fail(`Story '${workId}' immutable creation record is not valid UTF-8 JSON.`,
      'WFA_SNAPSHOT_INVALID');
  }
  return { commit, workflow, workflowRelative };
}

async function verifyBlob(root, config, workId, blob, label, { acceptedBytes = null } = {}) {
  if (!blob || typeof blob !== 'object') fail(`${label} has no blob reference.`);
  const digest = digestHex(blob.sha256, `${label} blob`);
  const expectedPath = exactStoryBlobPath(config, workId, digest);
  if (String(blob.path ?? '') !== expectedPath) {
    fail(`${label} points outside the content-addressed snapshot store.`, 'WFA_PATH_REFUSED');
  }
  if (acceptedBytes) {
    const bytes = acceptedBytes.get(expectedPath);
    if (!bytes || sha256(bytes) !== digest || bytes.byteLength !== blob.bytes) {
      fail(`${label} blob bytes do not match the immutable Story creation commit.`);
    }
    return { bytes: Buffer.from(bytes), sha256: digest, size: bytes.byteLength };
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

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertExactFields(record, expected, label) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail(`${label} must be an object.`);
  }
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    fail(`${label} has an invalid record shape.`);
  }
}

function dependencySemanticIdentity(dependency) {
  if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) {
    fail('Workflow snapshot execution dependency must be an object.');
  }
  const current = ['agentId', 'dependencyId', 'inclusion', 'optional', 'assetLogicalId']
    .some((field) => hasOwn(dependency, field));
  if (current) {
    if (!KEBAB_ID.test(dependency.agentId ?? '')
        || !KEBAB_ID.test(dependency.dependencyId ?? '')
        || !DEPENDENCY_KINDS.has(dependency.kind)) {
      fail('Workflow snapshot execution dependency has an invalid semantic identity.');
    }
    return {
      current: true,
      agentId: dependency.agentId,
      dependencyId: dependency.dependencyId,
      kind: dependency.kind,
      key: canonicalJson([dependency.agentId, dependency.kind, dependency.dependencyId])
    };
  }
  const legacy = /^agent:([a-z0-9]+(?:-[a-z0-9]+)*):([a-z0-9]+(?:-[a-z0-9]+)*)$/
    .exec(String(dependency.id ?? ''));
  if (!legacy || !DEPENDENCY_KINDS.has(dependency.kind)) {
    fail('Legacy workflow snapshot dependency has an invalid semantic identity.');
  }
  return {
    current: false, agentId: legacy[1], dependencyId: legacy[2], kind: dependency.kind,
    key: canonicalJson([legacy[1], dependency.kind, legacy[2]])
  };
}

function assertExecutionDependencyShape(dependency, identity) {
  const label = `Saved dependency '${dependency.id ?? 'unknown'}'`;
  if (identity.current) {
    assertExactFields(dependency, CURRENT_DEPENDENCY_FIELDS, label);
    const expectedId = `agent:${identity.agentId}:${identity.kind}:${identity.dependencyId}`;
    if (dependency.id !== expectedId || typeof dependency.optional !== 'boolean'
        || dependency.availability !== (dependency.optional ? 'remote-optional' : 'remote-required')
        || !QUALIFIED_SHA256.test(dependency.referenceSha256 ?? '')
        || typeof dependency.executable !== 'boolean') {
      fail(`${label} has inconsistent identity or availability fields.`);
    }
    if (dependency.inclusion === 'included') {
      if (dependency.assetLogicalId !== dependency.id
          || !QUALIFIED_SHA256.test(dependency.contentSha256 ?? '')
          || dependency.executable !== false) {
        fail(`${label} has an invalid retained-byte decision.`);
      }
      return;
    }
    if (dependency.inclusion === 'omitted') {
      if (dependency.optional !== true || dependency.assetLogicalId !== null
          || dependency.contentSha256 !== null || dependency.executable !== false) {
        fail(`${label} has an invalid omission decision.`);
      }
      return;
    }
    if (dependency.inclusion === 'external-requirement') {
      if (dependency.assetLogicalId !== null || dependency.contentSha256 !== null
          || dependency.executable !== true) {
        fail(`${label} has an invalid external requirement decision.`);
      }
      return;
    }
    fail(`${label} has an unsupported inclusion decision.`);
  }

  // Original v1 records did not carry agentId/dependencyId/inclusion fields and never retained
  // dependency bytes. Preserve that exact readable shape; anything partial or embellished is
  // ambiguous and fails closed rather than being upgraded in memory.
  assertExactFields(dependency, LEGACY_DEPENDENCY_FIELDS, label);
  if (!DEPENDENCY_AVAILABILITY.has(dependency.availability)
      || !QUALIFIED_SHA256.test(dependency.referenceSha256 ?? '')
      || dependency.contentSha256 !== null || typeof dependency.executable !== 'boolean') {
    fail(`${label} has an invalid legacy dependency record.`);
  }
}

function assertDependencyClosure(manifest, assetByLogicalId) {
  const dependencies = manifest.executionDependencies;
  if (!Array.isArray(dependencies)) {
    fail('Workflow snapshot execution-dependency manifest is invalid.');
  }
  if (dependencies.length > MAXIMUM_ASSETS) {
    fail('Workflow snapshot execution-dependency manifest is too large.', 'WFA_LIMIT_REACHED');
  }
  const dependencyIds = new Set();
  const semanticIdentities = new Set();
  for (const dependency of dependencies) {
    const identity = dependencySemanticIdentity(dependency);
    if (semanticIdentities.has(identity.key)) {
      fail(
        `Workflow snapshot has conflicting records for dependency '${identity.agentId}/${identity.kind}/${identity.dependencyId}'.`
      );
    }
    semanticIdentities.add(identity.key);
    if (!dependency.id || dependencyIds.has(dependency.id)) {
      fail('Workflow snapshot execution-dependency identities are invalid.');
    }
    dependencyIds.add(dependency.id);
    assertExecutionDependencyShape(dependency, identity);
    if (dependency.inclusion === 'included') {
      const asset = assetByLogicalId.get(dependency.assetLogicalId);
      if (!asset || asset.logicalId !== dependency.id
          || asset.purpose !== `agent-${identity.kind}`
          || canonicalJson(asset.dependencies) !== canonicalJson([`agent:${identity.agentId}`])
          || asset.blob.sha256 !== dependency.contentSha256
          || asset.source?.kind !== 'reviewed-agent-dependency'
          || asset.source?.agentId !== identity.agentId
          || asset.source?.dependencyId !== identity.dependencyId
          || asset.source?.referenceSha256 !== dependency.referenceSha256
          || asset.source?.sha256 !== dependency.contentSha256) {
        fail(
          `Required saved dependency '${dependency.id}' is not bound to its retained bytes.`,
          'WFA_DEPENDENCY_UNAVAILABLE'
        );
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const walk = (logicalId) => {
    if (visiting.has(logicalId)) fail(`Workflow snapshot dependency cycle includes '${logicalId}'.`);
    if (visited.has(logicalId)) return;
    const asset = assetByLogicalId.get(logicalId);
    if (!asset) fail(`Workflow snapshot dependency '${logicalId}' is missing.`, 'WFA_DEPENDENCY_UNAVAILABLE');
    if (!Array.isArray(asset.dependencies)
        || asset.dependencies.some((entry) => typeof entry !== 'string' || !entry)) {
      fail(`Workflow snapshot asset '${logicalId}' has invalid dependency links.`);
    }
    visiting.add(logicalId);
    for (const child of asset.dependencies ?? []) walk(child);
    visiting.delete(logicalId);
    visited.add(logicalId);
  };
  for (const logicalId of assetByLogicalId.keys()) walk(logicalId);
}

export async function verifyWorkflowSnapshot(root, config, workflow, {
  retainBytes = false, requireAccepted = false
} = {}) {
  let storedReference = workflow.workflowSnapshot ?? null;
  if (!storedReference) return {
    status: 'legacy', enrolled: false, closure: 'unproven', reason: 'snapshot-reference-absent'
  };
  let accepted = null;
  if (requireAccepted) {
    accepted = initialSnapshotAuthority(root, config, workflow.workItem.id);
    const acceptedReference = accepted.workflow?.workflowSnapshot ?? null;
    if (!acceptedReference
        || canonicalJson(acceptedReference) !== canonicalJson(storedReference)) {
      fail(
        `Story '${workflow.workItem.id}' workflow snapshot reference differs from its immutable creation commit.`,
        'WFA_SNAPSHOT_INVALID'
      );
    }
    storedReference = acceptedReference;
  }
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
  let manifestBytes = null;
  let safe = null;
  if (accepted) {
    manifestBytes = gitTreeEntries(
      root, accepted.commit, [reference.manifestPath], 'Workflow snapshot manifest'
    ).get(reference.manifestPath);
  } else {
    safe = await secureRepositoryPath(root, reference.manifestPath, {
      label: 'Workflow snapshot manifest', mustExist: true, type: 'file'
    });
  }
  let manifest;
  try {
    const source = accepted
      ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))
      : await readJson(safe.absolute);
    manifest = readRecord(SNAPSHOT_FAMILY, source).record;
  }
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
  const acceptedBlobBytes = accepted
    ? gitTreeEntries(root, accepted.commit, [
        manifest.policy?.path,
        ...(manifest.assets ?? []).map((asset) => asset?.blob?.path)
      ].filter(Boolean), 'Workflow snapshot closure')
    : null;
  const policy = await verifyBlob(
    root, config, workflow.workItem.id, manifest.policy, 'Effective workflow policy',
    { acceptedBytes: acceptedBlobBytes }
  );
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
  const assetByLogicalId = new Map();
  const retainedAssets = new Map();
  for (const asset of manifest.assets) {
    if (!asset?.logicalId || logicalIds.has(asset.logicalId)) fail('Workflow snapshot asset identities are invalid.');
    logicalIds.add(asset.logicalId);
    const captured = await verifyBlob(
      root, config, workflow.workItem.id, asset.blob,
      `Workflow snapshot asset '${asset.logicalId}'`, { acceptedBytes: acceptedBlobBytes }
    );
    assetByLogicalId.set(asset.logicalId, asset);
    if (retainBytes) retainedAssets.set(asset.logicalId, Buffer.from(captured.bytes));
    totalBytes += captured.size;
  }
  assertDependencyClosure(manifest, assetByLogicalId);
  if (totalBytes > MAXIMUM_BUNDLE_BYTES || manifest.limits?.bytes !== totalBytes
      || manifest.limits?.assets !== manifest.assets.length) {
    fail('Workflow snapshot closure does not match its accepted resource accounting.', 'WFA_LIMIT_REACHED');
  }
  const result = {
    status: 'ready', enrolled: true, closure: 'verified', revision: manifest.revision,
    snapshotHash: manifest.snapshotHash, genesisSnapshotHash: reference.genesisSnapshotHash,
    manifestPath: reference.manifestPath, assets: manifest.assets.length,
    bytes: totalBytes, executionDependencies: manifest.executionDependencies ?? [],
    provenance: manifest.provenance, semantics: manifest.semantics,
    creationCommit: accepted?.commit ?? null
  };
  if (retainBytes) {
    result.manifest = structuredClone(manifest);
    result.policy = capturedPolicy;
    result.assetBytes = retainedAssets;
  }
  return result;
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
