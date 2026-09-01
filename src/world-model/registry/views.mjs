import { canonicalJson, compareText, deepFreeze, sealRecord } from '../canonicalize.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  VIEW_ID_PATTERN, assertBoolean, assertCanonicalOrder, assertExactKeys, assertInteger,
  assertPlainRecord, assertSchemaKind, assertSelfHash, assertSha256, assertString,
  assertStringArray, contractFailure
} from '../contracts.mjs';
import {
  ASSURANCE_LEVELS, FACT_STATUSES, FACT_TYPES, GOVERNED_STRUCTURAL_ASSURANCE,
  MODEL_MODES, SECTION_KINDS, VIEW_STATUSES, assertVocabularyValue
} from '../vocabularies.mjs';

const SECTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const COMPOSITION_OUTPUT_SCHEMA = 'world-model-composition-candidate-v1';

function section(id, title, sectionKind = 'factual') {
  return { id, title, required: true, sectionKind };
}

function contract({ id, title, sections, requiredFactTypes, optionalFactTypes, requiredUnavailableSubjects,
  maximumSelectedFacts, tldrMaximumWords, sectionMaximumWords, totalMaximumWords }) {
  return sealRecord({
    schemaVersion: currentSchemaVersion('world-model-view-contract'),
    kind: 'world-model-view-contract',
    id,
    version: 4,
    title,
    publisher: { id: 'sflow-core' },
    sections,
    factPolicy: {
      requiredFactTypes,
      optionalFactTypes,
      allowedStatus: ['available', 'partial', 'unavailable', 'contradicted'],
      allowedAssurance: [...GOVERNED_STRUCTURAL_ASSURANCE],
      requiredUnavailableSubjects
    },
    bodyAccess: { allowed: false, maximumBytes: 0 },
    crossViewReferences: { allowed: false },
    narrative: {
      tldrMaximumWords,
      sectionMaximumWords,
      totalMaximumWords,
      factualUnitsRequireFactRefs: true
    },
    facts: { maximumSelectedFacts, canonicalBlock: 'kernel-materialized' },
    model: { mode: 'optional', outputSchema: 'world-model-composition-candidate-v1' },
    budgets: { maximumInputTokens: 8000, maximumOutputTokens: 1400 },
    risk: { class: 'low' },
    validity: { status: 'active' }
  }, 'contractSha256');
}

const BUILTINS = [
  contract({
    id: 'arch.contracts',
    title: 'Architecture contracts',
    sections: [
      section('public-contracts', 'Public contracts'),
      section('implementations', 'Implementations'),
      section('consumers', 'Consumers'),
      section('contract-contradictions', 'Contract contradictions', 'contradiction'),
      section('unavailable-runtime-guarantees', 'Unavailable runtime guarantees', 'unavailable')
    ],
    requiredFactTypes: ['consumer-dependency', 'implementation', 'interface', 'protocol-field', 'schema-contract', 'signature'],
    optionalFactTypes: [],
    requiredUnavailableSubjects: ['runtime-guarantee'],
    maximumSelectedFacts: 60,
    tldrMaximumWords: 120,
    sectionMaximumWords: 250,
    totalMaximumWords: 900
  }),
  contract({
    id: 'biz.rules',
    title: 'Business rules',
    sections: [
      section('registered-rules', 'Registered rules'),
      section('conditions-and-outcomes', 'Conditions and outcomes'),
      section('rule-locations', 'Rule locations'),
      section('conflicts-and-unavailable-meaning', 'Conflicts and unavailable meaning', 'unavailable')
    ],
    requiredFactTypes: ['rule-definition'],
    optionalFactTypes: ['business-glossary', 'clause-binding', 'condition-expression'],
    requiredUnavailableSubjects: ['business-meaning'],
    maximumSelectedFacts: 50,
    tldrMaximumWords: 100,
    sectionMaximumWords: 220,
    totalMaximumWords: 750
  }),
  contract({
    id: 'dev.hotspots',
    title: 'Development hotspots',
    sections: [
      section('structural-concentration', 'Structural concentration'),
      section('change-concentration', 'Change concentration'),
      section('dependency-concentration', 'Dependency concentration'),
      section('evidence-limitations', 'Evidence limitations', 'unavailable')
    ],
    requiredFactTypes: ['change-frequency', 'dependency-degree'],
    optionalFactTypes: ['complexity-metric', 'incident-mapping', 'ownership-concentration'],
    requiredUnavailableSubjects: ['complexity-metric', 'incident-mapping', 'ownership-concentration'],
    maximumSelectedFacts: 50,
    tldrMaximumWords: 100,
    sectionMaximumWords: 220,
    totalMaximumWords: 700
  }),
  contract({
    id: 'dev.impact',
    title: 'Development impact',
    sections: [
      section('changed-structure', 'Changed structure'),
      section('dependency-impact', 'Dependency impact'),
      section('affected-contracts', 'Affected contracts'),
      section('test-impact', 'Test impact'),
      section('unavailable-analysis', 'Unavailable analysis', 'unavailable')
    ],
    requiredFactTypes: ['changed-symbol', 'contract-change', 'dependency-edge'],
    optionalFactTypes: ['structural-impact', 'test-impact'],
    requiredUnavailableSubjects: ['runtime-frequency'],
    maximumSelectedFacts: 40,
    tldrMaximumWords: 120,
    sectionMaximumWords: 250,
    totalMaximumWords: 700
  })
].map(validateViewContract);

