import { collisionSafeIds, compareText, sealRecord, sha256 } from '../canonicalize.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  DERIVATION_ID_PATTERN, EVIDENCE_ID_PATTERN, FACT_ID_PATTERN, assertCanonicalOrder,
  assertExactKeys, assertPlainRecord, assertSchemaKind, assertSelfHash, assertSha256,
  assertString, assertStringArray, contractFailure
} from '../contracts.mjs';
import { resolveExtractorManifest, validateExtractorRegistry } from '../registry/extractors.mjs';
import { DERIVATION_STATUSES, assertVocabularyValue } from '../vocabularies.mjs';
import { validateEvidenceCatalog } from './evidence-catalog.mjs';
import { validateFactLedger } from './fact-ledger.mjs';

const EXTRACTOR_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;

export function validateDerivationIdentity(value) {
  assertPlainRecord(value, 'Derivation identity');
  assertExactKeys(value, {
    required: [
      'extractor', 'sourceManifestSha256', 'scopeManifestSha256', 'configurationSha256',
      'grammarSha256', 'dependencyManifestSha256', 'inputEvidenceIds'
    ],
    label: 'Derivation identity'
  });
  assertExactKeys(value.extractor, { required: ['id', 'version', 'implementationSha256'], label: 'Derivation extractor' });
  assertString(value.extractor.id, 'Derivation extractor id', { pattern: EXTRACTOR_ID_PATTERN });
  assertString(value.extractor.version, 'Derivation extractor version', { pattern: SEMVER_PATTERN });
  assertSha256(value.extractor.implementationSha256, 'Derivation extractor implementationSha256');
  for (const field of [
    'sourceManifestSha256', 'scopeManifestSha256', 'configurationSha256', 'grammarSha256', 'dependencyManifestSha256'
  ]) assertSha256(value[field], `Derivation ${field}`);
  assertStringArray(value.inputEvidenceIds, 'Derivation inputEvidenceIds', { sorted: true, pattern: EVIDENCE_ID_PATTERN });
  return value;
}

export function derivationIdentityFromRecord(value) {
  return {
    extractor: structuredClone(value.extractor),
    sourceManifestSha256: value.sourceManifestSha256,
    scopeManifestSha256: value.scopeManifestSha256,
    configurationSha256: value.configurationSha256,
    grammarSha256: value.grammarSha256,
    dependencyManifestSha256: value.dependencyManifestSha256,
    inputEvidenceIds: [...value.inputEvidenceIds]
  };
}

export function allocateDerivationIdentities(identityValues) {
  if (!Array.isArray(identityValues)) contractFailure('Derivation identities must be an array.');
  const entries = identityValues.map((value, index) => ({
    index,
    identity: structuredClone(validateDerivationIdentity(value)),
    digest: sha256(value)
  }));
  const ids = collisionSafeIds(entries.map((entry) => entry.digest), { prefix: 'DRV-' });
  return entries.map((entry) => ({
    index: entry.index,
    id: ids.get(entry.digest.slice(7)),
    identity: entry.identity
  }));
}

export function createDerivationCatalog({ identities = [], outputFactIdsByDerivationId = {},
  statusByDerivationId = {}, evidenceCatalog = null, factLedger = null,
  extractorRegistry = null } = {}) {
  const allocated = allocateDerivationIdentities(identities);
  const derivations = allocated.map(({ id, identity }) => {
    const outputFactIds = [...new Set(outputFactIdsByDerivationId[id] ?? [])].sort();
    const status = statusByDerivationId[id] ?? 'complete';
    return sealRecord({
      schemaVersion: currentSchemaVersion('world-model-derivation'),
      kind: 'world-model-derivation',
      id,
      ...identity,
      outputFactIds,
      status
    }, 'derivationSha256');
  }).sort((left, right) => compareText(left.id, right.id));
  return validateDerivationCatalog(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-derivation-catalog'),
    kind: 'world-model-derivation-catalog',
    derivations
  }, 'catalogSha256'), { evidenceCatalog, factLedger, extractorRegistry });
}

