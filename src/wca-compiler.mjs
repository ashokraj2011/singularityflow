/** Deterministic, source-bound authoring preview. Nothing here approves, installs or executes. */
import { readFile, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import { configurationReadRoot, configurationReadScope, configurationReadSnapshot } from './configuration-read-scope.mjs';
import { captureVerifiedConfigurationAssetBytes, inspectApprovedSkillPackage } from './configuration-branch.mjs';
import { loadDefinition, validateDefinition, resolveWorkType, assertPlannedClaimsReady, applyWorkflowCompatibility } from './config.mjs';
import { discoverAgents, parseAgentDependencies, validateAgentCatalog } from './agents.mjs';
import { MODEL_TASKS, assertModelTask } from './model-tasks.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';
import { approvalPolicyCapacity, normalizeApprovalPolicy } from './approval-authority.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { inspectSkillPackageContents, readSealedSkillPackage } from './skp-package.mjs';
import { validateConfiguredSkillPhase, compileSkillPhaseProposal } from './skp-contract.mjs';
import { normalizeTemplateCatalog, resolveTemplate } from './template-catalog.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { openGitDraftStore } from './wca-git-drafts.mjs';
import { scanEntries } from './secrets.mjs';
import { SingularityFlowError, isPortableRepositoryPathComponent } from './util.mjs';
import { remoteFingerprint } from './git-remote-diagnostics.mjs';
import { captureEnvironmentDeclaration, matchEnvironmentLocalPath, withEnvironmentWorldModelExclusions,
  ENVIRONMENT_DECLARATION_PATH } from './environment-declaration.mjs';
import { simulateResolvedWorkflowLifecycle, WORKFLOW_LIFECYCLE_SIMULATION_PROFILE } from './workflow-lifecycle-simulation.mjs';
import { planWorkflowOnlyChanges, workflowDefinitionSha256, planSharedPhaseChanges,
  planSharedAgentChanges, planSharedAgentMetadataChanges, planSharedTemplateChanges, planSharedSkillContractChanges,
  planSharedSkillContractGroupChanges,
  WCA_SHARED_PHASE_CHANGES_PROFILE, WCA_SHARED_AGENT_CHANGES_PROFILE, WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE,
  WCA_SHARED_TEMPLATE_CHANGES_PROFILE, WCA_SHARED_SKILL_CONTRACT_CHANGES_PROFILE,
  WCA_SHARED_SKILL_CONTRACT_GROUP_PLAN_PROFILE, WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE } from './wca-workflow-changes.mjs';
import { prepareWorkflowSkillConsent, workflowSkillFinalizationReview,
  consumeWorkflowSkillFinalizationConsent, finalizeWorkflowSkillConsent,
  workflowSkillFinalizedProjection, sealWorkflowSkillFinalization,
  renderWorkflowSkillCandidateAgent, WCA_SKP_LOCAL_PRODUCER_PROFILE } from './wca-skp-finalization.mjs';
import { sharedSkillContractCatalog } from './wca-skill-contract-review.mjs';
import { incrementCommandCounter } from './dx-timing-context.mjs';

export const WCA_COMPILER_PROFILE = 'wca-complete-package/v4';
export const WCA_PREVIEW_KIND = 'workflow-authoring-package-preview';
export const WCA_REQUEST_SCHEMA = 'sflow-workflow-request@2';
export const WCA_CATALOG_CHOICE_KIND = 'workflow-authoring-catalog-choices';
export const WCA_COMPILER_LIMITS = Object.freeze({ requestBytes: 5 * 1024 * 1024, objects: 128, workflows: 16, sharedAffectedWorkflows: 64, phases: 64, assets: 128, assetBytes: 8 * 1024 * 1024, findings: 128, nodes: 100_000, depth: 32 });
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SHA = /^sha256:[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const CONTEXTS = new WeakMap();
const SOURCES = new WeakMap();
const PREVIEWS = new WeakMap();
const GROUPS = ['workflows', 'phases', 'agents', 'skills', 'templates'];
const KINDS = { workflows: 'workflow', phases: 'phase', agents: 'agent', skills: 'skill', templates: 'template' };
const CATALOG_KINDS = ['phase', 'template', 'agent', 'workflow', 'execution-task', 'quality-command', 'approval-authority'];
const digest = (value) => `sha256:${recordSha256(value)}`;
const bytesDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function fail(message, code = 'WCA_REQUEST_INVALID') { throw new SingularityFlowError(message, { code }); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function closed(value, fields, label) {
  if (!plain(value) || Object.keys(value).some((key) => !fields.includes(key))) fail(`${label} has an unsupported closed shape.`);
}
function id(value, label) {
  if (typeof value !== 'string' || !ID.test(value) || value.length > 64 || !isPortableRepositoryPathComponent(value)) fail(`${label} requires a portable lower-case kebab-case ID.`);
  return value;
}
function text(value, label, maximum = 30_000) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || Buffer.from(value).toString('utf8') !== value || /\0/u.test(value)) fail(`${label} requires bounded literal UTF-8 text.`);
  return value;
}
function portable(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || value.split('/').some((part) => !isPortableRepositoryPathComponent(part))) fail(`${label} requires a portable relative logical path.`);
  return value;
}
function optionalArray(value, label) { if (value !== undefined && !Array.isArray(value)) fail(`${label} must be an explicit array.`); return value ?? []; }
function reviewedNonCodeFinish(order, symbols, candidate) {
  const last = order.at(-1);
  const phase = candidate.phases[last];
  // Ordinary phases have a concrete template, artifact-only scope and a required human approval.
  // Approved review phases remain usable when the workflow is later edited or forked.
  if (!phase || phase.kind === 'skill'
      || phase.writeScope !== 'artifact-only' || !phase.approval
      || phase.approval === 'none' || ![undefined, 'required'].includes(phase.approval.mode)
      || !phase.inputs?.some((input) => (typeof input === 'string' ? input : input.phase) === order.at(-2))) return false;
  return order.every((phaseId) => {
    const selected = symbols.phases.get(phaseId);
    if (selected?.kind === 'skill') {
      return selected.contract?.task !== 'code' && selected.contract?.writeScope === 'artifact-only';
    }
    const ordinary = candidate.phases[phaseId];
    return ordinary?.writeScope === 'artifact-only' && !phaseRequiresCodeDelivery(ordinary);
  });
}
function safeCopy(value) {
  let nodes = 0; const active = new Set();
  function visit(item, depth) {
    if (++nodes > WCA_COMPILER_LIMITS.nodes || depth > WCA_COMPILER_LIMITS.depth) fail('Compiler input exceeds its structural budget.', 'WCA_COMPILER_LIMIT');
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item;
    if (typeof item === 'string') { if (Buffer.from(item).toString('utf8') !== item) fail('Compiler input has invalid Unicode.'); return item; }
    if (!Array.isArray(item) && !plain(item) || active.has(item)) fail('Compiler input must be acyclic ordinary JSON data.');
    active.add(item); const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const descriptor of Object.values(descriptors)) if (!Object.hasOwn(descriptor, 'value')) fail('Compiler input cannot contain accessors.');
    let result;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length) fail('Compiler arrays must be dense ordinary JSON arrays.');
      result = item.map((child) => visit(child, depth + 1));
    } else result = Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child, depth + 1)]));
    active.delete(item); return result;
  }
  const copy = visit(value, 0); const bytes = Buffer.from(canonicalJson(copy));
  if (bytes.length > WCA_COMPILER_LIMITS.requestBytes) fail('Compiler request exceeds its byte budget.', 'WCA_COMPILER_LIMIT');
  admit([{ path: 'workflow-request.json', content: bytes.toString('utf8'), forceScan: true }]);
  return copy;
}
function admit(entries) { if (!scanEntries(entries).clean) fail('Compiler capture contains possible credentials; no candidate is emitted.', 'WCA_COMPILER_CONTENT_BLOCKED'); }
function freeze(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
async function approvedBytes(root, relative, optional = false) {
  portable(relative, 'Approved asset path');
  const file = path.join(root, relative); const info = await lstat(file).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info && optional) return null;
  if (!info?.isFile() || info.isSymbolicLink() || info.size > WCA_COMPILER_LIMITS.assetBytes) fail('Approved asset is unavailable or outside the compiler byte budget.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  const bytes = await readFile(file);
  if (bytes.length !== info.size) fail('Approved asset changed during capture.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  return bytes;
}

// Protect the entire approved package identity, including unassigned packages and resources
// absent from the workflow catalog. Names come from the exact approved owner, not the app tree.
async function approvedSkillIds(root, snapshot) {
  const ids = new Set();
  const capture = (key) => {
    if (!ID.test(key) || key.length > 64 || !isPortableRepositoryPathComponent(key)) fail('Approved skill package identity is not portable.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
    ids.add(key);
    if (ids.size > 4096) fail('Approved skill identity catalog exceeds its bounded capture budget.', 'WCA_COMPILER_LIMIT');
  };
  if (snapshot) {
    for (const entry of snapshot.assets) {
      if (!entry.relative.startsWith('singularity/skills/')) continue;
      const parts = entry.relative.slice('singularity/skills/'.length).split('/');
      if (parts.length > 1) capture(parts[0]);
    }
    return ids;
  }
  // Older verified read overlays lack a retained snapshot. Inspect only their private approved
  // projection's bounded directory names; never hydrate package bytes or follow symlinks.
  const directory = path.join(root, 'singularity/skills');
  const info = await lstat(directory).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return ids;
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Approved skill identity catalog is unavailable.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 4096) fail('Approved skill identity catalog exceeds its bounded capture budget.', 'WCA_COMPILER_LIMIT');
  for (const entry of entries) {
    if (entry.isSymbolicLink()) fail('Approved skill identity catalog contains a symbolic link.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
    if (entry.isDirectory()) capture(entry.name);
  }
  return ids;
}

/** Opaque runtime context, captured only through the freshly refreshed approved-config owner. */
export async function captureWorkflowCompilerContext(root) {
  return withApprovedConfigurationRead(root, async (authority) => {
    if (!authority || authority.kind === 'working-tree' || typeof authority.remote !== 'string' || !OID.test(authority.commit ?? '')) fail('Preview requires an exact approved configuration authority.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
    const sourceRoot = configurationReadRoot(root);
    const ownerPolicy = configurationReadScope(root)?.assetPolicy;
    if (!ownerPolicy) fail('Preview requires the exact approved configuration asset policy.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
    const assetPolicy = freeze(structuredClone(ownerPolicy));
    const before = await approvedBytes(sourceRoot, 'singularity/workflow.yml');
    const definition = structuredClone(await loadDefinition(root));
    // Runtime discovery fields contain local/temporary paths and are not workflow.yml policy.
    delete definition.agents; delete definition.agentCatalog; delete definition.agentPromptsRoot;
    const agents = await discoverAgents(root);
    const environmentCapture = await captureEnvironmentDeclaration(sourceRoot, { optional: true });
    const files = new Map([['singularity/workflow.yml', before]]);
    if (environmentCapture) files.set(ENVIRONMENT_DECLARATION_PATH, Buffer.from(environmentCapture.bytes));
    const skills = await approvedSkillIds(sourceRoot, configurationReadSnapshot(root));
    for (const agent of agents.filter((value) => value.scope === 'repository')) files.set(portable(agent.source, 'Approved agent path'), Buffer.from(agent.text));
    for (const entry of Object.values(normalizeTemplateCatalog(definition.templates))) {
      const relative = portable(`${definition.templatesRoot}/${entry.path}`, 'Approved template path');
      const content = await approvedBytes(sourceRoot, relative, true); if (content) files.set(relative, content);
    }
    const selectedTemplatePaths = new Set(Object.values(definition.phases).map((phase) => phase.defaultTemplate));
    for (const workflow of Object.values(definition.workTypes)) for (const value of Object.values(workflow.templateOverrides ?? {})) selectedTemplatePaths.add(value);
    for (const reference of selectedTemplatePaths) {
      if (!reference) continue;
      const selected = resolveTemplate(definition, reference);
      if (!selected?.path) continue; // Remote agent dependencies are never fetched by preview.
      const relative = portable(`${definition.templatesRoot}/${selected.path}`, 'Approved template path');
      if (!files.has(relative)) { const content = await approvedBytes(sourceRoot, relative, true); if (content) files.set(relative, content); }
    }
    // Exact replacement parents come from the retained Git/blob owner, never another live read.
    // Older overlays can still inspect ordinary requests; new replacement profiles require this.
    const retainedSnapshot = configurationReadSnapshot(root);
    let exactFiles = null;
    if (retainedSnapshot) {
      try {
        exactFiles = new Map(captureVerifiedConfigurationAssetBytes(retainedSnapshot, {
          selectPaths: [...files.keys()]
        }).map((entry) => [entry.relative, entry.contents]));
      } catch (error) {
        // The new bounded raw-byte profile cannot change ordinary/historical capture behavior.
        // Only its explicit replacement consumer below treats unavailability as a refusal.
        if (!['APPROVED_CONFIGURATION_EXACT_BYTES_UNAVAILABLE', 'APPROVED_CONFIGURATION_INCOMPLETE'].includes(error?.code)) throw error;
      }
    }
    const repository = openGitDraftStore({ root, remote: authority.remote, workspaceId: 'configuration' }).capability.repository;
    const baseRevision = authority.manifest?.source?.commit ?? authority.commit;
    if (!OID.test(baseRevision)) fail('Approved source commit is unavailable.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
    const view = freeze({ kind: 'workflow-authoring-compiler-context', schemaVersion: 1,
      source: { kind: authority.kind, repository, ref: authority.ref, observedCommit: authority.commit, baseRevision,
        workflowSha256: bytesDigest(before) }, profile: WCA_COMPILER_PROFILE });
    CONTEXTS.set(view, { root, sourceRoot, definition: structuredClone(definition), rawDefinition: YAML.parse(before.toString('utf8')), agents, skills, files, exactFiles, retainedSnapshot, repository, baseRevision, assetPolicy,
      environmentDeclaration: environmentCapture?.declaration ?? null, environmentSha256: environmentCapture ? bytesDigest(environmentCapture.bytes) : null,
      expectedAuthority: { kind: authority.kind, commit: authority.commit, sourceCommit: baseRevision, remoteFingerprint: remoteFingerprint(repository) } });
    return view;
  }, { preferAuthority: true, requireAuthorityRefresh: true, allowLocalHeads: false, freshOwnerCapture: true, captureAuthoringBytes: true });
}

function assertExactReplacementCapture(captured) {
  if (!captured.exactFiles) fail('Exact replacements require retained verified Git/blob capture; no live directory fallback is allowed.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  for (const [relative, bytes] of captured.files) {
    if (!captured.exactFiles.get(relative)?.equals(bytes)) fail('Approved authoring text differs from its retained exact Git bytes.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  }
  const normalized = applyWorkflowCompatibility(YAML.parse(captured.exactFiles.get('singularity/workflow.yml').toString('utf8')));
  normalized.agentCatalog = captured.agents; normalized.agents = Object.fromEntries(captured.agents.map((agent) => [agent.id, agent]));
  validateDefinition(normalized);
  delete normalized.agentCatalog; delete normalized.agents; delete normalized.agentPromptsRoot;
  const projected = withEnvironmentWorldModelExclusions(normalized, captured.environmentDeclaration);
  if (canonicalJson(projected) !== canonicalJson(captured.definition)) fail('Approved configuration policy differs from its retained exact Git bytes.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
}

/** Reads one actual immutable selected revision. Caller JSON cannot impersonate a retained read. */
export async function captureWorkflowDraftCompilerSource(context, { draftId, revision = null } = {}) {
  const captured = CONTEXTS.get(context); if (!captured) fail('Use an owner-captured compiler context.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  const store = openGitDraftStore({ root: captured.root, remote: captured.repository, workspaceId: 'configuration', environmentDeclaration: captured.environmentDeclaration });
  const read = await store.readRevision({ draftId, revision });
  const payload = safeCopy(read.payload); const retainedPackages = new Map();
  if (payload.intent === 'edit' && payload.changes?.length === 1
      && payload.changes[0]?.profile === WCA_SHARED_SKILL_CONTRACT_CHANGES_PROFILE
      && payload.definitions?.phases?.length === 1 && payload.definitions.phases[0]?.id === payload.changes[0].id) {
    const phase = captured.rawDefinition.phases[payload.changes[0].id]; const selected = phase?.skillBinding?.bindingRefs?.skill;
    if (phase?.kind === 'skill' && selected && captured.retainedSnapshot) {
      incrementCommandCounter('wca.replacement-package-capture');
      const capture = await inspectApprovedSkillPackage(captured.retainedSnapshot, selected.id, {
        expectedPackageSha256: selected.packageSha256, requireInertGitMode: true });
      retainedPackages.set(selected.id, readSealedSkillPackage(capture));
    }
  }
  if (payload.intent === 'edit' && Array.isArray(payload.changes) && payload.changes.length >= 2
      && payload.changes.length <= 16 && payload.changes.every((change) =>
        change?.profile === WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE)
      && payload.definitions?.phases?.length === payload.changes.length && captured.retainedSnapshot) {
    for (const change of payload.changes) {
      const phase = captured.rawDefinition.phases?.[change.id]; const selected = phase?.skillBinding?.bindingRefs?.skill;
      if (phase?.kind !== 'skill' || !selected || retainedPackages.has(selected.id)) continue;
      incrementCommandCounter('wca.replacement-package-capture');
      const capture = await inspectApprovedSkillPackage(captured.retainedSnapshot, selected.id, {
        expectedPackageSha256: selected.packageSha256, requireInertGitMode: true });
      retainedPackages.set(selected.id, readSealedSkillPackage(capture));
    }
  }
  const source = freeze({ kind: 'workflow-authoring-draft-source', schemaVersion: 1, repository: captured.repository,
    workspaceId: read.record.workspaceId, draftId: read.record.draftId, revision: read.record.revision,
    lifecycleEpoch: read.record.lifecycleEpoch, revisionSha256: read.record.revisionSha256, head: read.head,
    payloadSha256: read.record.content.payloadSha256, assetManifestSha256: read.record.content.assetManifestSha256,
    lifecycle: read.tombstone ? 'deleted' : 'live' });
  SOURCES.set(source, { context, payload, retainedPackages, assets: read.assets.map((asset) => ({ path: asset.path, content: Buffer.from(asset.content) })) });
  return source;
}

function requestShape(request) {
  closed(request, ['schema', 'intent', 'id', 'label', 'description', 'baseRevision', 'target', 'bindings', 'definitions', 'changes', 'assets', 'executionProposals', 'rationale'], 'Workflow request');
  if (request.schema !== WCA_REQUEST_SCHEMA) fail('Select the supported versioned complete workflow request. Historical version 1 is not interpreted as version 2.', 'WCA_REQUEST_UNSUPPORTED');
  if (!['create', 'edit', 'fork'].includes(request.intent)) fail('Request intent must be create, edit or fork.');
  id(request.id, 'Package ID'); text(request.label, 'Package label', 512);
  if (request.description !== undefined && typeof request.description !== 'string' || request.rationale !== undefined && typeof request.rationale !== 'string') fail('Description and rationale must be literal text.');
  closed(request.target, ['governs', 'authority', 'hosts'], 'Request target');
  if (request.target.governs !== 'story' || request.target.authority !== 'selected-repository') fail('This compiler currently supports the selected repository Story authority only.', 'WCA_TARGET_UNSUPPORTED');
  if (request.target.hosts !== undefined && (!Array.isArray(request.target.hosts) || request.target.hosts.some((host) => typeof host !== 'string'))) fail('Target hosts must be explicit catalog IDs.');
  if (request.bindings !== undefined && !plain(request.bindings)) fail('Bindings must be a named reference map.');
  if (request.definitions !== undefined) closed(request.definitions, GROUPS, 'Candidate definitions');
  for (const field of ['changes', 'executionProposals']) if (request[field] !== undefined && !Array.isArray(request[field])) fail(`${field} must be an explicit array; unsupported proposals cannot be silently discarded.`);
}

function compilerCatalogs(captured) {
  const catalogs = {
    phase: captured.definition.phases, workflow: captured.definition.workTypes,
    agent: Object.fromEntries(captured.agents.map((agent) => [agent.id, agent])),
    template: normalizeTemplateCatalog(captured.definition.templates),
    'approval-authority': captured.definition.approvalAuthorities,
    'execution-task': Object.fromEntries(MODEL_TASKS.map((task) => [task, { id: task, owner: 'model-tasks/v1' }])),
    'quality-command': {}
  };
  const ambiguousChecks = new Set();
  for (const phase of Object.values(captured.definition.phases)) for (const [index, raw] of (phase.qualityCommands ?? []).entries()) {
    const check = normalizeExternalCommand(raw, index); const previous = catalogs['quality-command'][check.id];
    if (previous && canonicalJson(previous) !== canonicalJson(check)) ambiguousChecks.add(check.id);
    catalogs['quality-command'][check.id] = check;
  }
  return { catalogs, ambiguousChecks };
}

/** Navigation only. A visible authority ID is not membership, host access or permission. */
export function workflowCompilerCatalogChoices(context, options = {}) {
  const captured = CONTEXTS.get(context); if (!captured) fail('Use an owner-captured compiler context.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  const copied = safeCopy(options); closed(copied, ['kind', 'cursor', 'limit'], 'Catalog navigation');
  const { kind = null, cursor = 0, limit = 32 } = copied;
  if (kind !== null && !CATALOG_KINDS.includes(kind) || !Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 64 || kind === null && cursor !== 0) fail('Catalog navigation requires a supported kind and bounded pagination.');
  const { catalogs, ambiguousChecks } = compilerCatalogs(captured);
  const groups = (kind === null ? CATALOG_KINDS : [kind]).map((catalogKind) => {
    const entries = Object.entries(catalogs[catalogKind] ?? {}).filter(([key]) => catalogKind !== 'quality-command' || !ambiguousChecks.has(key)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const choices = entries.slice(cursor, cursor + limit).map(([key, value]) => ({
      ref: { source: 'catalog', kind: catalogKind, id: key },
      label: Array.from(typeof value.label === 'string' ? value.label : key).slice(0, 256).join(''),
      ...(catalogKind === 'workflow' && Object.hasOwn(captured.rawDefinition.workTypes ?? {}, key)
        ? { rawDefinitionSha256: workflowDefinitionSha256(captured.rawDefinition.workTypes[key]),
          phaseOrder: [...captured.rawDefinition.workTypes[key].phases] } : {})
    }));
    return { kind: catalogKind, choices, total: entries.length, nextCursor: cursor + choices.length < entries.length ? cursor + choices.length : null, unavailable: catalogKind === 'quality-command' ? ambiguousChecks.size : 0 };
  });
  return freeze({ schemaVersion: 1, kind: WCA_CATALOG_CHOICE_KIND, approvedSource: context.source,
    permissionEffect: 'none', membership: 'not-verified', hostMapping: 'not-verified', groups });
}

/** Pure deterministic compilation over opaque exact source/context captures. */
export function compileWorkflowDraftPackage(selection = {}) {
  return compileOwnerWorkflowDraftPackage(selection);
}

function compileOwnerWorkflowDraftPackage({ context, source } = {}, finalization = null) {
  const captured = CONTEXTS.get(context); const draft = SOURCES.get(source);
  if (!captured || !draft || draft.context !== context) fail('Compiler context and draft source must be captured together by their owners.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  const request = safeCopy(draft.payload);
  const findings = []; const locks = []; const operations = []; const graph = []; const skillProposals = [];
  const skillEntries = [];
  const finalized = finalization ? workflowSkillFinalizedProjection(finalization.prepared, finalization.projection) : null;
  const finalizedPhases = new Map((finalized?.phases ?? []).map((entry) => [entry.phaseId, entry.configuredPhase]));
  const unavailable = new Set(['WCA_SKP_CONFIRMATION_BINDING_PENDING', 'WCA_HOST_CONTRACT_UNAVAILABLE', 'WCA_OPERATION_MAPPING_UNAVAILABLE', 'WCA_SKILL_ASSIGNMENT_UNAVAILABLE', 'WCA_CHANGE_OWNER_UNAVAILABLE', 'WCA_REMOTE_DEPENDENCY_UNAVAILABLE', 'WCA_SHARED_SKILL_CONTRACT_GROUP_OWNER_UNAVAILABLE']);
  const add = (code, fieldPath, message, category = unavailable.has(code) ? 'capability-unavailable' : 'submission-blocker') => {
    if (findings.length < WCA_COMPILER_LIMITS.findings) findings.push({ code, fieldPath, message, category, requiredFor: 'package-preview', sourceRule: WCA_COMPILER_PROFILE, resolvingAction: 'workflow.author.edit' });
  };
  const attempt = (fieldPath, work) => { try { return work(); } catch (error) { add(error.code ?? 'WCA_VALIDATION_FAILED', fieldPath, error.code ? error.message : 'The existing configuration owner refused this candidate.'); return null; } };
  const candidate = structuredClone(captured.definition); const files = new Map(); const symbols = Object.fromEntries(GROUPS.map((group) => [group, new Map()]));
  const replacementFiles = new Map(); const agents = [...captured.agents];
  let acceptedRequest = false; let workflowChanges = null; let sharedObjectChanges = null;
  let phaseReplacements = null; let groupReplacement = null;
  const simulation = { schemaVersion: 1, kind: 'workflow-authoring-lifecycle-simulation',
    profile: WORKFLOW_LIFECYCLE_SIMULATION_PROFILE, status: 'incomplete', workflows: [],
    prerequisites: 'candidate-not-validated', execution: 'not-run', humanAvailability: 'not-verified', hostEnforcement: 'unavailable' };
  attempt('request', () => { requestShape(request); acceptedRequest = true; });
  const output = () => {
    const orderedFindings = findings.sort((a, b) => a.fieldPath.localeCompare(b.fieldPath, 'en') || a.code.localeCompare(b.code, 'en'));
    const emitted = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([file, content]) => ({ path: file, content, bytes: Buffer.byteLength(content), sha256: bytesDigest(Buffer.from(content)) }));
    const core = { schemaVersion: 1, kind: WCA_PREVIEW_KIND, compiler: WCA_COMPILER_PROFILE,
      source, approvedSource: context.source, approvedAssetPolicy: captured.assetPolicy,
      requestSchema: request.schema ?? null, requestSha256: digest(request),
      catalogChoices: workflowCompilerCatalogChoices(context),
      candidateAssetManifestSha256: digest(emitted.map(({ path: file, bytes, sha256 }) => ({ path: file, bytes, sha256 }))),
      catalogSha256: digest(locks), policySha256: digest({ approvalSecurity: captured.definition.approvalSecurity, sequenceGates: captured.definition.sequenceGates, codeDelivery: captured.definition.codeDelivery ?? null, environmentSha256: captured.environmentSha256, assetPolicy: captured.assetPolicy }),
      dependencyLocks: locks, graph, skillProposals, simulation, workflowChanges,
      ...(sharedObjectChanges ? { sharedObjectChanges } : {}), findings: orderedFindings, fileOperations: operations, assets: emitted,
      permissions: { effective: 'pre-change-approved-policy-only', addedOperations: [], removedOperations: [], newNativeTools: [], enforcement: 'not-verified' },
      candidateDefinition: candidate, candidateDefinitionSha256: digest(candidate),
      readiness: { authoring: findings.length ? findings.every((finding) => finding.category === 'capability-unavailable') ? 'unavailable' : 'invalid' : 'valid', simulation: simulation.status, behavior: 'not-evaluated', host: 'discovery-unverified', publication: 'not-proposed', activation: 'inactive', confirmation: 'absent', execution: 'not-run' },
      coverage: { schema: acceptedRequest ? 'checked' : 'invalid', references: 'selected-closure', policy: 'pre-change-approved-source', graph: 'ordered-input-and-registered-rework-validation', simulation: simulation.status, simulationProfile: simulation.profile, hostEnforcement: 'unavailable', behavior: 'not-evaluated', sharedConsumerImpact: 'configuration-only' },
      effects: { configurationWritten: false, proposalCreated: false, approvalGranted: false, activated: false, executed: false },
      nextAction: findings.length ? { operation: 'workflow.author.edit', legalEffect: 'edit-inert-draft' } : { operation: 'workflow.author.review', legalEffect: 'needs-separate-exact-human-confirmation', available: false } };
    let prepared = null; let finalizationRecord = null;
    if (skillEntries.length && (finalized || findings.every((finding) => finding.code === 'WCA_SKP_CONFIRMATION_BINDING_PENDING'))) {
      if (finalized && !findings.length) {
        finalizationRecord = sealWorkflowSkillFinalization(finalization.projection, JSON.parse(canonicalJson({
          definition: candidate,
          files: emitted.map(({ path: file, content, bytes, sha256 }) => ({ path: file, mode: '100644', bytes, sha256, contentBase64: Buffer.from(content).toString('base64') }))
        })));
      } else if (!finalized) {
        try {
          prepared = prepareWorkflowSkillConsent(JSON.parse(canonicalJson({ source, approvedSource: context.source,
            request, snapshotInputs: { request, assets: draft.assets.map((asset) => ({ path: asset.path,
              bytes: asset.content.length, sha256: bytesDigest(asset.content), contentBase64: asset.content.toString('base64') })) },
            candidateDefinition: { ...candidate, version: 3 }, pendingFiles: pendingSkillFiles,
            entries: skillEntries, dependencyLocks: locks, policySha256: core.policySha256,
            ...(phaseReplacements ? { phaseReplacements, approvedWorkflow: { path: 'singularity/workflow.yml',
              bytes: captured.exactFiles.get('singularity/workflow.yml').length,
              sha256: bytesDigest(captured.exactFiles.get('singularity/workflow.yml')),
              contentBase64: captured.exactFiles.get('singularity/workflow.yml').toString('base64') } } : {}),
            ...(groupReplacement ? { groupReplacement, approvedWorkflow: { path: 'singularity/workflow.yml',
              bytes: captured.exactFiles.get('singularity/workflow.yml').length,
              sha256: bytesDigest(captured.exactFiles.get('singularity/workflow.yml')),
              contentBase64: captured.exactFiles.get('singularity/workflow.yml').toString('base64') } } : {}) })));
        } catch (error) {
          core.findings.push({ code: error.code ?? 'WCA_SKP_FINALIZATION_INVALID', fieldPath: 'skillFinalization', message: error.message,
            category: 'submission-blocker', requiredFor: 'package-preview', sourceRule: WCA_COMPILER_PROFILE, resolvingAction: 'workflow.author.edit' });
          core.readiness.authoring = 'invalid';
        }
      }
    }
    if (prepared) core.skillFinalization = { status: prepared.finalization, subject: prepared.subject,
      review: workflowSkillFinalizationReview(prepared), approval: 'not-granted', activation: 'inactive', execution: 'not-started' };
    if (prepared?.finalization === 'requires-exact-terminal-consent') {
      core.readiness.authoring = 'review-required';
      core.nextAction = { operation: 'workflow.author.submit', legalEffect: 'needs-separate-exact-human-terminal-review', available: true };
      for (const finding of core.findings) if (finding.code === 'WCA_SKP_CONFIRMATION_BINDING_PENDING') {
        finding.resolvingAction = 'workflow.author.submit';
      }
    }
    if (finalizationRecord) {
      core.skillFinalization = { status: 'finalized-inactive-proposal', subject: finalization.prepared.subject,
        record: finalizationRecord, approval: 'not-granted', activation: 'inactive', execution: 'not-started' };
      core.readiness.confirmation = 'consumed-terminal-local';
      core.nextAction = { operation: 'workflow.author.review', legalEffect: 'requires-separate-configuration-review', available: false };
    }
    const preview = freeze(JSON.parse(canonicalJson({ ...core, planSha256: digest(core) })));
    PREVIEWS.set(preview, { context, source, prepared, finalization: finalizationRecord ? finalization : null }); return preview;
  };
  let pendingSkillFiles = [];
  if (!acceptedRequest) return output();
  if (source.lifecycle !== 'live') add('WCA_DRAFT_DELETED', 'source.lifecycle', 'Deleted retained revisions cannot create a current submission plan.');
  if (request.baseRevision !== captured.baseRevision) add('WCA_BASE_REVISION_STALE', 'baseRevision', 'The request must explicitly bind this exact approved configuration base commit.');
  const sharedPhaseRequest = request.intent === 'edit'
    && request.changes?.some((change) => change?.profile === WCA_SHARED_PHASE_CHANGES_PROFILE);
  const contentProfile = request.intent === 'edit' ? request.changes?.find((change) =>
    [WCA_SHARED_AGENT_CHANGES_PROFILE, WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE, WCA_SHARED_TEMPLATE_CHANGES_PROFILE].includes(change?.profile))?.profile : null;
  const singleSkillContractRequest = request.intent === 'edit' && request.changes?.some((change) => change?.profile === WCA_SHARED_SKILL_CONTRACT_CHANGES_PROFILE);
  const groupSkillContractRequest = request.intent === 'edit' && request.changes?.some((change) => change?.profile === WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE);
  const skillContractRequest = singleSkillContractRequest || groupSkillContractRequest;
  const skillContractGroupPlanRequest = request.intent === 'edit' && request.changes?.some((change) =>
    change?.profile === WCA_SHARED_SKILL_CONTRACT_GROUP_PLAN_PROFILE);
  if (skillContractGroupPlanRequest) {
    attempt('changes', () => {
      assertExactReplacementCapture(captured);
      const changes = request.changes; const patches = request.definitions?.phases;
      if (!Array.isArray(changes) || changes.length < 2 || changes.length > 16
          || !Array.isArray(patches) || patches.length !== changes.length
          || changes.some((change) => change?.profile !== WCA_SHARED_SKILL_CONTRACT_GROUP_PLAN_PROFILE)
          || GROUPS.filter((group) => group !== 'phases').some((group) => request.definitions?.[group]?.length)
          || Object.keys(request.bindings ?? {}).length || request.assets?.length || draft.assets.length
          || request.executionProposals?.length || request.target.hosts?.length) {
        fail('Multi-skill impact preview needs two to sixteen exactly paired phase declarations without other changes, assets, hosts or executable proposals.',
          'WCA_SHARED_SKILL_CONTRACT_GROUP_INVALID');
      }
      const declarations = new Map();
      for (const patch of patches) {
        if (!plain(patch) || declarations.has(patch.id)) fail('Multi-skill phase declarations must have distinct exact IDs.', 'WCA_SHARED_SKILL_CONTRACT_GROUP_INVALID');
        declarations.set(patch.id, patch);
      }
      const catalogs = {};
      const selections = changes.map((change) => {
        closed(change, ['profile', 'kind', 'id', 'operation', 'expectedDefinitionSha256'], 'Multi-skill impact change');
        if (!declarations.has(change.id) || Object.hasOwn(catalogs, change.id)) {
          fail('Every selected skill must have one matching phase declaration and change row.', 'WCA_SHARED_SKILL_CONTRACT_GROUP_INVALID');
        }
        catalogs[change.id] = sharedSkillContractCatalog(captured.rawDefinition, change.id);
        const { profile, ...row } = change;
        return { ...row, replacement: declarations.get(change.id) };
      });
      const agentImpactCatalog = captured.agents.map(({ id, scope, source, text, phases, defaultFor, tools, worldModelViews, dependencies }) => ({
        id, scope, source: scope === 'repository' ? source : `${scope}/${id}.agent.md`, text,
        phases: phases ?? [], defaultFor: defaultFor ?? [], tools: tools ?? [], worldModelViews: worldModelViews ?? [],
        dependencies: dependencies ?? [] }));
      sharedObjectChanges = planSharedSkillContractGroupChanges({ approvedDefinition: captured.rawDefinition,
        agents: agentImpactCatalog, changes: selections, catalogs });
    });
    for (const finding of sharedObjectChanges?.findings ?? []) add(finding.code, finding.fieldPath ?? 'changes', finding.message);
    if (sharedObjectChanges?.status === 'ready-for-impact-review') {
      add('WCA_SHARED_SKILL_CONTRACT_GROUP_OWNER_UNAVAILABLE', 'changes',
        'The complete multi-skill impact is available for review; grouped consent, finalization and emission require a separate versioned owner.');
    }
    return output();
  }
  if (sharedPhaseRequest) {
    attempt('changes', () => {
      const patches = request.definitions?.phases;
      if (!Array.isArray(patches) || !patches.length || patches.length > WCA_COMPILER_LIMITS.objects) fail('Shared phase changes need bounded complete paired phase replacements.');
      for (const group of GROUPS.filter((name) => name !== 'phases')) if ((request.definitions?.[group] ?? []).length) {
        fail('Shared phase review cannot mix workflow, agent, skill or template object updates.', 'WCA_SHARED_PHASE_UNSUPPORTED');
      }
      if (Object.keys(request.bindings ?? {}).length || request.assets?.length || draft.assets.length || request.executionProposals?.length) {
        fail('Shared phase review cannot attach resources, binding aliases or executable proposals.', 'WCA_SHARED_PHASE_UNSUPPORTED');
      }
      const byId = new Map();
      for (const patch of patches) {
        closed(patch, ['id', 'replacement'], 'Shared phase definition'); const key = id(patch.id, 'Shared phase ID');
        if (byId.has(key)) fail('Shared phase patches repeat an identity.', 'WCA_OBJECT_COLLISION');
        byId.set(key, patch.replacement);
      }
      const changes = request.changes.map((change) => {
        closed(change, ['profile', 'kind', 'id', 'operation', 'expectedDefinitionSha256'], 'Shared phase change');
        if (change.profile !== WCA_SHARED_PHASE_CHANGES_PROFILE || !byId.has(change.id)) fail('Every shared phase change needs its exact profile and paired replacement.');
        const { profile, ...row } = change; return { ...row, replacement: byId.get(change.id) };
      });
      if (changes.length !== byId.size) fail('Every shared phase replacement needs one explicit matching change.');
      sharedObjectChanges = planSharedPhaseChanges({ approvedDefinition: captured.rawDefinition,
        agents: captured.agents.map(({ id: key, scope, text: body, phases, defaultFor, tools, worldModelViews, dependencies }) => ({
          id: key, scope, text: body, phases: phases ?? [], defaultFor: defaultFor ?? [], tools: tools ?? [],
          worldModelViews: worldModelViews ?? [], dependencies: dependencies ?? [] })), changes });
    });
    for (const finding of sharedObjectChanges?.findings ?? []) add(finding.code, finding.fieldPath ?? 'changes', finding.message);
    if (findings.length || sharedObjectChanges?.status !== 'ready-for-review') return output();
    const affected = sharedObjectChanges.impact.affectedWorkflows;
    if (!affected.length || affected.length > WCA_COMPILER_LIMITS.sharedAffectedWorkflows) {
      add('WCA_COMPILER_LIMIT', 'changes', 'Shared phase preview needs between one and 64 complete affected workflow simulations; no consumers were omitted.');
      return output();
    }
    for (const replacement of sharedObjectChanges.replacements) candidate.phases[replacement.id] = structuredClone(replacement.definition);
    for (const workflow of affected) symbols.workflows.set(workflow.id, { id: workflow.id });
    for (const lock of sharedObjectChanges.dependencyLocks) locks.push({ source: lock.kind === 'execution-task'
      ? 'installed-runtime-registry' : lock.source === 'installed-agent-registry' ? 'installed-agent-registry' : 'approved-catalog',
      kind: lock.kind, id: lock.id, definitionSha256: lock.definitionSha256, baseRevision: captured.baseRevision });
  } else if (contentProfile) {
    attempt('changes', () => {
      assertExactReplacementCapture(captured);
      const group = [WCA_SHARED_AGENT_CHANGES_PROFILE, WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE].includes(contentProfile) ? 'agents' : 'templates';
      const patches = request.definitions?.[group];
      if (!Array.isArray(patches) || !patches.length || patches.length > WCA_COMPILER_LIMITS.objects) fail('Shared text changes need bounded complete paired replacements.');
      for (const other of GROUPS.filter((name) => name !== group)) if ((request.definitions?.[other] ?? []).length) fail('Shared text profiles cannot mix object kinds or create new configuration objects.', 'WCA_SHARED_CONTENT_UNSUPPORTED');
      if (Object.keys(request.bindings ?? {}).length || request.assets?.length || draft.assets.length || request.executionProposals?.length) fail('Shared text profiles cannot attach resources, binding aliases or executable proposals.', 'WCA_SHARED_CONTENT_UNSUPPORTED');
      const byId = new Map();
      for (const patch of patches) {
        closed(patch, group === 'agents' ? ['id', 'text'] : ['id', 'content', 'definition'], 'Shared text definition');
        if (typeof patch.id !== 'string' || byId.has(patch.id)) fail('Shared text patches need unique exact identities.', 'WCA_OBJECT_COLLISION');
        const { id: key, ...replacement } = patch; byId.set(key, replacement);
      }
      const changes = request.changes.map((change) => {
        closed(change, group === 'agents' ? ['profile', 'kind', 'id', 'operation', 'expectedTextSha256']
          : ['profile', 'kind', 'id', 'operation', 'expectedDefinitionSha256', 'expectedContentSha256'], 'Shared text change');
        if (change.profile !== contentProfile || !byId.has(change.id)) fail('Every shared text change needs one exact matching profile and replacement.');
        const { profile, ...row } = change; return { ...row, replacement: byId.get(change.id) };
      });
      if (changes.length !== byId.size) fail('Every shared text replacement needs one explicit matching change.');
      const templateContents = [...captured.exactFiles].filter(([relative]) => relative.startsWith(`${candidate.templatesRoot}/`)).map(([path, bytes]) => {
        const content = bytes.toString('utf8'); if (!Buffer.from(content).equals(bytes)) fail('Exact text replacement cannot reinterpret binary captured content.', 'WCA_CONTENT_UNRESOLVED');
        return { path, content };
      });
      const input = { approvedDefinition: captured.rawDefinition, agents: captured.agents.map(({ id, scope, source, text, phases, defaultFor, tools, worldModelViews, dependencies }) => ({
        id, scope, source, text, phases: phases ?? [], defaultFor: defaultFor ?? [], tools: tools ?? [], worldModelViews: worldModelViews ?? [], dependencies: dependencies ?? [] })), templateContents, changes };
      sharedObjectChanges = group === 'agents' ? contentProfile === WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE
        ? planSharedAgentMetadataChanges(input) : planSharedAgentChanges(input) : planSharedTemplateChanges(input);
    });
    for (const finding of sharedObjectChanges?.findings ?? []) add(finding.code, finding.fieldPath ?? 'changes', finding.message);
    if (findings.length || sharedObjectChanges?.status !== 'ready-for-review') return output();
    const affected = sharedObjectChanges.impact.affectedWorkflows;
    if (!affected.length || affected.length > WCA_COMPILER_LIMITS.sharedAffectedWorkflows) {
      add('WCA_COMPILER_LIMIT', 'changes', 'Shared text preview needs between one and 64 complete affected workflow simulations; no consumers were omitted.'); return output();
    }
    for (const replacement of sharedObjectChanges.replacements) {
      if (replacement.kind === 'agent') {
        const index = agents.findIndex((agent) => agent.id === replacement.id);
        agents[index] = { ...agents[index], ...parseAgentDependencies(replacement.text, { source: replacement.path, agentId: replacement.id }), text: replacement.text };
      } else if (replacement.catalogId) candidate.templates[replacement.catalogId] = replacement.definition;
      replacementFiles.set(replacement.path, replacement.text ?? replacement.content);
    }
    for (const workflow of affected) symbols.workflows.set(workflow.id, { id: workflow.id });
    for (const lock of sharedObjectChanges.dependencyLocks) locks.push({ source: lock.kind === 'execution-task'
      ? 'installed-runtime-registry' : lock.source === 'installed-agent-registry' ? 'installed-agent-registry' : 'approved-catalog',
      kind: lock.kind, id: lock.id, definitionSha256: lock.definitionSha256, baseRevision: captured.baseRevision });
  } else if (groupSkillContractRequest) {
    attempt('changes', () => {
      assertExactReplacementCapture(captured);
      const changes = request.changes; const declarations = request.definitions?.phases;
      if (!Array.isArray(changes) || changes.length < 2 || changes.length > 16
          || !Array.isArray(declarations) || declarations.length !== changes.length
          || changes.some((change) => change?.profile !== WCA_SHARED_SKILL_CONTRACT_GROUP_REVIEW_PROFILE)
          || GROUPS.filter((group) => group !== 'phases').some((group) => request.definitions?.[group]?.length)
          || Object.keys(request.bindings ?? {}).length || request.assets?.length || draft.assets.length
          || request.executionProposals?.length || request.target.hosts?.length) {
        fail('Grouped skill review needs two to sixteen exactly paired phase declarations without mixed objects, attachments, hosts or executable proposals.',
          'WCA_SHARED_SKILL_CONTRACT_GROUP_INVALID');
      }
      const byId = new Map();
      for (const declaration of declarations) {
        if (!plain(declaration) || byId.has(declaration.id)) fail('Grouped skill declarations must have distinct exact IDs.', 'WCA_SHARED_SKILL_CONTRACT_GROUP_INVALID');
        byId.set(declaration.id, declaration);
      }
      const catalogs = {}; const selectedPackages = new Map();
      const selections = changes.map((change) => {
        closed(change, ['profile', 'kind', 'id', 'operation', 'expectedDefinitionSha256'], 'Grouped skill contract change');
        if (!byId.has(change.id) || Object.hasOwn(catalogs, change.id)) {
          fail('Every grouped skill change requires one exact paired declaration.', 'WCA_SHARED_SKILL_CONTRACT_GROUP_INVALID');
        }
        const sourcePhase = captured.rawDefinition.phases?.[change.id];
        const selected = sourcePhase?.skillBinding?.bindingRefs?.skill;
        if (sourcePhase?.kind !== 'skill' || !selected) fail('Select existing confirmed skill phases only.', 'WCA_SHARED_SKILL_CONTRACT_UNSUPPORTED');
        const retainedPackage = draft.retainedPackages.get(selected.id);
        if (!retainedPackage) fail('An exact retained approved package is unavailable; no live folder fallback is allowed.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
        const inspected = readSealedSkillPackage(retainedPackage);
        if (inspected.manifest.packageSha256 !== selected.packageSha256) fail('A grouped package changed from its confirmed binding.', 'SKP_SKILL_DRIFT');
        selectedPackages.set(change.id, inspected);
        const prefix = `singularity/skills/${selected.id}/`;
        for (const [relative, bytes] of inspected.contents) {
          if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('The grouped text proposal cannot reinterpret binary retained packages.', 'WCA_SHARED_SKILL_CONTRACT_PACKAGE_UNSUPPORTED');
          const path = `${prefix}${relative}`; const content = bytes.toString('utf8');
          if (replacementFiles.has(path) && replacementFiles.get(path) !== content) fail('Grouped phases disagree on package bytes.', 'WCA_SHARED_SKILL_CONTRACT_PACKAGE_UNSUPPORTED');
          replacementFiles.set(path, content);
        }
        catalogs[change.id] = sharedSkillContractCatalog(captured.rawDefinition, change.id);
        const { profile, ...row } = change;
        return { ...row, replacement: byId.get(change.id) };
      });
      const agentImpactCatalog = captured.agents.map(({ id, scope, source, text, phases, defaultFor, tools, worldModelViews, dependencies }) => ({
        id, scope, source: scope === 'repository' ? source : `${scope}/${id}.agent.md`, text,
        phases: phases ?? [], defaultFor: defaultFor ?? [], tools: tools ?? [], worldModelViews: worldModelViews ?? [],
        dependencies: dependencies ?? [] }));
      sharedObjectChanges = planSharedSkillContractGroupChanges({ approvedDefinition: captured.rawDefinition,
        agents: agentImpactCatalog, changes: selections, catalogs });
      if (sharedObjectChanges.status !== 'ready-for-impact-review') return;
      for (const lock of sharedObjectChanges.dependencyLocks) locks.push({ source: lock.kind === 'execution-task'
        ? 'installed-runtime-registry' : lock.source === 'installed-agent-registry' ? 'installed-agent-registry' : 'approved-catalog',
      kind: lock.kind, id: lock.id, definitionSha256: lock.kind === 'agent'
        ? digest({ id: lock.id, scope: captured.agents.find((agent) => agent.id === lock.id).scope,
          textSha256: bytesDigest(Buffer.from(captured.agents.find((agent) => agent.id === lock.id).text)) }) : lock.definitionSha256,
      baseRevision: captured.baseRevision });
      groupReplacement = { phaseReplacements: sharedObjectChanges.replacements.map((replacement) => ({
        phaseId: replacement.id, beforeDefinitionSha256: replacement.beforeDefinitionSha256,
        beforeDefinition: replacement.beforeDefinition, catalog: catalogs[replacement.id] })),
      consumerImpactSha256: digest(sharedObjectChanges),
      affectedWorkflowIds: sharedObjectChanges.impact.affectedWorkflows.map((workflow) => workflow.id), agentImpactCatalog };
      for (const key of Object.keys(candidate)) delete candidate[key]; Object.assign(candidate, structuredClone(captured.rawDefinition));
      for (const replacement of sharedObjectChanges.replacements) {
        const exactAgent = captured.agents.find((agent) => agent.defaultFor.includes(replacement.id));
        if (!exactAgent) fail('An exact approved default producer is unavailable.', 'WCA_SHARED_SKILL_CONTRACT_AGENT_UNAVAILABLE');
        delete candidate.phases[replacement.id];
        skillEntries.push({ phase: replacement.phase, catalog: catalogs[replacement.id], phaseOrder: replacement.phaseOrder,
          agent: { id: exactAgent.id, scope: exactAgent.scope, text: exactAgent.text },
          packageManifest: selectedPackages.get(replacement.id).manifest });
        if (finalizedPhases.has(replacement.id)) candidate.phases[replacement.id] = structuredClone(finalizedPhases.get(replacement.id));
        else { skillProposals.push(replacement.proposal); add('WCA_SKP_CONFIRMATION_BINDING_PENDING', `definitions.phases.${replacement.id}`,
          'The grouped skill contract needs one fresh terminal review to compile all selected bindings and simulate every affected workflow.'); }
      }
    });
    for (const finding of sharedObjectChanges?.findings ?? []) add(finding.code, finding.fieldPath ?? 'changes', finding.message);
    if (findings.some((finding) => finding.code !== 'WCA_SKP_CONFIRMATION_BINDING_PENDING')
        || sharedObjectChanges?.status !== 'ready-for-impact-review') return output();
    const affected = sharedObjectChanges.impact.affectedWorkflows;
    if (!affected.length || affected.length > WCA_COMPILER_LIMITS.sharedAffectedWorkflows) {
      add('WCA_COMPILER_LIMIT', 'changes', 'Grouped review requires all affected workflow simulations within the 64-workflow budget.'); return output();
    }
    for (const workflow of affected) symbols.workflows.set(workflow.id, { id: workflow.id });
  } else if (skillContractRequest) {
    attempt('changes', () => {
      assertExactReplacementCapture(captured);
      if (request.changes.length !== 1 || request.definitions?.phases?.length !== 1
          || GROUPS.filter((group) => group !== 'phases').some((group) => request.definitions?.[group]?.length)
          || Object.keys(request.bindings ?? {}).length || request.assets?.length || draft.assets.length
          || request.executionProposals?.length || request.target.hosts?.length) {
        fail('Skill contract review selects one existing phase without mixed objects, attachments, hosts or executable proposals.', 'WCA_SHARED_SKILL_CONTRACT_UNSUPPORTED');
      }
      const change = request.changes[0];
      closed(change, ['profile', 'kind', 'id', 'operation', 'expectedDefinitionSha256'], 'Shared skill contract change');
      if (change.profile !== WCA_SHARED_SKILL_CONTRACT_CHANGES_PROFILE || change.id !== request.definitions.phases[0].id) fail('Pair the exact contract profile and existing phase declaration.');
      const sourcePhase = captured.rawDefinition.phases[change.id]; const selected = sourcePhase?.skillBinding?.bindingRefs?.skill;
      if (sourcePhase?.kind !== 'skill' || !selected) fail('Select one exact existing confirmed skill phase.', 'WCA_SHARED_SKILL_CONTRACT_UNSUPPORTED');
      const prefix = `singularity/skills/${selected.id}/`;
      const retainedPackage = draft.retainedPackages.get(selected.id);
      if (!retainedPackage) fail('Exact approved retained package bytes are unavailable; no live folder fallback is allowed.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
      const inspected = readSealedSkillPackage(retainedPackage);
      const contents = inspected.contents;
      if (inspected.manifest.packageSha256 !== selected.packageSha256) fail('The exact approved skill package changed from its confirmed binding.', 'SKP_SKILL_DRIFT');
      for (const [relative, bytes] of contents) {
        if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('This text proposal dialect cannot replace or reinterpret binary retained packages.', 'WCA_SHARED_SKILL_CONTRACT_PACKAGE_UNSUPPORTED');
        replacementFiles.set(`${prefix}${relative}`, bytes.toString('utf8'));
      }
      const catalog = sharedSkillContractCatalog(captured.rawDefinition, change.id);
      const { profile, ...row } = change;
      const agentImpactCatalog = captured.agents.map(({ id, scope, source, text, phases, defaultFor, tools, worldModelViews, dependencies }) => ({
        id, scope, source: scope === 'repository' ? source : `${scope}/${id}.agent.md`, text, phases: phases ?? [], defaultFor: defaultFor ?? [],
        tools: tools ?? [], worldModelViews: worldModelViews ?? [], dependencies: dependencies ?? [] }));
      sharedObjectChanges = planSharedSkillContractChanges({ approvedDefinition: captured.rawDefinition,
        agents: agentImpactCatalog,
        changes: [{ ...row, replacement: request.definitions.phases[0] }], catalog });
      if (sharedObjectChanges.status !== 'ready-for-contract-review') return;
      const replacement = sharedObjectChanges.replacements[0];
      const exactAgent = captured.agents.find((agent) => agent.defaultFor.includes(replacement.id));
      for (const lock of sharedObjectChanges.dependencyLocks) locks.push({ source: lock.kind === 'execution-task'
        ? 'installed-runtime-registry' : lock.source === 'installed-agent-registry' ? 'installed-agent-registry' : 'approved-catalog',
        kind: lock.kind, id: lock.id, definitionSha256: lock.kind === 'agent'
          ? digest({ id: lock.id, scope: captured.agents.find((agent) => agent.id === lock.id).scope,
            textSha256: bytesDigest(Buffer.from(captured.agents.find((agent) => agent.id === lock.id).text)) }) : lock.definitionSha256,
        baseRevision: captured.baseRevision });
      phaseReplacements = [{ phaseId: replacement.id, beforeDefinitionSha256: replacement.beforeDefinitionSha256,
        beforeDefinition: replacement.beforeDefinition, catalog,
        consumerImpactSha256: digest(sharedObjectChanges), affectedWorkflowIds: sharedObjectChanges.impact.affectedWorkflows.map((workflow) => workflow.id), agentImpactCatalog }];
      for (const key of Object.keys(candidate)) delete candidate[key]; Object.assign(candidate, structuredClone(captured.rawDefinition));
      delete candidate.phases[replacement.id];
      skillEntries.push({ phase: replacement.phase, catalog, phaseOrder: replacement.phaseOrder,
        agent: { id: exactAgent.id, scope: exactAgent.scope, text: exactAgent.text }, packageManifest: inspected.manifest });
      if (finalizedPhases.has(replacement.id)) candidate.phases[replacement.id] = structuredClone(finalizedPhases.get(replacement.id));
      else { skillProposals.push(replacement.proposal); add('WCA_SKP_CONFIRMATION_BINDING_PENDING', `definitions.phases.${replacement.id}`,
        'The existing skill contract is lowered without its old binding. A fresh one-use terminal review must compile and simulate the exact replacement before inactive proposal emission.'); }
    });
    for (const finding of sharedObjectChanges?.findings ?? []) add(finding.code, finding.fieldPath ?? 'changes', finding.message);
    if (findings.some((finding) => finding.code !== 'WCA_SKP_CONFIRMATION_BINDING_PENDING') || sharedObjectChanges?.status !== 'ready-for-contract-review') return output();
    const affected = sharedObjectChanges.impact.affectedWorkflows;
    if (!affected.length || affected.length > WCA_COMPILER_LIMITS.sharedAffectedWorkflows) {
      add('WCA_COMPILER_LIMIT', 'changes', 'Skill contract review requires all affected workflow simulations within the 64-workflow budget.'); return output();
    }
    for (const workflow of affected) symbols.workflows.set(workflow.id, { id: workflow.id });
  } else if (request.intent !== 'create') {
    workflowChanges = planWorkflowOnlyChanges({ request, approvedDefinition: captured.rawDefinition,
      agents: captured.agents.map(({ id, scope, text, phases, defaultFor, tools, worldModelViews, dependencies }) => ({
        id, scope, text, phases: phases ?? [], defaultFor: defaultFor ?? [], tools: tools ?? [],
        worldModelViews: worldModelViews ?? [], dependencies: dependencies ?? [] })) });
    for (const finding of workflowChanges.findings) add(finding.code, finding.fieldPath ?? 'changes', finding.message);
    if (workflowChanges.status !== 'ready') return output();
    // The pure planner has no persistence capability. Its exact raw parent/dependency impact is
    // included in this preview hash; ordinary config validation and submission own all writes.
  } else if (request.changes?.length) add('WCA_CHANGE_OWNER_UNAVAILABLE', 'changes', 'Create requests cannot infer updates or deletion from explicit object changes. Select a supported workflow-only edit or linked fork.');
  if (request.executionProposals?.length) add('WCA_EXECUTION_PROPOSAL_UNADMITTED', 'executionProposals', 'Executable proposals remain inert and have no runtime admission owner.');
  if (request.target.hosts?.length) add('WCA_HOST_CONTRACT_UNAVAILABLE', 'target.hosts', 'No installed exact host/tool mapping contract has been verified by this compiler.');
  for (const group of GROUPS) attempt(`definitions.${group}`, () => {
    if (sharedObjectChanges && (sharedPhaseRequest && group === 'phases'
        || skillContractRequest && group === 'phases'
        || [WCA_SHARED_AGENT_CHANGES_PROFILE, WCA_SHARED_AGENT_METADATA_CHANGES_PROFILE].includes(contentProfile) && group === 'agents'
        || contentProfile === WCA_SHARED_TEMPLATE_CHANGES_PROFILE && group === 'templates')) return;
    const values = request.definitions?.[group] ?? [];
    if (!Array.isArray(values) || values.length > (group === 'workflows' ? WCA_COMPILER_LIMITS.workflows : WCA_COMPILER_LIMITS.objects)) fail('Candidate collection exceeds its bounded object budget.', 'WCA_COMPILER_LIMIT');
    for (const value of values) {
      if (!plain(value)) fail('Candidate definitions must be ordinary objects.');
      const key = id(value.id, `${group} ID`);
      if (symbols[group].has(key)) fail('Candidate definitions repeat an object ID.', 'WCA_OBJECT_COLLISION');
      const existing = group === 'workflows' ? candidate.workTypes[key] : group === 'phases' ? candidate.phases[key] : group === 'templates' ? candidate.templates?.[key] : group === 'agents' ? captured.agents.find((agent) => agent.id === key) : group === 'skills' ? captured.skills.has(key) : null;
      const selectedEdit = group === 'workflows' && workflowChanges?.replacements.some((row) => row.id === key && row.operation === 'edit');
      if (existing && !selectedEdit || key.startsWith('sf-') || key.startsWith('sflow-')) fail('Candidate definitions cannot shadow approved or privileged installed objects.', 'WCA_OBJECT_COLLISION');
      symbols[group].set(key, value);
    }
  });
  if (findings.some((finding) => finding.code === 'WCA_OBJECT_COLLISION')) return output();
  const bindings = new Map();
  const { catalogs, ambiguousChecks } = compilerCatalogs(captured);
  const pin = (kind, key, value) => {
    // Host discovery paths include disposable approved-read roots. Only exact bytes and stable
    // identities belong to a dependency lock, never a machine path or temporary directory.
    const identity = kind === 'agent' ? { id: value.id, scope: value.scope, textSha256: bytesDigest(Buffer.from(value.text)) } : value;
    if (kind === 'template' && !captured.files.has(`${candidate.templatesRoot}/${value.path}`)) fail('The approved template bytes are missing.', 'WCA_CONTENT_UNRESOLVED');
    const origin = kind === 'execution-task' ? 'installed-runtime-registry' : kind === 'agent' && value.scope !== 'repository' ? 'installed-agent-registry' : 'approved-catalog';
    const entry = { source: origin, kind, id: key, definitionSha256: digest(identity), baseRevision: captured.baseRevision };
    if (!locks.some((item) => item.kind === kind && item.id === key)) locks.push(entry);
    return { ...value, id: key };
  };
  const resolve = (raw, kind, fieldPath) => {
    let reference = raw;
    if (typeof raw === 'string') {
      const candidateGroup = GROUPS.find((group) => KINDS[group] === kind);
      const proposed = candidateGroup && symbols[candidateGroup].get(raw); const existing = catalogs[kind]?.[raw];
      if (proposed && existing) fail('A shorthand reference is ambiguous.', 'WCA_REFERENCE_AMBIGUOUS');
      reference = { source: proposed ? 'candidate' : 'catalog', kind, id: raw };
    }
    if (plain(reference) && Object.keys(reference).length === 1 && plain(reference.ref)) reference = reference.ref;
    closed(reference, ['source', 'kind', 'id'], fieldPath);
    if (reference.kind !== kind || !['candidate', 'catalog'].includes(reference.source)) fail('Reference source and kind must be explicit and supported.');
    if (reference.source === 'candidate') {
      id(reference.id, fieldPath);
      const group = GROUPS.find((value) => KINDS[value] === kind); const value = group && symbols[group].get(reference.id);
      if (!value) fail('Candidate reference has no same-package definition.', 'WCA_REFERENCE_MISSING'); return value;
    }
    text(reference.id, 'Catalog reference ID', 512);
    const value = Object.hasOwn(catalogs[kind] ?? {}, reference.id) ? catalogs[kind][reference.id] : null;
    if (!value || kind === 'quality-command' && ambiguousChecks.has(reference.id)) fail('Approved catalog reference is absent or ambiguous.', 'WCA_REFERENCE_MISSING');
    return pin(kind, reference.id, value);
  };
  for (const [key, raw] of Object.entries(request.bindings ?? {})) attempt(`bindings.${key}`, () => {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(key)) fail('Binding aliases must be bounded identifiers.');
    const reference = { source: 'catalog', ...(plain(raw) && Object.keys(raw).length === 1 && plain(raw.ref) ? raw.ref : raw) };
    if (reference.source !== 'catalog') fail('Binding aliases may select only exact existing catalog entries; candidate definitions use explicit candidate references.', 'WCA_CATALOG_REFERENCE_INVALID');
    if (!['execution-task', 'quality-command', 'approval-authority', 'phase', 'template', 'agent', 'workflow'].includes(reference.kind)) fail('This approved operation or host catalog has no installed resolution owner.', 'WCA_CATALOG_UNAVAILABLE');
    bindings.set(key, { kind: reference.kind, value: resolve(reference, reference.kind, `bindings.${key}`) });
  });
  const bound = (key, kind) => {
    const value = bindings.get(key); if (!value || value.kind !== kind) fail('Binding is missing or has a different approved kind.', 'WCA_REFERENCE_MISSING'); return value.value;
  };
  const assets = new Map(); const usedAssets = new Set(); let totalAssetBytes = 0;
  const addAsset = (logical, bytes) => {
    portable(logical, 'Asset path'); const folded = logical.normalize('NFC').toLowerCase();
    if ([...assets.keys()].some((value) => value.normalize('NFC').toLowerCase() === folded)) fail('Assets collide on a supported filesystem.', 'WCA_ASSET_COLLISION');
    totalAssetBytes += bytes.length;
    if (assets.size >= WCA_COMPILER_LIMITS.assets || totalAssetBytes > WCA_COMPILER_LIMITS.assetBytes) fail('Candidate asset closure exceeds its budget.', 'WCA_COMPILER_LIMIT');
    admit([{ path: logical, content: bytes.toString('utf8'), forceScan: true }]); assets.set(logical, Buffer.from(bytes));
  };
  attempt('assets', () => {
    for (const asset of draft.assets) addAsset(asset.path, asset.content);
    if (request.assets !== undefined && !Array.isArray(request.assets)) fail('Assets must be a literal bounded array.');
    for (const asset of request.assets ?? []) {
      closed(asset, ['path', 'mediaType', 'content'], 'Request asset');
      if (asset.mediaType !== undefined) text(asset.mediaType, 'Asset media type', 256);
      text(asset.content, 'Asset content', WCA_COMPILER_LIMITS.assetBytes); addAsset(asset.path, Buffer.from(asset.content));
    }
  });
  const body = (value, inline, assetField, label) => {
    if (Object.hasOwn(value, inline) === Object.hasOwn(value, assetField)) fail('Choose exactly one literal inline body or captured asset.', 'WCA_CONTENT_UNRESOLVED');
    if (Object.hasOwn(value, inline)) return text(value[inline], label);
    const logical = portable(value[assetField], label); const bytes = assets.get(logical);
    if (!bytes || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('Selected content asset is absent or not exact UTF-8.', 'WCA_CONTENT_UNRESOLVED');
    usedAssets.add(logical);
    return text(bytes.toString('utf8'), label);
  };
  const emit = (relative, content) => {
    portable(relative, 'Managed output path');
    if (matchEnvironmentLocalPath(captured.environmentDeclaration, relative)) fail('Approved environment-local paths cannot become shared candidate assets.', 'WCA_ENVIRONMENT_LOCAL_CONTENT_UNADMITTED');
    if ([...files.keys()].some((key) => key.normalize('NFC').toLowerCase() === relative.normalize('NFC').toLowerCase())) fail('Managed output paths collide.', 'WCA_ASSET_COLLISION');
    const skillPath = skillContractRequest ? /^singularity\/skills\/([^/]+)\/(.+)$/u.exec(relative) : null;
    const before = captured.files.get(relative) ?? (skillPath ? draft.retainedPackages.get(skillPath[1])?.contents.get(skillPath[2]) : null);
    if (before && relative !== 'singularity/workflow.yml'
        && (!replacementFiles.has(relative) || replacementFiles.get(relative) !== content)) fail('Managed output already exists; explicit reviewed update is required.', 'WCA_OBJECT_COLLISION');
    admit([{ path: relative, content, forceScan: true }]); files.set(relative, content);
    operations.push({ path: relative, action: before ? 'update' : 'create', beforeSha256: before ? bytesDigest(before) : null, afterSha256: bytesDigest(Buffer.from(content)) });
  };
  for (const [key, value] of symbols.templates) attempt(`definitions.templates.${key}`, () => {
    closed(value, ['id', 'label', 'description', 'kind', 'content', 'contentAsset'], 'Template definition');
    if (value.label !== undefined) text(value.label, 'Template label', 512);
    if (value.description !== undefined && typeof value.description !== 'string') fail('Template description must be literal text.');
    const content = body(value, 'content', 'contentAsset', 'Template body');
    const relative = `${request.id}/${key}.md`; candidate.templates ??= {};
    candidate.templates[key] = { path: relative, label: value.label ?? key, ...(value.kind ? { kind: value.kind } : {}) };
    emit(`${candidate.templatesRoot}/${relative}`, content);
  });
  const skillPackages = new Map();
  for (const [key, value] of symbols.skills) attempt(`definitions.skills.${key}`, () => {
    closed(value, ['id', 'description', 'instructions', 'instructionsAsset', 'operationBindings', 'qualityBindings', 'resources', 'producerClassification'], 'Skill definition');
    if (value.producerClassification !== undefined) {
      closed(value.producerClassification, ['profile', 'eligibility'], 'Requested producer classification');
      if (value.producerClassification.profile !== WCA_SKP_LOCAL_PRODUCER_PROFILE
          || value.producerClassification.eligibility !== 'candidate-producer') fail('Select the explicit artifact-only local review classification; it is not approved eligibility.', 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE');
    }
    text(value.description, 'Skill description', 1024); const instructions = body(value, 'instructions', 'instructionsAsset', 'Skill instructions');
    if (!Array.isArray(value.operationBindings) || value.operationBindings.length) fail('New skill operations require an approved runtime mapping owner; no implicit native tool grant is emitted.', 'WCA_OPERATION_MAPPING_UNAVAILABLE');
    for (const binding of optionalArray(value.qualityBindings, 'Skill quality bindings')) bound(binding, 'quality-command');
    const contents = new Map([['SKILL.md', Buffer.from(`---\n${YAML.stringify({ name: key, description: value.description })}---\n${instructions}\n`)]]);
    if (!Array.isArray(value.resources ?? [])) fail('Skill resources must be literal selected assets.');
    for (const resource of value.resources ?? []) {
      closed(resource, ['path', 'asset'], 'Skill resource'); const relative = portable(resource.path, 'Skill resource path');
      if (!relative.startsWith('references/')) fail('Only inert references are supported; scripts/hooks are unadmitted.', 'WCA_EXECUTION_PROPOSAL_UNADMITTED');
      const bytes = assets.get(portable(resource.asset, 'Skill resource asset')); if (!bytes) fail('Skill resource is unresolved.', 'WCA_CONTENT_UNRESOLVED');
      usedAssets.add(resource.asset);
      if (contents.has(relative)) fail('Skill resources repeat an output path.', 'WCA_ASSET_COLLISION');
      if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('The text emitter cannot replace binary resource bytes.', 'WCA_CONTENT_UNRESOLVED');
      contents.set(relative, bytes);
    }
    const inspected = inspectSkillPackageContents(key, contents); skillPackages.set(key, inspected);
    // Review/draft bytes must never enter native auto-discovery. Activation requires a separate
    // qualified host adapter; approved configuration and retained snapshots use this inert root.
    for (const [relative, bytes] of contents) emit(`singularity/skills/${key}/${relative}`, bytes.toString('utf8'));
  });
  for (const [key, value] of symbols.agents) attempt(`definitions.agents.${key}`, () => {
    closed(value, ['id', 'description', 'prompt', 'promptAsset', 'toolBindings', 'skillRefs'], 'Agent definition');
    text(value.description, 'Agent description', 1024); const prompt = body(value, 'prompt', 'promptAsset', 'Agent prompt');
    if (!Array.isArray(value.toolBindings) || value.toolBindings.length) fail('New agent tools require an approved effective-host mapping; no general shell or wildcard grant is emitted.', 'WCA_OPERATION_MAPPING_UNAVAILABLE');
    for (const skill of optionalArray(value.skillRefs, 'Agent skill references')) resolve(skill, 'skill', 'Agent skill reference');
    if (value.skillRefs?.length) add('WCA_SKILL_ASSIGNMENT_UNAVAILABLE', `definitions.agents.${key}.skillRefs`, 'The governed Agent Markdown owner has no admitted local skill-assignment renderer; references are not silently discarded.');
    const phases = [...symbols.phases.values()].filter((phase) => {
      const reference = typeof phase.agent === 'string' ? { source: 'candidate', kind: 'agent', id: phase.agent } : phase.agent?.ref ?? phase.agent;
      return reference?.source === 'candidate' && reference.kind === 'agent' && reference.id === key;
    }).map((phase) => phase.id);
    const reviewedSkillAgent = phases.some((phaseId) => symbols.phases.get(phaseId)?.kind === 'skill')
      ? renderWorkflowSkillCandidateAgent(JSON.parse(canonicalJson({ request,
        assets: draft.assets.map((asset) => ({ path: asset.path, bytes: asset.content.length,
          sha256: bytesDigest(asset.content), contentBase64: asset.content.toString('base64') })) })), key) : null;
    const sourcePath = reviewedSkillAgent?.path ?? `.github/agents/${request.id}-${key}.agent.md`;
    const content = reviewedSkillAgent?.text ?? `---\n${YAML.stringify({ name: key, description: value.description, tools: [], metadata: { 'sflow-phases': phases.join(','), 'sflow-default-for': phases.join(',') } })}---\n${prompt}\n`;
    const parsed = parseAgentDependencies(content, { source: sourcePath, agentId: key }); agents.push({ ...parsed, text: content, scope: 'repository' }); emit(sourcePath, content);
  });
  // Resolve ordinary candidate output contracts before compiling any SKP proposal. The package
  // declaration order is not execution order and must not hide earlier workflow producers.
  const phaseDefinitions = [...symbols.phases].sort(([, a], [, b]) => Number(a.kind === 'skill') - Number(b.kind === 'skill'));
  for (const [key, value] of phaseDefinitions) attempt(`definitions.phases.${key}`, () => {
    if (value.kind === 'skill') {
      closed(value, ['id', 'kind', 'label', 'skill', 'contract', 'agent'], 'Skill phase definition');
      const selectedAgent = value.agent === undefined ? null : resolve(value.agent, 'agent', 'Skill phase agent');
      closed(value.skill, ['id', 'packageSha256'], 'Selected candidate skill');
      const inspected = skillPackages.get(value.skill?.id);
      if (!inspected || value.skill.packageSha256 !== undefined && inspected.manifest.packageSha256 !== value.skill.packageSha256) fail('The selected new skill must bind its exact captured candidate package.', 'SKP_SKILL_DRIFT');
      const phaseId = (phase) => typeof phase === 'string' ? phase : (phase?.ref ?? phase)?.id;
      const orders = [...symbols.workflows.values()].filter((workflow) => workflow.phases?.some((phase) => phaseId(phase) === key));
      if (!orders.length || orders.some((workflow) => canonicalJson(workflow.phases) !== canonicalJson(orders[0].phases))) fail('New skill phase requires one exact unambiguous workflow order.', 'SKP_INPUT_ORDER');
      const phaseOrder = orders[0].phases.map(phaseId);
      const approvedOutputs = Object.fromEntries(Object.entries(candidate.phases).map(([phaseId, phase]) => [phaseId, { outputs: phase.kind === 'skill' ? phase.skillBinding.bindingRefs.outputs : [{ id: 'primary', path: phase.artifact.path }] }]));
      for (const [phaseId, phase] of symbols.phases) if (phase.contract?.produces) approvedOutputs[phaseId] = { outputs: phase.contract.produces.map((output) => ({ id: output.id, path: output.path })) };
      const checks = Object.fromEntries(Object.entries(catalogs['quality-command']).filter(([checkId]) => !ambiguousChecks.has(checkId)).map(([checkId, command]) => {
        // The structured SKP check owner distinguishes absence from a legacy shell command.
        // Normalization returns command:null for argv checks; remove only that absent union arm.
        const { command: shell, ...argvCommand } = command;
        return [checkId, shell === null && Array.isArray(command.argv) ? argvCommand : command];
      }));
      const catalog = { skillPackages: { [value.skill.id]: { packageSha256: inspected.manifest.packageSha256, eligibility: 'proposed-candidate-producer' } },
        phases: approvedOutputs, checks, approvalAuthorities: captured.definition.approvalAuthorities,
        approvalSecurity: captured.definition.approvalSecurity, artifactSets: captured.definition.artifactSets ?? {}, readPaths: [], sourceScopes: {}, codeDelivery: captured.definition.codeDelivery };
      // No confirmation, approved eligibility, effect scope or runtime binding is invented. The
      // proposed producer classification is visibly distinct and refused by confirmed lowering.
      const phase = { id: value.id, kind: value.kind, label: value.label, skill: { id: value.skill.id, packageSha256: inspected.manifest.packageSha256 }, contract: value.contract };
      const proposed = compileSkillPhaseProposal({ phase, catalog, phaseOrder });
      if (selectedAgent) {
        const exactAgent = agents.find((agent) => agent.id === selectedAgent.id);
        if (!exactAgent || !(exactAgent.defaultFor ?? []).includes(key)) add('WCA_AGENT_BINDING_UNAVAILABLE', `definitions.phases.${key}.agent`, 'The selected agent must have one exact existing or candidate default mapping for this phase.');
        else skillEntries.push({ phase, catalog, phaseOrder,
          agent: { id: exactAgent.id, scope: exactAgent.scope, text: exactAgent.text },
          packageManifest: inspected.manifest,
          ...(symbols.skills.get(value.skill.id)?.producerClassification ? {
            producerClassification: symbols.skills.get(value.skill.id).producerClassification } : {}) });
      } else if (symbols.skills.get(value.skill.id)?.producerClassification) add('WCA_AGENT_BINDING_UNAVAILABLE', `definitions.phases.${key}.agent`, 'Finalization requires one explicitly selected exact phase agent.');
      const configured = finalizedPhases.get(key);
      if (configured) {
        candidate.version = 3;
        candidate.phases[key] = structuredClone(configured);
        validateConfiguredSkillPhase(candidate.phases[key], key);
      } else {
        skillProposals.push(proposed);
        add('WCA_SKP_CONFIRMATION_BINDING_PENDING', `definitions.phases.${key}`, 'Contract policy is validated proposal-only. Explicit producer classification and a real one-use terminal review are required before inactive candidate configuration emission.');
      }
      return;
    }
    closed(value, ['id', 'label', 'artifact', 'inputs', 'template', 'agent', 'skills', 'taskBinding', 'approvalBinding', 'qualityBindings', 'writeScope', 'clarification'], 'Phase definition');
    text(value.label, 'Phase label', 512); if (!plain(value.artifact)) fail('New phases require an explicit concrete artifact contract.', 'WCA_ARTIFACT_UNRESOLVED');
    closed(value.artifact, ['path', 'kind', 'minimumBytes', 'maximumBytes', 'allowedExtensions', 'allowedMediaTypes', 'validation'], 'Artifact contract');
    if (value.artifact.validation !== undefined) closed(value.artifact.validation, ['requiredHeadings', 'forbiddenPlaceholders'], 'Artifact validation');
    const artifact = safeCopy(value.artifact); portable(artifact.path, 'Phase artifact');
    if (!artifact.path.startsWith(`artifacts/${key}/`) || !Number.isSafeInteger(artifact.minimumBytes) || artifact.minimumBytes < 1 || !Number.isSafeInteger(artifact.maximumBytes) || artifact.maximumBytes < artifact.minimumBytes) fail('Phase output needs exact own-artifact path and positive byte bounds.', 'WCA_ARTIFACT_UNRESOLVED');
    if (value.writeScope !== 'artifact-only') fail('New source effects require exact admitted source-scope/code-delivery contracts.', 'WCA_PERMISSION_UNAPPROVED');
    const template = resolve(value.template, 'template', 'Phase template'); const templateId = template.id ?? (typeof value.template === 'string' ? value.template : value.template.id);
    const agent = resolve(value.agent, 'agent', 'Phase agent');
    for (const skill of optionalArray(value.skills, 'Phase skill references')) resolve(skill, 'skill', 'Phase skill reference');
    if (value.skills?.length) add('WCA_SKILL_ASSIGNMENT_UNAVAILABLE', `definitions.phases.${key}.skills`, 'Skill references need an admitted SKP binding; ordinary phases cannot silently discard them.');
    const task = bound(value.taskBinding, 'execution-task').id; assertModelTask(task);
    if (task === 'code') fail('Code production requires the admitted code-delivery/source-scope owner, not artifact-only defaults.', 'WCA_PERMISSION_UNAPPROVED');
    const authority = bindings.get(value.approvalBinding);
    if (!authority || authority.kind !== 'approval-authority') fail('New phases require an exact existing human authority.', 'WCA_APPROVAL_UNRESOLVED');
    const inputs = optionalArray(value.inputs, 'Phase inputs').map((input) => { const phase = resolve(input, 'phase', 'Phase input'); return { phase: phase.id ?? (typeof input === 'string' ? input : input.id), optional: false }; });
    candidate.phases[key] = { label: value.label, artifact, inputs, defaultTemplate: `template:${templateId}`,
      approval: normalizeApprovalPolicy({ mode: 'required', authorities: [authority.value.id], minimum: 1 }, candidate.approvalAuthorities, key, candidate.approvalSecurity),
      generation: { requirement: 'required', defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'], task }, writeScope: 'artifact-only',
      qualityCommands: optionalArray(value.qualityBindings, 'Phase quality bindings').map((binding) => bound(binding, 'quality-command')),
      ...(value.clarification ? { clarification: value.clarification } : {}) };
    if (!symbols.agents.has(agent.id) && !(agent.defaultFor ?? []).includes(key)) add('WCA_AGENT_BINDING_UNAVAILABLE', `definitions.phases.${key}.agent`, 'The selected approved agent has no existing default mapping for this new phase; an explicit reviewed agent update is required.');
  });
  for (const logical of assets.keys()) if (!usedAssets.has(logical)) add('WCA_ASSET_UNCLAIMED', 'assets', 'A captured attachment has no explicit candidate content/resource consumer. Resolve its disposition instead of silently omitting package bytes.');
  if (!symbols.workflows.size) add('WCA_WORKFLOW_MISSING', 'definitions.workflows', 'A complete package must define at least one workflow.');
  for (const [key, value] of symbols.workflows) attempt(`definitions.workflows.${key}`, () => {
    closed(value, ['id', 'label', 'description', 'phases', 'plannedClaims', 'reworkLoops'], 'Workflow definition');
    if (value.label !== undefined) text(value.label, 'Workflow label', 512);
    if (value.description !== undefined && typeof value.description !== 'string') fail('Workflow description must be literal text.');
    const replacement = workflowChanges?.replacements.find((row) => row.id === key)
      ?? (sharedObjectChanges ? { definition: captured.rawDefinition.workTypes[key] } : null);
    const selectedOrder = replacement?.definition.phases ?? value.phases;
    if (!Array.isArray(selectedOrder) || !selectedOrder.length || selectedOrder.length > WCA_COMPILER_LIMITS.phases) fail('Workflow phase order must be explicit and bounded.', 'WCA_GRAPH_INVALID');
    const order = selectedOrder.map((entry) => { const selected = resolve(entry, 'phase', 'Workflow phase'); return selected.id ?? (typeof entry === 'string' ? entry : entry.id); });
    if (new Set(order).size !== order.length || !sharedObjectChanges && (order[0] !== 'intake'
        || order.at(-1) !== 'conformance' && !reviewedNonCodeFinish(order, symbols, candidate))) {
      fail('Workflow order must be unique and start with Intake; code workflows end with Conformance, while non-code workflows may end with a reviewed artifact-only phase that consumes the preceding output.', 'WCA_GRAPH_INVALID');
    }
    candidate.workTypes[key] = replacement ? { ...structuredClone(replacement.definition), phases: order }
      : { label: value.label ?? request.label, description: value.description ?? '', phases: order, ...(value.plannedClaims !== undefined ? { plannedClaims: value.plannedClaims } : {}), ...(value.reworkLoops ? { reworkLoops: value.reworkLoops } : {}) };
    // Only the effective workType contract owns inputs, templates, artifact paths and approval.
    // Retained overrides must neither be silently dropped nor checked against the base phase.
    // Incomplete SKP proposals stay display-only and have no configured phase to resolve yet.
    const effective = order.every((phaseId) => candidate.phases[phaseId])
      ? new Map(resolveWorkType(candidate, key).phases.map((phase) => [phase.id, phase])) : null;
    const approvedEffective = groupReplacement
      ? new Map(resolveWorkType(captured.definition, key).phases.map((phase) => [phase.id, phase])) : null;
    for (const [index, phaseId] of order.entries()) {
      const proposed = skillProposals.find((proposal) => proposal.phaseId === phaseId);
      const selectedGroupPhase = groupReplacement?.phaseReplacements.some((replacement) => replacement.phaseId === phaseId);
      const phase = effective?.get(phaseId) ?? (!selectedGroupPhase ? approvedEffective?.get(phaseId) : null)
        ?? candidate.phases[phaseId] ?? proposed?.phasePolicy;
      if (!phase) { add('WCA_PHASE_UNCOMPILED', `definitions.workflows.${key}.phases`, 'A selected phase could not be compiled.'); continue; }
      if (skillProposals.length && phase.approval?.mode !== 'none'
          && !approvalPolicyCapacity(candidate.approvalAuthorities, phase.approval).attainable) {
        add('WCA_REVIEWER_CAPACITY_UNATTAINABLE', `definitions.workflows.${key}.phases.${phaseId}`,
          'The approved configuration has too few eligible reviewers for this phase. Configure reviewers in the repository approval authority before SKP terminal consent.');
      }
      if (phase.kind === 'skill') validateConfiguredSkillPhase(candidate.phases[phaseId], phaseId);
      if (!symbols.phases.has(phaseId)) {
        const selectedAgent = agents.find((agent) => agent.defaultFor.includes(phaseId));
        if (selectedAgent) pin('agent', selectedAgent.id, selectedAgent);
        const template = phase.kind === 'skill' ? null : resolveTemplate(candidate, phase.template ?? phase.defaultTemplate);
        if (template?.source === 'agent') add('WCA_REMOTE_DEPENDENCY_UNAVAILABLE', `definitions.workflows.${key}.phases.${phaseId}`, 'A remote Agent dependency is not a captured complete preview input; preview will not fetch it.');
        else if (template?.path) {
          const relative = `${candidate.templatesRoot}/${template.path}`;
          const bytes = replacementFiles.has(relative) ? Buffer.from(replacementFiles.get(relative)) : captured.files.get(relative);
          if (!bytes) add('WCA_CONTENT_UNRESOLVED', `definitions.workflows.${key}.phases.${phaseId}`, 'The selected approved template bytes are missing.');
          else if (!locks.some((lock) => lock.kind === 'template-content' && lock.id === relative)) locks.push({ source: 'approved-catalog', kind: 'template-content', id: relative, definitionSha256: bytesDigest(bytes), baseRevision: captured.baseRevision });
        }
      }
      graph.push({ workflowId: key, phaseId, order: index, kind: proposed ? 'skill-proposal' : phase.kind ?? 'template', inputs: (phase.inputs ?? []).map((input) => typeof input === 'string' ? input : input.phase), artifact: phase.artifact.path, humanReview: phase.approval?.mode !== 'none', evidence: 'not-run', ...(proposed ? { outputs: proposed.bindingRefs.outputs, runtimeBinding: 'absent' } : {}) });
      for (const input of phase.inputs ?? []) { const inputId = typeof input === 'string' ? input : input.phase; if (order.indexOf(inputId) < 0 || order.indexOf(inputId) >= index) add('WCA_INPUT_ORDER_INVALID', `definitions.workflows.${key}.phases.${phaseId}.inputs`, 'Artifact dependencies must resolve to exact earlier selected producers; ordinary cycles are invalid.'); }
    }
  });
  let candidateValidated = false;
  // Config validation normalizes runtime defaults in place. Once SKP consent has bound the raw
  // pending definition, validate/simulate a clone rather than changing reviewed emitted policy.
  const validatedCandidate = finalized ? structuredClone(candidate) : candidate;
  // Proposal-only skill contracts deliberately lack configured phases. Do not feed that
  // incomplete projection to the full configuration owner and mislabel its missing bindings as
  // an unrelated configuration failure, or simulate it as a confirmed execution contract.
  if (!skillProposals.length) attempt('candidate.configuration', () => {
    validateDefinition(validatedCandidate); validateAgentCatalog(agents, validatedCandidate);
    for (const key of symbols.workflows.keys()) if (validatedCandidate.workTypes[key]) assertPlannedClaimsReady(resolveWorkType(validatedCandidate, key));
    candidateValidated = true;
  });
  if (candidateValidated && symbols.workflows.size) {
    simulation.prerequisites = 'normalized-candidate';
    for (const key of symbols.workflows.keys()) attempt(`simulation.${key}`, () => {
      if (!validatedCandidate.workTypes[key]) { simulation.status = 'incomplete'; return; }
      const report = simulateResolvedWorkflowLifecycle(resolveWorkType(validatedCandidate, key));
      if (Buffer.byteLength(canonicalJson([...simulation.workflows, report])) > 2 * 1024 * 1024) {
        add('WCA_SIMULATION_LIMIT', `simulation.${key}`, 'Lifecycle simulation exceeds its aggregate report budget; no partial report is a complete verdict.');
        return;
      }
      simulation.workflows.push(report);
      for (const finding of report.findings) add(finding.code, `simulation.${key}${finding.phaseId ? `.${finding.phaseId}` : ''}`, finding.message,
        report.status === 'invalid' ? 'submission-blocker' : 'capability-unavailable');
      if (report.status !== 'complete-for-profile' && !report.findings.length) {
        add('WCA_SIMULATION_INCOMPLETE', `simulation.${key}`, 'The selected lifecycle cannot be completely projected by this profile; no execution readiness was inferred.', 'capability-unavailable');
      }
    });
    simulation.status = simulation.workflows.some((report) => report.status === 'invalid') ? 'invalid'
      : simulation.workflows.length === symbols.workflows.size && simulation.workflows.every((report) => report.status === 'complete-for-profile') ? 'complete-for-profile' : 'incomplete';
  }
  locks.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (groupReplacement) groupReplacement.approvedTemplateFiles = locks.filter((lock) => lock.kind === 'template-content').map((lock) => {
    const bytes = captured.exactFiles?.get(lock.id);
    if (!bytes || bytesDigest(bytes) !== lock.definitionSha256) {
      fail('A grouped template content lock lacks exact approved Git bytes.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
    }
    return { path: lock.id, bytes: bytes.length, sha256: lock.definitionSha256, contentBase64: bytes.toString('base64') };
  });
  if (skillContractRequest) attempt('candidate.pending-package', () => {
    for (const [relative, content] of replacementFiles) emit(relative, content);
  });
  pendingSkillFiles = [...files].map(([file, content]) => ({ path: file, content, bytes: Buffer.byteLength(content), sha256: bytesDigest(Buffer.from(content)) }));
  if (!findings.length) attempt('candidate.files', () => {
    // Workflow-only edits must not serialize loadDefinition defaults back into unrelated shared
    // definitions. Preserve the raw approved source and overlay only the exact reviewed targets.
    const emittedDefinition = workflowChanges || sharedObjectChanges ? structuredClone(captured.rawDefinition) : candidate;
    if (workflowChanges) for (const replacement of workflowChanges.replacements) {
      emittedDefinition.workTypes[replacement.id] = structuredClone(replacement.definition);
    }
    if (sharedObjectChanges) for (const replacement of sharedObjectChanges.replacements) {
      if (replacement.kind === 'phase') emittedDefinition.phases[replacement.id] = structuredClone(skillContractRequest
        ? finalizedPhases.get(replacement.id) : replacement.definition);
      else if (replacement.kind === 'template' && replacement.catalogId) emittedDefinition.templates[replacement.catalogId] = structuredClone(replacement.definition);
    }
    if (!skillContractRequest) for (const [relative, content] of replacementFiles) emit(relative, content);
    const unchangedRawDefinition = contentProfile && canonicalJson(emittedDefinition) === canonicalJson(captured.rawDefinition);
    emit('singularity/workflow.yml', unchangedRawDefinition ? captured.exactFiles.get('singularity/workflow.yml').toString('utf8')
      : YAML.stringify(emittedDefinition, { lineWidth: 0 }));
  });
  if (findings.length) { files.clear(); operations.length = 0; }
  return output();
}

/** Exact read-only entry point for shell/Show adapters; no approval/action capability is returned. */
export async function previewWorkflowDraftPackage(root, { draftId, revision = null } = {}) {
  const context = await captureWorkflowCompilerContext(root);
  const source = await captureWorkflowDraftCompilerSource(context, { draftId, revision });
  return compileWorkflowDraftPackage({ context, source });
}

/** Recompile rather than adopting caller-written preview bytes or rebasing their plan identity. */
export async function revalidateWorkflowDraftPackage(root, { draftId, revision, expectedPlanSha256 } = {}) {
  if (typeof expectedPlanSha256 !== 'string' || !SHA.test(expectedPlanSha256)) fail('An exact preview identity is required.', 'WCA_PREVIEW_STALE');
  const current = await previewWorkflowDraftPackage(root, { draftId, revision });
  if (current.planSha256 !== expectedPlanSha256) fail('Draft, catalog, policy, authority or candidate content changed; obtain a new review.', 'WCA_PREVIEW_STALE');
  return current;
}

/** Exact candidate bytes for the existing proposal owner, never an action/approval capability. */
export function workflowDraftPackageProposalFiles(preview) {
  const retained = PREVIEWS.get(preview); const captured = retained && CONTEXTS.get(retained.context);
  const draft = retained && SOURCES.get(retained.source);
  if (!captured || !draft) fail('Use a compiler-owned exact preview, not caller-written candidate files.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  if (preview.findings.length || preview.readiness.authoring !== 'valid' || preview.readiness.simulation !== 'complete-for-profile') fail('This preview has unresolved package or lifecycle findings and cannot emit proposal files.', 'WCA_PACKAGE_NOT_SUBMITTABLE');
  const files = preview.assets.map((asset) => {
    const bytes = Buffer.from(asset.content);
    if (bytesDigest(bytes) !== asset.sha256 || bytes.length !== asset.bytes) fail('Compiler candidate closure is inconsistent.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
    return { path: asset.path, mode: '100644', bytes: bytes.length, sha256: asset.sha256, contentBase64: bytes.toString('base64') };
  });
  const snapshotInputs = { request: safeCopy(draft.payload), assets: draft.assets.map((asset) => ({
    path: asset.path, bytes: asset.content.length, sha256: bytesDigest(asset.content), contentBase64: asset.content.toString('base64')
  })) };
  return freeze({ preview, expectedAuthority: structuredClone(captured.expectedAuthority), assetPolicy: structuredClone(captured.assetPolicy), snapshotInputs, files });
}

/** Fresh owner capture/revalidation before proposal staging. No mutable caller file set is used. */
export async function captureWorkflowDraftPackageProposal(root, options = {}) {
  const request = safeCopy(options); closed(request, ['draftId', 'revision', 'expectedPlanSha256'], 'Exact package proposal selection');
  return workflowDraftPackageProposalFiles(await revalidateWorkflowDraftPackage(root, request));
}

/** Exact review identity before bindings exist. This exports no consent or file-write grant. */
export function workflowDraftSkillSubmissionReview(preview) {
  const retained = PREVIEWS.get(preview);
  if (!retained?.prepared || retained.prepared.finalization !== 'requires-exact-terminal-consent'
      || preview.findings.some((finding) => finding.code !== 'WCA_SKP_CONFIRMATION_BINDING_PENDING')
      || preview.skillProposals.length !== retained.prepared.subject.phases.length) {
    fail('This skill package still needs an explicit producer classification, exact agent, or other authoring decision.', 'WCA_PACKAGE_NOT_SUBMITTABLE');
  }
  return workflowSkillFinalizationReview(retained.prepared);
}

/** Real terminal-owner consumption precedes any configured binding, file emission or proposal. */
export async function finalizeWorkflowDraftSkillProposal(root, options = {}) {
  const selection = safeCopy(options);
  closed(selection, ['draftId', 'revision', 'expectedPlanSha256', 'confirmation'], 'Exact skill finalization selection');
  if (typeof selection.confirmation !== 'string') fail('A one-use direct-terminal authorization is required.', 'WCA_SKP_CONSENT_REQUIRED');
  const preview = await revalidateWorkflowDraftPackage(root, selection);
  workflowDraftSkillSubmissionReview(preview);
  const retained = PREVIEWS.get(preview);
  const consent = await consumeWorkflowSkillFinalizationConsent(root, retained.prepared, selection.confirmation);
  const projection = finalizeWorkflowSkillConsent(retained.prepared, consent);
  const finalization = { prepared: retained.prepared, projection, prePlanSha256: preview.planSha256 };
  const finalized = compileOwnerWorkflowDraftPackage({ context: retained.context, source: retained.source }, finalization);
  return workflowDraftPackageProposalFiles(finalized);
}

/** Staging reuses no consent: it only rechecks the exact consumed subject against fresh owners. */
export async function revalidateFinalizedWorkflowDraftSkillProposal(root, preview) {
  const retained = PREVIEWS.get(preview);
  if (!retained?.finalization) fail('Use an exact compiler-owned finalized skill projection.', 'WCA_SKP_CONSENT_REQUIRED');
  const pending = await revalidateWorkflowDraftPackage(root, { draftId: preview.source.draftId,
    revision: preview.source.revision, expectedPlanSha256: retained.finalization.prePlanSha256 });
  workflowDraftSkillSubmissionReview(pending);
  const fresh = PREVIEWS.get(pending);
  const finalization = { ...retained.finalization, prepared: fresh.prepared };
  const current = compileOwnerWorkflowDraftPackage({ context: fresh.context, source: fresh.source }, finalization);
  if (current.planSha256 !== preview.planSha256) fail('The finalized closure changed; review a new subject.', 'WCA_PREVIEW_STALE');
  return workflowDraftPackageProposalFiles(current);
}
