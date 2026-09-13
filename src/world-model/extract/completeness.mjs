import { canonicalJson, compareText } from '../canonicalize.mjs';
import {
  assertExactKeys, assertPlainRecord, contractFailure
} from '../contracts.mjs';
import {
  createWorldModelCompletenessRecord
} from '../history/model-owners.mjs';
import { WMP_MAXIMUM_OBJECT_BYTES } from '../history/identity.mjs';
import {
  resolveExtractorExecutionContract, resolveExtractorManifest, validateExtractorRegistry
} from '../registry/extractors.mjs';
import { validateViewContract } from '../registry/views.mjs';
import { pathInsideScope } from '../scope/matcher.mjs';
import { validateScopeManifest } from '../scope/manifest.mjs';
import { validateSourceSnapshot } from '../source/snapshot.mjs';
import { validateDerivationCatalog } from './derivation-catalog.mjs';
import { validateEvidenceCatalog } from './evidence-catalog.mjs';
import { validateExtractionExecutionReceipt } from './execution-receipt.mjs';
import { validateFactLedger } from './fact-ledger.mjs';
import { validateViewFactLedger } from './selection.mjs';

const TERMINAL_STATUSES = new Set(['processed', 'partial', 'unsupported', 'failed']);
const REASON_CODE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;

function executionKey(value) {
  return `${value.id}@${value.version}`;
}

function fail(message, code = 'WMP_COMPLETENESS_EXECUTION_INVALID', details = {}) {
  contractFailure(message, code, details);
}

function validateTerminal(status, reasonCode, label) {
  if (!TERMINAL_STATUSES.has(status)) fail(`${label} status is invalid.`);
  if (status === 'processed') {
    if (reasonCode !== null) fail(`${label} processed outcome cannot carry a reason.`);
  } else if (typeof reasonCode !== 'string' || !REASON_CODE.test(reasonCode)) {
    fail(`${label} requires a stable reason code.`);
  }
}

function exactExecutionIdentity(execution, registry) {
  assertPlainRecord(execution, 'Extractor execution');
  assertExactKeys(execution, {
    required: [
      'id', 'version', 'implementationSha256', 'manifestSha256', 'coverage',
      'pathOutcomes', 'globalOutcome'
    ],
    label: 'Extractor execution'
  });
  const manifest = resolveExtractorManifest(registry, executionKey(execution));
  const expected = resolveExtractorExecutionContract(manifest);
  for (const field of [
    'id', 'version', 'implementationSha256', 'manifestSha256', 'coverage'
  ]) {
    if (execution[field] !== expected[field]) {
      fail(
        `Extractor execution '${executionKey(execution)}' does not match its installed ${field}.`,
        'WMP_COMPLETENESS_EXECUTION_IDENTITY_MISMATCH',
        { extractor: executionKey(execution), field, expected: expected[field], received: execution[field] }
      );
    }
  }
  return expected;
}

