/**
 * Pure lowering of one already confirmed SKP authoring phase.
 *
 * WCA must authenticate the human plan confirmation and the existing configuration owner must
 * supply an approved, exact candidate catalog. The digests checked here detect stale inputs;
 * they are not evidence of actor authority or current host enforcement. This module neither reads
 * skill prose nor executes catalog commands. Its ordinary `phasePolicy` still needs a registered
 * schema/reader and a retained skill/template execution path before a workflow writer may use it.
 *
 * Catalog shape: { skillPackages, phases, checks, approvalAuthorities, approvalSecurity,
 * artifactSets?, sourceScopes?, readPaths?, codeDelivery? }. Every selected check is a reviewed
 * structured command object; phase outputs in `phases` have exact {id, path} references.
 */
import path from 'node:path';

import { normalizeApprovalPolicy } from './approval-authority.mjs';
import { normalizeArtifactSet } from './artifact-sets.mjs';
import { normalizeCodeDeliveryPolicy } from './code-delivery-policy.mjs';
import { normalizeClarificationPolicy } from './clarifications.mjs';
import { normalizeExternalCommand } from './external-command-policy.mjs';
import { assertModelTask } from './model-tasks.mjs';
import { canonicalJson, recordSha256 } from './records.mjs';
import { isPortableRepositoryPathComponent, SingularityFlowError } from './util.mjs';

export const SKP_CONTRACT_COMPILER = 'skp-contract/v1';
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const KIND = /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|custom:[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const OUTPUT_ROLES = new Set(['criteria', 'planning', 'findings', 'evidence', 'none']);
const CLAUSE_MODES = new Set(['required', 'optional', 'none']);
const COMMAND_FIELDS = new Set([
  'id', 'argv', 'command', 'modelPolicy', 'requirement', 'timeoutMs', 'kind',
  'environment', 'workingDirectory', 'affectedRoots', 'result'
]);

function fail(code, message, details = null) {
  throw new SingularityFlowError(message, { code, ...(details ? { details } : {}) });
}

function plain(value, label, code = 'SKP_CONTRACT_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${label} must be a plain object.`);
  }
  return value;
}

function closed(value, allowed, label, code = 'SKP_CONTRACT_INVALID') {
  plain(value, label, code);
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) fail(code, `${label} contains unsupported field '${field}'.`, { field });
  }
}

function checkedId(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) {
    fail('SKP_CONTRACT_INVALID', `${label} must be a lower-case kebab-case ID.`);
  }
  return value;
}

function checkedDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('SKP_CONTRACT_INVALID', `${label} must be a sha256:<64 lowercase hex> digest.`);
  }
  return value;
}

