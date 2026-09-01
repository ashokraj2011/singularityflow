import { compareText, sha256 } from '../canonicalize.mjs';
import { assertExactKeys, assertPlainRecord, contractFailure } from '../contracts.mjs';
import {
  BUILTIN_EXTRACTOR_REGISTRY, DEFAULT_EXTRACTOR_REFERENCES, resolveExtractorManifest,
  validateExtractorRegistry
} from '../registry/extractors.mjs';
import {
  BUILTIN_VIEW_REGISTRY, resolveViewContract, validateViewContract, validateViewRegistry
} from '../registry/views.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import {
  createExactSourceSnapshot, validateSourceSnapshot, verifyExactSourceSnapshot
} from '../source/snapshot.mjs';
import {
  IMPORT_DEPENDENCY_ID, IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256, extractImportDependencies,
  LANGUAGE_DETECTION_ID, LANGUAGE_DETECTION_IMPLEMENTATION_SHA256, extractLanguages,
  REPOSITORY_FILES_ID, REPOSITORY_FILES_IMPLEMENTATION_SHA256, extractRepositoryFiles,
  REQUIRED_FACT_COVERAGE_ID, REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256, extractRequiredFactCoverage,
  SYMBOL_SKELETON_ID, SYMBOL_SKELETON_IMPLEMENTATION_SHA256, extractSymbolSkeleton
} from './adapters/index.mjs';
import {
  allocateDerivationIdentities, createDerivationCatalog, validateDerivationCatalog
} from './derivation-catalog.mjs';
import {
  createEvidenceCatalog, evidenceIdForDescriptor, validateEvidenceCatalog, validateEvidenceDescriptor
} from './evidence-catalog.mjs';
import { createFactLedger, validateFactLedger } from './fact-ledger.mjs';
import { selectViewFacts } from './selection.mjs';

const ADAPTERS = Object.freeze({
  [REPOSITORY_FILES_ID]: {
    implementationSha256: REPOSITORY_FILES_IMPLEMENTATION_SHA256,
    run: extractRepositoryFiles
  },
  [LANGUAGE_DETECTION_ID]: {
    implementationSha256: LANGUAGE_DETECTION_IMPLEMENTATION_SHA256,
    run: extractLanguages
  },
  [SYMBOL_SKELETON_ID]: {
    implementationSha256: SYMBOL_SKELETON_IMPLEMENTATION_SHA256,
    run: extractSymbolSkeleton
  },
  [IMPORT_DEPENDENCY_ID]: {
    implementationSha256: IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256,
    run: extractImportDependencies
  },
  [REQUIRED_FACT_COVERAGE_ID]: {
    implementationSha256: REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256,
    run: extractRequiredFactCoverage
  }
});

export const EMPTY_EXTRACTOR_CONFIGURATION_SHA256 = sha256({ kind: 'world-model-extractor-configuration', version: 1 });
export const BUILTIN_GRAMMAR_SHA256 = sha256({
  kind: 'world-model-lexical-grammar-set',
  version: 2,
  algorithms: [
    'repository-facts.extractImports-code-and-literal-aware-v2',
    'repository-facts.extractSymbols-code-only-v2'
  ]
});

function resolveViewContracts(viewRegistry, requestedViews) {
  const registry = validateViewRegistry(viewRegistry);
  if (!Array.isArray(requestedViews)) contractFailure('Requested views must be an array.');
  const contracts = requestedViews.map((reference) => {
    if (typeof reference === 'string') return resolveViewContract(registry, reference);
    if (reference?.kind === 'world-model-view-contract') {
      const supplied = validateViewContract(reference);
      const registered = resolveViewContract(registry, { id: supplied.id, version: supplied.version });
      if (registered.contractSha256 !== supplied.contractSha256) contractFailure('Requested View Contract is not the registered exact contract.', 'WMB_VIEW_CONTRACT_MISMATCH');
      return registered;
    }
    if (reference && typeof reference === 'object') {
      return resolveViewContract(registry, {
        id: reference.viewId ?? reference.id,
        version: reference.viewVersion ?? reference.version
      });
    }
    contractFailure('Requested view must be an exact registered reference.', 'WMB_VIEW_REFERENCE_INVALID');
  }).sort((left, right) => compareText(`${left.id}@${left.version}`, `${right.id}@${right.version}`));
  const keys = contracts.map((item) => `${item.id}@${item.version}`);
  if (new Set(keys).size !== keys.length) contractFailure('Requested views contain a duplicate exact contract.');
  return contracts;
}

