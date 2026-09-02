/** Immutable, Git-backed Candidate authority for the core Auto Story profile. */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { gitCommonDir } from '../git.mjs';
import { runRemoteGit } from '../git-execution.mjs';
import { canonicalJson } from '../records.mjs';
import {
  buildRepositoryTreeChangeSet, compareRepositoryIdentity
} from '../repository-change-set.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { SingularityFlowError, run } from '../util.mjs';
import { resolvePlatformProcess, tryWindowsTaskkill } from '../platform-process.mjs';
import { applicationChangeSetProjection, isApplicationChangePath } from '../work-intervals.mjs';
import { readAutoPrivateRecord, writeAutoPrivateRecord } from './auto-private-store.mjs';

const FLIGHT_ID = /^AFL-[A-F0-9]{26}$/;
const ATTEMPT_ID = /^AAT-[A-F0-9]{26}$/;
const CANDIDATE_ID = /^CAN-[A-F0-9]{26}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const GIT_OBJECT = /^[a-f0-9]{40,64}$/;
const CANDIDATE_ENV = Object.freeze({
  flightId: 'SFLOW_AUTO_CANDIDATE_FLIGHT_ID',
  candidateId: 'SFLOW_AUTO_CANDIDATE_ID',
  candidateSha256: 'SFLOW_AUTO_CANDIDATE_SHA256',
  bindingSha256: 'SFLOW_AUTO_CANDIDATE_BINDING_SHA256',
  verificationReceiptSha256: 'SFLOW_AUTO_CANDIDATE_VERIFICATION_SHA256'
});
const MAX_VERIFICATION_COMMANDS = 32;
const MAX_VERIFICATION_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CANDIDATE_RESOURCES = 20_000;
const PHASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RECOVERY_DISPOSITIONS = new Set(['authored', 'preserved-after-failure']);

function fail(message, code = 'AUTO_CANDIDATE_INVALID', details = null) {
  throw new SingularityFlowError(message, { code, details });
}

