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
  const existing = evidence.counts?.existing ?? 0;
  const byFingerprint = new Map((evidence.findings ?? []).map((finding) => [finding.fingerprint, finding]));
  const held = (evidence.dependencies?.held ?? []).map((fingerprint) => byFingerprint.get(fingerprint)).filter(Boolean).slice(0, 5)
    .map(({ id, tool, rule, severity, package: name, installedVersion, fixedVersion, cve, message }) => ({ id, tool, rule, severity, package: name, installedVersion,
      ...(fixedVersion ? { fixedVersion } : {}), ...(cve ? { cve } : {}), message }));
  const stale = (evidence.commands ?? []).filter((command) => command.database?.stale).map((command) => command.id);
  if (evidence.outcome === 'passed' && !unavailable.length && !existing && !held.length && !stale.length) return null;
  const parts = [];
  // A vulnerable package this Story added or upgraded is a person's, never the loop's [CQF:REQ-050].
  if (held.length) {
    parts.push(`${evidence.counts?.dependenciesHeld ?? held.length} known vulnerabilit${held.length === 1 ? 'y' : 'ies'} in packages this Story added or upgraded `
      + `${held.length === 1 ? 'holds' : 'hold'} the step's approval until upgraded or accepted by a person (${held.slice(0, 3).map((finding) => `${finding.package}${finding.installedVersion ? `@${finding.installedVersion}` : ''} ${finding.rule ?? ''}`.trim()).join('; ')})`);
  }
  if (stale.length) parts.push(`the advisory database of ${stale.join(', ')} is more than 7 days old`);
  if (remaining.length) {
    parts.push(`${evidence.counts?.counted ?? remaining.length} finding(s) on changed lines remain after ${evidence.attempt ?? '?'} attempt(s)`
      + ` and go to the step's approvers (${remaining.slice(0, 3).map((finding) => `${finding.rule ?? finding.tool} at ${finding.file ?? '?'}:${finding.line ?? '?'}`).join('; ')})`);
  }
  if (unavailable.length) parts.push(`scanner${unavailable.length === 1 ? '' : 's'} ${unavailable.join(', ')} could not run and blocked nothing`);
  // Findings on lines this Story did not change are shown, and count for nothing [CQF:REQ-042].
  if (existing) parts.push(`${existing} existing finding(s) on lines this Story did not change count for nothing`);
  return { mode: evidence.mode, outcome: evidence.outcome, attempt: evidence.attempt ?? null,
    counts: { counted: evidence.counts?.counted ?? 0, newCode: evidence.counts?.newCode ?? 0, existing: evidence.counts?.existing ?? 0 },
    remaining, unavailable, ...(held.length ? { held } : {}), words: `${parts.join('; ')}.` };
}