function executeAdapters({ root, sourceSnapshot, scopeManifest, extractorRegistry, extractorReferences, viewContracts }) {
  if (!Array.isArray(extractorReferences)) contractFailure('Extractor references must be an array.');
  const references = [...new Set(extractorReferences)].sort();
  if (viewContracts.length && !references.some((reference) => reference.startsWith(`${REQUIRED_FACT_COVERAGE_ID}@`))) {
    const coverage = extractorRegistry.manifests.find((manifest) => manifest.id === REQUIRED_FACT_COVERAGE_ID);
    if (!coverage) contractFailure('Required unavailable coverage producer is not registered.', 'WMB_EXTRACTOR_NOT_REGISTERED');
    references.push(`${coverage.id}@${coverage.version}`);
    references.sort();
  }
  // Coverage observes the complete deterministic producer result set, so it is always the final
  // registration pass regardless of lexical extractor ID order.
  references.sort((left, right) => {
    const leftCoverage = left.startsWith(`${REQUIRED_FACT_COVERAGE_ID}@`);
    const rightCoverage = right.startsWith(`${REQUIRED_FACT_COVERAGE_ID}@`);
    return leftCoverage === rightCoverage ? compareText(left, right) : leftCoverage ? 1 : -1;
  });
  const context = { root, sourceSnapshot, scopeManifest };
  const results = [];
  for (const reference of references) {
    const manifest = resolveExtractorManifest(extractorRegistry, reference);
    const adapter = ADAPTERS[manifest.id];
    if (!adapter) contractFailure(`Extractor '${reference}' has no closed built-in adapter.`, 'WMB_EXTRACTOR_NOT_REGISTERED');
    if (adapter.implementationSha256 !== manifest.producer.implementationSha256) {
      contractFailure(`Extractor '${reference}' implementation does not match its registered manifest.`, 'WMB_EXTRACTOR_IMPLEMENTATION_MISMATCH');
    }
    let output;
    try {
      output = manifest.id === REQUIRED_FACT_COVERAGE_ID
        ? adapter.run({ viewContracts, existingFacts: results.flatMap((result) => result.facts) })
        : adapter.run(context);
    } catch (error) {
      if (error?.code?.startsWith('WMB_')) throw error;
      contractFailure(`Registered extractor '${reference}' failed internally: ${error.message}`, 'WMB_EXTRACTOR_INTERNAL_ERROR');
    }
    validateAdapterResult(output, manifest);
    results.push({ manifest, ...output });
  }
  return results;
}

function validateAdapterResult(value, manifest) {
  assertPlainRecord(value, `Extractor '${manifest.id}' result`);
  assertExactKeys(value, { required: ['producerId', 'observations', 'facts'], label: `Extractor '${manifest.id}' result` });
  if (value.producerId !== manifest.id) contractFailure(`Extractor '${manifest.id}' returned a different producer identity.`);
  if (!Array.isArray(value.observations) || !Array.isArray(value.facts)) contractFailure(`Extractor '${manifest.id}' returned invalid arrays.`);
  for (const observation of value.observations) {
    validateEvidenceDescriptor(observation);
    if (!manifest.evidenceKinds.includes(observation.kind)) contractFailure(`Extractor '${manifest.id}' emitted undeclared evidence kind '${observation.kind}'.`);
  }
  for (const fact of value.facts) {
    assertPlainRecord(fact, `Extractor '${manifest.id}' Fact draft`);
    if (!manifest.factTypes.includes(fact.factType)) contractFailure(`Extractor '${manifest.id}' emitted undeclared Fact type '${fact.factType}'.`);
    if (!Array.isArray(fact.evidence)) contractFailure(`Extractor '${manifest.id}' Fact draft must bind evidence descriptors.`);
    fact.evidence.forEach((descriptor) => validateEvidenceDescriptor(descriptor));
  }
  return value;
}

function derivationIdentity(result, sourceSnapshot, scopeManifest, evidenceCatalog, extractorRegistry) {
  // Derivations describe the exact provenance retained by their output Facts. An extractor may
  // register additional observations in the Evidence Catalog, but only Fact-local evidence is a
  // dependency of the persisted derivation graph. In particular, Fact-local evidence must not be
  // lost merely because an adapter did not also repeat it in its top-level observations array.
  const inputEvidenceIds = [...new Set(result.facts.flatMap((fact) => (
    fact.evidence.map((descriptor) => evidenceIdForDescriptor(evidenceCatalog, descriptor))
  )))].sort();
  return {
    extractor: {
      id: result.manifest.id,
      version: result.manifest.version,
      implementationSha256: result.manifest.producer.implementationSha256
    },
    sourceManifestSha256: sourceSnapshot.sourceManifestSha256,
    scopeManifestSha256: scopeManifest.scopeSha256,
    configurationSha256: EMPTY_EXTRACTOR_CONFIGURATION_SHA256,
    grammarSha256: result.manifest.producer.parser.grammarSha256,
    dependencyManifestSha256: sha256({
      extractorRegistrySha256: extractorRegistry.registrySha256,
      extractorManifestSha256: result.manifest.manifestSha256
    }),
    inputEvidenceIds
  };
}

