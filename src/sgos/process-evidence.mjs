/**
 * Deterministic, portable SGOS Process evidence.
 *
 * The compiler reads the immutable Process index and control lineage through the supported
 * read-only store APIs.  The resulting record contains every rooted immutable record plus the
 * exact mutable Process snapshot, active execution leases, and referenced Device receipts.  The
 * verifier is deliberately repository-independent: it accepts only bundle bytes and never opens
 * Git, the source checkout, or the Git-common operational sidecar.
 *
 * This is an integrity/completeness format, not a signature or Authority Store attestation.  Its
 * assurance block says that explicitly and the verifier never upgrades that claim.
 */
import { canonicalJson } from '../records.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError } from '../util.mjs';
import {
  createToolIntent, createToolResult, readSgosToolIntent, readSgosToolResult
} from './devices.mjs';
import { validateSgosRecord } from './contracts.mjs';
import { sgosSha256 } from './evidence.mjs';
import { SGOS_INSTALLED_LIMITS } from './limits.mjs';
import { compareSgosCodePoints } from './order.mjs';
import {
  fsckSgosProcess, readSgosControlSuccessor, readSgosExecutionLease,
  readSgosImmutableRecord, readSgosProcess
} from './store.mjs';

const FORMAT = 'sflow.sgos.process-evidence/v1';
const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_BUNDLE_BYTES = 2 * SGOS_INSTALLED_LIMITS.maximumProcessRecordBytes
  + 2 * SGOS_INSTALLED_LIMITS.maximumRecordBytes;

const HASH_FIELDS = Object.freeze({
  'action-evidence': 'evidenceSha256',
  'agent-proposal': 'proposalSha256',
  'candidate-snapshot': 'candidateSha256',
  'fanout-expansion-receipt': 'expansionSha256',
  'gvm-checkpoint': 'checkpointSha256',
  'gvm-program': 'programSha256',
  'gvm-task-attempt': 'attemptSha256',
  'gvm-task-receipt': 'receiptSha256',
  'human-request': 'requestSha256',
  'human-response': 'responseSha256',
  'join-receipt': 'joinReceiptSha256',
  'process-binding': 'bindingSha256',
  'resource-lease': 'leaseSha256',
  'sgos-replay-plan': 'replayPlanSha256'
});

const ASSURANCE = Object.freeze({
  integrity: 'content-addressed-local-export',
  authority: 'not-provided',
  signature: 'not-provided',
  freshAuthorityVerification: 'not-performed',
  source: 'machine-local-operational-sidecar'
});

function fail(message, code = 'SGOS_PROCESS_EVIDENCE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function portableByteLimit(options = {}) {
  const value = options?.maximumBytes ?? MAX_BUNDLE_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_BUNDLE_BYTES) {
    fail('SGOS Process evidence maximumBytes must be a positive installed-bound integer.',
      'SGOS_PROCESS_EVIDENCE_LIMIT_INVALID', {
        maximumInstalledBytes: MAX_BUNDLE_BYTES, received: value ?? null
      });
  }
  return value;
}

function boundedCanonicalBytes(bundle, options = {}) {
  const maximumBytes = portableByteLimit(options);
  const bytes = canonicalJson(bundle);
  const actualBytes = Buffer.byteLength(bytes, 'utf8');
  if (actualBytes > maximumBytes) {
    fail('SGOS Process evidence exceeds the configured portable bundle limit.',
      'SGOS_PROCESS_EVIDENCE_LIMIT', { maximumBytes, actualBytes });
  }
  return bytes;
}

function plain(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!plain(value)) fail(`${label} must be an object.`);
  const vocabulary = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !vocabulary.has(key));
  if (unexpected.length) fail(`${label} contains unsupported field(s): ${unexpected.join(', ')}.`,
    'SGOS_PROCESS_EVIDENCE_SHAPE_INVALID', { label, unexpected });
}

function issue(code, subject = null, reference = null) {
  return Object.freeze({ code, subject, reference });
}

function issueKey(value) {
  return `${value.code}\u0000${value.subject ?? ''}\u0000${value.reference ?? ''}`;
}

function canonicalIssues(values) {
  const unique = new Map();
  for (const value of values) unique.set(issueKey(value), issue(value.code, value.subject, value.reference));
  return Object.freeze([...unique.values()].sort((left, right) =>
    compareSgosCodePoints(issueKey(left), issueKey(right))));
}

function recordIdentity(family, sha256) {
  return `${family}\u0000${sha256}`;
}

function recordOrder(left, right) {
  return compareSgosCodePoints(
    recordIdentity(left?.family ?? '', left?.recordSha256 ?? ''),
    recordIdentity(right?.family ?? '', right?.recordSha256 ?? '')
  );
}

function isCanonicalOrder(values, comparator, identity) {
  for (let index = 1; index < values.length; index += 1) {
    if (comparator(values[index - 1], values[index]) >= 0) {
      return { valid: false, duplicate: identity(values[index - 1]) === identity(values[index]) };
    }
  }
  return { valid: true, duplicate: false };
}

function immutableCore(process) {
  return {
    processId: process.processId,
    programSha256: process.programSha256,
    policySnapshotSha256: process.policySnapshotSha256,
    processBindingSha256: process.processBindingSha256,
    taskContractSha256: process.taskContractSha256,
    authorityBinding: structuredClone(process.authorityBinding),
    createdAt: process.createdAt
  };
}

function processAtEvent(process, event) {
  const value = {
    schemaVersion: process.schemaVersion,
    kind: 'gvm-process',
    ...immutableCore(process),
    ...structuredClone(event.result),
    controlEventSha256: event.controlEventSha256,
    recordIndexSha256: event.recordIndexSha256
  };
  return Object.freeze({ ...value, processSha256: sgosSha256(value) });
}

function bundleCore(bundle) {
  const core = structuredClone(bundle);
  delete core.bundleSha256;
  return core;
}

function sealBundle(value) {
  const core = structuredClone(value);
  delete core.bundleSha256;
  core.schemaVersion = currentSchemaVersion('sgos-process-evidence-bundle');
  core.kind = 'sgos-process-evidence-bundle';
  core.format = FORMAT;
  return Object.freeze({ ...core, bundleSha256: sgosSha256(core) });
}