export function validateDerivationRecord(value, {
  evidenceIds = null, factIds = null, expectedId = null, extractorRegistry = null
} = {}) {
  assertPlainRecord(value, 'World-model Derivation Record');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'id', 'extractor', 'sourceManifestSha256', 'scopeManifestSha256',
      'configurationSha256', 'grammarSha256', 'dependencyManifestSha256', 'inputEvidenceIds',
      'outputFactIds', 'status', 'derivationSha256'
    ],
    label: 'World-model Derivation Record'
  });
  assertSchemaKind(value, 'world-model-derivation', 'World-model Derivation Record');
  assertString(value.id, 'Derivation id', { pattern: DERIVATION_ID_PATTERN });
  validateDerivationIdentity(derivationIdentityFromRecord(value));
  if (extractorRegistry) {
    const registry = validateExtractorRegistry(extractorRegistry);
    const registered = resolveExtractorManifest(
      registry, `${value.extractor.id}@${value.extractor.version}`
    );
    if (registered.producer.implementationSha256 !== value.extractor.implementationSha256) {
      contractFailure(
        `Derivation '${value.id}' is not bound to the registered extractor implementation.`,
        'WMB_EXTRACTOR_REGISTRY_MISMATCH'
      );
    }
    if (registered.producer.parser.grammarSha256 !== value.grammarSha256) {
      contractFailure(
        `Derivation '${value.id}' is not bound to the registered extractor parser grammar.`,
        'WMB_DERIVATION_BINDING_INVALID',
        {
          expectedGrammarSha256: registered.producer.parser.grammarSha256,
          receivedGrammarSha256: value.grammarSha256
        }
      );
    }
    const expectedDependency = sha256({
      extractorRegistrySha256: registry.registrySha256,
      extractorManifestSha256: registered.manifestSha256
    });
    if (value.dependencyManifestSha256 !== expectedDependency) {
      contractFailure(
        `Derivation '${value.id}' does not bind its exact extractor registry and manifest.`,
        'WMB_DERIVATION_BINDING_INVALID'
      );
    }
  }
  assertStringArray(value.outputFactIds, 'Derivation outputFactIds', { sorted: true, pattern: FACT_ID_PATTERN });
  assertVocabularyValue('Derivation status', value.status, DERIVATION_STATUSES);
  if (evidenceIds) for (const id of value.inputEvidenceIds) {
    if (!evidenceIds.has(id)) contractFailure(`Derivation '${value.id}' references unknown evidence '${id}'.`, 'WMB_EVIDENCE_NOT_REGISTERED');
  }
  if (factIds) for (const id of value.outputFactIds) {
    if (!factIds.has(id)) contractFailure(`Derivation '${value.id}' references unknown fact '${id}'.`, 'WMB_FACT_NOT_REGISTERED');
  }
  if (expectedId && value.id !== expectedId) contractFailure(`Derivation '${value.id}' has a non-canonical content ID.`, 'WMB_CONTENT_ID_INVALID');
  assertSha256(value.derivationSha256, 'Derivation derivationSha256');
  assertSelfHash(value, 'derivationSha256', 'World-model Derivation Record');
  return value;
}