export function validateViewContract(value) {
  assertPlainRecord(value, 'World-model View Contract');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'id', 'version', 'title', 'publisher', 'sections',
      'factPolicy', 'bodyAccess', 'crossViewReferences', 'narrative', 'facts', 'model',
      'budgets', 'risk', 'validity', 'contractSha256'
    ],
    label: 'World-model View Contract'
  });
  assertSchemaKind(value, 'world-model-view-contract', 'World-model View Contract');
  assertString(value.id, 'View Contract id', { pattern: VIEW_ID_PATTERN });
  assertInteger(value.version, 'View Contract version', { minimum: 1 });
  assertString(value.title, 'View Contract title');
  assertExactKeys(value.publisher, { required: ['id'], label: 'View Contract publisher' });
  assertString(value.publisher.id, 'View Contract publisher id', { pattern: SECTION_ID_PATTERN });

  if (!Array.isArray(value.sections) || !value.sections.length) contractFailure('View Contract sections must be a non-empty array.');
  const sectionIds = new Set();
  for (const [index, item] of value.sections.entries()) {
    assertExactKeys(item, { required: ['id', 'title', 'required', 'sectionKind'], label: `View Contract section ${index}` });
    assertString(item.id, `View Contract section ${index} id`, { pattern: SECTION_ID_PATTERN });
    assertString(item.title, `View Contract section ${index} title`);
    assertBoolean(item.required, `View Contract section ${index} required`);
    assertVocabularyValue(`View Contract section ${index} kind`, item.sectionKind, SECTION_KINDS);
    if (sectionIds.has(item.id)) contractFailure(`View Contract repeats section '${item.id}'.`);
    sectionIds.add(item.id);
  }

  assertExactKeys(value.factPolicy, {
    required: ['requiredFactTypes', 'optionalFactTypes', 'allowedStatus', 'allowedAssurance', 'requiredUnavailableSubjects'],
    label: 'View Contract factPolicy'
  });
  for (const field of ['requiredFactTypes', 'optionalFactTypes', 'requiredUnavailableSubjects']) {
    assertStringArray(value.factPolicy[field], `View Contract factPolicy.${field}`, { sorted: true });
    value.factPolicy[field].forEach((entry) => assertVocabularyValue(`View Contract ${field}`, entry, FACT_TYPES));
  }
  const overlap = value.factPolicy.requiredFactTypes.filter((item) => value.factPolicy.optionalFactTypes.includes(item));
  if (overlap.length) contractFailure(`View Contract fact types cannot be both required and optional: ${overlap.join(', ')}.`);
  assertStringArray(value.factPolicy.allowedStatus, 'View Contract allowedStatus', { unique: true });
  value.factPolicy.allowedStatus.forEach((entry) => assertVocabularyValue('View Contract allowed status', entry, FACT_STATUSES));
  if (value.factPolicy.allowedStatus.includes('stale')) contractFailure('Current View Contracts cannot select stale facts.');
  assertStringArray(value.factPolicy.allowedAssurance, 'View Contract allowedAssurance', { unique: true });
  value.factPolicy.allowedAssurance.forEach((entry) => assertVocabularyValue('View Contract allowed assurance', entry, ASSURANCE_LEVELS));

  assertExactKeys(value.bodyAccess, { required: ['allowed', 'maximumBytes'], label: 'View Contract bodyAccess' });
  assertBoolean(value.bodyAccess.allowed, 'View Contract bodyAccess.allowed');
  assertInteger(value.bodyAccess.maximumBytes, 'View Contract bodyAccess.maximumBytes', { minimum: 0 });
  if (!value.bodyAccess.allowed && value.bodyAccess.maximumBytes !== 0) contractFailure('Denied body access must have a zero byte budget.');
  assertExactKeys(value.crossViewReferences, { required: ['allowed'], label: 'View Contract crossViewReferences' });
  assertBoolean(value.crossViewReferences.allowed, 'View Contract crossViewReferences.allowed');

  assertExactKeys(value.narrative, {
    required: ['tldrMaximumWords', 'sectionMaximumWords', 'totalMaximumWords', 'factualUnitsRequireFactRefs'],
    label: 'View Contract narrative'
  });
  assertInteger(value.narrative.tldrMaximumWords, 'View Contract TL;DR word budget', { minimum: 1 });
  assertInteger(value.narrative.sectionMaximumWords, 'View Contract section word budget', { minimum: 1 });
  assertInteger(value.narrative.totalMaximumWords, 'View Contract total word budget', { minimum: 1 });
  assertBoolean(value.narrative.factualUnitsRequireFactRefs, 'View Contract factualUnitsRequireFactRefs');

  assertExactKeys(value.facts, { required: ['maximumSelectedFacts', 'canonicalBlock'], label: 'View Contract facts' });
  assertInteger(value.facts.maximumSelectedFacts, 'View Contract maximumSelectedFacts', { minimum: 1 });
  if (value.facts.canonicalBlock !== 'kernel-materialized') contractFailure("View Contract facts.canonicalBlock must be 'kernel-materialized'.");
  assertExactKeys(value.model, { required: ['mode', 'outputSchema'], label: 'View Contract model' });
  assertVocabularyValue('View Contract model mode', value.model.mode, MODEL_MODES);
  if (value.model.outputSchema !== COMPOSITION_OUTPUT_SCHEMA) {
    contractFailure(`View Contract outputSchema must be '${COMPOSITION_OUTPUT_SCHEMA}'.`);
  }
  assertExactKeys(value.budgets, { required: ['maximumInputTokens', 'maximumOutputTokens'], label: 'View Contract budgets' });
  assertInteger(value.budgets.maximumInputTokens, 'View Contract maximumInputTokens', { minimum: 1 });
  assertInteger(value.budgets.maximumOutputTokens, 'View Contract maximumOutputTokens', { minimum: 1 });
  assertExactKeys(value.risk, { required: ['class'], label: 'View Contract risk' });
  if (!['low', 'medium', 'high'].includes(value.risk.class)) contractFailure('View Contract risk class is invalid.');
  assertExactKeys(value.validity, { required: ['status'], label: 'View Contract validity' });
  assertVocabularyValue('View Contract validity status', value.validity.status, VIEW_STATUSES);
  assertSha256(value.contractSha256, 'View Contract contractSha256');
  assertSelfHash(value, 'contractSha256', 'World-model View Contract');
  return value;
}