async function indexedSnapshot(root, state) {
  const indexesNewestFirst = [];
  const entries = new Map();
  const records = [];
  let cursor = state.recordIndexSha256;
  for (let depth = 0; cursor !== null; depth += 1) {
    if (depth >= SGOS_INSTALLED_LIMITS.maximumProcessRecords) {
      fail('Process evidence record-index traversal exceeded its installed bound.',
        'SGOS_PROCESS_EVIDENCE_LIMIT');
    }
    const { record: index } = await readSgosImmutableRecord(
      root, state.processId, 'sgos-record-index', cursor
    );
    indexesNewestFirst.push(index);
    for (const entry of index.delta) {
      const identity = recordIdentity(entry.family, entry.recordSha256);
      if (entries.has(identity)) {
        fail('Process evidence source index contains a duplicate immutable identity.',
          'SGOS_RECORD_INDEX_DUPLICATE', { family: entry.family, recordSha256: entry.recordSha256 });
      }
      entries.set(identity, entry);
      const loaded = await readSgosImmutableRecord(
        root, state.processId, entry.family, entry.recordSha256
      );
      records.push(Object.freeze({
        family: entry.family,
        recordSha256: entry.recordSha256,
        record: structuredClone(loaded.record)
      }));
    }
    cursor = index.priorIndexSha256;
  }
  records.sort(recordOrder);
  return Object.freeze({
    recordIndexes: Object.freeze(indexesNewestFirst.reverse().map((entry) => structuredClone(entry))),
    records: Object.freeze(records)
  });
}

async function controlSnapshot(root, state) {
  const newestFirst = [];
  let cursor = state.controlEventSha256;
  for (let depth = 0; cursor !== null; depth += 1) {
    if (depth >= SGOS_INSTALLED_LIMITS.maximumControlRecords) {
      fail('Process evidence control traversal exceeded its installed bound.',
        'SGOS_PROCESS_EVIDENCE_LIMIT');
    }
    const { record: event } = await readSgosImmutableRecord(
      root, state.processId, 'sgos-control-event', cursor
    );
    const successor = await readSgosControlSuccessor(root, state.processId, event.beforeProcessSha256);
    newestFirst.push(Object.freeze({ event: structuredClone(event), successor: structuredClone(successor) }));
    cursor = event.priorControlEventSha256;
  }
  return Object.freeze(newestFirst.reverse());
}

function referencedHashes(records) {
  const values = new Set();
  for (const { record } of records) {
    for (const field of [
      'inputRefs', 'outputRefs', 'evidenceRefs', 'effectRefs', 'humanDecisionRefs'
    ]) {
      for (const value of record[field] ?? []) if (HASH.test(String(value))) values.add(value);
    }
  }
  return [...values].sort(compareSgosCodePoints);
}

async function toolSnapshot(root, processId, records, gaps, contradictions) {
  const tools = [];
  for (const reference of referencedHashes(records)) {
    let intent;
    try {
      intent = await readSgosToolIntent(root, reference);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      contradictions.push(issue(
        error?.code ?? 'tool-intent-corrupt', 'tool-intent', reference
      ));
      continue;
    }
    if (intent.processId !== processId) {
      contradictions.push(issue('tool-intent-process-mismatch', 'tool-intent', reference));
      continue;
    }
    let result = null;
    try {
      result = await readSgosToolResult(root, reference);
    } catch (error) {
      if (error?.code === 'SGOS_TOOL_RESULT_NOT_FOUND') {
        gaps.push(issue('tool-result-unavailable', 'tool-intent', reference));
      } else {
        contradictions.push(issue(
          error?.code ?? 'tool-result-corrupt', 'tool-intent', reference
        ));
      }
    }
    tools.push(Object.freeze({
      intentSha256: intent.intentSha256,
      resultSha256: result?.resultSha256 ?? null,
      intent: structuredClone(intent),
      result: result == null ? null : structuredClone(result)
    }));
    if (result !== null) {
      gaps.push(issue('device-raw-evidence-not-exported', 'tool-result', result.resultSha256));
    }
  }
  tools.sort((left, right) => compareSgosCodePoints(left.intentSha256, right.intentSha256));
  return Object.freeze(tools);
}

async function executionLeaseSnapshot(root, state, gaps, contradictions) {
  const values = [];
  for (const leaseId of [...state.activeLeases].sort(compareSgosCodePoints)) {
    try {
      const record = await readSgosExecutionLease(root, state.processId, leaseId);
      if (record === null) {
        gaps.push(issue('execution-lease-unavailable', 'execution-lease', leaseId));
        continue;
      }
      values.push(Object.freeze({ leaseSha256: sgosSha256(record), record: structuredClone(record) }));
    } catch (error) {
      contradictions.push(issue(
        error?.code ?? 'execution-lease-corrupt', 'execution-lease', leaseId
      ));
    }
  }
  return Object.freeze(values);
}

function sourceIssues(fsck, gaps, contradictions) {
  if (fsck.status === 'attention') gaps.push(issue('source-fsck-attention', 'process', fsck.processId));
  if (fsck.status === 'failed') contradictions.push(issue('source-fsck-failed', 'process', fsck.processId));
  if (fsck.pendingReservations.length) {
    gaps.push(issue('source-pending-record-reservations', 'process', String(fsck.pendingReservations.length)));
  }
  if (fsck.transitionIntent !== null) {
    gaps.push(issue('source-transition-pending', 'process', fsck.transitionIntent.intentSha256));
  }
  for (const entry of fsck.missing) {
    contradictions.push(issue('source-indexed-record-missing', entry.family, entry.recordSha256));
  }
  for (const entry of fsck.orphans) {
    contradictions.push(issue('source-orphan-record', entry.family, entry.recordSha256));
  }
  for (const entry of fsck.errors) {
    contradictions.push(issue(entry.code ?? 'source-fsck-error', 'process', fsck.processId));
  }
}

