/**
 * The findings a gate recorded, as a person or an agent reads them after it: what remains on changed
 * lines, what exists already, and which scanners could not run. Every message stays the tool's data.
 */

/** A published step's findings in a few fields, or null when nothing needs saying (all passed, or none ran). */
export function publishedFindingsSummary(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const unavailable = (evidence.unavailable ?? []).map((entry) => entry.commandId);
  const counted = new Set(evidence.counted ?? []);
  const remaining = (evidence.findings ?? []).filter((finding) => counted.has(finding.fingerprint)).slice(0, 5)
    .map(({ id, tool, rule, severity, file, line, message }) => ({ id, tool, rule, severity, file, line, message }));
  if (evidence.outcome === 'passed' && !unavailable.length) return null;
  const parts = [];
  if (remaining.length) {
    parts.push(`${evidence.counts?.counted ?? remaining.length} finding(s) on changed lines remain after ${evidence.attempt ?? '?'} attempt(s)`
      + ` and go to the step's approvers (${remaining.slice(0, 3).map((finding) => `${finding.rule ?? finding.tool} at ${finding.file ?? '?'}:${finding.line ?? '?'}`).join('; ')})`);
  }
  if (unavailable.length) parts.push(`scanner${unavailable.length === 1 ? '' : 's'} ${unavailable.join(', ')} could not run and blocked nothing`);
  return { mode: evidence.mode, outcome: evidence.outcome, attempt: evidence.attempt ?? null,
    counts: { counted: evidence.counts?.counted ?? 0, newCode: evidence.counts?.newCode ?? 0, existing: evidence.counts?.existing ?? 0 },
    remaining, unavailable, words: `${parts.join('; ')}.` };
}
