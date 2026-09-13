import path from 'node:path';

import { compareText, deepFreeze, sha256 } from '../canonicalize.mjs';
import { assertExactKeys, assertPlainRecord, contractFailure } from '../contracts.mjs';
import {
  BUILTIN_EXTRACTOR_REGISTRY, DEFAULT_EXTRACTOR_REFERENCES, resolveExtractorManifest,
  resolveExtractorExecutionContract, validateExtractorRegistry
} from '../registry/extractors.mjs';
import {
  BUILTIN_VIEW_REGISTRY, resolveViewContract, validateViewContract, validateViewRegistry
} from '../registry/views.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import { scopedSnapshotFiles } from '../scope/matcher.mjs';
import {
  createExactSourceSnapshot, validateSourceSnapshot, verifyExactSourceSnapshot
} from '../source/snapshot.mjs';
import {
  CALL_REFERENCE_EDGE_ID, CALL_REFERENCE_EDGE_IMPLEMENTATION_SHA256, extractCallReferenceEdges,
  CLAUSE_CODE_BINDING_ID, CLAUSE_CODE_BINDING_IMPLEMENTATION_SHA256, extractClauseCodeBindings,
  CHANGE_REGION_ID, CHANGE_REGION_IMPLEMENTATION_SHA256, extractChangeRegions,
  CONFIGURATION_OBJECT_ID, CONFIGURATION_OBJECT_IMPLEMENTATION_SHA256, configurationFormat,
  extractConfigurationObjects,
  IMPORT_DEPENDENCY_ID, IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256, extractImportDependencies,
  HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID, HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_IMPLEMENTATION_SHA256,
  extractHumanConfirmedKnowledge,
  INTERFACE_CONTRACT_ID, INTERFACE_CONTRACT_IMPLEMENTATION_SHA256, extractInterfaceContracts,
  LANGUAGE_DETECTION_ID, LANGUAGE_DETECTION_IMPLEMENTATION_SHA256, extractLanguages,
  OWNERSHIP_MAINTAINER_RECORD_ID, OWNERSHIP_MAINTAINER_RECORD_IMPLEMENTATION_SHA256,
  isCodeownersPath,
  extractOwnershipMaintainerRecords,
  REPOSITORY_FILES_ID, REPOSITORY_FILES_IMPLEMENTATION_SHA256, extractRepositoryFiles,
  REQUIRED_FACT_COVERAGE_ID, REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256, extractRequiredFactCoverage,
  RUNTIME_OBSERVATION_IMPORT_ID, RUNTIME_OBSERVATION_IMPORT_IMPLEMENTATION_SHA256,
  extractRuntimeObservations,
  RULE_DEFINITION_ID, RULE_DEFINITION_IMPLEMENTATION_SHA256, extractRuleDefinitions,
  SIGNATURE_AND_EXPORT_ID, SIGNATURE_AND_EXPORT_IMPLEMENTATION_SHA256, extractSignaturesAndExports,
  SYMBOL_SKELETON_ID, SYMBOL_SKELETON_IMPLEMENTATION_SHA256, extractSymbolSkeleton,
  TEST_IDENTITY_ID, TEST_IDENTITY_IMPLEMENTATION_SHA256, extractTestIdentities,
  isTestSourcePath
} from './adapters/index.mjs';
import { SOURCE_LIKE, languageForPath } from './adapters/common.mjs';
import {
  allocateDerivationIdentities, createDerivationCatalog, validateDerivationCatalog
} from './derivation-catalog.mjs';
import {
  createEvidenceCatalog, evidenceIdForDescriptor, validateEvidenceCatalog, validateEvidenceDescriptor
} from './evidence-catalog.mjs';
import { createExtractionExecutionReceipt } from './execution-receipt.mjs';
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
  [SIGNATURE_AND_EXPORT_ID]: {
    implementationSha256: SIGNATURE_AND_EXPORT_IMPLEMENTATION_SHA256,
    run: extractSignaturesAndExports
  },
  [SYMBOL_SKELETON_ID]: {
    implementationSha256: SYMBOL_SKELETON_IMPLEMENTATION_SHA256,
    run: extractSymbolSkeleton
  },
  [IMPORT_DEPENDENCY_ID]: {
    implementationSha256: IMPORT_DEPENDENCY_IMPLEMENTATION_SHA256,
    run: extractImportDependencies
  },
  [CALL_REFERENCE_EDGE_ID]: {
    implementationSha256: CALL_REFERENCE_EDGE_IMPLEMENTATION_SHA256,
    run: extractCallReferenceEdges
  },
  [INTERFACE_CONTRACT_ID]: {
    implementationSha256: INTERFACE_CONTRACT_IMPLEMENTATION_SHA256,
    run: extractInterfaceContracts
  },
  [CONFIGURATION_OBJECT_ID]: {
    implementationSha256: CONFIGURATION_OBJECT_IMPLEMENTATION_SHA256,
    run: extractConfigurationObjects
  },
  [RULE_DEFINITION_ID]: {
    implementationSha256: RULE_DEFINITION_IMPLEMENTATION_SHA256,
    run: extractRuleDefinitions
  },
  [TEST_IDENTITY_ID]: {
    implementationSha256: TEST_IDENTITY_IMPLEMENTATION_SHA256,
    run: extractTestIdentities
  },
  [CLAUSE_CODE_BINDING_ID]: {
    implementationSha256: CLAUSE_CODE_BINDING_IMPLEMENTATION_SHA256,
    run: extractClauseCodeBindings
  },
  [CHANGE_REGION_ID]: {
    implementationSha256: CHANGE_REGION_IMPLEMENTATION_SHA256,
    run: extractChangeRegions
  },
  [OWNERSHIP_MAINTAINER_RECORD_ID]: {
    implementationSha256: OWNERSHIP_MAINTAINER_RECORD_IMPLEMENTATION_SHA256,
    run: extractOwnershipMaintainerRecords
  },
  [RUNTIME_OBSERVATION_IMPORT_ID]: {
    implementationSha256: RUNTIME_OBSERVATION_IMPORT_IMPLEMENTATION_SHA256,
    run: extractRuntimeObservations
  },
  [HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID]: {
    implementationSha256: HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_IMPLEMENTATION_SHA256,
    run: extractHumanConfirmedKnowledge
  },
  [REQUIRED_FACT_COVERAGE_ID]: {
    implementationSha256: REQUIRED_FACT_COVERAGE_IMPLEMENTATION_SHA256,
    run: extractRequiredFactCoverage
  }
});

