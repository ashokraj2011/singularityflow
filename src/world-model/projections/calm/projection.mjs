import { currentSchemaVersion, readRecord } from '../../../schema-migrations.mjs';
import { SingularityFlowError } from '../../../util.mjs';
import { canonicalJson, sealRecord, sha256 } from '../../canonicalize.mjs';
import { BUILTIN_ARCH_CALM_CONTRACT, CALM_SCHEMA_URI } from '../../registry/projections.mjs';
import { validateCalmWithOfficialToolchain } from './validator.mjs';

const ALLOWED_ASSURANCE = new Set(BUILTIN_ARCH_CALM_CONTRACT.assurance.allowed);
const NODE_TYPES = new Set(['actor', 'database', 'ecosystem', 'network', 'service', 'system', 'webclient']);
const INTENT_OPERATIONS = new Set([
  'add-node', 'remove-node', 'change-node', 'add-interface', 'remove-interface',
  'change-interface', 'add-relationship', 'remove-relationship', 'change-relationship',
  'apply-control', 'remove-control', 'add-flow', 'remove-flow'
]);
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function fail(message, code, details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function clone(value) { return structuredClone(value); }
function ordered(values, key = (value) => value) {
  return [...values].sort((left, right) => String(key(left)).localeCompare(String(key(right))));
}
function exactHash(value, label) {
  if (!SHA256.test(String(value ?? ''))) fail(`${label} must be an exact SHA-256.`, 'WMC_FACT_SET_INVALID');
  return value;
}
function text(value, fallback = '') {
  const result = String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/https?:\/\/[^\s/]+@[^\s]+/giu, '[credentialed-url-omitted]')
    .replace(/https?:\/\/[^\s?]+\?[^\s]*(?:token|secret|password|api[_-]?key)=[^\s&]+[^\s]*/giu,
      '[credentialed-url-omitted]')
    .trim();
  return result;
}
function safeId(value, label) {
  const result = text(value);
  if (!ID.test(result)) fail(`${label} '${result}' is not a safe architecture identifier.`, 'WMC_ELEMENT_ID_COLLISION');
  return result;
}
function safeRelativePath(value) {
  const result = text(value).replaceAll('\\', '/').replace(/^\.\//, '');
  if (!result || result.startsWith('/') || /^[A-Za-z]:\//.test(result)
      || result.split('/').includes('..') || /[\r\n\0]/.test(result)) {
    fail(`Architecture source path '${value}' is not repository-relative.`, 'WMC_FACT_SET_INVALID');
  }
  return result;
}
function selfHash(family, value, field) {
  return Object.freeze(readRecord(family, sealRecord(value, field)).record);
}
function repoRecord(value) {
  if (typeof value === 'string') return { id: text(value) };
  const id = text(value?.id ?? value?.repository ?? value?.name);
  if (!id) return null;
  const result = { id };
  const revision = value?.revision ?? value?.sha256 ?? null;
  if (revision && SHA256.test(revision)) result.revision = revision;
  return result;
}

/** Produce the exact, privacy-bounded capability authority input consumed by WMC. */
export function createArchitectureCapabilitySnapshot(definition, {
  sourcePath = 'singularity/capabilities.yml', sourceSha256 = null
} = {}) {
  const capabilities = definition?.capabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    fail('Approved capability authority is unavailable.', 'WMC_CAPABILITY_SNAPSHOT_UNAVAILABLE');
  }
  const source = safeRelativePath(sourcePath);
  const entries = ordered(Object.entries(capabilities), ([id]) => id).map(([rawId, value]) => {
    const id = safeId(rawId, 'Capability id');
    const repositories = ordered((value.repositories ?? (value.repository ? [value.repository] : []))
      .map(repoRecord).filter(Boolean), (item) => item.id);
    const dependencies = ordered((value.dependencies ?? []).map((dependency) => ({
      capabilityId: safeId(
        typeof dependency === 'string' ? dependency : dependency.capability ?? dependency.id,
        `Capability '${id}' dependency`
      ),
      contract: text(typeof dependency === 'object' ? dependency.contract ?? '' : '') || null,
      revision: typeof dependency === 'object' && SHA256.test(dependency.revision ?? '')
        ? dependency.revision : null
    })), (item) => `${item.capabilityId}/${item.contract ?? ''}/${item.revision ?? ''}`);
    const declaredType = value.architecture?.nodeType ?? value.nodeType ?? null;
    if (declaredType != null && !NODE_TYPES.has(declaredType)) {
      fail(`Capability '${id}' declares unsupported CALM node type '${declaredType}'.`, 'WMC_FACT_SET_INVALID');
    }
    return {
      id,
      label: text(value.label ?? value.name, id),
      description: text(value.description),
      kind: value.kind,
      nodeType: declaredType,
      parent: value.parent == null ? null : safeId(value.parent, `Capability '${id}' parent`),
      repositories,
      teams: ordered((value.teams ?? []).map((team) => safeId(team, `Capability '${id}' team`))),
      dependencies,
      source: { path: source, recordId: id }
    };
  });
  const ids = new Set(entries.map((entry) => entry.id));
  for (const entry of entries) {
    if (!['collection', 'delivery'].includes(entry.kind)) {
      fail(`Capability '${entry.id}' has unsupported kind '${entry.kind}'.`, 'WMC_FACT_SET_INVALID');
    }
    if (entry.parent && !ids.has(entry.parent)) {
      fail(`Capability '${entry.id}' has unknown parent '${entry.parent}'.`, 'WMC_FACT_SET_INVALID');
    }
  }
  const digest = sourceSha256 ?? sha256(definition);
  exactHash(digest, 'Capability source digest');
  return Object.freeze(sealRecord({
    schemaVersion: currentSchemaVersion('architecture-fact-set'),
    kind: 'architecture-capability-snapshot', source: { path: source, sha256: digest }, capabilities: entries
  }, 'snapshotSha256'));
}

