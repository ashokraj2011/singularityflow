/**
 * Portable workflow bundles and lossless linked workflow copies.
 *
 * A bundle contains configuration needed to understand and run the selected workflows, not Story
 * state.  It intentionally excludes work items, generated artifacts, ledgers, caches, credentials,
 * provider configuration, and repository bindings.  Imports merge only absent objects, reuse exact
 * matches, and refuse a same-name/different-value collision before the first write.
 */
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import {
  lstat, mkdir, open, readFile, readdir, rename, rm, writeFile
} from 'node:fs/promises';
import YAML from 'yaml';
import {
  configurationReadRoot, configurationReadScope, configurationReadSnapshot,
  withConfigurationReadRoot
} from './configuration-read-scope.mjs';
import { inspectApprovedSkillPackage } from './configuration-branch.mjs';
import { executeGitQuery } from './git-query.mjs';
import { remoteFingerprint } from './git-remote-diagnostics.mjs';
import { normalizeCodeDeliveryPolicy } from './code-delivery-policy.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';
import { normalizeIntegrations } from './step-actions.mjs';
import { SKP_CONTRACT_COMPILER, validateConfiguredSkillPhase } from './skp-contract.mjs';
import {
  inspectSkillPackageContents, SKP_CAPTURE_LIMITS, SKP_PACKAGE_FORMAT, SKP_PARSER_PROFILE,
  verifySkillPackage
} from './skp-package.mjs';
import {
  portableConfigurationPath, portableFilesystemPathIdentity
} from './configuration-assets.mjs';
import {
  AGENT_LOCK_PATH, discoverAgents, parseAgentDependencies, parseAgentTemplateReference, parseAttachedSkills,
  portableVendoredPath, validateAgentCatalog
} from './agents.mjs';
import {
  IMPORTS_LOCK_PATH, IMPORTS_VENDOR_ROOT, parseImportsLedger, renderImportsLedger
} from './imports-ledger.mjs';
import { mcpDescriptorPath } from './mcp-descriptor.mjs';
import { instructionPath, loadInstructionLibrary, parseInstruction, readInstruction } from './instruction-library.mjs';
import {
  LIBRARY_SKILL_TABLE, SKILL_ATTACHMENTS_PATH, effectiveLibrarySkills, librarySkillPath, loadSkillLibrary, parseLibrarySkill, readSkillAttachments, skillAttachmentsText
} from './skill-library.mjs';
import {
  CATALOG_SUBJECTS, RESOLVE_ALL_CHOICES, catalogSubjectKind, nameCandidates, normalizeResolutions, parseSubject,
  pickResolution, renameBundleSubjects, renameRefusal, subjectChoices, subjectNoun, suggestedAction,
  transferCatalog, setTransferCatalog
} from './workflow-transfer-resolution.mjs';
import { validateDefinition, WORKFLOW_PATH } from './config.mjs';
import { PORTFOLIO_PATH, validatePortfolio } from './initiative-config.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { recordSha256 } from './records.mjs';
import { isTemplateReference, parseTemplateReference } from './template-catalog.mjs';
import { secureRepositoryPath, SingularityFlowError } from './util.mjs';
import { renderPreservingFormatting } from './yaml-formatting.mjs';
import { seededWorkflowProtection, assertSeededWorkflowsUnchanged } from './seeded-workflow-protection.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';

export { importPlanText, importResolutionOptions } from './workflow-transfer-resolution.mjs';
export const WORKFLOW_BUNDLE_KIND = 'sflow-workflow-bundle';
const WORKFLOW_BUNDLE_FAMILY = 'workflow-bundle';
export const WORKFLOW_BUNDLE_SCHEMA_VERSION = currentSchemaVersion(WORKFLOW_BUNDLE_FAMILY);

const MAX_ASSETS = 2048;
const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_ASSET_BYTES_TOTAL = 16 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_BYTES_TOTAL = 64 * 1024 * 1024;
const MAX_SKILL_PACKAGES = 32;
const MAX_SKILL_BUNDLE_BYTES = 112 * 1024 * 1024;
const MAX_OBJECTS = 8192;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TRANSFER_PLANS = new WeakMap();
const SKILL_SEMANTICS = Object.freeze({
  skillPackageReader: SKP_PACKAGE_FORMAT, skillTextParser: SKP_PARSER_PROFILE,
  skillPhaseBinding: SKP_CONTRACT_COMPILER
});

const STORE = Object.freeze({
  story: Object.freeze({
    file: WORKFLOW_PATH, workflows: 'workTypes', phases: 'phases', validate: validateDefinition
  }),
  initiative: Object.freeze({
    file: PORTFOLIO_PATH, workflows: 'initiativeProfiles', phases: 'initiativePhases', validate: validatePortfolio
  })
});

function fail(message, code = 'WORKFLOW_BUNDLE_INVALID', details = undefined) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function clone(value) { return value == null ? value : structuredClone(value); }

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
function digest(value) {
  const bytes = typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value);
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function captureTransferDestination(root) {
  const scope = configurationReadScope(root);
  if (!scope?.authority) return null;
  const authority = clone(scope.authority);
  const sourceCommit = authority.kind === 'verified-state-mirror'
    ? authority.manifest?.source?.commit : authority.commit;
  if (!['approved-configuration-ref', 'verified-state-mirror'].includes(authority.kind)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(authority.commit ?? '')
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceCommit ?? '')
      || (authority.kind === 'verified-state-mirror'
        && authority.manifest?.source?.branch !== 'sflow/config')
      || (authority.remote != null
        && (typeof authority.remote !== 'string' || !authority.remote.trim()))) {
    fail('Workflow transfer requires an exact approved destination identity.',
      'WORKFLOW_TRANSFER_DESTINATION_INVALID');
  }
  // Ref aliases and the disposable read mount are transport details, not destination identity.
  const identity = Object.freeze({
    kind: authority.kind, branch: 'sflow/config', commit: authority.commit, sourceCommit,
    remoteFingerprint: authority.remote == null ? null : remoteFingerprint(authority.remote)
  });
  return {
    identity, authority, assetPolicy: clone(scope.assetPolicy),
    configurationSnapshot: scope.configurationSnapshot
  };
}

/**
 * Capture a mutation only from a plan produced by this owner. The proposal owner independently
 * checks the expected remote/source/mirror before invoking it; the scratch must then reproduce
 * the reviewed target bytes under the same approved scope. Serialized plans cannot grant scope.
 */
export function workflowTransferProposal(plan, {
  expectedPlanSha256, requireApprovedDestination = false
} = {}) {
  const retained = TRANSFER_PLANS.get(plan);
  if (!retained) fail('Workflow transfer requires a freshly captured owner plan.',
    'WORKFLOW_TRANSFER_PLAN_INVALID');
  assertConfirmation(expectedPlanSha256, retained.planSha256, 'Workflow transfer');
  const { destination, operation, resolutions = {} } = retained;
  if (requireApprovedDestination && !destination) {
    fail('No exact approved workflow transfer destination is available. Refresh configuration and preview again.',
      'WORKFLOW_TRANSFER_DESTINATION_UNAVAILABLE');
  }
  const input = clone(retained.input);
  const mutate = async (target) => {
    const apply = () => operation === 'import'
      ? applyWorkflowImport(target, input, { expectedPlanSha256: retained.planSha256, resolutions })
      : copyWorkflow(target, { ...input, expectedPlanSha256: retained.planSha256 });
    if (!destination) return apply();
    let actualCommit = null;
    try { actualCommit = executeGitQuery(target, 'repository.head'); }
    catch { /* A non-Git target cannot prove this base. */ }
    if (actualCommit !== destination.identity.sourceCommit) {
      fail('The approved workflow transfer destination changed. Preview again; use --propose from an application or Story checkout.',
        'WORKFLOW_TRANSFER_DESTINATION_CHANGED', {
          expectedCommit: destination.identity.sourceCommit, actualCommit
        });
    }
    return withConfigurationReadRoot(target, target, destination.authority, apply, {
      assetPolicy: destination.assetPolicy, configurationSnapshot: destination.configurationSnapshot
    });
  };
  const expectedAuthority = destination ? {
    kind: destination.identity.kind, commit: destination.identity.commit,
    sourceCommit: destination.identity.sourceCommit,
    remoteFingerprint: destination.identity.remoteFingerprint
  } : null;
  return { expectedAuthority, mutate };
}

function textAssetFormat(bytes) {
  const bomSignatures = [
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from([0xff, 0xfe, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0xfe, 0xff]),
    Buffer.from([0xff, 0xfe]),
    Buffer.from([0xfe, 0xff])
  ];
  if (bomSignatures.some((signature) => bytes.subarray(0, signature.length).equals(signature))) {
    return { valid: false, reason: 'text asset contains a byte-order mark' };
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    return { valid: false, reason: 'text asset is not valid UTF-8' };
  }
  let lf = false;
  let crlf = false;
  let bareCr = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\r') {
      if (text[index + 1] === '\n') {
        crlf = true;
        index += 1;
      } else bareCr = true;
    } else if (text[index] === '\n') lf = true;
  }
  if (bareCr || (lf && crlf)) {
    return { valid: false, reason: 'text asset has mixed or ambiguous line endings' };
  }
  return { valid: true, normalized: text.replaceAll('\r\n', '\n') };
}

function importedAssetReuse(asset, targetBytes) {
  const incomingBytes = assetBytes(asset);
  // A vendored copy is pinned by the hash of its bytes, so only the same bytes can stand in for it.
  if (asset.kind === 'vendored' || !/^text\//i.test(asset.mediaType)) {
    return { reusable: incomingBytes.equals(targetBytes), reason: 'same path has different content' };
  }
  const incoming = textAssetFormat(incomingBytes);
  if (!incoming.valid) return { reusable: false, reason: `incoming ${incoming.reason}` };
  const target = textAssetFormat(targetBytes);
  if (!target.valid) return { reusable: false, reason: `target ${target.reason}` };
  return {
    reusable: incomingBytes.equals(targetBytes) || incoming.normalized === target.normalized,
    reason: 'same path has different content'
  };
}

function assetBytes(asset) {
  return Buffer.from(asset.content, asset.encoding === 'base64' ? 'base64' : 'utf8');
}

function exactFields(value, fields, label) {
  if (!plainObject(value) || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...fields].sort())) {
    fail(`${label} has unknown or missing fields.`, 'SKP_WORKFLOW_PACKAGE_INVALID');
  }
}

function selectedSkillBindings(bundle, storedVersion = WORKFLOW_BUNDLE_SCHEMA_VERSION) {
  const selected = new Map();
  for (const [phaseId, phase] of Object.entries(bundle.objects.story.phases)) {
    if (phase.kind !== 'skill' && phase.skillBinding == null) continue;
    if (storedVersion === 1) {
      fail(`Workflow bundle v1 cannot transfer skill phase 'story:${phaseId}' without its approved package.`,
        'SKP_WORKFLOW_TRANSFER_UNSUPPORTED');
    }
    const binding = validateConfiguredSkillPhase(phase, phaseId);
    const { id, packageSha256 } = binding.bindingRefs.skill;
    const prior = selected.get(id);
    if (prior && prior.packageSha256 !== packageSha256) {
      fail(`Workflow bundle selects conflicting versions of skill '${id}'.`, 'SKP_WORKFLOW_PACKAGE_INVALID');
    }
    const record = prior ?? { skillId: id, packageSha256, phaseBindings: [] };
    record.phaseBindings.push({
      governs: 'story', phaseId, contractSha256: binding.bindingRefs.contractSha256,
      compilationSha256: binding.compilationSha256, bindingSha256: digest(binding)
    });
    selected.set(id, record);
    if (selected.size > MAX_SKILL_PACKAGES) {
      fail('Workflow bundle selects too many skill packages.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
    }
  }
  return [...selected.values()].sort((left, right) => left.skillId.localeCompare(right.skillId))
    .map((record) => ({ ...record, phaseBindings: record.phaseBindings
      .sort((left, right) => left.phaseId.localeCompare(right.phaseId)) }));
}

function validateSkillPackages(bundle, storedVersion) {
  const selected = selectedSkillBindings(bundle, storedVersion);
  if (storedVersion === 1) {
    if (bundle.skillPackages != null || bundle.semantics != null) {
      fail('Workflow bundle v1 cannot carry version-2 skill package metadata.', 'SKP_WORKFLOW_TRANSFER_UNSUPPORTED');
    }
    return;
  }
  if (!Array.isArray(bundle.skillPackages) || bundle.skillPackages.length > MAX_SKILL_PACKAGES
      || canonicalJson(bundle.semantics) !== canonicalJson(SKILL_SEMANTICS)
      || bundle.skillPackages.length !== selected.length) {
    fail('Workflow bundle is missing its exact selected skill inventory or interpretation profile.',
      'SKP_WORKFLOW_PACKAGE_INVALID');
  }
  let total = 0;
  for (const [index, record] of bundle.skillPackages.entries()) {
    exactFields(record, ['skillId', 'manifest', 'source', 'phaseBindings', 'files'], 'Workflow skill package');
    const choice = selected[index];
    if (record.skillId !== choice.skillId || record.manifest?.skillId !== choice.skillId
        || record.manifest?.packageSha256 !== choice.packageSha256
        || canonicalJson(record.phaseBindings) !== canonicalJson(choice.phaseBindings)
        || !Array.isArray(record.files) || record.files.length > SKP_CAPTURE_LIMITS.files) {
      fail(`Workflow bundle skill '${choice.skillId}' differs from its selected compiled bindings.`,
        'SKP_WORKFLOW_PACKAGE_INVALID');
    }
    exactFields(record.source, ['kind', 'branch', 'commit'], `Skill '${choice.skillId}' provenance`);
    if (record.source.kind !== 'approved-configuration' || record.source.branch !== 'sflow/config'
        || !/^[a-f0-9]{40,64}$/.test(record.source.commit ?? '')) {
      fail(`Workflow bundle skill '${choice.skillId}' has invalid source provenance.`,
        'SKP_WORKFLOW_PACKAGE_INVALID');
    }
    const contents = new Map();
    for (const file of record.files) {
      exactFields(file, ['path', 'encoding', 'content'], `Skill '${choice.skillId}' file`);
      if (file.encoding !== 'base64' || typeof file.content !== 'string'
          || file.content.length > Math.ceil(SKP_CAPTURE_LIMITS.referenceBytes / 3) * 4
          || contents.has(file.path)) {
        fail(`Workflow bundle skill '${choice.skillId}' has invalid or duplicate file bytes.`,
          'SKP_WORKFLOW_PACKAGE_INVALID');
      }
      const bytes = Buffer.from(file.content, 'base64');
      if (bytes.toString('base64') !== file.content) {
        fail(`Workflow bundle skill '${choice.skillId}' has non-canonical byte encoding.`,
          'SKP_WORKFLOW_PACKAGE_INVALID');
      }
      contents.set(file.path, bytes);
    }
    const capture = inspectSkillPackageContents(choice.skillId, contents, {
      expectedPackageSha256: choice.packageSha256
    });
    if (canonicalJson(capture.manifest) !== canonicalJson(record.manifest)
        || canonicalJson(record.files.map((file) => file.path))
          !== canonicalJson(record.manifest.files.map((file) => file.path))) {
      fail(`Workflow bundle skill '${choice.skillId}' differs from its complete package manifest.`,
        'SKP_WORKFLOW_PACKAGE_INVALID');
    }
    total += verifySkillPackage(capture).bytes;
  }
  if (total > MAX_SKILL_BYTES_TOTAL) {
    fail('Workflow bundle skill bytes exceed the aggregate retention limit.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  }
}

function skillFileAssets(bundle) {
  return (bundle.skillPackages ?? []).flatMap((record) => record.files.map((file) => {
    const metadata = record.manifest.files.find((entry) => entry.path === file.path);
    return {
      kind: 'skill-package-file', skillId: record.skillId,
      path: `singularity/skills/${record.skillId}/${file.path}`,
      mediaType: 'application/octet-stream', size: metadata.bytes, sha256: metadata.sha256,
      encoding: 'base64', content: file.content
    };
  }));
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireId(value, label) {
  const candidate = String(value ?? '').trim();
  if (!ID.test(candidate)) fail(`${label} must be lower-case kebab-case.`, 'WORKFLOW_ID_INVALID');
  return candidate;
}

function parseWorkflowSelector(value, label = 'Workflow identifier') {
  const candidate = String(value ?? '').trim();
  const qualified = candidate.match(/^(story|initiative):([a-z0-9]+(?:-[a-z0-9]+)*)$/);
  return {
    governs: qualified?.[1] ?? null,
    id: requireId(qualified?.[2] ?? candidate, label),
    selector: qualified ? `${qualified[1]}:${qualified[2]}` : candidate
  };
}

async function regularFile(file, label, { optional = false } = {}) {
  const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) {
    if (optional) return null;
    fail(`${label} does not exist: ${file}`, 'WORKFLOW_DEPENDENCY_MISSING');
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    fail(`${label} must be a regular file and cannot be a symbolic link: ${file}`,
      'WORKFLOW_DEPENDENCY_NOT_REGULAR');
  }
  return info;
}

async function readYamlDocument(root, store, { optional = false } = {}) {
  const secured = await secureRepositoryPath(root, store.file, {
    label: store.file, mustExist: !optional, type: 'file'
  });
  if (!secured.exists) return null;
  const file = secured.absolute;
  const text = await readFile(file, 'utf8');
  let document;
  try { document = YAML.parseDocument(text); }
  catch (error) { fail(`Cannot parse ${store.file}: ${error.message}`, 'WORKFLOW_CONFIGURATION_INVALID'); }
  if (document.errors?.length) {
    fail(`Cannot parse ${store.file}: ${document.errors[0].message}`, 'WORKFLOW_CONFIGURATION_INVALID');
  }
  return { file, text, document, value: document.toJS() ?? {} };
}

function safeAssetPath(value, label = 'Bundle asset path') {
  const relative = portableConfigurationPath(value);
  if (!relative || relative !== value) fail(`${label} is not a portable repository-relative path: ${value}`,
    'WORKFLOW_BUNDLE_PATH_INVALID');
  return relative;
}

async function assertSafeTarget(root, relative) {
  const safe = safeAssetPath(relative);
  const parts = safe.split('/');
  let cursor = root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const info = await lstat(cursor).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (info?.isSymbolicLink()) fail(`Workflow import target cannot traverse a symbolic link: ${safe}`,
      'WORKFLOW_IMPORT_TARGET_SYMBOLIC_LINK');
  }
  return path.join(root, ...parts);
}

async function portableTargetState(root, relative) {
  const safe = safeAssetPath(relative);
  const parts = safe.split('/');
  let cursor = root;
  const actual = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const parent = await lstat(cursor)
      .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (!parent) return { exists: false, file: path.join(root, ...parts), caseConflict: null };
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      return { exists: true, file: cursor, caseConflict: actual.join('/'), blocked: true };
    }
    const identity = portableFilesystemPathIdentity(part);
    const matches = (await readdir(cursor, { withFileTypes: true }))
      .filter((candidate) => portableFilesystemPathIdentity(candidate.name) === identity);
    if (matches.length > 1) {
      return {
        exists: true, file: cursor,
        caseConflict: [...actual, part].join('/'), blocked: true, ambiguous: true
      };
    }
    if (!matches.length) {
      return { exists: false, file: path.join(cursor, ...parts.slice(index)), caseConflict: null };
    }
    const matched = matches[0];
    actual.push(matched.name);
    cursor = path.join(cursor, matched.name);
    if (matched.name !== part) {
      return { exists: true, file: cursor, caseConflict: actual.join('/'), blocked: true };
    }
  }
  return { exists: true, file: cursor, caseConflict: null };
}

