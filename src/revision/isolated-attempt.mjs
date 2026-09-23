/**
 * A deliberately narrow REV isolated-attempt foundation. This is not an agent executor:
 * only module-issued, declarative file edits can run. Arbitrary callbacks and shell commands
 * cannot prove process-tree quiescence or absence of network/cache effects and are refused.
 * This module never changes a Git ref, the visible worktree, or a REV loop head.
 */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applicationPathContext, isApplicationPath } from '../application-paths.mjs';
import { readLocalGitBlobs } from '../git-blob-batch.mjs';
import { gitDisabledHooksPath } from '../git-isolation-paths.mjs';
import { recordSha256 } from '../records.mjs';
import { freezeSgosCandidate, readSgosRetainedCandidate } from '../sgos/candidate-lifecycle.mjs';
import { run, SingularityFlowError } from '../util.mjs';
import {
  sgosRevisionCandidateReference, verifySgosRevisionCandidateReference
} from './candidate-adapter.mjs';

const MAX_FILES = 2_000;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_EDIT_FILES = 128;
const OBJECT_ID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const REGISTERED = new WeakMap();
const RESULT_BYTES = new WeakMap();

function fail(code, message) { throw new SingularityFlowError(message, { code }); }
function sha(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }
function hash(value) { return `sha256:${recordSha256(value)}`; }

function safePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || value !== value.normalize('NFC')
      || value.startsWith('/') || value.includes('\\') || value.includes('\0')
      || value.split('/').some((part) => !part || part === '.' || part === '..'
        || part.length > 255 || part.toLowerCase() === '.git'
        || /[\x00-\x1f\x7f:]/u.test(part))) {
    fail('REV_ATTEMPT_PATH_INVALID', 'Attempt path is not a safe relative application path.');
  }
  return value;
}

function safeEditPath(value) {
  const relative = safePath(value);
  if (['.gitattributes', '.gitmodules'].includes(path.posix.basename(relative).toLowerCase())) {
    fail('REV_ATTEMPT_PATH_INVALID', 'Git behavior metadata is not an application edit target.');
  }
  if (!isApplicationPath(relative)) {
    fail('REV_ATTEMPT_SCOPE_REFUSED', 'Governed state is not an application edit target.');
  }
  return relative;
}

function pathSet(values, context) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_EDIT_FILES) {
    fail('REV_ATTEMPT_SCOPE_INVALID', 'An explicit bounded set of allowed application paths is required.');
  }
  const paths = values.map(safeEditPath);
  if (paths.some((item) => !isApplicationPath(item, context))) {
    fail('REV_ATTEMPT_SCOPE_REFUSED', 'Allowed paths contain a configured governed resource.');
  }
  if (new Set(paths).size !== paths.length) {
    fail('REV_ATTEMPT_SCOPE_INVALID', 'Allowed application paths must be unique.');
  }
  return new Set(paths);
}