const SOURCE_FILE = (context, file) => SOURCE_LIKE.has(
  path.posix.extname(file.path).toLowerCase()
);
const CONFIGURATION_FILE = (context, file) => Boolean(configurationFormat(file.path));
const INTERFACE_INPUT = (context, file) => SOURCE_FILE(context, file) || (
  CONFIGURATION_FILE(context, file)
  && /(?:^|\.)(?:schema|openapi|asyncapi)(?:\.|$)/.test(
    path.posix.basename(file.path).toLowerCase()
  )
);

/**
 * Current-release execution boundaries. These functions are executable policy, never retained
 * history: the exact admitted manifest binds them through its implementation digest.
 */
const EXECUTION_BOUNDARIES = Object.freeze({
  [REPOSITORY_FILES_ID]: { applies: () => true },
  [LANGUAGE_DETECTION_ID]: {
    applies: (context, file) => Boolean(languageForPath(file.path))
  },
  [SIGNATURE_AND_EXPORT_ID]: { applies: SOURCE_FILE },
  [SYMBOL_SKELETON_ID]: { applies: SOURCE_FILE },
  [IMPORT_DEPENDENCY_ID]: { applies: SOURCE_FILE },
  [CALL_REFERENCE_EDGE_ID]: {
    applies: (context, file) => context.scopeManifest.allowedSubjects.includes('dependency-edge')
      && SOURCE_FILE(context, file)
  },
  [INTERFACE_CONTRACT_ID]: { applies: INTERFACE_INPUT },
  [CONFIGURATION_OBJECT_ID]: { applies: CONFIGURATION_FILE },
  [RULE_DEFINITION_ID]: { applies: CONFIGURATION_FILE },
  [TEST_IDENTITY_ID]: {
    applies: (context, file) => SOURCE_FILE(context, file) && isTestSourcePath(file.path)
  },
  [CLAUSE_CODE_BINDING_ID]: { applies: SOURCE_FILE },
  [CHANGE_REGION_ID]: { applies: null },
  [OWNERSHIP_MAINTAINER_RECORD_ID]: {
    applies: (context, file) => isCodeownersPath(file.path)
  },
  [RUNTIME_OBSERVATION_IMPORT_ID]: { applies: null },
  [HUMAN_CONFIRMED_KNOWLEDGE_IMPORT_ID]: { applies: null },
  [REQUIRED_FACT_COVERAGE_ID]: { applies: null }
});

