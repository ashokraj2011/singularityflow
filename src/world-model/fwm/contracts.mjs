import { currentSchemaVersion, readRecord } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { assertFwmRecordHash, fwmSealRecord, fwmSemanticSha256 } from './canonical.mjs';

export const FWM_SHA256 = /^sha256:[a-f0-9]{64}$/;
export const FWM_VIEW_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/;
export const FWM_EXACT_VIEW = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+@[1-9][0-9]*$/;
const SAFE_REF = /^(?:handler|profile|schema|freshness|admissibility|coverage|order|budget|render|validation):[a-z0-9][a-z0-9.-]*@[1-9][0-9]*$/;
const LOWER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function fail(message, code = 'FWM_CONTRACT_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label} must be a plain object.`);
  return value;
}

function exact(value, required, optional, label) {
  plain(value, label);
  const allowed = new Set([...required, ...optional]);
  for (const field of required) if (!Object.hasOwn(value, field)) fail(`${label} is missing '${field}'.`);
  for (const field of Object.keys(value)) if (!allowed.has(field)) fail(`${label} contains unknown field '${field}'.`);
  return value;
}

function text(value, label, pattern = null) {
  if (typeof value !== 'string' || !value.length || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid.`);
  }
  return value;
}

function integer(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`${label} is invalid.`);
  return value;
}

function array(value, label, item, { minimum = 0, unique = false, sorted = false } = {}) {
  if (!Array.isArray(value) || value.length < minimum) fail(`${label} must be an array.`);
  value.forEach((entry, index) => item(entry, `${label}[${index}]`));
  if (unique && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) fail(`${label} contains duplicates.`);
  if (sorted && value.some((entry, index) => index && JSON.stringify(value[index - 1]) >= JSON.stringify(entry))) {
    fail(`${label} must be unique and canonically ordered.`, 'FWM_CANONICAL_ORDER_INVALID');
  }
  return value;
}

function digest(value, label) { return text(value, label, FWM_SHA256); }
function exactView(value, label) { return text(value, label, FWM_EXACT_VIEW); }
function safeRef(value, label) { return text(value, label, SAFE_REF); }

function schema(record, family, kind, label) {
  try { readRecord(family, record); }
  catch (error) {
    fail(`${label} schema is unsupported: ${error.message}`, 'FWM_UNSUPPORTED_SCHEMA');
  }
  if (record.kind !== kind) {
    fail(`${label} schema or kind is unsupported.`, 'FWM_UNSUPPORTED_SCHEMA');
  }
}

function assertSortedStrings(values, label, pattern = null) {
  return array(values, label, (value, itemLabel) => text(value, itemLabel, pattern), {
    unique: true, sorted: true
  });
}

export function createFwmViewDescriptor(values) {
  return validateFwmViewDescriptor(fwmSealRecord({
    schemaVersion: currentSchemaVersion('world-model-read-view-descriptor'),
    kind: 'world-model-read-view-descriptor',
    ...structuredClone(values)
  }, 'descriptorSha256'));
}

export function validateFwmViewDescriptor(value) {
  const record = exact(value, [
    'schemaVersion', 'kind', 'name', 'revision', 'title', 'handlerRef',
    'implementationSha256', 'queryProfileRef', 'parameterSchemaRef', 'resultSchemaRef',
    'inputKinds', 'requiredDomains', 'requiredCapabilities', 'consumerClasses',
    'freshnessPolicyRef', 'admissibilityProfileRef', 'coverageContractRef',
    'orderingProfileRef', 'budgetProfileRef', 'renderProfileRef', 'dependencyViews',
    'validationProfileRef', 'outputUse', 'permissions', 'lifecycle', 'descriptorSha256'
  ], [], 'FWM View Descriptor');
  schema(record, 'world-model-read-view-descriptor', 'world-model-read-view-descriptor', 'FWM View Descriptor');
  text(record.name, 'FWM view name', FWM_VIEW_ID);
  integer(record.revision, 'FWM view revision', 1);
  text(record.title, 'FWM view title');
  safeRef(record.handlerRef, 'FWM view handlerRef');
  digest(record.implementationSha256, 'FWM view implementationSha256');
  for (const field of [
    'queryProfileRef', 'parameterSchemaRef', 'resultSchemaRef', 'freshnessPolicyRef',
    'admissibilityProfileRef', 'coverageContractRef', 'orderingProfileRef',
    'budgetProfileRef', 'renderProfileRef', 'validationProfileRef'
  ]) safeRef(record[field], `FWM view ${field}`);
  assertSortedStrings(record.inputKinds, 'FWM view inputKinds', LOWER_ID);
  assertSortedStrings(record.requiredDomains, 'FWM view requiredDomains', LOWER_ID);
  assertSortedStrings(record.requiredCapabilities, 'FWM view requiredCapabilities', /^[a-z][a-z0-9.-]*$/);
  assertSortedStrings(record.consumerClasses, 'FWM view consumerClasses', LOWER_ID);
  assertSortedStrings(record.dependencyViews, 'FWM view dependencyViews', FWM_EXACT_VIEW);
  if (!['advisory', 'explanatory', 'verifier-input'].includes(record.outputUse)) {
    fail('FWM view outputUse is invalid.');
  }
  exact(record.permissions, [
    'model', 'network', 'sourceWrites', 'domainWrites', 'derivedCacheWrites'
  ], [], 'FWM view permissions');
  if (record.permissions.model !== 'never' || record.permissions.network !== 'none'
      || record.permissions.sourceWrites !== false || record.permissions.domainWrites !== false
      || record.permissions.derivedCacheWrites !== true) {
    fail('FWM structural views require the model-free, network-free, read-only capability profile.',
      'FWM_VIEW_CAPABILITY_INVALID');
  }
  if (!['active', 'draft', 'deprecated', 'retired-for-new-use', 'archived'].includes(record.lifecycle)) {
    fail('FWM view lifecycle is invalid.');
  }
  assertFwmRecordHash(record, 'descriptorSha256');
  return record;
}

export function createFwmConsumer(values) {
  return validateFwmConsumer(fwmSealRecord({
    schemaVersion: currentSchemaVersion('world-model-read-consumer'),
    kind: 'world-model-read-consumer',
    ...structuredClone(values)
  }, 'consumerSha256'));
}

export function validateFwmConsumer(value) {
  const record = exact(value, [
    'schemaVersion', 'kind', 'id', 'consumerClass', 'owner', 'viewRefs', 'required',
    'maximumBytes', 'fallback', 'consumerSha256'
  ], [], 'FWM Consumer Contract');
  schema(record, 'world-model-read-consumer', 'world-model-read-consumer', 'FWM Consumer Contract');
  text(record.id, 'FWM consumer id', LOWER_ID);
  text(record.consumerClass, 'FWM consumer class', LOWER_ID);
  text(record.owner, 'FWM consumer owner', LOWER_ID);
  assertSortedStrings(record.viewRefs, 'FWM consumer viewRefs', FWM_EXACT_VIEW);
  if (typeof record.required !== 'boolean') fail('FWM consumer required must be boolean.');
  integer(record.maximumBytes, 'FWM consumer maximumBytes', 1024, 65536);
  if (!['unavailable', 'ordinary-files'].includes(record.fallback)) fail('FWM consumer fallback is invalid.');
  assertFwmRecordHash(record, 'consumerSha256');
  return record;
}

export function createFwmRegistry(descriptors) {
  const sorted = descriptors.map((entry) => structuredClone(validateFwmViewDescriptor(entry)))
    .sort((left, right) => compareText(`${left.name}@${left.revision}`, `${right.name}@${right.revision}`));
  return validateFwmRegistry(fwmSealRecord({
    schemaVersion: currentSchemaVersion('world-model-read-registry'),
    kind: 'world-model-read-registry',
    packageId: 'sflow-core-structural',
    packageRevision: 1,
    descriptors: sorted
  }, 'registrySha256'));
}

export function validateFwmRegistry(value) {
  const record = exact(value, [
    'schemaVersion', 'kind', 'packageId', 'packageRevision', 'descriptors', 'registrySha256'
  ], [], 'FWM View Registry');
  schema(record, 'world-model-read-registry', 'world-model-read-registry', 'FWM View Registry');
  text(record.packageId, 'FWM registry package id', LOWER_ID);
  integer(record.packageRevision, 'FWM registry package revision', 1);
  array(record.descriptors, 'FWM registry descriptors', validateFwmViewDescriptor, { minimum: 1 });
  const refs = record.descriptors.map((entry) => `${entry.name}@${entry.revision}`);
  if (new Set(refs).size !== refs.length || refs.some((entry, index) => index && refs[index - 1] >= entry)) {
    fail('FWM registry descriptors must be unique and canonically ordered.', 'FWM_CANONICAL_ORDER_INVALID');
  }
  const known = new Set(refs);
  for (const descriptor of record.descriptors) {
    for (const dependency of descriptor.dependencyViews) {
      if (!known.has(dependency)) fail(`FWM view dependency '${dependency}' is not registered.`, 'FWM_VIEW_NOT_REGISTERED');
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byRef = new Map(record.descriptors.map((entry) => [`${entry.name}@${entry.revision}`, entry]));
  const visit = (reference) => {
    if (visiting.has(reference)) fail(`FWM view dependency cycle reaches '${reference}'.`, 'FWM_VIEW_DEPENDENCY_CYCLE');
    if (visited.has(reference)) return;
    visiting.add(reference);
    for (const dependency of byRef.get(reference).dependencyViews) visit(dependency);
    visiting.delete(reference);
    visited.add(reference);
  };
  refs.forEach(visit);
  assertFwmRecordHash(record, 'registrySha256');
  return record;
}

export function createFwmActivation({ registrySha256, activeViews, aliases, consumers }) {
  return validateFwmActivation(fwmSealRecord({
    schemaVersion: currentSchemaVersion('world-model-read-activation'),
    kind: 'world-model-read-activation', registrySha256,
    activeViews: [...activeViews].sort(),
    aliases: [...aliases].sort((left, right) => compareText(left.name, right.name)),
    consumers: consumers.map((entry) => structuredClone(entry))
      .sort((left, right) => compareText(left.id, right.id)),
    status: 'active'
  }, 'activationSha256'));
}

export function validateFwmActivation(value, registry = null) {
  const record = exact(value, [
    'schemaVersion', 'kind', 'registrySha256', 'activeViews', 'aliases', 'consumers',
    'status', 'activationSha256'
  ], [], 'FWM Registry Activation');
  schema(record, 'world-model-read-activation', 'world-model-read-activation', 'FWM Registry Activation');
  digest(record.registrySha256, 'FWM activation registrySha256');
  assertSortedStrings(record.activeViews, 'FWM activation activeViews', FWM_EXACT_VIEW);
  array(record.aliases, 'FWM activation aliases', (alias, label) => {
    exact(alias, ['name', 'viewRef'], [], label);
    text(alias.name, `${label}.name`, FWM_VIEW_ID);
    exactView(alias.viewRef, `${label}.viewRef`);
  });
  if (new Set(record.aliases.map((entry) => entry.name)).size !== record.aliases.length
      || record.aliases.some((entry, index) => index && record.aliases[index - 1].name >= entry.name)) {
    fail('FWM activation aliases must be unique and canonically ordered.');
  }
  array(record.consumers, 'FWM activation consumers', validateFwmConsumer);
  if (new Set(record.consumers.map((entry) => entry.id)).size !== record.consumers.length
      || record.consumers.some((entry, index) => index && record.consumers[index - 1].id >= entry.id)) {
    fail('FWM activation consumers must be unique and canonically ordered.');
  }
  if (record.status !== 'active') fail('FWM registry activation status is invalid.');
  if (registry) {
    const installed = validateFwmRegistry(registry);
    if (record.registrySha256 !== installed.registrySha256) fail('FWM activation binds another registry.', 'FWM_REGISTRY_BINDING_INVALID');
    const known = new Set(installed.descriptors.map((entry) => `${entry.name}@${entry.revision}`));
    for (const reference of [...record.activeViews, ...record.aliases.map((entry) => entry.viewRef),
      ...record.consumers.flatMap((entry) => entry.viewRefs)]) {
      if (!known.has(reference)) fail(`FWM activation references unknown view '${reference}'.`, 'FWM_VIEW_NOT_REGISTERED');
    }
    for (const reference of record.activeViews) {
      const descriptor = installed.descriptors.find((entry) => `${entry.name}@${entry.revision}` === reference);
      if (descriptor.lifecycle !== 'active') fail(`FWM activation cannot activate '${reference}' in lifecycle '${descriptor.lifecycle}'.`, 'FWM_VIEW_NOT_ACTIVE');
    }
    for (const reference of record.activeViews) {
      if (!record.consumers.some((consumer) => consumer.viewRefs.includes(reference))) {
        fail(`Active FWM view '${reference}' has no consumer contract.`, 'FWM_VIEW_CONSUMER_REQUIRED');
      }
    }
  }
  assertFwmRecordHash(record, 'activationSha256');
  return record;
}

export function createFwmInputBinding(values) {
  return validateFwmInputBinding(fwmSealRecord({
    schemaVersion: currentSchemaVersion('world-model-input-binding'),
    kind: 'world-model-input-binding',
    ...structuredClone(values)
  }, 'bindingSha256'));
}

export function validateFwmInputBinding(value) {
  const record = exact(value, [
    'schemaVersion', 'kind', 'sourceDomainId', 'sourceKind', 'sourceRefs',
    'generationRefs', 'candidateRef', 'policyRef', 'capabilityRef', 'ledgerPins',
    'recordRoots', 'evaluationBoundary', 'coverage', 'consistency', 'bindingSha256'
  ], [], 'FWM Input Binding');
  schema(record, 'world-model-input-binding', 'world-model-input-binding', 'FWM Input Binding');
  digest(record.sourceDomainId, 'FWM input sourceDomainId');
  if (!['git-commit', 'product-candidate', 'working-tree', 'loc-candidate', 'loc-bundle', 'recorded-domain-snapshot'].includes(record.sourceKind)) {
    fail('FWM input sourceKind is unsupported.', 'FWM_UNSUPPORTED_CAPABILITY');
  }
  const refs = (values, label) => array(values, label, (entry, itemLabel) => {
    exact(entry, ['kind', 'id', 'sha256'], [], itemLabel);
    text(entry.kind, `${itemLabel}.kind`, LOWER_ID);
    text(entry.id, `${itemLabel}.id`);
    digest(entry.sha256, `${itemLabel}.sha256`);
  }, { unique: true, sorted: true });
  refs(record.sourceRefs, 'FWM input sourceRefs');
  refs(record.generationRefs, 'FWM input generationRefs');
  exact(record.candidateRef, ['status'], ['id', 'sha256'], 'FWM input candidateRef');
  if (!['required', 'not-required', 'unavailable'].includes(record.candidateRef.status)) fail('FWM input candidateRef status is invalid.');
  if (record.candidateRef.status === 'required') {
    text(record.candidateRef.id, 'FWM candidate id'); digest(record.candidateRef.sha256, 'FWM candidate sha256');
  } else if (Object.hasOwn(record.candidateRef, 'id') || Object.hasOwn(record.candidateRef, 'sha256')) {
    fail('FWM candidate identity is allowed only when the candidate is required.');
  }
  for (const field of ['policyRef', 'capabilityRef']) {
    if (record[field] !== null) digest(record[field], `FWM input ${field}`);
  }
  refs(record.ledgerPins, 'FWM input ledgerPins');
  refs(record.recordRoots, 'FWM input recordRoots');
  exact(record.evaluationBoundary, ['kind', 'value'], [], 'FWM input evaluationBoundary');
  text(record.evaluationBoundary.kind, 'FWM evaluation boundary kind', LOWER_ID);
  text(record.evaluationBoundary.value, 'FWM evaluation boundary value');
  exact(record.coverage, ['status', 'limitations'], [], 'FWM input coverage');
  if (!['complete', 'partial', 'unavailable'].includes(record.coverage.status)) fail('FWM input coverage status is invalid.');
  assertSortedStrings(record.coverage.limitations, 'FWM input limitations');
  exact(record.consistency, ['kind', 'sha256'], [], 'FWM input consistency');
  text(record.consistency.kind, 'FWM consistency kind', LOWER_ID);
  digest(record.consistency.sha256, 'FWM consistency sha256');
  assertFwmRecordHash(record, 'bindingSha256');
  return record;
}

export function createFwmOrigin(values) {
  return validateFwmOrigin(fwmSealRecord({
    schemaVersion: currentSchemaVersion('world-model-record-origin'),
    kind: 'world-model-record-origin', ...structuredClone(values)
  }, 'originSha256'));
}

export function validateFwmOrigin(value) {
  const record = exact(value, [
    'schemaVersion', 'kind', 'originClass', 'sourceRef', 'producerRef',
    'validationRef', 'limitations', 'originSha256'
  ], [], 'FWM Record Origin');
  schema(record, 'world-model-record-origin', 'world-model-record-origin', 'FWM Record Origin');
  if (!['parsed', 'declared', 'signed', 'computed'].includes(record.originClass)) fail('FWM origin class is unsupported.');
  digest(record.sourceRef, 'FWM origin sourceRef');
  text(record.producerRef, 'FWM origin producerRef');
  if (record.validationRef !== null) digest(record.validationRef, 'FWM origin validationRef');
  assertSortedStrings(record.limitations, 'FWM origin limitations');
  assertFwmRecordHash(record, 'originSha256');
  return record;
}

export function createFwmReadResult(values) {
  return validateFwmReadResult(fwmSealRecord({
    schemaVersion: currentSchemaVersion('world-model-read-result'),
    kind: 'world-model-read-result', ...structuredClone(values)
  }, 'resultSha256'));
}

export function validateFwmReadResult(value) {
  const record = exact(value, [
    'schemaVersion', 'kind', 'resolvedView', 'inputBinding', 'semanticQueryId',
    'freshness', 'originSummary', 'admissibilityProfile', 'coverage', 'resultStatus',
    'items', 'origins', 'evidenceRefs', 'partial', 'reasons', 'continuation',
    'semanticResultDigest', 'deliveredSliceDigest', 'resultSha256'
  ], [], 'FWM Read Result');
  schema(record, 'world-model-read-result', 'world-model-read-result', 'FWM Read Result');
  exact(record.resolvedView, ['reference', 'descriptorSha256', 'registrySha256', 'activationSha256'], [], 'FWM resolved view');
  exactView(record.resolvedView.reference, 'FWM resolved view reference');
  for (const field of ['descriptorSha256', 'registrySha256', 'activationSha256']) digest(record.resolvedView[field], `FWM resolved view ${field}`);
  validateFwmInputBinding(record.inputBinding);
  digest(record.semanticQueryId, 'FWM semanticQueryId');
  exact(record.freshness, ['sourceKind', 'status', 'bindingSha256'], [], 'FWM freshness');
  text(record.freshness.sourceKind, 'FWM freshness sourceKind', LOWER_ID);
  if (!['fresh', 'captured', 'stale', 'unavailable'].includes(record.freshness.status)) fail('FWM freshness status is invalid.');
  digest(record.freshness.bindingSha256, 'FWM freshness bindingSha256');
  assertSortedStrings(record.originSummary, 'FWM originSummary');
  safeRef(record.admissibilityProfile, 'FWM admissibility profile');
  exact(record.coverage, ['analysis', 'scan', 'traversal', 'delivery'], [], 'FWM read coverage');
  for (const field of ['analysis', 'scan', 'traversal', 'delivery']) {
    if (!['complete', 'partial', 'unavailable', 'not-required'].includes(record.coverage[field])) fail(`FWM coverage ${field} is invalid.`);
  }
  if (!['found', 'absent-in-complete-scope', 'unknown', 'unavailable'].includes(record.resultStatus)) fail('FWM result status is invalid.');
  array(record.items, 'FWM result items', (entry, label) => {
    exact(entry, ['record', 'originSha256'], [], label);
    plain(entry.record, `${label}.record`);
    digest(entry.originSha256, `${label}.originSha256`);
  });
  array(record.origins, 'FWM result origins', validateFwmOrigin);
  if (new Set(record.origins.map((entry) => entry.originSha256)).size !== record.origins.length
      || record.origins.some((entry, index) => index
        && record.origins[index - 1].originSha256 >= entry.originSha256)) {
    fail('FWM result origins must be unique and ordered by originSha256.', 'FWM_CANONICAL_ORDER_INVALID');
  }
  const originIds = new Set(record.origins.map((entry) => entry.originSha256));
  for (const item of record.items) {
    if (!originIds.has(item.originSha256)) {
      fail(`FWM result item references missing origin '${item.originSha256}'.`, 'FWM_ORIGIN_NOT_FOUND');
    }
  }
  const actualOriginSummary = [...new Set(record.origins.map((entry) => entry.originClass))].sort();
  if (JSON.stringify(actualOriginSummary) !== JSON.stringify(record.originSummary)) {
    fail('FWM originSummary does not match the delivered origins.');
  }
  assertSortedStrings(record.evidenceRefs, 'FWM evidenceRefs', FWM_SHA256);
  if (typeof record.partial !== 'boolean') fail('FWM partial must be boolean.');
  const computedPartial = Object.values(record.coverage)
    .some((entry) => entry === 'partial' || entry === 'unavailable');
  if (record.partial !== computedPartial) fail('FWM partial does not match its coverage dimensions.');
  if (record.freshness.bindingSha256 !== record.inputBinding.bindingSha256) {
    fail('FWM freshness does not bind the delivered input binding.');
  }
  if (record.resultStatus === 'found' && record.items.length === 0) fail('FWM found result has no items.');
  if (record.resultStatus !== 'found' && record.items.length !== 0) fail('FWM non-found result contains items.');
  if (record.resultStatus === 'absent-in-complete-scope' && record.partial) {
    fail('FWM absence cannot be claimed with partial coverage.');
  }
  if (record.resultStatus === 'unknown' && !record.partial) fail('FWM unknown result requires partial coverage.');
  if (record.resultStatus === 'unavailable' && record.coverage.analysis !== 'unavailable') {
    fail('FWM unavailable result requires unavailable analysis coverage.');
  }
  assertSortedStrings(record.reasons, 'FWM reasons');
  if (record.continuation !== null) text(record.continuation, 'FWM continuation');
  for (const field of ['semanticResultDigest', 'deliveredSliceDigest', 'resultSha256']) digest(record[field], `FWM result ${field}`);
  const semanticResultDigest = fwmSemanticSha256('fwm/semantic-result/v1', {
    resolvedView: record.resolvedView.reference,
    inputBindingSha256: record.inputBinding.bindingSha256,
    semanticQueryId: record.semanticQueryId,
    resultStatus: record.resultStatus,
    items: record.items,
    coverage: {
      analysis: record.coverage.analysis,
      scan: record.coverage.scan,
      traversal: record.coverage.traversal
    }
  });
  if (record.semanticResultDigest !== semanticResultDigest) {
    fail('FWM semantic result digest does not match the semantic result.', 'FWM_SEMANTIC_DIGEST_MISMATCH');
  }
  const deliveredSliceDigest = fwmSemanticSha256('fwm/delivered-slice/v1', {
    semanticResultDigest,
    items: record.items,
    origins: record.origins,
    coverage: record.coverage,
    partial: record.partial,
    reasons: record.reasons,
    continuation: record.continuation
  });
  if (record.deliveredSliceDigest !== deliveredSliceDigest) {
    fail('FWM delivered slice digest does not match the result envelope.', 'FWM_DELIVERY_DIGEST_MISMATCH');
  }
  assertFwmRecordHash(record, 'resultSha256');
  return record;
}

export function fwmDigest(label, value) {
  return fwmSemanticSha256(`fwm/${label}`, value);
}
