/**
 * Read-only REV context adapter. Git can prove saved bytes and index state; it cannot inspect an
 * editor's unsaved buffers. Callers without a trusted editor-host observation receive an explicit
 * unavailable result and must not open a loop, precheck, or publish from this projection.
 *
 * This is a point-in-time observation, not a lease. Mutating consumers must read it again inside
 * their subject/publication lock and compare every authority-bearing digest.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { applicationPathContext, isApplicationChangePath } from '../application-paths.mjs';
import { loadDefinition } from '../config.mjs';
import { configurationAssetPaths, readConfigurationSource } from '../configuration-branch.mjs';
import { gitCommonDir, repoRoot } from '../git.mjs';
import { recordSha256 } from '../records.mjs';
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { loadWorkflow, sourceTreeHash, workDirRelative, workflowPath } from '../state-stores.mjs';
import { run, secureRepositoryPath, SingularityFlowError } from '../util.mjs';
import { withoutConfiguredFilters } from '../worktree-fingerprint.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const MAX_CHANGED_PATHS = 4096;
const MAX_CHANGED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_CHANGED_BYTES = 256 * 1024 * 1024;
const MAX_CONFIG_BYTES = 128 * 1024 * 1024;

const digest = (value) => `sha256:${recordSha256(value)}`;
const bytesDigest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function unavailable(code, message, details = {}) {
  return Object.freeze({ status: 'unavailable', code, message, ...details });
}
function refuse(code, message) { throw new SingularityFlowError(message, { code }); }
function nulPaths(output, label) {
  if (typeof output !== 'string' || (output && !output.endsWith('\0'))) {
    refuse('REV_GIT_OBSERVATION_INVALID', `${label} did not return a complete NUL-delimited list.`);
  }
  return output ? output.slice(0, -1).split('\0').map((value) => {
    if (!value || value.startsWith('/') || value.includes('\\')
        || value.split('/').some((part) => !part || part === '.' || part === '..')
        || /[\u0000-\u001f\u007f\ufffd]/.test(value)) {
      refuse('REV_GIT_OBSERVATION_INVALID', `${label} contains an unsupported repository path.`);
    }
    return value;
  }) : [];
}
function git(root, args, { disableFilters = false } = {}) {
  // `git status` may otherwise refresh the index's stat cache. This probe must never alter the
  // selected worktree/index, even as an optional Git performance optimization.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  return run('git', disableFilters ? withoutConfiguredFilters(root, args, { env, fresh: true }) : args,
    { cwd: root, env }).stdout;
}
function gitOid(root, reference) {
  const value = git(root, ['rev-parse', '--verify', reference]).trim();
  if (!OID.test(value)) refuse('REV_GIT_OBSERVATION_INVALID', `Git ${reference} did not resolve to one exact object.`);
  return value;
}
function changedPathList(root) {
  const tracked = nulPaths(git(root, [
    'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', '--ignore-submodules=none', 'HEAD', '--'
  ], { disableFilters: true }), 'Tracked changes');
  const untracked = nulPaths(git(root, ['ls-files', '--others', '--exclude-standard', '-z']), 'Untracked files');
  const changedPaths = [...new Set([...tracked, ...untracked])].sort();
  if (changedPaths.length > MAX_CHANGED_PATHS) {
    refuse('REV_WORKTREE_LIMIT', 'REV cannot pin more than 4096 changed repository paths.');
  }
  return { changedPaths, untracked: new Set(untracked) };
}
async function changedFileRecord(root, relative, untracked, budget) {
  const secured = await secureRepositoryPath(root, relative, {
    label: 'REV saved path', allowFinalSymlink: true
  });
  const absolute = secured.absolute;
  const first = await lstat(absolute).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!first) return { path: relative, kind: 'deleted', untracked: false };
  if (!first.isFile() && !first.isSymbolicLink()) {
    refuse('REV_WORKTREE_UNSUPPORTED', `REV cannot pin a directory, submodule, or special file at '${relative}'.`);
  }
  if (first.size > MAX_CHANGED_FILE_BYTES || budget.bytes + first.size > MAX_CHANGED_BYTES) {
    refuse('REV_WORKTREE_LIMIT', 'REV saved changes exceed the bounded byte budget.');
  }
  const bytes = first.isSymbolicLink()
    ? Buffer.from(await readlink(absolute)) : await readFile(absolute);
  const last = await lstat(absolute);
  if (first.dev !== last.dev || first.ino !== last.ino || first.size !== last.size
      || first.mtimeMs !== last.mtimeMs || first.mode !== last.mode) {
    refuse('REV_WORKTREE_CHANGED', `Saved path '${relative}' changed during observation.`);
  }
  budget.bytes += bytes.length;
  return {
    path: relative, kind: first.isSymbolicLink() ? 'symlink' : 'file',
    mode: first.mode & 0o777, size: bytes.length, sha256: bytesDigest(bytes), untracked
  };
}

async function configurationAndWorkflowDigest(root, config, workflow, workId) {
  const selected = await configurationAssetPaths(root);
  if (selected.length > MAX_CHANGED_PATHS) {
    refuse('REV_CONFIGURATION_LIMIT', 'REV cannot pin more than 4096 configuration assets.');
  }
  const assets = [];
  let bytesRead = 0;
  for (const relative of selected) {
    const secured = await secureRepositoryPath(root, relative, {
      label: 'REV configuration asset', mustExist: true, type: 'file'
    });
    const info = await lstat(secured.absolute);
    if (info.isSymbolicLink() || !info.isFile() || bytesRead + info.size > MAX_CONFIG_BYTES) {
      refuse('REV_CONFIGURATION_UNAVAILABLE', 'A configuration asset is unsafe or exceeds the REV byte limit.');
    }
    const bytes = await readFile(secured.absolute);
    bytesRead += bytes.length;
    assets.push({ path: relative, sha256: bytesDigest(bytes) });
  }
  const stateFile = workflowPath(root, config, workId);
  const stateRelative = path.relative(root, stateFile).split(path.sep).join('/');
  const state = await secureRepositoryPath(root, stateRelative, {
    label: 'REV Story state', mustExist: true, type: 'file'
  });
  const stateBytes = await readFile(state.absolute);
  if (stateBytes.length > 8 * 1024 * 1024) {
    refuse('REV_WORKFLOW_LIMIT', 'Story state exceeds the REV byte limit.');
  }
  return {
    configSha256: digest({ definition: config, assets }),
    workflowSha256: digest({ workflow, bytesSha256: bytesDigest(stateBytes) })
  };
}

/**
 * Pin Git HEAD, index, saved changed bytes, and application source without writing an index/tree.
 * A clean worktree has an exact Git savedTree; for a dirty one, `savedTree:null` is intentional:
 * inventing a Git tree object ID from status text would make a false equality proof.
 */