function jsonSafe(value, label, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') fail('SKP_CONTRACT_INVALID', `${label} must contain only JSON values.`);
  if (seen.has(value)) fail('SKP_CONTRACT_INVALID', `${label} contains a cycle.`);
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[index];
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        fail('SKP_CONTRACT_INVALID', `${label}[${index}] must be an ordinary JSON value.`);
      }
      jsonSafe(descriptor.value, `${label}[${index}]`, seen);
    }
    for (const key of Object.keys(descriptors)) {
      if (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)) {
        fail('SKP_CONTRACT_INVALID', `${label} has non-JSON array field '${key}'.`);
      }
    }
  } else {
    plain(value, label);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!Object.hasOwn(descriptor, 'value')) {
        fail('SKP_CONTRACT_INVALID', `${label}.${key} must be data, not a getter or setter.`);
      }
      jsonSafe(descriptor.value, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function exactPath(value, label, root = 'artifacts') {
  if (typeof value !== 'string' || !value || value.includes('\\')
      || value.startsWith('/') || /^[A-Za-z]:/.test(value)
      || /[\u0000-\u001f\u007f*?\[\]]/.test(value)
      || value.split('/').some((part) => !isPortableRepositoryPathComponent(part))
      || (root && !value.startsWith(`${root}/`))) {
    fail('SKP_OUTPUT_PATH_INVALID', `${label} must be an exact portable path under ${root || 'the repository'}.`);
  }
  return value;
}

/** Exact content identity only; WCA proves the referenced plan was approved by a human. */
export function skillContractSha256(phaseId, contract) {
  jsonSafe(contract, 'Skill contract');
  return `sha256:${recordSha256({ format: SKP_CONTRACT_COMPILER, phaseId, contract })}`;
}

/** Exact catalog identity only; the configuration owner proves its provenance and approval. */
export function skillCandidateCatalogSha256(catalog) {
  jsonSafe(catalog, 'Candidate catalog');
  return `sha256:${recordSha256({ format: SKP_CONTRACT_COMPILER, catalog })}`;
}

/** Covers display/selection/order as well as the contract; a plan owner binds this exact candidate. */
export function skillPhaseCandidateSha256(phase, phaseOrder, catalogSha256) {
  jsonSafe(phase, 'Skill phase');
  jsonSafe(phaseOrder, 'Confirmed workflow order');
  checkedDigest(catalogSha256, 'Candidate catalog digest');
  return `sha256:${recordSha256({
    format: SKP_CONTRACT_COMPILER, phase, phaseOrder, catalogSha256
  })}`;
}

function outputsFor(phase, contract, catalog) {
  if (!Array.isArray(contract.produces) || !contract.produces.length) {
    fail('SKP_CONTRACT_EMPTY', `Skill phase '${phase.id}' needs at least one concrete required artifact output.`);
  }
  const ids = new Set();
  const paths = new Set();
  const outputs = contract.produces.map((raw, index) => {
    const label = `Skill phase '${phase.id}' produces[${index}]`;
    closed(raw, [
      'id', 'path', 'kind', 'mediaType', 'encoding', 'minimumBytes', 'maximumBytes',
      'required', 'clauses', 'claimRole'
    ], label);
    const id = checkedId(raw.id, `${label}.id`);
    const outputPath = exactPath(raw.path, `${label}.path`, `artifacts/${phase.id}`);
    if (ids.has(id) || paths.has(outputPath)) {
      fail('SKP_OUTPUT_DUPLICATE', `${label} repeats an output ID or path.`);
    }
    ids.add(id);
    paths.add(outputPath);
    if (typeof raw.kind !== 'string' || !KIND.test(raw.kind)) {
      fail('SKP_CONTRACT_INVALID', `${label}.kind must be a registered-style kind or custom:<id>.`);
    }
    if (!Number.isSafeInteger(raw.minimumBytes) || raw.minimumBytes < 1
        || !Number.isSafeInteger(raw.maximumBytes) || raw.maximumBytes < raw.minimumBytes) {
      fail('SKP_CONTRACT_INVALID', `${label} needs positive minimumBytes and maximumBytes with maximum >= minimum.`);
    }
    if (raw.required !== undefined && typeof raw.required !== 'boolean') {
      fail('SKP_CONTRACT_INVALID', `${label}.required must be boolean.`);
    }
    if (raw.mediaType !== undefined && (typeof raw.mediaType !== 'string' || !MEDIA_TYPE.test(raw.mediaType))) {
      fail('SKP_CONTRACT_INVALID', `${label}.mediaType is invalid.`);
    }
    if (raw.kind.startsWith('custom:') && !raw.mediaType) {
      fail('SKP_CONTRACT_INVALID', `${label} custom kind needs an explicit mediaType.`);
    }
    if (raw.encoding !== undefined && !['utf-8', 'binary'].includes(raw.encoding)) {
      fail('SKP_CONTRACT_INVALID', `${label}.encoding must be utf-8 or binary.`);
    }
    if (raw.kind.startsWith('custom:') && raw.encoding === undefined) {
      fail('SKP_CONTRACT_INVALID', `${label} custom kind needs an explicit encoding.`);
    }
    if (!CLAUSE_MODES.has(raw.clauses)) {
      fail('SKP_CONTRACT_INVALID', `${label}.clauses must explicitly be required, optional, or none.`);
    }
    if (!OUTPUT_ROLES.has(raw.claimRole)) {
      fail('SKP_CONTRACT_INVALID', `${label}.claimRole must explicitly name a registered SKP role.`);
    }
    return {
      id, path: outputPath, kind: raw.kind, required: raw.required !== false,
      minimumBytes: raw.minimumBytes, maximumBytes: raw.maximumBytes,
      ...(raw.mediaType ? { mediaType: raw.mediaType } : {}),
      ...(raw.encoding ? { encoding: raw.encoding } : {}),
      clauses: raw.clauses, claimRole: raw.claimRole
    };
  });
  if (!outputs.some((output) => output.required)) {
    fail('SKP_CONTRACT_EMPTY', `Skill phase '${phase.id}' needs at least one required artifact output.`);
  }
  const primaryId = contract.primaryOutput ?? (outputs.length === 1 ? outputs[0].id : null);
  const primary = outputs.find((output) => output.id === primaryId);
  if (!primary || !primary.required) {
    fail('SKP_ARTIFACT_SET_INVALID', `Skill phase '${phase.id}' needs one required primaryOutput.`);
  }
  let artifactSet = null;
  if (outputs.length > 1) {
    const setId = checkedId(contract.artifactSet, `Skill phase '${phase.id}' artifactSet`);
    const set = Object.hasOwn(catalog.artifactSets ?? {}, setId)
      ? catalog.artifactSets[setId] : null;
    if (!set) fail('SKP_ARTIFACT_SET_INVALID', `Skill phase '${phase.id}' references unknown artifact set '${setId}'.`);
    artifactSet = normalizeArtifactSet(set, setId);
    const directory = path.posix.dirname(primary.path);
    const members = new Map(artifactSet.members.map((member) => [member.path, member]));
    if (members.size !== outputs.length || artifactSet.primary !== path.posix.relative(directory, primary.path)) {
      fail('SKP_ARTIFACT_SET_INVALID', `Artifact set '${setId}' does not exactly match the skill outputs.`);
    }
    for (const output of outputs) {
      const relative = path.posix.relative(directory, output.path);
      const member = members.get(relative);
      if (!member || member.required !== output.required || member.authority !== 'governed') {
        fail('SKP_ARTIFACT_SET_INVALID', `Artifact set '${setId}' does not bind output '${output.id}' exactly.`);
      }
    }
  } else if (contract.artifactSet !== undefined) {
    fail('SKP_ARTIFACT_SET_INVALID', `Skill phase '${phase.id}' cannot name an artifact set for one output.`);
  }
  const artifact = {
    path: primary.path, kind: primary.kind,
    minimumBytes: primary.minimumBytes, maximumBytes: primary.maximumBytes,
    ...(primary.mediaType ? { allowedMediaTypes: [primary.mediaType] } : {})
  };
  return { artifact, artifactSet: artifactSet?.id ?? null, outputs };
}

function inputsFor(phaseId, contract, catalog, phaseOrder) {
  const rawInputs = contract.consumes ?? [];
  if (!Array.isArray(rawInputs)) fail('SKP_CONTRACT_INVALID', `Skill phase '${phaseId}' consumes must be an array.`);
  const current = phaseOrder.indexOf(phaseId);
  if (current < 0 || current !== phaseOrder.lastIndexOf(phaseId)) {
    fail('SKP_INPUT_ORDER', `Skill phase '${phaseId}' must appear exactly once in the confirmed workflow order.`);
  }
  const seen = new Set();
  const inputs = rawInputs.map((input, index) => {
    const label = `Skill phase '${phaseId}' consumes[${index}]`;
    closed(input, ['phase', 'output', 'required', 'state'], label);
    const source = checkedId(input.phase, `${label}.phase`);
    const output = checkedId(input.output, `${label}.output`);
    const order = phaseOrder.indexOf(source);
    if (order < 0 || order >= current || order !== phaseOrder.lastIndexOf(source)) {
      fail('SKP_INPUT_ORDER', `${label} must reference one earlier phase in the confirmed order.`);
    }
    if (input.required !== true && input.required !== false) {
      fail('SKP_CONTRACT_INVALID', `${label}.required must explicitly be true or false.`);
    }
    if (input.state !== 'approved') {
      fail('SKP_INPUT_STATE_INVALID', `${label}.state must explicitly require approved output.`);
    }
    const sourceOutputs = Object.hasOwn(catalog.phases ?? {}, source)
      ? catalog.phases[source]?.outputs : null;
    const matches = Array.isArray(sourceOutputs)
      ? sourceOutputs.filter((entry) => entry?.id === output) : [];
    if (!matches.length) {
      fail('SKP_INPUT_UNKNOWN', `${label} references unknown output '${output}' from '${source}'.`);
    }
    if (matches.length > 1) {
      fail('SKP_INPUT_AMBIGUOUS', `${label} matches duplicate catalog outputs '${source}/${output}'.`);
    }
    const key = `${source}\u0000${output}`;
    if (seen.has(key)) fail('SKP_INPUT_DUPLICATE', `${label} repeats an input binding.`);
    seen.add(key);
    return {
      phase: source, output, required: input.required, state: 'approved',
      path: exactPath(matches[0].path, `${label} catalog output path`)
    };
  });
  const phases = [...new Set(inputs.map((input) => input.phase))];
  const phaseInputs = phases.map((source) => ({
    phase: source,
    optional: inputs.filter((input) => input.phase === source).every((input) => !input.required)
  }));
  return { phaseInputs, inputs };
}

function checksFor(phaseId, contract, catalog) {
  const ids = contract.checks ?? [];
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(ids).size !== ids.length) {
    fail('SKP_CONTRACT_INVALID', `Skill phase '${phaseId}' checks must be unique approved check IDs.`);
  }
  const commands = ids.map((id, index) => {
    const raw = Object.hasOwn(catalog.checks ?? {}, id) ? catalog.checks[id] : null;
    if (!raw) fail('SKP_CHECK_UNKNOWN', `Skill phase '${phaseId}' references unknown approved check '${id}'.`);
    closed(raw, [...COMMAND_FIELDS], `Approved check '${id}'`, 'SKP_CHECK_INVALID');
    if (raw.id !== id || !Array.isArray(raw.argv) || !raw.argv.length
        || raw.argv.some((arg) => typeof arg !== 'string' || !arg)
        || raw.command !== undefined || raw.modelPolicy === undefined) {
      fail('SKP_CHECK_INVALID', `Approved check '${id}' must be an exact structured argv command.`);
    }
    return normalizeExternalCommand(raw, index);
  });
  return {
    qualityCommands: commands,
    checks: commands.map((command) => ({ id: command.id,
      definitionSha256: `sha256:${recordSha256(command)}` }))
  };
}

