/** Deterministic Observation Firewall and disposable raw-observation cache. */
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir, head } from './git.mjs';
import { issueContextExpansionHandle } from './context-handles.mjs';
import { resolveExecutionOutcome } from './execution-outcome.mjs';
import { recordSha256 } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { SECRET_RULES } from './secrets.mjs';
import { SingularityFlowError, writeAtomic } from './util.mjs';
import { repositoryLogger } from './logging.mjs';

const MAX_RAW_BYTES = 8 * 1024 * 1024;
const DEFAULT_INCLUDED_BYTES = 16 * 1024;
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const OBSERVATION_COMPILER_VERSION = '3.0.0';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
// v1 raw observations could be written before redaction. A versioned cache root prevents
// current readers from ever resolving those legacy bytes through a new expansion handle.
function cacheRoot(root) { return path.join(gitCommonDir(root), 'singularity-flow', 'evidence-packets', 'observations', 'v2'); }
function rawFile(root, digest) { return path.join(cacheRoot(root), 'raw', `${digest}.raw`); }
function summaryFile(root, cacheKey) { return path.join(cacheRoot(root), 'summaries', `${cacheKey}.json`); }

function boundedText(value, maximumBytes) {
  const text = String(value ?? '');
  if (Buffer.byteLength(text) <= maximumBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, middle)) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return text.slice(0, low);
}

function lines(raw) { return String(raw).replace(/\r\n?/g, '\n').split('\n'); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }

/** Redact before parsing, hashing, caching, or issuing a raw expansion handle. */
function redactObservation(raw) {
  let text = String(raw ?? '');
  const counts = new Map();
  const privateBlock = /-----BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;
  text = text.replace(privateBlock, () => {
    counts.set('private-key', (counts.get('private-key') ?? 0) + 1);
    return '[redacted-secret:private-key]';
  });
  for (const rule of SECRET_RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    text = text.replace(pattern, (...args) => {
      const whole = args[0];
      const captures = args.slice(1, -2);
      const value = captures.find((entry) => entry != null) ?? whole;
      if (rule.accept && !rule.accept(value)) return whole;
      counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
      return `[redacted-secret:${rule.id}]`;
    });
  }
  return {
    bytes: Buffer.from(text, 'utf8'),
    facts: [...counts].sort(([left], [right]) => left.localeCompare(right))
      .map(([rule, count]) => ({ rule, count })),
    occurrences: [...counts.values()].reduce((total, count) => total + count, 0)
  };
}
function integerMatch(source, patterns) {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return Number(match[1]);
  }
  return null;
}