export async function probeRevisionSavedState(root, { config, workflow } = {}) {
  const canonicalRoot = await realpath(root);
  if (await realpath(repoRoot(canonicalRoot)) !== canonicalRoot) {
    refuse('REV_REPOSITORY_ROOT', 'REV requires the exact Git repository root.');
  }
  const headCommit = gitOid(canonicalRoot, 'HEAD^{commit}');
  const headTree = gitOid(canonicalRoot, 'HEAD^{tree}');
  const index = git(canonicalRoot, ['ls-files', '--stage', '-z']);
  if (index.split('\0').filter(Boolean).some((line) => !/^\d{6} [a-f0-9]{40}(?:[a-f0-9]{24})? 0\t/.test(line))) {
    refuse('REV_INDEX_UNMERGED', 'REV requires a fully merged stage-zero Git index.');
  }
  if (index.split('\0').filter(Boolean).some((line) => line.startsWith('160000 '))) {
    refuse('REV_SUBMODULE_UNSUPPORTED', 'REV cannot prove a submodule worktree without a separate bounded observation.');
  }
  const porcelain = git(canonicalRoot, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'
  ], { disableFilters: true });
  const { changedPaths, untracked } = changedPathList(canonicalRoot);
  if (porcelain && !changedPaths.length) {
    refuse('REV_GIT_OBSERVATION_INVALID', 'Git reports changes that REV cannot enumerate safely.');
  }
  const budget = { bytes: 0 };
  const saved = [];
  for (const relative of changedPaths) {
    saved.push(await changedFileRecord(canonicalRoot, relative, untracked.has(relative), budget));
  }
  const sourceTreeSha256 = await sourceTreeHash(canonicalRoot, config, workflow);
  const context = applicationPathContext(config, workflow);
  const prefix = `${workDirRelative(config, workflow.workItem.id).replace(/\/$/, '')}/`;
  const applicationChangedPaths = changedPaths.filter((relative) => isApplicationChangePath(relative, {
    ...context, untracked: untracked.has(relative)
  }));
  const transactionOwnedPaths = changedPaths.filter((relative) => relative.startsWith(prefix));
  const otherGovernedPaths = changedPaths.filter((relative) => !applicationChangedPaths.includes(relative)
    && !transactionOwnedPaths.includes(relative));
  const afterHead = gitOid(canonicalRoot, 'HEAD^{commit}');
  const afterTree = gitOid(canonicalRoot, 'HEAD^{tree}');
  const afterIndex = git(canonicalRoot, ['ls-files', '--stage', '-z']);
  const afterPorcelain = git(canonicalRoot, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'
  ], { disableFilters: true });
  const afterChangedPaths = changedPathList(canonicalRoot).changedPaths;
  const afterSaved = [];
  const afterBudget = { bytes: 0 };
  for (const relative of afterChangedPaths) {
    afterSaved.push(await changedFileRecord(canonicalRoot, relative, untracked.has(relative), afterBudget));
  }
  if (headCommit !== afterHead || headTree !== afterTree || index !== afterIndex
      || porcelain !== afterPorcelain || digest(saved) !== digest(afterSaved)) {
    refuse('REV_WORKTREE_CHANGED', 'HEAD, index, or saved files changed during REV observation.');
  }
  const baseline = {
    headCommit, headTree, indexSha256: bytesDigest(Buffer.from(index)),
    porcelainSha256: bytesDigest(Buffer.from(porcelain)), sourceTreeSha256,
    saved, applicationChangedPaths, transactionOwnedPaths, otherGovernedPaths
  };
  return Object.freeze({
    ...baseline, changedPaths,
    savedTree: changedPaths.length ? null : headTree,
    editorDiskIndexBaselineSha256: digest(baseline)
  });
}