function sourceIntegrity(fsck) {
  return Object.freeze({
    status: fsck.status,
    processSha256: fsck.processSha256,
    recordIndexSha256: fsck.recordIndexSha256,
    indexedRecordCount: fsck.indexedRecordCount,
    indexedBytes: fsck.indexedBytes,
    indexRecordCount: fsck.indexRecordCount,
    missingCount: fsck.missing.length,
    orphanCount: fsck.orphans.length,
    pendingReservationCount: fsck.pendingReservations.length,
    transitionPending: fsck.transitionIntent !== null,
    lineageStatus: fsck.lineage.status,
    lineageRecordCount: fsck.lineage.recordCount,
    lineageBytes: fsck.lineage.bytes,
    errorCodes: Object.freeze([...new Set(fsck.errors.map((entry) => entry.code ?? 'unknown'))]
      .sort(compareSgosCodePoints))
  });
}

function portableCompletenessGaps(state, program, records, controlLineage, tools, gaps) {
  gaps.push(issue('task-contract-bytes-not-exported', 'task-contract', state.taskContractSha256));
  gaps.push(issue('approved-authority-bundle-not-exported', 'authority', state.processBindingSha256));
  if (program.taskTemplates.some((task) => task.opcode === 'AGENT')) {
    gaps.push(issue('execution-event-records-not-durable', 'process', state.processId));
  }
  if (controlLineage.some(({ event }) => event.action === 'process-paused')) {
    gaps.push(issue('stop-quiescence-receipts-not-durable', 'process', state.processId));
  }

  const available = new Set([
    state.processSha256,
    ...records.map((entry) => entry.recordSha256),
    ...controlLineage.flatMap(({ event, successor }) => [
      event.controlEventSha256, successor?.successorSha256
    ]).filter(Boolean),
    ...tools.flatMap(({ intentSha256, resultSha256 }) => [intentSha256, resultSha256]).filter(Boolean)
  ]);
  for (const { record } of records) {
    for (const field of ['evidenceRefs', 'effectRefs', 'humanDecisionRefs']) {
      for (const reference of record[field] ?? []) {
        if (HASH.test(String(reference)) && !available.has(reference)) {
          gaps.push(issue('referenced-evidence-not-exported', field, reference));
        }
      }
    }
  }
}

/**
 * Compile one deterministic Process evidence bundle without mutating Process or repository state.
 * A valid Process can be larger than the portable export ceiling; that is an explicit bounded
 * refusal, never a partial export. `maximumBytes` may narrow but cannot raise the installed bound.
 */
export async function compileSgosProcessEvidence(root, processId, options = {}) {
  const state = await readSgosProcess(root, processId);
  const fsck = await fsckSgosProcess(root, processId);
  const gaps = [];
  const contradictions = [];
  sourceIssues(fsck, gaps, contradictions);
  const { recordIndexes, records } = await indexedSnapshot(root, state);
  const controlLineage = await controlSnapshot(root, state);
  const programEntry = records.find((entry) =>
    entry.family === 'gvm-program' && entry.recordSha256 === state.programSha256);
  const bindingEntry = records.find((entry) =>
    entry.family === 'process-binding' && entry.recordSha256 === state.processBindingSha256);
  if (!programEntry) contradictions.push(issue('program-record-unavailable', 'gvm-program', state.programSha256));
  if (!bindingEntry) {
    contradictions.push(issue('process-binding-record-unavailable', 'process-binding', state.processBindingSha256));
  }
  const tools = await toolSnapshot(root, state.processId, records, gaps, contradictions);
  const executionLeases = await executionLeaseSnapshot(root, state, gaps, contradictions);
  if (fsck.lineage.recordCount > 0) {
    gaps.push(issue(
      'private-lineage-records-not-exported', 'process-lineage',
      String(fsck.lineage.recordCount)
    ));
  }
  portableCompletenessGaps(
    state, programEntry?.record ?? { taskTemplates: [] }, records, controlLineage, tools, gaps
  );
  const canonicalGaps = canonicalIssues(gaps);
  const canonicalContradictions = canonicalIssues(contradictions);
  const bundle = sealBundle({
    processId: state.processId,
    processSha256: state.processSha256,
    programSha256: state.programSha256,
    processBindingSha256: state.processBindingSha256,
    recordIndexSha256: state.recordIndexSha256,
    controlEventSha256: state.controlEventSha256,
    process: structuredClone(state),
    program: programEntry == null ? null : structuredClone(programEntry.record),
    processBinding: bindingEntry == null ? null : structuredClone(bindingEntry.record),
    recordIndexes,
    controlLineage,
    records,
    executionLeases,
    tools,
    sourceIntegrity: sourceIntegrity(fsck),
    assurance: ASSURANCE,
    evidenceCompleteness: canonicalContradictions.length
      ? 'contradictory' : canonicalGaps.length ? 'incomplete' : 'complete',
    gaps: canonicalGaps,
    contradictions: canonicalContradictions
  });
  boundedCanonicalBytes(bundle, options);
  return bundle;
}

function add(issues, code, subject = null, reference = null) {
  issues.push(issue(code, subject, reference));
}

function validateIssueArray(value, label, contradictions) {
  if (!Array.isArray(value)) {
    add(contradictions, 'bundle-field-invalid', label, null);
    return [];
  }
  const normalized = [];
  for (const entry of value) {
    if (!plain(entry) || Object.keys(entry).sort().join(',') !== 'code,reference,subject'
        || typeof entry.code !== 'string' || !entry.code
        || (entry.subject !== null && typeof entry.subject !== 'string')
        || (entry.reference !== null && typeof entry.reference !== 'string')) {
      add(contradictions, 'bundle-issue-invalid', label, null);
      continue;
    }
    normalized.push(issue(entry.code, entry.subject, entry.reference));
  }
  const canonical = canonicalIssues(normalized);
  if (canonicalJson(canonical) !== canonicalJson(value)) {
    add(contradictions, 'bundle-issues-reordered-or-duplicated', label, null);
  }
  return canonical;
}

