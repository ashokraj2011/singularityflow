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
    guidance: 'Repair the reported failing tests or implementation in the governed phase, then run the tests again.',
    retryCondition: 'test-failure-repaired'
  },
  'process-failed-with-passing-report': {
    guidance: 'The report says tests passed but the test process failed. Inspect the remaining command stages and their output.',
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
  const inferred = execution.provenance === 'inferred';
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
