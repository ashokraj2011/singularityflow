import { canonicalJson, compareText, sealRecord, sha256 } from '../canonicalize.mjs';
import { currentSchemaVersion } from '../../schema-migrations.mjs';
import {
  FACT_ID_PATTERN, VIEW_ID_PATTERN, assertCanonicalOrder, assertExactKeys, assertInteger,
  assertPlainRecord, assertSchemaKind, assertSelfHash, assertSha256, assertString,
  assertStringArray, contractFailure
} from '../contracts.mjs';
import { validateViewContract } from '../registry/views.mjs';
import { validateFactLedger, validateFactRecord } from './fact-ledger.mjs';

export const REGISTERED_SELECTION_POLICY = Object.freeze({
  id: 'registered-view-fact-selection',
  version: 1,
  ordering: 'fact-id-lexical',
  staleFacts: 'exclude',
  requiredFacts: 'never-prune',
  contradictions: 'material-and-never-prune'
});
export const REGISTERED_SELECTION_POLICY_SHA256 = sha256(REGISTERED_SELECTION_POLICY);

function assertRegisteredPolicy(value) {
  const policy = value ?? REGISTERED_SELECTION_POLICY;
  if (canonicalJson(policy) !== canonicalJson(REGISTERED_SELECTION_POLICY)) {
    contractFailure('View Fact selection policy is not registered.', 'WMB_SELECTION_POLICY_NOT_REGISTERED');
  }
  return policy;
}

function computeViewSelection(source, view) {
  const eligibleTypes = new Set([
    ...view.factPolicy.requiredFactTypes,
    ...view.factPolicy.optionalFactTypes,
    ...view.factPolicy.requiredUnavailableSubjects
  ]);
  const eligible = source.facts.filter((fact) => eligibleTypes.has(fact.factType)
    && fact.status !== 'stale'
    && view.factPolicy.allowedStatus.includes(fact.status)
    && view.factPolicy.allowedAssurance.includes(fact.assurance));

  const required = eligible.filter((fact) => view.factPolicy.requiredFactTypes.includes(fact.factType));
  for (const factType of view.factPolicy.requiredFactTypes) {
    if (!required.some((fact) => fact.factType === factType)) {
      contractFailure(`View '${view.id}@${view.version}' is missing required Fact type '${factType}'.`, 'WMB_REQUIRED_FACT_MISSING');
    }
  }
  const requiredUnavailable = eligible.filter((fact) => fact.status === 'unavailable'
    && view.factPolicy.requiredUnavailableSubjects.includes(fact.factType));
  for (const factType of view.factPolicy.requiredUnavailableSubjects) {
    if (!eligible.some((fact) => fact.factType === factType)) {
      contractFailure(`View '${view.id}@${view.version}' has neither registered coverage nor an unavailable Fact for '${factType}'.`, 'WMB_REQUIRED_UNAVAILABLE_FACT_MISSING');
    }
  }
  const contradictions = eligible.filter((fact) => fact.status === 'contradicted');
  const mandatoryIds = new Set([...required, ...requiredUnavailable, ...contradictions].map((fact) => fact.id));
  if (mandatoryIds.size > view.facts.maximumSelectedFacts) {
    contractFailure(
      `View '${view.id}@${view.version}' has ${mandatoryIds.size} mandatory Facts but its hard ceiling is ${view.facts.maximumSelectedFacts}.`,
      'WMB_VIEW_FACT_BUDGET_EXCEEDED'
    );
  }
  const optional = eligible.filter((fact) => !mandatoryIds.has(fact.id)).sort((left, right) => compareText(left.id, right.id));
  const remaining = view.facts.maximumSelectedFacts - mandatoryIds.size;
  const selectedIds = new Set([...mandatoryIds, ...optional.slice(0, remaining).map((fact) => fact.id)]);
  return {
    facts: eligible.filter((fact) => selectedIds.has(fact.id))
      .map((fact) => structuredClone(fact))
      .sort((left, right) => compareText(left.id, right.id)),
    requiredFactIds: required.map((fact) => fact.id).sort(),
    requiredUnavailableFactIds: requiredUnavailable.map((fact) => fact.id).sort(),
    materialContradictionFactIds: contradictions.map((fact) => fact.id).sort()
  };
}

export function selectViewFacts({ factLedger, viewContract, selectionPolicy = null } = {}) {
  const source = validateFactLedger(factLedger);
  const view = validateViewContract(viewContract);
  assertRegisteredPolicy(selectionPolicy);
  if (view.validity.status !== 'active') contractFailure(`View '${view.id}@${view.version}' is not active.`, 'WMB_VIEW_NOT_ACTIVE');
  const selected = computeViewSelection(source, view);
  return validateViewFactLedger(sealRecord({
    schemaVersion: currentSchemaVersion('world-model-view-fact-ledger'),
    kind: 'world-model-view-fact-ledger',
    viewId: view.id,
    viewVersion: view.version,
    viewSpecSha256: view.contractSha256,
    sourceLedgerSha256: source.ledgerSha256,
    ...selected,
    selectionPolicySha256: REGISTERED_SELECTION_POLICY_SHA256
  }, 'ledgerSha256'), { factLedger: source, viewContract: view });
}