export function createViewRegistry(contracts) {
  if (!Array.isArray(contracts) || !contracts.length) contractFailure('View Registry contracts must be a non-empty array.');
  const sorted = contracts.map((item) => structuredClone(validateViewContract(item)))
    .sort((left, right) => compareText(`${left.id}@${left.version}`, `${right.id}@${right.version}`));
  const keys = sorted.map((item) => `${item.id}@${item.version}`);
  if (new Set(keys).size !== keys.length) contractFailure('View Registry contains a duplicate exact view version.');
  return validateViewRegistry(sealRecord({
    schemaVersion: 1,
    kind: 'world-model-view-registry',
    contracts: sorted
  }, 'registrySha256'));
}

export function validateViewRegistry(value) {
  assertPlainRecord(value, 'World-model View Registry');
  assertExactKeys(value, { required: ['schemaVersion', 'kind', 'contracts', 'registrySha256'], label: 'World-model View Registry' });
  assertSchemaKind(value, 'world-model-view-registry', 'World-model View Registry');
  if (!Array.isArray(value.contracts) || !value.contracts.length) contractFailure('View Registry contracts must be a non-empty array.');
  value.contracts.forEach(validateViewContract);
  assertCanonicalOrder(value.contracts, (item) => `${item.id}@${item.version}`, 'View Registry contracts');
  const keys = value.contracts.map((item) => `${item.id}@${item.version}`);
  if (new Set(keys).size !== keys.length) contractFailure('View Registry contains a duplicate exact view version.');
  assertSha256(value.registrySha256, 'View Registry registrySha256');
  assertSelfHash(value, 'registrySha256', 'World-model View Registry');
  return value;
}

