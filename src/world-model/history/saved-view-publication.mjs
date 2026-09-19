import { currentSchemaVersion } from '../../schema-migrations.mjs';
import { SingularityFlowError } from '../../util.mjs';
import { canonicalJson, compareText, deepFreeze, sealRecord, sha256 } from '../canonicalize.mjs';
import { createViewProjectionRegistration } from '../extract/view-projection.mjs';
import { createWmpViewBinding, createWmpViewInputs } from './contracts.mjs';
import { stageWorldModelHistoryPublication } from './publication.mjs';
import {
  parseExactRetainedObject, validateRetainedObjectReference
} from './retained-object.mjs';
import { validateRetainedWorldModelBindingGraph } from './store.mjs';
import {
  PERSISTED_OVERVIEW_RENDERER_CONTRACT,
  PERSISTED_OVERVIEW_VALIDATION_CHECK_IDS,
  PERSISTED_OVERVIEW_VALIDATOR_CONTRACT
} from './view-owner-contracts.mjs';
import { renderPersistedOverviewView } from '../materialize/overview-view.mjs';
import {
  createWorldModelConsumerProfile, createWorldModelOutputBudget
} from '../plan.mjs';
import { WMP_OVERVIEW_VIEW_REGISTRY, normalizeWmpOverviewViewReference } from '../registry/views.mjs';

const DEFAULT_SELECTION = deepFreeze({
  kind: 'wmp/view-selection',
  version: 1,
  storyScopeSha256: null,
  querySha256: null,
  factIds: [],
  traversal: { maximumFacts: 1000, maximumEdges: 1000, maximumDepth: 8 }
});
const FORMATS = new Set(['md', 'json']);
const VARIANTS = new Set(['brief', 'full']);

function fail(message, code = 'WMP_VIEW_MATERIALIZATION_INVALID', details = {}, cause) {
  throw new SingularityFlowError(message, { code, details, cause });
}

function retained(record, role, family, mediaType = 'application/json') {
  const text = typeof record === 'string' ? record : canonicalJson(record);
  const bytes = Buffer.from(text, 'utf8');
  return deepFreeze({
    ref: { role, family, mediaType, sha256: sha256(bytes), bytes: bytes.length },
    bytes: text,
    record: typeof record === 'string' ? null : record
  });
}

function exactBytes(value, label) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(value); }
    catch (error) {
      fail(`${label} is not exact UTF-8.`, 'WMP_CANONICAL_BYTES_REQUIRED', {}, error);
    }
  }
  fail(`${label} has no exact retained bytes.`, 'WMP_CANONICAL_BYTES_REQUIRED');
}

function normalizedModel(value) {
  const binding = value?.binding;
  const source = value?.objects ?? value?.closure;
  if (!binding || !Array.isArray(source)) {
    fail('Saved-view materialization requires one accepted Model Binding and its complete verified closure.',
      'WMP_INPUT_MISSING');
  }
  const objects = source.map((entry, index) => {
    if (!entry?.ref) fail(`Accepted model object ${index} has no exact ObjectRef.`, 'WMP_INPUT_MISSING');
    const ref = validateRetainedObjectReference(entry.ref);
    const bytes = exactBytes(entry.bytes, `Accepted model object '${ref.role}'`);
    const record = parseExactRetainedObject(ref, Buffer.from(bytes, 'utf8'));
    if (entry.record !== undefined
        && canonicalJson(entry.record) !== canonicalJson(record)) {
      fail(`Accepted model object '${ref.role}' record differs from its exact retained bytes.`,
        'WMP_INTEGRITY_FAILED', { role: ref.role, sha256: ref.sha256 });
    }
    return deepFreeze({
      ref: structuredClone(ref),
      bytes,
      record
    });
  });
  const bindingObject = retained(binding, 'model-binding', 'world-model-model-binding');
  const closure = new Map(objects.map((entry) => [entry.ref.sha256, {
    ref: entry.ref, bytes: Buffer.from(entry.bytes, 'utf8'), record: entry.record
  }]));
  closure.set(bindingObject.ref.sha256, {
    ref: bindingObject.ref, bytes: Buffer.from(bindingObject.bytes, 'utf8'), record: binding
  });
  validateRetainedWorldModelBindingGraph('model', binding, closure, {
    currentExtractorAdmission: false
  });
  return { binding, objects, bindingObject, closure };
}