function validateRecordWrapper(wrapper, contradictions) {
  if (!plain(wrapper)) {
    add(contradictions, 'bundle-record-wrapper-invalid', 'records', null);
    return null;
  }
  try { exactKeys(wrapper, ['family', 'recordSha256', 'record'], 'Process evidence record'); } catch {
    add(contradictions, 'bundle-record-wrapper-invalid', 'records', null);
    return null;
  }
  const hashField = HASH_FIELDS[wrapper.family];
  if (!hashField || !HASH.test(String(wrapper.recordSha256 ?? '')) || !plain(wrapper.record)) {
    add(contradictions, 'bundle-record-wrapper-invalid', wrapper.family ?? 'unknown', wrapper.recordSha256 ?? null);
    return null;
  }
  try { validateSgosRecord(wrapper.record); } catch {
    add(contradictions, 'bundle-record-contract-invalid', wrapper.family, wrapper.recordSha256);
  }
  const core = structuredClone(wrapper.record);
  delete core[hashField];
  if (wrapper.record.kind !== wrapper.family
      || wrapper.record[hashField] !== wrapper.recordSha256
      || sgosSha256(core) !== wrapper.recordSha256) {
    add(contradictions, 'bundle-record-tampered', wrapper.family, wrapper.recordSha256);
  }
  return wrapper;
}

function validateRecordIndexes(bundle, wrappers, contradictions) {
  const indexes = Array.isArray(bundle.recordIndexes) ? bundle.recordIndexes : [];
  if (!Array.isArray(bundle.recordIndexes)) add(contradictions, 'bundle-field-invalid', 'recordIndexes', null);
  const authoritative = new Map();
  let prior = null;
  let cumulativeBytes = 0;
  const counts = {};
  for (const index of indexes) {
    if (!plain(index)) {
      add(contradictions, 'record-index-contract-invalid', 'sgos-record-index', null);
      continue;
    }
    try { validateSgosRecord(index); } catch {
      add(contradictions, 'record-index-contract-invalid', 'sgos-record-index', index?.recordIndexSha256 ?? null);
      continue;
    }
    const core = structuredClone(index); delete core.recordIndexSha256;
    if (sgosSha256(core) !== index.recordIndexSha256) {
      add(contradictions, 'record-index-tampered', 'sgos-record-index', index.recordIndexSha256);
    }
    if (index.sequence !== (prior == null ? 0 : prior.sequence + 1)
        || index.priorIndexSha256 !== (prior?.recordIndexSha256 ?? null)) {
      add(contradictions, 'record-index-reordered-or-omitted', 'sgos-record-index', index.recordIndexSha256);
    }
    for (const entry of index.delta ?? []) {
      const identity = recordIdentity(entry.family, entry.recordSha256);
      if (authoritative.has(identity)) {
        add(contradictions, 'record-index-duplicate', entry.family, entry.recordSha256);
      } else authoritative.set(identity, entry);
      counts[entry.family] = (counts[entry.family] ?? 0) + 1;
      cumulativeBytes += entry.bytes;
    }
    const canonicalCounts = Object.fromEntries(Object.entries(counts)
      .sort(([left], [right]) => compareSgosCodePoints(left, right)));
    if (index.totalRecordCount !== authoritative.size || index.totalBytes !== cumulativeBytes
        || canonicalJson(index.familyCounts) !== canonicalJson(canonicalCounts)) {
      add(contradictions, 'record-index-counters-invalid', 'sgos-record-index', index.recordIndexSha256);
    }
    prior = index;
  }
  if ((indexes.at(-1)?.recordIndexSha256 ?? null) !== bundle.recordIndexSha256
      || bundle.process?.recordIndexSha256 !== bundle.recordIndexSha256) {
    add(contradictions, 'record-index-head-mismatch', 'process', bundle.recordIndexSha256 ?? null);
  }

  const represented = new Map();
  for (const wrapper of wrappers) {
    if (!wrapper) continue;
    const identity = recordIdentity(wrapper.family, wrapper.recordSha256);
    if (represented.has(identity)) {
      add(contradictions, 'bundle-record-duplicated', wrapper.family, wrapper.recordSha256);
    } else represented.set(identity, wrapper);
  }
  for (const [identity, entry] of authoritative) {
    const wrapper = represented.get(identity);
    if (!wrapper) {
      add(contradictions, 'indexed-record-omitted', entry.family, entry.recordSha256);
      continue;
    }
    if (Buffer.byteLength(canonicalJson(wrapper.record)) !== entry.bytes) {
      add(contradictions, 'indexed-record-byte-count-mismatch', entry.family, entry.recordSha256);
    }
    const expectedAttemptId = wrapper.record.attemptId;
    const expectedTaskInstanceId = wrapper.record.taskInstanceId;
    if ((entry.attemptId ?? null) !== (expectedAttemptId ?? null)
        || (entry.taskInstanceId ?? null) !== (expectedTaskInstanceId ?? null)) {
      add(contradictions, 'indexed-record-metadata-mismatch', entry.family, entry.recordSha256);
    }
  }
  for (const [identity, wrapper] of represented) {
    if (!authoritative.has(identity)) {
      add(contradictions, 'bundle-record-orphaned', wrapper.family, wrapper.recordSha256);
    }
  }
  return { authoritative, represented, indexes };
}

