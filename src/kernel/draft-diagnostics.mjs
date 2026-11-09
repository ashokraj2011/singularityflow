/** Bounded diagnostics from the same validators used by publication, never passing evidence. */
export const MAX_DRAFT_DIAGNOSTICS = 256;
const overflow = new WeakMap();

export function draftDiagnosticSummary(diagnostics) {
  const omitted = overflow.get(diagnostics) ?? 0;
  return { maximum: MAX_DRAFT_DIAGNOSTICS, omitted, complete: omitted === 0 };
}

/**
 * What an authored cell or line holds, short, so a refusal can say what it found. Only author-written
 * artifact text passes through here. Agents looped for many rounds on refusals that named a rule but
 * never the value that broke it (office, 2026-10-29).
 */
export function shown(cell) {
  const text = String(cell ?? '').trim().replace(/\s+/gu, ' ');
  return text ? `'${text.length > 80 ? `${text.slice(0, 77)}...` : text}'` : 'nothing';
}

/**
 * What is wrong with a path an author wrote, in words: one message for every defect sent authors
 * guessing which rule they broke. Null when no single defect is recognisable.
 */
export function pathDefect(candidate) {
  const value = String(candidate ?? '');
  if (!value.trim()) return 'it is empty';
  if (value !== value.trim()) return 'it has spaces around it';
  if (value.endsWith('/')) return 'it names a folder (ends with /); name a file';
  if (value === '.' || value.startsWith('./') || value.includes('/./') || value.includes('//')) return 'it has ./ or // in it; write the plain path from the repository root';
  if (value === '..' || value.startsWith('../') || value.includes('/../')) return 'it climbs out with ..; write the path from the repository root';
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value) || value.includes('\\')) return 'it is an absolute or Windows path; write it relative to the repository root with /';
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return 'it is a URL, not a repository path';
  if (/[*?[\]{}]/u.test(value)) return 'it is a pattern (* ? [ ] { }); name one exact file';
  if (/[<>$]/u.test(value) || value.includes('...')) return 'it holds a placeholder (< > $ ...); name the real file';
  if (/(?:^|\/)(?:TODO|TBD|PLACEHOLDER)(?:\.|\/|$)/iu.test(value)) return 'it names a TODO or TBD placeholder; name the real file';
  if (/[\0-\x1f\x7f]/u.test(value)) return 'it holds a control character';
  return null;
}

/** The message, with what the cell holds when the validator recorded it and the message does not already say. */
function withActual(message, actual) {
  if (typeof actual !== 'string' || /\bholds\b/u.test(message)) return message;
  const quoted = shown(actual);
  if (message.includes(quoted)) return message;
  return `${message.replace(/\s*$/u, '')} It holds ${quoted}.`;
}

export function collectDraftDiagnostic(diagnostics, error, location = {}) {
  if (diagnostics.length >= MAX_DRAFT_DIAGNOSTICS) {
    overflow.set(diagnostics, (overflow.get(diagnostics) ?? 0) + 1);
    return;
  }
  const details = { ...location, ...(error.details ?? {}) };
  const finding = { code: error.code ?? 'SPEC_PLANNED_TABLE_INVALID', message: withActual(error.message, details.actual),
    line: details.line ?? null, clauseId: details.clauseId ?? null,
    field: details.field ?? null, details };
  if (!diagnostics.some(item => JSON.stringify(item) === JSON.stringify(finding))) diagnostics.push(finding);
}

export function inspectDraftValue(diagnostics, read, location = {}) {
  try { return { valid: true, value: read() }; }
  catch (error) { collectDraftDiagnostic(diagnostics, error, location); return { valid: false, value: null }; }
}