function validatedExecutions(executionValues, registry, source) {
  if (!Array.isArray(executionValues) || !executionValues.length) {
    fail('Completeness construction requires at least one extractor execution.');
  }
  const sourceFiles = new Map(source.files.map((file) => [file.path, file]));
  const executions = executionValues.map((execution) => {
    const identity = exactExecutionIdentity(execution, registry);
    if (!Array.isArray(execution.pathOutcomes)) {
      fail(`Extractor execution '${executionKey(execution)}' pathOutcomes must be an array.`);
    }
    if (identity.coverage === 'global') {
      if (execution.pathOutcomes.length !== 0) {
        fail(
          `Global extractor '${executionKey(execution)}' cannot claim per-path coverage.`,
          'WMP_COMPLETENESS_EXECUTION_COVERAGE_MISMATCH'
        );
      }
      assertPlainRecord(execution.globalOutcome,
        `Extractor execution '${executionKey(execution)}' globalOutcome`);
      assertExactKeys(execution.globalOutcome, {
        required: ['status', 'reasonCode'],
        label: `Extractor execution '${executionKey(execution)}' globalOutcome`
      });
      validateTerminal(
        execution.globalOutcome.status, execution.globalOutcome.reasonCode,
        `Extractor execution '${executionKey(execution)}' globalOutcome`
      );
      return { identity, pathOutcomes: new Map(), globalOutcome: execution.globalOutcome };
    }
    if (execution.globalOutcome !== null) {
      fail(
        `Path extractor '${executionKey(execution)}' cannot claim global coverage.`,
        'WMP_COMPLETENESS_EXECUTION_COVERAGE_MISMATCH'
      );
    }
    if (execution.pathOutcomes.length !== sourceFiles.size) {
      fail(
        `Path extractor '${executionKey(execution)}' does not account for every exact source path.`,
        'WMP_COMPLETENESS_SOURCE_PATH_MISMATCH',
        {
          extractor: executionKey(execution), expectedPaths: sourceFiles.size,
          receivedPaths: execution.pathOutcomes.length
        }
      );
    }
    const outcomes = new Map();
    for (const [index, outcome] of execution.pathOutcomes.entries()) {
      const label = `Extractor execution '${executionKey(execution)}' pathOutcomes[${index}]`;
      assertPlainRecord(outcome, label);
      assertExactKeys(outcome, {
        required: ['path', 'sourceContentSha256', 'status', 'reasonCode'], label
      });
      const file = sourceFiles.get(outcome.path);
      if (!file || outcomes.has(outcome.path)
          || outcome.sourceContentSha256 !== file.contentSha256) {
        fail(
          `Extractor '${executionKey(execution)}' path outcome is not bound to one exact source file.`,
          'WMP_COMPLETENESS_SOURCE_PATH_MISMATCH',
          { extractor: executionKey(execution), path: outcome.path }
        );
      }
      validateTerminal(outcome.status, outcome.reasonCode, label);
      outcomes.set(outcome.path, outcome);
    }
    for (const file of source.files) {
      if (!outcomes.has(file.path)) {
        fail(
          `Extractor '${executionKey(execution)}' omits exact source path '${file.path}'.`,
          'WMP_COMPLETENESS_SOURCE_PATH_MISMATCH',
          { extractor: executionKey(execution), path: file.path }
        );
      }
    }
    return { identity, pathOutcomes: outcomes, globalOutcome: null };
  }).sort((left, right) => compareText(executionKey(left.identity), executionKey(right.identity)));
  const keys = executions.map((entry) => executionKey(entry.identity));
  if (new Set(keys).size !== keys.length) {
    fail('Completeness construction received duplicate extractor executions.');
  }
  return executions;
}

function aggregatePathStatus(extractors) {
  const statuses = new Set(extractors.map((entry) => entry.status));
  if (statuses.has('failed')) return 'failed';
  if (statuses.has('partial') || (statuses.has('processed') && statuses.has('unsupported'))) {
    return 'partial';
  }
  if (statuses.has('processed')) return 'processed';
  return 'unsupported';
}

function aggregatePathReason(status, extractors) {
  if (status === 'processed') return null;
  const reasons = [...new Set(extractors.map((entry) => entry.reasonCode).filter(Boolean))]
    .sort(compareText);
  if (status === 'partial') return 'PARTIAL_EXTRACTION';
  if (reasons.length === 1) return reasons[0];
  return status === 'failed' ? 'MULTIPLE_EXTRACTOR_FAILURES' : 'MULTIPLE_UNSUPPORTED_EXTRACTORS';
}