/** Validate only complete, flat TAP 13 documents. Loose test-like text remains diagnostic. */
function validatedTapProtocol(source) {
  const rows = lines(source).map((row) => row.trim()).filter(Boolean);
  if (rows[0] !== 'TAP version 13') return null;
  const planRows = rows.filter((row) => /^1\.\.\d+(?:\s+#.*)?$/.test(row));
  if (planRows.length !== 1) return null;
  const planned = Number(planRows[0].match(/^1\.\.(\d+)/)[1]);
  const results = rows.flatMap((row) => {
    const match = row.match(/^(not ok|ok)\s+(\d+)\s*(?:-|$)/i);
    return match ? [{ passed: match[1].toLowerCase() === 'ok', number: Number(match[2]) }] : [];
  });
  if (results.length !== planned || results.some((result, index) => result.number !== index + 1)) return null;
  const footerTests = integerMatch(source, [/^# tests\s+(\d+)\s*$/m]);
  const footerPass = integerMatch(source, [/^# pass\s+(\d+)\s*$/m]);
  const footerFail = integerMatch(source, [/^# fail\s+(\d+)\s*$/m]);
  const footerSkipped = integerMatch(source, [/^# skipped\s+(\d+)\s*$/m]) ?? 0;
  const passed = results.filter((result) => result.passed).length;
  const failed = results.length - passed;
  if (footerTests != null && footerTests !== planned) return null;
  if (footerPass != null && footerPass !== passed) return null;
  if (footerFail != null && footerFail !== failed) return null;
  if (footerSkipped > planned || passed + failed !== planned) return null;
  return Object.freeze({
    id: 'tap', version: '13', parserVersion: '1.0.0', complete: true,
    verdict: failed > 0 ? 'failed' : 'passed'
  });
}

function sourceMaterial(kind, content, extra = {}) {
  return { kind, content, material: 'untrusted-source', instructions: 'not-authoritative', ...extra };
}

function testObservation(raw, maximumBytes) {
  const source = String(raw);
  const rows = lines(source);
  const failingNames = unique(rows.flatMap((row) => {
    const node = row.match(/^\s*(?:not ok|✖|×|FAIL)\s+(?:\d+\s+-\s+)?(.+?)\s*$/i);
    return node ? [node[1].trim()] : [];
  })).slice(0, 100);
  const errorRows = unique(rows.filter((row) =>
    /(?:AssertionError|Error:|expected\b|actual\b|ERR_[A-Z0-9_]+|\bat\s+[^\s].*:\d+:\d+)/.test(row)
  ).map((row) => row.trim())).slice(0, 160);
  const assertionDetails = unique(rows.flatMap((row, index) =>
    /(?:AssertionError|expected\b|actual\b|ERR_[A-Z0-9_]+)/i.test(row)
      ? rows.slice(index, index + 8).filter((entry) => entry.trim()).map((entry) => entry.trim()) : []
  )).slice(0, 240);
  const includedText = boundedText([
    ...failingNames.map((name) => `FAIL ${name}`),
    ...assertionDetails,
    ...errorRows
  ].join('\n'), maximumBytes);
  const passed = integerMatch(source, [/^# pass\s+(\d+)\s*$/m, /\b(\d+)\s+passed\b/i]);
  const failed = integerMatch(source, [/^# fail\s+(\d+)\s*$/m, /\b(\d+)\s+failed\b/i]) ?? failingNames.length;
  const skipped = integerMatch(source, [/^# skipped\s+(\d+)\s*$/m, /\b(\d+)\s+skipped\b/i]);
  const tests = integerMatch(source, [/^# tests\s+(\d+)\s*$/m, /\btests?\s*[:=]\s*(\d+)\b/i])
    ?? ([passed, failed, skipped].every((value) => value != null) ? passed + failed + skipped : null);
  const uniqueErrors = unique(errorRows.map((row) => row.replace(/\b\d+(?::\d+)+\b/g, '<location>')));
  return {
    summary: { tests, passed, failed, skipped, uniqueRootErrors: uniqueErrors.length },
    included: includedText ? [sourceMaterial('failure-detail', includedText, { failingTests: failingNames })] : [],
    omitted: { passingTests: passed, repeatedStackFrames: Math.max(0, errorRows.length - uniqueErrors.length) },
    parsed: tests != null || failingNames.length > 0 || errorRows.length > 0,
    protocol: validatedTapProtocol(source)
  };
}

function stackObservation(raw, maximumBytes) {
  const rows = lines(raw);
  const frames = rows.filter((row) => /^\s*(?:at\s+|Caused by:|[A-Za-z_$][\w.$]*(?:Error|Exception):)/.test(row));
  const seen = new Set();
  const retained = [];
  let repeated = 0;
  for (const frame of frames) {
    const normalized = frame.trim().replace(/:\d+(?::\d+)?\)?$/, ':<location>)');
    if (seen.has(normalized)) { repeated += 1; continue; }
    seen.add(normalized);
    retained.push(frame.trim());
  }
  const application = retained.filter((frame) => !/node_modules|node:internal|<anonymous>/.test(frame));
  const selected = unique([...application, ...retained]).slice(0, 200);
  const content = boundedText(selected.join('\n'), maximumBytes);
  return {
    summary: { uniqueFrameSequences: selected.length, applicationFrames: application.length, exceptionCauses: retained.filter((row) => /^Caused by:/.test(row)).length },
    included: content ? [sourceMaterial('unique-stack', content)] : [],
    omitted: { repeatedStackFrames: repeated },
    parsed: frames.length > 0,
    protocol: null
  };
}

function gitObservation(raw, maximumBytes) {
  const rows = lines(raw);
  const changed = [];
  const hunks = [];
  const binary = [];
  const renames = [];
  let current = null;
  let added = 0;
  let removed = 0;
  const changedSymbols = [];
  for (const row of rows) {
    const diff = row.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (diff) { current = diff[2]; changed.push(current); hunks.push(row); continue; }
    const rename = row.match(/^rename (?:from|to) (.+)$/);
    if (rename) { renames.push(row); hunks.push(row); continue; }
    if (/^(?:deleted file mode|new file mode)/.test(row)) { hunks.push(row); continue; }
    if (/^(?:Binary files .* differ|GIT binary patch)/.test(row)) { binary.push(current ?? row); hunks.push(row); continue; }
    if (/^@@/.test(row)) { hunks.push(row); continue; }
    if (/^\+[^+]/.test(row)) {
      added += 1;
      const symbol = row.match(/^\+\s*(?:export\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/);
      if (symbol) changedSymbols.push(symbol[1]);
      hunks.push(row); continue;
    }
    if (/^-[^-]/.test(row)) { removed += 1; hunks.push(row); }
  }
  const content = boundedText(hunks.join('\n'), maximumBytes);
  return {
    summary: {
      changedPaths: unique(changed).sort(), changedSymbols: unique(changedSymbols).sort(),
      addedLines: added, removedLines: removed, binaryFiles: unique(binary).sort(), renames
    },
    included: content ? [sourceMaterial('changed-hunks', content)] : [],
    omitted: { unchangedFileContent: true },
    parsed: changed.length > 0 || hunks.length > 0,
    protocol: null
  };
}

function buildObservation(raw, maximumBytes) {
  const rows = lines(raw);
  const diagnostics = unique(rows.filter((row) =>
    /(?:\berror\b|\bwarning\b|FAILED|FAILURE:|undefined reference|ld:|TS\d{3,5}|[A-Z]{1,8}\d{3,6})/i.test(row)
  ).map((row) => row.trim())).slice(0, 240);
  const failedTask = rows.map((row) => row.match(/(?:Task\s+|Execution failed for task\s+['"]?)([^'"\s]+)|^FAILURE:\s*(.+)$/i))
    .find(Boolean);
  const codes = unique(diagnostics.flatMap((row) => row.match(/\b(?:TS\d{3,5}|[A-Z]{2,8}\d{3,6}|ERR_[A-Z0-9_]+)\b/g) ?? [])).sort();
  const warnings = diagnostics.filter((row) => /\bwarning\b/i.test(row)).length;
  const errorDiagnostics = diagnostics.filter((row) => /\berror\b|FAILED|FAILURE:|undefined reference/i.test(row)).length;
  const content = boundedText(diagnostics.join('\n'), maximumBytes);
  return {
    summary: { failedTask: failedTask?.[1] ?? failedTask?.[2] ?? null, diagnostics: diagnostics.length, errorDiagnostics, warnings, errorCodes: codes },
    included: content ? [sourceMaterial('build-diagnostics', content)] : [],
    omitted: { repeatedInformationalLines: Math.max(0, rows.length - diagnostics.length) },
    parsed: diagnostics.length > 0,
    protocol: null
  };
}

function genericObservation(raw, maximumBytes) {
  const content = boundedText(raw, maximumBytes);
  return {
    summary: {},
    included: content ? [sourceMaterial('bounded-raw', content)] : [],
    omitted: { bytes: Math.max(0, Buffer.byteLength(raw) - Buffer.byteLength(content)) },
    parsed: false,
    protocol: null
  };
}

function normalizeExecution(execution, exitCode) {
  if (execution == null) return { exitCode };
  if (!execution || typeof execution !== 'object' || Array.isArray(execution)) {
    throw new SingularityFlowError('Observation execution metadata must be an object.', {
      code: 'EPC_EXECUTION_INVALID'
    });
  }
  return { ...execution };
}

function durableOutcome(kind, execution, protocol) {
  const process = resolveExecutionOutcome(execution);
  let status = process.state === 'succeeded'
    ? (['stack-trace', 'git-diff'].includes(kind) ? 'observed'
        : ['test-result', 'build-output', 'package-install', 'static-analysis'].includes(kind) ? 'passed' : 'unparsed')
    : process.state === 'cancelled' ? 'cancelled'
      : process.state === 'unknown' ? 'unknown' : 'failed';
  let outcome = { ...process, contradiction: null };
  if (protocol?.complete === true && ['passed', 'failed'].includes(protocol.verdict)) {
    const processVerdict = process.state === 'succeeded' ? 'passed'
      : ['failed', 'timed-out', 'not-started'].includes(process.state) ? 'failed' : null;
    if (processVerdict && processVerdict !== protocol.verdict) {
      const contradiction = {
        process: process.state,
        protocol: protocol.verdict,
        resolution: 'failed-safe',
        code: 'OBSERVATION_OUTCOME_CONTRADICTION'
      };
      status = 'failed';
      outcome = {
        ...process, state: 'failed', authority: processVerdict === 'failed' ? process.authority : 'structured-protocol',
        reason: 'authoritative-outcomes-disagree', contradiction
      };
    } else if (!processVerdict && process.state === 'unknown') {
      status = protocol.verdict;
      outcome = {
        ...process,
        state: protocol.verdict === 'passed' ? 'succeeded' : 'failed',
        authority: 'structured-protocol', reason: null, contradiction: null
      };
    }
  }
  return { status, outcome: Object.freeze(outcome) };
}

async function pruneObservationCache(root, { maximumBytes = DEFAULT_CACHE_BYTES, retentionMs = DEFAULT_RETENTION_MS } = {}) {
  const entries = [];
  for (const [directoryName, pattern] of [
    ['raw', /^[a-f0-9]{64}\.raw$/], ['summaries', /^[a-f0-9]{64}\.json$/]
  ]) {
    const directory = path.join(cacheRoot(root), directoryName);
    const names = await readdir(directory).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error));
    for (const name of names.filter((value) => pattern.test(value))) {
      const file = path.join(directory, name);
      const info = await stat(file);
      entries.push({
        file, key: `${directoryName}/${name}`, size: info.size, mtimeMs: info.mtimeMs,
        evictionPriority: directoryName === 'summaries' ? 0 : 1
      });
    }
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs
    || left.evictionPriority - right.evictionPriority || left.key.localeCompare(right.key));
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  for (const entry of entries) {
    if (Date.now() - entry.mtimeMs <= retentionMs && total <= maximumBytes) continue;
    await rm(entry.file, { force: true });
    total -= entry.size;
  }
}

async function storeObservation(root, digest, raw, summaryKey, summary) {
  await writeAtomic(rawFile(root, digest), raw, { mode: 0o600 });
  await writeAtomic(summaryFile(root, summaryKey), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  await pruneObservationCache(root);
}

export async function readRawObservation(root, digest) {
  if (!/^[a-f0-9]{64}$/.test(String(digest ?? ''))) {
    throw new SingularityFlowError('Raw observation reference is invalid.', { code: 'EPC_EXPANSION_INVALID' });
  }
  try { return await readFile(rawFile(root, digest)); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError('Raw observation is unavailable, expired, or predates the redacted v2 cache.', {
      code: 'EPC_OBSERVATION_EVICTED', details: { nextAction: 'Rerun the configured safe operation, then request a new redacted packet.' }
    });
    throw error;
  }
}

export async function readObservationSummary(root, cacheKey) {
  if (!/^[a-f0-9]{64}$/.test(String(cacheKey ?? ''))) {
    throw new SingularityFlowError('Observation summary reference is invalid.', { code: 'EPC_EXPANSION_INVALID' });
  }
  try { return readRecord('observation-summary', await readFile(summaryFile(root, cacheKey))).record; }
  catch (error) {
    if (error?.code === 'ENOENT') throw new SingularityFlowError('Observation summary is no longer retained.', { code: 'EPC_OBSERVATION_EVICTED' });
    throw error;
  }
}

export async function compileObservation(root, {
  kind,
  raw,
  commandClass = 'configured-operation',
  exitCode = null,
  execution = null,
  maximumIncludedBytes = DEFAULT_INCLUDED_BYTES,
  binding = {}
} = {}) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  if (bytes.length > MAX_RAW_BYTES) throw new SingularityFlowError(`Observation raw output exceeds ${MAX_RAW_BYTES} bytes.`, { code: 'EPC_RAW_OUTPUT_TOO_LARGE' });
  if (!Number.isInteger(maximumIncludedBytes) || maximumIncludedBytes < 256 || maximumIncludedBytes > 128 * 1024) {
    throw new SingularityFlowError('Observation included-byte budget is invalid.', { code: 'EPC_CONTEXT_BUDGET_INVALID' });
  }
  const redacted = redactObservation(bytes.toString('utf8'));
  const source = redacted.bytes.toString('utf8');
  const compiler = kind === 'test-result' ? testObservation
    : kind === 'stack-trace' ? stackObservation
      : kind === 'git-diff' ? gitObservation
        : ['build-output', 'package-install', 'static-analysis'].includes(kind) ? buildObservation
          : genericObservation;
  const executionMetadata = normalizeExecution(execution, exitCode);
  const compiled = compiler(source, maximumIncludedBytes);
  const resolved = durableOutcome(String(kind ?? 'unknown'), executionMetadata, compiled.protocol);
  const sourceExitCode = Number.isInteger(executionMetadata.exitCode) ? executionMetadata.exitCode : null;
  const digest = sha256(redacted.bytes);
  const compilerIdentity = {
    id: `${String(kind ?? 'generic')}-observation`,
    version: OBSERVATION_COMPILER_VERSION,
    profile: { maximumIncludedBytes }
  };
  const observationId = `obs-${recordSha256({ kind, digest, execution: executionMetadata, compiler: compilerIdentity }).slice(0, 20)}`;
  const result = {
    schemaVersion: currentSchemaVersion('observation-summary'),
    observationId,
    kind: String(kind ?? 'unknown'),
    status: resolved.status,
    outcome: resolved.outcome,
    source: { commandClass: String(commandClass), exitCode: sourceExitCode, execution: executionMetadata, sha256: digest },
    compiler: compilerIdentity,
    correlation: {
      workspaceId: `sha256:${recordSha256({ root })}`,
      storyId: binding.workId ?? null,
      workType: binding.workType ?? null,
      phase: binding.phase ?? null,
      generation: binding.generation ?? null,
      intervalId: binding.intervalId ?? null,
      goalId: binding.goalId ?? null,
      flightPlanId: binding.flightPlanId ?? null,
      operationId: binding.operationId ?? null,
      packetId: binding.packetId ?? null,
      launchId: binding.launchId ?? null,
      sessionId: binding.sessionId ?? null
    },
    summary: compiled.summary,
    protocol: compiled.protocol,
    included: compiled.included,
    omitted: compiled.omitted,
    rawBytes: bytes.length,
    includedBytes: Buffer.byteLength(JSON.stringify(compiled.included)),
    compressionRatio: bytes.length ? Number((Buffer.byteLength(JSON.stringify(compiled.included)) / bytes.length).toFixed(6)) : null,
    parsing: compiled.parsed ? { status: 'parsed', code: null } : { status: 'unparsed', code: 'EPC_OBSERVATION_UNPARSED' },
    guidanceOnly: true,
    modelInvoked: false,
    redaction: {
      status: redacted.occurrences > 0 ? 'applied' : 'not-needed',
      applied: redacted.occurrences > 0,
      occurrences: redacted.occurrences,
      facts: redacted.facts
    },
    expansion: []
  };
  const log = repositoryLogger(root, null, { context: { observationId, kind: result.kind } });
  log.info('observation.outcome.resolved', null, {
    state: result.outcome.state, authority: result.outcome.authority,
    exitCode: result.outcome.exitCode, signal: result.outcome.signal
  });
  if (result.outcome.contradiction) log.info('observation.outcome.contradiction', null, {
    code: result.outcome.contradiction.code,
    process: result.outcome.contradiction.process,
    protocol: result.outcome.contradiction.protocol,
    resolution: result.outcome.contradiction.resolution
  });
  const sourceRevision = binding.sourceRevision ?? head(root);
  const rawHandle = await issueContextExpansionHandle(root, {
    packetId: binding.packetId ?? `observation-${observationId}`,
    workId: binding.workId ?? null,
    flightPlanId: binding.flightPlanId ?? null,
    sourceRevision,
    lifecycleRevision: binding.lifecycleRevision ?? null,
    itemId: observationId,
    expansionKind: 'observation-raw',
    maximumOutputBytes: binding.maximumOutputBytes ?? Math.min(128 * 1024, Math.max(4096, maximumIncludedBytes)),
    source: { rawSha256: digest }
  });
  result.expansion.push({ kind: 'raw-observation', handle: rawHandle });
  const summaryKey = recordSha256({
    observationId, commandClass, execution: executionMetadata, maximumIncludedBytes,
    binding: {
      packetId: binding.packetId ?? null, workId: binding.workId ?? null,
      flightPlanId: binding.flightPlanId ?? null, sourceRevision,
      lifecycleRevision: binding.lifecycleRevision ?? null
    }
  });
  await storeObservation(root, digest, redacted.bytes, summaryKey, result);
  return result;
}