function editorStatus(value, repositoryRoot) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.source !== 'editor-host' || !['saved', 'unsaved', 'unavailable'].includes(value.status)
      || value.repositoryRoot !== repositoryRoot
      || !HASH.test(String(value.observationSha256 ?? ''))) {
    return unavailable('REV_EDITOR_STATE_UNAVAILABLE',
      'The editor host did not provide a verifiable saved-buffer observation.');
  }
  if (value.status === 'unsaved') return unavailable('REV_EDITOR_UNSAVED',
    'Save or discard unsaved editor buffers before opening or advancing a revision loop.');
  if (value.status !== 'saved' || value.dirtyDocumentCount !== 0) {
    return unavailable('REV_EDITOR_STATE_UNAVAILABLE',
      'The editor host could not establish that all repository buffers are saved.');
  }
  return Object.freeze({ status: 'saved', observationSha256: value.observationSha256 });
}

/**
 * Return an exact, loop-store-shaped context only when the selected Story, Code generation,
 * approved bindings, Git state, and host editor state all resolve. The caller supplies the three
 * approval digests from its verified authority records; no synthetic default is permitted.
 */
export async function readRevisionCurrentContext({
  root, workId, phaseId = null, readApprovedBindings = null, observeEditorBuffers = null
} = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(String(workId ?? ''))) {
    refuse('REV_CONTEXT_INPUT', 'REV needs an absolute selected repository and exact Story ID.');
  }
  const canonicalRoot = await realpath(root);
  const config = await loadDefinition(canonicalRoot);
  const workflow = await loadWorkflow(canonicalRoot, config, workId);
  const phase = workflow?.phases?.[workflow.currentPhase];
  if (workflow.workItem?.id !== workId || !phase || (phaseId && phaseId !== workflow.currentPhase)
      || !phaseRequiresCodeDelivery(phase) || !['in_progress', 'rework'].includes(phase.status)
      || !Number.isSafeInteger(phase.generation) || phase.generation < 1) {
    return unavailable('REV_PHASE_NOT_OPEN', 'REV requires the selected active Story Code generation.');
  }
  const configurationSource = await readConfigurationSource(canonicalRoot, { verify: true });
  const { configSha256, workflowSha256 } = await configurationAndWorkflowDigest(
    canonicalRoot, config, workflow, workId);
  const saved = await probeRevisionSavedState(canonicalRoot, { config, workflow });
  const observation = typeof observeEditorBuffers === 'function'
    ? editorStatus(await observeEditorBuffers({ repositoryRoot: canonicalRoot, workId,
      phaseId: workflow.currentPhase, phaseGeneration: phase.generation }), canonicalRoot)
    : unavailable('REV_EDITOR_STATE_UNAVAILABLE',
      'The CLI cannot inspect unsaved editor buffers. Use a trusted editor-host observation.');
  if (observation.status !== 'saved') {
    return unavailable(observation.code, observation.message, { savedState: saved });
  }
  if (typeof readApprovedBindings !== 'function') {
    return unavailable('REV_BINDING_UNAVAILABLE',
      'Approved intent, route contract, and proof profile have not been verified.', { savedState: saved });
  }
  const bindings = await readApprovedBindings({ repositoryRoot: canonicalRoot, workId,
    phaseId: workflow.currentPhase, phaseGeneration: phase.generation, config, workflow });
  if (!bindings || bindings.status !== 'verified'
    || ['approvedIntentSha256', 'routeContractSha256', 'proofProfileSha256']
    .some((key) => !HASH.test(String(bindings[key] ?? '')))) {
    return unavailable('REV_BINDING_UNAVAILABLE',
      'Approved intent, route contract, and proof profile require exact verified digests.', { savedState: saved });
  }
  // Re-read all moving authority after the comparatively expensive source and editor observation.
  const currentConfig = await loadDefinition(canonicalRoot);
  const currentWorkflow = await loadWorkflow(canonicalRoot, currentConfig, workId);
  const currentDigests = await configurationAndWorkflowDigest(
    canonicalRoot, currentConfig, currentWorkflow, workId);
  const finalSaved = await probeRevisionSavedState(canonicalRoot, {
    config: currentConfig, workflow: currentWorkflow
  });
  const finalEditor = editorStatus(await observeEditorBuffers({
    repositoryRoot: canonicalRoot, workId,
    phaseId: workflow.currentPhase, phaseGeneration: phase.generation
  }), canonicalRoot);
  if (finalEditor.status !== 'saved'
      || finalEditor.observationSha256 !== observation.observationSha256) {
    return unavailable('REV_EDITOR_STATE_CHANGED',
      'Editor buffers changed during REV context observation. Save and retry.');
  }
  if (currentDigests.configSha256 !== configSha256
      || currentDigests.workflowSha256 !== workflowSha256
      || finalSaved.editorDiskIndexBaselineSha256 !== saved.editorDiskIndexBaselineSha256) {
    return unavailable('REV_CONTEXT_CHANGED', 'Story, configuration, or HEAD changed during REV observation.');
  }
  const repositorySha256 = bytesDigest(Buffer.from(await realpath(gitCommonDir(canonicalRoot))));
  const context = Object.freeze({
    repositorySha256, headCommit: saved.headCommit, sourceTreeSha256: saved.sourceTreeSha256,
    configSha256, workflowSha256,
    approvedIntentSha256: bindings.approvedIntentSha256,
    routeContractSha256: bindings.routeContractSha256,
    proofProfileSha256: bindings.proofProfileSha256,
    editorDiskIndexBaselineSha256: digest({
      saved: saved.editorDiskIndexBaselineSha256,
      editor: observation.observationSha256
    })
  });
  return Object.freeze({
    status: 'ready', repositoryRoot: canonicalRoot,
    subject: Object.freeze({ workId, phaseId: workflow.currentPhase,
      phaseGeneration: phase.generation }), context, savedState: saved,
    editor: observation,
    configurationSourceSha256: configurationSource ? digest(configurationSource) : null
  });
}
