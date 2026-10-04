/**
 * Join one exact test declaration to the occurrences of one test run [E2G-016].
 *
 * Pure. A declaration passes only through exactly one occurrence of its own identity (or, for a
 * parameterized declaration, exactly its statically known set of instances, every one passing).
 * An unrelated passing test in the same module, file or run never stands in for it. The outcome is
 * one closed word, from the strongest blocker down: inconclusive (the declaration itself cannot be
 * pinned down), missing, ambiguous, failed, unverified-skipped, flaky, passed.
 */

export const WITNESS_OUTCOMES = Object.freeze([
  'inconclusive', 'missing', 'ambiguous', 'failed', 'unverified-skipped', 'flaky', 'passed'
]);

/** Gap codes that describe a declaration without making its identity unknowable. */
const NON_BLOCKING_GAPS = new Set([]);

function sameList(left = [], right = []) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fileMatches(occurrenceFile, sourcePath) {
  if (!occurrenceFile) return null;
  const file = String(occurrenceFile).replaceAll('\\', '/');
  return file === sourcePath || file.endsWith(`/${sourcePath}`);
}

function blockingGaps(declaration) {
  return (declaration.gaps ?? []).filter((entry) => !NON_BLOCKING_GAPS.has(entry.code));
}

function candidateOccurrences(declaration, occurrences, language) {
  if (language === 'java') {
    const className = declaration.className ?? `${declaration.packageName}.${declaration.classPath.join('$')}`;
    const inClass = occurrences.filter((occurrence) => occurrence.className === className);
    if (declaration.parameters) {
      const method = declaration.methodName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const instance = new RegExp(`^${method}(?:\\(.*\\))?\\[\\d+\\]$`, 'u');
      return inClass.filter((occurrence) => instance.test(occurrence.name ?? ''));
    }
    return inClass.filter((occurrence) => occurrence.name === declaration.methodName || occurrence.name === `${declaration.methodName}()`);
  }
  // A persisted attempt names an occurrence's describe path `suitePath`; a fresh parse, `ancestorTitles`.
  const inSuite = occurrences.filter((occurrence) => sameList(occurrence.suitePath ?? occurrence.ancestorTitles ?? [], declaration.suitePath));
  const named = declaration.parameters
    ? (() => {
      if (!declaration.parameters.titlePattern) return [];
      const pattern = new RegExp(declaration.parameters.titlePattern, 'u');
      return inSuite.filter((occurrence) => pattern.test(occurrence.name ?? ''));
    })()
    : inSuite.filter((occurrence) => occurrence.name === declaration.name);
  // A report that names each occurrence's file narrows the match to this declaration's file.
  if (declaration.framework === 'node:test') {
    // Names alone can credit another file; line identity also excludes helper-created tests.
    return named.filter((occurrence) => occurrence.file === declaration.sourcePath
      && occurrence.line === declaration.line);
  }
  if (named.some((occurrence) => fileMatches(occurrence.file, declaration.sourcePath) != null)) {
    return named.filter((occurrence) => fileMatches(occurrence.file, declaration.sourcePath) !== false);
  }
  return named;
}

function outcomeOf(occurrences) {
  if (occurrences.some((occurrence) => occurrence.outcome === 'failed')) return 'failed';
  if (occurrences.some((occurrence) => occurrence.outcome === 'skipped')) return 'unverified-skipped';
  if (occurrences.some((occurrence) => occurrence.flaky === true)) return 'flaky';
  return 'passed';
}

/**
 * The result of one declaration in one run. `run` is the enclosing command's own result: a test
 * that passed inside a run that failed, timed out or was interrupted does not pass.
 */
export function joinDeclaration(declaration, occurrences, { language, runner = null, run = { completed: true, succeeded: true } } = {}) {
  const gaps = blockingGaps(declaration);
  const reasons = gaps.map((entry) => entry.code);
  if (declaration.parameters && language === 'java' && runner === 'gradle') {
    reasons.push('PARAMETERIZED_RUNNER_NAMING_UNSUPPORTED');
  }
  if (reasons.length) return { outcome: 'inconclusive', reasons, occurrences: [] };
  const matched = candidateOccurrences(declaration, occurrences ?? [], language);
  const summary = matched.map((occurrence) => ({
    name: occurrence.name ?? null, outcome: occurrence.outcome, flaky: occurrence.flaky === true
  }));
  if (!matched.length) return { outcome: 'missing', reasons: ['NO_OCCURRENCE'], occurrences: [] };
  if (declaration.parameters) {
    const expected = declaration.parameters.count;
    if (matched.length < expected) return { outcome: 'missing', reasons: ['INSTANCES_MISSING'], expected, occurrences: summary };
    if (matched.length > expected) return { outcome: 'ambiguous', reasons: ['INSTANCES_EXCEED_DECLARATION'], expected, occurrences: summary };
  } else if (matched.length > 1) {
    return { outcome: 'ambiguous', reasons: ['DUPLICATE_OCCURRENCE'], occurrences: summary };
  }
  const outcome = outcomeOf(matched);
  if (outcome === 'passed' || outcome === 'flaky') {
    if (!run.completed) return { outcome: 'inconclusive', reasons: ['RUN_INCOMPLETE'], occurrences: summary };
    if (!run.succeeded) return { outcome: 'failed', reasons: ['RUN_FAILED'], occurrences: summary };
  }
  return { outcome, reasons: [], occurrences: summary, ...(declaration.parameters ? { expected: declaration.parameters.count } : {}) };
}