function approvalFor(phaseId, contract, catalog) {
  const raw = contract.approval;
  closed(raw, ['authorities', 'minimum', 'requiredAuthorities', 'rejectTo'],
    `Skill phase '${phaseId}' approval`);
  if (!Array.isArray(raw.authorities) || !raw.authorities.length
      || raw.authorities.some((id) => typeof id !== 'string')
      || new Set(raw.authorities).size !== raw.authorities.length) {
    fail('SKP_CONTRACT_INVALID', `Skill phase '${phaseId}' must select unique human authority IDs.`);
  }
  if (!Number.isSafeInteger(raw.minimum) || raw.minimum < 1) {
    fail('SKP_CONTRACT_INVALID', `Skill phase '${phaseId}' approval.minimum must be at least one.`);
  }
  for (const id of raw.authorities) {
    if (!Object.hasOwn(catalog.approvalAuthorities ?? {}, id)) {
      fail('SKP_AUTHORITY_UNKNOWN', `Skill phase '${phaseId}' references unknown approved authority '${id}'.`);
    }
  }
  return normalizeApprovalPolicy({ mode: 'required', ...raw },
    catalog.approvalAuthorities, phaseId, catalog.approvalSecurity ?? {});
}

function effectsFor(phaseId, contract, catalog, qualityCommands) {
  const writeScope = contract.writeScope;
  if (!['artifact-only', 'source-and-artifact'].includes(writeScope)) {
    fail('SKP_CONTRACT_INVALID', `Skill phase '${phaseId}' needs an explicit writeScope.`);
  }
  const readScope = contract.readScope;
  closed(readScope, ['inputs', 'sourcePaths'], `Skill phase '${phaseId}' readScope`);
  if (typeof readScope.inputs !== 'boolean' || !Array.isArray(readScope.sourcePaths)
      || new Set(readScope.sourcePaths).size !== readScope.sourcePaths.length) {
    fail('SKP_CONTRACT_INVALID', `Skill phase '${phaseId}' readScope needs inputs and unique sourcePaths.`);
  }
  if (catalog.readPaths != null && !Array.isArray(catalog.readPaths)) {
    fail('SKP_CATALOG_UNAVAILABLE', 'Approved candidate catalog readPaths must be an array.');
  }
  const approvedReadPaths = new Set(catalog.readPaths ?? []);
  const sourcePaths = readScope.sourcePaths.map((sourcePath) => {
    exactPath(sourcePath, `Skill phase '${phaseId}' readScope.sourcePaths`, null);
    if (!approvedReadPaths.has(sourcePath)) {
      fail('SKP_READ_SCOPE_UNAPPROVED', `Skill phase '${phaseId}' requests unapproved read path '${sourcePath}'.`);
    }
    return sourcePath;
  });
  if (contract.consumes?.length && !readScope.inputs) {
    fail('SKP_CONTRACT_INVALID', `Skill phase '${phaseId}' consumes inputs but readScope.inputs is false.`);
  }
  if (writeScope === 'artifact-only') {
    if (contract.task === 'code' || contract.sourceScope !== undefined) {
      fail('SKP_CODE_TASK_REQUIRED', `Skill phase '${phaseId}' cannot select code or source scope without source-and-artifact writeScope.`);
    }
    return { writeScope, sourceScope: null, readScope: { inputs: readScope.inputs, sourcePaths } };
  }
  if (contract.task !== 'code') {
    fail('SKP_CODE_TASK_REQUIRED', `Source-writing skill phase '${phaseId}' must explicitly select task: code.`);
  }
  const sourceScopeId = checkedId(contract.sourceScope, `Skill phase '${phaseId}' sourceScope`);
  const sourceScope = Object.hasOwn(catalog.sourceScopes ?? {}, sourceScopeId)
    ? catalog.sourceScopes[sourceScopeId] : null;
  if (!sourceScope) {
    fail('SKP_SCOPE_UNAPPROVED', `Skill phase '${phaseId}' references unknown approved source scope '${sourceScopeId}'.`);
  }
  if (!Array.isArray(sourceScope.writeRoots) || !sourceScope.writeRoots.length
      || new Set(sourceScope.writeRoots).size !== sourceScope.writeRoots.length) {
    fail('SKP_SCOPE_UNAPPROVED', `Approved source scope '${sourceScopeId}' needs exact writeRoots.`);
  }
  sourceScope.writeRoots.forEach((root) => {
    exactPath(root, `Approved source scope '${sourceScopeId}' writeRoot`, null);
    const portableRoot = root.normalize('NFKC').toLowerCase();
    if (['.git', 'singularity', '.github/agents', '.github/workflows'].some(
      (protectedRoot) => portableRoot === protectedRoot || portableRoot.startsWith(`${protectedRoot}/`)
    )) {
      fail('SKP_SCOPE_UNAPPROVED', `Approved source scope '${sourceScopeId}' names protected control path '${root}'.`);
    }
  });
  if (!catalog.codeDelivery) {
    fail('SKP_SCOPE_REQUIRES_CHECKS', `Source-writing skill phase '${phaseId}' needs an approved code-delivery policy.`);
  }
  const codeDelivery = normalizeCodeDeliveryPolicy(catalog.codeDelivery);
  const hasTest = qualityCommands.some((command) => command.kind === 'test'
    && command.requirement === 'required' && command.modelPolicy === 'never'
    && Array.isArray(command.argv) && command.argv.length
    && command.result?.adapter && command.result?.path
    && command.result.minimumDiscovered >= codeDelivery.tests.minimumDiscovered
    && command.result.minimumPassed >= codeDelivery.tests.minimumPassed);
  if (!hasTest) {
    fail('SKP_SCOPE_REQUIRES_CHECKS',
      `Source-writing skill phase '${phaseId}' needs an approved required structured executable test with result adapter.`);
  }
  return {
    writeScope, readScope: { inputs: readScope.inputs, sourcePaths },
    sourceScope: { id: sourceScopeId, definitionSha256: `sha256:${recordSha256(sourceScope)}` },
    codeDeliverySha256: `sha256:${recordSha256(codeDelivery)}`
  };
}