function authorityGroups(definition) {
  const source = definition?.approvalAuthorities ?? definition?.workflow?.approvalAuthorities ?? {};
  return ordered(Object.entries(source).map(([rawId, value]) => ({
    id: safeId(rawId, 'Approval authority id'),
    label: text(value?.label, rawId),
    role: text(value?.role ?? value?.authorityRole, 'approval')
  })), (entry) => entry.id);
}

function protectedPaths(definition) {
  const values = new Set(definition?.protectedPaths ?? definition?.workflow?.protectedPaths ?? []);
  for (const phase of Object.values(definition?.phases ?? {})) {
    for (const value of phase?.protectedPaths ?? []) values.add(value);
  }
  return ordered([...values].map(safeRelativePath));
}

/** Strip member identities and unrelated workflow material from architecture policy input. */
export function createArchitectureConfigurationSnapshot(definition, {
  sourcePath = 'singularity/workflow.yml', sourceSha256 = null
} = {}) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    fail('Approved configuration authority is unavailable.', 'WMC_CONFIGURATION_SNAPSHOT_UNAVAILABLE');
  }
  const source = safeRelativePath(sourcePath);
  const digest = sourceSha256 ?? sha256(definition);
  exactHash(digest, 'Configuration source digest');
  return Object.freeze(sealRecord({
    schemaVersion: currentSchemaVersion('architecture-fact-set'),
    kind: 'architecture-configuration-snapshot',
    source: { path: source, sha256: digest },
    policyMode: text(definition.mode ?? definition.policy?.mode, 'governed'),
    approvalGroups: authorityGroups(definition),
    protectedPaths: protectedPaths(definition)
  }, 'snapshotSha256'));
}