function exactInstalledExecutionBoundary(manifest) {
  const adapter = ADAPTERS[manifest.id];
  const boundary = EXECUTION_BOUNDARIES[manifest.id];
  if (!adapter || !boundary
      || adapter.implementationSha256 !== manifest.producer.implementationSha256) {
    contractFailure(
      `Extractor '${manifest.id}@${manifest.version}' has no exact installed execution boundary.`,
      'WMB_EXTRACTOR_EXECUTION_BOUNDARY_MISSING'
    );
  }
  const installed = BUILTIN_EXTRACTOR_REGISTRY.manifests.find((candidate) => (
    candidate.id === manifest.id && candidate.version === manifest.version
  ));
  if (!installed || installed.manifestSha256 !== manifest.manifestSha256) {
    contractFailure(
      `Extractor '${manifest.id}@${manifest.version}' is not the exact installed execution subject.`,
      'WMB_EXTRACTOR_EXECUTION_BOUNDARY_MISMATCH'
    );
  }
  return { adapter, boundary, contract: resolveExtractorExecutionContract(manifest) };
}

function pathState(outcomes, file) {
  if (!outcomes.has(file.path)) {
    outcomes.set(file.path, {
      path: file.path,
      sourceContentSha256: file.contentSha256,
      read: false,
      produced: false,
      partial: false,
      unsupported: new Set(),
      failed: new Set()
    });
  }
  return outcomes.get(file.path);
}

function recordPathSignal(outcomes, file, signal, reasonCode = null) {
  const state = pathState(outcomes, file);
  if (signal === 'read') state.read = true;
  else if (signal === 'processed') state.produced = true;
  else if (signal === 'partial') state.partial = true;
  else if (signal === 'unsupported') state.unsupported.add(reasonCode);
  else if (signal === 'failed') state.failed.add(reasonCode);
  else contractFailure(`Unknown extractor path signal '${signal}'.`, 'WMB_EXTRACTOR_OUTCOME_INVALID');
}