/**
 * Compile one WCA-confirmed candidate; returns JSON-only policy and references, never authority.
 * WCA must verify actor, exact plan/draft revision, and approval of the supplied catalog first.
 */
export function compileConfirmedSkillPhase({ phase, confirmation, catalog, phaseOrder } = {}) {
  if (!confirmation) fail('SKP_CONTRACT_UNCONFIRMED', 'Skill phase has no verified plan confirmation.');
  plain(confirmation, 'Skill plan confirmation');
  closed(confirmation, [
    'contractSha256', 'catalogSha256', 'packageSha256', 'candidateSha256',
    'planSha256', 'draftRevision'
  ], 'Skill plan confirmation');
  plain(catalog, 'Approved candidate catalog', 'SKP_CATALOG_UNAVAILABLE');
  plain(phase, 'Skill phase');
  jsonSafe(catalog, 'Approved candidate catalog');
  jsonSafe(phase, 'Skill phase');
  jsonSafe(confirmation, 'Skill plan confirmation');
  jsonSafe(phaseOrder, 'Confirmed workflow order');
  if (!Array.isArray(phaseOrder) || !phaseOrder.length
      || phaseOrder.some((id) => typeof id !== 'string' || !ID.test(id))
      || new Set(phaseOrder).size !== phaseOrder.length) {
    fail('SKP_INPUT_ORDER', 'Confirmed workflow order must contain unique phase IDs.');
  }
  // Ordinary duplicates would create a second policy authority beside `contract`. They are
  // deliberately not merged, even if an individual field currently happens to match.
  closed(phase, ['id', 'kind', 'label', 'skill', 'contract'], 'Skill phase', 'SKP_CONTRACT_CONFLICT');
  const phaseId = checkedId(phase.id, 'Skill phase id');
  if (phase.kind !== 'skill' || typeof phase.label !== 'string' || !phase.label.trim()) {
    fail('SKP_CONTRACT_INVALID', `Skill phase '${phaseId}' needs kind: skill and a label.`);
  }
  closed(phase.skill, ['id', 'packageSha256'], `Skill phase '${phaseId}' selected skill`);
  const skillId = checkedId(phase.skill.id, `Skill phase '${phaseId}' selected skill`);
  const packageSha256 = checkedDigest(phase.skill.packageSha256, 'Skill package digest');
  const selectedPackage = Object.hasOwn(catalog.skillPackages ?? {}, skillId)
    ? catalog.skillPackages[skillId] : null;
  if (!selectedPackage || selectedPackage.packageSha256 !== packageSha256
      || selectedPackage.eligibility !== 'candidate-producer') {
    fail('SKP_SKILL_NOT_PHASE_PRODUCER', `Skill '${skillId}' is not an exact admitted producer in the approved catalog.`);
  }
  closed(phase.contract, [
    'task', 'consumes', 'produces', 'checks', 'writeScope', 'sourceScope', 'readScope',
    'approval', 'clarification', 'primaryOutput', 'artifactSet'
  ], `Skill phase '${phaseId}' contract`);
  const contract = phase.contract;
  const task = assertModelTask(contract.task, `Skill phase '${phaseId}' task`);
  const contractSha256 = skillContractSha256(phaseId, contract);
  const catalogSha256 = skillCandidateCatalogSha256(catalog);
  const candidateSha256 = skillPhaseCandidateSha256(phase, phaseOrder, catalogSha256);
  for (const [field, expected] of [
    ['contractSha256', contractSha256], ['packageSha256', packageSha256],
    ['catalogSha256', catalogSha256], ['candidateSha256', candidateSha256]
  ]) {
    if (confirmation[field] !== expected) {
      fail('SKP_CONTRACT_UNCONFIRMED', `Skill phase '${phaseId}' confirmation does not bind current ${field}.`);
    }
  }
  checkedDigest(confirmation.planSha256, 'Confirmed plan digest');
  if (!Number.isSafeInteger(confirmation.draftRevision) || confirmation.draftRevision < 1) {
    fail('SKP_CONTRACT_UNCONFIRMED', `Skill phase '${phaseId}' needs the exact confirmed draft revision.`);
  }
  const { artifact, artifactSet, outputs } = outputsFor(phase, contract, catalog);
  const { phaseInputs, inputs } = inputsFor(phaseId, contract, catalog, phaseOrder);
  const { qualityCommands, checks } = checksFor(phaseId, contract, catalog);
  const approval = approvalFor(phaseId, contract, catalog);
  const effects = effectsFor(phaseId, contract, catalog, qualityCommands);
  const phasePolicy = {
    label: phase.label.trim(), artifact, inputs: phaseInputs,
    qualityCommands, approval, writeScope: effects.writeScope,
    generation: {
      requirement: 'required', defaultProducer: 'governed-agent',
      allowedProducers: ['governed-agent'], task
    },
    clarification: normalizeClarificationPolicy(contract.clarification ?? {})
  };
  if (artifactSet) phasePolicy.artifactSet = artifactSet;
  const bindingRefs = {
    skill: { id: skillId, packageSha256 },
    contractSha256, catalogSha256,
    confirmation: {
      planSha256: confirmation.planSha256,
      candidateSha256,
      draftRevision: confirmation.draftRevision
    },
    inputs, outputs, checks,
    readScope: effects.readScope,
    sourceScope: effects.sourceScope,
    codeDeliverySha256: effects.codeDeliverySha256 ?? null
  };
  const core = { compiler: SKP_CONTRACT_COMPILER, phaseId, phasePolicy, bindingRefs };
  return JSON.parse(canonicalJson({
    ...core, compilationSha256: `sha256:${recordSha256(core)}`
  }));
}