function localGitEnv() {
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

function gitRead(root, args, env) {
  const result = run('git', ['-c', `core.hooksPath=${gitDisabledHooksPath()}`, ...args], {
    cwd: root, env, encoding: 'buffer', allowFailure: true,
    maxBuffer: 4 * 1024 * 1024, timeoutMs: 10_000, windowsHide: true
  });
  if (result.error || result.status !== 0) {
    fail('REV_ATTEMPT_TREE_UNAVAILABLE', 'The retained parent tree could not be read locally.');
  }
  return Buffer.from(result.stdout);
}

function gitObject(root, args, env, input = undefined) {
  const result = run('git', [
    '-c', `core.hooksPath=${gitDisabledHooksPath()}`,
    '-c', 'commit.gpgSign=false', ...args
  ], {
    cwd: root, env, input, encoding: 'buffer', allowFailure: true,
    maxBuffer: 1024 * 1024, timeoutMs: 10_000, windowsHide: true
  });
  if (result.error || result.status !== 0) {
    fail('REV_ATTEMPT_FREEZE_GIT_FAILED', 'Private-index candidate object construction failed.');
  }
  return Buffer.from(result.stdout).toString('utf8').trim();
}

function treeEntries(root, tree, env) {
  if (!OBJECT_ID.test(String(tree ?? ''))
      || gitRead(root, ['cat-file', '-t', tree], env).toString('utf8').trim() !== 'tree') {
    fail('REV_ATTEMPT_TREE_UNAVAILABLE', 'The retained parent tree is not a local Git tree.');
  }
  const raw = gitRead(root, ['ls-tree', '-rz', '--full-tree', tree], env);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const result = [];
  const folded = new Set();
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf(0, offset);
    if (end < 0) fail('REV_ATTEMPT_TREE_INVALID', 'Git returned an incomplete tree entry.');
    let entry;
    try { entry = decoder.decode(raw.subarray(offset, end)); }
    catch { fail('REV_ATTEMPT_TREE_INVALID', 'Parent tree has a non-UTF-8 path.'); }
    const match = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t(.+)$/u.exec(entry);
    if (!match) fail('REV_ATTEMPT_TREE_UNSUPPORTED', 'Parent tree contains a symlink, submodule, or unsupported entry.');
    const relative = safePath(match[3]);
    const foldedPath = relative.toLowerCase();
    if (folded.has(foldedPath) || result.length >= MAX_FILES) {
      fail('REV_ATTEMPT_TREE_UNSUPPORTED', 'Parent tree has ambiguous paths or exceeds the file limit.');
    }
    folded.add(foldedPath);
    result.push({ path: relative, mode: match[1], objectId: match[2] });
    offset = end + 1;
  }
  return result;
}

async function materialize(root, tree, workspace, env) {
  const entries = treeEntries(root, tree, env);
  const blobs = readLocalGitBlobs(root, entries.map((entry) => entry.objectId), {
    env, maximumBytes: MAX_TREE_BYTES, maximumObjectBytes: MAX_FILE_BYTES,
    code: 'REV_ATTEMPT_TREE_UNAVAILABLE', limitCode: 'REV_ATTEMPT_TREE_LIMIT',
    label: 'REV parent tree'
  });
  const before = new Map();
  for (const entry of entries) {
    const bytes = blobs.get(entry.objectId);
    if (!bytes) fail('REV_ATTEMPT_TREE_UNAVAILABLE', 'A retained parent blob is missing.');
    const target = path.join(workspace, entry.path);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    await chmod(target, entry.mode === '100755' ? 0o700 : 0o600);
    before.set(entry.path, { sha256: sha(bytes), bytes: bytes.length, mode: entry.mode });
  }
  return before;
}

async function snapshot(workspace) {
  const files = new Map();
  let totalBytes = 0;
  async function walk(directory, prefix = '') {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const relative = safePath(prefix ? `${prefix}/${item.name}` : item.name);
      const target = path.join(directory, item.name);
      const stat = await lstat(target);
      if (stat.isDirectory()) {
        await walk(target, relative);
      } else if (stat.isFile() && !stat.isSymbolicLink()) {
        if (files.size >= MAX_FILES || stat.size > MAX_FILE_BYTES) {
          fail('REV_ATTEMPT_EFFECT_LIMIT', 'Attempt output exceeds the file limit.');
        }
        totalBytes += stat.size;
        if (totalBytes > MAX_TREE_BYTES) fail('REV_ATTEMPT_EFFECT_LIMIT', 'Attempt output exceeds the byte limit.');
        const bytes = await readFile(target);
        files.set(relative, { sha256: sha(bytes), bytes: bytes.length,
          mode: stat.mode & 0o111 ? '100755' : '100644' });
      } else {
        fail('REV_ATTEMPT_EFFECT_UNSUPPORTED', 'Attempt output contains a symlink or non-file effect.');
      }
    }
  }
  await walk(workspace);
  return files;
}

function difference(before, after, allowed, context) {
  const changes = [];
  for (const item of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const prior = before.get(item) ?? null;
    const next = after.get(item) ?? null;
    if (hash(prior) === hash(next)) continue;
    if (!allowed.has(item) || !isApplicationPath(item, context)) {
      fail('REV_ATTEMPT_SCOPE_REFUSED', 'Attempt changed a path outside the allowed application set.');
    }
    changes.push({ path: item, before: prior, after: next });
    if (changes.length > MAX_EDIT_FILES) fail('REV_ATTEMPT_EFFECT_LIMIT', 'Attempt changed too many files.');
  }
  return changes;
}