function validateControlLineage(bundle, indexes, contradictions) {
  const lineage = Array.isArray(bundle.controlLineage) ? bundle.controlLineage : [];
  if (!Array.isArray(bundle.controlLineage)) add(contradictions, 'bundle-field-invalid', 'controlLineage', null);
  const indexSequence = new Map(indexes.map((entry) => [entry.recordIndexSha256, entry.sequence]));
  let priorEvent = null;
  let priorAfter = null;
  let priorIndexSequence = -1;
  let infrastructureBytes = 0;
  let infrastructureRecords = 0;
  for (const pair of lineage) {
    if (!plain(pair) || !plain(pair.event) || !plain(pair.successor)) {
      add(contradictions, 'control-lineage-entry-invalid', 'controlLineage', null);
      continue;
    }
    const { event, successor } = pair;
    try { validateSgosRecord(event); } catch {
      add(contradictions, 'control-event-contract-invalid', 'sgos-control-event', event.controlEventSha256 ?? null);
    }
    try { validateSgosRecord(successor); } catch {
      add(contradictions, 'control-successor-contract-invalid', 'sgos-control-successor', successor.successorSha256 ?? null);
    }
    const eventCore = structuredClone(event); delete eventCore.controlEventSha256;
    const successorCore = structuredClone(successor); delete successorCore.successorSha256;
    if (sgosSha256(eventCore) !== event.controlEventSha256) {
      add(contradictions, 'control-event-tampered', 'sgos-control-event', event.controlEventSha256 ?? null);
    }
    if (sgosSha256(successorCore) !== successor.successorSha256) {
      add(contradictions, 'control-successor-tampered', 'sgos-control-successor', successor.successorSha256 ?? null);
    }
    if (event.priorControlEventSha256 !== (priorEvent?.controlEventSha256 ?? null)
        || event.controlDepth !== (priorEvent?.controlDepth ?? 0) + 1
        || (priorAfter !== null && event.beforeProcessSha256 !== priorAfter.processSha256)) {
      add(contradictions, 'control-lineage-reordered-or-omitted', 'sgos-control-event', event.controlEventSha256 ?? null);
    }
    if (successor.processId !== event.processId
        || successor.beforeProcessSha256 !== event.beforeProcessSha256
        || successor.controlEventSha256 !== event.controlEventSha256
        || successor.controlDepth !== event.controlDepth
        || successor.operatorTransitionCount !== event.operatorTransitionCount) {
      add(contradictions, 'control-successor-mismatch', 'sgos-control-successor', successor.successorSha256 ?? null);
    }
    const eventIndexSequence = indexSequence.get(event.recordIndexSha256);
    if (!Number.isSafeInteger(eventIndexSequence) || eventIndexSequence < priorIndexSequence) {
      add(contradictions, 'control-event-index-unavailable', 'sgos-control-event', event.controlEventSha256 ?? null);
    } else {
      const introduced = indexes.filter((entry) =>
        entry.sequence > priorIndexSequence && entry.sequence <= eventIndexSequence);
      infrastructureBytes += introduced.reduce(
        (total, entry) => total + Buffer.byteLength(canonicalJson(entry)), 0
      ) + Buffer.byteLength(canonicalJson(event)) + Buffer.byteLength(canonicalJson(successor));
      infrastructureRecords += introduced.length + 2;
      if (successor.cumulativeInfrastructureBytes !== infrastructureBytes
          || successor.cumulativeInfrastructureRecords !== infrastructureRecords) {
        add(contradictions, 'control-infrastructure-counters-invalid', 'sgos-control-successor', successor.successorSha256 ?? null);
      }
      priorIndexSequence = eventIndexSequence;
    }
    const after = processAtEvent(bundle.process, event);
    priorEvent = event;
    priorAfter = after;
  }
  if ((priorEvent?.controlEventSha256 ?? null) !== bundle.controlEventSha256
      || bundle.process?.controlEventSha256 !== bundle.controlEventSha256) {
    add(contradictions, 'control-head-mismatch', 'process', bundle.controlEventSha256 ?? null);
  }
  if (priorAfter !== null && priorAfter.processSha256 !== bundle.processSha256) {
    add(contradictions, 'control-head-process-mismatch', 'process', bundle.processSha256 ?? null);
  }
}

function validateTools(bundle, contradictions, gaps) {
  const tools = Array.isArray(bundle.tools) ? bundle.tools : [];
  if (!Array.isArray(bundle.tools)) add(contradictions, 'bundle-field-invalid', 'tools', null);
  const order = isCanonicalOrder(tools,
    (left, right) => compareSgosCodePoints(
      left?.intentSha256 ?? '', right?.intentSha256 ?? ''
    ),
    (entry) => entry?.intentSha256 ?? '');
  if (!order.valid) add(contradictions,
    order.duplicate ? 'tool-record-duplicated' : 'tool-record-reordered', 'tools', null);
  for (const entry of tools) {
    if (!plain(entry) || !plain(entry.intent)) {
      add(contradictions, 'tool-record-invalid', 'tools', null);
      continue;
    }
    try {
      const core = structuredClone(entry.intent);
      delete core.deviceRecordFormat; delete core.deviceRecordVersion;
      delete core.kind; delete core.intentSha256;
      const rebuilt = createToolIntent(core);
      if (canonicalJson(rebuilt) !== canonicalJson(entry.intent)
          || rebuilt.intentSha256 !== entry.intentSha256
          || entry.intent.processId !== bundle.processId) {
        add(contradictions, 'tool-intent-tampered', 'tool-intent', entry.intentSha256 ?? null);
      }
    } catch {
      add(contradictions, 'tool-intent-contract-invalid', 'tool-intent', entry.intentSha256 ?? null);
    }
    if (entry.result === null) {
      if (entry.resultSha256 !== null) {
        add(contradictions, 'tool-result-reference-without-record', 'tool-result', entry.resultSha256);
      }
      add(gaps, 'tool-result-unavailable', 'tool-intent', entry.intentSha256 ?? null);
      continue;
    }
    try {
      const core = structuredClone(entry.result);
      delete core.deviceRecordFormat; delete core.deviceRecordVersion;
      delete core.kind; delete core.resultSha256;
      const rebuilt = createToolResult(core);
      if (canonicalJson(rebuilt) !== canonicalJson(entry.result)
          || rebuilt.resultSha256 !== entry.resultSha256
          || entry.result.intentSha256 !== entry.intentSha256) {
        add(contradictions, 'tool-result-tampered', 'tool-result', entry.resultSha256 ?? null);
      }
    } catch {
      add(contradictions, 'tool-result-contract-invalid', 'tool-result', entry.resultSha256 ?? null);
    }
    add(gaps, 'device-raw-evidence-not-exported', 'tool-result', entry.resultSha256 ?? null);
  }
  return tools;
}

