import { recordSha256 } from '../records.mjs';
import { currentSchemaVersion } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';

export const ADHOC_TERMINAL_STATES = Object.freeze([
  'landed', 'promoted', 'split', 'local-only', 'discarded', 'cancelled'
]);

export const ADHOC_DISPOSITIONS = Object.freeze([
  'claimed', 'deviation', 'split', 'revert', 'engine-managed', 'local-only',
  'outside-scope', 'unresolved'
]);

export function contentSha256(value, hashField) {
  const core = { ...value };
  delete core[hashField];
  return `sha256:${recordSha256(core)}`;
}

export function stampRecord(family, value, hashField) {
  const record = { ...value, schemaVersion: currentSchemaVersion(family) };
  return { ...record, [hashField]: contentSha256(record, hashField) };
}

export function assertRecordHash(record, hashField, label = record?.kind ?? 'record') {
  const actual = contentSha256(record, hashField);
  if (record?.[hashField] !== actual) {
    throw new SingularityFlowError(`${label} failed its content hash check.`, {
      code: 'ADH_RECORD_INTEGRITY', details: { expected: record?.[hashField] ?? null, actual }
    });
  }
  return record;
}

export function adhocError(code, blockingFact, legalNextAction, details = {}) {
  return new SingularityFlowError(
    `${blockingFact} Work is preserved. ${legalNextAction}`,
    {
      code,
      details: {
        preservedWork: true,
        blockingFact,
        legalNextAction,
        ...details
      }
    }
  );
}

export function assertSessionMutable(session) {
  if (ADHOC_TERMINAL_STATES.includes(session.status)) {
    throw adhocError(
      'ADH_SESSION_TERMINAL',
      `Ad hoc session '${session.sessionId}' is already ${session.status}.`,
      'Start a new ad hoc session for additional work.'
    );
  }
  return session;
}

export function normalizeResourceId(value) {
  const result = String(value ?? '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!result || result.startsWith('/') || result === '..' || result.startsWith('../')
      || result.split('/').includes('..')) {
    throw adhocError('ADH_DISPOSITION_INVALID', `Resource '${value}' is not repository-relative.`, 'Use a path shown by adhoc effects.');
  }
  return result;
}