function oneRole(model, role) {
  const matches = model.objects.filter((entry) => entry.ref.role === role);
  if (matches.length !== 1 || !matches[0].record) {
    fail(`Saved-view materialization requires exactly one retained '${role}' record.`,
      'WMP_INPUT_ROLE_MISSING', { role, matches: matches.length });
  }
  return matches[0];
}

function canonicalReferences(values = []) {
  if (!Array.isArray(values) || !values.length) {
    fail('Saved-view materialization requires at least one persisted overview view.',
      'WMP_VIEW_UNKNOWN');
  }
  const selected = new Map();
  for (const value of values) {
    const resolved = normalizeWmpOverviewViewReference(value);
    selected.set(resolved.reference, resolved);
  }
  return [...selected.values()].sort((left, right) => compareText(left.reference, right.reference));
}

function exactSelection(value = DEFAULT_SELECTION) {
  // createWmpViewInputs owns the full closed validation. Clone here so one caller cannot mutate
  // another view while fan-out is in progress.
  return structuredClone(value);
}

function receiptFor({ renderedObject, contract, selectedLedger, scopeManifest }) {
  return sealRecord({
    schemaVersion: currentSchemaVersion('world-model-view-validation-receipt'),
    kind: 'world-model-view-validation-receipt',
    viewId: contract.id,
    viewVersion: contract.version,
    candidateSha256: renderedObject.ref.sha256,
    candidateSchemaSha256: PERSISTED_OVERVIEW_VALIDATOR_CONTRACT.candidateSchemaSha256,
    viewSpecSha256: contract.contractSha256,
    factLedgerSha256: selectedLedger.ledgerSha256,
    scopeSha256: scopeManifest.scopeSha256,
    checks: PERSISTED_OVERVIEW_VALIDATION_CHECK_IDS.map((id) => ({ id, status: 'pass' })),
    status: 'passed',
    validatorSha256: PERSISTED_OVERVIEW_VALIDATOR_CONTRACT.implementationSha256
  }, 'receiptSha256');
}

function expansionHandle(rendered) {
  if (rendered.outputFormat === 'json') {
    const parsed = JSON.parse(rendered.content);
    return parsed?.selection?.expansionHandle ?? null;
  }
  const escaped = /^- Expansion: (.+)$/mu.exec(rendered.content)?.[1];
  const handle = escaped?.replaceAll('&#58;', ':').replaceAll('\\-', '-') ?? null;
  return /^wmp-view:sha256:[a-f0-9]{64}$/u.test(handle ?? '') ? handle : null;
}

/**
 * Materialize deterministic persisted overview views over one already accepted Model Binding.
 *
 * This service is the sole saved-view writer. It accepts no caller-supplied rendered bytes,
 * receipts, owner digests, measurements, or view keys. It recomputes all of them, then submits the
 * complete model-plus-view closure to the existing publication admission boundary. Existing model
 * objects may be restaged because every path uses absent-or-identical semantics; that gives the
 * validator one combined existing-plus-new graph without trusting ambient state.
 *
 * Persisted overview v1 is deliberately byte-only. Token measurement is not an approximation and
 * is not silently inferred. Any non-null tokenizer request fails before rendering or staging.
 */
