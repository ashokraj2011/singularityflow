/**
 * Explicit saved-file capture for a single Code revision interval. Planning is read-only and
 * compares raw bytes; it never runs Git filters, hooks, project commands, or an editor command.
 * Freezing is opt-in and requires a trusted editor-buffer adapter plus independent admission.
 * Neither operation advances a REV loop head or publishes a Story generation.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { applicationPathContext, isApplicationPath } from '../application-paths.mjs';
import { gitDisabledHooksPath } from '../git-isolation-paths.mjs';
import { recordSha256 } from '../records.mjs';
import { repositoryCaseInsensitivePaths } from '../repository-change-set.mjs';
import { scannablePath, scanEntries, secretRefusal } from '../secrets.mjs';
import { run, SingularityFlowError } from '../util.mjs';
import { verifySgosRevisionCandidateReference } from './candidate-adapter.mjs';
import {
  executeIsolatedRevisionAttempt, freezeRevisionAttemptCandidate,
  registerRevisionDeclarativeEditDriver
} from './isolated-attempt.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_PATHS = 10_000;
const MAX_CHANGED = 128;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const HANDOFF = new WeakMap();

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function hash(value) { return `sha256:${recordSha256(value)}`; }
function sha(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function same(a, b) { return a?.mode === b?.mode && a?.oid === b?.oid; }

function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024
      || value !== value.normalize('NFC') || value.startsWith('/')
      || value.includes('\\') || /[\x00-\x1f\x7f:]/u.test(value)
      || value.split('/').some((part) => !part || part === '.' || part === '..'
        || part.length > 255 || part.toLowerCase() === '.git')) {
    fail('REV_MANUAL_PATH_UNSUPPORTED', 'A Git path is not a portable, safe application path.');
  }
  return value;
}

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith('GIT_') || normalized.startsWith('GCM_')) delete env[key];
  }
  return {
    ...env, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'
  };
}

function gitBytes(root, args) {
  const result = run('git', [
    '-c', `core.hooksPath=${gitDisabledHooksPath()}`,
    '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', ...args
  ], {
    cwd: root, env: gitEnv(), encoding: 'buffer', allowFailure: true,
    maxBuffer: 8 * 1024 * 1024, timeoutMs: 10_000, windowsHide: true
  });
  if (result.error || result.status !== 0) {
    fail('REV_MANUAL_GIT_UNAVAILABLE', 'The local Git snapshot could not be read safely.');
  }
  return Buffer.from(result.stdout);
}

function text(root, args) { return gitBytes(root, args).toString('utf8').trim(); }

function fileModeSupported(root) {
  const result = run('git', [
    '-c', `core.hooksPath=${gitDisabledHooksPath()}`,
    'config', '--bool', '--get', 'core.filemode'
  ], {
    cwd: root, env: gitEnv(), encoding: 'utf8', allowFailure: true,
    timeoutMs: 10_000, windowsHide: true
  });
  if (result.error || ![0, 1].includes(result.status)) {
    fail('REV_MANUAL_GIT_UNAVAILABLE', 'Git file-mode policy could not be read.');
  }
  return result.status === 0 ? result.stdout.trim() !== 'false' : true;
}

function nulRecords(buffer) {
  if (buffer.length && buffer.at(-1) !== 0) {
    fail('REV_MANUAL_GIT_INVALID', 'Git returned an incomplete NUL-delimited record.');
  }
  const records = buffer.toString('utf8').split('\0');
  records.pop();
  if (records.some((record) => record.includes('\ufffd'))) {
    fail('REV_MANUAL_PATH_UNSUPPORTED', 'Git returned a non-UTF-8 path.');
  }
  return records;
}

function treeMap(root, tree) {
  if (!OID.test(tree)) fail('REV_MANUAL_PARENT_INVALID', 'The candidate tree is invalid.');
  const entries = new Map();
  for (const line of nulRecords(gitBytes(root, ['ls-tree', '-rz', '--full-tree', tree]))) {
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/u.exec(line);
    if (!match) fail('REV_MANUAL_TREE_UNSUPPORTED', 'A Git tree contains an unsupported entry.');
    const item = safePath(match[4]);
    if (entries.has(item) || entries.size >= MAX_PATHS) {
      fail('REV_MANUAL_TREE_UNSUPPORTED', 'A Git tree has ambiguous paths or exceeds the path limit.');
    }
    entries.set(item, { mode: match[1], oid: match[3] });
  }
  return entries;
}

function indexMap(root) {
  const entries = new Map();
  for (const line of nulRecords(gitBytes(root, ['ls-files', '--stage', '-z']))) {
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}(?:[a-f0-9]{24})?) ([0-3])\t(.+)$/u.exec(line);
    if (!match) fail('REV_MANUAL_INDEX_UNSUPPORTED', 'The real Git index contains an unsupported entry.');
    const item = safePath(match[4]);
    if (match[3] !== '0' || entries.has(item) || entries.size >= MAX_PATHS) {
      fail('REV_MANUAL_INDEX_UNSUPPORTED', 'The real Git index is conflicted or exceeds the path limit.');
    }
    entries.set(item, { mode: match[1], oid: match[2] });
  }
  return entries;
}

function untrackedPaths(root) {
  const values = nulRecords(gitBytes(root, ['ls-files', '--others', '--exclude-standard', '-z']));
  if (values.length > MAX_PATHS) fail('REV_MANUAL_PATH_LIMIT', 'Too many untracked paths to inventory.');
  return values.map(safePath);
}

function gitBlobOid(bytes, algorithm) {
  return createHash(algorithm).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

async function diskEntry(root, relative, algorithm, budget, modeOverride = null) {
  const segments = relative.split('/');
  let target = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    target = path.join(target, segments[i]);
    let stat;
    try { stat = await lstat(target); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('REV_MANUAL_DISK_UNSUPPORTED', 'A saved path traverses a symlink or non-directory.');
    }
  }
  target = path.join(target, segments.at(-1));
  let stat;
  try { stat = await lstat(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
    fail('REV_MANUAL_DISK_UNSUPPORTED', 'A saved path is not a bounded regular file.');
  }
  budget.bytes += stat.size;
  if (budget.bytes > MAX_TOTAL_BYTES) {
    fail('REV_MANUAL_DISK_LIMIT', 'Saved application files exceed the inventory byte limit.');
  }
  let bytes;
  let after;
  try {
    bytes = await readFile(target);
    after = await lstat(target);
  } catch {
    fail('REV_MANUAL_DISK_CHANGED', 'A saved file changed during manual-capture inventory.');
  }
  if (!after.isFile() || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
      || after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino || bytes.length !== stat.size) {
    fail('REV_MANUAL_DISK_CHANGED', 'A saved file changed during manual-capture inventory.');
  }
  return {
    entry: { mode: modeOverride ?? (stat.mode & 0o111 ? '100755' : '100644'),
      oid: gitBlobOid(bytes, algorithm),
      sha256: sha(bytes), bytes: bytes.length },
    bytes
  };
}

function explicitPaths(values) {
  if (!Array.isArray(values) || values.length > MAX_CHANGED) {
    fail('REV_MANUAL_PATH_SELECTION_INVALID', 'Select an explicit bounded list of application paths.');
  }
  const selected = values.map(safePath);
  if (new Set(selected).size !== selected.length) {
    fail('REV_MANUAL_PATH_SELECTION_INVALID', 'Selected paths must be unique.');
  }
  return selected.sort();
}

function captureNote(note) {
  if (typeof note !== 'string' || !note.trim() || note.length > 1024
      || /[\x00-\x1f\x7f]/u.test(note)) {
    fail('REV_MANUAL_NOTE_REQUIRED', 'Manual capture needs an explicit bounded explanation.');
  }
  return note.trim();
}

function protectedPathGuards(config, workflow) {
  return [...new Set([
    ...(config?.governance?.protectedPaths ?? []),
    ...(workflow?.resolution?.capability?.policy?.protectedPaths ?? [])
  ].filter((value) => typeof value === 'string' && value.trim())
    .map((value) => value.replace(/\/$/u, '')))];
}

function assertNoProtectedManualPaths(root, drift, config, workflow) {
  const fold = repositoryCaseInsensitivePaths(root)
    ? (value) => value.toLocaleLowerCase('en-US') : (value) => value;
  const guards = protectedPathGuards(config, workflow).map(fold);
  const blocked = drift.filter((item) => item.candidateDrift).map((item) => item.path)
    .filter((item) => guards.some((guard) => fold(item) === guard
      || fold(item).startsWith(`${guard}/`)));
  if (blocked.length) {
    fail('REV_MANUAL_PROTECTED_PATH',
      `Manual revision cannot capture protected path(s): ${blocked.join(', ')}.`);
  }
  return Object.freeze({ status: 'pass', checkedPathCount: drift.length,
    guardCount: guards.length });
}

function assertNoManualSecrets(drift, savedBytes) {
  const entries = [];
  for (const item of drift.filter((candidate) => candidate.candidateDrift && candidate.saved)) {
    const bytes = savedBytes.get(item.path);
    if (!bytes) fail('REV_MANUAL_SECRET_SCAN_UNAVAILABLE',
      `Saved bytes for '${item.path}' are unavailable to the secret scanner.`);
    if (!scannablePath(item.path)) {
      fail('REV_MANUAL_SECRET_SCAN_UNAVAILABLE',
        `Saved path '${item.path}' has no registered content scanner.`);
    }
    const content = bytes.toString('utf8');
    if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) {
      fail('REV_MANUAL_SECRET_SCAN_UNAVAILABLE',
        `Saved path '${item.path}' is not valid UTF-8 and has no registered binary scanner.`);
    }
    entries.push({ path: item.path, content });
  }
  const scan = scanEntries(entries);
  if (scan.skipped.length || scan.waived.length) {
    fail('REV_MANUAL_SECRET_SCAN_UNAVAILABLE',
      'Every captured result byte must pass the installed secret scanner without skips or waivers.');
  }
  const refusal = secretRefusal(scan);
  if (refusal) fail('REV_MANUAL_SECRET_DETECTED', refusal);
  return Object.freeze({ status: 'pass', scanned: scan.scanned,
    skipped: scan.skipped.length, waived: scan.waived.length });
}

async function editorProof(verifySavedEditorBuffers, root, changedPaths) {
  if (typeof verifySavedEditorBuffers !== 'function') return null;
  let proof;
  try { proof = await verifySavedEditorBuffers({ root, changedPaths: Object.freeze([...changedPaths]) }); }
  catch { return null; }
  if (proof?.status !== 'all-saved' || !HASH.test(String(proof.snapshotSha256 ?? ''))) return null;
  const assurance = proof.assurance === 'user-asserted'
    ? 'user-asserted' : 'trusted-adapter';
  return { status: 'all-saved', snapshotSha256: proof.snapshotSha256, assurance };
}

/** Inventory exact Git/index/saved bytes against a retained selected parent; no mutation. */
export async function planManualRevisionCapture({
  root, subjectId, parentCandidate, allowedPaths, note, stagedDisposition, untrackedDisposition,
  ignoredPaths = [], config = {}, workflow = {}, verifySavedEditorBuffers
} = {}) {
  const requestedNote = captureNote(note);
  const selected = explicitPaths(allowedPaths);
  const ignored = explicitPaths(ignoredPaths);
  if (!root || typeof subjectId !== 'string' || !subjectId || subjectId.length > 256
      || !parentCandidate || !config || !workflow
      || await verifySgosRevisionCandidateReference(root, parentCandidate, { subjectId }) !== true) {
    fail('REV_MANUAL_PARENT_UNVERIFIED', 'Manual capture requires an exact retained parent candidate.');
  }
  const canonicalRoot = await realpath(root);
  const topLevel = await realpath(text(root, ['rev-parse', '--show-toplevel']));
  if (canonicalRoot !== topLevel && (process.platform !== 'win32'
      || canonicalRoot.toLowerCase() !== topLevel.toLowerCase())) {
    fail('REV_MANUAL_ROOT_INVALID', 'Manual capture requires the exact Git repository root.');
  }
  const baselineCommit = text(root, ['rev-parse', 'HEAD']);
  if (baselineCommit !== parentCandidate.repository.baselineCommit) {
    fail('REV_MANUAL_BASELINE_CHANGED', 'The Story HEAD no longer matches the selected candidate baseline.');
  }
  const objectFormat = text(root, ['rev-parse', '--show-object-format=storage']);
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    fail('REV_MANUAL_GIT_UNAVAILABLE', 'Git object format is unsupported.');
  }
  const headEntries = treeMap(root, text(root, ['rev-parse', 'HEAD^{tree}']));
  const candidateEntries = treeMap(root, parentCandidate.repository.candidateTree);
  const indexBefore = indexMap(root);
  const untracked = untrackedPaths(root);
  const honorFileMode = fileModeSupported(root);
  const paths = [...new Set([
    ...headEntries.keys(), ...candidateEntries.keys(), ...indexBefore.keys(), ...untracked
  ])].sort();
  if (paths.length > MAX_PATHS) fail('REV_MANUAL_PATH_LIMIT', 'Repository path inventory exceeds the limit.');
  const context = applicationPathContext(config, workflow);
  const budget = { bytes: 0 };
  const drift = [];
  const savedBytes = new Map();
  for (const item of paths) {
    const head = headEntries.get(item) ?? null;
    const index = indexBefore.get(item) ?? null;
    const candidate = candidateEntries.get(item) ?? null;
    const indexedMode = index?.mode ?? candidate?.mode ?? head?.mode ?? '100644';
    const modeOverride = !honorFileMode && ['100644', '100755'].includes(indexedMode)
      ? indexedMode : null;
    const saved = await diskEntry(canonicalRoot, item, objectFormat, budget, modeOverride);
    const disk = saved?.entry ?? null;
    const staged = !same(head, index);
    const unstaged = !same(index, disk);
    const candidateDrift = !same(candidate, disk);
    if (!staged && !unstaged && !candidateDrift) continue;
    if (drift.length >= MAX_CHANGED) {
      fail('REV_MANUAL_CHANGE_LIMIT', 'Too many changed paths for one manual capture.');
    }
    if (saved) savedBytes.set(item, Buffer.from(saved.bytes));
    drift.push({
      path: item, head, index, saved: disk, candidate,
      staged, unstaged, untracked: !head && !index && !!disk,
      candidateDrift,
      applicationPath: isApplicationPath(item, context)
        && !['.gitattributes', '.gitmodules'].includes(path.posix.basename(item).toLowerCase())
    });
  }
  const indexAfter = indexMap(root);
  if (hash([...indexBefore]) !== hash([...indexAfter])
      || text(root, ['rev-parse', 'HEAD']) !== baselineCommit
      || await verifySgosRevisionCandidateReference(root, parentCandidate, { subjectId }) !== true) {
    fail('REV_MANUAL_SNAPSHOT_CHANGED', 'The index, HEAD, or retained candidate changed during inventory.');
  }
  const ignoredSet = new Set(ignored);
  const unexpectedIgnored = ignored.filter((item) => {
    const observed = drift.find((entry) => entry.path === item);
    return !observed || observed.applicationPath;
  });
  if (unexpectedIgnored.length) {
    fail('REV_MANUAL_SCOPE_REFUSED',
      `Ignored paths are not exact observed non-application drift: ${unexpectedIgnored.join(', ')}.`);
  }
  const admittedDrift = drift.filter((item) => !ignoredSet.has(item.path));
  const changedPaths = admittedDrift.map((item) => item.path);
  const protectedPathCheck = assertNoProtectedManualPaths(canonicalRoot, admittedDrift, config, workflow);
  const secretScan = assertNoManualSecrets(admittedDrift, savedBytes);
  const buffers = await editorProof(verifySavedEditorBuffers, canonicalRoot, changedPaths);
  const findings = [];
  if (!buffers) findings.push({ code: 'REV_UNSAVED_BUFFERS', message: 'A trusted editor adapter has not proved all relevant buffers saved.' });
  if (admittedDrift.some((item) => !item.applicationPath || !['100644', '100755', undefined].includes(item.saved?.mode)
      || !['100644', '100755', undefined].includes(item.index?.mode)
      || !['100644', '100755', undefined].includes(item.candidate?.mode))) {
    findings.push({ code: 'REV_MANUAL_SCOPE_REFUSED', message: 'Changed paths include governed or unsupported Git entries.' });
  }
  if (hash(selected) !== hash(changedPaths)) {
    findings.push({ code: 'REV_MANUAL_PATH_SELECTION_REQUIRED', message: 'Explicit allowed paths must equal the exact saved/index drift inventory.' });
  }
  if (admittedDrift.some((item) => item.staged) && stagedDisposition !== 'capture-saved-disk') {
    findings.push({ code: 'REV_MANUAL_INDEX_DISPOSITION_REQUIRED', message: 'Staged changes require explicit saved-disk disposition.' });
  }
  if (admittedDrift.some((item) => item.untracked) && untrackedDisposition !== 'capture-listed') {
    findings.push({ code: 'REV_MANUAL_UNTRACKED_DISPOSITION_REQUIRED', message: 'Untracked files require explicit listed-file disposition.' });
  }
  if (!admittedDrift.some((item) => item.candidateDrift)) {
    findings.push({ code: 'REV_MANUAL_NO_CANDIDATE_DRIFT', message: 'Saved files do not differ from the selected frozen candidate.' });
  }
  const core = {
    schemaVersion: 1, kind: 'revision-manual-capture-plan',
    status: findings.length ? 'unavailable' : 'ready-for-explicit-freeze',
    subjectId,
    parentCandidateId: parentCandidate.candidateId,
    parentCandidateSha256: parentCandidate.candidateSha256,
    parentCandidateRefSha256: hash(parentCandidate),
    baselineCommit, candidateTree: parentCandidate.repository.candidateTree,
    indexSha256: hash([...indexAfter]),
    editorBuffers: buffers ?? { status: 'unverified', snapshotSha256: null },
    allowedPaths: selected, ignoredPaths: ignored, note: requestedNote,
    stagedDisposition: stagedDisposition ?? null,
    untrackedDisposition: untrackedDisposition ?? null,
    drift: admittedDrift, findings, protectedPathCheck, secretScan,
    ignoredFilesIncluded: false, loopHeadAdvanced: false, storyPublished: false
  };
  const plan = Object.freeze({ ...core, planSha256: hash(core) });
  HANDOFF.set(plan, { canonicalRoot, savedBytes, contextSha256: hash(context) });
  return plan;
}

