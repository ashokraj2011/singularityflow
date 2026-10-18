/** Workspace-owned checkout graph. Git/workspace receipts are the inventory, not a shadow DB. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { readWorkspace, workspaceRepositoryPath } from './workspace-manifest.mjs';
import { preparedWorkspaceBranch, workspaceBranchMember } from './workspace-branch-locations.mjs';
import { captureExecutionContext } from './execution-context.mjs';
import { SingularityFlowError, removeTemporaryTree } from './util.mjs';
import { worktreeInventory, withCheckoutLifecycleLease } from './story-worktree.mjs';
import { activeSubjectLocks, currentSubjectLockOwner, prepareHeldLockRemoval,
  withRepositoryMutationLease } from './subject-lock.mjs';

const hash = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
const ordinary = async file => {
  const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  return Boolean(info?.isDirectory() && !info.isSymbolicLink());
};

async function checkoutPrivateState(root, common, permittedTokens = null) {
  const runtime = path.join(common, 'singularity-flow');
  const runtimeInfo = await lstat(runtime).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (runtimeInfo && (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink())) return true;
  const metadata = await readdir(runtime).catch(error => {
    if (error.code === 'ENOENT') return []; throw error;
  });
  if (metadata.some(name => !['branch-checkout.json', 'locks'].includes(name))) return true;
  try { await lstat(path.join(common, 'singularity-flow-documents')); return true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Only this transaction's reset-fencing lease may accompany a retired clone. Foreign,
  // corrupt and unknown leases are preservation reasons, not disposable metadata.
  const lockRoot = path.join(runtime, 'locks');
  if (metadata.includes('locks') && !await ordinary(lockRoot)) return true;
  const lockEntries = await readdir(lockRoot).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error));
  const locks = await activeSubjectLocks(root);
  if (lockEntries.some(name => !locks.some(lock => lock.directory === path.join(lockRoot, name)))) return true;
  return locks.some(lock => {
    if (!lock.owner?.subject) return true;
    const held = permittedTokens?.has(lock.owner.lockToken)
      || currentSubjectLockOwner(root, lock.owner.subject)?.lockToken === lock.owner.lockToken;
    return !held;
  });
}

/** All worktrees are observed from Git; none are reconstructed from Story/display names. */
export async function workspaceCheckoutInventory(workspacePath) {
  const workspace = await readWorkspace(workspacePath);
  const canonicalWorkspace = await realpath(workspace.path);
  const candidates = new Map();
  for (const [id, repository] of Object.entries(workspace.repositories)) {
    const root = workspaceRepositoryPath(workspace, repository);
    candidates.set(root, { repositoryId: id, root, purpose: repository.adoption ? 'adopted' : 'canonical', owned: !repository.adoption });
  }
  const repos = path.join(workspace.path, 'repos');
  if (await ordinary(repos)) {
    const folders = await readdir(repos, { withFileTypes: true });
    if (folders.length > 10000) throw new SingularityFlowError('Checkout inventory exceeds its bounded folder limit.', { code: 'CHECKOUT_INVENTORY_LIMIT' });
    for (const folder of folders) {
      if (!folder.isDirectory() || folder.isSymbolicLink()) continue;
      const parent = path.join(repos, folder.name);
      for (const id of Object.keys(workspace.repositories)) {
        const root = path.join(parent, id);
        if (!await ordinary(root) || !await ordinary(path.join(root, '.git'))) continue;
        const member = await workspaceBranchMember(path.join(root, '.git'), workspace);
        if (!member || member.repositoryId !== id) continue;
        const selected = await preparedWorkspaceBranch(workspace, id, member.record.branch);
        candidates.set(root, { repositoryId: id, root, owned: true, purpose: 'branch',
          branch: member.record.branch, current: selected?.repositoryPath === root,
          createdAt: member.record.createdAt });
      }
    }
  }
  const clones = [];
  for (const candidate of candidates.values()) {
    if (!await ordinary(candidate.root)) {
      clones.push({ ...candidate, state: 'missing', worktrees: [], cleanupEligible: false }); continue;
    }
    try {
      const context = await captureExecutionContext(candidate.root, { workflow: null, fresh: true });
      const worktrees = worktreeInventory(candidate.root).map(entry => entry.path);
      // Unknown/private state, local document bytes and recovery records are never disposable.
      const privateState = await checkoutPrivateState(candidate.root, context.clone.commonDirectory);
      const structurallyEligible = candidate.purpose === 'branch' && !candidate.current
        && worktrees.length === 1 && !privateState;
      clones.push({ ...candidate, state: 'ready', clone: context.clone, worktrees,
        privateState, cleanupEligible: structurallyEligible });
    } catch (error) {
      clones.push({ ...candidate, state: 'unavailable', error: { code: error.code ?? 'CHECKOUT_UNAVAILABLE', message: error.message },
        worktrees: [], cleanupEligible: false });
    }
  }
  return { schemaVersion: 1, resultType: 'workspace-checkouts', workspaceId: workspace.id,
    workspacePath: canonicalWorkspace, clones, mutationAuthority: false };
}