function digest(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? Buffer.from(value) : Buffer.from(canonicalJson(value));
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unsupported field '${key}'.`);
  }
}

function candidateDirectory(root, flightId) {
  if (!FLIGHT_ID.test(String(flightId ?? ''))) fail('Auto Candidate flight ID is invalid.');
  return path.join(gitCommonDir(root), 'singularity-flow', 'auto-flights', flightId, 'candidates');
}

function candidateFile(root, flightId, candidateId) {
  if (!CANDIDATE_ID.test(String(candidateId ?? ''))) fail('Auto Candidate ID is invalid.');
  return path.join(candidateDirectory(root, flightId), `${candidateId}.json`);
}

function verificationFile(root, flightId, candidateId) {
  return path.join(candidateDirectory(root, flightId), `${candidateId}.verification.json`);
}

function recoveryRef({
  flightId, phase, baseCheckpointSha256, disposition, attemptNumber,
  modelInvocations, attemptId
}) {
  if (!FLIGHT_ID.test(String(flightId ?? '')) || !ATTEMPT_ID.test(String(attemptId ?? ''))
      || !PHASE_ID.test(String(phase ?? '')) || !HASH.test(String(baseCheckpointSha256 ?? ''))
      || !RECOVERY_DISPOSITIONS.has(disposition)
      || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1
      || !Number.isSafeInteger(modelInvocations) || modelInvocations < attemptNumber) {
    fail('Auto Candidate recovery authority has an invalid identity.',
      'AUTO_CANDIDATE_RECOVERY_INVALID');
  }
  return [
    'refs/singularity-flow/auto-candidate-recovery', flightId, phase,
    baseCheckpointSha256.slice(7), disposition,
    String(attemptNumber), String(modelInvocations), attemptId
  ].join('/');
}

function parseRecoveryRef(value) {
  const match = String(value ?? '').match(
    /^refs\/singularity-flow\/auto-candidate-recovery\/(AFL-[A-F0-9]{26})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-f0-9]{64})\/(authored|preserved-after-failure)\/([1-9][0-9]*)\/([1-9][0-9]*)\/(AAT-[A-F0-9]{26})$/
  );
  if (!match) fail('Auto Candidate recovery ref is invalid.', 'AUTO_CANDIDATE_RECOVERY_CORRUPT');
  const parsed = {
    ref: value, flightId: match[1], phase: match[2],
    baseCheckpointSha256: `sha256:${match[3]}`, disposition: match[4],
    attemptNumber: Number(match[5]), modelInvocations: Number(match[6]), attemptId: match[7]
  };
  if (!Number.isSafeInteger(parsed.attemptNumber) || parsed.attemptNumber < 1
      || !Number.isSafeInteger(parsed.modelInvocations)
      || parsed.modelInvocations < parsed.attemptNumber) {
    fail('Auto Candidate recovery counters are invalid.', 'AUTO_CANDIDATE_RECOVERY_CORRUPT');
  }
  return Object.freeze(parsed);
}

function recoveryCommitMessage(context, binding) {
  return [
    `Auto Candidate recovery ${binding.candidateId}`,
    '',
    `Flight: ${context.flightId}`,
    `Attempt: ${context.attemptId}`,
    `Phase: ${context.phase}`,
    `Base-Checkpoint-SHA256: ${context.baseCheckpointSha256}`,
    `Disposition: ${context.disposition}`,
    `Attempt-Number: ${context.attemptNumber}`,
    `Model-Invocations: ${context.modelInvocations}`,
    `Binding-SHA256: ${binding.bindingSha256}`,
    ''
  ].join('\n');
}

function remoteGit(root, args, { operation = 'remote-probe', allowFailure = true } = {}) {
  return runRemoteGit(args, { cwd: root, operation, allowFailure });
}

function git(root, args, { env = process.env, input = null, allowFailure = false } = {}) {
  const result = run('git', args, {
    cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
    input, allowFailure, encoding: 'buffer'
  });
  if (!allowFailure && result.status !== 0) {
    fail(`Git Candidate operation failed: ${String(result.stderr || result.stdout).slice(0, 4096).trim()}`,
      'AUTO_CANDIDATE_GIT_FAILED');
  }
  return result;
}

function outputBytes(result) {
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

function outputText(result) {
  return outputBytes(result).toString('utf8').trim();
}

function temporaryIndexEnvironment(index) {
  return {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'Singularity Flow',
    GIT_AUTHOR_EMAIL: 'singularity-flow@localhost.invalid',
    GIT_COMMITTER_NAME: 'Singularity Flow',
    GIT_COMMITTER_EMAIL: 'singularity-flow@localhost.invalid',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
    GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'
  };
}

async function freezeWorktreeTree(root) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-candidate-'));
  const env = temporaryIndexEnvironment(path.join(temporary, 'index'));
  try {
    const status = outputBytes(git(root, [
      'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'
    ])).toString('utf8').split('\0').filter(Boolean);
    const dirtySubmodules = status.filter((entry) => {
      const submoduleState = entry.split(' ')[2] ?? '';
      return submoduleState.startsWith('S')
        && (submoduleState[2] === 'M' || submoduleState[3] === 'U');
    });
    if (dirtySubmodules.length) {
      fail(
        'Auto Candidate cannot freeze uncommitted files inside a submodule. Commit or discard '
          + 'the nested submodule changes, then retry so the Candidate can bind one exact gitlink.',
        'AUTO_CANDIDATE_DIRTY_SUBMODULE', { count: dirtySubmodules.length }
      );
    }
    git(root, ['read-tree', 'HEAD'], { env });
    git(root, ['add', '-A', '--', '.'], { env });
    const tree = outputText(git(root, ['write-tree'], { env }));
    if (!GIT_OBJECT.test(tree)) fail('Git did not produce a Candidate tree.', 'AUTO_CANDIDATE_GIT_FAILED');
    return { tree, env };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function parseTree(buffer, pathContext) {
  const fields = buffer.toString('utf8').split('\0').filter(Boolean);
  const manifest = [];
  for (const field of fields) {
    const tab = field.indexOf('\t');
    const [mode, type, object] = field.slice(0, tab).split(' ');
    const repositoryPath = field.slice(tab + 1);
    if (tab < 0 || !GIT_OBJECT.test(object)) continue;
    if (!isApplicationChangePath(repositoryPath, pathContext)) continue;
    const gitlink = mode === '160000' && type === 'commit';
    if (type !== 'blob' && !gitlink) {
      fail(`Auto Candidate encountered unsupported Git tree entry '${repositoryPath}'.`,
        'AUTO_CANDIDATE_UNSUPPORTED_TREE_ENTRY', { mode, type, path: repositoryPath });
    }
    manifest.push({
      path: repositoryPath,
      mode,
      kind: mode === '120000' ? 'symlink' : gitlink ? 'gitlink' : 'git-object',
      object
    });
  }
  manifest.sort((left, right) => compareRepositoryIdentity(left.path, right.path));
  return manifest;
}

export function autoCandidateSourceTreeSha256(root, tree, pathContext = null) {
  if (!GIT_OBJECT.test(String(tree ?? ''))) fail('Candidate tree object is invalid.', 'AUTO_CANDIDATE_CORRUPT');
  const listing = outputBytes(git(root, ['ls-tree', '-r', '-z', tree, '--']));
  return digest(parseTree(listing, pathContext));
}

function manifestFromChangeSet(changeSet, changeSetDigest = changeSet?.digest) {
  if (!changeSet || typeof changeSet !== 'object' || !HASH.test(String(changeSet.digest ?? ''))) {
    fail('Candidate freeze requires an exact application change-set digest.');
  }
  const entries = changeSet.entries ?? [];
  if (!Array.isArray(entries) || entries.length > MAX_CANDIDATE_RESOURCES) {
    fail(`Auto Candidate resource manifest must contain at most ${MAX_CANDIDATE_RESOURCES} entries.`,
      'AUTO_CANDIDATE_RESOURCE_LIMIT');
  }
  return {
    changeSetDigest,
    entries: entries.map((entry) => ({
      changeId: entry.changeId,
      status: entry.status,
      oldPath: entry.oldPath ?? null,
      newPath: entry.newPath ?? null,
      oldMode: entry.oldMode ?? null,
      newMode: entry.newMode ?? null,
      oldObject: entry.oldObject ?? null,
      newObject: entry.newObject ?? null,
      newContent: entry.newContent == null ? null : {
        kind: entry.newContent.kind,
        sha256: entry.newContent.sha256 ?? null,
        bytes: entry.newContent.bytes
      }
    }))
  };
}

export function autoAttemptId({ flightId, phase, attemptNumber, generationIntentId = null }) {
  if (!FLIGHT_ID.test(String(flightId ?? '')) || typeof phase !== 'string' || !phase
      || !Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
    fail('Auto Candidate attempt identity is invalid.');
  }
  return `AAT-${digest({ flightId, phase, attemptNumber, generationIntentId }).slice(7, 33).toUpperCase()}`;
}

function coreForBinding(record) {
  const core = structuredClone(record);
  delete core.bindingSha256;
  return core;
}

export function validateAutoCandidateBinding(record) {
  exactObject(record, [
    'schemaVersion', 'kind', 'flightId', 'attemptId', 'candidateId', 'candidateSha256',
    'baselineSha256', 'resourceManifestSha256', 'applicationChangeSetDigest',
    'applicationResourceDigest', 'origin', 'repository', 'resourceManifest', 'bindingSha256'
  ], 'Auto Candidate binding');
  if (record.kind !== 'auto-candidate-binding'
      || !FLIGHT_ID.test(String(record.flightId ?? ''))
      || !ATTEMPT_ID.test(String(record.attemptId ?? ''))
      || !CANDIDATE_ID.test(String(record.candidateId ?? ''))
      || ![record.candidateSha256, record.baselineSha256, record.resourceManifestSha256,
        record.applicationChangeSetDigest, record.applicationResourceDigest,
        record.bindingSha256].every((value) => HASH.test(String(value ?? '')))) {
    fail('Auto Candidate binding has an invalid closed-vocabulary identity.');
  }
  exactObject(record.origin, ['mode', 'executionUnitId', 'attemptKind'], 'Auto Candidate origin');
  if (record.origin.mode !== 'auto'
      || typeof record.origin.executionUnitId !== 'string' || !record.origin.executionUnitId.trim()
      || !['phase-authoring', 'repair-authoring'].includes(record.origin.attemptKind)) {
    fail('Auto Candidate origin is invalid.');
  }
  exactObject(record.repository, [
    'baselineCommit', 'baselineTree', 'candidateTree', 'candidateCommit', 'retainedRef'
  ], 'Auto Candidate repository binding');
  for (const field of ['baselineCommit', 'baselineTree', 'candidateTree', 'candidateCommit']) {
    if (!GIT_OBJECT.test(String(record.repository[field] ?? ''))) fail(`Auto Candidate ${field} is invalid.`);
  }
  const expectedRef = `refs/singularity-flow/auto-candidates/${record.flightId}/${record.candidateId}`;
  if (record.repository.retainedRef !== expectedRef
      || record.baselineSha256 !== digest({
        commit: record.repository.baselineCommit, tree: record.repository.baselineTree
      })) {
    fail('Auto Candidate repository authority is internally inconsistent.', 'AUTO_CANDIDATE_CORRUPT');
  }
  exactObject(record.resourceManifest, ['changeSetDigest', 'entries'], 'Auto Candidate resource manifest');
  if (!Array.isArray(record.resourceManifest.entries)
      || record.resourceManifest.entries.length > MAX_CANDIDATE_RESOURCES) {
    fail(`Auto Candidate resource manifest must contain at most ${MAX_CANDIDATE_RESOURCES} entries.`,
      'AUTO_CANDIDATE_RESOURCE_LIMIT');
  }
  if (record.resourceManifest.changeSetDigest !== record.applicationChangeSetDigest
      || record.resourceManifestSha256 !== digest(record.resourceManifest)
      || record.bindingSha256 !== digest(coreForBinding(record))) {
    fail('Auto Candidate binding failed its content integrity check.', 'AUTO_CANDIDATE_CORRUPT');
  }
  for (const [index, entry] of record.resourceManifest.entries.entries()) {
    exactObject(entry, [
      'changeId', 'status', 'oldPath', 'newPath', 'oldMode', 'newMode', 'oldObject',
      'newObject', 'newContent'
    ], `Auto Candidate resource ${index + 1}`);
    const repositoryPath = (value) => value == null || (
      typeof value === 'string' && value && !value.includes('\\')
      && !path.posix.isAbsolute(value) && !value.split('/').includes('..')
    );
    const mode = (value) => value == null
      || ['000000', '100644', '100755', '120000', '160000'].includes(value);
    const object = (value) => value == null || GIT_OBJECT.test(String(value));
    if (!HASH.test(String(entry.changeId ?? ''))
        || !['added', 'copied', 'deleted', 'modified', 'renamed', 'type-changed',
          'unmerged', 'unknown', 'broken'].includes(entry.status)
        || !repositoryPath(entry.oldPath) || !repositoryPath(entry.newPath)
        || !mode(entry.oldMode) || !mode(entry.newMode)
        || !object(entry.oldObject) || !object(entry.newObject)) {
      fail('Auto Candidate resource manifest contains an invalid entry.', 'AUTO_CANDIDATE_CORRUPT');
    }
    if (entry.newContent != null) {
      exactObject(entry.newContent, ['kind', 'sha256', 'bytes'],
        `Auto Candidate resource ${index + 1} content`);
      if (!['regular-file', 'symlink', 'missing', 'non-regular'].includes(entry.newContent.kind)
          || (entry.newContent.sha256 != null && !HASH.test(String(entry.newContent.sha256)))
          || !Number.isSafeInteger(entry.newContent.bytes) || entry.newContent.bytes < 0) {
        fail('Auto Candidate resource content identity is invalid.', 'AUTO_CANDIDATE_CORRUPT');
      }
    }
  }
  return Object.freeze(structuredClone(record));
}

/** Bind the application delta without including excluded transport/output tree objects. */
export function autoCandidateResourceDigest(changeSet, { baselineTree, candidateSha256 } = {}) {
  if (!GIT_OBJECT.test(String(baselineTree ?? ''))
      || !HASH.test(String(candidateSha256 ?? ''))) {
    fail('Auto Candidate resource digest identity is invalid.', 'AUTO_CANDIDATE_INVALID');
  }
  return digest({
    baselineTree,
    candidateSha256,
    entries: manifestFromChangeSet(changeSet).entries
  });
}

export async function freezeAutoCandidate(root, {
  flightId, attemptId, baselineCommit, pathContext = null,
  executionUnitId, attemptKind = 'phase-authoring', recoveryAuthority = null
} = {}) {
  if (!FLIGHT_ID.test(String(flightId ?? '')) || !ATTEMPT_ID.test(String(attemptId ?? ''))
      || !GIT_OBJECT.test(String(baselineCommit ?? ''))
      || typeof executionUnitId !== 'string' || !executionUnitId.trim()) {
    fail('Auto Candidate freeze identity is invalid.');
  }
  const baselineTree = outputText(git(root, ['rev-parse', '--verify', `${baselineCommit}^{tree}`]));
  const frozen = await freezeWorktreeTree(root);
  const candidateSha256 = autoCandidateSourceTreeSha256(root, frozen.tree, pathContext);
  // A baseline-to-worktree diff cannot recognize an unstaged rename: Git reports the old path as
  // deleted and the new path separately as untracked. The frozen Git tree can. Build the manifest
  // from the two immutable trees so add/delete/rename/mode/type identities survive independently of
  // index state, while retaining the lifecycle's canonical application change-set digest as the
  // publication equality boundary.
  const frozenChangeSet = applicationChangeSetProjection(buildRepositoryTreeChangeSet(root, {
    baseTree: baselineTree,
    targetTree: frozen.tree,
    subject: { kind: 'auto-candidate', id: attemptId }
  }), pathContext);
  const resourceManifest = manifestFromChangeSet(frozenChangeSet);
  const applicationResourceDigest = autoCandidateResourceDigest(frozenChangeSet, {
    baselineTree, candidateSha256
  });
  const baselineSha256 = digest({ commit: baselineCommit, tree: baselineTree });
  const resourceManifestSha256 = digest(resourceManifest);
  const identity = { flightId, attemptId, candidateSha256, baselineSha256, resourceManifestSha256 };
  const candidateId = `CAN-${digest(identity).slice(7, 33).toUpperCase()}`;
  const env = temporaryIndexEnvironment(path.join(os.tmpdir(), `unused-sflow-auto-${process.pid}`));
  const message = `Auto Candidate ${candidateId}\n\nCandidate-SHA256: ${candidateSha256}\n`;
  const candidateCommit = outputText(git(root, ['commit-tree', frozen.tree, '-p', baselineCommit], {
    env, input: message
  }));
  const retainedRef = `refs/singularity-flow/auto-candidates/${flightId}/${candidateId}`;
  const zero = '0'.repeat(candidateCommit.length);
  const created = git(root, ['update-ref', retainedRef, candidateCommit, zero], { allowFailure: true });
  if (created.status !== 0) {
    const observed = outputText(git(root, ['rev-parse', '--verify', retainedRef], { allowFailure: true }));
    if (observed !== candidateCommit) {
      fail('Auto Candidate retention ref already has different immutable bytes.', 'AUTO_CANDIDATE_CONFLICT');
    }
  }
  const core = {
    schemaVersion: currentSchemaVersion('auto-candidate-binding'),
    kind: 'auto-candidate-binding',
    flightId,
    attemptId,
    candidateId,
    candidateSha256,
    baselineSha256,
    resourceManifestSha256,
    applicationChangeSetDigest: frozenChangeSet.digest,
    applicationResourceDigest,
    origin: { mode: 'auto', executionUnitId, attemptKind },
    repository: { baselineCommit, baselineTree, candidateTree: frozen.tree, candidateCommit, retainedRef },
    resourceManifest
  };
  const binding = validateAutoCandidateBinding({ ...core, bindingSha256: digest(core) });
  await writeAutoPrivateRecord(
    root, candidateFile(root, flightId, candidateId), 'candidate', canonicalJson(binding), { immutable: true }
  );
  // Returning from freeze is the crash boundary: when an executor supplies recovery authority,
  // the exact binding and Candidate commit must already be reachable from the configured remote.
  // A hard process exit on the next instruction can then be recovered without another model call.
  if (recoveryAuthority != null) {
    await publishAutoCandidateRecoveryAuthority(root, binding, recoveryAuthority);
  }
  return binding;
}

/** Recompute exact source and delta identity from a new temporary tree without changing the index. */
export async function observeAutoCandidateWorktree(root, binding, pathContext = null) {
  validateAutoCandidateBinding(binding);
  const frozen = await freezeWorktreeTree(root);
  const applicationChangeSet = applicationChangeSetProjection(buildRepositoryTreeChangeSet(root, {
    baseTree: binding.repository.baselineTree,
    targetTree: frozen.tree,
    // The canonical change-set digest includes its subject. Reuse the frozen subject so an
    // unchanged Candidate reproduces exactly; a diagnostic-only observation subject would make
    // every verification differ even when all repository bytes were identical.
    subject: { kind: 'auto-candidate', id: binding.attemptId }
  }), pathContext);
  const candidateSha256 = autoCandidateSourceTreeSha256(root, frozen.tree, pathContext);
  return Object.freeze({
    candidateSha256,
    applicationChangeSetDigest: applicationChangeSet.digest,
    applicationResourceDigest: autoCandidateResourceDigest(applicationChangeSet, {
      baselineTree: binding.repository.baselineTree, candidateSha256
    }),
    tree: frozen.tree
  });
}

export async function readAutoCandidateBinding(root, { flightId, candidateId } = {}) {
  const raw = await readAutoPrivateRecord(
    root, candidateFile(root, flightId, candidateId), 'candidate', { optional: true }
  );
  if (raw == null) fail(`Auto Candidate '${candidateId}' was not found.`, 'AUTO_CANDIDATE_NOT_FOUND');
  return assertLocalCandidateRetention(
    root, parseCandidateBindingBytes(raw, { flightId, candidateId })
  );
}

function parseCandidateBindingBytes(raw, { flightId = null, candidateId = null } = {}) {
  let stored;
  try { stored = JSON.parse(raw); } catch (error) {
    fail(`Auto Candidate '${candidateId ?? 'recovery authority'}' is not valid JSON: ${error.message}`,
      'AUTO_CANDIDATE_CORRUPT');
  }
  // Verify the bytes in the version that was actually stored before any additive migration. A
  // migration may shape a record for reading; it must never manufacture integrity for old bytes.
  if (stored?.bindingSha256 !== digest(coreForBinding(stored))) {
    fail(`Auto Candidate '${candidateId}' failed its historical content hash.`, 'AUTO_CANDIDATE_CORRUPT');
  }
  const binding = validateAutoCandidateBinding(readRecord('auto-candidate-binding', stored).record);
  if ((flightId != null && binding.flightId !== flightId)
      || (candidateId != null && binding.candidateId !== candidateId)) {
    fail('Auto Candidate path and record identity differ.', 'AUTO_CANDIDATE_CORRUPT');
  }
  return binding;
}

function assertLocalCandidateRetention(root, binding) {
  const observedCommit = outputText(git(root, ['rev-parse', '--verify', binding.repository.retainedRef], {
    allowFailure: true
  }));
  const observedTree = observedCommit && outputText(git(root, ['rev-parse', `${observedCommit}^{tree}`], {
    allowFailure: true
  }));
  if (observedCommit !== binding.repository.candidateCommit || observedTree !== binding.repository.candidateTree) {
    fail('Auto Candidate retention ref no longer names the frozen tree.', 'AUTO_CANDIDATE_RETENTION_LOST');
  }
  return binding;
}

function remoteObjectAtRef(root, remote, ref) {
  const result = remoteGit(root, ['ls-remote', '--refs', '--', remote, ref], {
    operation: 'remote-probe', allowFailure: true
  });
  if (result.status !== 0) {
    fail('Auto Candidate authority could not read its configured remote ref.',
      'AUTO_CANDIDATE_REMOTE_UNAVAILABLE');
  }
  const lines = outputText(result).split(/\r?\n/u).filter(Boolean);
  if (lines.length > 1) {
    fail('Auto Candidate remote returned an ambiguous exact ref.', 'AUTO_CANDIDATE_REMOTE_CONFLICT');
  }
  return lines[0] ? lines[0].split(/\s+/u)[0] : null;
}

function buildRecoveryCommit(root, binding, context) {
  const bytes = canonicalJson(binding);
  const blob = outputText(git(root, ['hash-object', '-w', '--stdin'], { input: bytes }));
  if (!GIT_OBJECT.test(blob)) fail('Git did not create the Candidate recovery binding object.',
    'AUTO_CANDIDATE_GIT_FAILED');
  const tree = outputText(git(root, ['mktree'], {
    input: `100644 blob ${blob}\tbinding.json\n`
  }));
  if (!GIT_OBJECT.test(tree)) fail('Git did not create the Candidate recovery authority tree.',
    'AUTO_CANDIDATE_GIT_FAILED');
  const env = temporaryIndexEnvironment(path.join(os.tmpdir(), `unused-sflow-auto-recovery-${process.pid}`));
  const commit = outputText(git(root, [
    'commit-tree', tree, '-p', binding.repository.candidateCommit
  ], { env, input: recoveryCommitMessage(context, binding) }));
  if (!GIT_OBJECT.test(commit)) fail('Git did not create the Candidate recovery authority commit.',
    'AUTO_CANDIDATE_GIT_FAILED');
  return { commit, tree };
}

/**
 * Publish a deterministic immutable attempt journal before the Candidate freeze call returns.
 * The journal has the Candidate commit as its parent and the exact binding as its sole tree entry,
 * so fetching one ref brings both the recovery receipt and all frozen source objects.
 */
export async function publishAutoCandidateRecoveryAuthority(root, binding, {
  phase, baseCheckpointSha256, disposition = 'authored', attemptNumber,
  modelInvocations, remote = 'origin'
} = {}) {
  const retained = assertLocalCandidateRetention(root, validateAutoCandidateBinding(binding));
  if (typeof remote !== 'string' || !remote.trim()) {
    fail('Auto Candidate recovery requires a configured remote.',
      'AUTO_CANDIDATE_REMOTE_UNAVAILABLE');
  }
  const context = Object.freeze({
    flightId: retained.flightId, attemptId: retained.attemptId,
    phase, baseCheckpointSha256, disposition, attemptNumber, modelInvocations
  });
  const ref = recoveryRef(context);
  const { commit } = buildRecoveryCommit(root, retained, context);
  const zero = '0'.repeat(commit.length);
  const created = git(root, ['update-ref', ref, commit, zero], { allowFailure: true });
  if (created.status !== 0) {
    const local = outputText(git(root, ['rev-parse', '--verify', ref], { allowFailure: true }));
    if (local !== commit) {
      fail('Auto Candidate local recovery ref already names different immutable authority.',
        'AUTO_CANDIDATE_RECOVERY_CONFLICT');
    }
  }
  const observed = remoteObjectAtRef(root, remote, ref);
  if (observed && observed !== commit) {
    fail('Auto Candidate remote recovery ref already names different immutable authority.',
      'AUTO_CANDIDATE_RECOVERY_CONFLICT');
  }
  if (!observed) {
    const pushed = remoteGit(root, [
      'push', '--porcelain', '--', remote, `${commit}:${ref}`
    ], { operation: 'remote-push', allowFailure: true });
    if (pushed.status !== 0) {
      fail('Auto Candidate recovery authority could not be retained by the configured remote.',
        'AUTO_CANDIDATE_REMOTE_PUBLICATION_FAILED');
    }
  }
  if (remoteObjectAtRef(root, remote, ref) !== commit) {
    fail('Auto Candidate recovery publication did not retain the exact journal commit.',
      'AUTO_CANDIDATE_REMOTE_PUBLICATION_FAILED');
  }
  return Object.freeze({ ...context, ref, commit, binding: retained });
}

function readFetchedRecoveryAuthority(root, advertisedCommit, parsed) {
  const fetched = outputText(git(root, ['rev-parse', '--verify', 'FETCH_HEAD'], {
    allowFailure: true
  }));
  if (fetched !== advertisedCommit) {
    fail('Fetched Auto Candidate recovery authority differs from its advertised commit.',
      'AUTO_CANDIDATE_RECOVERY_CORRUPT');
  }
  const parent = outputText(git(root, ['rev-parse', '--verify', `${fetched}^`], {
    allowFailure: true
  }));
  const raw = outputBytes(git(root, ['show', `${fetched}:binding.json`], { allowFailure: true }));
  if (!raw.length) fail('Auto Candidate recovery authority has no exact binding.',
    'AUTO_CANDIDATE_RECOVERY_CORRUPT');
  const binding = parseCandidateBindingBytes(raw.toString('utf8'), {
    flightId: parsed.flightId
  });
  if (binding.attemptId !== parsed.attemptId
      || parent !== binding.repository.candidateCommit) {
    fail('Auto Candidate recovery ref, binding, and Git parent differ.',
      'AUTO_CANDIDATE_RECOVERY_CORRUPT');
  }
  const listing = outputText(git(root, ['ls-tree', fetched], { allowFailure: true }));
  if (!/^100644 blob [a-f0-9]{40,64}\tbinding\.json$/u.test(listing)) {
    fail('Auto Candidate recovery authority tree is not closed to one binding.',
      'AUTO_CANDIDATE_RECOVERY_CORRUPT');
  }
  const message = outputText(git(root, ['show', '-s', '--format=%B', fetched]));
  if (message !== recoveryCommitMessage(parsed, binding).trimEnd()) {
    fail('Auto Candidate recovery commit message does not bind its ref context.',
      'AUTO_CANDIDATE_RECOVERY_CORRUPT');
  }
  const zero = '0'.repeat(binding.repository.candidateCommit.length);
  const retained = git(root, [
    'update-ref', binding.repository.retainedRef, binding.repository.candidateCommit, zero
  ], { allowFailure: true });
  if (retained.status !== 0) {
    const local = outputText(git(root, [
      'rev-parse', '--verify', binding.repository.retainedRef
    ], { allowFailure: true }));
    if (local !== binding.repository.candidateCommit) {
      fail('Recovered Candidate conflicts with an existing local retention ref.',
        'AUTO_CANDIDATE_RECOVERY_CONFLICT');
    }
  }
  assertLocalCandidateRetention(root, binding);
  return binding;
}

/** Discover and restore the exact Candidate frozen after the named governed boundary. */
export async function discoverAutoCandidateRecoveryAuthority(root, {
  flightId, phase, baseCheckpointSha256, remote = 'origin'
} = {}) {
  // Validate the prefix through the same closed ref builder without guessing an attempt or outcome.
  recoveryRef({
    flightId, phase, baseCheckpointSha256,
    disposition: 'authored', attemptNumber: 1, modelInvocations: 1,
    attemptId: `AAT-${'0'.repeat(26)}`
  });
  if (typeof remote !== 'string' || !remote.trim()) {
    fail('Auto Candidate recovery requires a configured remote.',
      'AUTO_CANDIDATE_REMOTE_UNAVAILABLE');
  }
  const prefix = [
    'refs/singularity-flow/auto-candidate-recovery', flightId, phase,
    baseCheckpointSha256.slice(7)
  ].join('/');
  const advertised = remoteGit(root, [
    'ls-remote', '--refs', '--', remote, `${prefix}/*/*/*/*`
  ], { operation: 'remote-probe', allowFailure: true });
  if (advertised.status !== 0) {
    fail('Auto Candidate recovery could not inspect its configured remote.',
      'AUTO_CANDIDATE_REMOTE_UNAVAILABLE');
  }
  const rows = outputText(advertised).split(/\r?\n/u).filter(Boolean).map((line) => {
    const [commit, ref, ...extra] = line.trim().split(/\s+/u);
    if (extra.length || !GIT_OBJECT.test(String(commit ?? '')) || !ref) {
      fail('Auto Candidate remote recovery advertisement is malformed.',
        'AUTO_CANDIDATE_RECOVERY_CORRUPT');
    }
    const parsed = parseRecoveryRef(ref);
    if (parsed.flightId !== flightId || parsed.phase !== phase
        || parsed.baseCheckpointSha256 !== baseCheckpointSha256) {
      fail('Auto Candidate remote returned a recovery ref outside the exact request.',
        'AUTO_CANDIDATE_RECOVERY_CORRUPT');
    }
    return { commit, parsed };
  });
  if (!rows.length) return null;
  if (rows.length > 4) {
    fail('Auto Candidate recovery authority is ambiguous for this governed boundary.',
      'AUTO_CANDIDATE_RECOVERY_CONFLICT');
  }
  const recovered = [];
  for (const row of rows) {
    const fetched = remoteGit(root, [
      'fetch', '--no-tags', '--quiet', '--', remote, row.parsed.ref
    ], { operation: 'remote-configuration', allowFailure: true });
    if (fetched.status !== 0) {
      fail('Auto Candidate recovery authority could not be fetched exactly.',
        'AUTO_CANDIDATE_REMOTE_LOST');
    }
    const binding = readFetchedRecoveryAuthority(root, row.commit, row.parsed);
    recovered.push(Object.freeze({ ...row.parsed, commit: row.commit, binding }));
  }
  const bindingHashes = new Set(recovered.map((entry) => entry.binding.bindingSha256));
  const counterTuples = new Set(recovered.map((entry) => (
    `${entry.attemptNumber}:${entry.modelInvocations}`
  )));
  if (bindingHashes.size !== 1 || counterTuples.size !== 1) {
    fail('Multiple different Candidates claim the same governed recovery boundary.',
      'AUTO_CANDIDATE_RECOVERY_CONFLICT');
  }
  // Preservation is monotonic: once any post-freeze failure/stop path records the same Candidate
  // as non-publishable, a prior authored journal cannot make it publishable again.
  const selected = recovered.find((entry) => entry.disposition === 'preserved-after-failure')
    ?? recovered[0];
  await writeAutoPrivateRecord(
    root,
    candidateFile(root, selected.binding.flightId, selected.binding.candidateId),
    'candidate', canonicalJson(selected.binding), { immutable: true }
  );
  return selected;
}

function remoteCandidateObject(root, remote, retainedRef) {
  return remoteObjectAtRef(root, remote, retainedRef);
}

/**
 * Make the immutable Candidate commit reachable from the same remote authority as the Story.
 *
 * The ref is content-addressed and is never force-updated. A remote conflict therefore fails
 * closed rather than allowing a later flight to replace bytes already named by a checkpoint.
 */
export async function publishAutoCandidateAuthority(root, binding, { remote = 'origin' } = {}) {
  const retained = validateAutoCandidateBinding(binding);
  if (typeof remote !== 'string' || !remote.trim()) {
    fail('Auto Candidate authority requires a configured remote.',
      'AUTO_CANDIDATE_REMOTE_UNAVAILABLE');
  }
  const local = outputText(git(root, ['rev-parse', '--verify', retained.repository.retainedRef], {
    allowFailure: true
  }));
  if (local !== retained.repository.candidateCommit) {
    fail('Auto Candidate local retention no longer names the sealed commit.',
      'AUTO_CANDIDATE_RETENTION_LOST');
  }
  const observed = remoteCandidateObject(root, remote, retained.repository.retainedRef);
  if (observed && observed !== retained.repository.candidateCommit) {
    fail('Auto Candidate remote ref already names different immutable bytes.',
      'AUTO_CANDIDATE_REMOTE_CONFLICT');
  }
  if (!observed) {
    const pushed = remoteGit(root, [
      'push', '--porcelain', '--', remote,
      `${retained.repository.candidateCommit}:${retained.repository.retainedRef}`
    ], { operation: 'remote-push', allowFailure: true });
    if (pushed.status !== 0) {
      fail('Auto Candidate could not be retained by the configured remote authority.',
        'AUTO_CANDIDATE_REMOTE_PUBLICATION_FAILED');
    }
  }
  if (remoteCandidateObject(root, remote, retained.repository.retainedRef)
      !== retained.repository.candidateCommit) {
    fail('Auto Candidate remote publication did not retain the sealed commit.',
      'AUTO_CANDIDATE_REMOTE_PUBLICATION_FAILED');
  }
  return retained;
}

/** Restore sealed Candidate records and their exact Git object from governed checkpoint bytes. */
export async function restoreAutoCandidateAuthority(root, binding, verification = null, {
  remote = 'origin'
} = {}) {
  const retained = validateAutoCandidateBinding(binding);
  const receipt = verification == null ? null : validateAutoCandidateVerification(verification);
  if (receipt && (receipt.flightId !== retained.flightId
      || receipt.candidateId !== retained.candidateId
      || receipt.candidateSha256 !== retained.candidateSha256
      || receipt.bindingSha256 !== retained.bindingSha256)) {
    fail('Governed Candidate verification does not bind the restored Candidate.',
      'AUTO_CANDIDATE_VERIFICATION_CORRUPT');
  }
  if (remoteCandidateObject(root, remote, retained.repository.retainedRef)
      !== retained.repository.candidateCommit) {
    fail('The governed Auto Candidate is no longer reachable from its remote authority.',
      'AUTO_CANDIDATE_REMOTE_LOST');
  }
  let local = outputText(git(root, ['rev-parse', '--verify', retained.repository.retainedRef], {
    allowFailure: true
  }));
  if (local && local !== retained.repository.candidateCommit) {
    fail('The local Candidate ref conflicts with governed remote authority.',
      'AUTO_CANDIDATE_REMOTE_CONFLICT');
  }
  if (!local || git(root, ['cat-file', '-e', `${retained.repository.candidateCommit}^{commit}`], {
    allowFailure: true
  }).status !== 0) {
    const fetched = remoteGit(root, [
      'fetch', '--no-tags', '--quiet', '--', remote, retained.repository.retainedRef
    ], { operation: 'remote-configuration', allowFailure: true });
    if (fetched.status !== 0
        || outputText(git(root, ['rev-parse', '--verify', 'FETCH_HEAD'], { allowFailure: true }))
          !== retained.repository.candidateCommit) {
      fail('The governed Auto Candidate commit could not be fetched exactly.',
        'AUTO_CANDIDATE_REMOTE_LOST');
    }
    const updated = git(root, [
      'update-ref', retained.repository.retainedRef, retained.repository.candidateCommit,
      local || '0'.repeat(retained.repository.candidateCommit.length)
    ], { allowFailure: true });
    if (updated.status !== 0) {
      fail('The governed Auto Candidate ref could not be restored locally.',
        'AUTO_CANDIDATE_REMOTE_CONFLICT');
    }
    local = retained.repository.candidateCommit;
  }
  const tree = outputText(git(root, [
    'rev-parse', '--verify', `${retained.repository.candidateCommit}^{tree}`
  ], { allowFailure: true }));
  if (local !== retained.repository.candidateCommit || tree !== retained.repository.candidateTree) {
    fail('The fetched Auto Candidate does not reproduce its governed tree.',
      'AUTO_CANDIDATE_RETENTION_LOST');
  }
  await writeAutoPrivateRecord(
    root, candidateFile(root, retained.flightId, retained.candidateId), 'candidate',
    canonicalJson(retained), { immutable: true }
  );
  if (receipt) {
    await writeAutoPrivateRecord(
      root, verificationFile(root, retained.flightId, retained.candidateId), 'candidate',
      canonicalJson(receipt), { immutable: true }
    );
  }
  return Object.freeze({ binding: retained, verification: receipt });
}

/**
 * Re-materialize only the application delta from the immutable Candidate. Governance files and
 * the Story checkpoint commit stay checked out and unmodified.
 */
export async function restoreAutoCandidateWorktree(root, binding, pathContext = null) {
  const retained = await readAutoCandidateBinding(root, {
    flightId: binding?.flightId, candidateId: binding?.candidateId
  });
  if (retained.bindingSha256 !== binding.bindingSha256) {
    fail('Restored Auto Candidate binding differs from governed checkpoint authority.',
      'AUTO_CANDIDATE_CORRUPT');
  }
  const headTree = outputText(git(root, ['rev-parse', '--verify', 'HEAD^{tree}']));
  const baselineSource = autoCandidateSourceTreeSha256(
    root, retained.repository.baselineTree, pathContext
  );
  const currentSource = autoCandidateSourceTreeSha256(root, headTree, pathContext);
  if (currentSource !== baselineSource) {
    fail('Recovery checkout application bytes differ from the Candidate baseline.',
      'AUTO_CANDIDATE_RECOVERY_CONFLICT');
  }
  const paths = [...new Set(retained.resourceManifest.entries.flatMap((entry) => (
    [entry.oldPath, entry.newPath].filter(Boolean)
  )))].sort();
  if (paths.length) {
    const patch = outputBytes(git(root, [
      'diff', '--binary', '--full-index', '--no-ext-diff',
      retained.repository.baselineTree, retained.repository.candidateTree, '--', ...paths
    ]));
    if (patch.length) {
      const applied = git(root, ['apply', '--binary', '--whitespace=nowarn', '-'], {
        input: patch, allowFailure: true
      });
      if (applied.status !== 0) {
        fail('The exact Auto Candidate application delta could not be restored.',
          'AUTO_CANDIDATE_RECOVERY_CONFLICT');
      }
    }
  }
  const observed = await observeAutoCandidateWorktree(root, retained, pathContext);
  assertAutoCandidateMatches(retained, observed);
  return retained;
}

export function assertAutoCandidateMatches(binding, {
  candidateSha256, applicationChangeSetDigest = null, applicationResourceDigest = null
} = {}) {
  validateAutoCandidateBinding(binding);
  if (binding.candidateSha256 !== candidateSha256) {
    fail('Application source changed after the Auto Candidate was frozen.', 'AUTO_CANDIDATE_CHANGED', {
      expected: binding.candidateSha256, actual: candidateSha256
    });
  }
  if (applicationResourceDigest != null
      && binding.applicationResourceDigest !== applicationResourceDigest) {
    fail('Application resource identity changed after the Auto Candidate was frozen.',
      'AUTO_CANDIDATE_CHANGED', {
        expected: binding.applicationResourceDigest, actual: applicationResourceDigest
      });
  }
  if (applicationResourceDigest == null && applicationChangeSetDigest != null
      && binding.applicationChangeSetDigest !== applicationChangeSetDigest) {
    fail('Application change-set identity changed after the Auto Candidate was frozen.',
      'AUTO_CANDIDATE_CHANGED', {
        expected: binding.applicationChangeSetDigest, actual: applicationChangeSetDigest
      });
  }
  return binding;
}

function normalizeVerificationCommands(commands) {
  if (!Array.isArray(commands) || !commands.length || commands.length > MAX_VERIFICATION_COMMANDS) {
    fail('Auto Candidate verification requires a bounded non-empty approved command list.',
      'AUTO_CANDIDATE_VERIFICATION_INVALID');
  }
  return commands.map((command, index) => {
    if (!command || typeof command !== 'object' || Array.isArray(command)
        || !Array.isArray(command.argv) || !command.argv.length
        || command.argv.some((part) => typeof part !== 'string' || !part)
        || !['never', undefined].includes(command.modelPolicy)) {
      fail(`Auto Candidate verification command ${index + 1} is not deterministic argv policy.`,
        'AUTO_CANDIDATE_VERIFICATION_INVALID');
    }
    const workingDirectory = String(command.workingDirectory ?? '.').replaceAll('\\', '/');
    if (path.posix.isAbsolute(workingDirectory) || workingDirectory.split('/').includes('..')) {
      fail(`Auto Candidate verification command ${index + 1} has an unsafe working directory.`,
        'AUTO_CANDIDATE_VERIFICATION_INVALID');
    }
    const resultPath = command.result?.path == null
      ? null : String(command.result.path).replaceAll('\\', '/');
    if (resultPath != null && (!resultPath || path.posix.isAbsolute(resultPath)
        || resultPath.includes(':') || resultPath.includes('\0')
        || resultPath.split('/').some((segment) => !segment || segment === '.' || segment === '..'))) {
      fail(`Auto Candidate verification command ${index + 1} has an unsafe evidence output path.`,
        'AUTO_CANDIDATE_VERIFICATION_INVALID');
    }
    return {
      id: String(command.id ?? `quality-${index + 1}`),
      argv: [...command.argv],
      workingDirectory,
      resultPath,
      timeoutMs: Math.min(30 * 60 * 1000, Math.max(1, Number(command.timeoutMs ?? 10 * 60 * 1000)))
    };
  });
}

async function runVerificationCommand(command, workspace, signal) {
  return new Promise((resolve, reject) => {
    const cwd = path.resolve(workspace, command.workingDirectory);
    if (cwd !== workspace && !cwd.startsWith(`${workspace}${path.sep}`)) {
      return reject(new SingularityFlowError('Candidate verifier escaped its isolated worktree.', {
        code: 'AUTO_CANDIDATE_VERIFICATION_INVALID'
      }));
    }
    const allowedEnvironment = [
      'PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec',
      'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'CI', 'JAVA_HOME', 'M2_HOME'
    ];
    const childEnvironment = {
      ...Object.fromEntries(allowedEnvironment.filter((key) => process.env[key] != null)
        .map((key) => [key, process.env[key]])),
      GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never'
    };
    let launch;
    try {
      launch = resolvePlatformProcess(command.argv[0], command.argv.slice(1), {
        platform: process.platform, environment: childEnvironment, cwd
      });
    } catch (error) {
      return reject(new SingularityFlowError(`Candidate verifier executable is unavailable: ${error.message}`, {
        code: 'AUTO_CANDIDATE_VERIFICATION_INVALID', cause: error
      }));
    }
    const child = spawn(launch.executable, launch.arguments, {
      cwd,
      env: childEnvironment,
      ...launch.spawnOptions,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const output = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
    const terminate = () => {
      if (child.exitCode != null || child.signalCode != null) return;
      if (process.platform === 'win32' && child.pid) {
        if (!tryWindowsTaskkill(child.pid, {
          force: true, environment: process.env, spawnSyncCommand: spawnSync,
          timeoutMs: 5_000
        })) child.kill('SIGKILL');
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const append = (chunk) => {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_VERIFICATION_OUTPUT_BYTES) { overflow = true; terminate(); }
      else output.push(value);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', reject);
    const timer = setTimeout(() => { timedOut = true; terminate(); }, command.timeoutMs);
    timer.unref?.();
    const abort = () => terminate();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) terminate();
    child.once('close', (status, terminationSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      const captured = Buffer.concat(output);
      resolve({
        id: command.id,
        argvSha256: digest(command.argv),
        workingDirectory: command.workingDirectory,
        status: status ?? 1,
        signal: terminationSignal ?? null,
        timedOut,
        overflow,
        outputSha256: digest(captured),
        outputBytes: captured.length
      });
    });
  });
}

function verificationCore(record) {
  const core = structuredClone(record);
  delete core.verificationReceiptSha256;
  return core;
}

export function validateAutoCandidateVerification(record) {
  exactObject(record, [
    'schemaVersion', 'kind', 'flightId', 'candidateId', 'candidateSha256',
    'bindingSha256', 'status', 'commands', 'candidateTreeUnchanged', 'verifiedAt',
    'verificationReceiptSha256'
  ], 'Auto Candidate verification');
  if (record.kind !== 'auto-candidate-verification'
      || !FLIGHT_ID.test(String(record.flightId ?? ''))
      || !CANDIDATE_ID.test(String(record.candidateId ?? ''))
      || ![record.candidateSha256, record.bindingSha256, record.verificationReceiptSha256]
        .every((value) => HASH.test(String(value ?? '')))
      || !['passed', 'failed'].includes(record.status)
      || !Array.isArray(record.commands)
      || record.commands.length < 1 || record.commands.length > MAX_VERIFICATION_COMMANDS
      || typeof record.candidateTreeUnchanged !== 'boolean'
      || Number.isNaN(Date.parse(record.verifiedAt))
      || record.verificationReceiptSha256 !== digest(verificationCore(record))) {
    fail('Auto Candidate verification receipt failed its contract.', 'AUTO_CANDIDATE_VERIFICATION_CORRUPT');
  }
  for (const [index, command] of record.commands.entries()) {
    exactObject(command, [
      'id', 'argvSha256', 'workingDirectory', 'status', 'signal', 'timedOut', 'overflow',
      'outputSha256', 'outputBytes'
    ], `Auto Candidate verification command ${index + 1}`);
    if (typeof command.id !== 'string' || !command.id
        || !HASH.test(String(command.argvSha256 ?? ''))
        || typeof command.workingDirectory !== 'string' || !command.workingDirectory
        || !Number.isInteger(command.status)
        || (command.signal != null && typeof command.signal !== 'string')
        || typeof command.timedOut !== 'boolean' || typeof command.overflow !== 'boolean'
        || !HASH.test(String(command.outputSha256 ?? ''))
        || !Number.isSafeInteger(command.outputBytes) || command.outputBytes < 0) {
      fail('Auto Candidate verification command result failed its contract.',
        'AUTO_CANDIDATE_VERIFICATION_CORRUPT');
    }
  }
  const commandsPassed = record.commands.every((result) => (
    result.status === 0 && !result.timedOut && !result.overflow
  ));
  if ((record.status === 'passed') !== (commandsPassed && record.candidateTreeUnchanged)) {
    fail('Auto Candidate verification verdict does not reproduce from its observations.',
      'AUTO_CANDIDATE_VERIFICATION_CORRUPT');
  }
  return Object.freeze(structuredClone(record));
}

export async function verifyAutoCandidate(root, binding, {
  commands, signal = null, verifiedAt = new Date().toISOString(), pathContext = null
} = {}) {
  const retained = await readAutoCandidateBinding(root, {
    flightId: binding?.flightId, candidateId: binding?.candidateId
  });
  if (retained.bindingSha256 !== binding.bindingSha256) {
    fail('Candidate verification received a different binding.', 'AUTO_CANDIDATE_VERIFICATION_INVALID');
  }
  // Verification is an immutable authority record. A process may crash after persisting it but
  // before advancing local flight state; recovery must reuse those exact observations rather than
  // rerun commands and manufacture a receipt with a new timestamp or environment.
  try {
    const existing = await readAutoCandidateVerification(root, {
      flightId: retained.flightId, candidateId: retained.candidateId
    });
    if (existing.candidateSha256 !== retained.candidateSha256
        || existing.bindingSha256 !== retained.bindingSha256) {
      fail('Stored Candidate verification belongs to different frozen bytes.',
        'AUTO_CANDIDATE_VERIFICATION_CORRUPT');
    }
    if (existing.status !== 'passed') {
      fail('The immutable Auto Candidate verification already failed.',
        existing.candidateTreeUnchanged
          ? 'AUTO_CANDIDATE_VERIFICATION_FAILED' : 'AUTO_CANDIDATE_VERIFICATION_MUTATED', {
          verificationReceiptSha256: existing.verificationReceiptSha256
        });
    }
    return existing;
  } catch (error) {
    if (error?.code !== 'AUTO_CANDIDATE_VERIFICATION_NOT_FOUND') throw error;
  }
  const normalized = normalizeVerificationCommands(commands);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-auto-candidate-verify-'));
  const workspace = path.join(temporary, 'worktree');
  const results = [];
  let candidateTreeUnchanged = false;
  try {
    git(root, ['worktree', 'add', '--detach', '--no-checkout', workspace, retained.repository.candidateCommit]);
    git(workspace, ['reset', '--hard', retained.repository.candidateCommit]);
    const before = await freezeWorktreeTree(workspace);
    if (before.tree !== retained.repository.candidateTree) {
      fail('Detached Candidate worktree does not equal its retained tree.',
        'AUTO_CANDIDATE_RETENTION_LOST');
    }
    for (const command of normalized) {
      if (signal?.aborted) fail('Candidate verification was cancelled.', 'AUTO_STOP_REQUESTED');
      results.push(await runVerificationCommand(command, workspace, signal));
    }
    // Remove only exact, predeclared result paths and only when those paths were absent from the
    // Candidate. Everything else—including configuration, harnesses, tracked governance bytes,
    // and undeclared build output—remains part of the post-command Git tree comparison.
    for (const resultPath of [...new Set(normalized.map((command) => command.resultPath)
      .filter(Boolean))]) {
      const candidateEntry = outputText(git(root, [
        'ls-tree', '-r', '--name-only', retained.repository.candidateTree, '--', resultPath
      ], { allowFailure: true }));
      if (candidateEntry) {
        fail(`Verification evidence path '${resultPath}' overlaps immutable Candidate bytes.`,
          'AUTO_CANDIDATE_VERIFICATION_INVALID');
      }
      const absolute = path.resolve(workspace, resultPath);
      if (absolute !== workspace && !absolute.startsWith(`${workspace}${path.sep}`)) {
        fail('Candidate verification evidence path escaped its isolated worktree.',
          'AUTO_CANDIDATE_VERIFICATION_INVALID');
      }
      await rm(absolute, { recursive: true, force: true });
    }
    const after = await freezeWorktreeTree(workspace);
    candidateTreeUnchanged = after.tree === retained.repository.candidateTree;
  } finally {
    git(root, ['worktree', 'remove', '--force', '--', workspace], { allowFailure: true });
    await rm(temporary, { recursive: true, force: true });
  }
  const passed = candidateTreeUnchanged
    && results.every((result) => result.status === 0 && !result.timedOut && !result.overflow);
  const core = {
    schemaVersion: currentSchemaVersion('auto-candidate-verification'),
    kind: 'auto-candidate-verification',
    flightId: retained.flightId,
    candidateId: retained.candidateId,
    candidateSha256: retained.candidateSha256,
    bindingSha256: retained.bindingSha256,
    status: passed ? 'passed' : 'failed',
    commands: results,
    candidateTreeUnchanged,
    verifiedAt
  };
  const receipt = validateAutoCandidateVerification({
    ...core, verificationReceiptSha256: digest(core)
  });
  await writeAutoPrivateRecord(
    root, verificationFile(root, retained.flightId, retained.candidateId), 'candidate',
    canonicalJson(receipt), { immutable: true }
  );
  if (!passed) {
    fail(candidateTreeUnchanged
      ? 'The isolated Auto Candidate verification failed.'
      : 'A verification command modified the isolated frozen Candidate.',
    candidateTreeUnchanged
      ? 'AUTO_CANDIDATE_VERIFICATION_FAILED' : 'AUTO_CANDIDATE_VERIFICATION_MUTATED', {
      verificationReceiptSha256: receipt.verificationReceiptSha256
    });
  }
  return receipt;
}

export async function readAutoCandidateVerification(root, {
  flightId, candidateId, verificationReceiptSha256 = null
} = {}) {
  const raw = await readAutoPrivateRecord(
    root, verificationFile(root, flightId, candidateId), 'candidate', { optional: true }
  );
  if (raw == null) fail('Auto Candidate verification receipt was not found.',
    'AUTO_CANDIDATE_VERIFICATION_NOT_FOUND');
  let stored;
  try { stored = JSON.parse(raw); } catch (error) {
    fail(`Auto Candidate verification receipt is invalid JSON: ${error.message}`,
      'AUTO_CANDIDATE_VERIFICATION_CORRUPT');
  }
  if (stored.verificationReceiptSha256 !== digest(verificationCore(stored))) {
    fail('Auto Candidate verification failed its historical content hash.',
      'AUTO_CANDIDATE_VERIFICATION_CORRUPT');
  }
  const receipt = validateAutoCandidateVerification(
    readRecord('auto-candidate-verification', stored).record
  );
  if (receipt.flightId !== flightId || receipt.candidateId !== candidateId
      || (verificationReceiptSha256 && receipt.verificationReceiptSha256 !== verificationReceiptSha256)) {
    fail('Auto Candidate verification identity differs from its publication binding.',
      'AUTO_CANDIDATE_VERIFICATION_CORRUPT');
  }
  return receipt;
}

export function autoCandidateEnvironment(binding, verification = null) {
  validateAutoCandidateBinding(binding);
  const receipt = verification ? validateAutoCandidateVerification(verification) : null;
  if (receipt && (receipt.flightId !== binding.flightId
      || receipt.candidateId !== binding.candidateId
      || receipt.candidateSha256 !== binding.candidateSha256
      || receipt.bindingSha256 !== binding.bindingSha256
      || receipt.status !== 'passed')) {
    fail('Auto Candidate verification does not bind the supplied Candidate.',
      'AUTO_CANDIDATE_VERIFICATION_FAILED');
  }
  return {
    [CANDIDATE_ENV.flightId]: binding.flightId,
    [CANDIDATE_ENV.candidateId]: binding.candidateId,
    [CANDIDATE_ENV.candidateSha256]: binding.candidateSha256,
    [CANDIDATE_ENV.bindingSha256]: binding.bindingSha256,
    ...(receipt ? {
      [CANDIDATE_ENV.verificationReceiptSha256]:
        receipt.verificationReceiptSha256
    } : {})
  };
}

export async function autoCandidateFromEnvironment(root, environment = process.env) {
  const values = Object.fromEntries(Object.entries(CANDIDATE_ENV)
    .filter(([key]) => key !== 'verificationReceiptSha256')
    .map(([key, name]) => [key, environment[name] ?? null]));
  if (Object.values(values).every((value) => value == null)) return null;
  if (Object.values(values).some((value) => value == null)) {
    fail('Auto Candidate publication environment is incomplete.', 'AUTO_CANDIDATE_ENVIRONMENT_INVALID');
  }
  const binding = await readAutoCandidateBinding(root, values);
  if (binding.candidateSha256 !== values.candidateSha256
      || binding.bindingSha256 !== values.bindingSha256) {
    fail('Auto Candidate publication environment does not match its retained record.',
      'AUTO_CANDIDATE_ENVIRONMENT_INVALID');
  }
  return binding;
}

export async function autoCandidatePublicationFromEnvironment(root, environment = process.env) {
  const binding = await autoCandidateFromEnvironment(root, environment);
  if (!binding) return null;
  const verificationReceiptSha256 = environment[CANDIDATE_ENV.verificationReceiptSha256] ?? null;
  if (!verificationReceiptSha256) {
    fail('Auto Candidate publication has no isolated verification receipt.',
      'AUTO_CANDIDATE_VERIFICATION_NOT_FOUND');
  }
  const verification = await readAutoCandidateVerification(root, {
    flightId: binding.flightId,
    candidateId: binding.candidateId,
    verificationReceiptSha256
  });
  if (verification.status !== 'passed'
      || verification.candidateSha256 !== binding.candidateSha256
      || verification.bindingSha256 !== binding.bindingSha256) {
    fail('Auto Candidate verification does not authorize this exact Candidate.',
      'AUTO_CANDIDATE_VERIFICATION_FAILED');
  }
  return Object.freeze({ binding, verification });
}
