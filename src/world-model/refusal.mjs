import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { deepFreeze } from './canonicalize.mjs';
import {
  VIEW_ID_PATTERN, assertExactKeys, assertPlainRecord, assertSchemaKind, assertSelfHash,
  assertSha256, assertString, assertStringArray
} from './contracts.mjs';

function sha(value) { return `sha256:${recordSha256(value)}`; }

export function worldModelRefusal({ code, view, preserved, failures, nextAction, retry = null }) {
  const base = {
    schemaVersion: currentSchemaVersion('world-model-refusal'),
    kind: 'world-model-refusal',
    code,
    view,
    preserved: {
      evidenceCatalogSha256: preserved.evidenceCatalogSha256,
      factLedgerSha256: preserved.factLedgerSha256,
      validViewIds: [...new Set(preserved.validViewIds ?? [])].sort()
    },
    failures: (failures ?? []).map((entry) => structuredClone(entry)),
    nextAction: structuredClone(nextAction),
    ...(retry ? { retry: structuredClone(retry) } : {})
  };
  return deepFreeze({ ...base, refusalSha256: sha(base) });
}

/** Validate the typed refusal envelope without assigning authority to optional retry metadata. */
export function validateWorldModelRefusal(value) {
  const refusal = readRecord('world-model-refusal', value).record;
  assertPlainRecord(refusal, 'World-model refusal');
  assertExactKeys(refusal, {
    required: [
      'schemaVersion', 'kind', 'code', 'view', 'preserved', 'failures', 'nextAction',
      'refusalSha256'
    ],
    optional: ['retry'],
    label: 'World-model refusal'
  });
  assertSchemaKind(refusal, 'world-model-refusal', 'World-model refusal');
  assertString(refusal.code, 'World-model refusal code', { pattern: /^WMB_[A-Z0-9_]+$/ });
  if (refusal.view !== null) {
    assertString(refusal.view, 'World-model refusal view', { pattern: VIEW_ID_PATTERN });
  }
  assertPlainRecord(refusal.preserved, 'World-model refusal preserved authority');
  assertExactKeys(refusal.preserved, {
    required: ['evidenceCatalogSha256', 'factLedgerSha256', 'validViewIds'],
    label: 'World-model refusal preserved authority'
  });
  assertSha256(refusal.preserved.evidenceCatalogSha256,
    'World-model refusal evidence catalog SHA-256');
  assertSha256(refusal.preserved.factLedgerSha256,
    'World-model refusal Fact Ledger SHA-256');
  assertStringArray(refusal.preserved.validViewIds,
    'World-model refusal valid view IDs', { sorted: true, pattern: VIEW_ID_PATTERN });
  if (!Array.isArray(refusal.failures) || !refusal.failures.length
      || refusal.failures.some((entry) => !entry || typeof entry !== 'object'
        || Array.isArray(entry))) {
    const error = new TypeError('World-model refusal failures must be a non-empty record array.');
    error.code = 'WMB_CONTRACT_INVALID';
    throw error;
  }
  assertPlainRecord(refusal.nextAction, 'World-model refusal next action');
  assertExactKeys(refusal.nextAction, {
    required: ['operation'], optional: ['view', 'reuseFacts'],
    label: 'World-model refusal next action'
  });
  assertString(refusal.nextAction.operation, 'World-model refusal next action operation');
  if (![
    'world-model.regenerate-view', 'world-model.retry-failed-view',
    'world-model.migrate', 'world-model.inspect'
  ].includes(refusal.nextAction.operation)) {
    const error = new TypeError('World-model refusal next action operation is not registered.');
    error.code = 'WMB_CONTRACT_INVALID';
    throw error;
  }
  if (refusal.nextAction.view != null) {
    assertString(refusal.nextAction.view, 'World-model refusal next action view', {
      pattern: VIEW_ID_PATTERN
    });
  }
  if (refusal.nextAction.reuseFacts != null
      && typeof refusal.nextAction.reuseFacts !== 'boolean') {
    const error = new TypeError('World-model refusal next action reuseFacts must be boolean.');
    error.code = 'WMB_CONTRACT_INVALID';
    throw error;
  }
  if (refusal.retry != null) assertPlainRecord(refusal.retry, 'World-model refusal retry authority');
  assertSelfHash(refusal, 'refusalSha256', 'World-model refusal');
  return deepFreeze(refusal);
}