function requiredFactOutcome(factType, facts) {
  const candidates = facts.filter(
    (fact) => fact.factType === factType && fact.status !== 'stale'
  );
  if (!candidates.length) {
    fail(
      `Fact Ledger omits required typed coverage for '${factType}'.`,
      'WMP_REQUIRED_FACT_COVERAGE_MISSING',
      { factType }
    );
  }
  const statuses = new Set(candidates.map((fact) => fact.status));
  if (statuses.has('contradicted')) {
    return { id: factType, status: 'contradicted', reasonCode: 'CONTRADICTED_FACTS' };
  }
  if (statuses.has('partial')) {
    return { id: factType, status: 'partial', reasonCode: 'PARTIAL_FACTS' };
  }
  if (statuses.has('available')) return { id: factType, status: 'available', reasonCode: null };
  const reasons = [...new Set(candidates.map((fact) => fact.reason?.code).filter(Boolean))]
    .sort(compareText);
  return {
    id: factType,
    status: 'unavailable',
    reasonCode: reasons.length === 1 ? reasons[0] : 'MULTIPLE_UNAVAILABLE_REASONS'
  };
}

/**
 * Build the durable completeness owner from terminal current-release extractor executions.
 *
 * The exact Source Snapshot is the complete roster in this increment. Paths excluded before that
 * snapshot cannot be reconstructed truthfully, so this bridge emits no fabricated exclusions.
 */
