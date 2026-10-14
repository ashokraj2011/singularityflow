function posix(filePath) {
  return filePath ? String(filePath).replace(/\\/gu, '/').replace(/^\.\//u, '') : null;
}

const PRIORITY_RANK = Object.freeze({
  P0: 0,
  P1: 1,
  P2: 2
});

function normalizeCategory(rawCategory = '', code = '') {
  if (code.includes('CORNER_CASE') || code.includes('corner-case')) return 'corner-case-obligations';
  if (code.includes('ASSERTION') || code.includes('assertion') || rawCategory === 'verification-contracts') {
    return 'verification-contracts';
  }
  if (rawCategory === 'traceability' || code.includes('TRACEABILITY')) return 'traceability';
  if (rawCategory === 'coverage' || code.includes('coverage') || code.includes('unclaimed')) return 'coverage';
  if (rawCategory === 'documentation' || code.includes('documentation')) return 'documentation';
  return rawCategory || 'governance';
}

function stepDedupeKey(step) {
  return [
    step.priority,
    step.category,
    step.code ?? '',
    step.path ?? '',
    step.line ?? '',
    step.symbol ?? ''
  ].join('::');
}

function compareSteps(a, b) {
  const rankDiff = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  if (rankDiff !== 0) return rankDiff;
  const pathA = a.path ?? '';
  const pathB = b.path ?? '';
  if (pathA !== pathB) return pathA.localeCompare(pathB);
  const lineA = a.line ?? 0;
  const lineB = b.line ?? 0;
  if (lineA !== lineB) return lineA - lineB;
  return String(a.code ?? '').localeCompare(String(b.code ?? ''));
}

function renderMarkdownSummary({ status, counts, steps, harness }) {
  if (steps.length === 0) {
    return '### Governance Remediation Plan\n\nAll verification contracts, corner-case obligations, and documentation checks are satisfied.';
  }
  const lines = [
    '### Governance Remediation Plan',
    '',
    `- **Status:** \`${status}\` (${counts.blocking} blocking P0, ${counts.p1} assurance P1, ${counts.p2} hygiene P2)`,
    ''
  ];

  for (const step of steps) {
    const loc = step.path ? ` (\`${step.path}${step.line ? `:${step.line}` : ''}\`)` : '';
    const target = step.suggestedTestPath ? ` -> target test: \`${step.suggestedTestPath}\`` : '';
    lines.push(`- **[${step.priority}] \`${step.code}\`**${loc}: ${step.message}${target}`);
  }

  if (harness?.scaffolds?.length) {
    lines.push('', '#### Synthesized Corner-Case Test Scaffolds', '');
    for (const scaffold of harness.scaffolds.slice(0, 3)) {
      lines.push(
        `Target: \`${scaffold.targetTestPath}\` (for \`${scaffold.symbol}\` in \`${scaffold.sourcePath}:${scaffold.line}\`)`,
        '```js',
        scaffold.code,
        '```',
        ''
      );
    }
  }

  return lines.join('\n').trim();
}

/**
 * Consolidate blocking findings, corner-case obligations, test assertion adequacy, unclaimed
 * path advisories, and code documentation advisories into a single prioritized remediation plan.
 */
export function buildGovernanceRemediationPlan({
  findings = [],
  advisories = [],
  cornerCases = null,
  documentation = null
} = {}) {
  const harness = cornerCases?.harness ?? null;
  const scaffoldsBySourceSymbol = new Map();
  for (const scaffold of harness?.scaffolds ?? []) {
    scaffoldsBySourceSymbol.set(`${scaffold.sourcePath}::${scaffold.symbol}`, scaffold);
  }
  const repairsByTestLine = new Map();
  for (const repair of harness?.inadequateTestRepairs ?? []) {
    repairsByTestLine.set(`${repair.targetTestPath}::${repair.line}`, repair);
  }

  const rawSteps = [];

  for (const finding of findings) {
    const filePath = posix(finding.path ?? finding.sourcePath ?? null);
    const symbol = finding.symbol ?? finding.value ?? null;
    const category = normalizeCategory(finding.category, finding.code ?? '');
    const scaffold = filePath && symbol
      ? scaffoldsBySourceSymbol.get(`${filePath}::${symbol}`) ?? null
      : null;
    const repair = filePath && finding.line
      ? repairsByTestLine.get(`${filePath}::${finding.line}`) ?? null
      : null;

    rawSteps.push({
      priority: 'P0',
      blocking: true,
      category,
      code: finding.code ?? 'GOVERNANCE_FINDING',
      path: filePath,
      line: finding.line ?? null,
      symbol,
      message: finding.message ?? 'Resolve blocking finding before publication.',
      suggestedTestPath: scaffold?.targetTestPath ?? repair?.targetTestPath ?? null,
      testScaffold: scaffold?.code ?? repair?.code ?? null
    });
  }

  if (cornerCases && !cornerCases.blocking) {
    for (const uncovered of cornerCases.uncoveredObligations ?? []) {
      const filePath = posix(uncovered.sourcePath);
      const scaffold = scaffoldsBySourceSymbol.get(`${filePath}::${uncovered.symbol}`) ?? null;
      rawSteps.push({
        priority: 'P1',
        blocking: false,
        category: 'corner-case-obligations',
        code: 'code.verification.corner-case-uncovered',
        path: filePath,
        line: uncovered.line ?? null,
        symbol: uncovered.symbol ?? null,
        message: `Uncovered ${uncovered.category} in ${uncovered.symbol} at ${filePath}:${uncovered.line} (${uncovered.construct}); add ${uncovered.requiredSignal} test assertion.`,
        suggestedTestPath: scaffold?.targetTestPath ?? null,
        testScaffold: scaffold?.code ?? null
      });
    }

    for (const decl of cornerCases.inadequateDeclarations ?? []) {
      const filePath = posix(decl.sourcePath);
      const repair = repairsByTestLine.get(`${filePath}::${decl.line ?? 1}`) ?? null;
      const isTautological = decl.adequacy === 'tautological';
      rawSteps.push({
        priority: 'P1',
        blocking: false,
        category: 'verification-contracts',
        code: isTautological ? 'code.verification.tautological-assertion' : 'code.verification.missing-assertion',
        path: filePath,
        line: decl.line ?? null,
        symbol: decl.name ?? null,
        message: isTautological
          ? `Test '${decl.name}' in ${filePath}:${decl.line ?? 1} contains only tautological literal assertions.`
          : `Test '${decl.name}' in ${filePath}:${decl.line ?? 1} contains no executable assertions.`,
        suggestedTestPath: filePath,
        testScaffold: repair?.code ?? null
      });
    }
  }

  for (const advisory of advisories) {
    const code = advisory.code ?? 'code.advisory';
    const category = normalizeCategory(advisory.category, code);
    const isDoc = category === 'documentation' || code === 'code.documentation.missing';
    const priority = isDoc ? 'P2' : 'P1';
    rawSteps.push({
      priority,
      blocking: false,
      category,
      code,
      path: posix(advisory.path ?? null),
      line: advisory.line ?? null,
      symbol: advisory.value ?? null,
      message: advisory.message ?? (isDoc && documentation?.guidance ? documentation.guidance : 'Address advisory item.'),
      suggestedTestPath: null,
      testScaffold: null
    });
  }

  const seen = new Set();
  const steps = [];
  for (const step of rawSteps) {
    const key = stepDedupeKey(step);
    if (seen.has(key)) continue;
    seen.add(key);
    steps.push(Object.freeze(step));
  }
  steps.sort(compareSteps);

  const p0 = steps.filter((step) => step.priority === 'P0').length;
  const p1 = steps.filter((step) => step.priority === 'P1').length;
  const p2 = steps.filter((step) => step.priority === 'P2').length;

  const byCategory = {};
  for (const step of steps) {
    byCategory[step.category] = (byCategory[step.category] ?? 0) + 1;
  }

  const status = p0 > 0
    ? 'action-required'
    : steps.length > 0
      ? 'advisory-only'
      : 'clean';

  const counts = Object.freeze({
    total: steps.length,
    blocking: p0,
    p0,
    p1,
    p2,
    cornerCaseScaffolds: harness?.scaffolds?.length ?? 0
  });

  return Object.freeze({
    schemaVersion: 1,
    status,
    counts,
    byCategory: Object.freeze(byCategory),
    steps: Object.freeze(steps),
    harness: harness ?? null,
    markdownSummary: renderMarkdownSummary({ status, counts, steps, harness })
  });
}
