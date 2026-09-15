import {
  canonicalJson, compareText, deepFreeze, sha256
} from '../canonicalize.mjs';
import { contractFailure } from '../contracts.mjs';
import {
  resolveExtractorManifest, validateExtractorRegistry
} from '../registry/extractors.mjs';
import {
  resolveViewContract, validateViewRegistry
} from '../registry/views.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import { validateSourceSnapshot } from '../source/snapshot.mjs';
import {
  WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256
} from '../history/extraction-profile-owners.mjs';
import {
  REQUIRED_FACT_COVERAGE_ID, REQUIRED_FACT_COVERAGE_VERSION,
  extractRequiredFactCoverage
} from './adapters/required-fact-coverage.mjs';
import {
  allocateDerivationIdentities, createDerivationCatalog,
  derivationIdentityFromRecord, validateDerivationCatalog
} from './derivation-catalog.mjs';
import { validateEvidenceCatalog } from './evidence-catalog.mjs';
import {
  createFactLedger, factIdentityFromRecord, validateFactLedger
} from './fact-ledger.mjs';
import { selectViewFacts } from './selection.mjs';

function exactViewContracts(viewRegistry, viewContracts) {
  const registry = validateViewRegistry(viewRegistry);
  if (!Array.isArray(viewContracts)) {
    contractFailure('View projection contracts must be an array.', 'WMB_VIEW_REFERENCE_INVALID');
  }
  const views = viewContracts.map((value) => {
    const id = value?.id ?? value?.viewId;
    const version = value?.version ?? value?.viewVersion;
    const registered = resolveViewContract(registry, { id, version });
    if (value?.kind === 'world-model-view-contract'
        && canonicalJson(value) !== canonicalJson(registered)) {
      contractFailure(
        `View projection contract '${id}@${version}' is not the exact registered contract.`,
        'WMB_VIEW_CONTRACT_MISMATCH'
      );
    }
    if (registered.validity.status !== 'active') {
      contractFailure(
        `View projection contract '${registered.id}@${registered.version}' is not active.`,
        'WMB_VIEW_NOT_ACTIVE'
      );
    }
    return registered;
  }).sort((left, right) => compareText(
    `${left.id}@${left.version}`, `${right.id}@${right.version}`
  ));
  const identities = views.map((view) => `${view.id}@${view.version}`);
  if (new Set(identities).size !== identities.length) {
    contractFailure('View projection repeats an exact View Contract.');
  }
  return views;
}

function projectionDerivationIdentity({ source, scope, registry, manifest }) {
  return {
    extractor: {
      id: manifest.id,
      version: manifest.version,
      implementationSha256: manifest.producer.implementationSha256
    },
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    configurationSha256: WMP_EMPTY_EXTRACTOR_CONFIGURATION_SHA256,
    grammarSha256: manifest.producer.parser.grammarSha256,
    dependencyManifestSha256: sha256({
      extractorRegistrySha256: registry.registrySha256,
      extractorManifestSha256: manifest.manifestSha256
    }),
    inputEvidenceIds: []
  };
}

function coverageFactDraft(value, derivationId) {
  const result = {
    factType: value.factType,
    subject: structuredClone(value.subject),
    claim: value.claim,
    status: value.status,
    assurance: value.assurance,
    evidenceIds: [],
    derivationId,
    conflictsWith: [...value.conflictsWith],
    scopeStatus: value.scopeStatus
  };
  if (value.reason) result.reason = structuredClone(value.reason);
  return result;
}

/**
 * Overlay view-dependent typed coverage on one accepted immutable base registration.
 *
 * The persisted model owns only source-derived facts. `required-fact-coverage` depends on the
 * installed active View Contracts, so it belongs to the current projection and is recreated from
 * accepted facts without reading repository bytes or invoking any producer other than that pure
 * coverage adapter. The result is byte-identical to a normal current-view registration.
 */