function resultPaths(output, selectedPaths, outcomes) {
  const recordDescriptor = (descriptor, signal = 'processed', reasonCode = null) => {
    const relative = descriptor?.locator?.path;
    const file = selectedPaths.get(relative);
    if (!file) return;
    recordPathSignal(outcomes, file, signal, reasonCode);
  };
  // Evidence can accompany a refused parse, so observing bytes is not itself successful Fact
  // production. It closes a zero-Fact path only as a verified read unless a Fact says otherwise.
  output.observations.forEach((descriptor) => recordDescriptor(descriptor, 'read'));
  for (const fact of output.facts) {
    let signal = 'processed';
    let reasonCode = null;
    if (fact.status === 'partial') {
      signal = 'partial';
      reasonCode = 'PARTIAL_OUTPUT';
    } else if (fact.status === 'unavailable') {
      reasonCode = fact.reason?.code ?? 'EXTRACTION_FAILED';
      signal = reasonCode === 'UNSUPPORTED_LANGUAGE' ? 'unsupported' : 'failed';
    }
    for (const descriptor of fact.evidence) recordDescriptor(descriptor, signal, reasonCode);
    const subjectId = fact.subject?.id;
    let subjectFile = selectedPaths.get(subjectId);
    // File-scoped analysis subjects use "path#qualifier". Resolve from the right so a legal '#'
    // inside a repository path cannot bind the Fact to an earlier, different file.
    if (!subjectFile && typeof subjectId === 'string') {
      let separator = subjectId.lastIndexOf('#');
      while (!subjectFile && separator > 0) {
        subjectFile = selectedPaths.get(subjectId.slice(0, separator));
        separator = subjectId.lastIndexOf('#', separator - 1);
      }
    }
    if (subjectFile) recordPathSignal(outcomes, subjectFile, signal, reasonCode);
  }
}

function terminalPathOutcome(state) {
  const first = (values) => [...values].sort(compareText)[0];
  if (state.failed.size) {
    if (state.produced || state.partial) {
      return {
        path: state.path, sourceContentSha256: state.sourceContentSha256,
        status: 'partial', reasonCode: 'PARTIAL_EXTRACTION'
      };
    }
    return {
      path: state.path, sourceContentSha256: state.sourceContentSha256,
      status: 'failed', reasonCode: first(state.failed)
    };
  }
  if (state.partial) {
    return {
      path: state.path, sourceContentSha256: state.sourceContentSha256,
      status: 'partial', reasonCode: 'PARTIAL_OUTPUT'
    };
  }
  if (state.unsupported.size && state.produced) {
    return {
      path: state.path, sourceContentSha256: state.sourceContentSha256,
      status: 'partial', reasonCode: 'PARTIAL_EXTRACTION'
    };
  }
  if (state.produced) {
    return {
      path: state.path, sourceContentSha256: state.sourceContentSha256,
      status: 'processed', reasonCode: null
    };
  }
  if (state.unsupported.size) {
    return {
      path: state.path, sourceContentSha256: state.sourceContentSha256,
      status: 'unsupported', reasonCode: first(state.unsupported)
    };
  }
  if (state.read) {
    return {
      path: state.path, sourceContentSha256: state.sourceContentSha256,
      status: 'processed', reasonCode: null
    };
  }
  return null;
}

function completedExecution({ context, manifest, boundary, contract, output, observed, global }) {
  if (contract.coverage === 'global') {
    if (!global) {
      contractFailure(
        `Extractor '${manifest.id}@${manifest.version}' did not report a global terminal outcome.`,
        'WMB_EXTRACTOR_OUTCOME_MISSING',
        { extractor: `${manifest.id}@${manifest.version}`, coverage: 'global' }
      );
    }
    return deepFreeze({
      ...contract,
      pathOutcomes: [],
      globalOutcome: global
    });
  }
  const selected = scopedSnapshotFiles(context.sourceSnapshot, context.scopeManifest)
    .sort((left, right) => compareText(left.path, right.path));
  const selectedPaths = new Map(selected.map((file) => [file.path, file]));
  resultPaths(output, selectedPaths, observed);
  const pathOutcomes = selected.map((file) => {
    if (file.type === 'symlink') {
      return {
        path: file.path,
        sourceContentSha256: file.contentSha256,
        status: 'unsupported',
        reasonCode: 'SYMLINK_UNSUPPORTED'
      };
    }
    const outcome = observed.has(file.path)
      ? terminalPathOutcome(observed.get(file.path))
      : null;
    if (outcome) return outcome;
    if (!boundary.applies(context, file)) {
      return {
        path: file.path,
        sourceContentSha256: file.contentSha256,
        status: 'unsupported',
        reasonCode: 'EXTRACTOR_NOT_APPLICABLE'
      };
    }
    contractFailure(
      `Extractor '${manifest.id}@${manifest.version}' did not close applicable path '${file.path}'.`,
      'WMB_EXTRACTOR_OUTCOME_MISSING',
      { extractor: `${manifest.id}@${manifest.version}`, path: file.path }
    );
  });
  return deepFreeze({ ...contract, pathOutcomes, globalOutcome: null });
}