function sourceRef(sourceKind, sourceSha256, extra = {}) {
  return { sourceKind, sourceSha256, assurance: extra.assurance ?? 'human-confirmed', ...extra };
}
function relationId(tuple) { return `sflow-rel-${sha256(tuple).slice(7, 27)}`; }
function parseClaim(claim) {
  if (typeof claim !== 'string') return null;
  try {
    const value = JSON.parse(claim);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function createArchitectureFactSet({
  subject, sourceManifestSha256, scopeSha256, factLedger, capabilitySnapshot,
  configurationSnapshot, includeGovernanceActors = true, includeControls = true
}) {
  const sourceHash = exactHash(sourceManifestSha256, 'Source manifest digest');
  const scopeHash = exactHash(scopeSha256, 'Scope digest');
  const ledgerHash = exactHash(factLedger?.ledgerSha256, 'Fact Ledger digest');
  exactHash(capabilitySnapshot?.snapshotSha256, 'Capability snapshot digest');
  exactHash(configurationSnapshot?.snapshotSha256, 'Configuration snapshot digest');
  const nodes = [];
  const interfaces = [];
  const relationships = [];
  const controls = [];
  const unavailable = [];
  const contradictions = [];
  const nodeIds = new Set();
  const capabilityById = new Map(capabilitySnapshot.capabilities.map((item) => [item.id, item]));
  const addNode = (record) => {
    if (nodeIds.has(record.id)) fail(`Architecture element id '${record.id}' collides.`, 'WMC_ELEMENT_ID_COLLISION');
    nodeIds.add(record.id); nodes.push(record);
  };
  for (const capability of capabilitySnapshot.capabilities) {
    const nodeType = capability.nodeType ?? (capability.kind === 'collection' ? 'system' : 'system');
    if (!capability.nodeType && capability.kind === 'delivery') {
      unavailable.push({ subject: `capability:${capability.id}/node-type`, reason: 'explicit-classification-unavailable' });
    }
    addNode({
      id: capability.id, nodeType, name: capability.label,
      description: capability.description || `${capability.kind === 'delivery' ? 'Delivery' : 'Collection'} capability ${capability.label}.`,
      layer: capability.kind, status: 'confirmed', repositories: clone(capability.repositories),
      sources: [sourceRef('capability', capabilitySnapshot.source.sha256, {
        path: capabilitySnapshot.source.path, recordId: capability.id
      })]
    });
  }
  if (includeGovernanceActors) for (const group of configurationSnapshot.approvalGroups) {
    const id = `actor:${group.id}`;
    addNode({
      id, nodeType: 'actor', name: group.label, description: `Governance authority ${group.label}.`,
      layer: 'governance', status: 'confirmed', repositories: [],
      sources: [sourceRef('configuration', configurationSnapshot.source.sha256, {
        path: configurationSnapshot.source.path, recordId: group.id
      })]
    });
  }
  for (const parent of capabilitySnapshot.capabilities) {
    const children = ordered(capabilitySnapshot.capabilities.filter((entry) => entry.parent === parent.id), (item) => item.id);
    if (!children.length) continue;
    const tuple = { kind: 'composed-of', container: parent.id, nodes: children.map((child) => child.id) };
    relationships.push({
      id: relationId(tuple), kind: 'composed-of', source: parent.id, destinations: tuple.nodes,
      description: `${parent.label} is composed of ${children.map((child) => child.label).join(' and ')}.`,
      status: 'confirmed', declared: true, observed: false,
      sources: [sourceRef('capability', capabilitySnapshot.source.sha256, {
        path: capabilitySnapshot.source.path, recordId: parent.id
      })]
    });
  }
  for (const capability of capabilitySnapshot.capabilities) for (const dependency of capability.dependencies) {
    if (!capabilityById.has(dependency.capabilityId)) {
      unavailable.push({ subject: `dependency:${capability.id}->${dependency.capabilityId}`, reason: 'target-capability-unavailable' });
      continue;
    }
    const tuple = {
      kind: 'connects', source: capability.id, destination: dependency.capabilityId,
      sourceInterface: null, destinationInterface: null, protocol: dependency.contract
    };
    relationships.push({
      id: relationId(tuple), kind: 'connects', source: capability.id,
      destination: dependency.capabilityId, protocol: dependency.contract,
      description: `${capability.label} connects to ${capabilityById.get(dependency.capabilityId).label}.`,
      status: 'declared-only', declared: true, observed: false,
      sources: [sourceRef('dependency-pin', capabilitySnapshot.source.sha256, {
        path: capabilitySnapshot.source.path, recordId: `${capability.id}->${dependency.capabilityId}`
      })]
    });
  }
  for (const fact of factLedger.facts ?? []) {
    if (!ALLOWED_ASSURANCE.has(fact.assurance)) continue;
    if (fact.status === 'unavailable') {
      unavailable.push({ subject: `${fact.subject?.kind}:${fact.subject?.id}`, factId: fact.id, reason: fact.reason?.code ?? 'unavailable' });
      continue;
    }
    if (fact.status === 'contradicted') {
      contradictions.push({ subject: `${fact.subject?.kind}:${fact.subject?.id}`, factId: fact.id, conflictsWith: clone(fact.conflictsWith ?? []) });
      continue;
    }
    const claim = parseClaim(fact.claim);
    if (['interface', 'schema-contract', 'protocol-field'].includes(fact.factType) && claim?.node && claim?.id
        && nodeIds.has(claim.node)) {
      interfaces.push({
        id: safeId(claim.id, 'Interface id'), node: claim.node,
        type: text(claim.type, 'sflow-published-contract'), value: text(claim.value ?? fact.claim),
        sources: [sourceRef('world-model-fact', fact.factSha256, {
          assurance: fact.assurance, factId: fact.id, evidenceIds: clone(fact.evidenceIds ?? [])
        })]
      });
    }
    if (['dependency-edge', 'import-dependency', 'consumer-dependency'].includes(fact.factType)
        && claim?.source && claim?.destination && nodeIds.has(claim.source) && nodeIds.has(claim.destination)) {
      const tuple = {
        kind: 'connects', source: claim.source, destination: claim.destination,
        sourceInterface: claim.sourceInterface ?? null, destinationInterface: claim.destinationInterface ?? null,
        protocol: claim.protocol ?? null
      };
      const id = relationId(tuple);
      const prior = relationships.find((entry) => entry.id === id);
      const observedSource = sourceRef('world-model-fact', fact.factSha256, {
        assurance: fact.assurance, factId: fact.id, evidenceIds: clone(fact.evidenceIds ?? [])
      });
      if (prior) {
        prior.observed = true; prior.status = prior.declared ? 'confirmed' : 'observed-only';
        prior.sources.push(observedSource);
      } else relationships.push({
        id, kind: 'connects', source: claim.source, destination: claim.destination,
        sourceInterface: claim.sourceInterface ?? null, destinationInterface: claim.destinationInterface ?? null,
        protocol: claim.protocol ?? null,
        description: `${claim.source} connects to ${claim.destination}.`, status: 'observed-only',
        declared: false, observed: true, sources: [observedSource]
      });
    }
  }
  if (includeControls && configurationSnapshot.protectedPaths.length) {
    controls.push({
      id: 'protected-configuration', description: 'SFlow protects approved configuration paths.',
      gateId: 'protectedPaths', mode: 'hard', paths: clone(configurationSnapshot.protectedPaths),
      policySha256: configurationSnapshot.snapshotSha256,
      sources: [sourceRef('configuration', configurationSnapshot.source.sha256, {
        path: configurationSnapshot.source.path, recordId: 'protectedPaths'
      })]
    });
  }
  const deduplicatedRelationships = ordered(relationships, (entry) => entry.id);
  if (new Set(deduplicatedRelationships.map((entry) => entry.id)).size !== deduplicatedRelationships.length) {
    fail('Architecture relationship identity collision.', 'WMC_ELEMENT_ID_COLLISION');
  }
  return selfHash('architecture-fact-set', {
    schemaVersion: currentSchemaVersion('architecture-fact-set'), kind: 'architecture-fact-set',
    subject: { kind: 'repository', id: safeId(subject?.id, 'Architecture subject') },
    inputs: {
      sourceManifestSha256: sourceHash, scopeSha256: scopeHash, factLedgerSha256: ledgerHash,
      capabilitySnapshotSha256: capabilitySnapshot.snapshotSha256,
      configurationSnapshotSha256: configurationSnapshot.snapshotSha256
    },
    nodes: ordered(nodes, (entry) => entry.id), interfaces: ordered(interfaces, (entry) => entry.id),
    relationships: deduplicatedRelationships, controls: ordered(controls, (entry) => entry.id),
    flows: [], unavailable: ordered(unavailable, (entry) => `${entry.subject}/${entry.factId ?? ''}`),
    contradictions: ordered(contradictions, (entry) => `${entry.subject}/${entry.factId ?? ''}`)
  }, 'factSetSha256');
}

function calmNode(node, interfaces) {
  return {
    'unique-id': node.id,
    'node-type': node.nodeType,
    name: node.name,
    description: node.description,
    interfaces: ordered(interfaces.filter((item) => item.node === node.id), (item) => item.id).map((item) => ({
      'unique-id': item.id, type: item.type, value: item.value,
      metadata: { sflow: { sourceFactIds: item.sources.map((source) => source.factId).filter(Boolean) } }
    })),
    metadata: { sflow: {
      origin: 'declared', status: node.status, layer: node.layer,
      ...(['collection', 'delivery'].includes(node.layer) ? { capabilityKind: node.layer } : {}),
      repositories: clone(node.repositories)
    } }
  };
}
function calmRelationship(relationship) {
  const relationshipType = relationship.kind === 'composed-of'
    ? { 'composed-of': { container: relationship.source, nodes: clone(relationship.destinations) } }
    : { connects: {
        source: { node: relationship.source, ...(relationship.sourceInterface ? { interfaces: [relationship.sourceInterface] } : {}) },
        destination: { node: relationship.destination, ...(relationship.destinationInterface ? { interfaces: [relationship.destinationInterface] } : {}) }
      } };
  return {
    'unique-id': relationship.id, 'relationship-type': relationshipType,
    description: relationship.description,
    metadata: { sflow: {
      status: relationship.status, declared: relationship.declared, observed: relationship.observed,
      ...(relationship.protocol ? { protocol: relationship.protocol } : {})
    } }
  };
}

export function renderCalmProjection(factSet, {
  subjectLabel = null, projectionContract = BUILTIN_ARCH_CALM_CONTRACT
} = {}) {
  const nodes = factSet.nodes.map((node) => calmNode(node, factSet.interfaces));
  const relationships = factSet.relationships.map(calmRelationship);
  const controls = Object.fromEntries(factSet.controls.map((control) => [control.id, {
    description: control.description,
    requirements: [{
      'requirement-url': 'https://singularity-flow.dev/schemas/calm/enforcement-control-v1.json',
      config: {
        'control-id': control.id, 'enforced-by': 'singularity-flow', 'gate-id': control.gateId,
        mode: control.mode, 'policy-sha256': control.policySha256, paths: clone(control.paths)
      }
    }]
  }]));
  const projection = {
    $schema: CALM_SCHEMA_URI,
    $id: `urn:singularity-flow:world-model:${factSet.subject.id}:arch.calm:${factSet.inputs.sourceManifestSha256.slice(7)}`,
    title: `${text(subjectLabel, factSet.subject.id)} — generated architecture`,
    description: 'Deterministic FINOS CALM projection of Singularity Flow governed facts.',
    metadata: { sflow: {
      projection: 'arch.calm@1', authority: 'derived-view', ...clone(factSet.inputs),
      projectionContractSha256: projectionContract.contractSha256,
      mapperSha256: sha256('sflow-calm-projection:v1')
    } },
    nodes, relationships, controls, flows: [], adrs: []
  };
  enforceProjectionBudgets(projection, projectionContract.budgets);
  validateCalmProjection(projection);
  const projectionBytes = canonicalJson(projection);
  const projectionSha256 = sha256({ utf8: projectionBytes });
  const elements = [
    ...factSet.nodes.map((node) => ({ elementId: node.id, elementKind: 'node', status: node.status, sources: clone(node.sources) })),
    ...factSet.interfaces.map((item) => ({ elementId: item.id, elementKind: 'interface', status: 'confirmed', sources: clone(item.sources) })),
    ...factSet.relationships.map((item) => ({
      elementId: item.id, elementKind: 'relationship', status: item.status,
      semanticIdentity: item.kind === 'composed-of'
        ? { kind: item.kind, source: item.source, destinations: clone(item.destinations) }
        : {
            kind: item.kind, source: item.source, destination: item.destination,
            sourceInterface: item.sourceInterface ?? null,
            destinationInterface: item.destinationInterface ?? null,
            protocol: item.protocol ?? null
          },
      sources: clone(item.sources)
    })),
    ...factSet.controls.map((item) => ({ elementId: item.id, elementKind: 'control', status: 'confirmed', sources: clone(item.sources) }))
  ].sort((left, right) => `${left.elementKind}/${left.elementId}`.localeCompare(`${right.elementKind}/${right.elementId}`));
  const sourceMap = selfHash('world-model-projection-source-map', {
    schemaVersion: currentSchemaVersion('world-model-projection-source-map'),
    kind: 'world-model-projection-source-map', projectionId: 'arch.calm', projectionVersion: 1,
    projectionSha256, elements
  }, 'sourceMapSha256');
  return Object.freeze({ projection, projectionBytes, projectionSha256, sourceMap });
}

export function validateCalmProjection(projection) {
  if (!projection || projection.$schema !== CALM_SCHEMA_URI || !String(projection.$id ?? '').startsWith('urn:')) {
    fail('Generated document does not bind the installed CALM 1.2 schema and deterministic ID.', 'WMC_CALM_SCHEMA_INVALID');
  }
  for (const field of ['nodes', 'relationships', 'flows', 'adrs']) {
    if (!Array.isArray(projection[field])) fail(`CALM '${field}' must be an array.`, 'WMC_CALM_SCHEMA_INVALID');
  }
  if (!projection.controls || typeof projection.controls !== 'object' || Array.isArray(projection.controls)) {
    fail("CALM 'controls' must be an object.", 'WMC_CALM_SCHEMA_INVALID');
  }
  const nodeIds = new Set();
  const interfaceIds = new Set();
  for (const node of projection.nodes) {
    if (nodeIds.has(node['unique-id'])) fail(`Duplicate CALM node '${node['unique-id']}'.`, 'WMC_ELEMENT_ID_COLLISION');
    nodeIds.add(node['unique-id']);
    for (const item of node.interfaces ?? []) {
      if (interfaceIds.has(item['unique-id'])) fail(`Duplicate CALM interface '${item['unique-id']}'.`, 'WMC_ELEMENT_ID_COLLISION');
      interfaceIds.add(item['unique-id']);
    }
  }
  const relationshipIds = new Set();
  for (const relationship of projection.relationships) {
    if (relationshipIds.has(relationship['unique-id'])) fail(`Duplicate CALM relationship '${relationship['unique-id']}'.`, 'WMC_ELEMENT_ID_COLLISION');
    relationshipIds.add(relationship['unique-id']);
    const type = relationship['relationship-type'];
    if (type?.['composed-of']) {
      if (!nodeIds.has(type['composed-of'].container)
          || type['composed-of'].nodes.some((id) => !nodeIds.has(id))) {
        fail(`CALM relationship '${relationship['unique-id']}' references an unknown node.`, 'WMC_CALM_SCHEMA_INVALID');
      }
    } else if (type?.connects) {
      if (!nodeIds.has(type.connects.source?.node) || !nodeIds.has(type.connects.destination?.node)) {
        fail(`CALM relationship '${relationship['unique-id']}' references an unknown node.`, 'WMC_CALM_SCHEMA_INVALID');
      }
    } else fail(`CALM relationship '${relationship['unique-id']}' has no supported type.`, 'WMC_CALM_SCHEMA_INVALID');
  }
  return { status: 'passed' };
}

export function enforceProjectionBudgets(projection, budgets) {
  const interfaceCount = projection.nodes.reduce((sum, node) => sum + (node.interfaces?.length ?? 0), 0);
  const counts = {
    nodes: projection.nodes.length, relationships: projection.relationships.length,
    interfaces: interfaceCount, controls: Object.keys(projection.controls).length,
    bytes: Buffer.byteLength(canonicalJson(projection))
  };
  const exceeded = [
    ['nodes', 'maximumNodes'], ['relationships', 'maximumRelationships'],
    ['interfaces', 'maximumInterfaces'], ['controls', 'maximumControls'], ['bytes', 'maximumBytes']
  ].filter(([count, limit]) => counts[count] > budgets[limit]);
  if (exceeded.length) fail('CALM projection exceeds its reviewed budget.', 'WMC_PROJECTION_BUDGET_EXCEEDED', {
    counts, limits: clone(budgets), exceeded: exceeded.map(([count, limit]) => ({ count, limit }))
  });
  return counts;
}

export function buildCalmProjection(input) {
  const factSet = createArchitectureFactSet(input);
  return Object.freeze({ factSet, ...renderCalmProjection(factSet, input) });
}

/** Attach proof from the reviewed, offline FINOS validator to a deterministic projection. */
export async function validateCalmProjectionCandidate(candidate, options = {}) {
  validateCalmProjection(candidate?.projection);
  if (candidate.projectionBytes !== canonicalJson(candidate.projection)
      || candidate.projectionSha256 !== sha256({ utf8: candidate.projectionBytes })
      || candidate.sourceMap?.projectionSha256 !== candidate.projectionSha256) {
    fail('CALM projection candidate bytes, digest, and provenance do not agree.', 'WMC_CALM_SCHEMA_INVALID');
  }
  const validationResult = await validateCalmWithOfficialToolchain(candidate.projection, options);
  const receipt = selfHash('world-model-projection-receipt', {
    schemaVersion: currentSchemaVersion('world-model-projection-receipt'),
    kind: 'world-model-projection-receipt', projectionId: 'arch.calm', projectionVersion: 1,
    inputs: { ...clone(candidate.factSet.inputs), architectureFactSetSha256: candidate.factSet.factSetSha256 },
    mapper: { id: 'sflow-calm-projection', version: 1, sha256: sha256('sflow-calm-projection:v1') },
    output: {
      path: 'projections/arch.calm.json', sha256: candidate.projectionSha256,
      bytes: Buffer.byteLength(candidate.projectionBytes), sourceMapSha256: candidate.sourceMap.sourceMapSha256
    },
    validation: {
      status: 'passed', toolchainLockSha256: validationResult.toolchainLock.lockSha256,
      normalizedResultSha256: validationResult.normalizedResultSha256
    }
  }, 'receiptSha256');
  return Object.freeze({ ...candidate, receipt, validationResult });
}

export function createCalmProjectionRefusal({ code, error, preserved }) {
  return selfHash('world-model-projection-refusal', {
    schemaVersion: currentSchemaVersion('world-model-projection-refusal'),
    kind: 'world-model-projection-refusal', projectionId: 'arch.calm',
    code: text(code, 'WMC_PROJECTION_UNAVAILABLE'),
    message: text(error?.message, 'Architecture projection is unavailable.'),
    preserved: clone(preserved)
  }, 'refusalSha256');
}

export function validateArchitectureIntent(value) {
  const record = readRecord('architecture-intent', value).record;
  if (record.kind !== 'architecture-intent' || !text(record.workId) || !text(record.phase)
      || !Number.isSafeInteger(record.generation) || record.generation < 1) {
    fail('Architecture intent identity is invalid.', 'WMC_INTENT_INVALID');
  }
  exactHash(record.base?.worldModelManifestSha256, 'Intent base manifest');
  exactHash(record.base?.calmProjectionSha256, 'Intent base CALM projection');
  if (!Array.isArray(record.clauses) || !record.clauses.length) fail('Architecture intent requires clauses.', 'WMC_INTENT_INVALID');
  const ids = new Set(); const targets = new Set();
  for (const clause of record.clauses) {
    if (!String(clause.clauseId ?? '').startsWith(`${record.workId}:ARCH-`)
        || !INTENT_OPERATIONS.has(clause.operation) || typeof clause.required !== 'boolean'
        || !text(clause.elementId) || !clause.value || typeof clause.value !== 'object') {
      fail(`Architecture intent clause '${clause.clauseId ?? 'unknown'}' is invalid.`, 'WMC_INTENT_INVALID');
    }
    if (ids.has(clause.clauseId) || targets.has(`${clause.operation.replace(/^(add|remove|change|apply)-/, '')}/${clause.elementId}`)) {
      fail(`Architecture intent repeats clause or semantic target '${clause.elementId}'.`, 'WMC_INTENT_CONFLICT');
    }
    ids.add(clause.clauseId); targets.add(`${clause.operation.replace(/^(add|remove|change|apply)-/, '')}/${clause.elementId}`);
  }
  const core = clone(record); delete core.intentSha256;
  if (record.intentSha256 !== sha256(core)) fail('Architecture intent hash does not match its content.', 'WMC_INTENT_INVALID');
  return record;
}

export function createArchitectureIntent({ workId, phase, generation, base, clauses }) {
  return validateArchitectureIntent(selfHash('architecture-intent', {
    schemaVersion: currentSchemaVersion('architecture-intent'), kind: 'architecture-intent',
    workId: text(workId), phase: text(phase), generation, base: clone(base),
    clauses: ordered(clauses, (clause) => clause.clauseId).map(clone)
  }, 'intentSha256'));
}

function targetCollection(projection, operation) {
  if (operation.endsWith('node')) return projection.nodes;
  if (operation.endsWith('relationship')) return projection.relationships;
  if (operation.endsWith('flow')) return projection.flows;
  return null;
}
function itemId(item) { return item['unique-id']; }

function plannedValue(clause, prior = {}) {
  const value = clone(clause.value);
  let normalized = value;
  if (clause.operation.endsWith('node')) {
    normalized = {
      ...value,
      ...(value.nodeType ? { 'node-type': value.nodeType } : {}),
      'unique-id': clause.elementId
    };
    delete normalized.nodeType;
    normalized.interfaces ??= prior.interfaces ?? [];
  } else if (clause.operation.endsWith('relationship')) {
    const relationshipType = value.relationshipType ?? 'connects';
    normalized = {
      ...value,
      'unique-id': clause.elementId,
      'relationship-type': relationshipType === 'composed-of'
        ? { 'composed-of': { container: value.container, nodes: clone(value.nodes ?? []) } }
        : { connects: { source: clone(value.source), destination: clone(value.destination) } }
    };
    for (const key of ['relationshipType', 'container', 'nodes', 'source', 'destination']) delete normalized[key];
  } else if (clause.operation.endsWith('interface')) {
    normalized = { ...value, 'unique-id': clause.elementId };
    delete normalized.node;
  } else normalized = { ...value, 'unique-id': clause.elementId };
  normalized.metadata = {
    ...(prior.metadata ?? {}), ...(normalized.metadata ?? {}),
    sflow: {
      ...(prior.metadata?.sflow ?? {}), ...(normalized.metadata?.sflow ?? {}),
      status: 'planned', clauseId: clause.clauseId
    }
  };
  return { ...prior, ...normalized };
}

function expectedIntentFields(clause) {
  const value = clone(clause.value);
  if (clause.operation.endsWith('node') && Object.hasOwn(value, 'nodeType')) {
    value['node-type'] = value.nodeType; delete value.nodeType;
  }
  if (clause.operation.endsWith('relationship')) {
    const type = value.relationshipType ?? 'connects';
    const result = { 'relationship-type': type === 'composed-of'
      ? { 'composed-of': { container: value.container, nodes: clone(value.nodes ?? []) } }
      : { connects: { source: clone(value.source), destination: clone(value.destination) } } };
    for (const [key, item] of Object.entries(value)) {
      if (!['relationshipType', 'container', 'nodes', 'source', 'destination'].includes(key)) result[key] = item;
    }
    return result;
  }
  if (clause.operation.endsWith('interface')) delete value.node;
  return value;
}

export function renderPlannedArchitecture({ projection, projectionSha256, worldModelManifestSha256, intent }) {
  const checked = validateArchitectureIntent(intent);
  if (checked.base.worldModelManifestSha256 !== worldModelManifestSha256
      || checked.base.calmProjectionSha256 !== projectionSha256) {
    fail('Architecture intent binds an older base projection.', 'WMC_INTENT_BASE_STALE', {
      expected: { worldModelManifestSha256, calmProjectionSha256: projectionSha256 }, received: checked.base
    });
  }
  const planned = clone(projection);
  for (const clause of checked.clauses) {
    const verb = clause.operation.split('-')[0];
    const collection = targetCollection(planned, clause.operation);
    if (clause.operation === 'apply-control') {
      if (planned.controls[clause.elementId]) fail(`Planned control '${clause.elementId}' already exists.`, 'WMC_INTENT_CONFLICT');
      planned.controls[clause.elementId] = { ...clone(clause.value), metadata: { sflow: { status: 'planned', clauseId: clause.clauseId } } };
      continue;
    }
    if (clause.operation === 'remove-control') {
      if (!planned.controls[clause.elementId]) fail(`Planned control '${clause.elementId}' is unknown.`, 'WMC_INTENT_CONFLICT');
      delete planned.controls[clause.elementId]; continue;
    }
    if (clause.operation.endsWith('interface')) {
      const node = planned.nodes.find((entry) => entry['unique-id'] === clause.value.node);
      if (!node) fail(`Planned interface node '${clause.value.node}' is unknown.`, 'WMC_INTENT_CONFLICT');
      const index = (node.interfaces ?? []).findIndex((entry) => itemId(entry) === clause.elementId);
      if (verb === 'add' && index >= 0) fail(`Planned interface '${clause.elementId}' already exists.`, 'WMC_INTENT_CONFLICT');
      if (verb !== 'add' && index < 0) fail(`Planned interface '${clause.elementId}' is unknown.`, 'WMC_INTENT_CONFLICT');
      if (verb === 'remove') node.interfaces.splice(index, 1);
      else {
        const item = plannedValue(clause, verb === 'change' ? node.interfaces[index] : {});
        if (verb === 'add') node.interfaces.push(item); else node.interfaces[index] = item;
      }
      continue;
    }
    if (!collection) fail(`Architecture intent operation '${clause.operation}' is unsupported.`, 'WMC_INTENT_INVALID');
    const index = collection.findIndex((entry) => itemId(entry) === clause.elementId);
    if (verb === 'add' && index >= 0) fail(`Planned element '${clause.elementId}' already exists.`, 'WMC_INTENT_CONFLICT');
    if (verb !== 'add' && index < 0) fail(`Planned element '${clause.elementId}' is unknown.`, 'WMC_INTENT_CONFLICT');
    if (verb === 'remove') collection.splice(index, 1);
    else {
      const item = plannedValue(clause, verb === 'change' ? collection[index] : {});
      if (verb === 'add') collection.push(item); else collection[index] = item;
    }
  }
  planned.nodes.sort((a, b) => itemId(a).localeCompare(itemId(b)));
  planned.relationships.sort((a, b) => itemId(a).localeCompare(itemId(b)));
  planned.flows.sort((a, b) => itemId(a).localeCompare(itemId(b)));
  validateCalmProjection(planned);
  const plannedSha256 = sha256({ utf8: canonicalJson(planned) });
  const receipt = selfHash('architecture-planned-projection-receipt', {
    schemaVersion: currentSchemaVersion('architecture-planned-projection-receipt'),
    kind: 'architecture-planned-projection-receipt', workId: checked.workId,
    intentSha256: checked.intentSha256, baseProjectionSha256: projectionSha256,
    plannedProjectionSha256: plannedSha256, validationStatus: 'passed'
  }, 'receiptSha256');
  return Object.freeze({ projection: planned, projectionSha256: plannedSha256, receipt });
}

function semanticElement(projection, clause) {
  if (clause.operation.endsWith('node')) return projection.nodes.find((entry) => itemId(entry) === clause.elementId);
  if (clause.operation.endsWith('relationship')) return projection.relationships.find((entry) => itemId(entry) === clause.elementId);
  if (clause.operation.endsWith('flow')) return projection.flows.find((entry) => itemId(entry) === clause.elementId);
  if (clause.operation.endsWith('control')) return projection.controls[clause.elementId];
  if (clause.operation.endsWith('interface')) {
    return projection.nodes.flatMap((entry) => entry.interfaces ?? []).find((entry) => itemId(entry) === clause.elementId);
  }
  return null;
}

export function verifyArchitectureIntent({ intent, baseAfter, baseAfterSha256 }) {
  const checked = validateArchitectureIntent(intent);
  validateCalmProjection(baseAfter);
  const clauses = checked.clauses.map((clause) => {
    const element = semanticElement(baseAfter, clause);
    let verdict;
    if (clause.operation.startsWith('remove-')) verdict = element ? 'deviated' : 'fulfilled';
    else if (!element) verdict = 'missing';
    else {
      const expected = expectedIntentFields(clause);
      const mismatched = Object.entries(expected).some(([key, value]) => canonicalJson(element[key]) !== canonicalJson(value));
      verdict = mismatched ? 'deviated' : 'fulfilled';
    }
    return { clauseId: clause.clauseId, verdict, elementIds: element ? [clause.elementId] : [], sourceRefs: [] };
  });
  const blocking = clauses.some((result) => {
    const source = checked.clauses.find((clause) => clause.clauseId === result.clauseId);
    return source.required && ['missing', 'deviated'].includes(result.verdict);
  });
  return selfHash('architecture-intent-fulfilment', {
    schemaVersion: currentSchemaVersion('architecture-intent-fulfilment'),
    kind: 'architecture-intent-fulfilment', workId: checked.workId,
    intentSha256: checked.intentSha256,
    baseBeforeSha256: checked.base.calmProjectionSha256,
    baseAfterSha256: exactHash(baseAfterSha256, 'Post-change projection digest'),
    clauses, blocking
  }, 'reportSha256');
}

export function validateArchitectureIntentFulfilment(value) {
  const record = readRecord('architecture-intent-fulfilment', value).record;
  if (record.kind !== 'architecture-intent-fulfilment' || !text(record.workId)
      || !Array.isArray(record.clauses) || typeof record.blocking !== 'boolean') {
    fail('Architecture intent fulfilment identity is invalid.', 'WMC_INTENT_UNFULFILLED');
  }
  for (const field of ['intentSha256', 'baseBeforeSha256', 'baseAfterSha256']) {
    exactHash(record[field], `Architecture fulfilment ${field}`);
  }
  const clauseIds = new Set();
  for (const clause of record.clauses) {
    if (!text(clause?.clauseId) || !['fulfilled', 'missing', 'deviated', 'unplanned', 'not-observable'].includes(clause.verdict)
        || !Array.isArray(clause.elementIds) || !Array.isArray(clause.sourceRefs)) {
      fail('Architecture intent fulfilment contains an invalid clause result.', 'WMC_INTENT_UNFULFILLED');
    }
    if (clauseIds.has(clause.clauseId)) {
      fail(`Architecture intent fulfilment repeats clause '${clause.clauseId}'.`, 'WMC_INTENT_UNFULFILLED');
    }
    clauseIds.add(clause.clauseId);
  }
  const core = clone(record); delete core.reportSha256;
  if (record.reportSha256 !== sha256(core)) {
    fail('Architecture intent fulfilment hash does not match its content.', 'WMC_INTENT_UNFULFILLED');
  }
  return record;
}

export function explainArchitectureElement({ projection, sourceMap, elementId, intent = null, intentPath = null }) {
  validateCalmProjection(projection);
  const row = sourceMap?.elements?.find((entry) => entry.elementId === elementId);
  if (!row && intent) {
    const checked = validateArchitectureIntent(intent);
    const clauses = checked.clauses.filter((clause) => clause.elementId === elementId);
    if (clauses.length) return Object.freeze({
      elementId,
      elementKind: clauses[0].operation.replace(/^(add|remove|change|apply)-/, ''),
      status: 'planned',
      sources: clauses.map((clause) => ({
        sourceKind: 'architecture-intent', sourceSha256: checked.intentSha256,
        assurance: 'human-confirmed', recordId: clause.clauseId,
        ...(intentPath ? { path: intentPath } : {})
      })),
      changeAt: intentPath ? [intentPath] : []
    });
  }
  if (!row) fail(`Architecture element '${elementId}' was not found.`, 'WMC_ELEMENT_NOT_FOUND');
  return Object.freeze({
    elementId, elementKind: row.elementKind, status: row.status, sources: clone(row.sources),
    changeAt: row.sources.map((source) => source.path).filter(Boolean)
  });
}

export const ARCHITECTURE_INTENT_OPERATIONS = Object.freeze([...INTENT_OPERATIONS].sort());