function validateExecutionLeases(bundle, contradictions, gaps) {
  const leases = Array.isArray(bundle.executionLeases) ? bundle.executionLeases : [];
  if (!Array.isArray(bundle.executionLeases)) {
    add(contradictions, 'bundle-field-invalid', 'executionLeases', null);
  }
  const expected = new Set(bundle.process?.activeLeases ?? []);
  const observed = new Set();
  const leaseOrder = isCanonicalOrder(leases,
    (left, right) => compareSgosCodePoints(
      left?.record?.leaseId ?? '', right?.record?.leaseId ?? ''
    ),
    (entry) => entry?.record?.leaseId ?? '');
  if (!leaseOrder.valid) add(contradictions,
    leaseOrder.duplicate ? 'execution-lease-duplicated' : 'execution-lease-reordered',
    'executionLeases', null);
  for (const entry of leases) {
    if (!plain(entry) || !plain(entry.record) || !HASH.test(String(entry.leaseSha256 ?? ''))
        || sgosSha256(entry.record) !== entry.leaseSha256) {
      add(contradictions, 'execution-lease-tampered', 'execution-lease', entry?.record?.leaseId ?? null);
      continue;
    }
    try { readRecord('sgos-execution-lease', entry.record); } catch {
      add(contradictions, 'execution-lease-contract-invalid', 'execution-lease', entry.record.leaseId ?? null);
    }
    if (entry.record.processId !== bundle.processId || observed.has(entry.record.leaseId)) {
      add(contradictions, 'execution-lease-duplicated-or-foreign', 'execution-lease', entry.record.leaseId ?? null);
    }
    observed.add(entry.record.leaseId);
  }
  for (const leaseId of expected) {
    if (!observed.has(leaseId)) add(gaps, 'execution-lease-unavailable', 'execution-lease', leaseId);
  }
  for (const leaseId of observed) {
    if (!expected.has(leaseId)) add(contradictions, 'execution-lease-orphaned', 'execution-lease', leaseId);
  }
}

function semanticReferences(bundle, wrappers, tools, contradictions, gaps) {
  const byFamily = new Map();
  for (const wrapper of wrappers) {
    if (!wrapper) continue;
    if (!byFamily.has(wrapper.family)) byFamily.set(wrapper.family, []);
    byFamily.get(wrapper.family).push(wrapper);
  }
  const referenced = new Set([
    recordIdentity('gvm-program', bundle.programSha256),
    recordIdentity('process-binding', bundle.processBindingSha256)
  ]);
  const identitiesByHash = new Map();
  for (const wrapper of wrappers) {
    if (!wrapper) continue;
    if (!identitiesByHash.has(wrapper.recordSha256)) identitiesByHash.set(wrapper.recordSha256, []);
    identitiesByHash.get(wrapper.recordSha256).push(
      recordIdentity(wrapper.family, wrapper.recordSha256)
    );
  }
  const referenceHash = (hash) => {
    for (const identity of identitiesByHash.get(hash) ?? []) referenced.add(identity);
  };
  const attemptIds = new Set();
  const receiptHashes = new Set();
  for (const task of Object.values(bundle.process?.taskInstances ?? {})) {
    for (const attemptId of task.attemptIds ?? []) attemptIds.add(attemptId);
    if (task.receiptSha256) receiptHashes.add(task.receiptSha256);
    for (const hash of task.outputRefs ?? []) referenceHash(hash);
  }
  for (const wrapper of byFamily.get('gvm-task-attempt') ?? []) {
    if (attemptIds.has(wrapper.record.attemptId)) referenced.add(recordIdentity(wrapper.family, wrapper.recordSha256));
  }
  for (const wrapper of byFamily.get('gvm-task-receipt') ?? []) {
    if (attemptIds.has(wrapper.record.attemptId) || receiptHashes.has(wrapper.recordSha256)) {
      referenced.add(recordIdentity(wrapper.family, wrapper.recordSha256));
      referenced.add(recordIdentity('gvm-task-attempt', wrapper.record.attemptSha256));
      referenced.add(recordIdentity('candidate-snapshot', wrapper.record.candidateSha256));
      for (const field of ['outputRefs', 'evidenceRefs', 'effectRefs', 'humanDecisionRefs']) {
        for (const hash of wrapper.record[field] ?? []) referenceHash(hash);
      }
    }
  }
  for (const wrapper of byFamily.get('action-evidence') ?? []) {
    if (attemptIds.has(wrapper.record.attemptId)) {
      referenced.add(recordIdentity(wrapper.family, wrapper.recordSha256));
      if (HASH.test(String(wrapper.record.postStateSha256 ?? ''))) {
        referenced.add(recordIdentity('candidate-snapshot', wrapper.record.postStateSha256));
      }
      for (const field of ['evidenceRefs', 'effectRefs', 'humanDecisionRefs']) {
        for (const hash of wrapper.record[field] ?? []) referenceHash(hash);
      }
    }
  }
  if (bundle.process?.currentCheckpointSha256) {
    let cursor = bundle.process.currentCheckpointSha256;
    const checkpoints = new Map((byFamily.get('gvm-checkpoint') ?? [])
      .map((entry) => [entry.recordSha256, entry.record]));
    while (cursor !== null && checkpoints.has(cursor)) {
      referenced.add(recordIdentity('gvm-checkpoint', cursor));
      cursor = checkpoints.get(cursor).priorCheckpointSha256;
    }
  }
  for (const pair of bundle.controlLineage ?? []) {
    if (pair?.event?.result?.currentCheckpointSha256) {
      referenced.add(recordIdentity('gvm-checkpoint', pair.event.result.currentCheckpointSha256));
    }
    for (const request of pair?.event?.result?.openHumanRequests ?? []) {
      referenced.add(recordIdentity('human-request', request));
    }
  }
  for (const hash of bundle.process?.openHumanRequests ?? []) {
    referenced.add(recordIdentity('human-request', hash));
  }
  for (const wrapper of byFamily.get('human-request') ?? []) {
    if (referenced.has(recordIdentity(wrapper.family, wrapper.recordSha256))) {
      referenced.add(recordIdentity('gvm-checkpoint', wrapper.record.checkpointSha256));
    }
  }
  for (const wrapper of byFamily.get('human-response') ?? []) {
    if (referenced.has(recordIdentity(wrapper.family, wrapper.recordSha256))) {
      referenced.add(recordIdentity('human-request', wrapper.record.requestSha256));
    }
  }
  for (const family of ['resource-lease']) {
    for (const wrapper of byFamily.get(family) ?? []) {
      if (attemptIds.has(wrapper.record.attemptId)) referenced.add(recordIdentity(family, wrapper.recordSha256));
    }
  }
  const fanoutParents = new Set((bundle.program?.taskTemplates ?? []).flatMap((task) => {
    const descriptor = task.metadata?.fanout ?? task.metadata?.fanoutCoordinator;
    return descriptor?.parentTaskId ? [descriptor.parentTaskId] : [];
  }));
  for (const wrapper of byFamily.get('fanout-expansion-receipt') ?? []) {
    if (fanoutParents.has(wrapper.record.parentTaskTemplateId)) {
      referenced.add(recordIdentity(wrapper.family, wrapper.recordSha256));
    }
  }
  // Replay plans are themselves immutable, confirmation-bound lineage roots. They are not mutable
  // task output and therefore do not need a current Process pointer to remain relevant evidence.
  for (const wrapper of byFamily.get('sgos-replay-plan') ?? []) {
    referenced.add(recordIdentity(wrapper.family, wrapper.recordSha256));
  }

  for (const wrapper of wrappers) {
    if (wrapper && !referenced.has(recordIdentity(wrapper.family, wrapper.recordSha256))) {
      add(contradictions, 'indexed-record-unreferenced', wrapper.family, wrapper.recordSha256);
    }
  }

  const availableHashes = new Set([
    bundle.processSha256,
    ...wrappers.filter(Boolean).map((entry) => entry.recordSha256),
    ...tools.flatMap((entry) => [entry.intentSha256, entry.resultSha256]).filter(Boolean),
    ...(bundle.controlLineage ?? []).flatMap((pair) => [
      pair?.event?.controlEventSha256, pair?.successor?.successorSha256
    ]).filter(Boolean)
  ]);
  for (const wrapper of wrappers) {
    for (const field of ['evidenceRefs', 'effectRefs', 'humanDecisionRefs']) {
      for (const reference of wrapper?.record?.[field] ?? []) {
        if (HASH.test(String(reference)) && !availableHashes.has(reference)) {
          add(gaps, 'referenced-evidence-not-exported', field, reference);
        }
      }
    }
  }
}

