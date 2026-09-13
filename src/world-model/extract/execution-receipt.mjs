import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  canonicalJson, compareText, deepFreeze, sealRecord, sha256
} from '../canonicalize.mjs';
import {
  VIEW_ID_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger,
  assertPlainRecord, assertSchemaKind, assertSelfHash, assertSha256, assertString,
  contractFailure
} from '../contracts.mjs';
import { validateViewContract } from '../registry/views.mjs';
import { validateViewFactLedger } from './selection.mjs';

const COVERAGE = new Set(['path', 'global']);
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/;

function extractionKey(value) {
  return `${value.id}@${value.version}`;
}

function viewKey(value) {
  return `${value.id ?? value.viewId}@${value.version ?? value.viewVersion}`;
}

function assertUniqueCanonical(values, keyOf, label) {
  assertCanonicalOrder(values, keyOf, label);
  const keys = values.map(keyOf);
  if (new Set(keys).size !== keys.length) {
    contractFailure(`${label} must not contain duplicate identities.`, 'WMP_EXTRACTION_RECEIPT_INVALID');
  }
}

function executionBindings(extractorExecutions) {
  if (!Array.isArray(extractorExecutions) || !extractorExecutions.length) {
    contractFailure(
      'Extraction execution receipt requires at least one exact extractor execution.',
      'WMP_EXTRACTION_RECEIPT_INVALID'
    );
  }
  return extractorExecutions.map((execution) => {
    assertPlainRecord(execution, 'Extractor execution receipt input');
    assertString(execution.id, 'Extractor execution receipt input id');
    assertString(execution.version, 'Extractor execution receipt input version', { pattern: SEMVER });
    assertSha256(
      execution.implementationSha256,
      'Extractor execution receipt input implementationSha256'
    );
    assertSha256(execution.manifestSha256, 'Extractor execution receipt input manifestSha256');
    if (!COVERAGE.has(execution.coverage)) {
      contractFailure(
        `Extractor execution receipt input coverage '${execution.coverage}' is invalid.`,
        'WMP_EXTRACTION_RECEIPT_INVALID'
      );
    }
    return {
      id: execution.id,
      version: execution.version,
      implementationSha256: execution.implementationSha256,
      manifestSha256: execution.manifestSha256,
      coverage: execution.coverage,
      executionSha256: sha256(execution)
    };
  }).sort((left, right) => compareText(extractionKey(left), extractionKey(right)));
}

function viewContractBindings(resolvedViewContracts) {
  if (!Array.isArray(resolvedViewContracts)) {
    contractFailure(
      'Extraction execution receipt requires the resolved View Contract array.',
      'WMP_EXTRACTION_RECEIPT_INVALID'
    );
  }
  return resolvedViewContracts.map((value) => {
    const contract = validateViewContract(value);
    return {
      id: contract.id,
      version: contract.version,
      contractSha256: contract.contractSha256
    };
  }).sort((left, right) => compareText(viewKey(left), viewKey(right)));
}

function viewLedgerBindings(viewFactLedgers) {
  if (!Array.isArray(viewFactLedgers)) {
    contractFailure(
      'Extraction execution receipt requires the View Fact Ledger array.',
      'WMP_EXTRACTION_RECEIPT_INVALID'
    );
  }
  return viewFactLedgers.map((value) => {
    const ledger = validateViewFactLedger(value);
    return {
      viewId: ledger.viewId,
      viewVersion: ledger.viewVersion,
      viewSpecSha256: ledger.viewSpecSha256,
      ledgerSha256: ledger.ledgerSha256
    };
  }).sort((left, right) => compareText(viewKey(left), viewKey(right)));
}

function assertViewRoster(viewContracts, viewFactLedgers) {
  const contracts = new Map(viewContracts.map((entry) => [viewKey(entry), entry]));
  if (contracts.size !== viewFactLedgers.length) {
    contractFailure(
      'Extraction execution receipt View Contracts and View Fact Ledgers have different rosters.',
      'WMP_EXTRACTION_RECEIPT_VIEW_MISMATCH'
    );
  }
  for (const ledger of viewFactLedgers) {
    const contract = contracts.get(viewKey(ledger));
    if (!contract || contract.contractSha256 !== ledger.viewSpecSha256) {
      contractFailure(
        `Extraction execution receipt View Fact Ledger '${viewKey(ledger)}' is not bound to its exact View Contract.`,
        'WMP_EXTRACTION_RECEIPT_VIEW_MISMATCH'
      );
    }
  }
}

function receiptCore({
  sourceManifestSha256, scopeManifestSha256, extractorRegistrySha256,
  extractorExecutions, resolvedViewContracts, viewFactLedgers
}) {
  assertSha256(sourceManifestSha256, 'Extraction execution receipt sourceManifestSha256');
  assertSha256(scopeManifestSha256, 'Extraction execution receipt scopeManifestSha256');
  assertSha256(extractorRegistrySha256, 'Extraction execution receipt extractorRegistrySha256');
  const executions = executionBindings(extractorExecutions);
  const contracts = viewContractBindings(resolvedViewContracts);
  const ledgers = viewLedgerBindings(viewFactLedgers);
  assertUniqueCanonical(executions, extractionKey, 'Extraction execution receipt extractors');
  assertUniqueCanonical(contracts, viewKey, 'Extraction execution receipt View Contracts');
  assertUniqueCanonical(ledgers, viewKey, 'Extraction execution receipt View Fact Ledgers');
  assertViewRoster(contracts, ledgers);
  return {
    schemaVersion: currentSchemaVersion('world-model-extraction-execution-receipt'),
    kind: 'world-model-extraction-execution-receipt',
    sourceManifestSha256,
    scopeManifestSha256,
    extractorRegistrySha256,
    extractorExecutions: executions,
    viewContracts: contracts,
    viewFactLedgers: ledgers
  };
}