export function validateDerivationCatalog(value, {
  evidenceCatalog = null, factLedger = null, extractorRegistry = null
} = {}) {
  assertPlainRecord(value, 'World-model Derivation Catalog');
  assertExactKeys(value, { required: ['schemaVersion', 'kind', 'derivations', 'catalogSha256'], label: 'World-model Derivation Catalog' });
  assertSchemaKind(value, 'world-model-derivation-catalog', 'World-model Derivation Catalog');
  if (!Array.isArray(value.derivations)) contractFailure('Derivation Catalog derivations must be an array.');
  const evidence = evidenceCatalog ? validateEvidenceCatalog(evidenceCatalog) : null;
  const evidenceIds = evidence ? new Set(evidence.items.map((item) => item.id)) : null;
  const derivationIds = new Set(value.derivations.map((item) => item?.id));
  const facts = factLedger
    ? validateFactLedger(factLedger, { evidenceCatalog: evidence, derivationIds })
    : null;
  const factsById = facts ? new Map(facts.facts.map((fact) => [fact.id, fact])) : null;
  const factIds = factsById ? new Set(factsById.keys()) : null;
  const identities = value.derivations.map(derivationIdentityFromRecord);
  const allocated = allocateDerivationIdentities(identities);
  const expectedByIndex = new Map(allocated.map((entry) => [entry.index, entry.id]));
  const ids = new Set();
  value.derivations.forEach((derivation, index) => {
    validateDerivationRecord(derivation, {
      evidenceIds, factIds, expectedId: expectedByIndex.get(index), extractorRegistry
    });
    if (ids.has(derivation.id)) contractFailure(`Derivation Catalog repeats id '${derivation.id}'.`);
    ids.add(derivation.id);
    if (evidence && (derivation.sourceManifestSha256 !== evidence.sourceManifestSha256
        || derivation.scopeManifestSha256 !== evidence.scopeManifestSha256)) {
      contractFailure(`Derivation '${derivation.id}' does not bind the Evidence Catalog source and scope.`, 'WMB_DERIVATION_BINDING_INVALID');
    }
    if (factsById) for (const factId of derivation.outputFactIds) {
      if (factsById.get(factId)?.derivationId !== derivation.id) {
        contractFailure(`Derivation '${derivation.id}' does not own output Fact '${factId}'.`, 'WMB_DERIVATION_BINDING_INVALID');
      }
    }
    if (factsById) {
      const retainedEvidenceIds = [...new Set(derivation.outputFactIds.flatMap((factId) => (
        factsById.get(factId)?.evidenceIds ?? []
      )))].sort();
      const inputEvidenceIds = derivation.inputEvidenceIds;
      for (const factId of derivation.outputFactIds) {
        for (const evidenceId of factsById.get(factId).evidenceIds) {
          if (!inputEvidenceIds.includes(evidenceId)) {
            contractFailure(
              `Fact '${factId}' evidence '${evidenceId}' is absent from derivation '${derivation.id}' inputs.`,
              'WMB_DERIVATION_EVIDENCE_MISMATCH',
              { derivationId: derivation.id, factId, evidenceId }
            );
          }
        }
      }
      if (retainedEvidenceIds.length !== inputEvidenceIds.length
          || retainedEvidenceIds.some((id, index) => id !== inputEvidenceIds[index])) {
        contractFailure(
          `Derivation '${derivation.id}' inputs are not the exact union of its output Fact evidence.`,
          'WMB_DERIVATION_EVIDENCE_MISMATCH',
          {
            derivationId: derivation.id,
            expectedEvidenceIds: retainedEvidenceIds,
            actualEvidenceIds: [...inputEvidenceIds]
          }
        );
      }
    }
  });
  if (factsById) {
    const byId = new Map(value.derivations.map((item) => [item.id, item]));
    for (const fact of factsById.values()) {
      const derivation = byId.get(fact.derivationId);
      if (!derivation || !derivation.outputFactIds.includes(fact.id)) {
        contractFailure(`Fact '${fact.id}' is not retained by its registered derivation.`, 'WMB_DERIVATION_BINDING_INVALID');
      }
    }
  }
  assertCanonicalOrder(value.derivations, (item) => item.id, 'Derivation Catalog records');
  assertSha256(value.catalogSha256, 'Derivation Catalog catalogSha256');
  assertSelfHash(value, 'catalogSha256', 'World-model Derivation Catalog');
  return value;
}

export function derivationIdForIdentity(catalogValue, identityValue) {
  const catalog = validateDerivationCatalog(catalogValue);
  const digest = sha256(validateDerivationIdentity(identityValue));
  const match = catalog.derivations.find((item) => sha256(derivationIdentityFromRecord(item)) === digest);
  if (!match) contractFailure('Derivation identity is not registered.', 'WMB_DERIVATION_NOT_REGISTERED');
  return match.id;
}