export function resolveViewContract(registryValue, reference, { requireActive = true } = {}) {
  const registry = validateViewRegistry(registryValue);
  const parsed = typeof reference === 'string'
    ? /^(?<id>[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+)@(?<version>[1-9][0-9]*)$/.exec(reference)?.groups
    : reference;
  if (!parsed) contractFailure(`View reference '${reference}' must bind an exact dotted id and version.`, 'WMB_VIEW_REFERENCE_INVALID');
  assertString(parsed.id, 'View reference id', { pattern: VIEW_ID_PATTERN });
  const version = typeof parsed.version === 'string' ? Number(parsed.version) : parsed.version;
  assertInteger(version, 'View reference version', { minimum: 1 });
  const found = registry.contracts.find((item) => item.id === parsed.id && item.version === version);
  if (!found) contractFailure(`View '${parsed.id}@${version}' is not registered.`, 'WMB_VIEW_NOT_REGISTERED', { id: parsed.id, version });
  if (requireActive && found.validity.status !== 'active') contractFailure(`View '${parsed.id}@${version}' is not active.`, 'WMB_VIEW_NOT_ACTIVE');
  return found;
}

export const BUILTIN_VIEW_REGISTRY = deepFreeze(createViewRegistry(BUILTINS));
export const BUILTIN_VIEW_REFERENCES = Object.freeze(BUILTIN_VIEW_REGISTRY.contracts.map((item) => `${item.id}@${item.version}`));

/**
 * A self-hash proves only that a registry is internally consistent. Governed WMB v4 execution
 * additionally requires the exact reviewed registry shipped by this build; otherwise a caller
 * could coherently reseal a same-version contract and silently change selection or composition
 * policy. Keep generic validation available for authoring/diagnostics, but use this assertion at
 * every governed planning, execution, and publication boundary.
 */
export function assertInstalledViewRegistry(value) {
  const registry = validateViewRegistry(value);
  if (registry.registrySha256 !== BUILTIN_VIEW_REGISTRY.registrySha256
      || canonicalJson(registry) !== canonicalJson(BUILTIN_VIEW_REGISTRY)) {
    contractFailure(
      'World-model View Registry is not the exact reviewed registry installed by this build.',
      'WMB_VIEW_REGISTRY_NOT_INSTALLED',
      {
        expectedRegistrySha256: BUILTIN_VIEW_REGISTRY.registrySha256,
        receivedRegistrySha256: registry.registrySha256
      }
    );
  }
  return registry;
}

export function resolveBuiltInViewContract(reference, options) {
  return resolveViewContract(BUILTIN_VIEW_REGISTRY, reference, options);
}
