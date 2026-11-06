/** Bounded, content-safe diagnostics for a refused required test execution. */
import { redactDiagnosticText } from './git-remote-diagnostics.mjs';

const MAX_TEXT = 2000;
const MAX_ARGV = 128;
const MAX_FAILED_TESTCASES = 12;
const TEST_ERROR = /^CODE_TEST_[A-Z0-9_]+$/u;
const SHA256 = /^(?:sha256:)?[0-9a-f]{64}$/u;

const FAILURE_GUIDANCE = Object.freeze({
  'missing-launcher': {
    guidance: 'Restore the approved test executable or its launcher on this machine, then inspect the same phase again.',
    retryCondition: 'runtime-changed'
  },
  'missing-dependency': {
    guidance: 'Install the repository-declared test dependencies with its approved package manager; inspect the test environment before retrying.',
    retryCondition: 'runtime-changed'
  },
  timeout: {
    guidance: 'Inspect the test process and its dependencies. Retry only after the cause of the timeout changes.',
    retryCondition: 'runtime-changed'
  },
  'source-mutation': {
    guidance: 'Review the exact source or test changes made by the command and the current phase scope before another publication attempt.',
    retryCondition: 'source-reviewed'
  },
  'failed-tests': {
    guidance: 'Repair the reported failing tests or implementation in the phase, then run the tests again.',
    retryCondition: 'test-failure-repaired'
  },
  'process-failed-with-passing-report': {
    guidance: 'The report says tests passed but the test process failed. Inspect the remaining command stages and their output.',
    retryCondition: 'diagnostic-reviewed'
  },
  // Every discovered test was skipped: no test executed. A skip is the suite's own decision, usually
  // because a service it needs is missing here; it is an environment cause and never a pass.
  'all-tests-skipped': {
    guidance: 'Every discovered test was skipped, so no test executed; this is usually the environment (a Docker daemon, database or service the tests need is missing here). A skipped test is not a pass: provide what the tests need and run them again, or a person who approves the step can accept the test-run risk.',
    retryCondition: 'runtime-changed'
  },
  // Model-free runs do not start a command whose external-model behavior is undeclared.
  'model-policy-skipped': {
    guidance: 'The test command was not run because it declares no modelPolicy and models are disabled for this run. Rerun with the model enabled, or have configuration declare modelPolicy: never for the command (then adopt it with story test-policy amend).',
    retryCondition: 'runtime-changed'
  },
  // A test file failed outside its tests, so the counts alone look like a pass.
  'suite-failed': {
    guidance: 'A test file failed outside its tests, usually while loading, so the run failed whatever the counted tests did. Read the example: fix the file, or, if this runner collected a file written for another runner (a Playwright spec under Vitest or Jest), keep it out of this runner\'s reach.',
    retryCondition: 'test-failure-repaired'
  },
  // The report was read and counts nothing: the fault is what ran, not the reporter.
  'no-tests': {
    guidance: 'The report counts zero tests, so no test ran. Read the output: the run stopped before collecting any, or the command looks where there are no tests. A run with no tests is never a pass.',
    retryCondition: 'diagnostic-reviewed'
  },
  'invalid-or-missing-report': {
    guidance: 'Repair the repository-owned test reporter or result path; the process exit alone is not passing test evidence.',
    retryCondition: 'report-repaired'
  },
  generic: {
    guidance: 'Inspect the bounded test output and report before repairing the cause. Do not repeat the same failing command unchanged.',
    retryCondition: 'diagnostic-reviewed'
  }
});