function validateSourceIntegrity(bundle, contradictions, gaps) {
  const source = bundle.sourceIntegrity;
  if (!plain(source)) {
    add(contradictions, 'source-integrity-invalid', 'sourceIntegrity', null);
    return;
  }
  if (source.processSha256 !== bundle.processSha256
      || source.recordIndexSha256 !== bundle.recordIndexSha256) {
    add(contradictions, 'source-integrity-head-mismatch', 'sourceIntegrity', bundle.processSha256 ?? null);
  }
  if (source.status === 'attention') add(gaps, 'source-fsck-attention', 'process', bundle.processId);
  if (source.status === 'failed') add(contradictions, 'source-fsck-failed', 'process', bundle.processId);
  if (source.pendingReservationCount > 0) {
    add(gaps, 'source-pending-record-reservations', 'process', String(source.pendingReservationCount));
  }
  if (source.transitionPending === true) add(gaps, 'source-transition-pending', 'process', null);
  if (Number.isSafeInteger(source.lineageRecordCount) && source.lineageRecordCount > 0) {
    add(gaps, 'private-lineage-records-not-exported', 'process-lineage',
      String(source.lineageRecordCount));
  }
  if (source.missingCount > 0) add(contradictions, 'source-indexed-record-missing', 'process', String(source.missingCount));
  if (source.orphanCount > 0) add(contradictions, 'source-orphan-record', 'process', String(source.orphanCount));
  for (const code of source.errorCodes ?? []) add(contradictions, code, 'process', bundle.processId);
}

/**
 * Verify portable bundle integrity without consulting the repository from which it was exported.
 * Returns a report for malformed/tampered evidence rather than turning absence into success.
 */
