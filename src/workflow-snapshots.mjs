import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from './records.mjs';
import { readLocalGitBlobs } from './git-blob-batch.mjs';
import { runRemoteGit } from './git-execution.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { syncAgent } from './agents.mjs';
import { inspectApprovedSkillPackage } from './configuration-branch.mjs';
import { SKP_CAPTURE_LIMITS, SKP_PACKAGE_FORMAT, SKP_PARSER_PROFILE,
  verifySkillPackage } from './skp-package.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import {
  assertCredentialFreeRemote, configuredRemoteIdentity, frozenRemoteTransport, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import {
  SingularityFlowError, posix, readJson, run, secureRepositoryPath, writeBytes, writeJson
} from './util.mjs';

const SNAPSHOT_FAMILY = 'workflow-snapshot';
const SNAPSHOT_REFERENCE_FAMILY = 'workflow-snapshot-reference';
const MAXIMUM_ASSET_BYTES = 1024 * 1024;
const MAXIMUM_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAXIMUM_ASSETS = 2048;
const MAXIMUM_SKILL_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAXIMUM_SKILL_SNAPSHOT_BYTES = MAXIMUM_BUNDLE_BYTES + MAXIMUM_SKILL_BUNDLE_BYTES;
const MAXIMUM_SKILL_ASSETS = 8192;
const MAXIMUM_SKILL_PACKAGES = 32;
const MAXIMUM_V2_MANIFEST_BYTES = 8 * 1024 * 1024;
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
const DEFAULT_PLANNING_PROMPT = 'singularity/prompts/copilot-planning.md';
// Snapshot objects are opaque bytes, not checkout text. Without a nearer attribute rule,
// core.autocrlf or a repository-wide `text` rule can rewrite a CRLF agent/template while `git
// add` accepts the new Story. The manifest would then name the captured bytes but the immutable
// creation commit would contain different bytes, making a Story created on Windows impossible to
// resume. Keep the generated object store binary; readers still use accepted Git blobs so a
// machine-local higher-precedence attribute cannot affect execution.
const SNAPSHOT_BLOB_ATTRIBUTES = Buffer.from('* -text\n');

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

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
  const attributesRelative = storyRelative(
    config, workId, 'config/wfa/blobs/.gitattributes'
  );
  const attributes = await secureRepositoryPath(root, attributesRelative, {
    label: 'Workflow snapshot blob attributes'
  });
  if (attributes.exists) {
    const current = await stableFile(
      attributes.absolute, 'Workflow snapshot blob attributes'
    );
    if (!current.bytes.equals(SNAPSHOT_BLOB_ATTRIBUTES)) {
      fail(
        'Workflow snapshot blob attributes must preserve exact opaque bytes.',
        'WFA_SOURCE_STALE'
      );
    }
  } else {
    await mkdir(path.dirname(attributes.absolute), { recursive: true });
    await writeBytes(attributes.absolute, SNAPSHOT_BLOB_ATTRIBUTES);
  }
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

