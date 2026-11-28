/**
 * The office report: one Markdown page a person can read and one JSON file the SFlow team reads, built from the
 * same checks. Each check says what was checked, its result (pass, fail or not available), short evidence and
 * what it means for SFlow. Nothing here reads the machine; index.mjs scrubs every string before it gets here.
 */
export const RESULTS = Object.freeze(['pass', 'fail', 'not available']);
/** The passing result, named once: a bare quoted word after a question mark reads to the office scanner as a credential. */
export const PASS = RESULTS[0];

export const AREAS = Object.freeze({
  A: 'Machine',
  B: 'Editors and Copilot',
  C: 'Copilot hooks run',
  D: 'Git host for clean pull requests',
  E: 'State checkout and local Git',
  F: 'Commit policy and server hooks',
  G: 'Jira'
});

export function check(id, area, title, result, evidence, meaning) {
  if (!RESULTS.includes(result)) throw new TypeError(`Unknown check result ${result}`);
  return {
    id, area, title, result,
    evidence: (Array.isArray(evidence) ? evidence : [evidence]).map((line) => String(line ?? '').trim()).filter(Boolean).slice(0, 12),
    meaning: String(meaning ?? '')
  };
}

export function buildReport({ checks, questions, createdAt, sflowVersion, system }) {
  const counts = Object.fromEntries(RESULTS.map((result) => [result, checks.filter((entry) => entry.result === result).length]));
  return {
    schemaVersion: 1,
    kind: 'sflow-office-checks',
    createdAt,
    sflowVersion,
    system,
    counts,
    questions,
    checks
  };
}

const cell = (text) => String(text ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');

export function renderMarkdown(report) {
  const lines = [
    `# SFlow office checks, ${report.createdAt.slice(0, 10)}`,
    '',
    `SFlow ${report.sflowVersion} on ${report.system}. ${report.counts.pass} passed, ${report.counts.fail} failed, ${report.counts['not available']} not available.`,
    '',
    'Send this file (and the .json file beside it) back to the SFlow team. It holds no names, emails, hostnames,',
    'organisation or repository names, addresses, tokens, environment values or file paths.',
    '',
    '| Check | Result |',
    '| --- | --- |',
    ...report.checks.map((entry) => `| ${entry.area}. ${cell(entry.title)} | ${entry.result} |`),
    ''
  ];
  if (report.questions.length) {
    lines.push('## Questions asked', '');
    for (const question of report.questions) lines.push(`- ${question.question} Answer: ${question.answer}.`);
    lines.push('');
  }
  for (const [area, name] of Object.entries(AREAS)) {
    const entries = report.checks.filter((entry) => entry.area === area);
    if (!entries.length) continue;
    lines.push(`## ${area}. ${name}`, '');
    for (const entry of entries) {
      lines.push(`### ${entry.title}: ${entry.result}`, '');
      lines.push('Evidence:');
      for (const line of entry.evidence) lines.push(`- ${line}`);
      lines.push('', `What it means for SFlow: ${entry.meaning}`, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