export function materializePersistedWorldModelViews(options = {}) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    fail('Saved-view materialization options must be a plain object.');
  }
  const {
    model,
    views,
    variants = ['full'],
    format = 'md',
    selection = DEFAULT_SELECTION,
    consumerProfile = createWorldModelConsumerProfile(),
    outputBudget = null,
    tokenizer = null,
    outputDir,
    historyDir,
    ...unknown
  } = options;
  const unsupported = Object.keys(unknown).sort(compareText);
  if (unsupported.length) {
    fail(`Saved-view materialization options contain unsupported field(s): ${unsupported.join(', ')}.`,
      'WMP_VIEW_MATERIALIZATION_INVALID', { unsupported });
  }
  if (tokenizer !== null) {
    fail(
      'Persisted overview v1 is byte-measured; token-measured variants require a separately registered exact tokenizer owner.',
      'WMP_TOKENIZER_OWNER_UNAVAILABLE'
    );
  }
  if (!FORMATS.has(format)) fail(`Unsupported saved-view format '${format}'.`, 'WMP_VIEW_OUTPUT_FORMAT_INVALID');
  if (!Array.isArray(variants) || !variants.length
      || variants.some((variant) => !VARIANTS.has(variant))) {
    fail('Saved-view variants must be a non-empty subset of brief and full.',
      'WMP_VIEW_VARIANT_INVALID');
  }
  const uniqueVariants = [...new Set(variants)].sort(compareText);
  const accepted = normalizedModel(model);
  const selectedViews = canonicalReferences(views);
  const contracts = selectedViews.map((entry) => entry.contract);
  const budget = outputBudget ?? createWorldModelOutputBudget(contracts);
  const sourceSnapshot = oneRole(accepted, 'source-snapshot').record;
  const scopeManifest = oneRole(accepted, 'scope-manifest').record;
  const extractorRegistry = oneRole(accepted, 'extractor-registry').record;
  const evidenceCatalog = oneRole(accepted, 'evidence-catalog').record;
  const derivationCatalog = oneRole(accepted, 'derivation-catalog').record;
  const sourceFactLedgerObject = oneRole(accepted, 'fact-ledger');
  const consumerObject = retained(
    consumerProfile, 'consumer-profile', 'world-model-consumer-profile'
  );
  const budgetObject = retained(budget, 'output-budget', 'world-model-output-budget');
  const rendererObject = retained(
    PERSISTED_OVERVIEW_RENDERER_CONTRACT,
    'renderer-contract', 'world-model-renderer-contract'
  );
  const validatorObject = retained(
    PERSISTED_OVERVIEW_VALIDATOR_CONTRACT,
    'validator-contract', 'world-model-validator-contract'
  );
  const commonObjects = [
    ...accepted.objects,
    consumerObject,
    budgetObject,
    rendererObject,
    validatorObject
  ];
  const bindings = [];
  const viewObjects = [];
  const materialized = [];
  for (const selected of selectedViews) {
    const contract = selected.contract;
    const projection = createViewProjectionRegistration({
      sourceSnapshot,
      scopeManifest,
      extractorRegistry,
      viewRegistry: WMP_OVERVIEW_VIEW_REGISTRY,
      evidenceCatalog,
      derivationCatalog,
      factLedger: sourceFactLedgerObject.record,
      viewContracts: [contract]
    });
    const projectedLedgerObject = retained(
      projection.factLedger, 'projection-fact-ledger', 'world-model-fact-ledger'
    );
    const viewContractObject = retained(
      contract, 'view-contract', 'world-model-view-contract'
    );
    const selectedLedger = projection.viewFactLedgers[0];
    const selectedLedgerObject = retained(
      selectedLedger, 'selected-fact-ledger', 'world-model-view-fact-ledger'
    );
    for (const variant of uniqueVariants) {
      const captures = [
        {
          role: 'fact-ledger', subject: 'accepted-model-source', status: 'available',
          objectRef: sourceFactLedgerObject.ref, reason: null
        },
        {
          role: 'model-binding', subject: 'accepted-model', status: 'available',
          objectRef: accepted.bindingObject.ref, reason: null
        },
        {
          role: 'output-budget', subject: contract.id, status: 'available',
          objectRef: budgetObject.ref, reason: null
        },
        {
          role: 'projection-fact-ledger', subject: contract.id, status: 'available',
          objectRef: projectedLedgerObject.ref, reason: null
        }
      ].sort((left, right) => compareText(
        `${left.role}\0${left.subject}`, `${right.role}\0${right.subject}`
      ));
      const exactViewSelection = exactSelection(selection);
      const viewInputs = createWmpViewInputs({
        modelPayloadSha256: accepted.binding.modelPayloadSha256,
        captures,
        viewContractRef: viewContractObject.ref,
        consumerProfileRef: consumerObject.ref,
        selection: exactViewSelection,
        comparisonRef: null,
        evidenceCutRef: null
      });
      const viewInputsObject = retained(
        viewInputs, 'view-inputs', 'world-model-view-inputs'
      );
      const rendered = renderPersistedOverviewView({
        viewContract: contract,
        sourceFactLedger: projection.factLedger,
        viewFactLedger: selectedLedger,
        variant,
        outputFormat: format,
        maximumBytes: PERSISTED_OVERVIEW_RENDERER_CONTRACT.maximumBytes[variant],
        modelPayloadSha256: accepted.binding.modelPayloadSha256,
        viewInputsSha256: viewInputs.inputManifestSha256
      });
      const renderedObject = retained(
        rendered.content,
        'rendered-view',
        null,
        format === 'md' ? 'text/markdown' : 'application/json'
      );
      const receipt = receiptFor({
        renderedObject, contract, selectedLedger, scopeManifest
      });
      const receiptObject = retained(
        receipt, 'validator-receipt', 'world-model-view-validation-receipt'
      );
      const inputs = {
        identityVersion: 1,
        modelPayloadSha256: accepted.binding.modelPayloadSha256,
        viewInputsSha256: viewInputs.inputManifestSha256,
        viewId: contract.id,
        viewVersion: contract.version,
        viewContractSha256: contract.contractSha256,
        rendererSha256: rendererObject.ref.sha256,
        validatorSha256: validatorObject.ref.sha256,
        consumerProfileSha256: consumerProfile.profileSha256,
        selectionSha256: sha256(exactViewSelection),
        outputBudgetSha256: budget.budgetSha256,
        tokenizerSha256: null,
        format,
        variant
      };
      const binding = createWmpViewBinding({
        inputs,
        viewInputsRef: viewInputsObject.ref,
        selectedFactLedgerRef: selectedLedgerObject.ref,
        rendererContractRef: rendererObject.ref,
        validatorContractRef: validatorObject.ref,
        status: 'complete',
        gaps: [],
        selection: {
          mode: 'inline',
          selectedFactIds: rendered.selectedFactIds,
          omittedFactIds: rendered.omittedFactIds,
          manifestRef: null
        },
        rendered: renderedObject.ref,
        measurement: { bytes: rendered.bytes, tokens: null, tokenizerSha256: null },
        validatorReceiptRef: receiptObject.ref
      });
      bindings.push(binding);
      viewObjects.push(
        viewContractObject, projectedLedgerObject, selectedLedgerObject,
        viewInputsObject, renderedObject, receiptObject
      );
      const handle = expansionHandle(rendered);
      if (!handle) fail('Saved-view renderer did not emit its governed expansion handle.',
        'WMP_VIEW_REPLAY_MISMATCH', { view: selected.reference, variant, format });
      materialized.push(deepFreeze({
        reference: selected.reference,
        variant,
        format,
        viewKey: binding.viewKey,
        bindingSha256: binding.bindingSha256,
        binding,
        renderedRef: renderedObject.ref,
        expansionHandle: handle,
        bytes: rendered.bytes
      }));
    }
  }
  const objects = [...commonObjects, ...viewObjects]
    .filter((entry, index, values) => values.findIndex((candidate) => (
      candidate.ref.role === entry.ref.role && candidate.ref.sha256 === entry.ref.sha256
    )) === index)
    .sort((left, right) => compareText(
      `${left.ref.role}\0${left.ref.sha256}`, `${right.ref.role}\0${right.ref.sha256}`
    ));
  const stagedHistory = stageWorldModelHistoryPublication({
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(historyDir === undefined ? {} : { historyDir }),
    modelBindings: [accepted.binding],
    viewBindings: bindings,
    objects: objects.map((entry) => ({ ref: entry.ref, bytes: entry.bytes }))
  });
  return deepFreeze({
    status: 'materialized',
    measurementPolicy: 'exact-bytes-v1',
    modelKey: accepted.binding.modelKey,
    modelBinding: accepted.binding,
    modelBindingRef: accepted.bindingObject.ref,
    views: materialized.sort((left, right) => compareText(
      `${left.reference}\0${left.variant}\0${left.format}`,
      `${right.reference}\0${right.variant}\0${right.format}`
    )),
    bindings,
    objects,
    stagedHistory
  });
}

export const createPersistedSavedViewPublication = materializePersistedWorldModelViews;
