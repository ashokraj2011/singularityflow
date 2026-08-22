const BLOCKING = new Set(['missing', 'partial']);

export function blockingConformanceVerdicts(markdown) {
  const findings = [];
  for (const line of String(markdown ?? '').split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', ''));
    if (cells.length < 5) continue;
    const clauseId = cells[0];
    const verdict = cells[4].toLowerCase();
    if (!BLOCKING.has(verdict)) continue;
    findings.push({ clauseId, verdict });
  }
  return findings;
}