export function createExtractionExecutionReceipt(input = {}) {
  return deepFreeze(validateExtractionExecutionReceipt(
    sealRecord(receiptCore(input), 'receiptSha256')
  ));
}

export function validateExtractionExecutionReceipt(value, expected = null) {
  assertPlainRecord(value, 'World-model extraction execution receipt');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'sourceManifestSha256', 'scopeManifestSha256',
      'extractorRegistrySha256', 'extractorExecutions', 'viewContracts', 'viewFactLedgers',
      'receiptSha256'
    ],
    label: 'World-model extraction execution receipt'
  });
  assertSchemaKind(
    value,
    'world-model-extraction-execution-receipt',
    'World-model extraction execution receipt'
  );
  for (const field of [
    'sourceManifestSha256', 'scopeManifestSha256', 'extractorRegistrySha256', 'receiptSha256'
  ]) assertSha256(value[field], `Extraction execution receipt ${field}`);
  if (!Array.isArray(value.extractorExecutions)
      || !Array.isArray(value.viewContracts)
      || !Array.isArray(value.viewFactLedgers)) {
    contractFailure(
      'Extraction execution receipt bindings must be arrays.',
      'WMP_EXTRACTION_RECEIPT_INVALID'
    );
  }
  if (!value.extractorExecutions.length) {
    contractFailure(
      'Extraction execution receipt requires at least one extractor execution binding.',
      'WMP_EXTRACTION_RECEIPT_INVALID'
    );
  }
  for (const entry of value.extractorExecutions) {
    assertPlainRecord(entry, 'Extraction execution receipt extractor');
    assertExactKeys(entry, {
      required: [
        'id', 'version', 'implementationSha256', 'manifestSha256', 'coverage',
        'executionSha256'
      ],
      label: 'Extraction execution receipt extractor'
    });
    assertString(entry.id, 'Extraction execution receipt extractor id');
    assertString(entry.version, 'Extraction execution receipt extractor version', { pattern: SEMVER });
    for (const field of ['implementationSha256', 'manifestSha256', 'executionSha256']) {
      assertSha256(entry[field], `Extraction execution receipt extractor ${field}`);
    }
    if (!COVERAGE.has(entry.coverage)) {
      contractFailure(
        `Extraction execution receipt coverage '${entry.coverage}' is invalid.`,
        'WMP_EXTRACTION_RECEIPT_INVALID'
      );
    }
  }
  for (const entry of value.viewContracts) {
    assertPlainRecord(entry, 'Extraction execution receipt View Contract');
    assertExactKeys(entry, {
      required: ['id', 'version', 'contractSha256'],
      label: 'Extraction execution receipt View Contract'
    });
    assertString(entry.id, 'Extraction execution receipt View Contract id', {
      pattern: VIEW_ID_PATTERN
    });
    assertInteger(entry.version, 'Extraction execution receipt View Contract version', { minimum: 1 });
    assertSha256(entry.contractSha256, 'Extraction execution receipt View Contract digest');
  }
  for (const entry of value.viewFactLedgers) {
    assertPlainRecord(entry, 'Extraction execution receipt View Fact Ledger');
    assertExactKeys(entry, {
      required: ['viewId', 'viewVersion', 'viewSpecSha256', 'ledgerSha256'],
      label: 'Extraction execution receipt View Fact Ledger'
    });
    assertString(entry.viewId, 'Extraction execution receipt View Fact Ledger id', {
      pattern: VIEW_ID_PATTERN
    });
    assertInteger(
      entry.viewVersion,
      'Extraction execution receipt View Fact Ledger version',
      { minimum: 1 }
    );
    assertSha256(entry.viewSpecSha256, 'Extraction execution receipt View Fact Ledger view digest');
    assertSha256(entry.ledgerSha256, 'Extraction execution receipt View Fact Ledger digest');
  }
  assertUniqueCanonical(
    value.extractorExecutions, extractionKey, 'Extraction execution receipt extractors'
  );
  assertUniqueCanonical(value.viewContracts, viewKey, 'Extraction execution receipt View Contracts');
  assertUniqueCanonical(
    value.viewFactLedgers, viewKey, 'Extraction execution receipt View Fact Ledgers'
  );
  assertViewRoster(value.viewContracts, value.viewFactLedgers);
  assertSelfHash(value, 'receiptSha256', 'World-model extraction execution receipt');
  if (expected) {
    const expectedCore = receiptCore(expected);
    const receivedCore = structuredClone(value);
    delete receivedCore.receiptSha256;
    if (canonicalJson(receivedCore) !== canonicalJson(expectedCore)) {
      contractFailure(
        'Extraction execution receipt does not bind the exact supplied extraction and view inputs.',
        'WMP_EXTRACTION_RECEIPT_BINDING_MISMATCH'
      );
    }
  }
  return value;
}