/** A preview proves clean/published history using the same strict proof as capability detach. */
export async function planWorkspaceCheckoutCleanup(workspacePath, { purge = false, onlyPaths = null } = {}) {
  const inventory = await workspaceCheckoutInventory(workspacePath);
  const workspace = await readWorkspace(workspacePath);
  const { workspaceRepositoryDropProof } = await import('./workspace.mjs');
  const candidates = [], preserved = [];
  for (const clone of inventory.clones) {
    if (onlyPaths && !onlyPaths.includes(clone.root)) continue;
    if (!clone.cleanupEligible) { preserved.push({ path: clone.root, reason: clone.state !== 'ready' ? clone.state
      : clone.current ? 'selected-branch-checkout' : clone.privateState ? 'private-or-recovery-state'
      : clone.worktrees.length > 1 ? 'dependent-worktrees' : 'retained-canonical-or-adopted-checkout' }); continue; }
    try {
      const proof = await workspaceRepositoryDropProof(workspace,
        { ...workspace.repositories[clone.repositoryId], id: clone.repositoryId }, { state: 'ready', dirty: false }, { targetPath: clone.root });
      candidates.push({ repositoryId: clone.repositoryId, ...proof });
    } catch (error) { preserved.push({ path: clone.root, reason: error.code ?? 'unverified', message: error.message }); }
  }
  const facts = { workspaceId: inventory.workspaceId, workspacePath: inventory.workspacePath, mode: purge ? 'purge' : 'retire', candidates };
  return { schemaVersion: 1, resultType: 'workspace-checkout-cleanup', ...facts, preserved,
    confirmation: hash(facts), applied: false, effects: 'preview-only' };
}

/** Retire into workspace-owned quarantine; no recursive deletion or lifecycle/remote mutation. */
export async function applyWorkspaceCheckoutCleanup(workspacePath, confirmation, { purge = false, onlyPaths = null, beforeRetire = null } = {}) {
  const { withRegistryFileLease } = await import('./file-lease.mjs');
  return withRegistryFileLease(path.join(workspacePath, 'workspace.json'), async () => {
    const plan = await planWorkspaceCheckoutCleanup(workspacePath, { purge, onlyPaths });
    if (confirmation !== plan.confirmation) throw new SingularityFlowError(
      'Checkout cleanup changed. Review a new cleanup preview; nothing was retired.', { code: 'CHECKOUT_CLEANUP_STALE' });
    const retired = [];
    try {
    for (const candidate of plan.candidates) {
      await withCheckoutLifecycleLease(candidate.path, () => withRepositoryMutationLease(candidate.path, 'workspace.cleanup', async () => {
      // The proof is re-observed immediately before each move. No clone with a new dependent
      // worktree, source change, recovery file or moved pointer may be retired from an old plan.
      const fresh = await planWorkspaceCheckoutCleanup(workspacePath, { purge, onlyPaths });
      const same = fresh.candidates.find(item => item.path === candidate.path);
      if (!same || hash(same) !== hash(candidate)) throw new SingularityFlowError(
        'Checkout changed during cleanup. Earlier retirements remain recoverable.', {
          code: 'CHECKOUT_CLEANUP_STALE', details: { retired }
        });
      const target = `${candidate.path}.retired-${randomUUID()}`;
      const permittedTokens = new Set((await activeSubjectLocks(candidate.path))
        .filter(lock => lock.owner?.subject
          && currentSubjectLockOwner(candidate.path, lock.owner.subject)?.lockToken === lock.owner.lockToken)
        .map(lock => lock.owner.lockToken));
      const handover = await prepareHeldLockRemoval(candidate.path);
      await beforeRetire?.();
      await rename(candidate.path, target);
      const retirement = { from: candidate.path, to: target, recovery: 'rename-back-after-inspection', removed: false };
      retired.push(retirement);
      await handover.commit(target);
      if (purge) {
        const workspace = await readWorkspace(workspacePath);
        const { workspaceRepositoryDropProof } = await import('./workspace.mjs');
        const proof = await workspaceRepositoryDropProof(workspace,
          { ...workspace.repositories[candidate.repositoryId], id: candidate.repositoryId },
          { state: 'ready', dirty: false }, { targetPath: target });
        if (proof.head !== candidate.head || proof.refsSha256 !== candidate.refsSha256
            || proof.worktreeSha256 !== candidate.worktreeSha256
            || hash(proof.directoryIdentity) !== hash(candidate.directoryIdentity)
            || await checkoutPrivateState(target, path.join(target, '.git'), permittedTokens)) throw new SingularityFlowError(
          'Retired checkout changed; its recoverable directory was preserved.', { code: 'CHECKOUT_CLEANUP_STALE', details: { retired } });
        await beforeRetire?.();
        await removeTemporaryTree(target);
        retirement.removed = true;
        retirement.recovery = 'published-git-history';
      }
      }));
    }
    } catch (error) {
      error.details = { ...(error.details ?? {}), retired,
        preservation: 'Unremoved quarantines remain recoverable at their reported paths.' };
      throw error;
    }
    return { ...plan, applied: true, effects: purge ? 'verified-unused-clones-removed' : 'recoverable-retirement', retired };
  });
}