export function registerExtractionDrafts({ sourceSnapshot, scopeManifest,
  extractorRegistry = BUILTIN_EXTRACTOR_REGISTRY, extractionResults = [], viewContracts = [] } = {}) {
  const source = validateSourceSnapshot(sourceSnapshot);
  const scope = validateScopeManifest(scopeManifest);
  const registry = validateExtractorRegistry(extractorRegistry);
  if (!Array.isArray(extractionResults)) contractFailure('Extraction results must be an array.');
  const producerIds = extractionResults.map((result) => result.manifest.id);
  if (new Set(producerIds).size !== producerIds.length) contractFailure('Extraction results repeat a registered producer.');
  for (const result of extractionResults) {
    const registered = resolveExtractorManifest(registry, `${result.manifest.id}@${result.manifest.version}`);
    if (registered.manifestSha256 !== result.manifest.manifestSha256) {
      contractFailure(`Extraction result producer '${result.manifest.id}' is not bound to its registered manifest.`, 'WMB_EXTRACTOR_REGISTRY_MISMATCH');
    }
    validateAdapterResult({
      producerId: result.producerId,
      observations: result.observations,
      facts: result.facts
    }, registered);
  }
  const descriptors = extractionResults.flatMap((result) => [
    ...result.observations,
    ...result.facts.flatMap((fact) => fact.evidence)
  ]);
  const evidenceCatalog = createEvidenceCatalog({ sourceSnapshot: source, scopeManifest: scope, descriptors });
  const identities = extractionResults.map((result) => derivationIdentity(result, source, scope, evidenceCatalog, registry));
  const allocations = allocateDerivationIdentities(identities);
  const derivationIdByProducer = new Map(allocations.map((allocation) => [
    allocation.identity.extractor.id, allocation.id
  ]));
  const factDrafts = extractionResults.flatMap((result) => result.facts.map((fact) => {
    const draft = {
      factType: fact.factType,
      subject: structuredClone(fact.subject),
      claim: fact.claim,
      status: fact.status,
      assurance: fact.assurance,
      evidenceIds: [...new Set(fact.evidence.map((descriptor) => evidenceIdForDescriptor(evidenceCatalog, descriptor)))].sort(),
      derivationId: derivationIdByProducer.get(result.manifest.id),
      conflictsWith: [...(fact.conflictsWith ?? [])].sort(),
      scopeStatus: fact.scopeStatus
    };
    if (fact.reason) draft.reason = structuredClone(fact.reason);
    return draft;
  }));
  const derivationIds = new Set(allocations.map((allocation) => allocation.id));
  const factLedger = createFactLedger({
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistry: registry,
    evidenceCatalog,
    derivationIds,
    factDrafts
  });
  const outputFactIdsByDerivationId = Object.fromEntries([...derivationIds].map((id) => [
    id, factLedger.facts.filter((fact) => fact.derivationId === id).map((fact) => fact.id).sort()
  ]));
  const statusByDerivationId = Object.fromEntries(extractionResults.map((result) => {
    const output = factLedger.facts.filter((fact) => fact.derivationId === derivationIdByProducer.get(result.manifest.id));
    const status = output.length && output.every((fact) => fact.status === 'unavailable')
      ? 'unavailable'
      : output.some((fact) => fact.status === 'unavailable' || fact.status === 'partial') ? 'partial' : 'complete';
    return [derivationIdByProducer.get(result.manifest.id), status];
  }));
  const derivationCatalog = createDerivationCatalog({
    identities,
    outputFactIdsByDerivationId,
    statusByDerivationId,
    evidenceCatalog,
    factLedger,
    extractorRegistry: registry
  });
  validateDerivationCatalog(derivationCatalog, {
    evidenceCatalog, factLedger, extractorRegistry: registry
  });
  validateFactLedger(factLedger, {
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistry: registry,
    evidenceCatalog,
    derivationIds: new Set(derivationCatalog.derivations.map((item) => item.id))
  });
  const viewFactLedgers = [...viewContracts]
    .sort((left, right) => compareText(`${left.id}@${left.version}`, `${right.id}@${right.version}`))
    .map((viewContract) => selectViewFacts({ factLedger, viewContract }));
  return { evidenceCatalog, derivationCatalog, factLedger, viewFactLedgers };
}

export function runDeterministicRegistration({ root, sourceSnapshot = null, scopeManifest,
  extractorRegistry = BUILTIN_EXTRACTOR_REGISTRY,
  extractorReferences = DEFAULT_EXTRACTOR_REFERENCES,
  requestedViews = [],
  viewRegistry = BUILTIN_VIEW_REGISTRY
} = {}) {
  if (typeof root !== 'string' || !root) contractFailure('Deterministic registration requires a repository root.');
  const source = sourceSnapshot
    ? verifyExactSourceSnapshot(root, sourceSnapshot, { scopeManifest })
    : createExactSourceSnapshot(root, { scopeManifest });
  const scope = validateScopeManifest(scopeManifest);
  const registry = validateExtractorRegistry(extractorRegistry);
  const views = resolveViewContracts(viewRegistry, requestedViews);
  const extractionResults = executeAdapters({
    root,
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistry: registry,
    extractorReferences,
    viewContracts: views
  });
  return {
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistrySha256: registry.registrySha256,
    ...registerExtractionDrafts({
      sourceSnapshot: source,
      scopeManifest: scope,
      extractorRegistry: registry,
      extractionResults,
      viewContracts: views
    })
  };
}