export function createViewProjectionRegistration({
  sourceSnapshot,
  scopeManifest,
  extractorRegistry,
  viewRegistry,
  evidenceCatalog,
  derivationCatalog,
  factLedger,
  viewContracts = []
} = {}) {
  const source = validateSourceSnapshot(structuredClone(sourceSnapshot));
  const scope = validateScopeManifest(structuredClone(scopeManifest));
  const registry = validateExtractorRegistry(structuredClone(extractorRegistry));
  const evidence = validateEvidenceCatalog(structuredClone(evidenceCatalog), {
    sourceSnapshot: source,
    scopeManifest: scope
  });
  const baseDerivationIds = new Set(
    (derivationCatalog?.derivations ?? []).map((entry) => entry.id)
  );
  const baseFacts = validateFactLedger(structuredClone(factLedger), {
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistry: registry,
    evidenceCatalog: evidence,
    derivationIds: baseDerivationIds
  });
  const baseDerivations = validateDerivationCatalog(structuredClone(derivationCatalog), {
    evidenceCatalog: evidence,
    factLedger: baseFacts,
    extractorRegistry: registry
  });
  validateFactLedger(baseFacts, {
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistry: registry,
    evidenceCatalog: evidence,
    derivationIds: new Set(baseDerivations.derivations.map((entry) => entry.id))
  });
  if (baseDerivations.derivations.some(
    (entry) => entry.extractor.id === REQUIRED_FACT_COVERAGE_ID
  )) {
    contractFailure(
      'Persisted base facts already contain the view-dependent coverage producer.',
      'WMP_PROJECTION_BASE_INVALID'
    );
  }

  const views = exactViewContracts(viewRegistry, viewContracts);
  if (!views.length) {
    return deepFreeze({
      sourceSnapshot: source,
      scopeManifest: scope,
      extractorRegistrySha256: registry.registrySha256,
      evidenceCatalog: evidence,
      derivationCatalog: baseDerivations,
      factLedger: baseFacts,
      viewFactLedgers: []
    });
  }

  const coverageManifest = resolveExtractorManifest(
    registry, `${REQUIRED_FACT_COVERAGE_ID}@${REQUIRED_FACT_COVERAGE_VERSION}`
  );
  const coverage = extractRequiredFactCoverage({
    viewContracts: views,
    existingFacts: baseFacts.facts
  });
  const baseIdentities = baseDerivations.derivations.map(derivationIdentityFromRecord);
  const coverageIdentity = projectionDerivationIdentity({
    source, scope, registry, manifest: coverageManifest
  });
  const allocations = allocateDerivationIdentities([...baseIdentities, coverageIdentity]);
  for (const [index, derivation] of baseDerivations.derivations.entries()) {
    if (allocations[index].id !== derivation.id) {
      contractFailure(
        'View projection would change an immutable base Derivation identity.',
        'WMB_PROJECTION_ID_COLLISION'
      );
    }
  }
  const coverageDerivationId = allocations.at(-1).id;
  const factDrafts = [
    ...baseFacts.facts.map(factIdentityFromRecord),
    ...coverage.facts.map((fact) => coverageFactDraft(fact, coverageDerivationId))
  ];
  const derivationIds = new Set(allocations.map((entry) => entry.id));
  const projectedFacts = createFactLedger({
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistry: registry,
    evidenceCatalog: evidence,
    derivationIds,
    factDrafts
  });
  const projectedFactsById = new Map(projectedFacts.facts.map((fact) => [fact.id, fact]));
  for (const fact of baseFacts.facts) {
    if (canonicalJson(projectedFactsById.get(fact.id)) !== canonicalJson(fact)) {
      contractFailure(
        'View projection would change an immutable base Fact identity.',
        'WMB_PROJECTION_ID_COLLISION'
      );
    }
  }

  const outputFactIdsByDerivationId = Object.fromEntries([...derivationIds].map((id) => [
    id,
    projectedFacts.facts.filter((fact) => fact.derivationId === id)
      .map((fact) => fact.id).sort(compareText)
  ]));
  const statusByDerivationId = Object.fromEntries(baseDerivations.derivations.map((entry) => [
    entry.id, entry.status
  ]));
  const coverageFacts = projectedFacts.facts.filter(
    (fact) => fact.derivationId === coverageDerivationId
  );
  statusByDerivationId[coverageDerivationId] = coverageFacts.length
    && coverageFacts.every((fact) => fact.status === 'unavailable')
    ? 'unavailable'
    : coverageFacts.some((fact) => fact.status === 'unavailable' || fact.status === 'partial')
      ? 'partial'
      : 'complete';
  const projectedDerivations = createDerivationCatalog({
    identities: [...baseIdentities, coverageIdentity],
    outputFactIdsByDerivationId,
    statusByDerivationId,
    evidenceCatalog: evidence,
    factLedger: projectedFacts,
    extractorRegistry: registry
  });
  const projectedDerivationsById = new Map(
    projectedDerivations.derivations.map((entry) => [entry.id, entry])
  );
  for (const derivation of baseDerivations.derivations) {
    if (canonicalJson(projectedDerivationsById.get(derivation.id)) !== canonicalJson(derivation)) {
      contractFailure(
        'View projection would change an immutable base Derivation record.',
        'WMB_PROJECTION_ID_COLLISION'
      );
    }
  }
  const viewFactLedgers = views.map((viewContract) => selectViewFacts({
    factLedger: projectedFacts,
    viewContract
  }));
  return deepFreeze({
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistrySha256: registry.registrySha256,
    evidenceCatalog: evidence,
    derivationCatalog: projectedDerivations,
    factLedger: projectedFacts,
    viewFactLedgers
  });
}
