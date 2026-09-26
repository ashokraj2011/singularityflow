/** Deterministic, source-bound authoring preview. Nothing here approves, installs or executes. */
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { withApprovedConfigurationRead } from './approved-configuration-reader.mjs';
import { configurationReadRoot, configurationReadScope } from './configuration-read-scope.mjs';
import { loadDefinition, validateDefinition, resolveWorkType, assertPlannedClaimsReady } from './config.mjs';
import { discoverAgents, parseAgentDependencies, validateAgentCatalog } from './agents.mjs';
import { MODEL_TASKS, assertModelTask } from './model-tasks.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';
import { normalizeApprovalPolicy } from './approval-authority.mjs';
import { inspectSkillPackageContents } from './skp-package.mjs';
import { validateConfiguredSkillPhase, compileSkillPhaseProposal } from './skp-contract.mjs';
import { normalizeTemplateCatalog, resolveTemplate } from './template-catalog.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { openGitDraftStore } from './wca-git-drafts.mjs';
import { scanEntries } from './secrets.mjs';
import { SingularityFlowError, isPortableRepositoryPathComponent } from './util.mjs';
import { remoteFingerprint } from './git-remote-diagnostics.mjs';
import { captureEnvironmentDeclaration, matchEnvironmentLocalPath } from './environment-declaration.mjs';

export const WCA_COMPILER_PROFILE = 'wca-complete-package/v1';
export const WCA_PREVIEW_KIND = 'workflow-authoring-package-preview';
export const WCA_REQUEST_SCHEMA = 'sflow-workflow-request@2';
export const WCA_CATALOG_CHOICE_KIND = 'workflow-authoring-catalog-choices';
export const WCA_COMPILER_LIMITS = Object.freeze({ requestBytes: 5 * 1024 * 1024, objects: 128, workflows: 16, phases: 64, assets: 128, assetBytes: 8 * 1024 * 1024, findings: 128, nodes: 100_000, depth: 32 });
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
    const repository = openGitDraftStore({ root, remote: authority.remote, workspaceId: 'configuration' }).capability.repository;
    const baseRevision = authority.manifest?.source?.commit ?? authority.commit;
    if (!OID.test(baseRevision)) fail('Approved source commit is unavailable.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
    const view = freeze({ kind: 'workflow-authoring-compiler-context', schemaVersion: 1,
      source: { kind: authority.kind, repository, ref: authority.ref, observedCommit: authority.commit, baseRevision,
        workflowSha256: bytesDigest(before) }, profile: WCA_COMPILER_PROFILE });
    CONTEXTS.set(view, { root, sourceRoot, definition: structuredClone(definition), agents, files, repository, baseRevision, assetPolicy,
      environmentDeclaration: environmentCapture?.declaration ?? null, environmentSha256: environmentCapture ? bytesDigest(environmentCapture.bytes) : null,
      expectedAuthority: { kind: authority.kind, commit: authority.commit, sourceCommit: baseRevision, remoteFingerprint: remoteFingerprint(repository) } });
    return view;
  }, { preferAuthority: true, requireAuthorityRefresh: true, allowLocalHeads: false });
}

/** Reads one actual immutable selected revision. Caller JSON cannot impersonate a retained read. */
export async function captureWorkflowDraftCompilerSource(context, { draftId, revision = null } = {}) {
  const captured = CONTEXTS.get(context); if (!captured) fail('Use an owner-captured compiler context.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  const store = openGitDraftStore({ root: captured.root, remote: captured.repository, workspaceId: 'configuration', environmentDeclaration: captured.environmentDeclaration });
  const read = await store.readRevision({ draftId, revision });
  const source = freeze({ kind: 'workflow-authoring-draft-source', schemaVersion: 1, repository: captured.repository,
    workspaceId: read.record.workspaceId, draftId: read.record.draftId, revision: read.record.revision,
    lifecycleEpoch: read.record.lifecycleEpoch, revisionSha256: read.record.revisionSha256, head: read.head,
    payloadSha256: read.record.content.payloadSha256, assetManifestSha256: read.record.content.assetManifestSha256,
    lifecycle: read.tombstone ? 'deleted' : 'live' });
  SOURCES.set(source, { context, payload: safeCopy(read.payload), assets: read.assets.map((asset) => ({ path: asset.path, content: Buffer.from(asset.content) })) });
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
      label: Array.from(typeof value.label === 'string' ? value.label : key).slice(0, 256).join('')
    }));
    return { kind: catalogKind, choices, total: entries.length, nextCursor: cursor + choices.length < entries.length ? cursor + choices.length : null, unavailable: catalogKind === 'quality-command' ? ambiguousChecks.size : 0 };
  });
  return freeze({ schemaVersion: 1, kind: WCA_CATALOG_CHOICE_KIND, approvedSource: context.source,
    permissionEffect: 'none', membership: 'not-verified', hostMapping: 'not-verified', groups });
}