export function verifySgosProcessEvidence(bundleValue) {
  const contradictions = [];
  const gaps = [];
  if (!plain(bundleValue)) {
    return Object.freeze({
      status: 'failed', integrity: 'failed', evidenceCompleteness: 'contradictory',
      processId: null, bundleSha256: null, assurance: ASSURANCE,
      gaps: Object.freeze([]),
      contradictions: Object.freeze([issue('bundle-not-an-object', 'bundle', null)])
    });
  }
  let bundle = structuredClone(bundleValue);
  try {
    bundle = readRecord('sgos-process-evidence-bundle', bundle).record;
  } catch (error) {
    add(contradictions, error?.code ?? 'bundle-schema-unsupported', 'bundle', null);
  }
  try {
    exactKeys(bundle, [
      'schemaVersion', 'kind', 'format', 'processId', 'processSha256', 'programSha256',
      'processBindingSha256', 'recordIndexSha256', 'controlEventSha256', 'process', 'program',
      'processBinding', 'recordIndexes', 'controlLineage', 'records', 'executionLeases', 'tools',
      'sourceIntegrity', 'assurance', 'evidenceCompleteness', 'gaps', 'contradictions',
      'bundleSha256'
    ], 'Process evidence bundle');
  } catch {
    add(contradictions, 'bundle-shape-invalid', 'bundle', null);
  }
  if (bundle.kind !== 'sgos-process-evidence-bundle' || bundle.format !== FORMAT
      || !HASH.test(String(bundle.bundleSha256 ?? ''))
      || sgosSha256(bundleCore(bundle)) !== bundle.bundleSha256) {
    add(contradictions, 'bundle-hash-or-format-invalid', 'bundle', bundle.bundleSha256 ?? null);
  }
  if (canonicalJson(bundle.assurance) !== canonicalJson(ASSURANCE)) {
    add(contradictions, 'bundle-assurance-overclaimed', 'assurance', null);
  }

  const declaredGaps = validateIssueArray(bundle.gaps, 'gaps', contradictions);
  const declaredContradictions = validateIssueArray(bundle.contradictions, 'contradictions', contradictions);
  gaps.push(...declaredGaps);
  contradictions.push(...declaredContradictions);

  try { validateSgosRecord(bundle.process); } catch {
    add(contradictions, 'process-contract-invalid', 'gvm-process', bundle.processSha256 ?? null);
  }
  if (bundle.process?.processId !== bundle.processId
      || bundle.process?.processSha256 !== bundle.processSha256
      || bundle.process?.programSha256 !== bundle.programSha256
      || bundle.process?.processBindingSha256 !== bundle.processBindingSha256) {
    add(contradictions, 'process-head-mismatch', 'gvm-process', bundle.processSha256 ?? null);
  } else {
    const core = structuredClone(bundle.process); delete core.processSha256;
    if (sgosSha256(core) !== bundle.processSha256) {
      add(contradictions, 'process-head-tampered', 'gvm-process', bundle.processSha256);
    }
  }
  if (bundle.program === null || bundle.program?.programSha256 !== bundle.programSha256) {
    add(contradictions, 'program-record-unavailable', 'gvm-program', bundle.programSha256 ?? null);
  } else {
    try { validateSgosRecord(bundle.program); } catch {
      add(contradictions, 'program-record-tampered', 'gvm-program', bundle.programSha256);
    }
    const core = structuredClone(bundle.program); delete core.programSha256;
    if (sgosSha256(core) !== bundle.programSha256) {
      add(contradictions, 'program-record-tampered', 'gvm-program', bundle.programSha256);
    }
  }
  if (bundle.processBinding === null
      || bundle.processBinding?.bindingSha256 !== bundle.processBindingSha256) {
    add(contradictions, 'process-binding-record-unavailable', 'process-binding', bundle.processBindingSha256 ?? null);
  } else {
    try { validateSgosRecord(bundle.processBinding); } catch {
      add(contradictions, 'process-binding-record-tampered', 'process-binding', bundle.processBindingSha256);
    }
    const core = structuredClone(bundle.processBinding); delete core.bindingSha256;
    if (sgosSha256(core) !== bundle.processBindingSha256) {
      add(contradictions, 'process-binding-record-tampered', 'process-binding', bundle.processBindingSha256);
    }
  }

  const records = Array.isArray(bundle.records) ? bundle.records : [];
  if (!Array.isArray(bundle.records)) add(contradictions, 'bundle-field-invalid', 'records', null);
  const order = isCanonicalOrder(records, recordOrder,
    (entry) => recordIdentity(entry.family ?? '', entry.recordSha256 ?? ''));
  if (!order.valid) add(contradictions,
    order.duplicate ? 'bundle-record-duplicated' : 'bundle-record-reordered', 'records', null);
  const wrappers = records.map((entry) => validateRecordWrapper(entry, contradictions));
  const { indexes } = validateRecordIndexes(bundle, wrappers, contradictions);
  validateControlLineage(bundle, indexes, contradictions);
  const tools = validateTools(bundle, contradictions, gaps);
  validateExecutionLeases(bundle, contradictions, gaps);
  semanticReferences(bundle, wrappers, tools, contradictions, gaps);
  validateSourceIntegrity(bundle, contradictions, gaps);

  if (bundle.taskContractSha256 != null) {
    add(contradictions, 'bundle-shape-invalid', 'taskContractSha256', null);
  }
  add(gaps, 'task-contract-bytes-not-exported', 'task-contract', bundle.process?.taskContractSha256 ?? null);
  add(gaps, 'approved-authority-bundle-not-exported', 'authority', bundle.processBindingSha256 ?? null);
  if (bundle.program?.taskTemplates?.some((task) => task.opcode === 'AGENT')) {
    add(gaps, 'execution-event-records-not-durable', 'process', bundle.processId ?? null);
  }
  if (bundle.controlLineage?.some((entry) => entry?.event?.action === 'process-paused')) {
    add(gaps, 'stop-quiescence-receipts-not-durable', 'process', bundle.processId ?? null);
  }

  const finalGaps = canonicalIssues(gaps);
  let finalContradictions = canonicalIssues(contradictions);
  const completeness = finalContradictions.length
    ? 'contradictory' : finalGaps.length ? 'incomplete' : 'complete';
  if (bundle.evidenceCompleteness !== completeness) {
    finalContradictions = canonicalIssues([
      ...finalContradictions,
      issue('bundle-completeness-overclaimed', 'evidenceCompleteness', bundle.evidenceCompleteness ?? null)
    ]);
  }
  const normalizedContradictions = finalContradictions;
  return Object.freeze({
    status: normalizedContradictions.length ? 'failed' : finalGaps.length ? 'incomplete' : 'verified',
    integrity: normalizedContradictions.length ? 'failed' : 'valid',
    evidenceCompleteness: normalizedContradictions.length ? 'contradictory' : completeness,
    processId: typeof bundle.processId === 'string' ? bundle.processId : null,
    bundleSha256: HASH.test(String(bundle.bundleSha256 ?? '')) ? bundle.bundleSha256 : null,
    assurance: ASSURANCE,
    gaps: finalGaps,
    contradictions: normalizedContradictions
  });
}

/** Canonical portable bytes. Verification remains read-only and repository-independent. */
export function serializeSgosProcessEvidence(bundle, options = {}) {
  const report = verifySgosProcessEvidence(bundle);
  if (report.integrity !== 'valid') {
    fail('Cannot serialize invalid SGOS Process evidence.', 'SGOS_PROCESS_EVIDENCE_INVALID', {
      contradictions: report.contradictions
    });
  }
  return boundedCanonicalBytes(bundle, options);
}

/** Parse and verify bounded bundle bytes from any directory or transport. */
export function parseSgosProcessEvidence(bytes, options = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8');
  const maximumBytes = portableByteLimit(options);
  if (buffer.length > maximumBytes) {
    fail('SGOS Process evidence exceeds the configured portable bundle limit.',
      'SGOS_PROCESS_EVIDENCE_LIMIT', { maximumBytes, actualBytes: buffer.length });
  }
  let value;
  try { value = JSON.parse(buffer.toString('utf8')); } catch (error) {
    fail('SGOS Process evidence is not valid JSON.', 'SGOS_PROCESS_EVIDENCE_INVALID', {
      cause: error?.message ?? String(error)
    });
  }
  return Object.freeze({ bundle: value, report: verifySgosProcessEvidence(value) });
}

export const SGOS_PROCESS_EVIDENCE_FORMAT = FORMAT;
export const SGOS_PROCESS_EVIDENCE_MAXIMUM_BYTES = MAX_BUNDLE_BYTES;
