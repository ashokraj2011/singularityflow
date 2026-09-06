/** Strict, content-free evidence contract for the WEL release benchmark. */
import { createHash } from 'node:crypto';

import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const WEL_BENCHMARK_SCHEMA = 'sflow-wel-benchmark/v5';
export const WEL_BENCHMARK_ASSURANCE = 'content-free-local-measurement';

export const WEL_BENCHMARK_CAPABILITIES = Object.freeze([
  'source-catalog', 'report-ingestion', 'receipt-projection', 'durable-storage-estimate',
  'baseline-comparison', 'context-xray-projection', 'story-start-latency',
  'story-push-recovery', 'story-offline-recovery', 'fresh-clone-verification',
  'interrupted-write-recovery', 'adapter-cancellation'
]);

export const WEL_BENCHMARK_EXCLUDED_CONTENT = Object.freeze([
  'repository-path', 'origin-url', 'work-id', 'git-identity', 'clause-text', 'test-body'
]);

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{2,127}$/;
const SAFE_ARCHITECTURE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const MAX_REPORT_BYTES = 128 * 1024;
const MAX_DURATION_MILLISECONDS = 60 * 60 * 1_000;
const MAX_MEASURED_BYTES = 1024 * 1024 * 1024;

const INTERPRETATIONS = Object.freeze({
  storyTimingInterpretation: 'synthetic local Story-start transaction including its governed local commits; configuration authority uses a local bare remote and application push is disabled',
  storyRecoveryInterpretation: 'synthetic local post-preflight transport loss followed by the public exact pending-publication sync path; this is not office-network evidence',
  storyOfflineRecoveryInterpretation: 'synthetic local authority loss after publication preflight, exact public sync recovery, and clean fresh-clone verification; this is not office-network evidence',
  interruptedWriteInterpretation: 'synthetic abrupt process exit after state write and before ref advancement, recovered through the public sync surface',
  adapterCancellationInterpretation: 'pre-cancelled exact-static observation returns unavailable evidence and creates no mapping proposal',
  timingInterpretation: 'paired local observation; signed deltas may be negative from timer noise and are not an enforced budget'
});

const TOP_LEVEL_KEYS = Object.freeze([
  'adapterCancellation', 'adapterCancellationInterpretation', 'architecture', 'assurance',
  'baselineReceiptBytes', 'baselineReceiptProjectionMilliseconds', 'catalogBytes',
  'completedSamples', 'contentExcluded', 'contextXrayBytes',
  'contextXrayProjectionMilliseconds', 'cpuMilliseconds', 'estimatedDurableBytesPerExecution',
  'estimatedDurableIncrementalBytesPerExecution', 'fixtureOutcomes',
  'incrementalReceiptBytes', 'incrementalReceiptProjectionMilliseconds',
  'interruptedWriteInterpretation', 'interruptedWriteRecovery', 'measurementCapabilities',
  'nodeMajor', 'outcome', 'parserMilliseconds', 'platform', 'rawReportBytes',
  'receiptBytes', 'receiptProjectionMilliseconds', 'reportIngestionMilliseconds',
  'requestedSamples', 'schema', 'storyOfflineRecovery', 'storyOfflineRecoveryInterpretation',
  'storyPushRecovery', 'storyRecoveryInterpretation', 'storyStartCompletedSamples',
  'storyStartMilliseconds', 'storyStartMode', 'storyStartRequestedSamples',
  'storyTimingInterpretation', 'storyWorkflowBytes', 'timingInterpretation', 'unavailableCode'
]);

function exactKeys(value, keys) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort());
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function boundedNumber(value, minimum = 0, maximum = MAX_DURATION_MILLISECONDS) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function timingFailures(value, label, { allowNegative = false } = {}) {
  const failures = [];
  const keys = ['maximum', 'median', 'minimum', 'p95'];
  if (!exactKeys(value, keys)) return [`${label} fields are invalid`];
  const minimum = allowNegative ? -MAX_DURATION_MILLISECONDS : 0;
  for (const key of keys) {
    if (!boundedNumber(value[key], minimum)) failures.push(`${label}.${key} is invalid`);
  }
  if (!failures.length
      && !(value.minimum <= value.median && value.median <= value.p95 && value.p95 <= value.maximum)) {
    failures.push(`${label} percentile order is invalid`);
  }
  return failures;
}