class DeclarativeEditDriver {
  constructor(edits) { this.edits = edits; }
  async start(workspace) {
    for (const edit of this.edits) {
      const target = path.join(workspace, edit.path);
      if (edit.operation === 'delete') {
        await rm(target, { force: true });
      } else {
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, edit.bytes, { flag: 'w', mode: 0o600 });
        await chmod(target, edit.executable ? 0o700 : 0o600);
      }
    }
    return { kind: 'in-process-declarative-edits', started: true };
  }
  async observe() { return { completed: true }; }
  async requestStop() { return { requested: true }; }
  async quiesce() { return { processTreeQuiescent: true, externalEffects: 'none-by-construction' }; }
  async collect(workspace) { return snapshot(workspace); }
}

/** Register only a bounded no-subprocess/no-network edit plan. This is not a provider adapter. */
export function registerRevisionDeclarativeEditDriver(edits) {
  if (!Array.isArray(edits) || !edits.length || edits.length > MAX_EDIT_FILES) {
    fail('REV_ATTEMPT_DRIVER_INVALID', 'A bounded nonempty edit plan is required.');
  }
  let totalBytes = 0;
  const seen = new Set();
  const plan = edits.map((edit) => {
    const relative = safeEditPath(edit?.path);
    if (seen.has(relative) || !['write', 'delete'].includes(edit?.operation)) {
      fail('REV_ATTEMPT_DRIVER_INVALID', 'Edit paths must be unique and use write or delete.');
    }
    seen.add(relative);
    if (edit.operation === 'delete') return { path: relative, operation: 'delete' };
    if (!Buffer.isBuffer(edit.bytes) && !(edit.bytes instanceof Uint8Array)) {
      fail('REV_ATTEMPT_DRIVER_INVALID', 'Write edits require exact byte content.');
    }
    const bytes = Buffer.from(edit.bytes);
    totalBytes += bytes.length;
    if (bytes.length > MAX_FILE_BYTES || totalBytes > MAX_EDIT_BYTES) {
      fail('REV_ATTEMPT_DRIVER_INVALID', 'Edit bytes exceed the declarative attempt limit.');
    }
    return { path: relative, operation: 'write', bytes, executable: edit.executable === true };
  });
  const token = Object.freeze({ kind: 'revision-declarative-edit-driver/v1' });
  REGISTERED.set(token, new DeclarativeEditDriver(plan));
  return token;
}

/**
 * Run one non-promoting isolated attempt. Unknown driver implementations are refused before
 * materialization. Any uncertain cleanup/quiescence or effect classification is recovery-required.
 */