/** Optional same-process child freeze; still no precheck, loop-head advance, or publication. */
export async function freezeManualRevisionCandidate({
  root, subjectId, parentCandidate, plan, config = {}, workflow = {}, verifySavedEditorBuffers,
  verifyAdmission, createdBy, createdAt
} = {}) {
  const handoff = plan && HANDOFF.get(plan);
  if (!handoff || plan.status !== 'ready-for-explicit-freeze' || plan.findings.length
      || plan.loopHeadAdvanced !== false || plan.storyPublished !== false) {
    // The identity-preserving WeakMap is intentional; serialized plans are not freeze authority.
    fail('REV_MANUAL_PLAN_UNVERIFIED', 'Freeze requires a live, ready, same-process manual plan.');
  }
  const { planSha256, ...planCore } = plan;
  if (hash(planCore) !== planSha256 || await realpath(root) !== handoff.canonicalRoot
      || hash(applicationPathContext(config, workflow)) !== handoff.contextSha256
      || hash(parentCandidate) !== plan.parentCandidateRefSha256 || subjectId !== plan.subjectId) {
    fail('REV_MANUAL_PLAN_STALE', 'The manual plan or application boundary changed.');
  }
  const fresh = await planManualRevisionCapture({
    root, subjectId, parentCandidate, allowedPaths: plan.allowedPaths, note: plan.note,
    ignoredPaths: plan.ignoredPaths,
    stagedDisposition: plan.stagedDisposition,
    untrackedDisposition: plan.untrackedDisposition,
    config, workflow, verifySavedEditorBuffers
  });
  if (fresh.planSha256 !== plan.planSha256) {
    fail('REV_MANUAL_PLAN_STALE', 'Saved bytes, index, or editor-buffer evidence changed after preview.');
  }
  if (typeof verifyAdmission !== 'function') {
    fail('REV_MANUAL_ADMISSION_REQUIRED', 'An independent manual-effect admission is required.');
  }
  const currentBytes = HANDOFF.get(fresh).savedBytes;
  const edits = fresh.drift.filter((item) => item.candidateDrift).map((item) => ({
    operation: item.saved ? 'write' : 'delete', path: item.path,
    ...(item.saved ? { bytes: currentBytes.get(item.path), executable: item.saved.mode === '100755' } : {})
  }));
  const driver = registerRevisionDeclarativeEditDriver(edits);
  const attemptResult = await executeIsolatedRevisionAttempt({
    root, parentCandidate, driver, allowedPaths: edits.map((item) => item.path), config, workflow
  });
  if (attemptResult.status === 'recovery-required') {
    fail('REV_ATTEMPT_ROLLBACK_FAILED',
      'The isolated saved-byte attempt could not prove cleanup; explicit recovery is required.');
  }
  if (attemptResult.status !== 'bounded-effects-collected' || attemptResult.cleanup?.verified !== true) {
    fail('REV_MANUAL_ATTEMPT_UNAVAILABLE', 'The isolated saved-byte attempt did not complete safely.');
  }
  const admitted = await verifyAdmission({ plan: fresh, attemptResult });
  if (admitted !== true) {
    fail('REV_MANUAL_ADMISSION_REQUIRED', 'Independent manual-effect admission refused the captured bytes.');
  }
  const finalSnapshot = await planManualRevisionCapture({
    root, subjectId, parentCandidate, allowedPaths: plan.allowedPaths, note: plan.note,
    ignoredPaths: plan.ignoredPaths,
    stagedDisposition: plan.stagedDisposition,
    untrackedDisposition: plan.untrackedDisposition,
    config, workflow, verifySavedEditorBuffers
  });
  if (finalSnapshot.planSha256 !== plan.planSha256) {
    fail('REV_MANUAL_PLAN_STALE', 'Saved bytes, index, or editor buffers changed during admission.');
  }
  const frozen = await freezeRevisionAttemptCandidate({
    root, parentCandidate, attemptResult, config, workflow,
    verifyAdmission: async () => true, createdBy, createdAt
  });
  return Object.freeze({
    schemaVersion: 1, kind: 'revision-manual-child-freeze',
    planSha256: plan.planSha256, note: plan.note,
    allowedPaths: plan.allowedPaths,
    frozen, loopHeadAdvanced: false, precheckRecorded: false, storyPublished: false
  });
}