async function capturePackagedPlanningPrompt(root, config, workId) {
  const captured = await stableFile(
    path.join(PACKAGE_ROOT, 'templates', 'copilot-planning.md'),
    'Packaged default planning prompt'
  );
  const blob = await installBlob(root, config, workId, {
    ...captured, mediaType: 'text/markdown; charset=utf-8'
  });
  return {
    logicalId: 'prompt:planning', purpose: 'planning-prompt', dependencies: [], blob,
    source: {
      kind: 'packaged-default', source: 'templates/copilot-planning.md', sha256: blob.sha256
    }
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

function selectedSkillBindings(policy) {
  const packages = new Map();
  const phaseIds = new Set();
  for (const phase of policy.phases ?? []) {
    if (!phase || !KEBAB_ID.test(phase.id ?? '') || phaseIds.has(phase.id)) {
      fail('Selected workflow phase identities are invalid.');
    }
    phaseIds.add(phase.id);
    if (phase.kind !== 'skill') {
      if (phase.skillBinding != null) {
        fail(`Phase '${phase.id}' has a skill binding without a skill producer.`);
      }
      continue;
    }
    if (!KEBAB_ID.test(phase.defaultAgent ?? '')) {
      fail(`Skill phase '${phase.id}' has no exact selected governed agent.`,
        'WFA_DEPENDENCY_UNAVAILABLE');
    }
    const binding = phase.skillBinding;
    const bindingVersion = Number(binding?.schemaVersion);
    const refs = binding?.bindingRefs;
    const skill = refs?.skill;
    if (bindingVersion !== 1 || binding.compiler !== 'skp-contract/v1'
        || binding.parserProfile !== SKP_PARSER_PROFILE
        || !QUALIFIED_SHA256.test(binding.compilationSha256 ?? '')
        || !QUALIFIED_SHA256.test(refs?.contractSha256 ?? '')
        || !KEBAB_ID.test(skill?.id ?? '')
        || !QUALIFIED_SHA256.test(skill?.packageSha256 ?? '')) {
      fail(`Skill phase '${phase.id}' has no complete confirmed package/contract binding.`,
        'WFA_DEPENDENCY_UNAVAILABLE');
    }
    const phaseBinding = {
      phaseId: phase.id,
      contractSha256: refs.contractSha256,
      compilationSha256: binding.compilationSha256,
      parserProfile: binding.parserProfile,
      bindingRefsSha256: domainHash('skp.binding-refs.v1', refs)
    };
    const current = packages.get(skill.id);
    if (current && current.packageSha256 !== skill.packageSha256) {
      fail(`Skill '${skill.id}' has conflicting selected package versions.`,
        'WFA_DEPENDENCY_UNAVAILABLE');
    }
    if (current) current.phaseBindings.push(phaseBinding);
    else packages.set(skill.id, {
      skillId: skill.id, packageSha256: skill.packageSha256,
      phaseBindings: [phaseBinding]
    });
  }
  if (packages.size > MAXIMUM_SKILL_PACKAGES) {
    fail(`Story selects more than ${MAXIMUM_SKILL_PACKAGES} skill packages.`, 'WFA_LIMIT_REACHED');
  }
  return [...packages.values()].sort((left, right) => compareText(left.skillId, right.skillId));
}

async function captureApprovedSkillPackages(root, config, workId, selected, approvedSnapshot,
  retainedDraftSkillPackages = null, pinnedConfigurationCommit = null) {
  if (!selected.length) return { assets: [], skillPackages: [], bytes: 0 };
  if (!approvedSnapshot && !retainedDraftSkillPackages) {
    fail('Selected skill phases require the exact approved configuration snapshot at Story start.',
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  // Inspect all selected packages before writing any skill blob. The configuration owner proves
  // this snapshot was approved; the package owner verifies its complete immutable byte manifest.
  const captures = [];
  let selectedBytes = 0;
  for (const choice of selected) {
    const capture = approvedSnapshot
      ? await inspectApprovedSkillPackage(approvedSnapshot, choice.skillId, {
          expectedPackageSha256: choice.packageSha256
        })
      : retainedDraftSkillPackages.get(choice.skillId);
    if (!capture || capture.manifest?.packageSha256 !== choice.packageSha256) {
      fail(`Selected skill '${choice.skillId}' is not retained at its confirmed package version.`,
        'WFA_DEPENDENCY_UNAVAILABLE');
    }
    if (pinnedConfigurationCommit && capture.source?.commit !== pinnedConfigurationCommit) {
      fail(`Selected skill '${choice.skillId}' differs from the Story's pinned configuration commit.`,
        'WFA_SOURCE_STALE');
    }
    const verified = verifySkillPackage(capture);
    selectedBytes += verified.bytes;
    if (selectedBytes > MAXIMUM_SKILL_BUNDLE_BYTES) {
      fail('Selected skill packages exceed the 64 MiB Story retention limit.', 'WFA_LIMIT_REACHED');
    }
    captures.push({ choice, capture });
  }
  const assets = [];
  const skillPackages = [];
  for (const { choice, capture } of captures) {
    const files = [];
    for (let index = 0; index < capture.manifest.files.length; index += 1) {
      const file = capture.manifest.files[index];
      const bytes = capture.contents.get(file.path);
      const logicalId = `skill:${choice.skillId}:file:${String(index + 1).padStart(3, '0')}`;
      const blob = await installBlob(root, config, workId, {
        bytes, size: bytes.byteLength, sha256: digestHex(file.sha256, `Skill '${choice.skillId}' file`),
        mediaType: file.role === 'instructions' || file.role === 'reference'
          ? 'text/markdown; charset=utf-8' : 'application/octet-stream'
      });
      assets.push({
        logicalId, purpose: 'skill-package-file', dependencies: [], blob,
        source: {
          kind: 'approved-skill-package', skillId: choice.skillId,
          packageSha256: choice.packageSha256, path: file.path,
          configurationCommit: capture.source?.commit ?? null, sha256: blob.sha256
        }
      });
      files.push({ path: file.path, assetLogicalId: logicalId });
    }
    skillPackages.push({
      skillId: choice.skillId, manifest: structuredClone(capture.manifest),
      phaseBindings: choice.phaseBindings, files
    });
  }
  return { assets, skillPackages, bytes: selectedBytes };
}

/**
 * Capture the exact declarative bytes a newly created Story needs to interpret its pinned policy.
 * This is part of the Story-start draft transaction: a failure leaves no accepted Story commit.
 */
export async function captureWorkflowSnapshot(root, config, workflow, {
  approvedConfigurationSnapshot = null,
  retainedDraftSkillPackages = null
} = {}) {
  const workId = workflow.workItem.id;
  const assets = [];
  const selectedSkills = selectedSkillBindings(workflow.resolution);
  const skillClosure = await captureApprovedSkillPackages(
    root, config, workId, selectedSkills, approvedConfigurationSnapshot,
    retainedDraftSkillPackages, workflow.resolution.configurationSource?.commit ?? null
  );
  assets.push(...skillClosure.assets);
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

  const planning = workflow.resolution.planning ?? null;
  if (planning?.enabled !== false && planning?.promptSource) {
    const source = await secureRepositoryPath(root, planning.promptSource, {
      label: 'Planning prompt', type: 'file'
    });
    const asset = source.exists
      ? await captureRepositoryAsset(root, config, workId, {
          logicalId: 'prompt:planning', purpose: 'planning-prompt',
          relativePath: planning.promptSource
        })
      : planning.promptSource === DEFAULT_PLANNING_PROMPT
        ? await capturePackagedPlanningPrompt(root, config, workId)
        : fail(`Planning prompt is unavailable: ${planning.promptSource}`,
          'WFA_DEPENDENCY_UNAVAILABLE');
    assets.push(asset);
    workflow.resolution.planningPromptSnapshot = {
      source: 'workflow-snapshot',
      sourcePath: asset.source.kind === 'repository-path' ? asset.source.path : asset.source.source,
      path: asset.blob.path,
      sha256: digestHex(asset.blob.sha256, 'Planning prompt')
    };
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
  const assetLimit = selectedSkills.length ? MAXIMUM_SKILL_ASSETS : MAXIMUM_ASSETS;
  if (assets.length > assetLimit) fail('Workflow snapshot has too many assets.', 'WFA_LIMIT_REACHED');
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
  const totalLimit = selectedSkills.length ? MAXIMUM_SKILL_SNAPSHOT_BYTES : MAXIMUM_BUNDLE_BYTES;
  if (totalBytes > totalLimit) {
    fail(`Workflow snapshot exceeds the ${totalLimit / (1024 * 1024)} MiB aggregate bundle limit.`,
      'WFA_LIMIT_REACHED');
  }

  const configurationSource = workflow.resolution.configurationSource ?? null;
  if (configurationSource?.repository) assertCredentialFreeRemote(configurationSource.repository);
  const createdAt = workflow.workItem.createdAt;
  const manifest = {
    // Template-only Stories preserve the original v1 manifest and hash semantics. v2 is used
    // only when the accepted policy selects at least one skill producer.
    schemaVersion: selectedSkills.length ? currentSchemaVersion(SNAPSHOT_FAMILY) : 1,
    kind: SNAPSHOT_FAMILY,
    story: {
      repositoryId: domainHash('wfa.repository.v1', configurationSource?.repository ?? 'local-authority'),
      workId
    },
    revision: 1, parentSnapshotHash: null,
    policy: policyBlob,
    assets: assets.sort((left, right) => selectedSkills.length
      ? compareText(left.logicalId, right.logicalId)
      : left.logicalId.localeCompare(right.logicalId)),
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
      snapshot: selectedSkills.length ? 'wfa-snapshot-v2' : 'wfa-snapshot-v1',
      canonicalJson: 'singularity-flow-canonical-json-v1',
      policyReaderMinimum: selectedSkills.length ? 9 : 5,
      agentDocumentParser: 'sflow-agent-document-v1',
      promptComposer: 'story-snapshot-agent-v1',
      ...(selectedSkills.length ? {
        skillPackageReader: SKP_PACKAGE_FORMAT,
        skillTextParser: SKP_PARSER_PROFILE,
        skillPhaseBinding: 'skp-contract/v1'
      } : {})
    },
    configFoldHash: domainHash('wfa.fold.v1', clonePolicy(workflow.resolution)),
    createdAt,
    limits: { assets: assets.length, bytes: totalBytes },
    snapshotHash: null
  };
  if (selectedSkills.length) manifest.skillPackages = skillClosure.skillPackages;
  manifest.snapshotHash = domainHash(
    selectedSkills.length ? 'wfa.snapshot.v2' : 'wfa.snapshot.v1', manifestCore(manifest)
  );
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

async function readRetainedDraftSkillPackages(root, config, workflow) {
  const reference = workflow.workflowSnapshot;
  if (!reference?.manifestPath) {
    fail('Unaccepted skill Story has no prior retained package closure.',
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  const safe = await secureRepositoryPath(root, reference.manifestPath, {
    label: 'Unaccepted skill snapshot manifest', mustExist: true, type: 'file'
  });
  const raw = await readJson(safe.absolute);
  if (readRecord(SNAPSHOT_FAMILY, raw).storedVersion !== 2) {
    fail('Unaccepted skill Story has no v2 retained package closure.',
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  const policy = await verifyBlob(root, config, workflow.workItem.id, raw.policy,
    'Unaccepted skill snapshot policy');
  let previousResolution;
  try { previousResolution = JSON.parse(policy.bytes.toString('utf8')); }
  catch { fail('Unaccepted skill snapshot policy is invalid.'); }
  const previous = await verifyWorkflowSnapshot(root, config, {
    ...workflow, resolution: previousResolution
  }, { retainBytes: true });
  const packages = new Map();
  for (const record of previous.manifest.skillPackages ?? []) {
    const contents = new Map();
    for (const file of record.files) {
      contents.set(file.path, Buffer.from(previous.assetBytes.get(file.assetLogicalId)));
    }
    const firstAsset = previous.manifest.assets.find((asset) =>
      asset.logicalId === record.files[0]?.assetLogicalId);
    packages.set(record.skillId, {
      manifest: record.manifest, contents,
      source: { commit: firstAsset?.source?.configurationCommit ?? null }
    });
  }
  return packages;
}

/**
 * Seal the last in-memory creation additions at the first governed commit boundary.
 *
 * `createWorkflow` is a draft builder: callers may still bind an accepted Auto plan, Change Flight
 * Plan, or other creation-only policy before their transaction commits. An unaccepted revision-one
 * directory may therefore be replaced inside that same locked transaction. This function checks
 * the creation commit before replacing a draft; it is never an amendment mechanism.
 */
export async function finalizeDraftWorkflowSnapshot(root, config, workflow) {
  try {
    const verification = await verifyWorkflowSnapshot(root, config, workflow);
    if (verification.enrolled) return workflow.workflowSnapshot;
  } catch {
    // An incomplete or inconsistent draft is replaceable only before its first accepted commit.
    // The guard below proves that boundary before any file is removed.
  }
  // A direct caller cannot turn this creation-only helper into a skill-version amendment by
  // changing the in-memory policy after acceptance. The exact creation commit is the authority
  // for whether a draft may be replaced, even when verification of the supplied object failed.
  if (!hasRetainedWorkflowSnapshotDraft(root, config, workflow)) {
    fail('Accepted Story workflow snapshots require a reviewed amendment revision; creation finalization is unavailable.',
      'WFA_AMENDMENT_UNSUPPORTED');
  }
  // The final pre-commit projection may change policy while keeping the confirmed skill version.
  // Rebuild it from the already verified draft closure; a later live folder or configuration head
  // cannot supply missing bytes or change the selected package during this transaction.
  const retainedDraftSkillPackages = selectedSkillBindings(workflow.resolution).length
    ? await readRetainedDraftSkillPackages(root, config, workflow)
    : null;
  const relative = storyRelative(config, workflow.workItem.id, 'config/wfa');
  const target = await secureRepositoryPath(root, relative, {
    label: 'Unaccepted workflow snapshot draft'
  });
  if (target.exists && !target.entry.isDirectory()) {
    fail('Unaccepted workflow snapshot draft is not a directory.', 'WFA_PATH_REFUSED');
  }
  if (target.exists) await rm(target.absolute, { recursive: true, force: true });
  delete workflow.workflowSnapshot;
  workflow.workflowSnapshot = await captureWorkflowSnapshot(root, config, workflow, {
    retainedDraftSkillPackages
  });
  return workflow.workflowSnapshot;
}

function exactStoryBlobPath(config, workId, digest) {
  return storyRelative(config, workId, `config/wfa/blobs/sha256/${digest}`);
}

/**
 * Accepted snapshots can be read from a blobless Story worktree. Inspect exact creation-commit
 * OIDs without contacting its promisor remote; only genuinely missing blobs may be hydrated.
 */
function missingLocalSnapshotBlobs(root, objectIds, label) {
  const localEnv = {
    ...process.env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1'
  };
  const checked = run('git', [
    'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'
  ], {
    cwd: root, env: localEnv, allowFailure: true,
    input: Buffer.from(`${objectIds.join('\n')}\n`),
    maxBuffer: Math.max(1024, objectIds.length * 160)
  });
  const rows = String(checked.stdout ?? '').trimEnd().split('\n');
  if (checked.status !== 0 || rows.length !== objectIds.length) {
    fail(`${label} could not inspect the required local Git objects.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  const missing = [];
  for (let index = 0; index < objectIds.length; index += 1) {
    const oid = objectIds[index];
    const row = rows[index].trim();
    if (row === `${oid} missing`) {
      missing.push(oid);
    } else if (!new RegExp(`^${oid} blob [0-9]+$`, 'u').test(row)) {
      fail(`${label} contains a non-blob or malformed Git object.`,
        'WFA_DEPENDENCY_UNAVAILABLE');
    }
  }
  return missing;
}

function configuredPromisorIdentity(root, label) {
  const promisor = run('git', ['config', '--local', '--get-regexp',
    '^remote\\..*\\.promisor$'], { cwd: root, allowFailure: true });
  const promisorNames = promisor.status === 0
    ? String(promisor.stdout ?? '').split(/\r?\n/u)
      .map((line) => /^remote\.([^\s]+)\.promisor\s+true$/iu.exec(line)?.[1] ?? null)
      .filter(Boolean)
    : [];
  if (promisorNames.length !== 1) {
    fail(`${label} requires exactly one partial-clone promisor remote; this checkout has ${promisorNames.length}. Repair its Git remotes before retrying.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  const identity = configuredRemoteIdentity(root, promisorNames[0], {
    direction: 'fetch'
  });
  if (!identity.configured || identity.ambiguous) {
    fail(`${label} has no unambiguous configured promisor fetch authority.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  return identity;
}

function removeFrozenPromisorAlias(root, transport, label) {
  const cleanup = run('git', ['config', '--local', '--remove-section',
    `remote.${transport.remote}`], { cwd: root, allowFailure: true });
  if (cleanup.status !== 0 && cleanup.status !== 5) {
    fail(`${label} could not remove its temporary partial-clone transport configuration.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
}

function hydrateMissingSnapshotBlobs(root, objectIds, label, maximumObjectBytes = MAXIMUM_ASSET_BYTES) {
  const missing = missingLocalSnapshotBlobs(root, objectIds, label);
  if (!missing.length) return false;
  const identity = configuredPromisorIdentity(root, label);
  const transport = frozenRemoteTransport(identity.url);
  // An exact blob want cannot bring an application tree into the worktree. The server-side limit
  // refuses oversized objects before they transfer; the local reader still enforces the limit and
  // verifies every returned Git hash. Filtered fetch may persist this one-shot alias in the local
  // Git config, so always remove exactly that random section before returning.
  for (let offset = 0; offset < missing.length; offset += 128) {
    try {
      try {
        runRemoteGit([
          'fetch', '--no-tags', '--no-write-fetch-head',
          `--filter=blob:limit=${maximumObjectBytes + 1}`, transport.remote,
          ...missing.slice(offset, offset + 128)
        ], {
          cwd: root, operation: 'remote-configuration', allowFailure: false,
          env: transport.env, maxBuffer: 64 * 1024
        });
      } catch (error) {
        if (error?.code === 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE') throw error;
        fail(`${label} could not fetch a missing immutable blob from the configured partial-clone remote. Check Git access and promised-object support, then retry.`,
          'WFA_DEPENDENCY_UNAVAILABLE', { remoteCode: error?.code ?? null });
      }
    } finally {
      removeFrozenPromisorAlias(root, transport, label);
    }
  }
  if (missingLocalSnapshotBlobs(root, missing, label).length) {
    fail(`${label} still has missing immutable Git blobs after the bounded fetch.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  return true;
}

/** A shallow tip is not proof of the Story's original workflow.json addition. */
function ensureCompleteStoryCreationHistory(root, label) {
  const shallow = run('git', ['rev-parse', '--is-shallow-repository'], {
    cwd: root, allowFailure: true
  });
  if (shallow.status !== 0 || !['true', 'false'].includes(shallow.stdout.trim())) {
    fail(`${label} cannot establish whether its Git history is complete.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  if (shallow.stdout.trim() === 'false') return;
  const branch = run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: root, allowFailure: true
  });
  const branchName = branch.status === 0 ? branch.stdout.trim() : '';
  if (!branchName || /[\r\n]/u.test(branchName)) {
    fail(`${label} is in a shallow detached checkout; attach its Story branch before retrying.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  const upstreamRemote = run('git', ['config', '--local', '--get',
    `branch.${branchName}.remote`], { cwd: root, allowFailure: true });
  const upstreamRef = run('git', ['config', '--local', '--get',
    `branch.${branchName}.merge`], { cwd: root, allowFailure: true });
  const identity = configuredPromisorIdentity(root, label);
  const mergeRef = upstreamRef.status === 0 ? upstreamRef.stdout.trim() : '';
  if (upstreamRemote.status !== 0 || upstreamRemote.stdout.trim() !== identity.remote
      || !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._\/-]*$/u.test(mergeRef)
      || mergeRef.includes('..') || mergeRef.endsWith('/') || mergeRef.includes('//')) {
    fail(`${label} is shallow without one verifiable Story upstream branch. Repair its tracking branch before retrying.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
  const head = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root }).stdout.trim();
  const transport = frozenRemoteTransport(identity.url);
  try {
    // Blobless unshallow transfers commits and trees, not application source. The one-shot frozen
    // alias prevents a mutable local URL rewrite from changing the selected authority mid-fetch.
    try {
      runRemoteGit([
        'fetch', '--no-tags', '--unshallow', '--filter=blob:none',
        transport.remote, mergeRef
      ], {
        cwd: root, operation: 'remote-configuration', allowFailure: false,
        env: transport.env, maxBuffer: 64 * 1024
      });
    } catch (error) {
      if (error?.code === 'GIT_ENTERPRISE_CONFIG_UNAVAILABLE') throw error;
      fail(`${label} could not fetch complete blobless ancestry from its configured Story upstream. Check Git access, then retry.`,
        'WFA_DEPENDENCY_UNAVAILABLE', { remoteCode: error?.code ?? null });
    }
  } finally {
    // Git may persist a filtered one-shot alias as a promisor remote. Remove only this invocation's
    // unpredictable alias; never rewrite the user's real origin or checkout state.
    removeFrozenPromisorAlias(root, transport, label);
  }
  const complete = run('git', ['rev-parse', '--is-shallow-repository'], { cwd: root });
  const unchanged = run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: root });
  const related = run('git', ['merge-base', 'HEAD', 'FETCH_HEAD'], {
    cwd: root, allowFailure: true
  });
  if (complete.stdout.trim() !== 'false' || unchanged.stdout.trim() !== head
      || related.status !== 0 || !/^[a-f0-9]{40,64}$/u.test(related.stdout.trim())) {
    fail(`${label} could not prove complete ancestry for the checked-out Story branch.`,
      'WFA_DEPENDENCY_UNAVAILABLE');
  }
}

function gitTreeEntries(root, commit, paths, label, {
  maximumBytes = MAXIMUM_BUNDLE_BYTES,
  maximumObjectBytes = MAXIMUM_ASSET_BYTES
} = {}) {
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
  const objectIds = [...entries.values()].map((entry) => entry.oid);
  const readBlobs = () => readLocalGitBlobs(root, objectIds, {
    maximumBytes,
    maximumObjectBytes,
    code: 'WFA_DEPENDENCY_UNAVAILABLE',
    limitCode: 'WFA_LIMIT_REACHED',
    label
  });
  let blobs;
  try {
    blobs = readBlobs();
  } catch (error) {
    if (error?.code !== 'WFA_DEPENDENCY_UNAVAILABLE') throw error;
    if (!hydrateMissingSnapshotBlobs(root, objectIds, label, maximumObjectBytes)) throw error;
    blobs = readBlobs();
  }
  return new Map([...entries].map(([relative, entry]) => [relative, blobs.get(entry.oid)]));
}

function initialSnapshotAuthority(root, config, workId) {
  const workflowRelative = storyRelative(config, workId, 'workflow.json');
  const repository = run('git', ['rev-parse', '--git-dir'], {
    cwd: root, allowFailure: true
  });
  if (repository.status === 0) {
    ensureCompleteStoryCreationHistory(root, `Story '${workId}' immutable creation record`);
  }
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

function validateBlobReference(config, workId, blob, label) {
  if (!blob || typeof blob !== 'object') fail(`${label} has no blob reference.`);
  const digest = digestHex(blob.sha256, `${label} blob`);
  const expectedPath = exactStoryBlobPath(config, workId, digest);
  if (String(blob.path ?? '') !== expectedPath) {
    fail(`${label} points outside the content-addressed snapshot store.`, 'WFA_PATH_REFUSED');
  }
  return { digest, expectedPath };
}

async function verifyBlob(root, config, workId, blob, label, { acceptedBytes = null } = {}) {
  const { digest, expectedPath } = validateBlobReference(config, workId, blob, label);
  if (acceptedBytes) {
    const bytes = acceptedBytes.get(expectedPath);
    if (!bytes || sha256(bytes) !== digest || bytes.byteLength !== blob.bytes) {
      fail(`${label} blob bytes do not match the immutable Story creation commit.`);
    }
    return { bytes: Buffer.from(bytes), sha256: digest, size: bytes.byteLength };
  }
  const safe = await secureRepositoryPath(root, blob.path, {
    label: `${label} blob`, type: 'file'
  });
  if (!safe.exists) fail(`${label} has no retained blob bytes.`, 'WFA_DEPENDENCY_UNAVAILABLE');
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

function assertSkillPackageClosure(manifest, storedVersion, policy, assetByLogicalId, assetBytes) {
  const selected = selectedSkillBindings(policy);
  const declared = manifest.skillPackages ?? [];
  if (storedVersion === 1) {
    if (selected.length || declared.length
        || [...assetByLogicalId.values()].some((asset) => asset.purpose === 'skill-package-file')) {
      fail('A v1 Story snapshot cannot select a skill producer.', 'WFA_RUNTIME_INCOMPATIBLE');
    }
    return;
  }
  if (storedVersion !== 2 || !selected.length || !Array.isArray(declared)
      || declared.length !== selected.length || declared.length > MAXIMUM_SKILL_PACKAGES
      || manifest.semantics?.snapshot !== 'wfa-snapshot-v2'
      || manifest.semantics?.policyReaderMinimum !== 9
      || manifest.semantics?.skillPackageReader !== SKP_PACKAGE_FORMAT
      || manifest.semantics?.skillTextParser !== SKP_PARSER_PROFILE
      || manifest.semantics?.skillPhaseBinding !== 'skp-contract/v1') {
    fail('Story skill snapshot has an unsupported or incomplete interpretation profile.',
      'WFA_RUNTIME_INCOMPATIBLE');
  }
  const claimedAssets = new Set();
  let skillBytes = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const choice = selected[index];
    const record = declared[index];
    assertExactFields(record, ['skillId', 'manifest', 'phaseBindings', 'files'],
      `Skill package '${choice.skillId}'`);
    if (record.skillId !== choice.skillId
        || record.manifest?.skillId !== choice.skillId
        || record.manifest?.packageSha256 !== choice.packageSha256
        || !Array.isArray(record.phaseBindings)
        || canonicalJson(record.phaseBindings) !== canonicalJson(choice.phaseBindings)
        || !Array.isArray(record.files)
        || !Array.isArray(record.manifest?.files)
        || record.files.length !== record.manifest?.files?.length
        || record.files.length > SKP_CAPTURE_LIMITS.files) {
      fail(`Skill package '${choice.skillId}' does not bind the accepted phase contracts.`,
        'WFA_SNAPSHOT_INVALID');
    }
    const contents = new Map();
    for (let fileIndex = 0; fileIndex < record.files.length; fileIndex += 1) {
      const fileRef = record.files[fileIndex];
      const file = record.manifest.files[fileIndex];
      assertExactFields(fileRef, ['path', 'assetLogicalId'],
        `Skill '${choice.skillId}' file reference`);
      if (!file || typeof file !== 'object' || typeof file.path !== 'string') {
        fail(`Skill '${choice.skillId}' has an invalid file manifest.`, 'WFA_SNAPSHOT_INVALID');
      }
      const expectedId = `skill:${choice.skillId}:file:${String(fileIndex + 1).padStart(3, '0')}`;
      const asset = assetByLogicalId.get(fileRef.assetLogicalId);
      const bytes = assetBytes.get(fileRef.assetLogicalId);
      if (fileRef.path !== file.path || fileRef.assetLogicalId !== expectedId
          || !asset || !bytes || claimedAssets.has(expectedId)
          || asset.purpose !== 'skill-package-file'
          || canonicalJson(asset.dependencies) !== canonicalJson([])
          || asset.blob.sha256 !== file.sha256 || asset.blob.bytes !== file.bytes
          || asset.source?.kind !== 'approved-skill-package'
          || asset.source?.skillId !== choice.skillId
          || asset.source?.packageSha256 !== choice.packageSha256
          || asset.source?.path !== file.path
          || (manifest.provenance?.configuration?.commit
            && asset.source?.configurationCommit !== manifest.provenance.configuration.commit)
          || asset.source?.sha256 !== file.sha256) {
        fail(`Skill '${choice.skillId}' file '${file.path}' has no exact retained bytes.`,
          'WFA_DEPENDENCY_UNAVAILABLE');
      }
      claimedAssets.add(expectedId);
      contents.set(file.path, bytes);
      skillBytes += bytes.byteLength;
    }
    try { verifySkillPackage({ manifest: record.manifest, contents }); }
    catch (error) {
      fail(`Skill '${choice.skillId}' retained package is invalid: ${error.message}`,
        'WFA_DEPENDENCY_UNAVAILABLE');
    }
  }
  if (skillBytes > MAXIMUM_SKILL_BUNDLE_BYTES
      || [...assetByLogicalId.values()].some((asset) => asset.purpose === 'skill-package-file'
        && !claimedAssets.has(asset.logicalId))) {
    fail('Story skill snapshot contains an unclaimed or oversized retained package.',
      'WFA_SNAPSHOT_INVALID');
  }
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
      root, accepted.commit, [reference.manifestPath], 'Workflow snapshot manifest', {
        maximumBytes: MAXIMUM_V2_MANIFEST_BYTES,
        maximumObjectBytes: MAXIMUM_V2_MANIFEST_BYTES
      }
    ).get(reference.manifestPath);
  } else {
    safe = await secureRepositoryPath(root, reference.manifestPath, {
      label: 'Workflow snapshot manifest', mustExist: true, type: 'file'
    });
  }
  let manifest;
  let sourceManifest;
  let storedVersion;
  try {
    const localManifestSize = accepted ? null : (await lstat(safe.absolute)).size;
    if (localManifestSize > MAXIMUM_V2_MANIFEST_BYTES) {
      fail('Workflow snapshot manifest exceeds its versioned size limit.', 'WFA_LIMIT_REACHED');
    }
    const source = accepted
      ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))
      : await readJson(safe.absolute);
    sourceManifest = source;
    const manifestSize = accepted ? manifestBytes.byteLength : localManifestSize;
    const rawVersion = Number(source?.schemaVersion);
    if (manifestSize > MAXIMUM_V2_MANIFEST_BYTES
        || (rawVersion === 1 && manifestSize > MAXIMUM_ASSET_BYTES)) {
      fail('Workflow snapshot manifest exceeds its versioned size limit.', 'WFA_LIMIT_REACHED');
    }
    // JSON Schema enforces these ceilings too, but classifying a hostile/self-rehashed oversized
    // closure as a runtime incompatibility hides the actual recovery. Inspect only the bounded
    // cardinality/accounting fields before schema projection; all semantic validation remains in
    // the registered immutable reader below.
    const v2 = rawVersion === 2;
    const tooManyAssets = Array.isArray(source?.assets)
      && source.assets.length > (v2 ? MAXIMUM_SKILL_ASSETS : MAXIMUM_ASSETS);
    const tooManyDependencies = Array.isArray(source?.executionDependencies)
      && source.executionDependencies.length > MAXIMUM_ASSETS;
    const tooManyDeclaredBytes = Number.isFinite(source?.limits?.bytes)
      && source.limits.bytes > (v2 ? MAXIMUM_SKILL_SNAPSHOT_BYTES : MAXIMUM_BUNDLE_BYTES);
    if (tooManyAssets || tooManyDependencies || tooManyDeclaredBytes) {
      fail('Workflow snapshot exceeds its accepted resource limits.', 'WFA_LIMIT_REACHED');
    }
    const opened = readRecord(SNAPSHOT_FAMILY, source);
    // Keep historical v1 bytes and schema stamp visible to Story consumers. The registered
    // v1→v2 projection proves readability, but it is not the immutable v1 identity being run.
    manifest = opened.storedVersion === 1 ? source : opened.record;
    storedVersion = opened.storedVersion;
  }
  catch (error) {
    if (error instanceof SingularityFlowError && String(error.code ?? '').startsWith('WFA_')) throw error;
    fail('Workflow snapshot manifest cannot be read with this runtime.', 'WFA_RUNTIME_INCOMPATIBLE');
  }
  if (manifest.kind !== SNAPSHOT_FAMILY || manifest.story?.workId !== workflow.workItem.id
      || manifest.revision !== reference.revision
      || manifest.snapshotHash !== reference.snapshotHash
      || domainHash(storedVersion === 2 ? 'wfa.snapshot.v2' : 'wfa.snapshot.v1',
        manifestCore(sourceManifest)) !== manifest.snapshotHash) {
    fail('Workflow snapshot manifest identity does not match its accepted Story reference.');
  }
  if (manifest.revision === 1 && manifest.parentSnapshotHash !== null) {
    fail('Workflow snapshot genesis has an unexpected parent.');
  }
  const closureReferences = [
    { blob: manifest.policy, label: 'Effective workflow policy' },
    ...(manifest.assets ?? []).map((asset) => ({
      blob: asset?.blob,
      label: `Workflow snapshot asset '${asset?.logicalId ?? 'unknown'}'`
    }))
  ];
  // Validate the portable path grammar before giving any caller-controlled path to Git. Otherwise
  // `ls-tree` may normalize a traversal spelling and turn the precise path refusal into a generic
  // missing/invalid-object error.
  for (const entry of closureReferences) {
    validateBlobReference(config, workflow.workItem.id, entry.blob, entry.label);
  }
  const acceptedBlobBytes = accepted
    ? gitTreeEntries(root, accepted.commit,
        closureReferences.map((entry) => entry.blob.path), 'Workflow snapshot closure', {
          maximumBytes: storedVersion === 2
            ? MAXIMUM_SKILL_SNAPSHOT_BYTES : MAXIMUM_BUNDLE_BYTES
        })
    : null;
  const policy = await verifyBlob(
    root, config, workflow.workItem.id, manifest.policy, 'Effective workflow policy',
    { acceptedBytes: acceptedBlobBytes }
  );
  let capturedPolicy;
  try { capturedPolicy = JSON.parse(policy.bytes.toString('utf8')); }
  catch { fail('Captured workflow policy is not valid JSON.'); }
  // Accepted Story policy is durable data, not a compatibility projection of today's runtime.
  // `workflow` has already passed through the current story-record reader, which may add safe
  // schema defaults in memory. Comparing the captured closure to that migrated object made an
  // unchanged historical Story fail whenever the runtime learned a new default. Instead prove:
  //   1. the captured policy is exactly what the immutable creation commit accepted; and
  //   2. the raw policy currently persisted for the Story has not been edited since capture.
  // This ignores mutable live workflow.yml defaults but still rejects both a changed closure and
  // direct edits to immutable resolution fields such as sequence gates or session policy.
  let compatibilityPolicy = clonePolicy(workflow.resolution);
  let creationPolicy = compatibilityPolicy;
  if (accepted) {
    creationPolicy = clonePolicy(accepted.workflow?.resolution);
    let persisted;
    try {
      const currentWorkflow = await secureRepositoryPath(root, accepted.workflowRelative, {
        label: 'Current Story workflow record', mustExist: true, type: 'file'
      });
      persisted = await readJson(currentWorkflow.absolute);
    } catch (error) {
      if (error instanceof SingularityFlowError) throw error;
      fail(`Current Story workflow record cannot be read: ${error.message}`);
    }
    compatibilityPolicy = clonePolicy(persisted?.resolution);
  }
  if (canonicalJson(capturedPolicy) !== canonicalJson(creationPolicy)
      || canonicalJson(capturedPolicy) !== canonicalJson(compatibilityPolicy)
      || manifest.configFoldHash !== domainHash('wfa.fold.v1', capturedPolicy)) {
    fail('Workflow compatibility projection differs from its accepted snapshot policy.');
  }
  if (!Array.isArray(manifest.assets)
      || manifest.assets.length > (storedVersion === 2 ? MAXIMUM_SKILL_ASSETS : MAXIMUM_ASSETS)) {
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
    if (retainBytes || asset.purpose === 'skill-package-file') {
      retainedAssets.set(asset.logicalId, Buffer.from(captured.bytes));
    }
    totalBytes += captured.size;
  }
  assertDependencyClosure(manifest, assetByLogicalId);
  assertSkillPackageClosure(manifest, storedVersion, capturedPolicy, assetByLogicalId, retainedAssets);
  if (totalBytes > (storedVersion === 2 ? MAXIMUM_SKILL_SNAPSHOT_BYTES : MAXIMUM_BUNDLE_BYTES)
      || manifest.limits?.bytes !== totalBytes
      || manifest.limits?.assets !== manifest.assets.length) {
    fail('Workflow snapshot closure does not match its accepted resource accounting.', 'WFA_LIMIT_REACHED');
  }
  const result = {
    status: 'ready', enrolled: true, closure: 'verified', revision: manifest.revision,
    snapshotHash: manifest.snapshotHash, genesisSnapshotHash: reference.genesisSnapshotHash,
    manifestPath: reference.manifestPath, assets: manifest.assets.length,
    bytes: totalBytes, executionDependencies: manifest.executionDependencies ?? [],
    skillPackages: (manifest.skillPackages ?? []).map((entry) => ({
      skillId: entry.skillId, packageSha256: entry.manifest.packageSha256,
      phaseIds: entry.phaseBindings.map((binding) => binding.phaseId)
    })),
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
