import { SingularityFlowError } from './util.mjs';

const KINDS = new Set(['story', 'initiative']);

export function subjectRef(value, { code = 'WORK_PENDING_SUBJECT_KEY_REQUIRED' } = {}) {
  const kind = String(value?.kind ?? '').trim();
  const id = String(value?.id ?? '').trim();
  if (!KINDS.has(kind) || !id) {
    throw new SingularityFlowError('A governed subject must include an explicit story/initiative kind and ID.', {
      code, details: { kind: kind || null, id: id || null }
    });
  }
  return Object.freeze({ kind, id });
}

export function subjectKey(value, options) {
  const subject = subjectRef(value, options);
  return `${subject.kind}:${subject.id}`;
}

export function validateSubjectKey(value) {
  const text = String(value ?? '');
  const separator = text.indexOf(':');
  if (separator < 1) return subjectKey(null);
  return subjectKey({ kind: text.slice(0, separator), id: text.slice(separator + 1) });
}
