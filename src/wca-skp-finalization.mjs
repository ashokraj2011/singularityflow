/**
 * Two non-circular SKP identities for the WCA owner. Preparation and sealing are pure; the only
 * authorization boundary delegates to the existing direct-terminal owner. Captured data is not
 * proof of approved provenance: the compiler must supply its exact approved-source capture and
 * revalidate it before staging. None of these projections approves, installs or runs a package.
 */
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { canonicalJson, recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { compileSkillPhaseProposal, compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill,
  validateConfiguredSkillPhase, skillContractSha256, skillPhaseCandidateSha256, SKP_CONTRACT_COMPILER } from './skp-contract.mjs';
import { verifySkillPackage } from './skp-package.mjs';
import { parseAgentDependencies } from './agents.mjs';
import { isPortableRepositoryPathComponent, SingularityFlowError } from './util.mjs';

export const WCA_SKP_PRECONSENT_PROFILE = 'wca-skp-preconsent/v1';
export const WCA_SKP_FINALIZATION_PROFILE = 'wca-skp-finalization/v1';
export const WCA_SKP_LOCAL_PRODUCER_PROFILE = 'local-reviewed-artifact-producer/v1';
export const WCA_SKP_FINALIZATION_LIMITS = Object.freeze({
  phases: 64, files: 256, nodes: 100_000, depth: 32,
  inputBytes: 12 * 1024 * 1024, packageBytes: 8 * 1024 * 1024,
  closureBytes: 16 * 1024 * 1024, subjectBytes: 1024 * 1024
});
const SHA = /^sha256:[a-f0-9]{64}$/u;
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PREPARED = new WeakMap();
const CONSENTS = new WeakMap();
const COMPILED = new WeakMap();
const digest = (value) => `sha256:${recordSha256(value)}`;
const bytesDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const domainDigest = (domain, value) => `sha256:${createHash('sha256').update(`${domain}\0`).update(canonicalJson(value)).digest('hex')}`;
const effects = () => ({ configurationWritten: false, proposalCreated: false, approvalGranted: false, activated: false, executed: false });
function fail(message, code = 'WCA_SKP_FINALIZATION_INVALID') { throw new SingularityFlowError(message, { code }); }
function plain(value) { return value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function closed(value, fields, required = fields) {
  if (!plain(value) || Object.keys(value).some((key) => !fields.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) fail('The SKP finalization input has an unsupported closed shape.');
}
function text(value, maximum = 512) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum || Buffer.from(value).toString('utf8') !== value || /[\0\r\n\x1b]/u.test(value)) fail('An exact bounded literal identity is required.');
  return value;
}
function id(value) { text(value); if (!ID.test(value)) fail('An exact phase, skill or agent ID is required.'); return value; }
function sha(value) { if (typeof value !== 'string' || !SHA.test(value)) fail('An exact SHA-256 identity is required.'); return value; }
function integer(value) { if (!Number.isSafeInteger(value) || value < 1) fail('An exact positive revision is required.'); return value; }
function portable(value) {
  text(value, 1024);
  if (value.includes('\\') || value.split('/').some((part) => !isPortableRepositoryPathComponent(part))) fail('An exact portable repository-relative path is required.');
  return value;
}
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function copy(value, maximum = WCA_SKP_FINALIZATION_LIMITS.inputBytes) {
  const seen = new Set(); let nodes = 0; let literalBytes = 0;
  const visit = (item, depth) => {
    if (++nodes > WCA_SKP_FINALIZATION_LIMITS.nodes || depth > WCA_SKP_FINALIZATION_LIMITS.depth) fail('The SKP finalization JSON exceeds its structural budget.', 'WCA_SKP_FINALIZATION_LIMIT');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      literalBytes += Buffer.byteLength(item);
      if (literalBytes > maximum || Buffer.from(item).toString('utf8') !== item) fail('The SKP finalization JSON exceeds its literal budget.', 'WCA_SKP_FINALIZATION_LIMIT');
      return item;
    }
    if (!item || typeof item !== 'object' || seen.has(item) || !Array.isArray(item) && !plain(item)) fail('SKP finalization requires ordinary bounded JSON data.');
    if (Array.isArray(item) && item.length > WCA_SKP_FINALIZATION_LIMITS.nodes) fail('The SKP finalization array exceeds its structural budget.', 'WCA_SKP_FINALIZATION_LIMIT');
    seen.add(item); const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length) fail('SKP finalization does not accept symbol fields.');
    const result = Array.isArray(item) ? [] : {};
    if (Array.isArray(item) && Object.keys(descriptors).some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key))) fail('SKP finalization arrays cannot carry extra fields.');
    for (const key of Array.isArray(item) ? Array.from({ length: item.length }, (_, index) => String(index)) : Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('SKP finalization does not invoke accessors or omit hidden fields.');
      literalBytes += Buffer.byteLength(key);
      Object.defineProperty(result, key, { value: visit(descriptor.value, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    seen.delete(item); return result;
  };
  const captured = visit(value, 0);
  if (Buffer.byteLength(canonicalJson(captured)) > maximum) fail('The SKP finalization JSON exceeds its byte budget.', 'WCA_SKP_FINALIZATION_LIMIT');
  return captured;
}
function files(values, maximum, { mode = false } = {}) {
  if (!Array.isArray(values) || values.length > WCA_SKP_FINALIZATION_LIMITS.files) fail('The exact file closure exceeds its file budget.', 'WCA_SKP_FINALIZATION_LIMIT');
  const aliases = new Set(); let total = 0;
  return values.map((file) => {
    closed(file, ['path', 'bytes', 'sha256', 'contentBase64', ...(mode ? ['mode'] : [])]);
    portable(file.path); sha(file.sha256);
    if (mode && file.mode !== '100644') fail('Candidate files must be ordinary inert blobs.');
    const alias = file.path.normalize('NFKC').toLowerCase();
    if (aliases.has(alias)) fail('The exact file closure contains portable aliases.'); aliases.add(alias);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > maximum || typeof file.contentBase64 !== 'string'
        || file.contentBase64.length > Math.ceil(maximum / 3) * 4) fail('The exact file closure exceeds its byte budget.', 'WCA_SKP_FINALIZATION_LIMIT');
    const bytes = Buffer.from(file.contentBase64, 'base64'); total += bytes.length;
    if (total > maximum) fail('The exact file closure exceeds its byte budget.', 'WCA_SKP_FINALIZATION_LIMIT');
    if (bytes.length !== file.bytes || bytes.toString('base64') !== file.contentBase64 || bytesDigest(bytes) !== file.sha256) fail('An exact retained file differs from its hash or canonical bytes.');
    return { ...file };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
function validateSource(source, approvedSource, inputs) {
  closed(source, ['kind', 'schemaVersion', 'repository', 'workspaceId', 'draftId', 'revision', 'lifecycleEpoch', 'revisionSha256', 'head', 'payloadSha256', 'assetManifestSha256', 'lifecycle']);
  closed(approvedSource, ['kind', 'repository', 'ref', 'observedCommit', 'baseRevision', 'workflowSha256']);
  // schema-transient: this is the compiler's closed source view, not a reopened durable revision.
  if (source.schemaVersion !== 1) fail('The compiler source view is unsupported.'); // schema-transient
  if (source.kind !== 'workflow-authoring-draft-source' || source.workspaceId !== 'configuration'
      || !/^WFD-[A-Z0-9]{6,32}$/u.test(source.draftId ?? '') || source.lifecycle !== 'live' || source.lifecycleEpoch !== 1
      || !OID.test(source.head ?? '') || !OID.test(approvedSource.observedCommit ?? '') || !OID.test(approvedSource.baseRevision ?? '')) fail('An exact live draft and approved configuration source are required.', 'WCA_SKP_SOURCE_STALE');
  integer(source.revision); sha(source.revisionSha256); sha(source.payloadSha256); sha(source.assetManifestSha256); sha(approvedSource.workflowSha256);
  text(source.repository, 4096); text(approvedSource.repository, 4096); text(approvedSource.kind); text(approvedSource.ref, 1024);
  if (source.repository !== approvedSource.repository || approvedSource.kind === 'working-tree' || inputs.request.baseRevision !== approvedSource.baseRevision) fail('Draft and approved source must bind one exact authority and base.', 'WCA_SKP_SOURCE_STALE');
  if (digest(inputs.request) !== source.payloadSha256) fail('The retained request differs from the exact draft source.', 'WCA_SKP_SOURCE_STALE');
  const assets = inputs.assets.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const core = { schemaVersion: currentSchemaVersion('workflow-authoring-asset-manifest'), kind: 'workflow-authoring-asset-manifest', assets };
  const manifest = { ...core, assetManifestSha256: digest(core) };
  if (digest(manifest) !== source.assetManifestSha256) fail('The retained assets differ from the exact draft source.', 'WCA_SKP_SOURCE_STALE');
}
function body(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > maximum || Buffer.from(value).toString('utf8') !== value || value.includes('\0')) fail('An exact bounded UTF-8 agent body is required.');
  return value;
}
/** The current candidate Agent Markdown dialect, reconstructed from retained literals only. */
export function renderWorkflowSkillCandidateAgent(retainedInputs, agentId) {
  return renderCandidateAgent(copy(retainedInputs), agentId);
}
function renderCandidateAgent(retainedInputs, agentId) {
  id(agentId); closed(retainedInputs, ['request', 'assets']);
  const request = retainedInputs.request;
  if (!plain(request) || !Array.isArray(retainedInputs.assets)) fail('Retained candidate agent inputs are required.');
  const definitions = request.definitions?.agents ?? [];
  if (!Array.isArray(definitions)) fail('Candidate agent declarations must be a literal array.');
  const matches = definitions.filter((agent) => agent?.id === agentId);
  if (!matches.length) return null;
  if (matches.length !== 1) fail('Selected candidate agent declarations are ambiguous.');
  const agent = matches[0];
  closed(agent, ['id', 'description', 'prompt', 'promptAsset', 'toolBindings', 'skillRefs'], ['id', 'description', 'toolBindings']);
  body(agent.description, 1024);
  if (!Array.isArray(agent.toolBindings) || agent.toolBindings.length || agent.skillRefs !== undefined && (!Array.isArray(agent.skillRefs) || agent.skillRefs.length)
      || Object.hasOwn(agent, 'prompt') === Object.hasOwn(agent, 'promptAsset')) fail('Candidate agent evidence must preserve the admitted literal, tool-free dialect.');
  let prompt;
  if (Object.hasOwn(agent, 'prompt')) prompt = body(agent.prompt, 30_000);
  else {
    portable(agent.promptAsset);
    const capturedAssets = files(retainedInputs.assets, WCA_SKP_FINALIZATION_LIMITS.packageBytes);
    const assets = new Map(capturedAssets.map((asset) => [asset.path, Buffer.from(asset.contentBase64, 'base64')]));
    if (request.assets !== undefined && !Array.isArray(request.assets)) fail('Request assets must be a literal array.');
    for (const asset of request.assets ?? []) {
      closed(asset, ['path', 'mediaType', 'content'], ['path', 'content']); portable(asset.path);
      if (assets.has(asset.path) || [...assets.keys()].some((key) => key.normalize('NFC').toLowerCase() === asset.path.normalize('NFC').toLowerCase())) fail('Candidate agent prompt assets are ambiguous.');
      if (asset.mediaType !== undefined) text(asset.mediaType, 256);
      assets.set(asset.path, Buffer.from(body(asset.content, WCA_SKP_FINALIZATION_LIMITS.packageBytes)));
    }
    const selected = assets.get(agent.promptAsset);
    if (!selected || Buffer.from(selected.toString('utf8')).compare(selected) !== 0) fail('Selected candidate agent prompt asset is unavailable or not exact UTF-8.');
    prompt = body(selected.toString('utf8'), 30_000);
  }
  const declarations = request.definitions?.phases ?? [];
  if (!Array.isArray(declarations)) fail('Candidate phase declarations must be a literal array.');
  const phases = declarations.filter((phase) => {
    const reference = typeof phase?.agent === 'string' ? { source: 'candidate', kind: 'agent', id: phase.agent } : phase?.agent?.ref ?? phase?.agent;
    return reference?.source === 'candidate' && reference.kind === 'agent' && reference.id === agentId;
  }).map((phase) => id(phase.id));
  if (new Set(phases).size !== phases.length || !phases.length || phases.length > WCA_SKP_FINALIZATION_LIMITS.phases) fail('The selected candidate agent has no unique bounded phase assignment.');
  const path = portable(`.github/agents/${id(request.id)}-${agentId}.agent.md`);
  const rendered = `---\n${YAML.stringify({ name: agentId, description: agent.description, tools: [], metadata: {
    'sflow-phases': phases.join(','), 'sflow-default-for': phases.join(',') } })}---\n${prompt}\n`;
  return { path, text: rendered };
}
function agentBodyEvidence(agent, phaseId, retainedInputs, pendingFiles, dependencyLocks) {
  closed(agent, ['id', 'scope', 'text']); id(agent.id);
  text(agent.scope);
  body(agent.text, 256 * 1024);
  const candidate = renderCandidateAgent(retainedInputs, agent.id);
  const source = candidate ? 'candidate' : agent.scope === 'repository' ? 'approved-catalog' : 'installed-agent-registry';
  const declarations = retainedInputs.request.definitions?.phases;
  const selected = Array.isArray(declarations) ? declarations.filter((phase) => phase?.id === phaseId) : [];
  const reference = typeof selected[0]?.agent === 'string' ? { source: candidate ? 'candidate' : 'catalog', kind: 'agent', id: selected[0].agent }
    : selected[0]?.agent?.ref ?? selected[0]?.agent;
  if (selected.length !== 1 || !plain(reference) || Object.keys(reference).some((key) => !['source', 'kind', 'id'].includes(key))
      || reference.kind !== 'agent' || reference.id !== agent.id || reference.source !== (candidate ? 'candidate' : 'catalog')) fail('The selected agent differs from the exact retained phase reference.', 'WCA_SKP_SOURCE_STALE');
  if (candidate && (agent.scope !== 'repository' || agent.text !== candidate.text)) fail('The selected candidate agent body differs from its retained request.', 'WCA_SKP_SOURCE_STALE');
  const path = candidate?.path ?? null;
  let parsed;
  try { parsed = parseAgentDependencies(agent.text, { source: path ?? `${agent.id}.agent.md`, agentId: agent.id }); }
  catch { fail('The selected agent body is not an admitted exact Agent Markdown document.'); }
  if (!parsed.defaultFor.includes(phaseId) || parsed.phases.length && !parsed.phases.includes(phaseId)) fail('The selected agent body does not declare the reviewed phase default.');
  const textSha256 = bytesDigest(Buffer.from(agent.text));
  if (candidate) {
    const emitted = pendingFiles?.find((file) => file.path === path);
    if (!emitted || emitted.sha256 !== textSha256 || emitted.contentBase64 !== Buffer.from(agent.text).toString('base64')) fail('The selected candidate agent body differs from the exact pending file.', 'WCA_SKP_SOURCE_STALE');
  } else {
    const locks = dependencyLocks.filter((lock) => lock.kind === 'agent' && lock.id === agent.id);
    if (locks.length !== 1 || locks[0].source !== source || locks[0].definitionSha256 !== digest({ id: agent.id, scope: agent.scope, textSha256 })) fail('The selected approved agent body differs from its retained dependency identity.', 'WCA_SKP_SOURCE_STALE');
  }
  return { id: agent.id, scope: agent.scope, source, path, bytes: Buffer.byteLength(agent.text), textSha256, bodyBase64: Buffer.from(agent.text).toString('base64') };
}
function validateAgentBodyEvidence(evidence, phaseId, retainedInputs, emitted, dependencyLocks) {
  closed(evidence, ['id', 'scope', 'source', 'path', 'bytes', 'textSha256', 'bodyBase64']);
  id(evidence.id); sha(evidence.textSha256);
  if (!Number.isSafeInteger(evidence.bytes) || evidence.bytes < 1 || evidence.bytes > 256 * 1024 || typeof evidence.bodyBase64 !== 'string'
      || evidence.bodyBase64.length > Math.ceil(256 * 1024 / 3) * 4) fail('The selected agent body proof exceeds its budget.', 'WCA_SKP_FINALIZATION_LIMIT');
  const bytes = Buffer.from(evidence.bodyBase64, 'base64');
  if (bytes.length !== evidence.bytes || bytes.toString('base64') !== evidence.bodyBase64 || bytesDigest(bytes) !== evidence.textSha256
      || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('The selected agent body proof is inconsistent.');
  const expected = agentBodyEvidence({ id: evidence.id, scope: evidence.scope, text: bytes.toString('utf8') }, phaseId, retainedInputs, emitted, dependencyLocks);
  if (canonicalJson(expected) !== canonicalJson(evidence)) fail('The selected agent body origin or emitted file is inconsistent.');
}
function captured(prepared) {
  const result = PREPARED.get(prepared);
  if (!result) fail('Use an owner-prepared SKP subject, not caller-written subject JSON.', 'WCA_SKP_SUBJECT_UNAVAILABLE');
  return result;
}
function reviewForSubject(subject) {
  const planCore = { schemaVersion: 1, kind: 'workflow-authoring-skp-consent-plan', subject,
    revision: subject.subjectSha256, effect: subject.intendedEffect, approval: 'not-granted', activation: 'inactive', execution: 'not-started' };
  const planHash = recordSha256(planCore);
  return freeze({ plan: { ...planCore, planId: `wca-skp-${planHash.slice(0, 24)}`, planHash },
    action: { actionId: `workflow-skp-confirm-${planHash.slice(0, 24)}`, label: 'Review skill contracts', effect: subject.intendedEffect,
      confirmation: { required: true, mode: 'one-time-authorization' } } });
}

/**
 * Pure content capture. The trusted compiler supplies source provenance separately; this private
 * brand only prevents subsequent JSON substitutions. No consent or producer approval is created.
 * Existing candidate-producer eligibility is retained verbatim. A new producer requires an exact
 * explicit request declaration and a separately displayed classification decision, effective only
 * for this inactive review projection after consumption. It never approves a package catalog.
 */
export function prepareWorkflowSkillFinalization(input) {
  const data = copy(input);
  closed(data, ['source', 'approvedSource', 'retainedInputs', 'phases', 'dependencyLocks', 'policySha256', 'classificationRequests', 'candidateDefinition', 'pendingFiles'],
    ['source', 'approvedSource', 'retainedInputs', 'phases', 'dependencyLocks', 'policySha256']);
  closed(data.retainedInputs, ['request', 'assets']);
  if (!plain(data.retainedInputs.request)) fail('The exact retained workflow request is required.');
  data.retainedInputs.assets = files(data.retainedInputs.assets, WCA_SKP_FINALIZATION_LIMITS.packageBytes);
  validateSource(data.source, data.approvedSource, data.retainedInputs); sha(data.policySha256);
  if (data.candidateDefinition !== undefined && (!plain(data.candidateDefinition) || !plain(data.candidateDefinition.phases))) fail('The exact pending configuration definition is required.');
  if (data.pendingFiles !== undefined) {
    data.pendingFiles = files(data.pendingFiles, WCA_SKP_FINALIZATION_LIMITS.closureBytes);
    if (data.pendingFiles.some((file) => file.path === 'singularity/workflow.yml')) fail('The pre-consent pending closure cannot contain a future finalized workflow.');
  }
  if (!Array.isArray(data.dependencyLocks) || data.dependencyLocks.length > 256) fail('The dependency identity closure exceeds its budget.', 'WCA_SKP_FINALIZATION_LIMIT');
  for (const lock of data.dependencyLocks) {
    closed(lock, ['source', 'kind', 'id', 'definitionSha256', 'baseRevision']);
    text(lock.source); text(lock.kind); text(lock.id, 1024); sha(lock.definitionSha256);
    if (lock.baseRevision !== data.approvedSource.baseRevision) fail('A dependency lock belongs to another approved base.', 'WCA_SKP_SOURCE_STALE');
  }
  if (!Array.isArray(data.phases) || !data.phases.length || data.phases.length > WCA_SKP_FINALIZATION_LIMITS.phases) fail('A bounded nonempty skill phase closure is required.', 'WCA_SKP_FINALIZATION_LIMIT');
  const requests = data.classificationRequests ?? [];
  if (!Array.isArray(requests) || requests.length > WCA_SKP_FINALIZATION_LIMITS.phases) fail('Producer classification requests exceed their budget.', 'WCA_SKP_FINALIZATION_LIMIT');
  const classifications = new Map();
  for (const request of requests) {
    closed(request, ['skillId', 'packageSha256', 'profile', 'eligibility']); id(request.skillId); sha(request.packageSha256);
    if (request.profile !== WCA_SKP_LOCAL_PRODUCER_PROFILE || request.eligibility !== 'candidate-producer' || classifications.has(request.skillId)) fail('Producer classification must be explicit, unique and use the admitted artifact-only review profile.', 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE');
    const skillDefinitions = data.retainedInputs.request.definitions?.skills;
    const selectedDefinitions = Array.isArray(skillDefinitions) ? skillDefinitions.filter((skill) => skill?.id === request.skillId) : [];
    const selectedDefinition = selectedDefinitions.length === 1 ? selectedDefinitions[0] : null;
    const declared = selectedDefinition?.producerClassification;
    if (!declared || canonicalJson(declared) !== canonicalJson({ profile: request.profile, eligibility: request.eligibility })) fail('Producer classification is absent from the exact retained draft.', 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE');
    if (!Array.isArray(selectedDefinition.operationBindings) || selectedDefinition.operationBindings.length) fail('Local reviewed classification cannot introduce skill operations.', 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE');
    classifications.set(request.skillId, request);
  }
  const phaseIds = new Set(); const packages = new Map(); const loweringCatalogs = new Map(); const usedClassifications = new Set(); let packageBytes = 0;
  const rows = data.phases.map((entry) => {
    closed(entry, ['phase', 'catalog', 'phaseOrder', 'agent', 'package']);
    id(entry.phase?.id); if (phaseIds.has(entry.phase.id)) fail('Skill phases cannot repeat.'); phaseIds.add(entry.phase.id);
    if (Object.hasOwn(data.candidateDefinition?.phases ?? {}, entry.phase.id)) fail('Confirmed lowering cannot silently replace an existing phase.');
    if (!Array.isArray(entry.phaseOrder) || !entry.phaseOrder.length || entry.phaseOrder.length > WCA_SKP_FINALIZATION_LIMITS.phases) fail('Workflow phase order exceeds its budget.', 'WCA_SKP_FINALIZATION_LIMIT');
    const agent = agentBodyEvidence(entry.agent, entry.phase.id, data.retainedInputs, data.pendingFiles, data.dependencyLocks);
    closed(entry.package, ['manifest', 'files']);
    entry.package.files = files(entry.package.files, WCA_SKP_FINALIZATION_LIMITS.packageBytes);
    const contents = new Map(entry.package.files.map((file) => [file.path, Buffer.from(file.contentBase64, 'base64')]));
    verifySkillPackage({ manifest: entry.package.manifest, contents });
    if (entry.package.manifest.skillId !== entry.phase.skill?.id || entry.package.manifest.packageSha256 !== entry.phase.skill?.packageSha256) fail('The retained package does not bind the selected skill.', 'WCA_SKP_SOURCE_STALE');
    const known = packages.get(entry.phase.skill.id);
    if (known && canonicalJson(known) !== canonicalJson(entry.package.manifest)) fail('One selected skill ID cannot name different retained packages.');
    if (!known) { packages.set(entry.phase.skill.id, entry.package.manifest); packageBytes += entry.package.files.reduce((total, file) => total + file.bytes, 0); }
    if (packageBytes > WCA_SKP_FINALIZATION_LIMITS.packageBytes) fail('The retained skill packages exceed their aggregate budget.', 'WCA_SKP_FINALIZATION_LIMIT');
    const proposal = compileSkillPhaseProposal(entry);
    const classification = classifications.get(entry.phase.skill.id);
    const loweringCatalog = structuredClone(entry.catalog);
    if (classification) {
      if (proposal.eligibility !== 'proposed-candidate-producer' || classification.packageSha256 !== entry.package.manifest.packageSha256
          || proposal.phasePolicy.writeScope !== 'artifact-only' || proposal.bindingRefs.sourceScope !== null
          || proposal.bindingRefs.readScope.sourcePaths.length || proposal.bindingRefs.codeDeliverySha256 !== null
          || proposal.phasePolicy.generation.task === 'code' || data.retainedInputs.request.target?.hosts?.length
          || data.retainedInputs.request.executionProposals?.length) fail('The explicit local classification cannot introduce source or host effects, or reclassify an approved catalog.', 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE');
      usedClassifications.add(classification.skillId);
      loweringCatalog.skillPackages[classification.skillId].eligibility = classification.eligibility;
    }
    const intended = compileSkillPhaseProposal({ phase: entry.phase, catalog: loweringCatalog, phaseOrder: entry.phaseOrder });
    loweringCatalogs.set(entry.phase.id, loweringCatalog);
    return { phaseId: entry.phase.id, selectedAgent: agent, phaseOrder: entry.phaseOrder, phase: entry.phase,
      contractSha256: proposal.bindingRefs.contractSha256, catalogSha256: proposal.bindingRefs.catalogSha256,
      candidateSha256: proposal.candidateSha256, packageSha256: entry.phase.skill.packageSha256,
      producerEligibility: proposal.eligibility, proposalSha256: proposal.proposalSha256,
      intendedClassification: classification ?? null, confirmationCatalogSha256: intended.bindingRefs.catalogSha256,
      confirmationCandidateSha256: intended.candidateSha256,
      phasePolicy: proposal.phasePolicy, bindingRefs: proposal.bindingRefs };
  }).sort((left, right) => left.phaseId < right.phaseId ? -1 : left.phaseId > right.phaseId ? 1 : 0);
  if (usedClassifications.size !== classifications.size) fail('Every reviewed producer classification must bind a selected exact phase package.', 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE');
  const core = { schemaVersion: currentSchemaVersion('workflow-authoring-skp-preconsent-subject'), kind: 'workflow-authoring-skp-preconsent-subject', profile: WCA_SKP_PRECONSENT_PROFILE,
    source: data.source, approvedSource: data.approvedSource, retainedInputsSha256: digest(data.retainedInputs),
    policySha256: data.policySha256, dependencyLocks: data.dependencyLocks,
    candidateDefinitionSha256: data.candidateDefinition ? digest(data.candidateDefinition) : null,
    pendingFilesSha256: data.pendingFiles ? digest(data.pendingFiles) : null,
    packages: [...packages.values()].sort((left, right) => left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0), phases: rows,
    classificationDecisions: requests.map((request) => ({ ...request, manifest: packages.get(request.skillId),
      effect: 'inactive-review-candidate-only', approvedCatalogChanged: false })),
    intendedEffect: 'create-inactive-configuration-review-proposal', sourceProvenance: 'requires-approved-compiler-capture',
    consent: 'absent', approval: 'not-granted', activation: 'inactive', execution: 'not-started', effects: effects() };
  if (Buffer.byteLength(canonicalJson(core)) > WCA_SKP_FINALIZATION_LIMITS.subjectBytes) fail('The exact review subject exceeds its display budget.', 'WCA_SKP_FINALIZATION_LIMIT');
  const subject = freeze({ ...core, subjectSha256: domainDigest(WCA_SKP_PRECONSENT_PROFILE, core) });
  const eligible = rows.every((row) => row.producerEligibility === 'candidate-producer' || row.intendedClassification);
  const prepared = freeze({ kind: 'workflow-authoring-skp-prepared', profile: WCA_SKP_PRECONSENT_PROFILE, subject,
    finalization: eligible ? 'requires-exact-terminal-consent' : 'producer-classification-unavailable', effects: effects() });
  const review = reviewForSubject(subject);
  PREPARED.set(prepared, { data, rows, review, eligible, loweringCatalogs }); return prepared;
}

export function workflowSkillFinalizationReview(prepared) { return captured(prepared).review; }

/** Compiler-facing adapter: exact pending bytes are supplied by its owner, never read from disk. */
export function prepareWorkflowSkillConsent(input) {
  const data = copy(input, 24 * 1024 * 1024);
  closed(data, ['source', 'approvedSource', 'request', 'snapshotInputs', 'candidateDefinition', 'pendingFiles', 'entries', 'dependencyLocks', 'policySha256'],
    ['source', 'approvedSource', 'request', 'snapshotInputs', 'candidateDefinition', 'pendingFiles', 'entries']);
  closed(data.snapshotInputs, ['request', 'assets']);
  if (canonicalJson(data.request) !== canonicalJson(data.snapshotInputs.request)) fail('The compiler request differs from the exact retained input closure.', 'WCA_SKP_SOURCE_STALE');
  if (!Array.isArray(data.pendingFiles) || data.pendingFiles.length > WCA_SKP_FINALIZATION_LIMITS.files || !Array.isArray(data.entries)) fail('The pending compiler closure must be bounded.', 'WCA_SKP_FINALIZATION_LIMIT');
  const pending = data.pendingFiles.map((file) => {
    if (Object.hasOwn(file, 'contentBase64')) return file;
    closed(file, ['path', 'bytes', 'sha256', 'content']);
    if (typeof file.content !== 'string') fail('Pending candidate files must retain exact literal text bytes.');
    return { path: file.path, bytes: file.bytes, sha256: file.sha256, contentBase64: Buffer.from(file.content).toString('base64') };
  }).map((file) => {
    // Proposal-file mode is a fixed inert blob and is not part of the package's relative manifest.
    if (Object.hasOwn(file, 'mode')) { if (file.mode !== '100644') fail('Pending files cannot contain executable modes.'); const { mode, ...rest } = file; return rest; }
    return file;
  });
  const pendingFiles = files(pending, WCA_SKP_FINALIZATION_LIMITS.closureBytes);
  const classifications = new Map();
  const phases = data.entries.map((entry) => {
    closed(entry, ['phase', 'catalog', 'phaseOrder', 'packageManifest', 'producerClassification', 'agent'],
      ['phase', 'catalog', 'phaseOrder', 'packageManifest', 'agent']);
    closed(entry.agent, ['id', 'scope', 'text', 'definitionSha256'], ['id', 'scope', 'text']);
    const { definitionSha256, ...agent } = entry.agent;
    if (definitionSha256 !== undefined && definitionSha256 !== digest({ id: agent.id, scope: agent.scope, textSha256: bytesDigest(Buffer.from(agent.text)) })) fail('The selected agent identity differs from its exact body.', 'WCA_SKP_SOURCE_STALE');
    const prefix = `singularity/skills/${entry.phase.skill?.id}/`;
    const packageFiles = pendingFiles.filter((file) => file.path.startsWith(prefix)).map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
    if (entry.producerClassification !== undefined) {
      closed(entry.producerClassification, ['profile', 'eligibility']);
      const request = { skillId: entry.phase.skill.id, packageSha256: entry.packageManifest.packageSha256, ...entry.producerClassification };
      if (classifications.has(request.skillId) && canonicalJson(classifications.get(request.skillId)) !== canonicalJson(request)) fail('Selected phases disagree on one producer classification.');
      classifications.set(request.skillId, request);
    }
    return { phase: entry.phase, catalog: entry.catalog, phaseOrder: entry.phaseOrder, agent, package: { manifest: entry.packageManifest, files: packageFiles } };
  });
  return prepareWorkflowSkillFinalization({ source: data.source, approvedSource: data.approvedSource, retainedInputs: data.snapshotInputs, phases,
    dependencyLocks: data.dependencyLocks ?? [], policySha256: data.policySha256 ?? digest(data.candidateDefinition),
    candidateDefinition: data.candidateDefinition, pendingFiles,
    classificationRequests: [...classifications.values()] });
}

export function assertWorkflowSkillPreConsentIdentity(prepared, expectedSubjectSha256) {
  captured(prepared); sha(expectedSubjectSha256);
  if (prepared.subject.subjectSha256 !== expectedSubjectSha256) fail('Draft, authority, package, agent, order or policy changed; review a fresh subject.', 'WCA_SKP_SUBJECT_STALE');
  return true;
}

/** Only this existing-owner consumption can mint the private, same-process, one-use capability. */
export async function consumeWorkflowSkillFinalizationConsent(root, prepared, token) {
  const selected = captured(prepared);
  if (!selected.eligible) fail('Proposed producer eligibility requires a separate explicit reviewed classification; consent cannot promote it.', 'WCA_SKP_PRODUCER_CLASSIFICATION_UNAVAILABLE');
  if (typeof root !== 'string' || !root || typeof token !== 'string' || !UUID.test(token)) fail('A real direct-terminal one-use authorization is required.', 'WCA_SKP_CONSENT_REQUIRED');
  const { consumeActionAuthorization } = await import('./action-authorization.mjs');
  const authorization = await consumeActionAuthorization(root, token, selected.review.plan, selected.review.action, { requireTerminalPresentation: true });
  const proof = freeze({ kind: 'workflow-authoring-skp-consumed-consent', subjectSha256: prepared.subject.subjectSha256,
    assurance: 'configured-local-review', authenticatedNativeHost: false, approval: 'not-granted', activation: 'inactive', execution: 'not-started' });
  CONSENTS.set(proof, { prepared, authorization }); return proof;
}

/** Pure, one-use lowering. A boolean, durable JSON receipt or copied capability is never consent. */
export function compileConsentedWorkflowSkillPhases(prepared, consent) {
  const selected = captured(prepared); const accepted = CONSENTS.get(consent);
  CONSENTS.delete(consent);
  if (!accepted || accepted.prepared !== prepared) fail('An exact owner-consumed terminal capability is required.', 'WCA_SKP_CONSENT_REQUIRED');
  const phases = selected.data.phases.map((entry) => {
    const row = selected.rows.find((value) => value.phaseId === entry.phase.id);
    const confirmation = { contractSha256: row.contractSha256, catalogSha256: row.confirmationCatalogSha256,
      packageSha256: row.packageSha256, candidateSha256: row.confirmationCandidateSha256,
      planSha256: prepared.subject.subjectSha256, draftRevision: selected.data.source.revision };
    const compiled = compileConfirmedSkillPhase({ phase: entry.phase, catalog: selected.loweringCatalogs.get(entry.phase.id), phaseOrder: entry.phaseOrder, confirmation });
    return { phaseId: compiled.phaseId, configuredPhase: configurationPhaseFromCompiledSkill(compiled), compilationSha256: compiled.compilationSha256 };
  }).sort((left, right) => left.phaseId < right.phaseId ? -1 : left.phaseId > right.phaseId ? 1 : 0);
  const authorization = accepted.authorization;
  const result = freeze({ kind: 'workflow-authoring-skp-confirmed-projection', profile: WCA_SKP_FINALIZATION_PROFILE,
    preConsentSubjectSha256: prepared.subject.subjectSha256, phases,
    classificationDecisions: prepared.subject.classificationDecisions,
    confirmation: { authorizationId: authorization.authorizationId, questionId: authorization.questionId,
      channel: authorization.channel, assurance: authorization.assurance, actor: copy(authorization.actor, 8192),
      actionPlanSha256: `sha256:${selected.review.plan.planHash}`, authenticatedNativeHost: false },
    approval: 'not-granted', activation: 'inactive', execution: 'not-started', effects: effects() });
  COMPILED.set(result, { prepared, selected }); return result;
}

export const finalizeWorkflowSkillConsent = compileConsentedWorkflowSkillPhases;

/** Same-process compiler check, not a portable receipt, provenance proof or writer permission. */
export function workflowSkillFinalizedProjection(prepared, projection) {
  captured(prepared);
  const retained = COMPILED.get(projection);
  if (!retained || retained.prepared.subject.subjectSha256 !== prepared.subject.subjectSha256
      || canonicalJson(retained.prepared.subject) !== canonicalJson(prepared.subject)) fail('The finalized projection is not bound to this exact prepared subject.', 'WCA_SKP_CONSENT_REQUIRED');
  return projection;
}

/** Seal exact emitted bytes separately; no future finalization hash occurs in an SKP binding. */
export function sealWorkflowSkillFinalization(projection, input) {
  const retained = COMPILED.get(projection);
  if (!retained) fail('Use the exact consented projection, not caller-written bindings.', 'WCA_SKP_CONSENT_REQUIRED');
  const selected = copy(input, 24 * 1024 * 1024); closed(selected, ['definition', 'files']);
  const emitted = files(selected.files, WCA_SKP_FINALIZATION_LIMITS.closureBytes, { mode: true });
  if (!plain(selected.definition) || !plain(selected.definition.phases)) fail('An emitted configuration definition is required.');
  const workflow = emitted.find((file) => file.path === 'singularity/workflow.yml');
  if (!workflow) fail('The emitted closure is missing its exact workflow definition.');
  let parsed;
  try { parsed = YAML.parse(Buffer.from(workflow.contentBase64, 'base64').toString('utf8')); } catch { fail('The emitted workflow definition is invalid.'); }
  if (canonicalJson(parsed) !== canonicalJson(selected.definition)) fail('The emitted workflow bytes differ from the exact candidate definition.');
  const pendingDefinition = retained.selected.data.candidateDefinition;
  const pendingFiles = retained.selected.data.pendingFiles;
  if (!pendingDefinition || !pendingFiles) fail('Final emission requires a reviewed complete ordinary candidate and pending byte closure.', 'WCA_SKP_EMITTED_CLOSURE_UNAVAILABLE');
  const expectedDefinition = structuredClone(pendingDefinition);
  for (const phase of projection.phases) expectedDefinition.phases[phase.phaseId] = structuredClone(phase.configuredPhase);
  if (canonicalJson(expectedDefinition) !== canonicalJson(selected.definition)) fail('Only the reviewed confirmed skill phases may change the pending definition after consent.');
  const actualPending = emitted.filter((file) => file.path !== 'singularity/workflow.yml').map(({ mode, ...rest }) => rest);
  const expectedPending = pendingFiles.filter((file) => file.path !== 'singularity/workflow.yml');
  if (canonicalJson(actualPending) !== canonicalJson(expectedPending)) fail('The emitted closure contains unreviewed files or changed pending bytes.');
  for (const phase of projection.phases) if (canonicalJson(selected.definition.phases[phase.phaseId]) !== canonicalJson(phase.configuredPhase)) fail('The emitted definition dropped or changed a confirmed phase.');
  for (const entry of retained.selected.data.phases) {
    const prefix = `singularity/skills/${entry.phase.skill.id}/`;
    const packageFiles = emitted.filter((file) => file.path.startsWith(prefix));
    if (packageFiles.length !== entry.package.files.length || entry.package.files.some((file) => {
      const actual = packageFiles.find((item) => item.path === `${prefix}${file.path}`);
      return !actual || actual.sha256 !== file.sha256 || actual.bytes !== file.bytes || actual.contentBase64 !== file.contentBase64;
    })) fail('The emitted closure differs from the exact reviewed skill package.');
  }
  if (emitted.some((file) => file.path.startsWith('.github/skills/') || file.path.startsWith('.copilot/skills/') || file.path.startsWith('.claude/skills/'))) fail('An inactive review closure cannot install native skill discovery bytes.');
  const core = { schemaVersion: currentSchemaVersion('workflow-authoring-skp-finalization'), kind: 'workflow-authoring-skp-finalization', profile: WCA_SKP_FINALIZATION_PROFILE,
    source: retained.selected.data.source, approvedSource: retained.selected.data.approvedSource,
    preConsentSubjectSha256: projection.preConsentSubjectSha256,
    confirmedBindingsSha256: digest(projection.phases), emittedDefinitionSha256: digest(selected.definition),
    emittedClosureSha256: digest(emitted.map(({ path, mode, bytes, sha256 }) => ({ path, mode, bytes, sha256 }))),
    confirmation: projection.confirmation, bindingDialect: WCA_SKP_PRECONSENT_PROFILE,
    classificationDecisions: projection.classificationDecisions,
    approval: 'not-granted', activation: 'inactive', execution: 'not-started', effects: effects() };
  return freeze({ ...core, finalizationSha256: domainDigest(WCA_SKP_FINALIZATION_PROFILE, core) });
}

/**
 * Offline integrity only. Historical JSON can be checked without a live terminal witness, but this
 * return value has no private brand and cannot be used to lower, stage, approve or run a package.
 */
export function validateWorkflowSkillFinalizationRecord(input) {
  const data = copy(input, 24 * 1024 * 1024); closed(data, ['subject', 'record', 'definition', 'files', 'retainedInputs']);
  const { subject, record, definition } = data;
  closed(subject, ['schemaVersion', 'kind', 'profile', 'source', 'approvedSource', 'retainedInputsSha256', 'policySha256', 'dependencyLocks',
    'candidateDefinitionSha256', 'pendingFilesSha256', 'packages', 'phases', 'classificationDecisions', 'intendedEffect', 'sourceProvenance',
    'consent', 'approval', 'activation', 'execution', 'effects', 'subjectSha256']);
  closed(record, ['schemaVersion', 'kind', 'profile', 'source', 'approvedSource', 'preConsentSubjectSha256', 'confirmedBindingsSha256',
    'emittedDefinitionSha256', 'emittedClosureSha256', 'confirmation', 'bindingDialect', 'classificationDecisions', 'approval', 'activation', 'execution', 'effects', 'finalizationSha256']);
  if (readRecord('workflow-authoring-skp-preconsent-subject', subject).storedVersion !== 1
      || readRecord('workflow-authoring-skp-finalization', record).storedVersion !== 1
      || subject.kind !== 'workflow-authoring-skp-preconsent-subject' || subject.profile !== WCA_SKP_PRECONSENT_PROFILE
      || record.kind !== 'workflow-authoring-skp-finalization' || record.profile !== WCA_SKP_FINALIZATION_PROFILE
      || record.bindingDialect !== WCA_SKP_PRECONSENT_PROFILE) fail('The retained finalization profile is unsupported.');
  const { subjectSha256, ...subjectCore } = subject; const { finalizationSha256, ...recordCore } = record;
  if (domainDigest(WCA_SKP_PRECONSENT_PROFILE, subjectCore) !== sha(subjectSha256)
      || domainDigest(WCA_SKP_FINALIZATION_PROFILE, recordCore) !== sha(finalizationSha256)
      || record.preConsentSubjectSha256 !== subjectSha256) fail('The retained finalization domains do not match.');
  if (Buffer.byteLength(canonicalJson(subject)) > WCA_SKP_FINALIZATION_LIMITS.subjectBytes) fail('The retained subject exceeds its budget.', 'WCA_SKP_FINALIZATION_LIMIT');
  if (subject.intendedEffect !== 'create-inactive-configuration-review-proposal' || subject.sourceProvenance !== 'requires-approved-compiler-capture'
      || subject.consent !== 'absent' || [subject, record].some((value) => value.approval !== 'not-granted' || value.activation !== 'inactive'
        || value.execution !== 'not-started' || canonicalJson(value.effects) !== canonicalJson(effects()))
      || canonicalJson(record.source) !== canonicalJson(subject.source) || canonicalJson(record.approvedSource) !== canonicalJson(subject.approvedSource)
      || canonicalJson(record.classificationDecisions) !== canonicalJson(subject.classificationDecisions)) fail('Retained finalization cannot claim approval, activation or execution.');
  closed(subject.source, ['kind', 'schemaVersion', 'repository', 'workspaceId', 'draftId', 'revision', 'lifecycleEpoch', 'revisionSha256', 'head', 'payloadSha256', 'assetManifestSha256', 'lifecycle']);
  closed(subject.approvedSource, ['kind', 'repository', 'ref', 'observedCommit', 'baseRevision', 'workflowSha256']);
  if (subject.source.schemaVersion !== 1) fail('The retained compiler source view is unsupported.'); // schema-transient: frozen compiler view inside the registered snapshot
  if (subject.source.kind !== 'workflow-authoring-draft-source' || subject.source.workspaceId !== 'configuration'
      || !/^WFD-[A-Z0-9]{6,32}$/u.test(subject.source.draftId ?? '') || subject.approvedSource.kind === 'working-tree'
      || subject.source.lifecycle !== 'live' || subject.source.lifecycleEpoch !== 1 || subject.source.repository !== subject.approvedSource.repository
      || !OID.test(subject.source.head ?? '') || !OID.test(subject.approvedSource.observedCommit ?? '') || !OID.test(subject.approvedSource.baseRevision ?? '')) fail('Retained sources do not bind one exact live scope.');
  text(subject.source.repository, 4096); text(subject.approvedSource.repository, 4096); text(subject.approvedSource.kind); text(subject.approvedSource.ref, 1024);
  integer(subject.source.revision); sha(subject.source.revisionSha256); sha(subject.source.payloadSha256); sha(subject.source.assetManifestSha256); sha(subject.approvedSource.workflowSha256);
  for (const field of ['retainedInputsSha256', 'policySha256', 'candidateDefinitionSha256', 'pendingFilesSha256']) sha(subject[field]);
  closed(data.retainedInputs, ['request', 'assets']);
  data.retainedInputs.assets = files(data.retainedInputs.assets, WCA_SKP_FINALIZATION_LIMITS.packageBytes);
  if (digest(data.retainedInputs) !== subject.retainedInputsSha256) fail('The retained agent request closure differs from the reviewed subject.');
  validateSource(subject.source, subject.approvedSource, data.retainedInputs);
  closed(record.confirmation, ['authorizationId', 'questionId', 'channel', 'assurance', 'actor', 'actionPlanSha256', 'authenticatedNativeHost']);
  const review = reviewForSubject(subject);
  if (!UUID.test(record.confirmation.authorizationId ?? '') || record.confirmation.questionId !== recordSha256({ planId: review.plan.planId, actionId: review.action.actionId, channel: 'terminal' }).slice(0, 24)
      || record.confirmation.channel !== 'terminal' || record.confirmation.assurance !== 'configured-local-review'
      || record.confirmation.authenticatedNativeHost !== false || record.confirmation.actionPlanSha256 !== `sha256:${review.plan.planHash}`) fail('The retained local review identity is inconsistent.');
  closed(record.confirmation.actor, ['name', 'email', 'login', 'githubLookup']);
  for (const field of ['name', 'email', 'login']) if (record.confirmation.actor[field] !== null && (typeof record.confirmation.actor[field] !== 'string' || Buffer.byteLength(record.confirmation.actor[field]) > 4096)) fail('The retained local actor metadata is invalid.');
  if (!['resolved', 'not-checked', 'unavailable'].includes(record.confirmation.actor.githubLookup)) fail('The retained local actor lookup state is invalid.');
  const emitted = files(data.files, WCA_SKP_FINALIZATION_LIMITS.closureBytes, { mode: true });
  if (!plain(definition) || !plain(definition.phases)) fail('The retained emitted definition is invalid.');
  const workflow = emitted.find((file) => file.path === 'singularity/workflow.yml'); let parsed;
  try { parsed = workflow && YAML.parse(Buffer.from(workflow.contentBase64, 'base64').toString('utf8')); } catch { fail('The retained emitted workflow bytes are invalid.'); }
  if (!workflow || canonicalJson(parsed) !== canonicalJson(definition) || digest(definition) !== record.emittedDefinitionSha256
      || digest(emitted.map(({ path, mode, bytes, sha256 }) => ({ path, mode, bytes, sha256 }))) !== record.emittedClosureSha256
      || digest(emitted.filter((file) => file.path !== 'singularity/workflow.yml').map(({ mode, ...rest }) => rest)) !== subject.pendingFilesSha256
      || emitted.some((file) => file.path.startsWith('.github/skills/') || file.path.startsWith('.copilot/skills/') || file.path.startsWith('.claude/skills/'))) fail('The retained emitted closure is inconsistent or installs native skill bytes.');
  if (!Array.isArray(subject.phases) || !subject.phases.length || subject.phases.length > WCA_SKP_FINALIZATION_LIMITS.phases
      || !Array.isArray(subject.packages) || subject.packages.length > WCA_SKP_FINALIZATION_LIMITS.phases
      || !Array.isArray(subject.classificationDecisions) || subject.classificationDecisions.length > WCA_SKP_FINALIZATION_LIMITS.phases
      || !Array.isArray(subject.dependencyLocks) || subject.dependencyLocks.length > 256) fail('The retained selected closure exceeds its budget.', 'WCA_SKP_FINALIZATION_LIMIT');
  const packageIds = new Set(); let packageBytes = 0;
  for (const manifest of subject.packages) {
    if (packageIds.has(manifest.skillId)) fail('Retained packages repeat a skill identity.'); packageIds.add(id(manifest.skillId));
    const prefix = `singularity/skills/${manifest.skillId}/`;
    const contents = new Map(emitted.filter((file) => file.path.startsWith(prefix)).map((file) => [file.path.slice(prefix.length), Buffer.from(file.contentBase64, 'base64')]));
    const verified = verifySkillPackage({ manifest, contents }); packageBytes += verified.bytes;
  }
  if (packageBytes > WCA_SKP_FINALIZATION_LIMITS.packageBytes) fail('Retained packages exceed the aggregate budget.', 'WCA_SKP_FINALIZATION_LIMIT');
  const decisions = new Map();
  for (const decision of subject.classificationDecisions) {
    closed(decision, ['skillId', 'packageSha256', 'profile', 'eligibility', 'manifest', 'effect', 'approvedCatalogChanged']);
    if (decisions.has(decision.skillId) || decision.profile !== WCA_SKP_LOCAL_PRODUCER_PROFILE || decision.eligibility !== 'candidate-producer'
        || decision.effect !== 'inactive-review-candidate-only' || decision.approvedCatalogChanged !== false
        || canonicalJson(subject.packages.find((manifest) => manifest.skillId === decision.skillId)) !== canonicalJson(decision.manifest)
        || decision.packageSha256 !== decision.manifest.packageSha256) fail('The retained explicit producer decision is inconsistent.');
    decisions.set(decision.skillId, decision);
  }
  for (const lock of subject.dependencyLocks) {
    closed(lock, ['source', 'kind', 'id', 'definitionSha256', 'baseRevision']);
    text(lock.source); text(lock.kind); text(lock.id, 1024); sha(lock.definitionSha256);
    if (lock.baseRevision !== subject.approvedSource.baseRevision) fail('A retained dependency belongs to another approved base.');
  }
  const originalDefinition = structuredClone(definition); const phases = []; const phaseIds = new Set(); const usedDecisions = new Set(); const usedPackages = new Set();
  for (const row of subject.phases) {
    closed(row, ['phaseId', 'selectedAgent', 'phaseOrder', 'phase', 'contractSha256', 'catalogSha256', 'candidateSha256', 'packageSha256',
      'producerEligibility', 'proposalSha256', 'intendedClassification', 'confirmationCatalogSha256', 'confirmationCandidateSha256', 'phasePolicy', 'bindingRefs']);
    id(row.phaseId); if (phaseIds.has(row.phaseId)) fail('Retained skill phases repeat.'); phaseIds.add(row.phaseId);
    validateAgentBodyEvidence(row.selectedAgent, row.phaseId, data.retainedInputs, emitted, subject.dependencyLocks);
    closed(row.phase, ['id', 'kind', 'label', 'skill', 'contract']); closed(row.phase.skill, ['id', 'packageSha256']);
    if (!Array.isArray(row.phaseOrder) || row.phaseOrder.length > WCA_SKP_FINALIZATION_LIMITS.phases || new Set(row.phaseOrder).size !== row.phaseOrder.length
        || row.phaseOrder.some((phaseId) => !ID.test(phaseId)) || !row.phaseOrder.includes(row.phaseId)
        || row.phase.id !== row.phaseId || row.phase.kind !== 'skill' || row.contractSha256 !== skillContractSha256(row.phaseId, row.phase.contract)
        || row.candidateSha256 !== skillPhaseCandidateSha256(row.phase, row.phaseOrder, sha(row.catalogSha256))
        || row.confirmationCandidateSha256 !== skillPhaseCandidateSha256(row.phase, row.phaseOrder, sha(row.confirmationCatalogSha256))
        || row.packageSha256 !== row.phase.skill.packageSha256 || !subject.packages.some((manifest) => manifest.skillId === row.phase.skill.id && manifest.packageSha256 === row.packageSha256)) fail('The retained phase subject is inconsistent.');
    usedPackages.add(row.phase.skill.id);
    const orders = Object.values(definition.workTypes ?? {}).filter((workflow) => workflow.phases?.includes(row.phaseId)).map((workflow) => workflow.phases);
    if (!orders.length || orders.some((order) => canonicalJson(order) !== canonicalJson(row.phaseOrder))) fail('The retained final workflow order differs from the reviewed skill order.');
    const decision = decisions.get(row.phase.skill.id);
    if (row.producerEligibility === 'proposed-candidate-producer') {
      if (!decision || canonicalJson(row.intendedClassification) !== canonicalJson({ skillId: decision.skillId, packageSha256: decision.packageSha256, profile: decision.profile, eligibility: decision.eligibility })
          || row.phasePolicy.writeScope !== 'artifact-only' || row.bindingRefs.sourceScope !== null || row.bindingRefs.readScope?.sourcePaths?.length !== 0
          || row.bindingRefs.codeDeliverySha256 !== null || row.phasePolicy.generation?.task === 'code') fail('Retained proposed eligibility has no exact bounded reviewed classification.');
      usedDecisions.add(decision.skillId);
    } else if (row.producerEligibility !== 'candidate-producer' || row.intendedClassification !== null || decision
        || row.catalogSha256 !== row.confirmationCatalogSha256 || row.candidateSha256 !== row.confirmationCandidateSha256) fail('Retained catalog eligibility cannot be silently promoted.');
    const proposal = { schemaVersion: 1, kind: 'skp-skill-phase-proposal', compiler: SKP_CONTRACT_COMPILER, phaseId: row.phaseId,
      phasePolicy: row.phasePolicy, bindingRefs: row.bindingRefs, candidateSha256: row.candidateSha256, eligibility: row.producerEligibility,
      status: 'proposal-only', confirmation: 'absent', execution: 'not-run' };
    if (digest(proposal) !== row.proposalSha256 || Object.hasOwn(row.bindingRefs, 'confirmation')) fail('A pre-consent proposal cannot contain a confirmed binding.');
    const configured = definition.phases[row.phaseId]; validateConfiguredSkillPhase(configured, row.phaseId);
    const expectedRefs = { ...row.bindingRefs, catalogSha256: row.confirmationCatalogSha256,
      confirmation: { planSha256: subjectSha256, candidateSha256: row.confirmationCandidateSha256, draftRevision: subject.source.revision } };
    const { kind, skillBinding, ...phasePolicy } = configured;
    if (kind !== 'skill' || canonicalJson(phasePolicy) !== canonicalJson(row.phasePolicy) || canonicalJson(skillBinding.bindingRefs) !== canonicalJson(expectedRefs)) fail('The retained configured binding does not match its reviewed subject.');
    phases.push({ phaseId: row.phaseId, configuredPhase: configured, compilationSha256: skillBinding.compilationSha256 }); delete originalDefinition.phases[row.phaseId];
  }
  phases.sort((left, right) => left.phaseId < right.phaseId ? -1 : left.phaseId > right.phaseId ? 1 : 0);
  if (digest(phases) !== record.confirmedBindingsSha256 || digest(originalDefinition) !== subject.candidateDefinitionSha256
      || usedDecisions.size !== decisions.size || usedPackages.size !== packageIds.size) fail('The retained finalized closure is incomplete or changes unreviewed ordinary policy.');
  return freeze({ structurallyConsistent: true, profile: WCA_SKP_FINALIZATION_PROFILE, subjectSha256, finalizationSha256,
    authority: 'none', consent: 'historical-local-review-only', approval: 'not-granted', activation: 'inactive', execution: 'not-started', effects: effects() });
}