function boundedText(value, max = MAX_TEXT) {
  const redacted = redactDiagnosticText(String(value ?? ''));
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}…[truncated]`;
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}

function safeStatus(value, accepted) {
  return typeof value === 'string' && accepted.has(value) ? value : null;
}

function boundedTestcaseName(value) {
  // Pytest and similar runners use "suite::case". The remote-URL redactor intentionally rejects
  // arbitrary "scheme::..." strings, so redact each bounded testcase component independently.
  const parts = value.slice(0, 2_000).split('::').slice(0, 16);
  const redacted = parts.map((part) => boundedText(part, 240)).join('::');
  return redacted.length <= 240 ? redacted : `${redacted.slice(0, 240)}…[truncated]`;
}

function projectedReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const status = safeStatus(value.status, new Set(['observed', 'unavailable']));
  if (!status) return null;
  const tests = value.tests && typeof value.tests === 'object' && !Array.isArray(value.tests)
    ? Object.fromEntries(['discovered', 'passed', 'failed', 'skipped']
      .map((key) => [key, safeCount(value.tests[key])])) : null;
  const cases = Array.isArray(value.failedTestcases)
    ? value.failedTestcases.slice(0, MAX_FAILED_TESTCASES).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || typeof entry.name !== 'string') return [];
      const testcaseStatus = safeStatus(entry.status, new Set(['failed', 'error', 'skipped']));
      return testcaseStatus ? [{ name: boundedTestcaseName(entry.name), status: testcaseStatus }] : [];
    }) : [];
  return {
    status,
    gateEligible: false,
    tests: status === 'observed' ? tests : null,
    sha256: typeof value.sha256 === 'string' && SHA256.test(value.sha256) ? value.sha256 : null,
    bytes: safeCount(value.bytes),
    failedTestcases: status === 'observed' ? cases : [],
    ...(status === 'observed' && safeCount(value.failedSuites) > 0 ? { failedSuites: value.failedSuites } : {}),
    ...(status === 'observed' && Array.isArray(value.failureExamples) ? { failureExamples: [...new Set(value.failureExamples
      .filter(entry => typeof entry === 'string').map(entry => boundedText(entry, 600)))].slice(0, 3) } : {}),
    reason: status === 'unavailable' && value.reason != null
      ? boundedText(value.reason, 320) : null
  };
}

function failureOf(kind) {
  return { kind, ...FAILURE_GUIDANCE[kind] };
}

/** Classify an execution without converting an observed report into gate evidence. */
export function classifyRequiredTestFailure(errorCode, check = null, report = null) {
  const code = String(errorCode ?? '');
  const observed = report?.status === 'observed' && report?.tests
    && typeof report.tests === 'object';
  const failed = observed ? safeCount(report.tests.failed) : null;
  const discovered = observed ? safeCount(report.tests.discovered) : null;
  const passed = observed ? safeCount(report.tests.passed) : null;
  const output = `${String(check?.stderr ?? '')}\n${String(check?.stdout ?? '')}\n${String(report?.reason ?? '')}`
    .slice(0, 16_000);
  const processFailed = check?.status === 'failed' || check?.status === 'blocked'
    || Number.isInteger(check?.exitCode) && check.exitCode !== 0;
  if (code === 'QUALITY_COMMAND_SOURCE_MUTATION') return failureOf('source-mutation');
  if (check?.status === 'skipped-warning' && check?.externalModelPolicy !== 'never') return failureOf('model-policy-skipped');
  if (check?.timedOut === true || code === 'CODE_TEST_TIMEOUT'
      || check?.status === 'blocked' && /command exceeded its \d+ms timeout|timed? out/iu.test(output)) {
    return failureOf('timeout');
  }
  if (check?.launchErrorCode === 'ENOENT' || check?.spawnErrorCode === 'ENOENT'
      || check?.error?.code === 'ENOENT'
      || check?.status === 'blocked' && /unable to run quality command:.*\bENOENT\b/iu.test(output)) {
    return failureOf('missing-launcher');
  }
  if (failed != null && failed > 0) return failureOf('failed-tests');
  if (/\bNo module named pytest\b|\bCannot find module ['"](?:jest|vitest|playwright|@playwright\/test)['"]|\b(?:jest|vitest|pytest|mvn|gradle): (?:command )?not found\b|\bCould not resolve dependencies\b|\bERR_MODULE_NOT_FOUND\b/iu.test(output)) {
    return failureOf('missing-dependency');
  }
  if (observed && !processFailed && failed === 0 && passed === 0 && discovered > 0
      && safeCount(report.tests.skipped) === discovered) {
    return failureOf('all-tests-skipped');
  }
  if (observed && safeCount(report.failedSuites) > 0) return failureOf('suite-failed');
  if (observed && discovered === 0 && failed === 0) return failureOf('no-tests');
  if (observed && failed === 0 && !(discovered > 0 && passed > 0)) {
    return failureOf('invalid-or-missing-report');
  }
  if (observed && failed === 0 && processFailed) {
    return failureOf('process-failed-with-passing-report');
  }
  if (code === 'CODE_TEST_RESULT_REQUIRED' || code === 'CODE_TEST_ZERO_DISCOVERED'
      || !processFailed && report?.status === 'unavailable') {
    return failureOf('invalid-or-missing-report');
  }
  return failureOf('generic');
}

/** The same allowlisted projection is used for CLI refusals and machine-local logs. */
export function requiredTestExecutionForRefusal(error) {
  if (!TEST_ERROR.test(String(error?.code ?? ''))
      && error?.code !== 'QUALITY_COMMAND_SOURCE_MUTATION') return null;
  const execution = error?.details?.requiredTestExecution;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)
      || typeof execution.commandId !== 'string'
      || typeof execution.cwd !== 'string'
      || typeof execution.resultPath !== 'string') return null;
  // Only an approved configured command's argv is withheld (it may carry secrets); others are shown.
  const inferred = execution.provenance !== 'configured';
  if (inferred && !Array.isArray(execution.argv)) return null;
  let argvRedacted = false;
  const argv = (inferred ? execution.argv : []).slice(0, MAX_ARGV).map((argument, index) => {
    const previous = String(execution.argv[index - 1] ?? '');
    if (/^--?(?:password|passwd|token|secret|api[-_]?key|access[-_]?key|authorization|credential)$/iu.test(previous)) {
      argvRedacted = true;
      return '[REDACTED]';
    }
    const raw = String(argument);
    const safe = boundedText(raw);
    if (safe !== raw) argvRedacted = true;
    return safe;
  });
  const stream = (name) => ({
    text: boundedText(execution[name]?.text),
    bytes: safeCount(execution[name]?.bytes) ?? Buffer.byteLength(String(execution[name]?.text ?? '')),
    truncated: execution[name]?.truncated === true
      || String(execution[name]?.text ?? '').length > MAX_TEXT
  });
  const rawFailure = execution.failure;
  const failure = rawFailure && typeof rawFailure === 'object'
    && Object.hasOwn(FAILURE_GUIDANCE, rawFailure.kind)
    ? failureOf(rawFailure.kind) : null;
  const report = projectedReport(execution.report);
  return {
    commandId: boundedText(execution.commandId),
    ...(execution.hostRuntime && typeof execution.hostRuntime === 'object' ? { hostRuntime: {
      node: boundedText(execution.hostRuntime.node, 64), platform: boundedText(execution.hostRuntime.platform, 32), arch: boundedText(execution.hostRuntime.arch, 32)
    } } : {}),
    argv: inferred ? argv : null,
    argvWithheld: !inferred,
    argvRedacted,
    argvTruncated: inferred && execution.argv.length > MAX_ARGV,
    provenance: inferred ? 'inferred' : 'configured',
    cwd: boundedText(execution.cwd),
    workingDirectory: boundedText(execution.workingDirectory),
    exitCode: Number.isInteger(execution.exitCode) ? execution.exitCode : null,
    status: boundedText(execution.status),
    resultPath: boundedText(execution.resultPath),
    configuredResultPath: boundedText(execution.configuredResultPath),
    resultAdapter: boundedText(execution.resultAdapter),
    stdout: stream('stdout'),
    stderr: stream('stderr'),
    ...(failure ? { failure } : {}),
    ...(report ? { report } : {})
  };
}

/** Bounded examples from this invocation's parsed report, before transient reports are restored. */
export async function requiredTestFailureExamples(parsed, adapter) {
  const { failedSuiteMessages, testCaseMessages } = await import('./test-case-messages.mjs');
  const occurrences = parsed.testcaseObservation?.occurrences ?? [];
  const contents = (parsed.rawReports ?? []).map(entry => entry.contents);
  const messages = testCaseMessages(adapter, contents, occurrences.length);
  const examples = new Set();
  for (const suite of failedSuiteMessages(adapter, contents).slice(0, 3)) {
    if (suite.message) examples.add(boundedText(`${suite.name.split(/[\\/]/u).at(-1)}: ${suite.message}`, 600));
  }
  for (let index = 0; index < occurrences.length && examples.size < 3; index += 1) {
    if (occurrences[index].outcome === 'failed' && messages?.[index]) examples.add(boundedText(messages[index], 600));
  }
  return [...examples];
}