export function createCompletenessRecordFromExtractionExecution({
  sourceSnapshot, scopeManifest, extractorRegistry, extractorExecutions,
  evidenceCatalog, derivationCatalog, factLedger, resolvedViewContracts, viewFactLedgers,
  extractionExecutionReceipt
} = {}) {
  const source = validateSourceSnapshot(sourceSnapshot);
  const scope = validateScopeManifest(scopeManifest);
  const outsidePath = source.files.find((file) => !pathInsideScope(file.path, scope));
  if (outsidePath) {
    fail(
      `Completeness construction requires a scoped Source Snapshot; '${outsidePath.path}' is outside it.`,
      'WMP_COMPLETENESS_SOURCE_SCOPE_MISMATCH',
      { path: outsidePath.path }
    );
  }
  const registry = validateExtractorRegistry(extractorRegistry);
  const evidence = validateEvidenceCatalog(evidenceCatalog, {
    sourceSnapshot: source, scopeManifest: scope
  });
  const facts = validateFactLedger(factLedger, {
    sourceSnapshot: source, scopeManifest: scope, extractorRegistry: registry,
    evidenceCatalog: evidence
  });
  const derivations = validateDerivationCatalog(derivationCatalog, {
    evidenceCatalog: evidence, factLedger: facts, extractorRegistry: registry
  });
  validateFactLedger(facts, {
    sourceSnapshot: source, scopeManifest: scope, extractorRegistry: registry,
    evidenceCatalog: evidence,
    derivationIds: new Set(derivations.derivations.map((entry) => entry.id))
  });
  if (!Array.isArray(resolvedViewContracts)) {
    fail(
      'Completeness construction requires the exact resolved View Contracts from extraction.',
      'WMP_COMPLETENESS_VIEW_REQUIREMENTS_REQUIRED'
    );
  }
  const views = resolvedViewContracts.map(validateViewContract);
  const viewKeys = views.map((view) => `${view.id}@${view.version}`);
  if (new Set(viewKeys).size !== viewKeys.length) {
    fail('Completeness construction received duplicate View Contracts.');
  }
  if (!Array.isArray(viewFactLedgers)) {
    fail(
      'Completeness construction requires the View Fact Ledgers produced by extraction.',
      'WMP_COMPLETENESS_VIEW_REQUIREMENTS_REQUIRED'
    );
  }
  const viewsByKey = new Map(views.map((view) => [`${view.id}@${view.version}`, view]));
  const ledgerKeys = viewFactLedgers.map((ledger) => `${ledger?.viewId}@${ledger?.viewVersion}`);
  if (new Set(ledgerKeys).size !== ledgerKeys.length
      || canonicalJson([...viewKeys].sort(compareText))
        !== canonicalJson([...ledgerKeys].sort(compareText))) {
    fail(
      'Resolved View Contracts do not match the exact View Fact Ledger roster from extraction.',
      'WMP_COMPLETENESS_VIEW_LEDGER_MISMATCH',
      { expected: [...ledgerKeys].sort(compareText), received: [...viewKeys].sort(compareText) }
    );
  }
  for (const ledger of viewFactLedgers) {
    validateViewFactLedger(ledger, {
      factLedger: facts,
      viewContract: viewsByKey.get(`${ledger.viewId}@${ledger.viewVersion}`)
    });
  }
  if (!extractionExecutionReceipt) {
    fail(
      'Completeness construction requires the sealed extraction execution receipt.',
      'WMP_EXTRACTION_RECEIPT_REQUIRED'
    );
  }
  validateExtractionExecutionReceipt(extractionExecutionReceipt, {
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    extractorRegistrySha256: registry.registrySha256,
    extractorExecutions,
    resolvedViewContracts: views,
    viewFactLedgers
  });

  const executions = validatedExecutions(extractorExecutions, registry, source);
  const executionRoster = executions.map((entry) => (
    `${executionKey(entry.identity)}#${entry.identity.implementationSha256}`
  )).sort(compareText);
  const derivationRoster = derivations.derivations.map((entry) => (
    `${entry.extractor.id}@${entry.extractor.version}#${entry.extractor.implementationSha256}`
  )).sort(compareText);
  if (canonicalJson(executionRoster) !== canonicalJson(derivationRoster)) {
    fail(
      'Completeness extractor executions do not match the exact Derivation Catalog producer roster.',
      'WMP_COMPLETENESS_EXECUTION_ROSTER_MISMATCH',
      { expected: derivationRoster, received: executionRoster }
    );
  }
  const pathExecutions = executions.filter((entry) => entry.identity.coverage === 'path');
  if (!pathExecutions.length) {
    fail(
      'Completeness construction requires at least one path-scoped extractor execution.',
      'WMP_COMPLETENESS_PATH_EXTRACTOR_REQUIRED'
    );
  }
  const globalExecutions = executions.filter((entry) => entry.identity.coverage === 'global');
  const pathOutcomes = source.files.map((file) => {
    const extractors = pathExecutions.map((execution) => {
      const outcome = execution.pathOutcomes.get(file.path);
      return {
        id: execution.identity.id,
        version: execution.identity.version,
        implementationSha256: execution.identity.implementationSha256,
        status: outcome.status,
        reasonCode: outcome.reasonCode
      };
    });
    const status = aggregatePathStatus(extractors);
    return {
      path: file.path,
      sourceContentSha256: file.contentSha256,
      status,
      reasonCode: aggregatePathReason(status, extractors),
      extractors
    };
  });
  const globalOutcomes = globalExecutions.map((execution) => ({
    id: execution.identity.id,
    version: execution.identity.version,
    implementationSha256: execution.identity.implementationSha256,
    status: execution.globalOutcome.status,
    reasonCode: execution.globalOutcome.reasonCode
  }));
  const requiredFactTypes = [...new Set(views.flatMap((view) => [
    ...view.factPolicy.requiredFactTypes,
    ...view.factPolicy.requiredUnavailableSubjects
  ]))].sort(compareText);
  const requiredSubjects = requiredFactTypes.map(
    (factType) => requiredFactOutcome(factType, facts.facts)
  );
  const record = createWorldModelCompletenessRecord({
    sourceManifestSha256: source.sourceManifestSha256,
    scopeManifestSha256: scope.scopeSha256,
    extractorRegistrySha256: registry.registrySha256,
    extractorReferences: executions.map((entry) => entry.identity),
    pathOutcomes,
    globalOutcomes,
    requiredSubjects
  });
  const bytes = Buffer.byteLength(canonicalJson(record), 'utf8');
  if (bytes > WMP_MAXIMUM_OBJECT_BYTES) {
    fail(
      'World-model Completeness Record exceeds the durable object capacity.',
      'WMP_COMPLETENESS_CAPACITY_EXCEEDED',
      { bytes, maximumBytes: WMP_MAXIMUM_OBJECT_BYTES }
    );
  }
  return record;
}