export const EMPTY_EXTRACTOR_CONFIGURATION_SHA256 = sha256({ kind: 'world-model-extractor-configuration', version: 1 });
export const BUILTIN_GRAMMAR_SHA256 = sha256({
  kind: 'world-model-lexical-grammar-set',
  version: 4,
  algorithms: [
    'single-pass-bounded-same-file-declaration-call-and-reference-candidates-v2',
    'constant-process-exact-first-parent-zero-context-change-regions-v2',
    'sealed-bounded-human-confirmed-business-knowledge-import-v1',
    'sealed-bounded-runtime-frequency-record-import-v1',
    'repository-facts.extractImports-code-and-literal-aware-v2',
    'repository-facts.extractSymbols-code-only-v2',
    'reviewed-polyglot-import-grammar-v3',
    'reviewed-polyglot-symbol-grammar-v3',
    'reviewed-closed-structural-metadata-grammar-v1'
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

function executeAdapters({
  root, sourceSnapshot, scopeManifest, extractorRegistry, extractorReferences, viewContracts,
  captureExtractorExecutions
}) {
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
  // One registration pass may project the same exact blob through several closed extractors.
  // Retain only its decoded text for this in-memory pass so each Git blob is verified once, never
  // once per extractor. The cache is discarded before any durable record is returned.
  const context = { root, sourceSnapshot, scopeManifest, sourceTextCache: new Map() };
  const selectedPaths = captureExtractorExecutions
    ? new Map(scopedSnapshotFiles(sourceSnapshot, scopeManifest).map((file) => [file.path, file]))
    : null;
  const results = [];
  for (const reference of references) {
    const manifest = resolveExtractorManifest(extractorRegistry, reference);
    const installedBoundary = captureExtractorExecutions
      ? exactInstalledExecutionBoundary(manifest)
      : null;
    const adapter = installedBoundary?.adapter ?? ADAPTERS[manifest.id];
    if (!adapter) {
      contractFailure(
        `Extractor '${reference}' has no closed built-in adapter.`,
        'WMB_EXTRACTOR_NOT_REGISTERED'
      );
    }
    if (adapter.implementationSha256 !== manifest.producer.implementationSha256) {
      contractFailure(
        `Extractor '${reference}' implementation does not match its registered manifest.`,
        'WMB_EXTRACTOR_IMPLEMENTATION_MISMATCH'
      );
    }
    const boundary = installedBoundary?.boundary ?? null;
    const contract = installedBoundary?.contract ?? null;
    const observed = new Map();
    let global = null;
    if (captureExtractorExecutions) context.adapterExecutionRecorder = (outcome) => {
      if (outcome.scope === 'global') {
        if (contract.coverage !== 'global'
            || !['processed', 'partial', 'unsupported', 'failed'].includes(outcome.signal)
            || (outcome.signal === 'processed') !== (outcome.reasonCode === null)
            || (outcome.reasonCode !== null
              && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(outcome.reasonCode))) {
          contractFailure(
            `Extractor '${reference}' reported an invalid global terminal outcome.`,
            'WMB_EXTRACTOR_OUTCOME_INVALID',
            { extractor: reference, status: outcome.signal }
          );
        }
        if (global) {
          contractFailure(
            `Extractor '${reference}' reported more than one global terminal outcome.`,
            'WMB_EXTRACTOR_OUTCOME_INVALID',
            { extractor: reference }
          );
        }
        global = { status: outcome.signal, reasonCode: outcome.reasonCode };
        return;
      }
      // A global extractor may read exact files while deriving its one repository-wide result.
      // Those reads cannot silently change its declared coverage or become per-path claims.
      if (contract.coverage === 'global' && outcome.scope === 'path') return;
      const file = selectedPaths.get(outcome.path);
      if (outcome.scope !== 'path' || contract.coverage !== 'path'
          || !file || file.type !== 'regular'
          || outcome.sourceContentSha256 !== file.contentSha256) {
        contractFailure(
          `Extractor '${reference}' reported an outcome outside its exact selected source.`,
          'WMB_EXTRACTOR_OUTCOME_INVALID',
          { extractor: reference, path: outcome.path }
        );
      }
      if (!['read', 'processed', 'partial', 'unsupported', 'failed'].includes(outcome.signal)
          || (['read', 'processed'].includes(outcome.signal)) !== (outcome.reasonCode === null)
          || (outcome.reasonCode !== null
            && !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/.test(outcome.reasonCode))) {
        contractFailure(
          `Extractor '${reference}' reported an invalid terminal outcome.`,
          'WMB_EXTRACTOR_OUTCOME_INVALID',
          { extractor: reference, path: outcome.path, status: outcome.signal }
        );
      }
      recordPathSignal(observed, file, outcome.signal, outcome.reasonCode);
    };
    let output;
    try {
      output = manifest.id === REQUIRED_FACT_COVERAGE_ID
        ? adapter.run({
          viewContracts,
          existingFacts: results.flatMap((result) => result.facts),
          adapterExecutionRecorder: context.adapterExecutionRecorder
        })
        : adapter.run(context);
    } catch (error) {
      if (error?.code?.startsWith('WMB_')) throw error;
      contractFailure(`Registered extractor '${reference}' failed internally: ${error.message}`, 'WMB_EXTRACTOR_INTERNAL_ERROR');
    } finally {
      delete context.adapterExecutionRecorder;
    }
    validateAdapterResult(output, manifest);
    const execution = captureExtractorExecutions
      ? completedExecution({ context, manifest, boundary, contract, output, observed, global })
      : null;
    results.push({ manifest, ...output, ...(execution ? { execution } : {}) });
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
  viewRegistry = BUILTIN_VIEW_REGISTRY,
  captureExtractorExecutions = false
} = {}) {
  if (typeof root !== 'string' || !root) contractFailure('Deterministic registration requires a repository root.');
  if (typeof captureExtractorExecutions !== 'boolean') {
    contractFailure('captureExtractorExecutions must be a boolean.');
  }
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
    viewContracts: views,
    captureExtractorExecutions
  });
  const registered = registerExtractionDrafts({
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistry: registry,
    extractionResults,
    viewContracts: views
  });
  const extractorExecutions = captureExtractorExecutions
    ? extractionResults.map((result) => result.execution)
    : null;
  const extractionExecutionReceipt = captureExtractorExecutions
    ? createExtractionExecutionReceipt({
      sourceManifestSha256: source.sourceManifestSha256,
      scopeManifestSha256: scope.scopeSha256,
      extractorRegistrySha256: registry.registrySha256,
      extractorExecutions,
      resolvedViewContracts: views,
      viewFactLedgers: registered.viewFactLedgers
    })
    : null;
  return {
    sourceSnapshot: source,
    scopeManifest: scope,
    extractorRegistrySha256: registry.registrySha256,
    ...(captureExtractorExecutions ? {
      // The registry may be caller-owned (for example an organisation overlay under validation).
      // Freeze only our retained copy; recursively freezing `views` here would mutate that input.
      resolvedViewContracts: deepFreeze(structuredClone(views)),
      extractorExecutions,
      extractionExecutionReceipt
    } : {}),
    ...registered
  };
}