export async function executeIsolatedRevisionAttempt({
  root, parentCandidate, driver, allowedPaths, config, workflow
} = {}) {
  const registered = driver && REGISTERED.get(driver);
  if (!registered) fail('REV_ATTEMPT_DRIVER_UNSUPPORTED',
    'Only a module-registered declarative driver is supported; callbacks and process drivers are unavailable.');
  if (!config || typeof config !== 'object' || !workflow || typeof workflow !== 'object') {
    fail('REV_ATTEMPT_SCOPE_INVALID', 'Configuration and workflow are required for application-path ownership.');
  }
  const context = applicationPathContext(config, workflow);
  const allowed = pathSet(allowedPaths, context);
  if (!root || !parentCandidate || parentCandidate.family !== 'sgos-candidate'
      || await verifySgosRevisionCandidateReference(root, parentCandidate) !== true) {
    fail('REV_PARENT_CANDIDATE_UNVERIFIED', 'The exact retained SGOS parent candidate is required.');
  }
  for (const edit of registered.edits) {
    if (!allowed.has(edit.path) || !isApplicationPath(edit.path, context)) {
      fail('REV_ATTEMPT_SCOPE_REFUSED', 'An edit is outside the allowed application set.');
    }
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-attempt-'));
  const workspace = path.join(temporary, 'candidate');
  let stage = 'materialize';
  let handle = null;
  let outcome;
  let collectedBytes = null;
  let cleanupVerified = false;
  try {
    await chmod(temporary, 0o700);
    await mkdir(workspace, { mode: 0o700 });
    const before = await materialize(root, parentCandidate.repository.candidateTree, workspace, localGitEnv());
    if (await verifySgosRevisionCandidateReference(root, parentCandidate) !== true) {
      fail('REV_PARENT_CANDIDATE_STALE', 'Retained parent changed during materialization.');
    }
    stage = 'started';
    handle = await registered.start(workspace);
    const observation = await registered.observe(handle);
    await registered.requestStop(handle);
    const quiescence = await registered.quiesce(handle);
    if (observation?.completed !== true || quiescence?.processTreeQuiescent !== true
        || quiescence?.externalEffects !== 'none-by-construction') {
      fail('REV_ATTEMPT_UNCERTAIN_EFFECTS', 'Attempt quiescence or external-effect absence is unproven.');
    }
    stage = 'collect';
    const after = await registered.collect(workspace);
    const changes = difference(before, after, allowed, context);
    collectedBytes = new Map();
    for (const change of changes) {
      if (change.after === null) {
        collectedBytes.set(change.path, null);
        continue;
      }
      const bytes = await readFile(path.join(workspace, change.path));
      if (bytes.length !== change.after.bytes || sha(bytes) !== change.after.sha256) {
        fail('REV_ATTEMPT_UNCERTAIN_EFFECTS', 'Collected result bytes changed after effect inventory.');
      }
      collectedBytes.set(change.path, bytes);
    }
    if (await verifySgosRevisionCandidateReference(root, parentCandidate) !== true) {
      fail('REV_PARENT_CANDIDATE_STALE', 'Retained parent changed during attempt.');
    }
    outcome = {
      schemaVersion: 1, kind: 'revision-isolated-attempt-evidence',
      status: 'bounded-effects-collected', parentCandidateId: parentCandidate.candidateId,
      parentCandidateSha256: parentCandidate.candidateSha256,
      parentTree: parentCandidate.repository.candidateTree,
      materializationSha256: hash([...before.entries()]),
      applicationPathContextSha256: hash(context),
      changes, effectSetSha256: hash(changes),
      quiescence, promotionAllowed: false, externalEffectsAllowed: false
    };
  } catch (error) {
    if (stage !== 'materialize') {
      // Even the internal no-process driver follows the stop/quiesce protocol on failure.
      try { await registered.requestStop(handle); await registered.quiesce(handle); }
      catch { /* The result remains recovery-required. */ }
    }
    outcome = {
      schemaVersion: 1, kind: 'revision-isolated-attempt-evidence',
      status: stage === 'materialize' ? 'refused' : 'recovery-required',
      code: error?.code ?? 'REV_ATTEMPT_UNCERTAIN_EFFECTS',
      parentCandidateId: parentCandidate.candidateId,
      parentTree: parentCandidate.repository.candidateTree,
      promotionAllowed: false, externalEffectsAllowed: false
    };
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true });
      try { await lstat(temporary); }
      catch (error) { if (error?.code === 'ENOENT') cleanupVerified = true; }
    } catch { cleanupVerified = false; }
  }
  const core = cleanupVerified
    ? { ...outcome, cleanup: { verified: true } }
    : { ...outcome, status: 'recovery-required', code: 'REV_ATTEMPT_ROLLBACK_FAILED',
      cleanup: { verified: false } };
  const result = { ...core, evidenceSha256: hash(core) };
  if (result.status === 'bounded-effects-collected' && collectedBytes) {
    RESULT_BYTES.set(result, {
      root: await realpath(root), candidateRefSha256: hash(parentCandidate),
      applicationPathContextSha256: hash(context), bytes: collectedBytes,
      evidenceSha256: result.evidenceSha256
    });
  }
  return result;
}