export function validateViewFactLedger(value, { factLedger = null, viewContract = null } = {}) {
  assertPlainRecord(value, 'World-model View Fact Ledger');
  assertExactKeys(value, {
    required: [
      'schemaVersion', 'kind', 'viewId', 'viewVersion', 'viewSpecSha256', 'sourceLedgerSha256',
      'facts', 'requiredFactIds', 'requiredUnavailableFactIds', 'materialContradictionFactIds',
      'selectionPolicySha256', 'ledgerSha256'
    ],
    label: 'World-model View Fact Ledger'
  });
  assertSchemaKind(value, 'world-model-view-fact-ledger', 'World-model View Fact Ledger');
  assertString(value.viewId, 'View Fact Ledger viewId', { pattern: VIEW_ID_PATTERN });
  assertInteger(value.viewVersion, 'View Fact Ledger viewVersion', { minimum: 1 });
  for (const field of ['viewSpecSha256', 'sourceLedgerSha256', 'selectionPolicySha256', 'ledgerSha256']) {
    assertSha256(value[field], `View Fact Ledger ${field}`);
  }
  if (value.selectionPolicySha256 !== REGISTERED_SELECTION_POLICY_SHA256) {
    contractFailure('View Fact Ledger selection policy is not registered.', 'WMB_SELECTION_POLICY_NOT_REGISTERED');
  }
  if (!Array.isArray(value.facts)) contractFailure('View Fact Ledger facts must be an array.');
  const selectedIds = new Set();
  for (const fact of value.facts) {
    validateFactRecord(fact);
    if (selectedIds.has(fact.id)) contractFailure(`View Fact Ledger repeats Fact '${fact.id}'.`);
    selectedIds.add(fact.id);
  }
  assertCanonicalOrder(value.facts, (fact) => fact.id, 'View Fact Ledger facts');
  for (const field of ['requiredFactIds', 'requiredUnavailableFactIds', 'materialContradictionFactIds']) {
    assertStringArray(value[field], `View Fact Ledger ${field}`, { sorted: true, pattern: FACT_ID_PATTERN });
    for (const id of value[field]) if (!selectedIds.has(id)) {
      contractFailure(`View Fact Ledger ${field} references unselected Fact '${id}'.`, 'WMB_FACT_NOT_REGISTERED');
    }
  }
  let source = null;
  if (factLedger) {
    source = validateFactLedger(factLedger);
    if (source.ledgerSha256 !== value.sourceLedgerSha256) contractFailure('View Fact Ledger source binding is invalid.', 'WMB_FACT_SOURCE_MISMATCH');
    const sourceIds = new Set(source.facts.map((fact) => fact.id));
    for (const id of selectedIds) if (!sourceIds.has(id)) contractFailure(`View Fact Ledger contains unregistered Fact '${id}'.`, 'WMB_FACT_NOT_REGISTERED');
  }
  if (viewContract) {
    const view = validateViewContract(viewContract);
    if (view.id !== value.viewId || view.version !== value.viewVersion || view.contractSha256 !== value.viewSpecSha256) {
      contractFailure('View Fact Ledger contract binding is invalid.', 'WMB_VIEW_CONTRACT_MISMATCH');
    }
    if (value.facts.length > view.facts.maximumSelectedFacts) contractFailure('View Fact Ledger exceeds its hard Fact budget.', 'WMB_VIEW_FACT_BUDGET_EXCEEDED');
    const eligibleTypes = new Set([
      ...view.factPolicy.requiredFactTypes,
      ...view.factPolicy.optionalFactTypes,
      ...view.factPolicy.requiredUnavailableSubjects
    ]);
    for (const fact of value.facts) {
      if (!eligibleTypes.has(fact.factType) || fact.status === 'stale'
          || !view.factPolicy.allowedStatus.includes(fact.status)
          || !view.factPolicy.allowedAssurance.includes(fact.assurance)) {
        contractFailure(`View Fact Ledger selected ineligible Fact '${fact.id}'.`, 'WMB_FACT_NOT_ELIGIBLE');
      }
    }
    if (source) {
      const expected = computeViewSelection(source, view);
      for (const field of ['requiredFactIds', 'requiredUnavailableFactIds', 'materialContradictionFactIds']) {
        if (canonicalJson(value[field]) !== canonicalJson(expected[field])) {
          contractFailure(`View Fact Ledger ${field} does not match deterministic selection.`, 'WMB_SELECTION_INVALID');
        }
      }
      if (canonicalJson(value.facts.map((fact) => fact.id)) !== canonicalJson(expected.facts.map((fact) => fact.id))) {
        contractFailure('View Fact Ledger Fact set does not match deterministic selection.', 'WMB_SELECTION_INVALID');
      }
    }
  }
  assertSelfHash(value, 'ledgerSha256', 'World-model View Fact Ledger');
  return value;
}