function walk(value, visitor, trail = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walk(entry, visitor, [...trail, index]));
    return;
  }
  if (!plainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitor(key, entry, value, [...trail, key]);
    walk(entry, visitor, [...trail, key]);
  }
}

function strings(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function ownCatalogEntry(catalog, id) {
  return plainObject(catalog) && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
}

function collectNamedDependencies(value, result, { governs = 'story' } = {}) {
  walk(value, (key, entry, parent) => {
    if (key === 'artifactSet' && typeof entry === 'string') result.artifactSets.add(entry);
    if (key === 'authorities' || key === 'requiredAuthorities') {
      for (const id of strings(entry)) result.authorities[governs].add(id);
    }
    // Some initiative gate declarations use one `authority` field instead of an approval
    // `authorities` list, and a specification-quality exception names the group that may grant it.
    // Treat both as candidates: values such as `advisory` are vocabulary, not authority IDs, and are
    // ignored later unless they resolve in an authority catalog.
    if ((key === 'authority' || key === 'exceptionAuthority') && typeof entry === 'string') {
      result.authorityCandidates[governs].add(entry);
    }
    if (key === 'requiredServers') for (const id of strings(entry)) result.mcpServers.add(id);
    if (key === 'server' && typeof entry === 'string' && parent.tool) result.mcpServers.add(entry);
    if (key === 'agents') for (const id of strings(entry)) result.agents.add(id);
    if (key === 'worldModelViews') for (const id of strings(entry)) result.worldModelViews.add(id);
    if (key === 'views' && Array.isArray(entry)
        && parent !== value && entry.every((item) => typeof item === 'string')) {
      for (const id of entry) result.worldModelViews.add(id);
    }
    if (key === 'applicability' && plainObject(entry) && typeof entry.policy === 'string') {
      result.applicabilityPolicies.add(entry.policy);
    }
    // A decision a person answers names the approval groups whose members choose. A candidate like
    // `authority`: an older bundle without the group still reads, and a target without it refuses.
    if (key === 'by' && Array.isArray(parent?.routes)) {
      for (const id of typeof entry === 'string' ? [entry] : strings(entry)) result.authorityCandidates[governs].add(id);
    }
    // Source review names the governed agent that reviews; the closure decides whether it travels.
    if (key === 'reviewerAgent' && typeof entry === 'string') result.reviewerAgents.add(entry);
    if (key === 'target' && typeof entry === 'string' && Array.isArray(parent.on) && parent.send) result.integrationTargets.add(entry);
  });
}

function phaseReferences(phase) {
  const result = new Set();
  for (const input of phase?.inputs ?? []) {
    if (typeof input === 'string') result.add(input);
    else if (typeof input?.phase === 'string') result.add(input.phase);
  }
  if (typeof phase?.testEvidenceFrom === 'string') result.add(phase.testEvidenceFrom);
  for (const output of (Array.isArray(phase?.outputs) ? phase.outputs : Object.values(phase?.outputs ?? {}))) {
    for (const consumed of output?.consumes ?? []) {
      if (typeof consumed === 'string' && consumed.includes('/')) result.add(consumed.split('/')[0]);
    }
  }
  return result;
}

function templateReferences(governs, workflow, phases) {
  const references = new Map();
  const add = (reference, phaseId) => {
    if (typeof reference !== 'string') return;
    const key = `${phaseId ?? ''}\0${reference}`;
    if (!references.has(key)) references.set(key, { governs, reference, phaseId: phaseId ?? null });
  };
  for (const [phaseId, value] of Object.entries(workflow?.templateOverrides ?? {})) {
    add(value, phaseId);
  }
  for (const [phaseId, phase] of Object.entries(phases)) {
    add(phase?.defaultTemplate, phaseId);
    for (const output of (Array.isArray(phase?.outputs) ? phase.outputs : Object.values(phase?.outputs ?? {}))) {
      add(output?.template, phaseId);
    }
  }
  for (const [phaseId, override] of Object.entries(workflow?.phaseOverrides ?? {})) {
    add(override?.defaultTemplate, phaseId);
    for (const output of (Array.isArray(override?.outputs) ? override.outputs : Object.values(override?.outputs ?? {}))) {
      add(output?.template, phaseId);
    }
  }
  return [...references.values()].sort((a, b) =>
    `${a.phaseId ?? ''}:${a.reference}`.localeCompare(`${b.phaseId ?? ''}:${b.reference}`));
}

// Export and the closed bundle reader traverse the same graph. MCP declarations can lead back
// to phases, default agents and agent-backed templates, so a single pass cannot close it. Keep
// complete server scopes rather than silently narrowing a shared server to the chosen workflow.
function workflowDependencyClosure(configs, workflows, agents, missingCode, { legacy = false } = {}) {
  const dependencies = {
    artifactSets: new Set(), authorities: { story: new Set(), initiative: new Set() },
    mcpServers: new Set(), agents: new Set(), reviewerAgents: new Set(),
    authorityCandidates: { story: new Set(), initiative: new Set() },
    applicabilityPolicies: new Set(), templateCatalog: new Set(), worldModelViews: new Set(), integrationTargets: new Set()
  };
  const selectedPhases = { story: new Set(), initiative: new Set() };
  const processedPhases = { story: new Set(), initiative: new Set() };
  const processedArtifactSets = new Set();
  const processedAgents = new Set();
  const processedServers = new Set();
  const defaultAgents = new Map();
  for (const agent of agents.values()) {
    for (const phaseId of agent.defaultFor) {
      const ids = defaultAgents.get(phaseId) ?? [];
      ids.push(agent.id); defaultAgents.set(phaseId, ids);
    }
  }
  const serversByPhase = new Map();
  const serversByAgent = new Map();
  for (const [id, server] of Object.entries(configs.story?.mcpServers ?? {})) {
    for (const [index, keys] of [[serversByPhase, server.phases], [serversByAgent, server.agents]]) {
      for (const key of keys ?? []) {
        const ids = index.get(key) ?? [];
        ids.push(id); index.set(key, ids);
      }
    }
  }
  for (const { governs, id } of workflows) {
    const definition = ownCatalogEntry(configs[governs]?.[STORE[governs].workflows], id);
    if (!definition) fail(`Workflow dependency '${governs}:${id}' is not defined.`, missingCode);
    collectNamedDependencies(definition, dependencies, { governs });
    for (const phaseId of definition.phases ?? []) selectedPhases[governs].add(phaseId);
  }
  const size = () => selectedPhases.story.size + selectedPhases.initiative.size
    + dependencies.artifactSets.size + dependencies.agents.size + dependencies.mcpServers.size;
  let references = [];
  let previousSize = -1;
  while (previousSize !== size()) {
    previousSize = size();
    if (previousSize > MAX_OBJECTS) fail('Workflow dependency closure exceeds the object limit.',
      'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
    for (const governs of ['story', 'initiative']) {
      for (const phaseId of selectedPhases[governs]) {
        if (processedPhases[governs].has(phaseId)) continue;
        processedPhases[governs].add(phaseId);
        const phase = ownCatalogEntry(configs[governs]?.[STORE[governs].phases], phaseId);
        if (!phase) fail(`Workflow dependency phase '${governs}:${phaseId}' is not defined.`, missingCode);
        if (governs !== 'story' && (phase.kind === 'skill' || phase.skillBinding != null)) {
          fail(`Workflow bundle cannot transfer unsupported Initiative skill phase '${phaseId}'.`,
            'SKP_WORKFLOW_TRANSFER_UNSUPPORTED');
        }
        collectNamedDependencies(phase, dependencies, { governs });
        for (const id of phaseReferences(phase)) selectedPhases[governs].add(id);
        if (governs === 'story' || legacy) {
          for (const id of defaultAgents.get(phaseId) ?? []) dependencies.agents.add(id);
        }
        if (governs === 'story') {
          for (const id of serversByPhase.get(phaseId) ?? []) dependencies.mcpServers.add(id);
        }
      }
    }
    for (const id of dependencies.artifactSets) {
      if (processedArtifactSets.has(id)) continue;
      processedArtifactSets.add(id);
      const value = ownCatalogEntry(configs.story?.artifactSets, id);
      if (!value) fail(`Referenced artifact set '${id}' is not defined.`, missingCode);
      collectNamedDependencies(value, dependencies, { governs: 'story' });
    }

    const referenced = new Map();
    const addReferences = (values) => {
      for (const value of values) referenced.set(
        `${value.governs}:${value.phaseId ?? ''}:${value.reference}`, value);
    };
    for (const governs of ['story', 'initiative']) {
      const phases = Object.fromEntries([...selectedPhases[governs]].map((id) =>
        [id, configs[governs][STORE[governs].phases][id]]));
      // Auxiliary Story phases reached through MCP also own templates when only an Initiative
      // workflow was selected. They are dependencies, not an implicitly selected Story workflow.
      addReferences(templateReferences(governs, {}, phases));
      for (const workflow of workflows.filter((entry) => entry.governs === governs)) {
        addReferences(templateReferences(governs,
          configs[governs][STORE[governs].workflows][workflow.id], {}));
      }
    }
    for (const id of dependencies.artifactSets) {
      const owners = [...selectedPhases.story].filter((phaseId) =>
        configs.story.phases[phaseId]?.artifactSet === id);
      for (const output of configs.story.artifactSets[id].outputs ?? []) {
        if (typeof output?.template !== 'string') continue;
        for (const phaseId of owners.length ? owners : [null]) addReferences([
          { governs: 'story', reference: output.template, phaseId }
        ]);
      }
    }
    references = [...referenced.values()].sort((a, b) =>
      `${a.governs}:${a.phaseId ?? ''}:${a.reference}`
        .localeCompare(`${b.governs}:${b.phaseId ?? ''}:${b.reference}`));
    for (const { governs, reference } of references) {
      if (reference.startsWith('agent:')) {
        dependencies.agents.add(parseAgentTemplateReference(reference).agentId);
      } else if (isTemplateReference(reference)) {
        if (governs !== 'story') fail(`Initiative workflow template '${reference}' cannot use the Story template catalog.`, missingCode);
        const id = parseTemplateReference(reference);
        if (ownCatalogEntry(configs.story?.templates, id) == null) fail(`Referenced template catalog entry '${id}' is not defined.`, missingCode);
        dependencies.templateCatalog.add(id);
      }
    }
    // A repository's own reviewer travels with the workflow. A packaged reviewer is installed with
    // Singularity Flow everywhere, and a bundle reader sees only the agents the bundle carries.
    for (const id of dependencies.reviewerAgents) {
      const agent = agents.get(id);
      if (agent && !['plugin', 'bundled'].includes(agent.scope)) dependencies.agents.add(id);
    }
    for (const id of dependencies.agents) {
      if (processedAgents.has(id)) continue;
      processedAgents.add(id);
      const agent = agents.get(id);
      if (!agent) fail(`Referenced governed agent '${id}' is not installed.`, missingCode);
      for (const view of agent.worldModelViews) dependencies.worldModelViews.add(view);
      if (!legacy) {
        for (const serverId of serversByAgent.get(id) ?? []) dependencies.mcpServers.add(serverId);
      }
    }
    for (const id of dependencies.mcpServers) {
      if (processedServers.has(id)) continue;
      processedServers.add(id);
      const server = ownCatalogEntry(configs.story?.mcpServers, id);
      if (!server) fail(`Referenced MCP server '${id}' is not defined.`, missingCode);
      if (!legacy) for (const phaseId of server.phases ?? []) selectedPhases.story.add(phaseId);
      for (const agentId of server.agents ?? []) dependencies.agents.add(agentId);
    }
  }
  return { dependencies, selectedPhases, references };
}

function configuredTemplateRoot(config, governs, storyConfig) {
  const value = governs === 'initiative'
    ? config.templatesRoot ?? storyConfig?.templatesRoot ?? 'singularity/templates'
    : config.templatesRoot ?? 'singularity/templates';
  return safeAssetPath(value, `${governs} templatesRoot`);
}

function templateAssetPath(rootPath, reference) {
  if (reference.startsWith('agent:')) return null;
  const safe = safeAssetPath(reference, 'Template reference');
  return safe === rootPath || safe.startsWith(`${rootPath}/`) ? safe : `${rootPath}/${safe}`;
}

function emptyObjects() {
  return {
    story: {
      workTypes: {}, phases: {}, templates: {}, artifactSets: {}, approvalAuthorities: {}, mcpServers: {}, integrations: { targets: {} }
    },
    initiative: { initiativeProfiles: {}, initiativePhases: {}, approvalAuthorities: {}, applicabilityPolicies: {} }
  };
}

function addMapEntry(target, key, value, kind) {
  if (!Object.hasOwn(target, key)) { target[key] = clone(value); return; }
  if (canonicalJson(target[key]) !== canonicalJson(value)) {
    fail(`Dependency '${kind}:${key}' resolved to two different definitions.`, 'WORKFLOW_BUNDLE_DEPENDENCY_CONFLICT');
  }
}

function bundleWithoutDigest(bundle) {
  const copy = clone(bundle);
  delete copy.bundleSha256;
  return copy;
}

function summarizeBundle(bundle) {
  return {
    workflows: bundle.workflows.length,
    phases: Object.keys(bundle.objects.story.phases).length
      + Object.keys(bundle.objects.initiative.initiativePhases).length,
    artifactSets: Object.keys(bundle.objects.story.artifactSets).length,
    approvalAuthorities: Object.keys(bundle.objects.story.approvalAuthorities).length
      + Object.keys(bundle.objects.initiative.approvalAuthorities).length,
    mcpServers: Object.keys(bundle.objects.story.mcpServers).length,
    agents: bundle.assets.filter((asset) => asset.kind === 'agent').length,
    agentLocks: Object.keys(bundle.agentLocks ?? {}).length,
    templates: bundle.assets.filter((asset) => asset.kind === 'template').length,
    vendoredCopies: bundle.assets.filter((asset) => asset.kind === 'vendored').length,
    skills: bundle.assets.filter((asset) => asset.kind === 'skill').length,
    instructions: bundle.assets.filter((asset) => asset.kind === 'instruction').length,
    importRecords: Object.keys(bundle.imports ?? {}).length,
    assets: bundle.assets.length,
    skillPackages: bundle.skillPackages?.length ?? 0,
    skillFiles: (bundle.skillPackages ?? []).reduce((total, record) => total + record.files.length, 0)
  };
}

function dependencyInventory(bundle) {
  const objectIds = (governs, section) => Object.keys(bundle.objects[governs][section] ?? {}).sort();
  return {
    workflows: bundle.workflows.map(({ governs, id }) => `${governs}:${id}`).sort(),
    phases: [
      ...objectIds('story', 'phases').map((id) => `story:${id}`),
      ...objectIds('initiative', 'initiativePhases').map((id) => `initiative:${id}`)
    ].sort(),
    artifactSets: objectIds('story', 'artifactSets'),
    templateCatalog: objectIds('story', 'templates'),
    templateAssets: bundle.assets.filter((asset) => asset.kind === 'template')
      .map((asset) => `${asset.governs}:${asset.reference}`).sort(),
    agents: bundle.assets.filter((asset) => asset.kind === 'agent').map((asset) => asset.id).sort(),
    agentLocks: Object.keys(bundle.agentLocks ?? {}).sort(),
    vendoredCopies: bundle.assets.filter((asset) => asset.kind === 'vendored').map((asset) => asset.path).sort(),
    skills: bundle.assets.filter((asset) => asset.kind === 'skill').map((asset) => asset.id).sort(),
    instructions: bundle.assets.filter((asset) => asset.kind === 'instruction').map((asset) => asset.id).sort(),
    importRecords: Object.keys(bundle.imports ?? {}).sort(),
    approvalAuthorities: [
      ...objectIds('story', 'approvalAuthorities').map((id) => `story:${id}`),
      ...objectIds('initiative', 'approvalAuthorities').map((id) => `initiative:${id}`)
    ].sort(),
    mcpServers: objectIds('story', 'mcpServers'),
    integrationTargets: Object.keys(bundle.objects.story.integrations?.targets ?? {}).sort(),
    applicabilityPolicies: objectIds('initiative', 'applicabilityPolicies'),
    worldModelViews: [...(bundle.requirements?.worldModelViews ?? [])].sort(),
    skillPackages: (bundle.skillPackages ?? []).map((record) => ({
      skillId: record.skillId, packageSha256: record.manifest.packageSha256,
      phases: record.phaseBindings.map((binding) => `${binding.governs}:${binding.phaseId}`)
    }))
  };
}

/**
 * `importedHere` is set only for a bundle this module rewrote with new names for an import: a step
 * the repository already has takes its default agent from the repository, and an agent renamed for
 * the import may draft no step by default. The merged configuration is checked for both afterwards.
 */
function validateBundleClosure(bundle, agents, storedVersion, importedHere = null) {
  const { dependencies, selectedPhases, references } = workflowDependencyClosure(
    bundle.objects, bundle.workflows, agents, 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING',
    { legacy: storedVersion < 3 });
  for (const id of dependencies.integrationTargets) {
    if (!Object.hasOwn(bundle.objects.story.integrations?.targets ?? {}, id)) fail(
      `Workflow bundle is missing integration target '${id}'. Export it again from the source repository.`,
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  }
  for (const id of Object.keys(bundle.objects.story.integrations?.targets ?? {})) {
    if (!dependencies.integrationTargets.has(id)) fail(`Workflow bundle contains unreferenced integration target '${id}'.`, 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
  }
  for (const workflow of bundle.workflows) {
    const store = STORE[workflow.governs];
    const definition = bundle.objects[workflow.governs][store.workflows][workflow.id];
    for (const [phaseId, override] of Object.entries(definition.phaseOverrides ?? {})) {
      if (override?.kind === 'skill' || override?.skillBinding != null) {
        fail(`Workflow bundle cannot override compiled skill phase '${workflow.governs}:${phaseId}'.`,
          'SKP_PHASE_BINDING_INVALID');
      }
    }
  }
  for (const governs of ['story', 'initiative']) {
    const store = STORE[governs];
    for (const phaseId of Object.keys(bundle.objects[governs][store.phases])) {
      if (!selectedPhases[governs].has(phaseId)) {
        fail(`Workflow bundle contains unreferenced phase '${governs}:${phaseId}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
      }
    }
  }
  for (const id of Object.keys(bundle.objects.story.artifactSets)) {
    if (!dependencies.artifactSets.has(id)) {
      fail(`Workflow bundle contains unreferenced artifact set '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
  for (const governs of ['story', 'initiative']) {
    for (const id of dependencies.authorities[governs]) {
      if (!Object.hasOwn(bundle.objects[governs].approvalAuthorities, id)) {
        fail(`Workflow bundle is missing approval authority '${governs}:${id}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
    }
    for (const id of dependencies.authorityCandidates[governs]) {
      if (Object.hasOwn(bundle.objects[governs].approvalAuthorities, id)) {
        dependencies.authorities[governs].add(id);
      }
    }
    for (const id of Object.keys(bundle.objects[governs].approvalAuthorities)) {
      if (!dependencies.authorities[governs].has(id)) {
        fail(`Workflow bundle contains unreferenced approval authority '${governs}:${id}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
      }
    }
  }
  for (const id of Object.keys(bundle.objects.story.mcpServers)) {
    if (!dependencies.mcpServers.has(id)) {
      fail(`Workflow bundle contains unreferenced MCP server '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
  for (const id of dependencies.applicabilityPolicies) {
    if (!Object.hasOwn(bundle.objects.initiative.applicabilityPolicies, id)) {
      fail(`Workflow bundle is missing applicability policy '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
  }
  for (const id of Object.keys(bundle.objects.initiative.applicabilityPolicies)) {
    if (!dependencies.applicabilityPolicies.has(id)) {
      fail(`Workflow bundle contains unreferenced applicability policy '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }

  const templateRoots = bundle.requirements?.templateRoots;
  if (!plainObject(templateRoots)
      || Object.keys(templateRoots).some((governs) => !['story', 'initiative'].includes(governs))) {
    fail('Workflow bundle is missing its governed template-root inventory.',
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  }
  for (const [governs, root] of Object.entries(templateRoots)) {
    safeAssetPath(root, `${governs} template root`);
  }

  const templateAssets = new Map();
  for (const asset of bundle.assets.filter((candidate) => candidate.kind === 'template')) {
    const key = `${asset.governs}:${asset.reference}`;
    const existing = templateAssets.get(key) ?? [];
    existing.push(asset);
    templateAssets.set(key, existing);
    const root = templateRoots[asset.governs];
    if (typeof root !== 'string') {
      fail(`Workflow bundle template '${key}' has no governed template root.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
    let declaredPath = asset.reference;
    if (isTemplateReference(asset.reference)) {
      if (asset.governs !== 'story') {
        fail(`Initiative workflow template '${asset.reference}' cannot use the Story template catalog.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
      const id = parseTemplateReference(asset.reference);
      const declaration = bundle.objects.story.templates[id];
      if (declaration == null) {
        fail(`Workflow bundle is missing template catalog entry '${id}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
      declaredPath = typeof declaration === 'string' ? declaration : declaration?.path;
      if (typeof declaredPath !== 'string' || !declaredPath) {
        fail(`Workflow bundle template catalog entry '${id}' does not define a path.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
    }
    const expectedPath = templateAssetPath(root, declaredPath);
    const expectedRootRelative = expectedPath === root ? '' : expectedPath.slice(root.length + 1);
    if (!expectedRootRelative || asset.rootRelative !== expectedRootRelative
        || asset.path !== `${root}/${expectedRootRelative}`) {
      fail(`Workflow bundle template '${key}' does not match its governed reference, root-relative path, and source path.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
    }
  }

  const referencedTemplateAssets = new Set();
  const checkTemplate = (governs, reference, phaseId) => {
    if (reference.startsWith('agent:')) {
      const { agentId, templateId } = parseAgentTemplateReference(reference);
      dependencies.agents.add(agentId);
      const agent = agents.get(agentId);
      if (!agent) {
        fail(`Workflow bundle is missing governed agent '${agentId}' for template '${reference}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
      const dependency = agent.dependencies.find((candidate) => candidate.id === templateId);
      if (!dependency) {
        fail(`Governed agent '${agentId}' does not declare remote template '${templateId}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
      if (dependency.type !== 'template') {
        fail(`Governed agent '${agentId}' dependency '${templateId}' is '${dependency.type}', not a template.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
      if (!phaseId) {
        fail(`Agent template '${reference}' is not bound to a workflow phase.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
      if (dependency.phases.length && !dependency.phases.includes(phaseId)) {
        fail(`Agent template '${agentId}/${templateId}' is not scoped to phase '${phaseId}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISMATCH');
      }
      const locked = bundle.agentLocks?.[agentId]?.dependencies?.find((candidate) =>
        candidate?.id === templateId && candidate?.type === 'template');
      if (!locked) {
        fail(`Agent template '${agentId}/${templateId}' has no matching dependency lock.`,
          'WORKFLOW_AGENT_LOCK_MISSING');
      }
      return;
    }
    if (isTemplateReference(reference)) {
      const id = parseTemplateReference(reference);
      dependencies.templateCatalog.add(id);
      if (!Object.hasOwn(bundle.objects.story.templates, id)) {
        fail(`Workflow bundle is missing template catalog entry '${id}'.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
    }
    const key = `${governs}:${reference}`;
    const matching = templateAssets.get(key) ?? [];
    if (matching.length !== 1) {
      fail(`Workflow bundle is missing template asset '${governs}:${reference}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
    referencedTemplateAssets.add(key);
  };
  for (const { governs, reference, phaseId } of references) {
    checkTemplate(governs, reference, phaseId);
  }
  for (const key of templateAssets.keys()) {
    if (!referencedTemplateAssets.has(key)) {
      fail(`Workflow bundle contains unreferenced template asset '${key}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
  for (const id of Object.keys(bundle.objects.story.templates)) {
    if (!dependencies.templateCatalog.has(id)) {
      fail(`Workflow bundle contains unreferenced template catalog entry '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
  for (const phaseId of selectedPhases.story) {
    const defaults = [...agents.values()].filter((agent) => agent.defaultFor.includes(phaseId));
    if (!defaults.length && importedHere?.phases.has(phaseId)) continue;
    if (defaults.length !== 1) {
      fail(`Workflow bundle phase '${phaseId}' requires exactly one default governed agent; found ${defaults.length}.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
    dependencies.agents.add(defaults[0].id);
  }
  for (const id of dependencies.agents) {
    if (!agents.has(id)) fail(`Workflow bundle is missing governed agent '${id}'.`,
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  }
  for (const id of agents.keys()) {
    if (!dependencies.agents.has(id) && !importedHere?.agents.has(id)) {
      fail(`Workflow bundle contains unreferenced governed agent '${id}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
  for (const agent of agents.values()) {
    for (const view of agent.worldModelViews) dependencies.worldModelViews.add(view);
  }
  const declaredViews = new Set(bundle.requirements?.worldModelViews ?? []);
  for (const view of dependencies.worldModelViews) {
    if (!declaredViews.has(view)) fail(`Workflow bundle is missing World Model requirement '${view}'.`,
      'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  }
  for (const view of declaredViews) {
    if (!dependencies.worldModelViews.has(view)) {
      fail(`Workflow bundle contains unreferenced World Model requirement '${view}'.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
}

/**
 * Every vendored copy belongs to exactly one carried owner and matches it: an agent's copy is the
 * file its lock names, with the locked hash, and an MCP server's copy is its descriptor. Every lock
 * entry that names a copy has it, and every import record describes a file the bundle carries.
 */
function validateVendoredCopies(bundle, storedVersion) {
  const copies = new Map(bundle.assets.filter((asset) => asset.kind === 'vendored').map((asset) => [asset.path, asset]));
  const claimed = new Set();
  for (const [agentId, lock] of Object.entries(bundle.agentLocks)) {
    for (const dependency of lock.dependencies ?? []) {
      if (dependency?.vendored == null) continue;
      if (storedVersion < 4) fail(`Workflow bundle v${storedVersion} cannot name a vendored copy for ${agentId}/${dependency.id}.`,
        'WORKFLOW_AGENT_LOCK_INVALID');
      const relative = portableVendoredPath(dependency.vendored);
      const copy = copies.get(relative);
      if (!copy || copy.owner.kind !== 'agent' || copy.owner.id !== agentId || copy.sha256 !== `sha256:${dependency.sha256}`) {
        fail(`Workflow bundle is missing the exact vendored copy ${relative} of ${agentId}/${dependency.id}.`,
          'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
      }
      claimed.add(relative);
    }
  }
  for (const copy of copies.values()) {
    if (copy.owner.kind === 'mcp-server') {
      if (!Object.hasOwn(bundle.objects.story.mcpServers, copy.owner.id) || copy.path !== mcpDescriptorPath(copy.owner.id)) {
        fail(`Workflow bundle carries descriptor ${copy.path} without its MCP server.`, 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
      }
      claimed.add(copy.path);
    }
    if (!claimed.has(copy.path)) fail(`Workflow bundle carries vendored copy ${copy.path} that no lock names.`,
      'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
  }
  if (storedVersion < 4) return;
  if (!plainObject(bundle.imports)) fail('Workflow bundle import records must be an object.');
  for (const [key, record] of Object.entries(bundle.imports)) {
    if (!plainObject(record) || typeof record.kind !== 'string' || !plainObject(record.source)
        || !describesCarried(record, bundle.assets)) {
      fail(`Workflow bundle import record '${key}' does not describe a file the bundle carries.`,
        'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
    }
  }
}

/**
 * Every skill a carried agent or workflow attaches travels with it, and no other skill does. A bundle older
 * than v5 carries no skills, so its agents' attachments must already be in the target.
 */
function validateCarriedSkills(bundle, agents, storedVersion) {
  if (storedVersion < 5) return;
  const carried = new Set(bundle.assets.filter((asset) => asset.kind === 'skill').map((asset) => asset.id));
  const attached = new Set();
  const scoped = bundle.workflowSkillAttachments ?? [];
  if (!Array.isArray(scoped)) fail('Workflow skill attachments must be a list.');
  const seen = new Set();
  for (const entry of scoped) {
    exactFields(entry, ['workflow', 'id', 'phases', 'use'], 'Workflow skill attachment');
    const type = bundle.objects.story.workTypes[entry.workflow];
    if (!type || !ID.test(entry.id) || !Array.isArray(entry.phases)
        || new Set(entry.phases).size !== entry.phases.length
        || entry.phases.some((id) => !type.phases.includes(id))
        || typeof entry.use !== 'string' || entry.use.length > 300 || /[|]/.test(entry.use)
        || seen.has(`${entry.workflow}:${entry.id}`)) fail('Invalid workflow-scoped skill attachment.');
    seen.add(`${entry.workflow}:${entry.id}`); attached.add(entry.id);
    if (!carried.has(entry.id)) fail(`Workflow '${entry.workflow}' attaches missing bundled skill '${entry.id}'.`, 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  }
  for (const agent of agents.values()) {
    for (const entry of agent.librarySkills ?? []) {
      attached.add(entry.id);
      if (!carried.has(entry.id)) fail(`Workflow bundle agent '${agent.id}' attaches skill '${entry.id}', which the bundle does not carry.`, 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
    }
  }
  for (const id of carried) {
    if (!attached.has(id)) fail(`Workflow bundle carries skill '${id}', which no carried agent or workflow attaches.`, 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
  }
  const requiredInstructions = new Set(bundle.assets.filter(asset => asset.kind === 'skill').flatMap(asset => parseLibrarySkill(asset.content, { id: asset.id }).instructionRefs));
  const instructionIds = new Set(bundle.assets.filter(asset => asset.kind === 'instruction').map(asset => asset.id));
  if (storedVersion < 8 && requiredInstructions.size) fail('Instruction references require a v8 workflow bundle carrying their exact definitions.', 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  for (const id of requiredInstructions) if (!instructionIds.has(id)) fail(`Workflow bundle references missing instruction '${id}'.`, 'WORKFLOW_BUNDLE_DEPENDENCY_MISSING');
  for (const id of instructionIds) if (!requiredInstructions.has(id)) fail(`Workflow bundle carries unreferenced instruction '${id}'.`, 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');
}

async function referencedInstructionAssets(root, assets) {
  const ids = new Set(assets.filter(asset => asset.kind === 'skill').flatMap(asset => parseLibrarySkill(asset.content, { id: asset.id }).instructionRefs));
  const carried = new Set(assets.filter(asset => asset.kind === 'instruction').map(asset => asset.id));
  const result = [];
  for (const id of [...ids].sort()) {
    if (carried.has(id)) continue;
    const item = await readInstruction(root, id);
    if (!item) fail(`Skill references missing instruction '${id}'.`, 'WORKFLOW_DEPENDENCY_MISSING');
    result.push({ kind: 'instruction', id, path: item.path, mediaType: 'text/markdown; charset=utf-8', size: item.bytes, sha256: digest(item.text), content: item.text });
  }
  return result;
}

async function readAgentLock(root, { optional = true } = {}) {
  const secured = await secureRepositoryPath(root, AGENT_LOCK_PATH, {
    label: AGENT_LOCK_PATH, mustExist: !optional, type: 'file'
  });
  const file = secured.absolute;
  if (!secured.exists) return { file, text: '', value: { version: 1, agents: {} } };
  const text = await readFile(file, 'utf8');
  let value;
  try { value = YAML.parse(text); }
  catch (error) { fail(`Cannot parse ${AGENT_LOCK_PATH}: ${error.message}`, 'WORKFLOW_AGENT_LOCK_INVALID'); }
  if (!plainObject(value) || value.version !== 1 || !plainObject(value.agents)) {
    fail(`${AGENT_LOCK_PATH} must contain version 1 and an agents object.`, 'WORKFLOW_AGENT_LOCK_INVALID');
  }
  return { file, text, value };
}

/** Whether an import record describes something a bundle carries: a file, or a generated artifact's agent. */
function describesCarried(record, assets) {
  if (!plainObject(record?.target)) return false;
  return record.kind === 'generated'
    ? assets.some((asset) => asset.kind === 'agent' && asset.id === record.target.agent)
    : assets.some((asset) => asset.path === record.target.path);
}

async function readImportsLedger(root) {
  const secured = await secureRepositoryPath(root, IMPORTS_LOCK_PATH, { label: IMPORTS_LOCK_PATH, type: 'file' });
  if (!secured.exists) return { file: secured.absolute, text: '', value: { version: 1, imports: {} } };
  const text = await readFile(secured.absolute, 'utf8');
  return { file: secured.absolute, text, value: parseImportsLedger(text) };
}

function lockedAgentEntry(lock, agent) {
  if (!agent.dependencies.length) return null;
  const entry = lock?.agents?.[agent.id];
  if (!plainObject(entry)) {
    fail(`Governed agent '${agent.id}' has remote dependencies but no exact ${AGENT_LOCK_PATH} entry. `
      + `Run singularity-flow agents lock ${agent.id} before exporting this workflow.`,
    'WORKFLOW_AGENT_LOCK_MISSING');
  }
  if (entry.sourceSha256 !== agent.sha256) {
    fail(`Governed agent '${agent.id}' changed after its dependency lock was recorded. `
      + `Run singularity-flow agents lock ${agent.id} --update before exporting this workflow.`,
    'WORKFLOW_AGENT_LOCK_STALE');
  }
  if (!Array.isArray(entry.dependencies)) {
    fail(`Governed agent '${agent.id}' has an invalid dependency lock.`, 'WORKFLOW_AGENT_LOCK_INVALID');
  }
  const dependencies = [];
  for (const dependency of agent.dependencies) {
    const locked = entry.dependencies.find((candidate) => candidate?.id === dependency.id
      && candidate?.type === dependency.type);
    if (!locked) {
      fail(`Governed agent '${agent.id}' dependency '${dependency.id}' is not locked. `
        + `Run singularity-flow agents lock ${agent.id} --update before exporting this workflow.`,
      'WORKFLOW_AGENT_LOCK_MISSING');
    }
    if (!plainObject(locked) || locked.maxBytes !== dependency.maxBytes) {
      fail(`Governed agent '${agent.id}' dependency '${dependency.id}' has invalid locked metadata.`,
        'WORKFLOW_AGENT_LOCK_INVALID');
    }
    if (dependency.type === 'generated') {
      if (locked.dynamic !== true || locked.urlTemplate !== dependency.url) {
        fail(`Governed agent '${agent.id}' generated dependency '${dependency.id}' has a stale lock.`,
          'WORKFLOW_AGENT_LOCK_STALE');
      }
    } else if (locked.url !== dependency.url
        || (locked.status === 'unavailable'
          ? (!dependency.optional || locked.sha256 != null)
          : !/^[a-f0-9]{64}$/.test(locked.sha256 ?? ''))) {
      fail(`Governed agent '${agent.id}' dependency '${dependency.id}' has a stale or invalid lock.`,
        'WORKFLOW_AGENT_LOCK_STALE');
    }
    if (String(locked.url ?? '').startsWith('mcp://')) {
      fail(`Governed agent '${agent.id}' ${dependency.type} '${dependency.id}' was imported from an MCP server, which a workflow bundle cannot carry yet. `
        + 'Import it in the destination repository from the same server instead.', 'WORKFLOW_AGENT_DEPENDENCY_UNPORTABLE');
    }
    // An imported (vendored) copy keeps its recorded path. From bundle v4 the copy itself travels
    // as a vendored asset the reader checks against this entry, so the destination never fetches
    // it again; an older bundle has neither and its destination re-fetches the same URL and hash.
    dependencies.push(clone(locked));
  }
  return {
    source: entry.source,
    sourceSha256: entry.sourceSha256,
    lockedAt: entry.lockedAt,
    dependencies
  };
}

/** A vendored copy as a bundle asset: exact UTF-8 text, owned by the agent or MCP server it serves. */
function vendoredAsset(relative, bytes, owner) {
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) {
    fail(`The imported copy ${relative} is not UTF-8 text, which a workflow bundle cannot carry.`, 'WORKFLOW_BUNDLE_ASSET_INVALID');
  }
  return {
    kind: 'vendored', owner, path: relative,
    mediaType: relative.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
    size: bytes.length, sha256: digest(content), content
  };
}

async function buildBundle(root, workflowIds) {
  const sourceRoot = configurationReadRoot(root);
  const story = await readYamlDocument(sourceRoot, STORE.story, { optional: true });
  const initiative = await readYamlDocument(sourceRoot, STORE.initiative, { optional: true });
  if (!story && !initiative) fail('No governed workflow configuration exists. Run singularity-flow init first.',
    'WORKFLOW_CONFIGURATION_MISSING');
  const configs = { story: story?.value ?? {}, initiative: initiative?.value ?? {} };
  const documents = { story, initiative };
  const requested = [...new Set(workflowIds.map((id) => String(id).trim()).filter(Boolean))];
  if (!requested.length) fail('Choose at least one workflow to export.', 'WORKFLOW_EXPORT_SELECTION_REQUIRED');
  const selected = [];
  for (const selector of requested) {
    const parsed = parseWorkflowSelector(selector);
    const { id } = parsed;
    const matches = Object.entries(STORE).filter(([governs, store]) =>
      (!parsed.governs || parsed.governs === governs)
      && Object.hasOwn(configs[governs]?.[store.workflows] ?? {}, id));
    if (!matches.length) fail(`Unknown workflow '${selector}'.`, 'WORKFLOW_UNKNOWN');
    if (matches.length > 1) {
      fail(`Workflow '${id}' exists for Story and Initiative work. Select story:${id} or initiative:${id}.`,
        'WORKFLOW_SELECTOR_AMBIGUOUS');
    }
    const governs = matches[0][0];
    if (!selected.some((entry) => entry.governs === governs && entry.id === id)) {
      selected.push({ governs, id });
    }
  }

  const objects = emptyObjects();
  const workflows = [];

  for (const { governs, id } of selected) {
    const store = STORE[governs];
    const config = configs[governs];
    const definition = config[store.workflows][id];
    for (const [phaseId, override] of Object.entries(definition.phaseOverrides ?? {})) {
      if (override?.kind === 'skill' || override?.skillBinding != null) {
        fail(`Workflow bundle cannot override compiled skill phase '${governs}:${phaseId}'.`,
          'SKP_PHASE_BINDING_INVALID');
      }
    }
    const targetMap = governs === 'story' ? objects.story.workTypes : objects.initiative.initiativeProfiles;
    addMapEntry(targetMap, id, definition, `${governs}-workflow`);
    workflows.push({ id, governs, definitionSha256: digest(definition) });
  }

  const discovered = await discoverAgents(sourceRoot);
  const workflowSkillAttachments = (await readSkillAttachments(sourceRoot))
    .filter((entry) => entry.workflow && selected.some((workflow) => workflow.governs === 'story' && workflow.id === entry.workflow))
    .map(({ workflow, id, phases, use }) => ({ workflow, id, phases: [...phases], use }));
  const { dependencies, selectedPhases, references } = workflowDependencyClosure(
    configs, workflows, new Map(discovered.map((agent) => [agent.id, agent])),
    'WORKFLOW_DEPENDENCY_MISSING');
  for (const governs of ['story', 'initiative']) {
    const config = configs[governs];
    const store = STORE[governs];
    for (const phaseId of selectedPhases[governs]) {
      const phase = config?.[store.phases]?.[phaseId];
      const targetMap = governs === 'story' ? objects.story.phases : objects.initiative.initiativePhases;
      addMapEntry(targetMap, phaseId, phase, `${governs}-phase`);
    }
  }

  for (const id of dependencies.artifactSets) {
    const value = configs.story?.artifactSets?.[id];
    if (!value) fail(`Referenced artifact set '${id}' is not defined.`, 'WORKFLOW_DEPENDENCY_MISSING');
    addMapEntry(objects.story.artifactSets, id, value, 'artifact-set');
  }
  for (const id of dependencies.mcpServers) {
    const value = configs.story?.mcpServers?.[id];
    if (!value) fail(`Referenced MCP server '${id}' is not defined.`, 'WORKFLOW_DEPENDENCY_MISSING');
    addMapEntry(objects.story.mcpServers, id, value, 'mcp-server');
  }
  for (const id of dependencies.integrationTargets) {
    const value = configs.story?.integrations?.targets?.[id];
    if (!value) fail(`Referenced integration target '${id}' is not defined.`, 'WORKFLOW_DEPENDENCY_MISSING');
    addMapEntry(objects.story.integrations.targets, id, value, 'integration-target');
  }
  for (const governs of ['story', 'initiative']) {
    for (const id of dependencies.authorities[governs]) {
      const value = configs[governs]?.approvalAuthorities?.[id];
      if (!value) fail(`Referenced approval authority '${governs}:${id}' is not defined.`,
        'WORKFLOW_DEPENDENCY_MISSING');
      const target = governs === 'story'
        ? objects.story.approvalAuthorities : objects.initiative.approvalAuthorities;
      addMapEntry(target, id, value, `${governs}-approval-authority`);
    }
  }
  for (const governs of ['story', 'initiative']) {
    for (const id of dependencies.authorityCandidates[governs]) {
      const value = configs[governs]?.approvalAuthorities?.[id];
      if (!value) continue;
      const target = governs === 'story'
        ? objects.story.approvalAuthorities : objects.initiative.approvalAuthorities;
      addMapEntry(target, id, value, `${governs}-approval-authority`);
    }
  }
  for (const id of dependencies.applicabilityPolicies) {
    const value = configs.initiative?.applicabilityPolicies?.[id];
    if (!value) fail(`Referenced applicability policy '${id}' is not defined.`, 'WORKFLOW_DEPENDENCY_MISSING');
    addMapEntry(objects.initiative.applicabilityPolicies, id, value, 'applicability-policy');
  }

  const templateSelections = [];
  const sourceTemplateRoots = {};
  for (const governs of ['story', 'initiative']) {
    if (selectedPhases[governs].size || selected.some((entry) => entry.governs === governs)) {
      sourceTemplateRoots[governs] = configuredTemplateRoot(configs[governs], governs, configs.story);
    }
  }
  for (const { governs, reference } of references) {
    if (reference.startsWith('agent:')) continue;
    let fileReference = reference;
    if (isTemplateReference(reference)) {
      const templateId = parseTemplateReference(reference);
      const declaration = configs.story.templates[templateId];
      addMapEntry(objects.story.templates, templateId, declaration, 'template');
      fileReference = typeof declaration === 'string' ? declaration : declaration?.path;
      if (typeof fileReference !== 'string' || !fileReference) {
        fail(`Template catalog entry '${templateId}' does not define a path.`,
          'WORKFLOW_DEPENDENCY_MISSING');
      }
    }
    const rootPath = sourceTemplateRoots[governs] ??=
      configuredTemplateRoot(configs[governs], governs, configs.story);
    const relative = templateAssetPath(rootPath, fileReference);
    const rootRelative = relative === rootPath ? '' : relative.slice(rootPath.length + 1);
    if (!rootRelative) fail(`Template '${reference}' does not identify a file below ${rootPath}.`,
      'WORKFLOW_BUNDLE_PATH_INVALID');
    templateSelections.push({ governs, reference, relative, rootRelative });
  }
  const sourceAgentLock = await readAgentLock(sourceRoot);
  const assets = [];
  const agentLocks = {};
  const assetIdentity = new Map();
  const pushAsset = (asset) => {
    const identity = `${asset.kind}:${asset.governs ?? ''}:${portableFilesystemPathIdentity(asset.path)}`;
    const prior = assetIdentity.get(identity);
    if (prior) {
      if (prior.sha256 !== asset.sha256) fail(`Bundle asset '${identity}' has conflicting content.`,
        'WORKFLOW_BUNDLE_ASSET_CONFLICT');
      return;
    }
    assetIdentity.set(identity, asset); assets.push(asset);
  };

  for (const agentId of [...dependencies.agents].sort()) {
    const agent = discovered.find((candidate) => candidate.id === agentId);
    if (!agent) fail(`Referenced governed agent '${agentId}' is not installed.`, 'WORKFLOW_DEPENDENCY_MISSING');
    const content = portableAgentText(agent);
    if (agent.scope === 'repository') {
      await secureRepositoryPath(sourceRoot, agent.source, {
        label: `Governed agent '${agentId}'`, mustExist: true, type: 'file'
      });
    }
    const size = Buffer.byteLength(content, 'utf8');
    if (size > MAX_ASSET_BYTES) fail(`Agent '${agentId}' exceeds the portable asset limit.`,
      'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
    pushAsset({
      kind: 'agent', id: agentId, path: `.github/agents/${agentId}.agent.md`,
      mediaType: 'text/markdown; charset=utf-8', size, sha256: digest(content), content
    });
    const lockEntry = lockedAgentEntry(sourceAgentLock.value, agent);
    // Validate the source's lock before materializing external attachments, then bind the
    // exported lock to the exact exported agent bytes. Remote dependency hashes stay unchanged.
    if (lockEntry) agentLocks[agentId] = { ...lockEntry, sourceSha256: digest(content).replace(/^sha256:/, '') };
    for (const view of agent.worldModelViews) dependencies.worldModelViews.add(view);
  }

  for (const { governs, reference, relative, rootRelative } of templateSelections) {
      const secured = await secureRepositoryPath(sourceRoot, relative, {
        label: `Template '${reference}'`, mustExist: true, type: 'file'
      });
      const file = secured.absolute;
      const info = secured.entry;
      if (info.size > MAX_ASSET_BYTES) fail(`Template '${reference}' exceeds the portable asset limit.`,
        'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
      const content = await readFile(file, 'utf8');
      const size = Buffer.byteLength(content, 'utf8');
      pushAsset({
        kind: 'template', governs, reference, rootRelative, path: relative,
        mediaType: 'text/markdown; charset=utf-8', size, sha256: digest(content), content
      });
  }
  // Vendored copies of imported dependencies travel with their owners, so the destination never
  // fetches them again: an agent's imported skills and templates, and an imported MCP server's
  // descriptor. A copy that no longer matches its lock is refused rather than carried; a lock that
  // names a copy this repository no longer has keeps the URL and hash, as before vendoring.
  for (const [agentId, lock] of Object.entries(agentLocks)) {
    for (const dependency of lock.dependencies) {
      if (dependency.vendored == null) continue;
      const relative = portableVendoredPath(dependency.vendored);
      const secured = await secureRepositoryPath(sourceRoot, relative, {
        label: `Imported copy of ${agentId}/${dependency.id}`, type: 'file'
      });
      if (!secured.exists) { delete dependency.vendored; continue; }
      const bytes = await readFile(secured.absolute);
      if (createHash('sha256').update(bytes).digest('hex') !== dependency.sha256) {
        fail(`The imported copy of ${agentId}/${dependency.id} (${relative}) no longer matches its lock. `
          + 'Run singularity-flow imports check, then import it again before exporting.', 'WORKFLOW_VENDORED_COPY_CHANGED');
      }
      pushAsset(vendoredAsset(relative, bytes, { kind: 'agent', id: agentId }));
    }
  }
  // Skills from the skill master travel with the agents that attach them, once each.
  const attachedSkillIds = new Set(discovered.filter((agent) => dependencies.agents.has(agent.id))
    .flatMap((agent) => effectiveLibrarySkills(agent).map((entry) => entry.id)));
  for (const entry of workflowSkillAttachments) attachedSkillIds.add(entry.id);
  for (const skillId of [...attachedSkillIds].sort()) {
    const relative = librarySkillPath(skillId);
    const secured = await secureRepositoryPath(sourceRoot, relative, { label: `Skill '${skillId}'`, type: 'file' });
    if (!secured.exists) fail(`An exported agent attaches skill '${skillId}', which is not in the skill master.`, 'WORKFLOW_DEPENDENCY_MISSING');
    const content = await readFile(secured.absolute, 'utf8');
    parseLibrarySkill(content, { id: skillId });
    pushAsset({
      kind: 'skill', id: skillId, path: relative, mediaType: 'text/markdown; charset=utf-8',
      size: Buffer.byteLength(content, 'utf8'), sha256: digest(content), content
    });
  }
  for (const asset of await referencedInstructionAssets(sourceRoot, assets)) pushAsset(asset);
  for (const serverId of Object.keys(objects.story.mcpServers)) {
    const relative = mcpDescriptorPath(serverId);
    const secured = await secureRepositoryPath(sourceRoot, relative, {
      label: `Imported MCP server descriptor '${serverId}'`, type: 'file'
    });
    if (secured.exists) pushAsset(vendoredAsset(relative, await readFile(secured.absolute), { kind: 'mcp-server', id: serverId }));
  }
  if (assets.length > MAX_ASSETS || assets.reduce((total, asset) => total + asset.size, 0) > MAX_ASSET_BYTES_TOTAL) {
    fail('Workflow bundle exceeds the portable asset limits.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  }
  // Where each carried import came from, so `imports check` in the destination still knows. A
  // generated artifact is fetched for each Story, so its record travels with its agent.
  const ledger = (await readImportsLedger(sourceRoot)).value;
  const imports = Object.fromEntries(Object.keys(ledger.imports).sort()
    .filter((key) => describesCarried(ledger.imports[key], assets))
    .map((key) => {
      const record = clone(ledger.imports[key]);
      if (record.kind === 'agent') {
        const original = discovered.find((agent) => agent.id === record.target.id);
        const exported = assets.find((asset) => asset.kind === 'agent' && asset.id === record.target.id);
        // Export may materialize file-based attachments into a previously imported agent.
        // Account only for this known transformation, never hide prior source customizations.
        if (original && exported && exported.content !== original.text
            && (record.fileSha256 ?? record.sha256) === original.sha256) {
          record.fileSha256 = exported.sha256.replace(/^sha256:/, '');
          record.transforms = [...new Set([...(record.transforms ?? []), 'materialized-skill-attachments'])];
        }
      }
      return [key, record];
    }));
  const staticDependencies = Object.values(agentLocks).flatMap((lock) => lock.dependencies)
    .filter((dependency) => dependency.type !== 'generated');

  const bundle = {
    schemaVersion: WORKFLOW_BUNDLE_SCHEMA_VERSION,
    workflowSkillAttachments,
    kind: WORKFLOW_BUNDLE_KIND,
    workflows: workflows.sort((a, b) => `${a.governs}:${a.id}`.localeCompare(`${b.governs}:${b.id}`)),
    objects,
    skillPackages: [],
    semantics: SKILL_SEMANTICS,
    agentLocks,
    imports,
    assets: assets.sort((a, b) => `${a.kind}:${a.governs ?? ''}:${a.path}`
      .localeCompare(`${b.kind}:${b.governs ?? ''}:${b.path}`)),
    requirements: {
      templateRoots: canonicalValue(sourceTemplateRoots),
      worldModelViews: [...dependencies.worldModelViews].sort(),
      externalAgentDependencies: discovered
        .filter((agent) => dependencies.agents.has(agent.id))
        .flatMap((agent) => agent.dependencies.map((entry) => ({
          agent: agent.id, id: entry.id, type: entry.type, url: entry.url,
          optional: entry.optional, maxBytes: entry.maxBytes
        })))
        .sort((a, b) => `${a.agent}:${a.id}`.localeCompare(`${b.agent}:${b.id}`)),
      dependencyMaterialization: !Object.keys(agentLocks).length ? 'none'
        : staticDependencies.every((dependency) => dependency.vendored != null) ? 'vendored' : 'hash-verified-refetch'
    }
  };
  // Export declarations, never credentials hidden in malformed integration targets.
  normalizeIntegrations(objects.story.integrations);
  const selectedSkills = selectedSkillBindings(bundle);
  let selectedSkillBytes = 0;
  if (selectedSkills.length) {
    const snapshot = configurationReadSnapshot(root);
    if (!snapshot || configs.story.version !== 3) {
      fail('Skill workflow export requires the exact verified approved configuration snapshot.',
        'SKP_APPROVED_CONFIGURATION_REQUIRED');
    }
    for (const choice of selectedSkills) {
      for (const binding of choice.phaseBindings) {
        if (canonicalJson(configs.story.phases[binding.phaseId])
            !== canonicalJson(snapshot.definition.phases[binding.phaseId])) {
          fail(`Skill phase '${binding.phaseId}' differs from its approved configuration.`,
            'SKP_APPROVED_CONFIGURATION_REQUIRED');
        }
      }
      const capture = await inspectApprovedSkillPackage(snapshot, choice.skillId, {
        expectedPackageSha256: choice.packageSha256
      });
      selectedSkillBytes += verifySkillPackage(capture).bytes;
      if (selectedSkillBytes > MAX_SKILL_BYTES_TOTAL) {
        fail('Workflow bundle skill bytes exceed the aggregate retention limit.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
      }
      bundle.skillPackages.push({
        skillId: choice.skillId, manifest: clone(capture.manifest), source: clone(capture.source),
        phaseBindings: choice.phaseBindings,
        files: capture.manifest.files.map((file) => ({
          path: file.path, encoding: 'base64', content: capture.contents.get(file.path).toString('base64')
        }))
      });
    }
  }
  bundle.bundleSha256 = digest(bundleWithoutDigest(bundle));
  return bundle;
}

async function validateBundle(raw, { importedHere = null } = {}) {
  // The registry supplies compatibility, while the transfer reader verifies the original stored
  // identity. Historical v1/v2 bundles retain their original dependency interpretation; the new
  // complete MCP closure is required only for v3, never invented by a compatibility projection.
  const { storedVersion } = readRecord(WORKFLOW_BUNDLE_FAMILY, raw);
  if (!plainObject(raw) || raw.kind !== WORKFLOW_BUNDLE_KIND) {
    fail(`Workflow bundle must use ${WORKFLOW_BUNDLE_KIND} schema version ${WORKFLOW_BUNDLE_SCHEMA_VERSION}.`);
  }
  const fields = ['schemaVersion', 'kind', 'workflows', 'objects', 'agentLocks', 'assets',
    'requirements', 'bundleSha256'];
  if (storedVersion > 1) fields.push('skillPackages', 'semantics');
  if (storedVersion > 3) fields.push('imports');
  if (storedVersion >= 7) fields.push('workflowSkillAttachments');
  exactFields(raw, fields, 'Workflow bundle');
  if (!Array.isArray(raw.workflows) || !raw.workflows.length || !plainObject(raw.objects)
      || !plainObject(raw.objects.story) || !plainObject(raw.objects.initiative)
      || !plainObject(raw.agentLocks) || !Array.isArray(raw.assets) || !plainObject(raw.requirements)
      || !Array.isArray(raw.requirements.worldModelViews)) {
    fail('Workflow bundle is missing workflows, objects, agent locks, or assets.');
  }
  const expectedObjects = emptyObjects();
  if (storedVersion < 6) delete expectedObjects.story.integrations;
  if (canonicalJson(Object.keys(raw.objects).sort()) !== canonicalJson(Object.keys(expectedObjects).sort())) {
    fail('Workflow bundle has unknown or missing governed object sections.');
  }
  for (const governs of Object.keys(expectedObjects)) {
    if (canonicalJson(Object.keys(raw.objects[governs]).sort())
        !== canonicalJson(Object.keys(expectedObjects[governs]).sort())) {
      fail(`Workflow bundle has unknown or missing '${governs}' object catalogs.`);
    }
  }
  if (storedVersion >= 6) {
    if (!plainObject(raw.objects.story.integrations) || !plainObject(raw.objects.story.integrations.targets)) {
      fail('Workflow bundle integrations must contain a targets object.');
    }
    exactFields(raw.objects.story.integrations, ['targets'], 'Workflow bundle integrations');
    normalizeIntegrations(raw.objects.story.integrations);
  }
  let objectCount = 0;
  for (const { governs, section } of configSections(raw)) {
    if (!plainObject(transferCatalog(raw.objects[governs], section))) {
      fail(`Workflow bundle object catalog '${governs}.${section}' must be an object.`);
    }
    for (const id of Object.keys(transferCatalog(raw.objects[governs], section))) {
      requireId(id, `${governs}.${section} object identifier`);
      objectCount += 1;
    }
  }
  if (objectCount > MAX_OBJECTS) fail('Workflow bundle has too many configuration objects.',
    'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  const expected = digest(bundleWithoutDigest(raw));
  if (raw.bundleSha256 !== expected) fail('Workflow bundle digest does not match its content.',
    'WORKFLOW_BUNDLE_DIGEST_MISMATCH');
  if (raw.assets.length > MAX_ASSETS) fail('Workflow bundle has too many assets.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  let total = 0;
  const identities = new Set();
  const agents = new Map();
  const assetKinds = storedVersion >= 8 ? ['template', 'agent', 'vendored', 'skill', 'instruction'] : storedVersion > 4 ? ['template', 'agent', 'vendored', 'skill']
    : storedVersion > 3 ? ['template', 'agent', 'vendored'] : ['template', 'agent'];
  for (const asset of raw.assets) {
    if (!plainObject(asset) || !assetKinds.includes(asset.kind)
        || typeof asset.content !== 'string' || typeof asset.sha256 !== 'string'
        || typeof asset.mediaType !== 'string') {
      fail('Workflow bundle contains an invalid asset record.');
    }
    safeAssetPath(asset.path);
    if (asset.kind === 'vendored' && (!asset.path.startsWith(`${IMPORTS_VENDOR_ROOT}/`)
        || !plainObject(asset.owner) || !['agent', 'mcp-server'].includes(asset.owner.kind)
        || !ID.test(asset.owner.id ?? ''))) {
      fail(`Workflow bundle vendored copy is not owned by a carried agent or MCP server: ${asset.path}`);
    }
    if (asset.kind === 'agent' && (!ID.test(asset.id ?? '')
        || asset.path !== `.github/agents/${asset.id}.agent.md`)) {
      fail(`Workflow bundle agent path is not canonical: ${asset.path}`);
    }
    if (asset.kind === 'skill') {
      if (!ID.test(asset.id ?? '') || asset.path !== librarySkillPath(asset.id)) {
        fail(`Workflow bundle skill path is not canonical: ${asset.path}`);
      }
      try { parseLibrarySkill(asset.content, { id: asset.id }); }
      catch (error) { fail(`Workflow bundle skill '${asset.id}' is not a valid skill: ${error.message}`); }
    }
    if (asset.kind === 'instruction') {
      if (!ID.test(asset.id ?? '') || asset.path !== instructionPath(asset.id)) fail(`Workflow bundle instruction path is not canonical: ${asset.path}`);
      try { parseInstruction(asset.content, { id: asset.id }); } catch (error) { fail(`Workflow bundle instruction '${asset.id}' is invalid: ${error.message}`); }
    }
    if (asset.kind === 'template') {
      if (!['story', 'initiative'].includes(asset.governs)
          || typeof asset.reference !== 'string' || !asset.reference
          || typeof asset.rootRelative !== 'string') {
        fail(`Workflow bundle template asset is missing its governed reference: ${asset.path}`);
      }
      if (isTemplateReference(asset.reference)) parseTemplateReference(asset.reference);
      else safeAssetPath(asset.reference, 'Template reference');
      safeAssetPath(asset.rootRelative, 'Template root-relative path');
    }
    const identity = `${asset.kind}:${asset.governs ?? ''}:${portableFilesystemPathIdentity(asset.path)}`;
    if (identities.has(identity)) fail(`Workflow bundle repeats asset '${identity}'.`);
    identities.add(identity);
    const size = Buffer.byteLength(asset.content, 'utf8');
    if (size !== asset.size || size > MAX_ASSET_BYTES || digest(asset.content) !== asset.sha256) {
      fail(`Workflow bundle asset '${asset.path}' failed size or digest validation.`,
        'WORKFLOW_BUNDLE_ASSET_INVALID');
    }
    if (/^text\//i.test(asset.mediaType)) {
      const format = textAssetFormat(Buffer.from(asset.content, 'utf8'));
      if (!format.valid) {
        fail(`Workflow bundle asset '${asset.path}' ${format.reason}.`,
          'WORKFLOW_BUNDLE_ASSET_INVALID');
      }
    }
    if (asset.kind === 'agent') {
      const parsed = parseAgentDependencies(asset.content, { source: asset.path, agentId: asset.id });
      agents.set(asset.id, { ...parsed, sha256: asset.sha256.replace(/^sha256:/, '') });
    }
    total += size;
  }
  if (total > MAX_ASSET_BYTES_TOTAL) fail('Workflow bundle assets exceed the aggregate limit.',
    'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  for (const id of Object.keys(raw.agentLocks)) {
    requireId(id, 'Agent lock identifier');
    if (!agents.has(id)) fail(`Workflow bundle has a lock for absent agent '${id}'.`,
      'WORKFLOW_AGENT_LOCK_INVALID');
  }
  for (const agent of agents.values()) {
    const locked = lockedAgentEntry({ agents: raw.agentLocks }, agent);
    if (!agent.dependencies.length && Object.hasOwn(raw.agentLocks, agent.id)) {
      fail(`Workflow bundle carries an unnecessary lock for local-only agent '${agent.id}'.`,
        'WORKFLOW_AGENT_LOCK_INVALID');
    }
    if (agent.dependencies.length && !locked) {
      fail(`Workflow bundle is missing the dependency lock for agent '${agent.id}'.`,
        'WORKFLOW_AGENT_LOCK_MISSING');
    }
  }
  validateBundleClosure(raw, agents, storedVersion, importedHere);
  validateVendoredCopies(raw, storedVersion);
  validateCarriedSkills(raw, agents, storedVersion);
  validateSkillPackages(raw, storedVersion);

  const workflowIdentities = new Set();
  for (const entry of raw.workflows) {
    if (!plainObject(entry) || !['story', 'initiative'].includes(entry.governs) || !ID.test(entry.id ?? '')) {
      fail('Workflow bundle has an invalid workflow identity.');
    }
    const identity = `${entry.governs}:${entry.id}`;
    if (workflowIdentities.has(identity)) fail(`Workflow bundle repeats workflow '${identity}'.`);
    workflowIdentities.add(identity);
    const catalog = entry.governs === 'story'
      ? raw.objects.story.workTypes : raw.objects.initiative.initiativeProfiles;
    if (!Object.hasOwn(catalog ?? {}, entry.id) || digest(catalog[entry.id]) !== entry.definitionSha256) {
      fail(`Workflow bundle definition digest is invalid for '${identity}'.`,
        'WORKFLOW_BUNDLE_DIGEST_MISMATCH');
    }
  }
  const catalogWorkflows = [
    ...Object.keys(raw.objects.story.workTypes).map((id) => `story:${id}`),
    ...Object.keys(raw.objects.initiative.initiativeProfiles).map((id) => `initiative:${id}`)
  ].sort();
  if (canonicalJson([...workflowIdentities].sort()) !== canonicalJson(catalogWorkflows)) {
    fail('Workflow bundle workflow inventory does not exactly match its governed workflow objects.');
  }
  return clone(raw);
}

export async function exportWorkflowBundle(root, workflowIds, outPath = null) {
  const bundle = await buildBundle(root, workflowIds);
  await validateBundle(bundle);
  if (!outPath) return bundle;
  const target = path.resolve(outPath);
  await mkdir(path.dirname(target), { recursive: true });
  let handle;
  try {
    handle = await open(target, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(canonicalValue(bundle), null, 2)}\n`, 'utf8');
  } catch (error) {
    if (error?.code === 'EEXIST') fail(`Workflow bundle output already exists: ${target}`,
      'WORKFLOW_EXPORT_OUTPUT_EXISTS');
    throw error;
  } finally { await handle?.close(); }
  return {
    schemaVersion: 1, resultType: 'workflow-export', status: 'exported', outputPath: target,
    bundleSha256: bundle.bundleSha256, workflows: bundle.workflows,
    summary: summarizeBundle(bundle), dependencies: dependencyInventory(bundle),
    notes: []
  };
}

export async function readWorkflowBundle(filePath) {
  const file = path.resolve(filePath);
  const info = await regularFile(file, 'Workflow bundle');
  if (info.size > MAX_SKILL_BUNDLE_BYTES) fail('Workflow bundle file exceeds its size limit.',
    'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  const text = await readFile(file, 'utf8');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { fail(`Workflow bundle is not valid JSON: ${error.message}`); }
  const { storedVersion } = readRecord(WORKFLOW_BUNDLE_FAMILY, parsed);
  if (storedVersion === 1 && info.size > MAX_BUNDLE_BYTES) {
    fail('Workflow bundle file exceeds its size limit.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  }
  return validateBundle(parsed);
}

async function normalizedBundle(bundleOrPath) {
  return typeof bundleOrPath === 'string'
    ? readWorkflowBundle(bundleOrPath) : validateBundle(bundleOrPath);
}

function configSections(bundle) {
  return [
    ['story', 'workTypes'], ['story', 'phases'], ['story', 'templates'], ['story', 'artifactSets'],
    ['story', 'approvalAuthorities'], ['story', 'mcpServers'],
    ['story', 'integrations.targets'],
    ['initiative', 'initiativeProfiles'], ['initiative', 'initiativePhases'],
    ['initiative', 'approvalAuthorities'], ['initiative', 'applicabilityPolicies']
  ].map(([governs, section]) => ({ governs, section, values: transferCatalog(bundle.objects[governs], section) }));
}

function linkedDependencyKind(governs, section) {
  return ({
    phases: `${governs}.phase`,
    initiativePhases: `${governs}.phase`,
    templates: 'template-catalog',
    artifactSets: 'artifact-set',
    approvalAuthorities: `${governs}.approval-authority`,
    mcpServers: 'mcp-server',
    applicabilityPolicies: 'applicability-policy'
  })[section] ?? `${governs}.${section}`;
}

function targetTemplatePath(asset, storyValue, initiativeValue) {
  if (['agent', 'vendored', 'skill', 'instruction', 'skill-package-file'].includes(asset.kind)) return asset.path;
  const governs = asset.governs;
  const targetRoot = configuredTemplateRoot(
    governs === 'story' ? storyValue : initiativeValue, governs, storyValue
  );
  const rootRelative = safeAssetPath(asset.rootRelative, 'Template root-relative path');
  return `${targetRoot}/${rootRelative}`;
}

async function targetSnapshot(root, bundle) {
  const targetRoot = configurationReadRoot(root);
  const story = await readYamlDocument(targetRoot, STORE.story, {
    optional: !Object.keys(bundle.objects.story.workTypes ?? {}).length
  });
  const initiative = await readYamlDocument(targetRoot, STORE.initiative, {
    optional: !Object.keys(bundle.objects.initiative.initiativeProfiles ?? {}).length
  });
  const agentLock = await readAgentLock(targetRoot);
  const importsLedger = await readImportsLedger(targetRoot);
  return { root: targetRoot, story, initiative, agentLock, importsLedger };
}

function entry(kind, id, extra = {}) { return { kind, id, ...extra }; }

function mergedConfigurationValue(existing, bundle, governs, replaced = new Set()) {
  const merged = clone(existing);
  for (const { section, values } of configSections(bundle).filter((item) => item.governs === governs)) {
    const catalog = transferCatalog(merged, section);
    for (const [id, value] of Object.entries(values)) {
      if (!Object.hasOwn(catalog, id) || replaced.has(`${governs}.${section}:${id}`)) catalog[id] = clone(value);
    }
    if (Object.keys(catalog).length) setTransferCatalog(merged, section, catalog);
  }
  return merged;
}

async function mergedImportAgentCatalog(root, bundle, kept = new Set()) {
  const catalog = new Map((await discoverAgents(root)).map((agent) => [agent.id, agent]));
  for (const asset of bundle.assets.filter((candidate) => candidate.kind === 'agent' && !kept.has(candidate.id))) {
    const parsed = parseAgentDependencies(asset.content, { source: asset.path, agentId: asset.id });
    catalog.set(asset.id, {
      ...parsed, scope: 'repository', file: path.join(root, asset.path), text: asset.content,
      sha256: asset.sha256.replace(/^sha256:/, '')
    });
  }
  return catalog;
}

function storyImportCandidate(value, agentCatalog) {
  const candidate = clone(value);
  candidate.agentCatalog = [...agentCatalog.values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  candidate.agents = Object.fromEntries(candidate.agentCatalog.map((agent) => [agent.id, agent]));
  return candidate;
}

function validateStoryImportCandidate(value, agentCatalog) {
  const candidate = storyImportCandidate(value, agentCatalog);
  validateDefinition(candidate);
  validateAgentCatalog(candidate.agentCatalog, candidate);
  return candidate;
}

function validateSkillTargetPolicy(bundle, existing, targetAgents = []) {
  const selected = selectedSkillBindings(bundle);
  if (!selected.length) return;
  if (existing.version !== 3) {
    fail('Target configuration must already admit the registered version-3 skill phase dialect.',
      'SKP_TARGET_POLICY_INCOMPATIBLE');
  }
  const incomingAgents = bundle.assets.filter((asset) => asset.kind === 'agent')
    .map((asset) => parseAgentDependencies(asset.content, { source: asset.path, agentId: asset.id }));
  const targetAgentById = new Map(targetAgents.map((agent) => [agent.id, agent]));
  // A governed session can explicitly select any retained agent, including a non-default agent
  // or an audited compatibility override. Phase labels therefore cannot narrow this admission
  // check: no agent in a skill-bearing bundle may widen the destination's approved limits.
  for (const agent of incomingAgents) {
    const targetAgent = targetAgentById.get(agent.id);
    if (agent.tools.some((tool) => !targetAgent?.tools.includes(tool))
        || (agent.dependencies.length && (!targetAgent
          || canonicalJson(agent.dependencies) !== canonicalJson(targetAgent.dependencies)))) {
      fail(`Skill workflow agent '${agent.id}' requests unapproved target tools or dependencies.`,
        'SKP_TARGET_PERMISSION_UNAPPROVED');
    }
  }
  const approvedChecks = new Set();
  for (const phase of Object.values(existing.phases ?? {})) {
    for (const [index, command] of (phase.qualityCommands ?? []).entries()) {
      approvedChecks.add(`sha256:${recordSha256(normalizeExternalCommand(command, index))}`);
    }
  }
  for (const workflow of Object.values(existing.workTypes ?? {})) {
    for (const phase of Object.values(workflow.phaseOverrides ?? {})) {
      for (const [index, command] of (phase.qualityCommands ?? []).entries()) {
        approvedChecks.add(`sha256:${recordSha256(normalizeExternalCommand(command, index))}`);
      }
    }
  }
  for (const choice of selected) {
    for (const { phaseId } of choice.phaseBindings) {
      const phase = bundle.objects.story.phases[phaseId];
      const refs = phase.skillBinding.bindingRefs;
      // An imported approval catalog is descriptive transfer metadata. It cannot enroll new
      // reviewers or grant a phase authority that this target has not already approved.
      for (const authority of new Set([
        ...phase.approval.authorities, ...(phase.approval.requiredAuthorities ?? [])
      ])) {
        if (!Object.hasOwn(existing.approvalAuthorities ?? {}, authority)
            || canonicalJson(existing.approvalAuthorities[authority])
              !== canonicalJson(bundle.objects.story.approvalAuthorities[authority])) {
          fail(`Skill phase '${phaseId}' requires an already-approved target authority '${authority}'.`,
            'SKP_TARGET_PERMISSION_UNAPPROVED');
        }
      }
      for (const check of refs.checks) {
        if (!approvedChecks.has(check.definitionSha256)) {
          fail(`Skill phase '${phaseId}' requires an already-approved target check '${check.id}'.`,
            'SKP_TARGET_PERMISSION_UNAPPROVED');
        }
      }
      if (refs.codeDeliverySha256 != null
          && refs.codeDeliverySha256 !== `sha256:${recordSha256(normalizeCodeDeliveryPolicy(existing.codeDelivery))}`) {
        fail(`Skill phase '${phaseId}' differs from the target code-delivery policy.`,
          'SKP_TARGET_POLICY_INCOMPATIBLE');
      }
      // Read/source scopes are compiled against an approved authoring catalog, not a portable
      // grant. Until a target catalog re-admits those exact scopes, only a target's existing
      // approved effect binding can establish equivalence. Current host checks still govern use.
      if (refs.sourceScope != null || refs.readScope.sourcePaths.length) {
        const targetRefs = existing.phases?.[phaseId]?.kind === 'skill'
          ? existing.phases[phaseId].skillBinding?.bindingRefs : null;
        if (!targetRefs || canonicalJson(targetRefs.readScope) !== canonicalJson(refs.readScope)
            || canonicalJson(targetRefs.sourceScope) !== canonicalJson(refs.sourceScope)) {
          fail(`Skill phase '${phaseId}' source effects require exact prior target admission.`,
            'SKP_TARGET_PERMISSION_UNAPPROVED');
        }
      }
    }
  }
}

async function validateSkillTargetMembership(root, bundle, conflicts) {
  for (const record of bundle.skillPackages ?? []) {
    const prefix = `singularity/skills/${record.skillId}`;
    const expected = new Set(record.files.map((file) => `${prefix}/${file.path}`));
    const queue = [prefix];
    let directories = 0;
    while (queue.length) {
      const relative = queue.shift();
      const file = await assertSafeTarget(root, relative);
      const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) {
        conflicts.push(entry('skill-package', relative, { reason: 'skill package target is not an ordinary directory' }));
        continue;
      }
      directories += 1;
      if (directories > SKP_CAPTURE_LIMITS.directories
          || relative.slice(prefix.length).split('/').length > SKP_CAPTURE_LIMITS.depth + 1) {
        conflicts.push(entry('skill-package', prefix, { reason: 'target package directory membership exceeds its retention limits' }));
        break;
      }
      const children = await readdir(file, { withFileTypes: true });
      if (children.length > SKP_CAPTURE_LIMITS.files + SKP_CAPTURE_LIMITS.directories) {
        conflicts.push(entry('skill-package', prefix, { reason: 'target package membership exceeds its retention limits' }));
        break;
      }
      for (const child of children) {
        const childPath = `${relative}/${child.name}`;
        if (child.isDirectory()) queue.push(childPath);
        else if (!child.isFile() || child.isSymbolicLink() || !expected.has(childPath)) {
          conflicts.push(entry('skill-package', childPath, {
            reason: 'target package contains an unclaimed or non-regular entry'
          }));
        }
      }
    }
  }
}

async function skillGitAttributes(root, bundle) {
  if (!bundle.skillPackages?.length) return null;
  const relative = 'singularity/.gitattributes';
  const portableState = await portableTargetState(root, relative);
  if (portableState.caseConflict) {
    fail(`Skill package Git attributes collide with '${portableState.caseConflict}'.`,
      'WORKFLOW_IMPORT_TARGET_INVALID');
  }
  const file = await assertSafeTarget(root, relative);
  const secured = await secureRepositoryPath(root, relative, {
    label: 'Retained skill package Git attributes', type: 'file'
  });
  let previous = '';
  if (secured.exists) {
    if (secured.entry.size > MAX_ASSET_BYTES) {
      fail('Skill package Git attributes exceed their configuration file limit.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
    }
    const bytes = await readFile(file);
    const format = textAssetFormat(bytes);
    if (!format.valid) {
      fail(`Skill package Git attributes ${format.reason}.`, 'WORKFLOW_IMPORT_TARGET_INVALID');
    }
    previous = bytes.toString('utf8');
  }
  // This nearest parent attribute is retained by the ordinary configuration owner. Keep the
  // selected package byte-for-byte through Git staging without adding a new file to its manifest.
  // The explicit IDs cannot affect another package or repository application files.
  const retained = '# Retain selected skill package bytes.\n'
    + bundle.skillPackages.map((record) => `skills/${record.skillId}/** -text\n`).join('');
  const alreadyRetained = previous.replaceAll('\r\n', '\n').endsWith(retained);
  const content = alreadyRetained ? previous
    : `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${retained}`;
  if (Buffer.byteLength(content) > MAX_ASSET_BYTES) {
    fail('Skill package Git attributes exceed their configuration file limit.', 'WORKFLOW_BUNDLE_LIMIT_EXCEEDED');
  }
  return {
    asset: {
      kind: 'skill-package-attributes', path: relative, mediaType: 'text/plain; charset=utf-8',
      content, size: Buffer.byteLength(content), sha256: digest(content)
    },
    relative, previousSha256: digest(previous), changed: !alreadyRetained
  };
}

const MAX_RESOLUTION_ROUNDS = 32;

/**
 * Preview an import. Same-name conflicts block it until each has a choice: `resolutions` maps a
 * subject (`phase:<id>`, `agent:<id>`, `template-file:<path>` …) to keep (the repository's own stays
 * and the import uses it), replace (the imported one takes its place) or rename (it arrives under a
 * new name, with every reference to it in the bundle rewritten). `resolveAll` makes one choice for
 * every conflict without its own, and again for conflicts its new names cause: a step imported
 * under a new name changes the workflow that lists it, which then differs from the repository's.
 */
export async function planWorkflowImport(root, bundleOrPath, { resolutions = {}, resolveAll = null } = {}) {
  const destination = captureTransferDestination(root);
  const bundle = await normalizedBundle(bundleOrPath);
  if (resolveAll != null && !RESOLVE_ALL_CHOICES.includes(resolveAll)) {
    fail(`--resolve-all takes one of: ${RESOLVE_ALL_CHOICES.join(', ')}.`, 'WORKFLOW_IMPORT_RESOLUTION_INVALID');
  }
  let plan = await importPlan(root, destination, bundle, normalizeResolutions(resolutions));
  for (let round = 0; resolveAll != null && round < MAX_RESOLUTION_ROUNDS; round += 1) {
    const additions = Object.fromEntries(plan.unresolved
      .filter((item) => item.subject && !Object.hasOwn(plan.resolutions ?? {}, item.subject))
      .map((item) => [item.subject, pickResolution(resolveAll, item)])
      .filter(([, choice]) => choice));
    if (!Object.keys(additions).length) break;
    plan = await importPlan(root, destination, bundle, normalizeResolutions({ ...plan.resolutions, ...additions }));
  }
  const { unused } = plan._internal;
  if (unused.length) {
    fail(`Nothing to keep or replace for ${unused.join(', ')}: ${unused.length === 1 ? 'it does' : 'they do'} not conflict `
      + `with this repository. Remove ${unused.length === 1 ? 'that choice' : 'those choices'} and preview again.`,
    'WORKFLOW_IMPORT_RESOLUTION_UNUSED', { subjects: unused });
  }
  return plan;
}

/** A subject reference a person can resolve, or null when the ID cannot name one. */
function subjectRef(kind, id) {
  if (!kind || (kind === 'template-file' ? !/^[^\s:]+$/.test(id ?? '') : !ID.test(id ?? ''))) return null;
  return `${kind}:${id}`;
}

function assetSubject(asset, relative) {
  if (asset.kind === 'agent') return subjectRef('agent', asset.id);
  if (asset.kind === 'template') return subjectRef('template-file', relative);
  if (asset.kind === 'vendored') return subjectRef(asset.owner.kind, asset.owner.id);
  if (asset.kind === 'skill') return subjectRef('skill', asset.id);
  if (asset.kind === 'instruction') return subjectRef('instruction', asset.id);
  return null;
}

/** An import record follows what it describes: an agent's skill, the agent, a server, a template file. */
function importRecordSubject(record) {
  const target = plainObject(record.target) ? record.target : {};
  if (['skill', 'generated'].includes(record.kind)) return subjectRef('agent', target.agent);
  if (record.kind === 'agent') return subjectRef('agent', target.id);
  if (record.kind === 'mcp-server') return subjectRef('mcp-server', target.id);
  if (record.kind === 'template') return subjectRef('template-file', target.path);
  if (record.kind === 'library-skill') return subjectRef('skill', target.id);
  return null;
}

function conflictPart(item) {
  if (catalogSubjectKind(item.kind)) return 'definition';
  return ({
    agent: `agent file ${item.id}`, 'agent-lock': 'dependency lock', vendored: `imported copy ${item.id}`,
    'import-record': `import record ${item.id}`, template: `file ${item.id}`
  })[item.kind] ?? `${item.kind} ${item.id}`;
}

/** The repository file a template reference names here, or null when it names none. */
function targetTemplateFile(values, governs, reference) {
  if (reference.startsWith('agent:')) return null;
  try {
    let file = reference;
    if (isTemplateReference(reference)) {
      const declaration = values.story?.templates?.[parseTemplateReference(reference)];
      file = typeof declaration === 'string' ? declaration : declaration?.path;
    }
    if (typeof file !== 'string') return null;
    return templateAssetPath(configuredTemplateRoot(values[governs] ?? {}, governs, values.story), file);
  } catch { return null; }
}

/** Which of the repository's own workflows use each step, agent, group, server, template and file. */
function targetUsage(values, agents) {
  const usage = new Map();
  const use = (subject, workflow) => {
    if (!subject) return;
    if (!usage.has(subject)) usage.set(subject, new Set());
    usage.get(subject).add(workflow);
  };
  const catalog = new Map(agents.map((agent) => [agent.id, agent]));
  for (const governs of ['story', 'initiative']) {
    for (const id of Object.keys(values[governs]?.[STORE[governs].workflows] ?? {})) {
      const workflow = `${governs}:${id}`;
      let closure;
      // A workflow that does not resolve here uses nothing an import could change.
      try { closure = workflowDependencyClosure(values, [{ governs, id }], catalog, 'WORKFLOW_DEPENDENCY_MISSING'); }
      catch { continue; }
      const { dependencies, selectedPhases, references } = closure;
      for (const phase of selectedPhases.story) use(subjectRef('phase', phase), workflow);
      for (const phase of selectedPhases.initiative) use(subjectRef('initiative-phase', phase), workflow);
      for (const set of dependencies.artifactSets) use(subjectRef('artifact-set', set), workflow);
      for (const [scope, kind] of [['story', 'approval-group'], ['initiative', 'initiative-approval-group']]) {
        for (const group of [...dependencies.authorities[scope], ...dependencies.authorityCandidates[scope]]) {
          if (Object.hasOwn(values[scope]?.approvalAuthorities ?? {}, group)) use(subjectRef(kind, group), workflow);
        }
      }
      for (const server of dependencies.mcpServers) use(subjectRef('mcp-server', server), workflow);
      for (const agent of dependencies.agents) use(subjectRef('agent', agent), workflow);
      for (const template of dependencies.templateCatalog) use(subjectRef('template', template), workflow);
      for (const policy of dependencies.applicabilityPolicies) use(subjectRef('applicability-policy', policy), workflow);
      for (const { governs: scope, reference } of references) {
        use(subjectRef('template-file', targetTemplateFile(values, scope, reference)), workflow);
      }
    }
  }
  return usage;
}

/** Names already taken here or in the bundle, and the next free one for an import under a new name. */
async function importNaming(target, bundle, values, agents) {
  const taken = new Map();
  const take = (kind, id) => {
    if (!taken.has(kind)) taken.set(kind, new Set());
    taken.get(kind).add(id);
  };
  for (const [kind, [governs, catalog]] of Object.entries(CATALOG_SUBJECTS)) {
    for (const id of Object.keys(transferCatalog(values[governs], catalog))) take(kind, id);
    for (const id of Object.keys(transferCatalog(bundle.objects[governs], catalog))) take(kind, id);
  }
  // One ID names one workflow across Story and Epic work, so neither may take the other's.
  for (const id of [...(taken.get('workflow') ?? []), ...(taken.get('initiative-workflow') ?? [])]) {
    take('workflow', id); take('initiative-workflow', id);
  }
  for (const agent of agents) take('agent', agent.id);
  for (const id of (await loadSkillLibrary(target.root)).skills.keys()) take('skill', id);
  for (const id of (await loadInstructionLibrary(target.root)).instructions.keys()) take('instruction', id);
  const templateRoots = new Map();
  for (const asset of bundle.assets) {
    if (asset.kind === 'agent') take('agent', asset.id);
    if (asset.kind === 'skill') take('skill', asset.id);
    if (asset.kind === 'instruction') take('instruction', asset.id);
    if (asset.kind === 'template') {
      const relative = targetTemplatePath(asset, values.story, values.initiative);
      take('template-file', relative);
      templateRoots.set(relative, relative.slice(0, relative.length - asset.rootRelative.length - 1));
    }
  }
  // A new name must not land on a file that is already here: an agent's file, an imported MCP
  // server's descriptor, or a template.
  const occupied = async (kind, id) => {
    if (taken.get(kind)?.has(id)) return true;
    const relative = kind === 'agent' ? `.github/agents/${id}.agent.md`
      : kind === 'mcp-server' ? mcpDescriptorPath(id) : kind === 'skill' ? librarySkillPath(id) : kind === 'instruction' ? instructionPath(id)
        : kind === 'template-file' ? id : null;
    return relative != null && (await portableTargetState(target.root, relative)).exists;
  };
  return {
    occupiedIds(kind) { return [...(taken.get(kind) ?? [])].sort(); },
    inBundle(kind, id) {
      if (Object.hasOwn(CATALOG_SUBJECTS, kind)) {
        const [governs, catalog] = CATALOG_SUBJECTS[kind];
        return Object.hasOwn(transferCatalog(bundle.objects[governs], catalog), id);
      }
      if (['agent', 'skill', 'instruction'].includes(kind)) return bundle.assets.some((asset) => asset.kind === kind && asset.id === id);
      return kind === 'template-file' && templateRoots.has(id);
    },
    async free(kind, id) {
      const candidate = nameCandidates(kind, id);
      for (let index = 1; ; index += 1) {
        const name = candidate(index);
        if (!(await occupied(kind, name))) { take(kind, name); return name; }
      }
    },
    async claim(kind, id, requested) {
      let name = requested;
      if (kind === 'template-file') {
        // A bare file name stays in the same folder; a path must stay under the same template root.
        name = requested.includes('/') ? requested : `${path.posix.dirname(id)}/${requested}`;
        const root = templateRoots.get(id);
        if (portableConfigurationPath(name) !== name || !name.startsWith(`${root}/`)) {
          fail(`The new path for template-file:${id} must be a repository path under ${root}/.`,
            'WORKFLOW_IMPORT_RESOLUTION_INVALID');
        }
      }
      if (await occupied(kind, name)) {
        fail(`The ${subjectNoun(kind)} '${name}' already exists here or in the bundle. Choose another new name for ${kind}:${id}.`,
          'WORKFLOW_IMPORT_RESOLUTION_INVALID');
      }
      take(kind, name);
      return name;
    }
  };
}

/** Recompute what a rewritten bundle's content determines, then read it like any other bundle. */
async function resealBundle(bundle, importedHere) {
  for (const asset of bundle.assets) {
    asset.size = Buffer.byteLength(asset.content, 'utf8');
    asset.sha256 = digest(asset.content);
  }
  for (const asset of bundle.assets.filter((candidate) => candidate.kind === 'agent')) {
    if (bundle.agentLocks[asset.id]) bundle.agentLocks[asset.id].sourceSha256 = asset.sha256.replace(/^sha256:/, '');
  }
  for (const workflow of bundle.workflows) {
    workflow.definitionSha256 = digest(bundle.objects[workflow.governs][STORE[workflow.governs].workflows][workflow.id]);
  }
  bundle.workflows.sort((a, b) => `${a.governs}:${a.id}`.localeCompare(`${b.governs}:${b.id}`));
  bundle.assets.sort((a, b) => `${a.kind}:${a.governs ?? ''}:${a.path}`.localeCompare(`${b.kind}:${b.governs ?? ''}:${b.path}`));
  bundle.bundleSha256 = digest(bundleWithoutDigest(bundle));
  return validateBundle(bundle, { importedHere });
}

async function importPlan(root, destination, original, chosen) {
  const target = await targetSnapshot(root, original);
  const values = { story: target.story?.value ?? {}, initiative: target.initiative?.value ?? {} };
  const targetAgents = await discoverAgents(target.root);
  const naming = await importNaming(target, original, values, targetAgents);
  const resolutions = {};
  const renames = new Map();
  for (const [subject, choice] of Object.entries(chosen)) {
    const { kind, id } = parseSubject(subject);
    if (choice.action !== 'rename') { resolutions[subject] = { action: choice.action }; continue; }
    if (!naming.inBundle(kind, id)) {
      fail(`The bundle has no ${subjectNoun(kind)} '${id}' to import under a new name.`, 'WORKFLOW_IMPORT_RESOLUTION_INVALID');
    }
    const refusal = renameRefusal(kind, id, original);
    if (refusal) fail(refusal, 'WORKFLOW_IMPORT_RESOLUTION_INVALID');
    const to = choice.to == null ? await naming.free(kind, id) : await naming.claim(kind, id, choice.to);
    renames.set(subject, to);
    resolutions[subject] = { action: 'rename', to };
  }
  // A new name is written through the bundle, which is then read again like any other bundle, so a
  // reference the rewrite missed fails here rather than binding to the repository's own object.
  const targetPhases = new Set(Object.keys(values.story.phases ?? {}));
  const bundle = renames.size ? await resealBundle(renameBundleSubjects(clone(original), renames, {
    targetPhases, targetAgents: new Set(targetAgents.map((agent) => agent.id)),
    targetPath: (asset) => targetTemplatePath(asset, values.story, values.initiative)
  }), {
    phases: targetPhases,
    agents: new Set([...renames].filter(([subject]) => subject.startsWith('agent:')).map(([, to]) => to))
  }) : original;
  const add = []; const reuse = []; const conflicts = [];
  const subjects = new Map();
  const noted = (item, subject) => { if (subject) subjects.set(item, subject); return item; };
  try { validateSkillTargetPolicy(bundle, values.story, targetAgents); }
  catch (error) {
    conflicts.push(entry('story.configuration', WORKFLOW_PATH, {
      reason: error?.message ?? String(error), code: error?.code ?? 'SKP_TARGET_POLICY_INCOMPATIBLE'
    }));
  }
  await validateSkillTargetMembership(target.root, bundle, conflicts);
  for (const { governs, section, values: incoming } of configSections(bundle)) {
    const existing = transferCatalog(values[governs], section);
    const kind = catalogSubjectKind(`${governs}.${section}`);
    for (const [id, value] of Object.entries(incoming)) {
      const subject = subjectRef(kind, id);
      if (!Object.hasOwn(existing, id)) add.push(noted(entry(`${governs}.${section}`, id), subject));
      else if (canonicalJson(existing[id]) === canonicalJson(value)) reuse.push(noted(entry(`${governs}.${section}`, id), subject));
      else conflicts.push(noted(entry(`${governs}.${section}`, id, { reason: 'same ID has different content' }), subject));
    }
  }
  const currentAttachments = await readSkillAttachments(target.root);
  // v7 carries a complete workflow attachment set, including an intentionally empty set.
  // Older bundles do not claim that scope and must not remove target-local attachments.
  for (const workflowId of Object.hasOwn(bundle, 'workflowSkillAttachments') ? Object.keys(bundle.objects.story.workTypes) : []) {
    const incoming = bundle.workflowSkillAttachments.filter((entry) => entry.workflow === workflowId);
    const existing = currentAttachments.filter((entry) => entry.workflow === workflowId);
    const operation = noted(entry('workflow-skill-attachments', workflowId), subjectRef('workflow', workflowId));
    const textOf = (entries) => skillAttachmentsText(entries) ?? '';
    if (textOf(existing) === textOf(incoming)) reuse.push(operation);
    else if (!existing.length) add.push(operation);
    else conflicts.push(Object.assign(operation, { reason: 'workflow has different skill attachments' }));
  }
  for (const [id, value] of Object.entries(bundle.agentLocks)) {
    const existing = target.agentLock.value.agents[id];
    const agent = targetAgents.find((entry) => entry.id === id);
    const portable = existing && agent && String(existing.sourceSha256).replace(/^sha256:/u, '') === digest(agent.text).replace(/^sha256:/u, '')
      ? { ...existing, sourceSha256: digest(portableAgentText(agent)).replace(/^sha256:/u, '') } : existing;
    const subject = subjectRef('agent', id);
    if (existing == null) add.push(noted(entry('agent-lock', id), subject));
    else if (canonicalJson(existing) === canonicalJson(value) || canonicalJson(portable) === canonicalJson(value)) reuse.push(noted(entry('agent-lock', id), subject));
    else conflicts.push(noted(entry('agent-lock', id, { reason: 'same agent has a different dependency lock' }), subject));
  }
  const assetTargets = [];
  const targetPaths = new Map();
  const attributes = await skillGitAttributes(target.root, bundle);
  if (attributes) {
    const operation = entry(attributes.asset.kind, attributes.relative, { sha256: attributes.asset.sha256 });
    (attributes.changed ? add : reuse).push(operation);
    assetTargets.push({ asset: attributes.asset, relative: attributes.relative });
    targetPaths.set(portableFilesystemPathIdentity(attributes.relative), {
      ...attributes.asset, targetPath: attributes.relative
    });
  }
  const incomingSkillAssets = skillFileAssets(bundle);
  const expectedSkillFiles = new Map(incomingSkillAssets.map((asset) => [asset.path, asset.sha256]));
  for (const asset of [...bundle.assets, ...incomingSkillAssets]) {
    const relative = targetTemplatePath(asset, values.story, values.initiative);
    const subject = assetSubject(asset, relative);
    if ((bundle.skillPackages ?? []).some((record) =>
      relative.startsWith(`singularity/skills/${record.skillId}/`))
        && expectedSkillFiles.get(relative) !== asset.sha256) {
      conflicts.push(entry('skill-package', relative, {
        reason: 'another imported asset would change the selected package membership or bytes'
      }));
    }
    const targetIdentity = portableFilesystemPathIdentity(relative);
    const prior = targetPaths.get(targetIdentity);
    if (prior) {
      if (prior.sha256 !== asset.sha256) {
        conflicts.push(entry('asset', relative, { reason: 'two bundle assets map to this target with different content' }));
      }
      continue;
    }
    targetPaths.set(targetIdentity, { ...asset, targetPath: relative });
    const targetState = await portableTargetState(target.root, relative);
    const file = await assertSafeTarget(target.root, relative);
    const info = targetState.caseConflict ? null
      : await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (targetState.caseConflict) {
      conflicts.push(entry(asset.kind, relative, {
        reason: `target collides by portable path identity with '${targetState.caseConflict}'`
      }));
    } else if (!info) add.push(noted(entry(asset.kind, relative, { sha256: asset.sha256 }), subject));
    else if (!info.isFile() || info.isSymbolicLink()) {
      conflicts.push(entry(asset.kind, relative, { reason: 'target is not a regular file' }));
    } else {
      const content = await readFile(file);
      // Export materializes central agent attachments into portable agent tables. Compare the
      // target's same attachments in that representation, without rewriting a seeded agent.
      const targetAgent = asset.kind === 'agent' ? targetAgents.find((agent) => agent.id === asset.id) : null;
      const portableContent = targetAgent ? Buffer.from(portableAgentText(targetAgent, content.toString('utf8'))) : content;
      const comparison = importedAssetReuse(asset, portableContent);
      if (comparison.reusable) reuse.push(noted(entry(asset.kind, relative, { sha256: asset.sha256 }), subject));
      else conflicts.push(noted(entry(asset.kind, relative, { reason: comparison.reason }), subject));
    }
    assetTargets.push({ asset, relative });
  }
  // Where each carried import came from, pointed at the file's place in this repository. A record
  // that differs only in when it was fetched describes the same import, so the target keeps its own.
  const targetPathOf = new Map(assetTargets.map(({ asset, relative }) => [asset.path, relative]));
  const sameImport = (left, right) => {
    const { fetchedAt: _left, ...a } = left; const { fetchedAt: _right, ...b } = right;
    return canonicalJson(a) === canonicalJson(b);
  };
  const importRecords = [];
  for (const [key, carried] of Object.entries(bundle.imports ?? {})) {
    const record = clone(carried);
    record.target.path = targetPathOf.get(carried.target.path) ?? carried.target.path;
    const existing = target.importsLedger.value.imports[key];
    const operation = noted(existing == null || sameImport(existing, record) ? entry('import-record', key)
      : entry('import-record', key, { reason: 'same import has a different source or hash' }), importRecordSubject(record));
    (existing == null ? add : operation.reason ? conflicts : reuse).push(operation);
    importRecords.push([key, record]);
  }
  const state = {
    story: digest(target.story?.text ?? ''), initiative: digest(target.initiative?.text ?? ''),
    agentLock: digest(target.agentLock.text), importsLedger: digest(target.importsLedger.text),
    skillAttachments: digest(skillAttachmentsText(currentAttachments) ?? ''),
    skillGitAttributes: attributes?.previousSha256 ?? null,
    assets: [...targetPaths.values()].map(({ targetPath: relative }) => relative).sort().map((relative) => {
      const operation = [...add, ...reuse, ...conflicts].find((item) => item.id === relative);
      return { path: relative, state: operation?.reason ?? operation?.sha256 ?? operation?.kind ?? 'unknown' };
    })
  };
  // Keep drops the imported subject entirely, its new copies and records too; replace writes it over
  // the repository's own. A subject without a choice stays a conflict.
  const chosenAction = (item) => {
    const action = resolutions[subjects.get(item)]?.action;
    return action === 'keep' || action === 'replace' ? action : null;
  };
  const used = new Set();
  const kept = []; const replaced = [];
  const settled = (item) => ({ kind: item.kind, id: item.id, subject: subjects.get(item) });
  const open = conflicts.filter((item) => {
    const action = chosenAction(item);
    if (!action) return true;
    used.add(subjects.get(item));
    (action === 'keep' ? kept : replaced).push(settled(item));
    return false;
  });
  const additions = add.filter((item) => {
    if (chosenAction(item) !== 'keep') return true;
    kept.push(settled(item));
    return false;
  });
  const unused = Object.entries(resolutions)
    .filter(([subject, choice]) => choice.action !== 'rename' && !used.has(subject)).map(([subject]) => subject);
  const replacedObjects = new Set(replaced.filter((item) => catalogSubjectKind(item.kind))
    .map((item) => `${item.kind}:${item.id}`));
  const keptAgents = new Set(Object.entries(resolutions)
    .filter(([subject, choice]) => choice.action === 'keep' && subject.startsWith('agent:'))
    .map(([subject]) => subject.slice('agent:'.length)));
  for (const item of reuse.filter((entry) => entry.kind === 'agent')) {
    const asset = assetTargets.find(({ relative }) => relative === item.id)?.asset;
    if (asset) keptAgents.add(asset.id);
  }
  const agentCatalog = await mergedImportAgentCatalog(target.root, bundle, keptAgents);
  const incomingConfiguration = Object.fromEntries(['story', 'initiative'].map((governs) => [
    governs,
    configSections(bundle).filter((item) => item.governs === governs)
      .some((item) => Object.keys(item.values).length)
  ]));
  const candidates = Object.fromEntries(['story', 'initiative'].map((governs) => [
    governs, mergedConfigurationValue(values[governs], bundle, governs, replacedObjects)
  ]));
  try {
    const writing = new Set([...additions, ...replaced].map((item) => item.id));
    const files = await Promise.all(assetTargets.filter(({ relative }) => writing.has(relative)).map(async ({ relative, asset }) => {
      let before = await readFile(path.join(target.root, relative)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (before == null && asset.kind === 'template' && asset.rootRelative) {
        before = await readFile(path.join(PACKAGE_ROOT, 'templates', 'artifacts', asset.rootRelative)).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
      }
      return { path: relative, before, after: assetBytes(asset) };
    }));
    assertSeededWorkflowsUnchanged(await seededWorkflowProtection(values.story, values.initiative, targetAgents), values, candidates, {
      beforeAgents: targetAgents, afterAgents: [...agentCatalog.values()],
      files
    });
  } catch (error) {
    open.push(entry('story.configuration', WORKFLOW_PATH, { reason: error.message, code: error.code }));
  }
  // Preview the complete merged schema before asking for confirmation.  A valid source bundle can
  // still be incompatible with a target repository's global policy (for example, a legacy view
  // assignment under a registered-v4 catalog).  That is an import conflict, not a surprise apply
  // failure after the user has confirmed a supposedly ready plan.
  for (const governs of ['story', 'initiative']) {
    const hasObjectConflict = open.some((item) => item.kind.startsWith(`${governs}.`));
    if (!incomingConfiguration[governs] || hasObjectConflict) continue;
    try {
      if (governs === 'story') validateStoryImportCandidate(candidates.story, agentCatalog);
      else validatePortfolio(clone(candidates.initiative));
    } catch (error) {
      open.push(entry(`${governs}.configuration`, STORE[governs].file, {
        reason: error?.message ?? String(error), code: error?.code ?? 'WORKFLOW_CONFIGURATION_INVALID'
      }));
    }
  }
  // Initiative routing is a two-document contract: a portfolio can be structurally valid on its
  // own while assigning a view absent from the repository's Story World-Model catalog.  Check the
  // exact merged pair before presenting a ready plan, including for Initiative-only bundles.
  if (incomingConfiguration.initiative
      && !open.some((item) => item.kind.startsWith('story.')
        || item.kind.startsWith('initiative.'))) {
    try {
      const storyCandidate = storyImportCandidate(candidates.story, agentCatalog);
      const portfolioCandidate = validatePortfolio(clone(candidates.initiative));
    } catch (error) {
      open.push(entry('initiative.configuration', STORE.initiative.file, {
        reason: error?.message ?? String(error), code: error?.code ?? 'WORKFLOW_CONFIGURATION_INVALID'
      }));
    }
  }
  const writes = [...additions, ...replaced];
  const changedPaths = new Set();
  if (writes.some((item) => item.kind.startsWith('story.'))) changedPaths.add(WORKFLOW_PATH);
  if (writes.some((item) => item.kind.startsWith('initiative.'))) changedPaths.add(PORTFOLIO_PATH);
  if (writes.some((item) => item.kind === 'agent-lock')) changedPaths.add(AGENT_LOCK_PATH);
  if (writes.some((item) => item.kind === 'import-record')) changedPaths.add(IMPORTS_LOCK_PATH);
  if (writes.some((item) => item.kind === 'workflow-skill-attachments')) changedPaths.add(SKILL_ATTACHMENTS_PATH);
  for (const item of writes) {
    if (['agent', 'template', 'vendored', 'skill', 'asset', 'skill-package-file', 'skill-package-attributes'].includes(item.kind)) changedPaths.add(item.id);
  }
  // What is still open, one entry per subject: why, which of the repository's workflows use it,
  // and the choices, with a free new name ready for rename.
  const usage = targetUsage(values, targetAgents);
  const grouped = new Map();
  for (const item of open) {
    const subject = subjects.get(item) ?? null;
    if (subject) item.subject = subject;
    const key = subject ?? `${item.kind}:${item.id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const unresolved = [];
  for (const key of [...grouped.keys()].sort()) {
    const items = grouped.get(key);
    const subject = items[0].subject ?? null;
    const { kind, id } = subject ? parseSubject(subject) : { kind: null, id: key };
    const choices = subjectChoices(kind).filter((action) => action !== 'rename' || !renameRefusal(kind, id, bundle));
    const suggested = suggestedAction(kind);
    unresolved.push({
      subject, kind, id, reasons: items.map((item) => `${conflictPart(item)}: ${item.reason}`),
      choices, suggested: choices.includes(suggested) ? suggested : choices.includes('keep') ? 'keep' : null,
      ...(choices.includes('rename') ? { renameTo: await naming.free(kind, id) } : {}),
      usedBy: subject ? [...(usage.get(subject) ?? [])].sort() : []
    });
  }
  const byIdentity = (a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
  const renamed = [...renames].map(([subject, to]) => ({ subject, to })).sort((a, b) => a.subject.localeCompare(b.subject));
  const identities = [];
  const assetDetails = new Map(original.assets.filter((asset) => ['agent', 'skill', 'instruction'].includes(asset.kind))
    .map((asset) => [asset, asset.kind === 'agent' ? parseAgentDependencies(asset.content, { source: asset.path })
      : asset.kind === 'instruction' ? parseInstruction(asset.content, { id: asset.id }) : parseLibrarySkill(asset.content, { id: asset.id })]));
  const skillAttachments = new Map();
  const phaseDestination = (id) => resolutions[`phase:${id}`]?.to ?? resolutions[`initiative-phase:${id}`]?.to ?? id;
  const attachment = (skillId, scope, ownerId, phases, use) => {
    if (!skillAttachments.has(skillId)) skillAttachments.set(skillId, []);
    const targetOwnerId = resolutions[`${scope}:${ownerId}`]?.to ?? ownerId;
    const targetSkillId = resolutions[`skill:${skillId}`]?.to ?? skillId;
    const final = scope === 'workflow'
      ? bundle.workflowSkillAttachments?.find((entry) => entry.workflow === targetOwnerId && entry.id === targetSkillId)
      : effectiveLibrarySkills(agentCatalog.get(targetOwnerId)).find((entry) => entry.id === targetSkillId);
    skillAttachments.get(skillId).push({ scope, ownerId, targetOwnerId,
      phases: [...phases], targetPhases: final?.phases ?? phases.map(phaseDestination), use: use ?? '' });
  };
  for (const entry of original.workflowSkillAttachments ?? []) attachment(entry.id, 'workflow', entry.workflow, entry.phases, entry.use);
  for (const [asset, details] of assetDetails) if (asset.kind === 'agent') {
    for (const entry of details.librarySkills ?? []) attachment(entry.id, 'agent', asset.id, entry.phases, entry.use);
  }
  for (const [kind, [governs, catalog]] of Object.entries(CATALOG_SUBJECTS)) {
    for (const id of Object.keys(transferCatalog(original.objects[governs], catalog)).sort()) {
      const subject = `${kind}:${id}`;
      const reason = renameRefusal(kind, id, original);
      identities.push({ subject, kind, sourceId: id, targetId: resolutions[subject]?.to ?? id,
        action: resolutions[subject]?.action ?? 'automatic', renameable: !reason, reason,
        occupiedIds: Object.keys(transferCatalog(values[governs], catalog)).sort(),
        suggestedId: reason ? id : resolutions[subject]?.to ?? await naming.free(kind, id) });
    }
  }
  for (const asset of original.assets.filter((asset) => ['agent', 'skill', 'instruction'].includes(asset.kind))) {
    const subject = `${asset.kind}:${asset.id}`;
    const details = assetDetails.get(asset);
    identities.push({ subject, kind: asset.kind, sourceId: asset.id, targetId: resolutions[subject]?.to ?? asset.id,
      action: resolutions[subject]?.action ?? 'automatic', renameable: true,
      occupiedIds: asset.kind === 'agent' ? targetAgents.map((agent) => agent.id).sort()
        : asset.kind === 'instruction' ? [...(await loadInstructionLibrary(target.root)).instructions.keys()].sort() : [...(await loadSkillLibrary(target.root)).skills.keys()].sort(),
      suggestedId: resolutions[subject]?.to ?? await naming.free(asset.kind, asset.id),
      label: details.label, description: details.description,
      ...(asset.kind === 'skill' ? { attachments: skillAttachments.get(asset.id) ?? [] } : {}),
      ...(asset.kind === 'skill' ? { instructionRefs: details.instructionRefs } : {}),
      ...(asset.kind === 'instruction' ? { usedBy: original.assets.filter(item => item.kind === 'skill' && parseLibrarySkill(item.content, { id: item.id }).instructionRefs.includes(asset.id)).map(item => item.id) } : {}),
      skills: details.librarySkills ?? [], resources: (details.dependencies ?? []).map((dependency) => ({ ...dependency,
        ...(Array.isArray(dependency.phases) ? { targetPhases: agentCatalog.get(resolutions[subject]?.to ?? asset.id)
          ?.dependencies.find((entry) => entry.id === dependency.id)?.phases ?? dependency.phases.map(phaseDestination) } : {}) })) });
    if (asset.kind === 'agent') for (const dependency of details.dependencies ?? []) {
      if (dependency.type !== 'skill') continue;
      identities.push({ subject: `remote-skill:${asset.id}/${dependency.id}`, kind: 'remote-skill',
        sourceId: `${asset.id}/${dependency.id}`, targetId: `${resolutions[subject]?.to ?? asset.id}/${dependency.id}`,
        occupiedIds: [], renameable: false,
        reason: 'Agent-scoped skill: its destination follows the renamed agent, so it cannot collide with another agent’s skill.' });
    }
  }
  for (const record of original.skillPackages ?? []) identities.push({
    subject: `compiled-skill:${record.skillId}`, kind: 'compiled-skill', sourceId: record.skillId,
    targetId: record.skillId, suggestedId: record.skillId, occupiedIds: [], renameable: false,
    reason: 'Compiled package identity is hash-bound; manage a different package through Skill configuration.',
    label: record.skillId, description: `Verified package ${record.manifest?.packageSha256 ?? record.manifest?.contentSha256 ?? ''}`
  });
  const planCore = {
    schemaVersion: 1, resultType: 'workflow-import-plan', bundleSha256: original.bundleSha256,
    ...(destination ? { destinationAuthority: destination.identity } : {}),
    targetStateSha256: digest(state),
    ...(Object.keys(resolutions).length ? { resolutions } : {}),
    operations: {
      add: additions.sort(byIdentity), reuse: reuse.sort(byIdentity),
      ...(replaced.length ? { replace: replaced.sort(byIdentity) } : {}),
      ...(kept.length ? { keep: kept.sort(byIdentity) } : {}),
      conflicts: open.sort(byIdentity)
    },
    ...(renamed.length ? { renamed } : {}),
    changedPaths: [...changedPaths].sort(),
    sharedDependencies: summarizeBundle(bundle)
  };
  const planSha256 = digest(planCore);
  const result = {
    ...planCore, planSha256, status: open.length ? 'blocked' : 'ready',
    added: planCore.operations.add, reused: planCore.operations.reuse,
    replaced: planCore.operations.replace ?? [], kept: planCore.operations.keep ?? [],
    conflicts: planCore.operations.conflicts, unresolved, identities,
    counts: {
      add: additions.length, reuse: reuse.length, replace: replaced.length, keep: kept.length, conflicts: open.length
    }
  };
  const writeKeys = new Set(writes.map((item) => `${item.kind}\0${item.id}`));
  // Kept non-enumerable so apply can reuse a validated target map without disclosing absolute
  // paths in JSON or binding the plan digest to a temporary approved-configuration mount.
  Object.defineProperty(result, '_internal', {
    value: {
      bundle, target, assetTargets, unused, replacedObjects, keptAgents,
      importRecords: importRecords.filter(([key]) => writeKeys.has(`import-record\0${key}`))
    },
    enumerable: false, configurable: false, writable: false
  });
  TRANSFER_PLANS.set(result, { destination, operation: 'import', input: clone(original), resolutions, planSha256 });
  return result;
}

async function rollbackWrites(applied) {
  const failures = [];
  for (const item of [...applied].reverse()) {
    try {
      if (item.previous == null) await rm(item.file, { force: true });
      else await writeFile(item.file, item.previous);
    } catch (error) {
      failures.push({ file: item.file, message: error?.message ?? String(error) });
    }
  }
  return failures;
}

async function applyFiles(files) {
  const applied = [];
  try {
    for (const { file, content } of files) {
      const info = await lstat(file).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
      const previous = info ? await readFile(file) : null;
      const directory = path.dirname(file);
      await mkdir(directory, { recursive: true });
      const temporary = path.join(directory, `.sflow-workflow-import-${process.pid}-${randomBytes(6).toString('hex')}`);
      try {
        await writeFile(temporary, content, { flag: 'wx' });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      applied.push({ file, previous });
    }
  } catch (error) {
    const rollbackFailures = await rollbackWrites(applied);
    if (rollbackFailures.length) {
      fail(`Workflow transfer failed and ${rollbackFailures.length} rollback operation`
        + `${rollbackFailures.length === 1 ? '' : 's'} also failed. Inspect the reported paths before retrying.`,
      'WORKFLOW_IMPORT_ROLLBACK_FAILED', {
        originalError: error?.message ?? String(error), rollbackFailures
      });
    }
    throw error;
  }
}

function assertConfirmation(expected, actual, operation) {
  if (!expected || expected !== actual) {
    fail(`${operation} plan changed or was not confirmed. Preview again and confirm exact plan ${actual}.`,
      'WORKFLOW_TRANSFER_PLAN_STALE', { expected: expected ?? null, actual });
  }
}

export async function applyWorkflowImport(root, bundleOrPath, {
  expectedPlanSha256, resolutions = {}, resolveAll = null
} = {}) {
  const plan = await planWorkflowImport(root, bundleOrPath, { resolutions, resolveAll });
  assertConfirmation(expectedPlanSha256, plan.planSha256, 'Workflow import');
  if (plan.conflicts.length) {
    const open = plan.unresolved.length;
    fail(`Workflow import has ${open} unresolved conflict${open === 1 ? '' : 's'}; nothing was changed. `
      + 'Preview it with --dry-run to choose keep, replace or rename for each.',
    'WORKFLOW_IMPORT_CONFLICT', { conflicts: plan.conflicts });
  }
  const { bundle, target, assetTargets, importRecords, replacedObjects, keptAgents } = plan._internal;
  const writes = new Set([...plan.operations.add, ...(plan.operations.replace ?? [])]
    .map((item) => `${item.kind}\0${item.id}`));
  const outputs = [];
  const attachedWorkflows = new Set([...plan.operations.add, ...(plan.operations.replace ?? [])]
    .filter((entry) => entry.kind === 'workflow-skill-attachments').map((entry) => entry.id));
  if (attachedWorkflows.size) {
    const current = await readSkillAttachments(target.root);
    const entries = [...current.filter((entry) => !attachedWorkflows.has(entry.workflow)),
      ...(bundle.workflowSkillAttachments ?? []).filter((entry) => attachedWorkflows.has(entry.workflow))];
    outputs.push({ file: await assertSafeTarget(target.root, SKILL_ATTACHMENTS_PATH), content: skillAttachmentsText(entries) ?? 'attachments: []\n' });
  }
  const candidateDocuments = {};
  const incomingConfiguration = {};
  for (const governs of ['story', 'initiative']) {
    const current = target[governs];
    const sections = configSections(bundle).filter((item) => item.governs === governs);
    incomingConfiguration[governs] = sections.some((item) => Object.keys(item.values).length);
    if (!incomingConfiguration[governs]) continue;
    if (!current) fail(`Import requires ${STORE[governs].file}. Run singularity-flow init first.`,
      'WORKFLOW_CONFIGURATION_MISSING');
    const document = current.document.clone();
    let changed = false;
    for (const { section, values } of sections) {
      const keys = section.split('.');
      for (const [id, value] of Object.entries(values)) {
        if (document.getIn([...keys, id]) !== undefined && !replacedObjects.has(`${governs}.${section}:${id}`)) continue;
        if (document.getIn(keys) === undefined) document.setIn(keys, document.createNode({}));
        document.setIn([...keys, id], document.createNode(value)); changed = true;
      }
    }
    candidateDocuments[governs] = { current, document, changed };
  }
  // Repeat schema and cross-document validation immediately before constructing the write set.
  // This keeps apply fail-closed even if preview logic changes independently in the future.
  const candidateValues = {
    story: candidateDocuments.story?.document.toJS() ?? target.story?.value ?? {},
    initiative: candidateDocuments.initiative?.document.toJS() ?? target.initiative?.value ?? {}
  };
  const agentCatalog = await mergedImportAgentCatalog(target.root, bundle, keptAgents);
  validateSkillTargetPolicy(bundle, target.story?.value ?? {}, await discoverAgents(target.root));
  if (incomingConfiguration.story) validateStoryImportCandidate(candidateValues.story, agentCatalog);
  if (incomingConfiguration.initiative) {
    const portfolioCandidate = validatePortfolio(clone(candidateValues.initiative));
    const storyCandidate = storyImportCandidate(candidateValues.story, agentCatalog);
  }
  for (const governs of ['story', 'initiative']) {
    const candidate = candidateDocuments[governs];
    if (!candidate?.changed) continue;
    // People maintain these files too: only the added declarations are new lines.
    outputs.push({
      file: candidate.current.file,
      content: renderPreservingFormatting(candidate.current.text, candidate.document)
    });
  }
  const lockWrites = Object.entries(bundle.agentLocks).filter(([id]) => writes.has(`agent-lock\0${id}`));
  if (lockWrites.length) {
    const value = clone(target.agentLock.value);
    for (const [id, lock] of lockWrites) value.agents[id] = clone(lock);
    outputs.push({ file: target.agentLock.file, content: YAML.stringify(value) });
  }
  if (importRecords.length) {
    const value = clone(target.importsLedger.value);
    for (const [key, record] of importRecords) value.imports[key] = record;
    outputs.push({ file: target.importsLedger.file, content: renderImportsLedger(value) });
  }
  for (const { asset, relative } of assetTargets) {
    if (!writes.has(`${asset.kind}\0${relative}`)) continue;
    outputs.push({ file: await assertSafeTarget(target.root, relative), content: assetBytes(asset) });
  }
  await applyFiles(outputs);
  return {
    schemaVersion: 1, resultType: 'workflow-import', status: outputs.length ? 'imported' : 'current',
    planSha256: plan.planSha256, bundleSha256: plan.bundleSha256,
    workflows: bundle.workflows, added: plan.added, reused: plan.reused,
    replaced: plan.replaced, kept: plan.kept, renamed: plan.renamed ?? [], conflicts: [],
    changed: outputs.length > 0,
    paths: outputs.map((item) => path.relative(target.root, item.file).split(path.sep).join('/')).sort()
  };
}

async function locateWorkflow(root, id) {
  const selected = parseWorkflowSelector(id, 'Source workflow identifier');
  const targetRoot = configurationReadRoot(root);
  const documents = {
    story: await readYamlDocument(targetRoot, STORE.story, { optional: true }),
    initiative: await readYamlDocument(targetRoot, STORE.initiative, { optional: true })
  };
  const found = Object.entries(STORE).filter(([governs, store]) =>
    (!selected.governs || selected.governs === governs)
    && Object.hasOwn(documents[governs]?.value?.[store.workflows] ?? {}, selected.id));
  if (!found.length) fail(`Unknown workflow '${selected.selector}'.`, 'WORKFLOW_UNKNOWN');
  if (found.length > 1) fail(`Workflow '${selected.id}' is ambiguous between Story and Initiative configuration.`,
    'WORKFLOW_SELECTOR_AMBIGUOUS');
  const [governs, store] = found[0];
  return {
    root: targetRoot, governs, store, id: selected.id, selector: `${governs}:${selected.id}`,
    document: documents[governs], documents
  };
}

export async function planWorkflowCopy(root, { sourceId, targetId, label, independent = false, resolutions = {} } = {}) {
  const destination = captureTransferDestination(root);
  const target = requireId(targetId, 'Target workflow identifier');
  if (typeof label !== 'string' || !label.trim()) fail('Workflow copy requires a non-empty label.',
    'WORKFLOW_COPY_LABEL_REQUIRED');
  const located = await locateWorkflow(root, sourceId);
  const source = located.id;
  if (source === target) fail('Source and target workflow IDs must be different.', 'WORKFLOW_COPY_TARGET_INVALID');
  const allTargetMatches = Object.entries(STORE).filter(([governs, store]) =>
    Object.hasOwn(located.documents[governs]?.value?.[store.workflows] ?? {}, target));
  const conflicts = allTargetMatches.map(([governs]) => entry(`${governs}.workflow`, target, {
    reason: 'target workflow already exists'
  }));
  const definition = clone(located.document.value[located.store.workflows][source]);
  definition.label = label.trim();
  const closure = await buildBundle(root, [located.selector]);
  if (independent) {
    const copied = closure.objects[located.governs][located.store.workflows][source];
    copied.label = label.trim();
    if (located.governs === 'initiative') {
      // Canonical Epic steps cannot change ID, but their agent and output configuration can
      // be independently bound by the copied profile. Otherwise renamed assets are orphaned
      // when import deliberately keeps the target's shared canonical declaration.
      for (const id of copied.phases) if (renameRefusal('initiative-phase', id, closure)) {
        const phase = closure.objects.initiative.initiativePhases[id];
        const previous = copied.phaseOverrides?.[id] ?? {};
        copied.phaseOverrides ??= {};
        copied.phaseOverrides[id] = {
          ...clone(previous), agents: clone(previous.agents ?? phase.agents ?? []),
          outputs: Object.fromEntries((phase.outputs ?? []).map((output) => [output.id, {
            ...clone(output), ...clone(previous.outputs?.[output.id] ?? {})
          }]))
        };
      }
    }
    await carryFileAttachments(root, closure);
    await resealBundle(closure);
    const choices = { ...normalizeResolutions(resolutions),
      [`${located.governs === 'story' ? 'workflow' : 'initiative-workflow'}:${source}`]: { action: 'rename', to: target } };
    // Copy editable dependencies rather than sharing them with the source workflow. Approval
    // groups and compiled/canonical contracts keep their identities and remain read-only.
    for (const [kind, [governs, catalog]] of Object.entries(CATALOG_SUBJECTS)) {
      if (kind.includes('approval-group') || kind.includes('workflow')) continue;
      for (const id of Object.keys(transferCatalog(closure.objects[governs], catalog))) {
        if (!renameRefusal(kind, id, closure)) choices[`${kind}:${id}`] ??= { action: 'rename' };
      }
    }
    for (const asset of closure.assets) {
      const kind = asset.kind === 'template' ? 'template-file' : asset.kind;
      if (['agent', 'skill', 'instruction', 'template-file'].includes(kind)) {
        const id = kind === 'template-file' ? targetTemplatePath(asset, located.documents.story?.value ?? {}, located.documents.initiative?.value ?? {}) : asset.id;
        choices[`${kind}:${id}`] ??= { action: 'rename' };
      }
    }
    for (const [subject, choice] of Object.entries(choices)) {
      const { kind, id } = parseSubject(subject);
      if (!kind.includes('approval-group') && !renameRefusal(kind, id, closure) && choice.action !== 'rename') {
        fail(`Independent duplication must rename ${subject}; shared editable dependencies would change the original.`, 'WORKFLOW_COPY_TARGET_INVALID');
      }
    }
    const plan = await planWorkflowImport(root, closure, { resolutions: choices, resolveAll: 'suggested' });
    return Object.assign(plan, { resultType: 'workflow-copy-plan', sourceId: source, sourceSelector: located.selector,
      targetId: target, governs: located.governs, independent: true });
  }
  const reuse = configSections(closure).flatMap(({ governs, section, values }) =>
    Object.keys(values)
      .filter((id) => !(governs === located.governs && section === located.store.workflows && id === source))
      .map((id) => entry(linkedDependencyKind(governs, section), id)));
  for (const asset of [...closure.assets, ...skillFileAssets(closure)]) reuse.push(entry(asset.kind, asset.path));
  for (const id of Object.keys(closure.agentLocks)) reuse.push(entry('agent-lock', id));
  const core = {
    schemaVersion: 1, resultType: 'workflow-copy-plan', sourceId: source,
    ...(destination ? { destinationAuthority: destination.identity } : {}),
    sourceSelector: located.selector, targetId: target,
    governs: located.governs, targetStateSha256: digest({
      story: located.documents.story?.text ?? '', initiative: located.documents.initiative?.text ?? '',
      skillAttachments: skillAttachmentsText(await readSkillAttachments(located.root)) ?? ''
    }),
    definitionSha256: digest(definition),
    changedPaths: conflicts.length ? [] : [located.store.file, ...((closure.workflowSkillAttachments ?? []).length ? [SKILL_ATTACHMENTS_PATH] : [])],
    operations: {
      add: conflicts.length ? [] : [entry(`${located.governs}.workflow`, target)],
      reuse: reuse.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)),
      conflicts
    },
    sharedDependencies: {
      ...summarizeBundle(closure),
      worldModelViews: clone(closure.requirements.worldModelViews),
      dependencyMaterialization: closure.requirements.dependencyMaterialization,
      linked: true
    }
  };
  const result = {
    ...core, planSha256: digest(core), status: conflicts.length ? 'blocked' : 'ready',
    added: core.operations.add, reused: core.operations.reuse, conflicts
  };
  TRANSFER_PLANS.set(result, {
    destination, operation: 'copy', input: { sourceId, targetId, label }, planSha256: result.planSha256
  });
  return result;
}

/** The agent text with rows added to its `## Attached skills` table, which is made when it has none. */
function withAttachedSkillRows(text, rows) {
  const lines = text.replace(/\s+$/, '').split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim().toLowerCase() === `## ${LIBRARY_SKILL_TABLE.heading}`.toLowerCase());
  const cells = rows.map((row) => `| ${row.join(' | ')} |`);
  if (at < 0) {
    return `${[...lines, '', `## ${LIBRARY_SKILL_TABLE.heading}`, '', `| ${LIBRARY_SKILL_TABLE.columns.join(' | ')} |`,
      `|${LIBRARY_SKILL_TABLE.columns.map(() => '---').join('|')}|`, ...cells].join('\n')}\n`;
  }
  let end = at + 1;
  while (end < lines.length && !lines[end].trim()) end += 1;
  while (end < lines.length && lines[end].trim().startsWith('|')) end += 1;
  lines.splice(end, 0, ...cells);
  return `${lines.join('\n')}\n`;
}

/**
 * An independent copy takes along the skills the attachments file attaches to the agents it
 * copies. The copies are this repository's own agents, so each skill is written into its copy's own
 * table and carried, and the import renames the skill and its steps with everything else; the
 * attachments file keeps naming the originals.
 */
async function carryFileAttachments(root, closure) {
  const attachments = await readSkillAttachments(root);
  if (!attachments.length) return;
  const carried = new Set(closure.assets.filter((asset) => asset.kind === 'skill').map((asset) => asset.id));
  for (const asset of closure.assets.filter((candidate) => candidate.kind === 'agent')) {
    const own = new Set(parseAttachedSkills(asset.content, asset.path).map((entry) => entry.id));
    const extra = attachments.filter((entry) => entry.agent === asset.id && !own.has(entry.id));
    if (!extra.length) continue;
    asset.content = withAttachedSkillRows(asset.content, extra.map((entry) => [entry.id, entry.phases.join(', ') || '*', entry.use || '-']));
    for (const entry of extra.filter((candidate) => !carried.has(candidate.id))) {
      const relative = librarySkillPath(entry.id);
      const secured = await secureRepositoryPath(configurationReadRoot(root), relative, { label: `Skill '${entry.id}'`, type: 'file' });
      if (!secured.exists) fail(`${SKILL_ATTACHMENTS_PATH} attaches skill '${entry.id}', which is not in the skill master.`, 'WORKFLOW_DEPENDENCY_MISSING');
      const content = await readFile(secured.absolute, 'utf8');
      parseLibrarySkill(content, { id: entry.id });
      closure.assets.push({
        kind: 'skill', id: entry.id, path: relative, mediaType: 'text/markdown; charset=utf-8',
        size: Buffer.byteLength(content, 'utf8'), sha256: digest(content), content
      });
      carried.add(entry.id);
    }
  }
  closure.assets.push(...await referencedInstructionAssets(configurationReadRoot(root), closure.assets));
}

/** Exact portable representation shared by export and collision comparison. */
function portableAgentText(agent, text = agent.text) {
  const own = new Set((agent.librarySkills ?? []).map((entry) => entry.id));
  const extra = (agent.attachedSkills ?? []).filter((entry) => !own.has(entry.id));
  return extra.length ? withAttachedSkillRows(text, extra.map((entry) =>
    [entry.id, entry.phases.join(', ') || '*', entry.use || '-'])) : text;
}

export async function copyWorkflow(root, {
  sourceId, targetId, label, expectedPlanSha256, independent = false, resolutions = {}
} = {}) {
  const plan = await planWorkflowCopy(root, { sourceId, targetId, label, independent, resolutions });
  assertConfirmation(expectedPlanSha256, plan.planSha256, 'Workflow copy');
  if (independent) {
    const retained = TRANSFER_PLANS.get(plan);
    return applyWorkflowImport(root, retained.input, { expectedPlanSha256, resolutions: retained.resolutions });
  }
  if (plan.conflicts.length) fail(`Workflow '${targetId}' already exists; nothing was changed.`,
    'WORKFLOW_COPY_TARGET_EXISTS', { conflicts: plan.conflicts });
  const located = await locateWorkflow(root, sourceId);
  const document = located.document.document.clone();
  const definition = clone(located.document.value[located.store.workflows][located.id]);
  definition.label = label.trim();
  document.setIn([located.store.workflows, targetId], document.createNode(definition));
  located.store.validate(document.toJS());
  const outputs = [{
    file: located.document.file, content: renderPreservingFormatting(located.document.text, document)
  }];
  if (located.governs === 'story') {
    const attachments = await readSkillAttachments(located.root);
    const copied = attachments.filter((entry) => entry.workflow === located.id).map((entry) => ({ ...entry, workflow: targetId }));
    if (copied.length) outputs.push({ file: await assertSafeTarget(located.root, SKILL_ATTACHMENTS_PATH), content: skillAttachmentsText([...attachments, ...copied]) });
  }
  await applyFiles(outputs);
  return {
    schemaVersion: 1, resultType: 'workflow-copy', status: 'copied',
    sourceId: located.id, sourceSelector: located.selector,
    targetId, workflowId: targetId, governs: located.governs,
    path: located.store.file, planSha256: plan.planSha256,
    sharedDependencies: plan.sharedDependencies, changed: true
  };
}