/**
 * Freeze an admitted, same-process result as an immutable child SGOS candidate. Admission is a
 * separate no-effect policy proof supplied by the caller; collecting bounded bytes is not itself
 * a secret, protected-path, or intent-policy verdict. This operation never advances a REV head.
 */
export async function freezeRevisionAttemptCandidate({
  root, parentCandidate, attemptResult, config, workflow,
  verifyAdmission, createdBy, createdAt
} = {}) {
  const handoff = attemptResult && RESULT_BYTES.get(attemptResult);
  if (!handoff || attemptResult.status !== 'bounded-effects-collected'
      || attemptResult.cleanup?.verified !== true
      || attemptResult.promotionAllowed !== false) {
    fail('REV_ATTEMPT_RESULT_UNVERIFIED', 'Freeze needs an admitted same-process isolated result.');
  }
  if (!config || typeof config !== 'object' || !workflow || typeof workflow !== 'object'
      || hash(applicationPathContext(config, workflow)) !== handoff.applicationPathContextSha256
      || attemptResult.applicationPathContextSha256 !== handoff.applicationPathContextSha256) {
    fail('REV_ATTEMPT_SCOPE_REFUSED', 'Application-path ownership changed after the attempt.');
  }
  const { evidenceSha256, ...evidenceCore } = attemptResult;
  if (hash(evidenceCore) !== evidenceSha256 || evidenceSha256 !== handoff.evidenceSha256
      || attemptResult.effectSetSha256 !== hash(attemptResult.changes)
      || !attemptResult.changes.length) {
    fail('REV_ATTEMPT_RESULT_UNVERIFIED', 'Attempt result is empty or changed after collection.');
  }
  if (typeof verifyAdmission !== 'function' || await verifyAdmission(attemptResult) !== true) {
    fail('REV_ATTEMPT_ADMISSION_REQUIRED', 'An independent scope, secret, and effect admission is required.');
  }
  if (await realpath(root) !== handoff.root || !parentCandidate
      || hash(parentCandidate) !== handoff.candidateRefSha256
      || await verifySgosRevisionCandidateReference(root, parentCandidate) !== true
      || attemptResult.parentCandidateId !== parentCandidate.candidateId
      || attemptResult.parentCandidateSha256 !== parentCandidate.candidateSha256
      || attemptResult.parentTree !== parentCandidate.repository.candidateTree) {
    fail('REV_PARENT_CANDIDATE_UNVERIFIED', 'The retained parent differs from the attempt handoff.');
  }
  const baselineCommit = gitRead(root, ['rev-parse', 'HEAD'], localGitEnv()).toString('utf8').trim();
  if (baselineCommit !== parentCandidate.repository.baselineCommit) {
    fail('REV_ATTEMPT_BASELINE_CHANGED', 'Current Story HEAD no longer matches the parent baseline.');
  }
  if (!createdBy || !['human', 'agent', 'service'].includes(createdBy.kind)
      || typeof createdBy.id !== 'string' || !createdBy.id) {
    fail('REV_ATTEMPT_CREATOR_INVALID', 'Child candidate needs a typed creator.');
  }
  const currentContext = applicationPathContext(config, workflow);
  for (const change of attemptResult.changes) {
    if (!isApplicationPath(change.path, currentContext) || !handoff.bytes.has(change.path)) {
      fail('REV_ATTEMPT_SCOPE_REFUSED', 'Collected result contains a forbidden application path.');
    }
    const bytes = handoff.bytes.get(change.path);
    if (bytes === null ? change.after !== null
      : change.after?.sha256 !== sha(bytes) || change.after.bytes !== bytes.length
        || !['100644', '100755'].includes(change.after.mode)) {
      fail('REV_ATTEMPT_RESULT_UNVERIFIED', 'Collected child bytes mismatch.');
    }
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-rev-index-'));
  let childTree;
  let childCommit;
  let objectWritesStarted = false;
  try {
    await chmod(temporary, 0o700);
    const env = {
      ...localGitEnv(), GIT_INDEX_FILE: path.join(temporary, 'index'),
      GIT_AUTHOR_NAME: 'Singularity Flow', GIT_AUTHOR_EMAIL: 'singularity-flow@localhost.invalid',
      GIT_COMMITTER_NAME: 'Singularity Flow', GIT_COMMITTER_EMAIL: 'singularity-flow@localhost.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
    };
    gitObject(root, ['read-tree', parentCandidate.repository.candidateTree], env);
    for (const change of attemptResult.changes) {
      const bytes = handoff.bytes.get(change.path);
      if (bytes === null) {
        gitObject(root, ['update-index', '--force-remove', '--', change.path], env);
      } else {
        objectWritesStarted = true;
        const blob = gitObject(root, ['hash-object', '-w', '--stdin'], env, bytes);
        if (!OBJECT_ID.test(blob)) fail('REV_ATTEMPT_FREEZE_GIT_FAILED', 'Git did not retain the child blob.');
        gitObject(root, ['update-index', '--add', '--cacheinfo',
          `${change.after.mode},${blob},${change.path}`], env);
      }
    }
    objectWritesStarted = true;
    childTree = gitObject(root, ['write-tree'], env);
    if (!OBJECT_ID.test(childTree) || childTree === parentCandidate.repository.candidateTree) {
      fail('REV_ATTEMPT_RESULT_UNVERIFIED', 'Child tree is absent or identical to its parent.');
    }
    const observed = gitObject(root, ['diff-tree', '-r', '--name-only', '-z',
      parentCandidate.repository.candidateTree, childTree], env);
    const changedPaths = observed.split('\0').filter(Boolean).sort();
    if (hash(changedPaths) !== hash(attemptResult.changes.map((item) => item.path).sort())) {
      fail('REV_ATTEMPT_RESULT_UNVERIFIED', 'Private-index tree differs from the collected effect set.');
    }
    childCommit = gitObject(root, ['commit-tree', childTree, '-p', baselineCommit], env,
      Buffer.from(`REV child of ${parentCandidate.candidateId}\n\nAttempt-Evidence-SHA256: ${evidenceSha256}\n`));
    if (!OBJECT_ID.test(childCommit)) fail('REV_ATTEMPT_FREEZE_GIT_FAILED', 'Git did not retain the child commit.');
  } catch (error) {
    if (objectWritesStarted) {
      fail('REV_ATTEMPT_FREEZE_RECOVERY_REQUIRED',
        'Candidate object construction stopped after Git object effects; inspect before retry.');
    }
    throw error;
  } finally {
    try { await rm(temporary, { recursive: true, force: true }); }
    catch {
      fail('REV_ATTEMPT_FREEZE_RECOVERY_REQUIRED',
        'Private candidate index cleanup could not be proven; inspect before retry.');
    }
  }
  if (gitRead(root, ['rev-parse', 'HEAD'], localGitEnv()).toString('utf8').trim() !== baselineCommit) {
    fail('REV_ATTEMPT_BASELINE_CHANGED', 'Story HEAD changed before candidate freeze.');
  }
  let retained;
  try {
    retained = await freezeSgosCandidate(root, {
      subjectId: (await readSgosRetainedCandidate(root, parentCandidate.candidateId)).candidate.subject.id,
      createdBy, ...(createdAt ? { createdAt } : {}),
      expectedBaseline: baselineCommit, baselineCommit,
      exactCandidateCommit: childCommit, expectedCandidateTree: childTree
    });
  } catch {
    fail('REV_ATTEMPT_FREEZE_RECOVERY_REQUIRED',
      'Candidate retention did not finish after Git object effects; inspect before retry.');
  }
  const childCandidate = await sgosRevisionCandidateReference(root, retained.candidate.candidateId);
  const core = {
    schemaVersion: 1, kind: 'revision-attempt-candidate-freeze',
    parentCandidateId: parentCandidate.candidateId,
    parentCandidateRefSha256: handoff.candidateRefSha256,
    parentTree: parentCandidate.repository.candidateTree,
    attemptEvidenceSha256: evidenceSha256,
    effectSetSha256: attemptResult.effectSetSha256,
    baselineCommit, childTree, childCommit, childCandidate,
    loopHeadAdvanced: false, testingVerificationComplete: false
  };
  return { ...core, freezeProofSha256: hash(core) };
}