function recoveryFailures(report) {
  const failures = [];
  const push = report.storyPushRecovery;
  if (!exactKeys(push, [
    'exactRetainedCommitPublished', 'failureCode', 'failureMilliseconds', 'outcome',
    'recoveryMilliseconds'
  ])) failures.push('storyPushRecovery fields are invalid');
  else if (push.outcome !== 'recovered' || push.exactRetainedCommitPublished !== true
      || !SAFE_CODE.test(String(push.failureCode ?? ''))
      || !boundedNumber(push.failureMilliseconds) || !boundedNumber(push.recoveryMilliseconds)) {
    failures.push('storyPushRecovery did not prove bounded exact recovery');
  }

  const offline = report.storyOfflineRecovery;
  if (!exactKeys(offline, [
    'exactRetainedCommitPublished', 'failureCode', 'failureMilliseconds', 'freshCloneClean',
    'freshCloneExact', 'freshCloneMilliseconds', 'outcome', 'recoveryMilliseconds'
  ])) failures.push('storyOfflineRecovery fields are invalid');
  else if (offline.outcome !== 'recovered' || offline.exactRetainedCommitPublished !== true
      || offline.freshCloneExact !== true || offline.freshCloneClean !== true
      || !SAFE_CODE.test(String(offline.failureCode ?? ''))
      || !boundedNumber(offline.failureMilliseconds) || !boundedNumber(offline.recoveryMilliseconds)
      || !boundedNumber(offline.freshCloneMilliseconds)) {
    failures.push('storyOfflineRecovery did not prove bounded exact fresh-clone recovery');
  }

  const interrupted = report.interruptedWriteRecovery;
  if (!exactKeys(interrupted, [
    'exactStableStateRestored', 'failureCode', 'failureMilliseconds', 'outcome',
    'recoveryMilliseconds'
  ])) failures.push('interruptedWriteRecovery fields are invalid');
  else if (interrupted.outcome !== 'recovered' || interrupted.exactStableStateRestored !== true
      || !SAFE_CODE.test(String(interrupted.failureCode ?? ''))
      || !boundedNumber(interrupted.failureMilliseconds)
      || !boundedNumber(interrupted.recoveryMilliseconds)) {
    failures.push('interruptedWriteRecovery did not prove bounded restoration');
  }

  const cancellation = report.adapterCancellation;
  if (!exactKeys(cancellation, ['exact', 'mappingProposals', 'milliseconds', 'outcome'])) {
    failures.push('adapterCancellation fields are invalid');
  } else if (cancellation.outcome !== 'cancelled-safe' || cancellation.exact !== false
      || cancellation.mappingProposals !== 0 || !boundedNumber(cancellation.milliseconds)) {
    failures.push('adapterCancellation did not prove a safe closed outcome');
  }
  return failures;
}

