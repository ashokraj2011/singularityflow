/** Bounded diagnostics from the same validators used by publication, never passing evidence. */
export const MAX_DRAFT_DIAGNOSTICS = 256;
const overflow = new WeakMap();

export function draftDiagnosticSummary(diagnostics) {
  const omitted = overflow.get(diagnostics) ?? 0;
  return { maximum: MAX_DRAFT_DIAGNOSTICS, omitted, complete: omitted === 0 };
}

export function collectDraftDiagnostic(diagnostics, error, location = {}) {
  if (diagnostics.length >= MAX_DRAFT_DIAGNOSTICS) {
    overflow.set(diagnostics, (overflow.get(diagnostics) ?? 0) + 1);
    return;
  }
  const details = { ...location, ...(error.details ?? {}) };
  const finding = { code: error.code ?? 'SPEC_PLANNED_TABLE_INVALID', message: error.message,
    line: details.line ?? null, clauseId: details.clauseId ?? null,
    field: details.field ?? null, details };
  if (!diagnostics.some(item => JSON.stringify(item) === JSON.stringify(finding))) diagnostics.push(finding);
}

export function inspectDraftValue(diagnostics, read, location = {}) {
  try { return { valid: true, value: read() }; }
  catch (error) { collectDraftDiagnostic(diagnostics, error, location); return { valid: false, value: null }; }
}