/** Pure deterministic compilation over opaque exact source/context captures. */
export function compileWorkflowDraftPackage({ context, source } = {}) {
  const captured = CONTEXTS.get(context); const draft = SOURCES.get(source);
  if (!captured || !draft || draft.context !== context) fail('Compiler context and draft source must be captured together by their owners.', 'WCA_COMPILER_SOURCE_UNAVAILABLE');
  const request = safeCopy(draft.payload);
  const findings = []; const locks = []; const operations = []; const graph = []; const skillProposals = [];
  const unavailable = new Set(['WCA_SKP_CONFIRMATION_BINDING_PENDING', 'WCA_HOST_CONTRACT_UNAVAILABLE', 'WCA_OPERATION_MAPPING_UNAVAILABLE', 'WCA_SKILL_ASSIGNMENT_UNAVAILABLE', 'WCA_CHANGE_OWNER_UNAVAILABLE', 'WCA_REMOTE_DEPENDENCY_UNAVAILABLE']);
  const add = (code, fieldPath, message, category = unavailable.has(code) ? 'capability-unavailable' : 'submission-blocker') => {
    if (findings.length < WCA_COMPILER_LIMITS.findings) findings.push({ code, fieldPath, message, category, requiredFor: 'package-preview', sourceRule: WCA_COMPILER_PROFILE, resolvingAction: 'workflow.author.edit' });
  };
  const attempt = (fieldPath, work) => { try { return work(); } catch (error) { add(error.code ?? 'WCA_VALIDATION_FAILED', fieldPath, error.code ? error.message : 'The existing configuration owner refused this candidate.'); return null; } };
  const candidate = structuredClone(captured.definition); const files = new Map(); const symbols = Object.fromEntries(GROUPS.map((group) => [group, new Map()]));
  let acceptedRequest = false;
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
      dependencyLocks: locks, graph, skillProposals, findings: orderedFindings, fileOperations: operations, assets: emitted,
      permissions: { effective: 'pre-change-approved-policy-only', addedOperations: [], removedOperations: [], newNativeTools: [], enforcement: 'not-verified' },
      candidateDefinition: candidate, candidateDefinitionSha256: digest(candidate),
      readiness: { authoring: findings.length ? findings.every((finding) => finding.category === 'capability-unavailable') ? 'unavailable' : 'invalid' : 'valid', simulation: 'incomplete', behavior: 'not-evaluated', host: 'discovery-unverified', publication: 'not-proposed', activation: 'inactive', confirmation: 'absent', execution: 'not-run' },
      coverage: { schema: acceptedRequest ? 'checked' : 'invalid', references: 'selected-closure', policy: 'pre-change-approved-source', graph: 'ordered-input-and-registered-rework-validation', hostEnforcement: 'unavailable', behavior: 'not-evaluated', sharedConsumerImpact: 'configuration-only' },
      effects: { configurationWritten: false, proposalCreated: false, approvalGranted: false, activated: false, executed: false },
      nextAction: findings.length ? { operation: 'workflow.author.edit', legalEffect: 'edit-inert-draft' } : { operation: 'workflow.author.review', legalEffect: 'needs-separate-exact-human-confirmation', available: false } };
    const preview = freeze(JSON.parse(canonicalJson({ ...core, planSha256: digest(core) })));
    PREVIEWS.set(preview, { context, source }); return preview;
  };
  if (!acceptedRequest) return output();
  if (source.lifecycle !== 'live') add('WCA_DRAFT_DELETED', 'source.lifecycle', 'Deleted retained revisions cannot create a current submission plan.');
  if (request.baseRevision !== captured.baseRevision) add('WCA_BASE_REVISION_STALE', 'baseRevision', 'The request must explicitly bind this exact approved configuration base commit.');
  if (request.intent !== 'create' || request.changes?.length) add('WCA_CHANGE_OWNER_UNAVAILABLE', 'changes', 'Edit, fork and explicit object changes require the existing impact/change owner; no update or deletion is inferred.');
  if (request.executionProposals?.length) add('WCA_EXECUTION_PROPOSAL_UNADMITTED', 'executionProposals', 'Executable proposals remain inert and have no runtime admission owner.');
  if (request.target.hosts?.length) add('WCA_HOST_CONTRACT_UNAVAILABLE', 'target.hosts', 'No installed exact host/tool mapping contract has been verified by this compiler.');
  for (const group of GROUPS) attempt(`definitions.${group}`, () => {
    const values = request.definitions?.[group] ?? [];
    if (!Array.isArray(values) || values.length > (group === 'workflows' ? WCA_COMPILER_LIMITS.workflows : WCA_COMPILER_LIMITS.objects)) fail('Candidate collection exceeds its bounded object budget.', 'WCA_COMPILER_LIMIT');
    for (const value of values) {
      if (!plain(value)) fail('Candidate definitions must be ordinary objects.');
      const key = id(value.id, `${group} ID`);
      if (symbols[group].has(key)) fail('Candidate definitions repeat an object ID.', 'WCA_OBJECT_COLLISION');
      const existing = group === 'workflows' ? candidate.workTypes[key] : group === 'phases' ? candidate.phases[key] : group === 'templates' ? candidate.templates?.[key] : group === 'agents' ? captured.agents.find((agent) => agent.id === key) : null;
      if (existing || key.startsWith('sf-') || key.startsWith('sflow-')) fail('Candidate definitions cannot shadow approved or privileged installed objects.', 'WCA_OBJECT_COLLISION');
      symbols[group].set(key, value);
    }
  });
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
    const before = captured.files.get(relative); if (before && relative !== 'singularity/workflow.yml') fail('Managed output already exists; explicit reviewed update is required.', 'WCA_OBJECT_COLLISION');
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
    closed(value, ['id', 'description', 'instructions', 'instructionsAsset', 'operationBindings', 'qualityBindings', 'resources'], 'Skill definition');
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
    for (const [relative, bytes] of contents) emit(`.github/skills/${request.id}-${key}/${relative}`, bytes.toString('utf8'));
  });
  const agents = [...captured.agents];
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
    const sourcePath = `.github/agents/${request.id}-${key}.agent.md`;
    const content = `---\n${YAML.stringify({ name: key, description: value.description, tools: [], metadata: { 'sflow-phases': phases.join(','), 'sflow-default-for': phases.join(',') } })}---\n${prompt}\n`;
    const parsed = parseAgentDependencies(content, { source: sourcePath, agentId: key }); agents.push({ ...parsed, text: content, scope: 'repository' }); emit(sourcePath, content);
  });
  for (const [key, value] of symbols.phases) attempt(`definitions.phases.${key}`, () => {
    if (value.kind === 'skill') {
      closed(value, ['id', 'kind', 'label', 'skill', 'contract', 'agent'], 'Skill phase definition');
      if (value.agent !== undefined) resolve(value.agent, 'agent', 'Skill phase agent');
      closed(value.skill, ['id', 'packageSha256'], 'Selected candidate skill');
      const inspected = skillPackages.get(value.skill?.id);
      if (!inspected || value.skill.packageSha256 !== undefined && inspected.manifest.packageSha256 !== value.skill.packageSha256) fail('The selected new skill must bind its exact captured candidate package.', 'SKP_SKILL_DRIFT');
      const orders = [...symbols.workflows.values()].filter((workflow) => workflow.phases?.some((phase) => phase === key || phase?.id === key));
      if (!orders.length || orders.some((workflow) => canonicalJson(workflow.phases) !== canonicalJson(orders[0].phases))) fail('New skill phase requires one exact unambiguous workflow order.', 'SKP_INPUT_ORDER');
      const phaseOrder = orders[0].phases.map((phase) => typeof phase === 'string' ? phase : phase.id);
      const approvedOutputs = Object.fromEntries(Object.entries(captured.definition.phases).map(([phaseId, phase]) => [phaseId, { outputs: phase.kind === 'skill' ? phase.skillBinding.bindingRefs.outputs : [{ id: 'primary', path: phase.artifact.path }] }]));
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
      skillProposals.push(compileSkillPhaseProposal({ phase, catalog, phaseOrder }));
      add('WCA_SKP_CONFIRMATION_BINDING_PENDING', `definitions.phases.${key}`, 'Contract policy is validated proposal-only. A later real exact-plan confirmation must create its runtime binding through the SKP owner before candidate configuration emission.'); return;
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
    if (!Array.isArray(value.phases) || !value.phases.length || value.phases.length > WCA_COMPILER_LIMITS.phases) fail('Workflow phase order must be explicit and bounded.', 'WCA_GRAPH_INVALID');
    const order = value.phases.map((entry) => { const selected = resolve(entry, 'phase', 'Workflow phase'); return selected.id ?? (typeof entry === 'string' ? entry : entry.id); });
    if (new Set(order).size !== order.length || order[0] !== 'intake' || order.at(-1) !== 'conformance') fail('Workflow order must be unique and explicitly retain Intake and Conformance.', 'WCA_GRAPH_INVALID');
    candidate.workTypes[key] = { label: value.label ?? request.label, description: value.description ?? '', phases: order, ...(value.plannedClaims !== undefined ? { plannedClaims: value.plannedClaims } : {}), ...(value.reworkLoops ? { reworkLoops: value.reworkLoops } : {}) };
    for (const [index, phaseId] of order.entries()) {
      const proposed = skillProposals.find((proposal) => proposal.phaseId === phaseId);
      const phase = candidate.phases[phaseId] ?? proposed?.phasePolicy;
      if (!phase) { add('WCA_PHASE_UNCOMPILED', `definitions.workflows.${key}.phases`, 'A selected phase could not be compiled.'); continue; }
      if (phase.kind === 'skill') validateConfiguredSkillPhase(phase, phaseId);
      if (!symbols.phases.has(phaseId)) {
        const selectedAgent = captured.agents.find((agent) => agent.defaultFor.includes(phaseId));
        if (selectedAgent) pin('agent', selectedAgent.id, selectedAgent);
        const template = resolveTemplate(candidate, phase.defaultTemplate);
        if (template?.source === 'agent') add('WCA_REMOTE_DEPENDENCY_UNAVAILABLE', `definitions.workflows.${key}.phases.${phaseId}`, 'A remote Agent dependency is not a captured complete preview input; preview will not fetch it.');
        else if (template?.path) {
          const relative = `${candidate.templatesRoot}/${template.path}`; const bytes = captured.files.get(relative);
          if (!bytes) add('WCA_CONTENT_UNRESOLVED', `definitions.workflows.${key}.phases.${phaseId}`, 'The selected approved template bytes are missing.');
          else if (!locks.some((lock) => lock.kind === 'template-content' && lock.id === relative)) locks.push({ source: 'approved-catalog', kind: 'template-content', id: relative, definitionSha256: bytesDigest(bytes), baseRevision: captured.baseRevision });
        }
      }
      graph.push({ workflowId: key, phaseId, order: index, kind: proposed ? 'skill-proposal' : phase.kind ?? 'template', inputs: (phase.inputs ?? []).map((input) => typeof input === 'string' ? input : input.phase), artifact: phase.artifact.path, humanReview: phase.approval?.mode !== 'none', evidence: 'not-run', ...(proposed ? { outputs: proposed.bindingRefs.outputs, runtimeBinding: 'absent' } : {}) });
      for (const input of phase.inputs ?? []) { const inputId = typeof input === 'string' ? input : input.phase; if (order.indexOf(inputId) < 0 || order.indexOf(inputId) >= index) add('WCA_INPUT_ORDER_INVALID', `definitions.workflows.${key}.phases.${phaseId}.inputs`, 'Artifact dependencies must resolve to exact earlier selected producers; ordinary cycles are invalid.'); }
    }
  });
  attempt('candidate.configuration', () => {
    validateDefinition(candidate); validateAgentCatalog(agents, candidate);
    for (const key of symbols.workflows.keys()) if (candidate.workTypes[key]) assertPlannedClaimsReady(resolveWorkType(candidate, key));
  });
  locks.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!findings.length) attempt('candidate.files', () => emit('singularity/workflow.yml', YAML.stringify(candidate, { lineWidth: 0 })));
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
  if (preview.findings.length || preview.readiness.authoring !== 'valid') fail('This preview has unresolved package findings and cannot emit proposal files.', 'WCA_PACKAGE_NOT_SUBMITTABLE');
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