function collectFailures(report, { platform = null, nodeMajor = null, requireObserved = true } = {}) {
  const failures = [];
  if (!exactKeys(report, TOP_LEVEL_KEYS)) failures.push('WEL benchmark fields are invalid');
  if (report?.schema !== WEL_BENCHMARK_SCHEMA) failures.push(`schema must be ${WEL_BENCHMARK_SCHEMA}`);
  if (report?.assurance !== WEL_BENCHMARK_ASSURANCE) failures.push('assurance is invalid');
  if (!PLATFORMS.has(report?.platform)) failures.push('platform is unsupported');
  if (platform != null && report?.platform !== platform) failures.push('platform does not match the verified host');
  if (!SAFE_ARCHITECTURE.test(String(report?.architecture ?? ''))) failures.push('architecture is invalid');
  if (!boundedInteger(report?.nodeMajor, 20, 99)) failures.push('nodeMajor is invalid');
  if (nodeMajor != null && report?.nodeMajor !== nodeMajor) failures.push('nodeMajor does not match the verified host');
  if (!boundedInteger(report?.requestedSamples, 1, 100)) failures.push('requestedSamples is invalid');
  if (!boundedInteger(report?.completedSamples, 0, report?.requestedSamples ?? 0)) failures.push('completedSamples is invalid');
  if (!boundedInteger(report?.storyStartRequestedSamples, 1, 30)) failures.push('storyStartRequestedSamples is invalid');
  if (report?.storyStartCompletedSamples !== report?.storyStartRequestedSamples) failures.push('Story-start samples are incomplete');
  if (report?.storyStartMode !== 'governed-local-publication-push-off') failures.push('storyStartMode is invalid');

  if (!['observed', 'unavailable'].includes(report?.outcome)) failures.push('outcome is invalid');
  if (requireObserved && report?.outcome !== 'observed') failures.push('release evidence requires an observed WEL benchmark');
  if (report?.outcome === 'observed') {
    if (report.completedSamples !== report.requestedSamples || report.unavailableCode !== null) {
      failures.push('observed benchmark samples are incomplete');
    }
    for (const [field, label] of [
      ['parserMilliseconds', 'parserMilliseconds'],
      ['reportIngestionMilliseconds', 'reportIngestionMilliseconds'],
      ['receiptProjectionMilliseconds', 'receiptProjectionMilliseconds'],
      ['baselineReceiptProjectionMilliseconds', 'baselineReceiptProjectionMilliseconds']
    ]) failures.push(...timingFailures(report[field], label));
    if (!exactKeys(report.incrementalReceiptProjectionMilliseconds,
      ['maximum', 'median', 'method', 'minimum', 'p95'])) {
      failures.push('incrementalReceiptProjectionMilliseconds fields are invalid');
    } else {
      failures.push(...timingFailures({
        minimum: report.incrementalReceiptProjectionMilliseconds.minimum,
        median: report.incrementalReceiptProjectionMilliseconds.median,
        p95: report.incrementalReceiptProjectionMilliseconds.p95,
        maximum: report.incrementalReceiptProjectionMilliseconds.maximum
      }, 'incrementalReceiptProjectionMilliseconds', { allowNegative: true }));
      if (report.incrementalReceiptProjectionMilliseconds.method !== 'witnessed-minus-unenrolled-same-process') {
        failures.push('incrementalReceiptProjectionMilliseconds.method is invalid');
      }
    }
    if (!exactKeys(report.cpuMilliseconds, ['median', 'p95'])
        || !boundedNumber(report.cpuMilliseconds?.median)
        || !boundedNumber(report.cpuMilliseconds?.p95)
        || report.cpuMilliseconds.median > report.cpuMilliseconds.p95) {
      failures.push('cpuMilliseconds is invalid');
    }
  } else if (report?.outcome === 'unavailable') {
    if (report.completedSamples !== 0 || !SAFE_CODE.test(String(report.unavailableCode ?? ''))) {
      failures.push('unavailable benchmark classification is invalid');
    }
    for (const field of [
      'parserMilliseconds', 'reportIngestionMilliseconds', 'receiptProjectionMilliseconds',
      'baselineReceiptProjectionMilliseconds', 'incrementalReceiptProjectionMilliseconds',
      'cpuMilliseconds'
    ]) if (report[field] !== null) failures.push(`${field} must be null when unavailable`);
  }

  failures.push(...timingFailures(report?.contextXrayProjectionMilliseconds,
    'contextXrayProjectionMilliseconds'));
  failures.push(...timingFailures(report?.storyStartMilliseconds, 'storyStartMilliseconds'));
  failures.push(...recoveryFailures(report ?? {}));

  const fixture = report?.fixtureOutcomes;
  if (!exactKeys(fixture, ['cases', 'exactStatic', 'falseExact', 'inexact'])
      || fixture?.cases !== 1 || fixture?.falseExact !== 0
      || fixture?.exactStatic !== (report?.outcome === 'observed' ? 1 : 0)
      || fixture?.inexact !== (report?.outcome === 'observed' ? 0 : 1)) {
    failures.push('fixtureOutcomes is invalid');
  }

  for (const field of [
    'catalogBytes', 'baselineReceiptBytes', 'receiptBytes', 'incrementalReceiptBytes',
    'contextXrayBytes', 'storyWorkflowBytes', 'rawReportBytes',
    'estimatedDurableBytesPerExecution', 'estimatedDurableIncrementalBytesPerExecution'
  ]) {
    if (!boundedInteger(report?.[field], 0, MAX_MEASURED_BYTES)) failures.push(`${field} is invalid`);
  }
  if (canonicalJson(report?.measurementCapabilities) !== canonicalJson(WEL_BENCHMARK_CAPABILITIES)) {
    failures.push('measurementCapabilities are invalid');
  }
  if (canonicalJson(report?.contentExcluded) !== canonicalJson(WEL_BENCHMARK_EXCLUDED_CONTENT)) {
    failures.push('contentExcluded is invalid');
  }
  for (const [field, expected] of Object.entries(INTERPRETATIONS)) {
    if (report?.[field] !== expected) failures.push(`${field} is invalid`);
  }
  try {
    if (Buffer.byteLength(canonicalJson(report), 'utf8') > MAX_REPORT_BYTES) failures.push('report exceeds its byte limit');
  } catch {
    failures.push('report is not canonical JSON');
  }
  return failures;
}

/** Validate and hash the exact content-free WEL benchmark report retained by release evidence. */
export function validateWelBenchmarkEvidence(report, expected = {}) {
  const failures = collectFailures(report, expected);
  if (failures.length) {
    throw new SingularityFlowError(`WEL benchmark evidence is invalid: ${failures.join('; ')}.`, {
      code: 'WEL_BENCHMARK_EVIDENCE_INVALID', details: { failures }
    });
  }
  const evidence = structuredClone(report);
  return {
    evidence,
    evidenceSha256: `sha256:${createHash('sha256').update(canonicalJson(evidence)).digest('hex')}`
  };
}

export function isWelBenchmarkEvidenceSha256(value) {
  return SHA256.test(String(value ?? ''));
}
