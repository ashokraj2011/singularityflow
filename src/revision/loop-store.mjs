/**
 * Machine-local REV loop journal. This is an inert storage primitive, not an execution bridge or a
 * shared/multi-machine head. A numbered, exclusively linked entry is both the append-only event and
 * the local head CAS slot; an admitted interval and its bound precheck cannot be split by a crash.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { gitCommonDir } from '../git.mjs';
import { secureWindowsAuthAcl } from '../mcp-auth-profile.mjs';
import { canonicalJson, recordSha256 } from '../records.mjs';
import { readRecord, stampCurrentRecord } from '../schema-migrations.mjs';
import { withSubjectLock } from '../subject-lock.mjs';
import { SingularityFlowError } from '../util.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CANDIDATE_ID = /^CAN-[A-Za-z0-9._:-]{6,127}$/;
const MAX_ENTRIES = 512;
const MAX_ENTRY_BYTES = 128 * 1024;
const FILE = /^(\d{10})\.json$/;
const TEMP = /^\.\d{10}\.json\.tmp-\d+-[a-f0-9-]{36}$/;
const CONTEXT_KEYS = [
  'repositorySha256', 'headCommit', 'sourceTreeSha256', 'configSha256',
  'workflowSha256', 'approvedIntentSha256', 'routeContractSha256',
  'proofProfileSha256', 'editorDiskIndexBaselineSha256'
];

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }
function requiredHash(value, label) {
  if (!HASH.test(String(value ?? ''))) fail('REV_LOOP_INVALID', `${label} needs an exact SHA-256 digest.`);
}
function identifier(value, label) {
  if (!ID.test(String(value ?? ''))) fail('REV_LOOP_INVALID', `${label} is not a bounded identifier.`);
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail('REV_LOOP_INVALID', `${label} has missing or unknown authority-bearing fields.`);
  }
}
function selfHash(record, field, kind) {
  if (record?.kind !== kind) {
    fail('REV_LOOP_INVALID', `Expected an exact ${kind} record.`);
  }
  try { readRecord(kind, record); }
  catch { fail('REV_LOOP_INVALID', `Expected a readable ${kind} record.`); }
  requiredHash(record[field], field);
  const { [field]: digest, ...core } = record;
  if (hash(core) !== digest) fail('REV_LOOP_INVALID', `${kind} failed its content hash.`);
}
function boundedJson(value, label, max = MAX_ENTRY_BYTES) {
  let bytes;
  try {
    bytes = Buffer.byteLength(canonicalJson(value));
    const visit = (item) => {
      if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
      if (typeof item === 'number' && Number.isFinite(item)) return;
      if (Array.isArray(item)) { item.forEach(visit); return; }
      if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) {
        throw new Error('non-JSON value');
      }
      for (const [key, child] of Object.entries(item)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('unsafe key');
        visit(child);
      }
    };
    visit(value);
  } catch { fail('REV_LOOP_INVALID', `${label} must be plain JSON.`); }
  if (bytes > max) fail('REV_LOOP_LIMIT', `${label} exceeds the local journal limit.`);
}
function validateContext(context) {
  exactKeys(context, CONTEXT_KEYS, 'Loop context');
  for (const key of CONTEXT_KEYS) {
    if (key === 'headCommit') {
      if (!OID.test(String(context[key] ?? ''))) fail('REV_LOOP_INVALID', 'Loop context needs an exact HEAD commit.');
    } else requiredHash(context[key], key);
  }
}
function validateCandidate(candidate) {
  exactKeys(candidate, ['candidateId', 'candidateSha256', 'candidateRefSha256', 'candidateTree'], 'Candidate reference');
  if (!CANDIDATE_ID.test(String(candidate.candidateId ?? '')) || !OID.test(String(candidate.candidateTree ?? ''))) {
    fail('REV_LOOP_INVALID', 'Loop candidate needs an exact retained ID and tree.');
  }
  requiredHash(candidate.candidateSha256, 'candidateSha256');
  requiredHash(candidate.candidateRefSha256, 'candidateRefSha256');
}
function validateOpen(transition) {
  exactKeys(transition, ['type', 'loopId', 'initialCandidate'], 'Open-loop transition');
  identifier(transition.loopId, 'Loop ID');
  validateCandidate(transition.initialCandidate);
}
function validateSnapshot(snapshot, candidate, scope, context, revision, transitionSha256) {
  const keys = [
    'candidateId', 'candidateSha256', 'candidateRefSha256', 'candidateTree', 'phaseGeneration',
    'headRevision', 'headTransitionSha256', 'workflowSha256', 'configSha256',
    'proofProfileSha256', 'editorDiskIndexBaselineSha256', 'headSnapshotSha256'
  ];
  exactKeys(snapshot, keys, 'Proposed head snapshot');
  requiredHash(snapshot.headSnapshotSha256, 'headSnapshotSha256');
  const { headSnapshotSha256, ...snapshotCore } = snapshot;
  if (hash(snapshotCore) !== headSnapshotSha256
      || snapshot.candidateId !== candidate.candidateId
      || snapshot.candidateSha256 !== candidate.candidateSha256
      || snapshot.candidateRefSha256 !== candidate.candidateRefSha256
      || snapshot.candidateTree !== candidate.candidateTree
      || snapshot.phaseGeneration !== scope.phaseGeneration
      || snapshot.headRevision !== revision
      || snapshot.headTransitionSha256 !== transitionSha256
      || snapshot.workflowSha256 !== context.workflowSha256
      || snapshot.configSha256 !== context.configSha256
      || snapshot.proofProfileSha256 !== context.proofProfileSha256
      || snapshot.editorDiskIndexBaselineSha256 !== context.editorDiskIndexBaselineSha256) {
    fail('REV_LOOP_INVALID', 'Proposed snapshot differs from the exact selected head inputs.');
  }
}
function validateHeadTransition(headTransition, previous, destination, context) {
  selfHash(headTransition, 'transitionSha256', 'revision-head-transition');
  exactKeys(headTransition, [
    'schemaVersion', 'kind', 'expectedLoopRevision', 'expectedHeadTransitionSha256',
    'fromCandidateRefSha256', 'toCandidateRefSha256',
    'worktreeIndexEditorPreimageSha256', 'materializedPostimageSha256',
    'reason', 'transitionSha256'
  ], 'Head transition');
  requiredHash(headTransition.worktreeIndexEditorPreimageSha256, 'Head preimage');
  requiredHash(headTransition.materializedPostimageSha256, 'Head postimage');
  if (typeof headTransition.reason !== 'string' || !headTransition.reason
      || headTransition.reason.length > 128) fail('REV_LOOP_INVALID', 'Head transition needs a bounded reason.');
  if (headTransition.expectedLoopRevision !== previous.revision
      || headTransition.expectedHeadTransitionSha256 !== previous.headTransitionSha256
      || headTransition.fromCandidateRefSha256 !== previous.head.candidateRefSha256
      || headTransition.toCandidateRefSha256 !== destination.candidateRefSha256) {
    fail('REV_LOOP_ADVANCED', 'Head transition does not compare-and-swap the selected parent.');
  }
  if (headTransition.worktreeIndexEditorPreimageSha256
        !== previous.context.editorDiskIndexBaselineSha256
      || headTransition.materializedPostimageSha256
        !== context.editorDiskIndexBaselineSha256) {
    fail('REV_LOOP_STALE', 'Head materialization preimage or postimage differs from live context.');
  }
}
function validateCommit(transition, scope, previous, context, revision) {
  exactKeys(transition, ['type', 'loopId', 'interval', 'headTransition', 'headSnapshot', 'precheck'], 'Interval commit');
  if (transition.loopId !== previous.loopId) fail('REV_LOOP_SCOPE', 'Interval belongs to another loop.');
  const { interval, headTransition, headSnapshot, precheck } = transition;
  selfHash(interval, 'intervalSha256', 'revision-interval');
  validateCandidate(interval.resultCandidate);
  validateHeadTransition(headTransition, previous, interval.resultCandidate, context);
  selfHash(precheck, 'precheckSha256', 'revision-precheck');
  if (interval.subject?.workId !== scope.workId || interval.subject?.phaseId !== scope.phaseId
      || interval.subject?.phaseGeneration !== scope.phaseGeneration || interval.status !== 'prechecked'
      || !ID.test(String(interval.intervalId ?? '')) || !Number.isSafeInteger(interval.sequence)
      || interval.sequence < 1 || interval.precheckSha256 !== precheck.precheckSha256) {
    fail('REV_LOOP_INVALID', 'Interval lacks exact phase, sequence, or precheck binding.');
  }
  if (interval.parentCandidate?.candidateId !== previous.head.candidateId
      || interval.parentCandidate?.candidateSha256 !== previous.head.candidateSha256
      || interval.parentCandidate?.candidateRefSha256 !== previous.head.candidateRefSha256
      || interval.sequence !== previous.intervalSequence + 1) {
    fail('REV_LOOP_ADVANCED', 'Interval does not extend the selected parent candidate and sequence.');
  }
  validateSnapshot(headSnapshot, interval.resultCandidate, scope, context, revision,
    headTransition.transitionSha256);
  const candidate = interval.resultCandidate;
  if (precheck.candidateId !== candidate.candidateId
      || precheck.candidateSha256 !== candidate.candidateSha256
      || precheck.candidateRefSha256 !== candidate.candidateRefSha256
      || precheck.candidateTree !== candidate.candidateTree
      || precheck.phaseGeneration !== scope.phaseGeneration
      || precheck.headRevision !== revision
      || precheck.headTransitionSha256 !== headTransition.transitionSha256
      || precheck.headSnapshotSha256 !== headSnapshot.headSnapshotSha256
      || precheck.workflowSha256 !== context.workflowSha256
      || precheck.configSha256 !== context.configSha256
      || precheck.editorDiskIndexBaselineSha256 !== context.editorDiskIndexBaselineSha256
      || precheck.proofProfileSha256 !== context.proofProfileSha256) {
    fail('REV_LOOP_INVALID', 'Precheck is not bound to the exact proposed head.');
  }
}
function validateSelect(transition, scope, previous, context, revision, candidateHistory) {
  exactKeys(transition, ['type', 'loopId', 'selectedCandidate', 'headTransition', 'headSnapshot'],
    'Select-head transition');
  if (transition.loopId !== previous.loopId) fail('REV_LOOP_SCOPE', 'Head selection belongs to another loop.');
  validateCandidate(transition.selectedCandidate);
  const historical = candidateHistory.get(transition.selectedCandidate.candidateRefSha256);
  if (!historical || hash(historical.candidate) !== hash(transition.selectedCandidate)
      || transition.selectedCandidate.candidateRefSha256 === previous.head.candidateRefSha256) {
    fail('REV_LOOP_INVALID', 'Selection must restore a different exact retained candidate from this loop.');
  }
  validateHeadTransition(transition.headTransition, previous, transition.selectedCandidate, context);
  if (!['restore', 'discard', 'developer-rejected-result'].includes(transition.headTransition.reason)) {
    fail('REV_LOOP_INVALID', 'Selection reason must be restore or discard.');
  }
  validateSnapshot(transition.headSnapshot, transition.selectedCandidate, scope, context,
    revision, transition.headTransition.transitionSha256);
  return historical;
}
function logicalHead(records, scope) {
  let state = null;
  const keys = new Set();
  const intervalIds = new Set();
  const candidateHistory = new Map();
  for (const entry of records) {
    if (keys.has(entry.idempotencyKeySha256)) fail('REV_LOOP_CORRUPT', 'Journal reuses an idempotency key.');
    keys.add(entry.idempotencyKeySha256);
    if (!state) {
      if (entry.revision !== 0 || entry.expectedRevision !== -1
          || entry.expectedHeadCandidateRefSha256 !== null || entry.transition.type !== 'open-loop') {
        fail('REV_LOOP_CORRUPT', 'Journal does not start with an open loop.');
      }
      validateOpen(entry.transition);
      candidateHistory.set(entry.transition.initialCandidate.candidateRefSha256,
        { candidate: entry.transition.initialCandidate, intervalId: null });
      state = {
        revision: 0, loopId: entry.transition.loopId, status: 'open',
        head: entry.transition.initialCandidate, headTransitionSha256: null,
        intervalSequence: 0, headIntervalId: null, entrySha256: entry.entrySha256,
        headSnapshotSha256: null, precheckSha256: null,
        context: entry.context
      };
      continue;
    }
    if (entry.expectedRevision !== state.revision || entry.revision !== state.revision + 1
        || entry.expectedHeadCandidateRefSha256 !== state.head.candidateRefSha256
        || entry.previousEntrySha256 !== state.entrySha256 || state.status !== 'open') {
      fail('REV_LOOP_CORRUPT', 'Journal chain, revision, or open-loop state is invalid.');
    }
    for (const key of CONTEXT_KEYS.filter((item) => item !== 'editorDiskIndexBaselineSha256')) {
      if (entry.context[key] !== state.context[key]) {
        fail('REV_LOOP_CORRUPT', 'Loop binding changed within one phase generation.');
      }
    }
    if (entry.transition.type === 'commit-interval') {
      validateCommit(entry.transition, scope, state, entry.context, entry.revision);
      if (candidateHistory.has(entry.transition.interval.resultCandidate.candidateRefSha256)) {
        fail('REV_LOOP_CORRUPT', 'Loop journal reuses a result candidate reference.');
      }
      if (intervalIds.has(entry.transition.interval.intervalId)) {
        fail('REV_LOOP_CORRUPT', 'Loop journal repeats an interval ID.');
      }
      intervalIds.add(entry.transition.interval.intervalId);
      candidateHistory.set(entry.transition.interval.resultCandidate.candidateRefSha256, {
        candidate: entry.transition.interval.resultCandidate,
        intervalId: entry.transition.interval.intervalId
      });
      state = {
        ...state, revision: entry.revision, head: entry.transition.interval.resultCandidate,
        headTransitionSha256: entry.transition.headTransition.transitionSha256,
        headIntervalId: entry.transition.interval.intervalId,
        intervalSequence: entry.transition.interval.sequence, entrySha256: entry.entrySha256,
        headSnapshotSha256: entry.transition.headSnapshot.headSnapshotSha256,
        precheckSha256: entry.transition.precheck.precheckSha256,
        context: entry.context
      };
    } else if (entry.transition.type === 'select-head') {
      const historical = validateSelect(entry.transition, scope, state, entry.context,
        entry.revision, candidateHistory);
      state = {
        ...state, revision: entry.revision, head: entry.transition.selectedCandidate,
        headTransitionSha256: entry.transition.headTransition.transitionSha256,
        headSnapshotSha256: entry.transition.headSnapshot.headSnapshotSha256,
        precheckSha256: null, headIntervalId: historical.intervalId,
        entrySha256: entry.entrySha256, context: entry.context
      };
    } else if (entry.transition.type === 'abandon-loop') {
      exactKeys(entry.transition, ['type', 'loopId'], 'Abandon-loop transition');
      if (entry.transition.loopId !== state.loopId) fail('REV_LOOP_SCOPE', 'Abandon belongs to another loop.');
      state = { ...state, revision: entry.revision, status: 'abandoned', entrySha256: entry.entrySha256,
        context: entry.context };
    } else fail('REV_LOOP_CORRUPT', 'Unsupported loop transition.');
  }
  return state;
}

async function privateDirectory(directory, { create, platform, windowsAcl, enforceMode }) {
  if (create) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
  }
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (!create && error?.code === 'ENOENT') return false; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('REV_LOOP_UNSAFE', 'Loop store directory is unsafe.');
  if (enforceMode) {
    if (platform === 'win32') await windowsAcl(directory, { directory: true, apply: create });
    else {
      if (create) await chmod(directory, 0o700);
      if (((await lstat(directory)).mode & 0o077) !== 0) fail('REV_LOOP_UNSAFE', 'Loop store directory is not private.');
    }
  }
  return true;
}
async function fileInfo(file, runtime) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_ENTRY_BYTES) {
    fail('REV_LOOP_CORRUPT', 'Journal entry is unsafe or out of bounds.');
  }
  if (runtime.platform === 'win32') await runtime.windowsAcl(file, { directory: false, apply: false });
  else if ((info.mode & 0o077) !== 0) fail('REV_LOOP_UNSAFE', 'Journal entry is not private.');
  return info;
}
async function readEntry(file, runtime) {
  const info = await fileInfo(file, runtime);
  const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) {
      fail('REV_LOOP_CORRUPT', 'Journal entry changed while opening.');
    }
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await handle.stat();
    if (count !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('REV_LOOP_CORRUPT', 'Journal entry changed while reading.');
    }
    let parsed;
    try { parsed = JSON.parse(bytes.subarray(0, count).toString('utf8')); }
    catch { fail('REV_LOOP_CORRUPT', 'Journal entry is not JSON.'); }
    if (canonicalJson(parsed) !== bytes.subarray(0, count).toString('utf8')) {
      fail('REV_LOOP_CORRUPT', 'Journal entry bytes are not canonical.');
    }
    return parsed;
  } finally { await handle.close(); }
}
async function flushDirectory(directory, platform) {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (platform !== 'win32' || !['EACCES', 'EPERM', 'EINVAL', 'EISDIR', 'ENOTSUP'].includes(error?.code)) {
      fail('REV_LOOP_DURABILITY_UNAVAILABLE', 'Loop journal directory could not be flushed.');
    }
  } finally { await handle?.close(); }
}
async function durableExclusive(file, bytes, runtime) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    if (runtime.platform === 'win32') await runtime.windowsAcl(temporary, { directory: false, apply: true });
    await link(temporary, file); // Atomic create-if-absent, including against a symlink.
    await flushDirectory(path.dirname(file), runtime.platform);
  } finally {
    await handle?.close();
    await unlink(temporary).catch((error) => { if (error?.code !== 'ENOENT') throw error; });
  }
}

/** No public runtime path imports this store; constructing it never activates execution. */
export function createRevisionLoopStore({
  root, workId, phaseId, phaseGeneration, assertCurrentContext, verifyRetainedCandidate,
  verifyCurrentPrecheck,
  platform = process.platform, windowsAcl = secureWindowsAuthAcl
}) {
  identifier(workId, 'Work ID');
  identifier(phaseId, 'Phase ID');
  if (!Number.isSafeInteger(phaseGeneration) || phaseGeneration < 0) {
    fail('REV_LOOP_INVALID', 'Phase generation must be non-negative.');
  }
  const scope = { workId, phaseId, phaseGeneration };
  const runtime = { platform, windowsAcl };
  const scopeHash = createHash('sha256').update(canonicalJson(scope)).digest('hex');

  async function journalDirectory(create = false) {
    const common = await realpath(gitCommonDir(root));
    if (!(await lstat(common)).isDirectory()) fail('REV_LOOP_UNSAFE', 'Git common directory is unsafe.');
    let directory = common;
    for (const [index, part] of ['singularity-flow', 'revisions', scopeHash, 'journal'].entries()) {
      directory = path.join(directory, part);
      const exists = await privateDirectory(directory, {
        create, platform, windowsAcl, enforceMode: index > 0
      });
      if (!exists) return null;
    }
    return directory;
  }
  async function entries() {
    const directory = await journalDirectory();
    if (!directory) return [];
    const names = await readdir(directory);
    if (names.length > MAX_ENTRIES * 2) fail('REV_LOOP_LIMIT', 'Loop journal exceeds its entry limit.');
    const files = [];
    for (const name of names) {
      if (TEMP.test(name)) continue; // Crash before the exclusive link never committed a revision.
      if (!FILE.test(name)) fail('REV_LOOP_CORRUPT', 'Loop journal contains an unexpected entry.');
      files.push(name);
    }
    files.sort();
    if (files.length > MAX_ENTRIES) fail('REV_LOOP_LIMIT', 'Loop journal exceeds its revision limit.');
    const result = [];
    for (const [index, name] of files.entries()) {
      if (Number(FILE.exec(name)[1]) !== index) fail('REV_LOOP_CORRUPT', 'Loop journal has a missing revision.');
      const entry = await readEntry(path.join(directory, name), runtime);
      try { readRecord('revision-loop-journal-entry', entry); }
      catch { fail('REV_LOOP_CORRUPT', 'Loop journal entry has an unreadable schema.'); }
      if (entry.kind !== 'revision-loop-journal-entry'
          || entry.revision !== index || entry.scope?.workId !== workId
          || entry.scope?.phaseId !== phaseId || entry.scope?.phaseGeneration !== phaseGeneration) {
        fail('REV_LOOP_CORRUPT', 'Loop journal entry has the wrong schema or phase.');
      }
      exactKeys(entry, [
        'schemaVersion', 'kind', 'scope', 'revision', 'expectedRevision',
        'expectedHeadCandidateRefSha256', 'previousEntrySha256',
        'idempotencyKeySha256', 'requestSha256', 'context', 'transition',
        'committedAt', 'entrySha256'
      ], 'Loop journal entry');
      exactKeys(entry.scope, ['workId', 'phaseId', 'phaseGeneration'], 'Loop journal subject');
      if (typeof entry.committedAt !== 'string'
          || !Number.isFinite(Date.parse(entry.committedAt))
          || new Date(entry.committedAt).toISOString() !== entry.committedAt) {
        fail('REV_LOOP_CORRUPT', 'Loop journal commit time is invalid.');
      }
      requiredHash(entry.entrySha256, 'entrySha256');
      requiredHash(entry.idempotencyKeySha256, 'idempotencyKeySha256');
      requiredHash(entry.requestSha256, 'requestSha256');
      const { entrySha256, ...core } = entry;
      if (hash(core) !== entrySha256) fail('REV_LOOP_CORRUPT', 'Loop journal entry failed its content hash.');
      validateContext(entry.context);
      if (entry.previousEntrySha256 !== (result.at(-1)?.entrySha256 ?? null)) {
        fail('REV_LOOP_CORRUPT', 'Loop journal hash chain is broken.');
      }
      result.push(entry);
    }
    logicalHead(result, scope);
    return result;
  }

  async function read() { return logicalHead(await entries(), scope); }
  async function list() { return entries(); }
  /** Compare retained references only. This does not inspect a candidate diff or run checks. */
  async function compare({ fromCandidateRefSha256, toCandidateRefSha256 }) {
    requiredHash(fromCandidateRefSha256, 'From candidate reference');
    requiredHash(toCandidateRefSha256, 'To candidate reference');
    const journal = await entries();
    const selected = logicalHead(journal, scope);
    const history = new Map();
    for (const entry of journal) {
      if (entry.transition.type === 'open-loop') history.set(
        entry.transition.initialCandidate.candidateRefSha256,
        { candidate: entry.transition.initialCandidate, intervalId: null }
      );
      if (entry.transition.type === 'commit-interval') history.set(
        entry.transition.interval.resultCandidate.candidateRefSha256,
        { candidate: entry.transition.interval.resultCandidate,
          intervalId: entry.transition.interval.intervalId }
      );
    }
    const from = history.get(fromCandidateRefSha256);
    const to = history.get(toCandidateRefSha256);
    if (!from || !to) fail('REV_LOOP_CANDIDATE_UNKNOWN', 'Comparison requires retained candidates in this local loop.');
    return {
      scope, kind: 'revision-candidate-reference-comparison',
      from, to, sameTree: from.candidate.candidateTree === to.candidate.candidateTree,
      selectedHeadRevision: selected.revision,
      selectedHeadCandidateRefSha256: selected.head.candidateRefSha256
    };
  }

  async function append({ expectedRevision, expectedHeadCandidateRefSha256 = null,
    context, idempotencyKey, transition }) {
    validateContext(context);
    identifier(idempotencyKey, 'Idempotency key');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < -1) {
      fail('REV_LOOP_INVALID', 'Expected loop revision is invalid.');
    }
    if (expectedHeadCandidateRefSha256 !== null) requiredHash(expectedHeadCandidateRefSha256, 'Expected head candidate');
    boundedJson(transition, 'Loop transition');
    // Take one immutable request snapshot before any lock wait or asynchronous authority callback.
    context = JSON.parse(JSON.stringify(context));
    transition = JSON.parse(JSON.stringify(transition));
    if (!transition || !['open-loop', 'commit-interval', 'select-head', 'abandon-loop'].includes(transition.type)) {
      fail('REV_LOOP_INVALID', 'Unsupported loop transition.');
    }
    if (typeof assertCurrentContext !== 'function') {
      fail('REV_LOOP_CONTEXT_REQUIRED', 'A live phase/context recheck is required before a local loop write.');
    }
    if (typeof verifyRetainedCandidate !== 'function') {
      fail('REV_LOOP_CANDIDATE_UNVERIFIED', 'A retained-candidate proof callback is required before a local loop write.');
    }
    if (transition.type === 'commit-interval' && typeof verifyCurrentPrecheck !== 'function') {
      fail('REV_LOOP_PRECHECK_UNVERIFIED', 'A current precheck-kernel proof callback is required before head advancement.');
    }
    const requestSha256 = hash({ scope, expectedRevision, expectedHeadCandidateRefSha256,
      context, idempotencyKey, transition });
    const keySha256 = `sha256:${createHash('sha256').update(idempotencyKey).digest('hex')}`;
    return withSubjectLock(root, { kind: 'story', id: workId }, async () => {
      if (await assertCurrentContext({ scope: structuredClone(scope), context: structuredClone(context) }) !== true) {
        fail('REV_LOOP_STALE', 'Current phase, generation, or context changed before the loop write.');
      }
      const directory = await journalDirectory(true);
      const journal = await entries();
      const replay = journal.find((entry) => entry.idempotencyKeySha256 === keySha256);
      if (replay) {
        if (replay.requestSha256 !== requestSha256) {
          fail('REV_LOOP_IDEMPOTENCY_CONFLICT', 'Idempotency key already names another loop transition.');
        }
        await flushDirectory(directory, platform);
        return replay;
      }
      const head = logicalHead(journal, scope);
      if ((head?.revision ?? -1) !== expectedRevision
          || (head?.head?.candidateRefSha256 ?? null) !== expectedHeadCandidateRefSha256) {
        fail('REV_LOOP_ADVANCED', 'Local loop head or parent candidate changed.');
      }
      if (head) {
        for (const key of CONTEXT_KEYS.filter((item) => item !== 'editorDiskIndexBaselineSha256')) {
          if (context[key] !== head.context[key]) {
            fail('REV_LOOP_STALE', 'Loop binding changed within one phase generation.');
          }
        }
      }
      const revision = expectedRevision + 1;
      if (revision >= MAX_ENTRIES) fail('REV_LOOP_LIMIT', 'Loop journal reached its revision limit.');
      if (!head) {
        if (transition.type !== 'open-loop') fail('REV_LOOP_INVALID', 'First transition must open the loop.');
        validateOpen(transition);
      } else if (head.status !== 'open') {
        fail('REV_LOOP_ADVANCED', 'Loop is no longer open.');
      } else if (transition.type === 'commit-interval') {
        validateCommit(transition, scope, head, context, revision);
        if (journal.some((entry) => entry.transition.type === 'commit-interval'
            && entry.transition.interval.intervalId === transition.interval.intervalId)) {
          fail('REV_LOOP_INVALID', 'Interval ID already belongs to an earlier revision.');
        }
      } else if (transition.type === 'select-head') {
        const history = new Map();
        for (const entry of journal) {
          if (entry.transition.type === 'open-loop') history.set(
            entry.transition.initialCandidate.candidateRefSha256,
            { candidate: entry.transition.initialCandidate, intervalId: null }
          );
          if (entry.transition.type === 'commit-interval') history.set(
            entry.transition.interval.resultCandidate.candidateRefSha256,
            { candidate: entry.transition.interval.resultCandidate,
              intervalId: entry.transition.interval.intervalId }
          );
        }
        validateSelect(transition, scope, head, context, revision, history);
      } else if (transition.type === 'abandon-loop') {
        exactKeys(transition, ['type', 'loopId'], 'Abandon-loop transition');
        if (transition.loopId !== head.loopId) fail('REV_LOOP_SCOPE', 'Abandon belongs to another loop.');
      } else fail('REV_LOOP_INVALID', 'An open loop cannot be opened again.');
      const destination = transition.type === 'open-loop' ? transition.initialCandidate
        : transition.type === 'commit-interval' ? transition.interval.resultCandidate
          : transition.type === 'select-head' ? transition.selectedCandidate : null;
      if ((head && await verifyRetainedCandidate(structuredClone(head.head), {
        scope: structuredClone(scope), context: structuredClone(context)
      }) !== true)
          || (destination && await verifyRetainedCandidate(structuredClone(destination), {
            scope: structuredClone(scope), context: structuredClone(context)
          }) !== true)) {
        fail('REV_LOOP_CANDIDATE_UNVERIFIED', 'Selected or parent candidate is not verified in its retained store.');
      }
      if (transition.type === 'commit-interval'
          && await verifyCurrentPrecheck(structuredClone(transition.precheck), {
            scope: structuredClone(scope), context: structuredClone(context),
            headSnapshot: structuredClone(transition.headSnapshot),
            interval: structuredClone(transition.interval)
          }) !== true) {
        fail('REV_LOOP_PRECHECK_UNVERIFIED', 'Precheck receipt was not recomputed from current exact inputs.');
      }
      // Candidate and precheck verification can await I/O. Recheck the phase before CAS.
      if (await assertCurrentContext({ scope: structuredClone(scope), context: structuredClone(context) }) !== true) {
        fail('REV_LOOP_STALE', 'Current phase or context changed during candidate verification.');
      }
      const core = stampCurrentRecord('revision-loop-journal-entry', {
        kind: 'revision-loop-journal-entry', scope, revision,
        expectedRevision, expectedHeadCandidateRefSha256,
        previousEntrySha256: journal.at(-1)?.entrySha256 ?? null,
        idempotencyKeySha256: keySha256, requestSha256, context, transition,
        committedAt: new Date().toISOString()
      });
      const entry = { ...core, entrySha256: hash(core) };
      const bytes = canonicalJson(entry);
      if (Buffer.byteLength(bytes) > MAX_ENTRY_BYTES) fail('REV_LOOP_LIMIT', 'Loop entry exceeds journal byte limit.');
      const file = path.join(directory, `${String(revision).padStart(10, '0')}.json`);
      try { await durableExclusive(file, bytes, runtime); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const latest = await entries();
        const winner = latest.find((item) => item.idempotencyKeySha256 === keySha256);
        if (winner?.requestSha256 === requestSha256) return winner;
        fail('REV_LOOP_ADVANCED', 'Another writer committed the local head revision.');
      }
      const persisted = await entries();
      if (persisted.at(-1)?.entrySha256 !== entry.entrySha256) {
        fail('REV_LOOP_CORRUPT', 'Committed loop entry did not round-trip.');
      }
      return persisted.at(-1);
    });
  }
  return Object.freeze({ scope, read, list, compare, append });
}
