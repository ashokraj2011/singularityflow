/** Machine-local retention. It removes proven published checkouts, never Story refs or authority. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readWorkspace } from './workspace-manifest.mjs';
import { writeAtomic, run, SingularityFlowError } from './util.mjs';
import { withRegistryFileLease } from './file-lease.mjs';

export const DEFAULT_WORKSPACE_RETENTION = Object.freeze({ enabled: true, completedDays: 7,
  cancelledDays: 7, unusedCloneDays: 7, intervalMinutes: 1440 });
const DAY = 86400000;
const fail = (message, code = 'WORKSPACE_RETENTION_UNVERIFIED') => {
  throw new SingularityFlowError(message, { code });
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function localDirectory(workspacePath) {
  const root = await realpath(workspacePath), directory = path.join(root, '.singularity-flow');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Unsafe workspace maintenance directory.');
  return directory;
}
async function readLocal(file, fallback, limit = 512 * 1024) {
  const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info) return fallback;
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) fail('Unsafe workspace retention record.');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { fail('Unreadable workspace retention record; automatic cleanup is suspended.'); }
}
export function normalizeWorkspaceRetention(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_WORKSPACE_RETENTION, key))) fail('Unknown retention setting.', 'WORKSPACE_RETENTION_SETTINGS_INVALID');
  const settings = { ...DEFAULT_WORKSPACE_RETENTION, ...value };
  if (typeof settings.enabled !== 'boolean' || ['completedDays', 'cancelledDays', 'unusedCloneDays']
    .some(key => !Number.isInteger(settings[key]) || settings[key] < 0 || settings[key] > 3650)
      || !Number.isInteger(settings.intervalMinutes) || settings.intervalMinutes < 1 || settings.intervalMinutes > 10080) {
    fail('Retention needs enabled true/false, integer days 0–3650, and intervalMinutes 1–10080.', 'WORKSPACE_RETENTION_SETTINGS_INVALID');
  }
  return Object.freeze(settings);
}
export async function workspaceRetentionSettings(workspacePath) {
  const workspace = await readWorkspace(workspacePath), directory = await localDirectory(workspace.path);
  const record = await readLocal(path.join(directory, 'retention-policy.json'), null, 8192);
  if (record && (record.format !== 1 || !record.settings || typeof record.settings !== 'object')) fail('Unsupported workspace retention policy.');
  return normalizeWorkspaceRetention(record?.settings);
}
export async function saveWorkspaceRetention(workspacePath, change) {
  const directory = await localDirectory((await readWorkspace(workspacePath)).path);
  const file = path.join(directory, 'retention-policy.json');
  return withRegistryFileLease(file, async () => {
    const settings = normalizeWorkspaceRetention({ ...await workspaceRetentionSettings(workspacePath), ...change });
    // schema-transient: machine-local retention preferences, not shared workflow policy.
    await writeAtomic(file, JSON.stringify({ format: 1, settings }), { mode: 0o600 });
    return settings;
  });
}

/** Window presence prevents an idle terminal Story open in another window from being removed. */
export async function touchWorkspaceCheckout(workspacePath, root, { surface, pid } = {}) {
  if (!/^[a-zA-Z0-9-]{1,80}$/u.test(surface ?? '') || !Number.isInteger(pid) || pid < 1) fail('Invalid checkout presence.');
  const directory = path.join(await localDirectory(workspacePath), 'checkout-presence');
  await mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Unsafe checkout presence directory.');
  await writeAtomic(path.join(directory, `${surface}.json`), JSON.stringify({ format: 1,
    root: await realpath(root), pid, touchedAt: new Date().toISOString() }), { mode: 0o600 });
}
async function protectedRoots(workspacePath, supplied) {
  const roots = [process.cwd(), ...supplied].map(root => path.resolve(root));
  const { readActiveWorkspaceContext, activeWorkspaceFile, workspaceRegistryFile } = await import('./workspace-context.mjs');
  const active = await readActiveWorkspaceContext(activeWorkspaceFile(), workspaceRegistryFile(), { refresh: false });
  if (active?.repositoryPath) roots.push(active.repositoryPath);
  const directory = path.join(await localDirectory(workspacePath), 'checkout-presence');
  const info = await lstat(directory).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && (!info.isDirectory() || info.isSymbolicLink())) fail('Unsafe checkout presence directory.');
  const files = info ? await readdir(directory) : [];
  if (files.length > 1024) fail('Checkout presence inventory is too large.');
  for (const file of files) {
    if (!/^[a-zA-Z0-9-]{1,80}\.json$/u.test(file)) fail('Unknown checkout presence record.');
    const record = await readLocal(path.join(directory, file), null, 16384);
    if (record?.format !== 1 || typeof record.root !== 'string' || record.root.includes('\0')
        || !path.isAbsolute(record.root) || !Number.isInteger(record.pid) || record.pid < 1) fail('Invalid checkout presence record.');
    try { process.kill(record.pid, 0); roots.push(record.root); }
    catch (error) {
      if (error.code === 'EPERM') roots.push(record.root);
      else if (error.code === 'ESRCH') await unlink(path.join(directory, file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      else throw error;
    }
  }
  return roots;
}
export function terminalRetentionTimestamp(workflow) {
  if (workflow.status === 'cancelled') return Date.parse(workflow.cancellation?.cancelledAt);
  if (workflow.status !== 'closed') return NaN;
  const dates = Object.values(workflow.phases ?? {}).map(phase => Date.parse(phase.approvedAt)).filter(Number.isFinite);
  return dates.length ? Math.max(...dates) : NaN;
}

/** Preserve local session/audit bytes outside the disposable clone, without moving recovery. */
async function retainWorktreeMetadata(workspacePath, root, workId) {
  const { gitDir } = await (await import('./repo-context.mjs')).createRepoContext(root).observe('repository.paths');
  const source = path.join(gitDir, 'singularity-flow');
  const sourceInfo = await lstat(source).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (!sourceInfo) return null;
  const parent = path.join(await localDirectory(workspacePath), 'retained-worktree-metadata');
  await mkdir(parent, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('Unsafe metadata retention directory.');
  const target = path.join(parent, `${digest([root, workId]).slice(0, 24)}-${randomUUID()}`);
  await mkdir(target, { mode: 0o700 });
  if (process.platform === 'win32') await (await import('./mcp-auth-profile.mjs')).secureWindowsAuthAcl(target, { directory: true, apply: true });
  const files = [], pending = [''];
  let bytes = 0, entries = 0;
  while (pending.length) {
    const relative = pending.pop(), directory = path.join(source, relative);
    const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink()) fail('Unsafe private metadata; checkout retained.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = path.join(relative, entry.name), file = path.join(source, next), stat = await lstat(file);
      if (++entries > 4096) fail('Private metadata retention exceeds its bounds.');
      if (stat.isSymbolicLink()) fail('Linked private metadata; checkout retained.');
      if (stat.isDirectory()) {
        await mkdir(path.join(target, next), { mode: 0o700 }); pending.push(next);
      } else {
        if (!stat.isFile() || bytes + stat.size > 16 * 1024 * 1024 || files.length > 4096) fail('Private metadata retention exceeds its bounds.');
        bytes += stat.size;
        const before = await readFile(file);
        await copyFile(file, path.join(target, next));
        if (!before.equals(await readFile(path.join(target, next))) || !before.equals(await readFile(file))) fail('Private metadata changed; checkout retained.');
        files.push({ path: next, sha256: createHash('sha256').update(before).digest('hex') });
      }
    }
  }
  await writeAtomic(path.join(target, 'RETENTION.json'), JSON.stringify({ format: 1, workId, source: root, files }), { mode: 0o600 });
  return target;
}

export async function recordWorkspaceRetentionFailure(workspacePath, error) {
  const directory = await localDirectory((await readWorkspace(workspacePath)).path);
  await writeAtomic(path.join(directory, 'cleanup-error.json'), JSON.stringify({ format: 1,
    at: new Date().toISOString(), code: error.code ?? 'WORKSPACE_RETENTION_FAILED',
    message: String(error.message).slice(0, 8192) }), { mode: 0o600 });
}

/** No force-removal. All destroyed bytes are published files or rebuildable Git index metadata. */
export async function terminalStoryWorktreeProof(workspace, clone, entry, { settings, now, protect = [] }) {
  const { workspaceDropGitEnvironment, assertWorkspaceDropLocalGitConfiguration, gitWriterLocks } = await import('./workspace.mjs');
  const env = workspaceDropGitEnvironment();
  const git = args => run('git', args, { cwd: entry.path, env, timeoutMs: 30000, maxBuffer: 8 * 1024 * 1024 }).stdout.trim();
  const root = await realpath(entry.path);
  if (!contains(await realpath(workspace.path), root)) fail('Story worktree is outside this workspace.');
  if (protect.some(selected => contains(root, selected))) fail('Checkout is selected or in use.', 'WORKSPACE_RETENTION_IN_USE');
  const own = await lstat(path.join(root, '.git'));
  if (!own.isFile() || own.isSymbolicLink()) fail('Story checkout has no ordinary Git worktree link.');
  const common = await realpath(path.resolve(root, git(['rev-parse', '--git-common-dir'])));
  if (common !== await realpath(clone.clone.commonDirectory)) fail('Story worktree changed owner.');
  const privateGit = await realpath(git(['rev-parse', '--absolute-git-dir']));
  if (path.dirname(privateGit) !== path.join(common, 'worktrees')) fail('Unexpected worktree metadata owner.');
  const privateFiles = await readdir(privateGit);
  const allowed = new Set(['HEAD', 'ORIG_HEAD', 'commondir', 'gitdir', 'index', 'logs', 'singularity-flow', 'COMMIT_EDITMSG', 'refs']);
  if (privateFiles.some(file => !allowed.has(file))) fail(`Private Git operation or recovery metadata is retained: ${privateFiles.filter(file => !allowed.has(file)).join(', ')}.`);
  if (privateFiles.includes('COMMIT_EDITMSG') && (await readFile(path.join(privateGit, 'COMMIT_EDITMSG'), 'utf8')).trim()
      !== git(['log', '-1', '--format=%B'])) fail('Unpublished commit message draft is retained.');
  for (const file of privateFiles) {
    if ((await lstat(path.join(privateGit, file))).isSymbolicLink()) fail('Linked private metadata is retained.');
  }
  if (privateFiles.includes('refs')) {
    const pending = [path.join(privateGit, 'refs')];
    let count = 0;
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (++count > 256 || !entry.isDirectory() || entry.isSymbolicLink()) fail('Private worktree refs are retained.');
        pending.push(path.join(directory, entry.name));
      }
    }
  }
  const privateRuntime = path.join(privateGit, 'singularity-flow');
  const runtimeInfo = await lstat(privateRuntime).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (runtimeInfo) {
    if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink()
        || (await readdir(privateRuntime)).some(file => !['cache', 'session.json', 'copilot-session.json', 'dx', 'harness-events', 'logs', 'temporary-indexes'].includes(file))) fail('Private Story recovery state is retained.');
    const indexes = path.join(privateRuntime, 'temporary-indexes');
    const indexesInfo = await lstat(indexes).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (indexesInfo && (!indexesInfo.isDirectory() || indexesInfo.isSymbolicLink() || (await readdir(indexes)).length)) fail('Private candidate indexes are retained.');
  }
  const sharedRuntime = path.join(common, 'singularity-flow');
  for (const name of await readdir(sharedRuntime).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!/recovery|pending|rescue|outbox|intent|journal/iu.test(name)) continue;
    const file = path.join(sharedRuntime, name), info = await lstat(file);
    if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(file)).length) fail('Shared publication/recovery state is retained.');
  }
  if ((await gitWriterLocks(privateGit)).length || (await gitWriterLocks(common)).length) fail('Git has an active writer.');
  const { activeSubjectLocks, currentSubjectLockOwner } = await import('./subject-lock.mjs');
  if ((await activeSubjectLocks(root)).some(lock => !lock.owner?.subject
      || currentSubjectLockOwner(root, lock.owner.subject)?.lockToken !== lock.owner.lockToken)) fail('A repository operation is active.');
  const { worktreeFingerprint } = await import('./worktree-fingerprint.mjs');
  if (worktreeFingerprint(root, { fresh: true, env, exhaustive: true }).dirty
      || git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=none'])) fail('Story has local, hidden or ignored files.');
  await assertWorkspaceDropLocalGitConfiguration({ id: clone.repositoryId }, root, { env, worktreeGitDirectory: privateGit });
  const head = git(['rev-parse', 'HEAD']), branch = git(['symbolic-ref', '--short', 'HEAD']);
  if (head !== entry.head || branch !== entry.branch) fail('Story checkout changed.');
  if (git(['rev-list', '--max-count=1', '--reflog', 'HEAD', '--not', head])) fail('Private reflog retains unpublished history.');
  const original = run('git', ['rev-parse', '--verify', 'ORIG_HEAD'], { cwd: root, env, allowFailure: true });
  if (original.status === 0 && run('git', ['merge-base', '--is-ancestor', original.stdout.trim(), head],
    { cwd: root, env, allowFailure: true }).status !== 0) fail('ORIG_HEAD retains unmerged history.');
  const { withReadScope } = await import('./read-scope.mjs');
  const accepted = await withReadScope(() => import('./accepted-story-execution.mjs').then(module => module.loadAcceptedStoryExecution(root, branch)));
  const workflow = accepted.workflow;
  if (!['closed', 'cancelled'].includes(workflow.status) || workflow.currentPhase != null && workflow.status === 'closed') fail('Story is not terminal.');
  const { storyWorktreeLocations } = await import('./story-worktree.mjs');
  const locations = await Promise.all([{ workspacePath: workspace.path, repositoryId: clone.repositoryId }, null]
    .map(context => storyWorktreeLocations(clone.root, workflow.workItem.id, { context })));
  if (!locations.some(location => [location.compact, location.legacy].includes(root))) fail('Story checkout path is not its owned location.');
  const at = terminalRetentionTimestamp(workflow), days = workflow.status === 'closed' ? settings.completedDays : settings.cancelledDays;
  if (!Number.isFinite(at) || now < at || now - at < days * DAY) fail('Story retention has not elapsed.', 'WORKSPACE_RETENTION_NOT_DUE');
  const repository = workspace.repositories[clone.repositoryId];
  const { configuredRemoteIdentity, frozenRemoteTransport } = await import('./git-remote-diagnostics.mjs');
  if (configuredRemoteIdentity(root, 'origin', { direction: 'fetch' }).url !== repository.url) fail('Story remote identity changed.');
  const { GitRemoteSession, requireRemoteObservation } = await import('./git-execution.mjs');
  const transport = frozenRemoteTransport(repository.url);
  const observed = requireRemoteObservation(await new GitRemoteSession({ cwd: root, env: transport.env }).observeAsync(repository.url,
    { refs: [`refs/heads/${branch}`], includeHead: false, timeoutMs: 30000 }), 'Story cleanup publication');
  if (observed.refs.get(`refs/heads/${branch}`) !== head) fail('Exact terminal Story revision is not published; nothing was removed.', 'WORKSPACE_RETENTION_UNPUBLISHED');
  return { root, head, branch, workId: workflow.workItem.id, status: workflow.status, terminalAt: new Date(at).toISOString() };
}

/** Interval-gated, bounded maintenance. Errors are retained, never converted into eligibility. */
export async function runWorkspaceRetention(workspacePath, { force = false, now = Date.now(), protect = [] } = {}) {
  const workspace = await readWorkspace(workspacePath), directory = await localDirectory(workspace.path);
  const settings = await workspaceRetentionSettings(workspace.path);
  if (!settings.enabled) return { status: 'disabled', settings, removed: [] };
  const stateFile = path.join(directory, 'cleanup-state.json');
  return withRegistryFileLease(stateFile, async () => {
    const state = await readLocal(stateFile, { format: 1, unused: {} });
    if (state.format !== 1 || !state.unused || typeof state.unused !== 'object' || Array.isArray(state.unused)) fail('Invalid cleanup journal.');
    if (!force && state.status === 'completed' && state.checkedAt && now >= Date.parse(state.checkedAt)
        && now - Date.parse(state.checkedAt) < settings.intervalMinutes * 60000) return { status: 'not-due', settings, removed: [] };
    const result = { format: 1, status: 'completed', checkedAt: new Date(now).toISOString(), settings,
      removed: [], preserved: [], unused: {} };
    const { workspaceCheckoutInventory, planWorkspaceCheckoutCleanup, applyWorkspaceCheckoutCleanup } = await import('./workspace-checkout-inventory.mjs');
    const { withCheckoutLifecycleLease, worktreeInventory } = await import('./story-worktree.mjs');
    const { withRepositoryMutationLease, withSubjectLock } = await import('./subject-lock.mjs');
    const inventory = await workspaceCheckoutInventory(workspace.path);
    const unchangedPolicy = async () => {
      if (digest(await workspaceRetentionSettings(workspace.path)) !== digest(settings)) fail('Retention policy changed during maintenance.');
    };
    let inspected = 0;
    const deadline = Date.now() + 120000;
    for (const clone of inventory.clones) {
      if (clone.state !== 'ready') continue;
      for (const entry of worktreeInventory(clone.root)) {
        if (++inspected > 128 || Date.now() > deadline) { result.preserved.push({ path: clone.root, reason: 'maintenance-budget' }); break; }
        if (entry.path === clone.root) continue;
        let retainedMetadata = null;
        try {
          await withRegistryFileLease(path.join(workspace.path, 'workspace.json'), () => withCheckoutLifecycleLease(clone.root,
            () => withRepositoryMutationLease(clone.root, 'workspace.retention', async () => {
              await unchangedPolicy();
              const roots = await protectedRoots(workspace.path, protect);
              const proof = await terminalStoryWorktreeProof(workspace, clone, entry, { settings, now, protect: roots });
              // Share the lifecycle owner's lease: a concurrent reopen/publication must not
              // begin between the last terminal-state observation and no-force removal.
              await withSubjectLock(clone.root, { kind: 'story', id: proof.workId }, async () => {
              retainedMetadata = await retainWorktreeMetadata(workspace.path, proof.root, proof.workId);
              // Recheck bytes/identity/presence immediately before Git's own no-force dirty check.
              const fresh = await terminalStoryWorktreeProof(workspace, clone, entry,
                { settings, now, protect: await protectedRoots(workspace.path, protect) });
              if (digest(proof) !== digest(fresh)) fail('Story cleanup proof changed.');
              await unchangedPolicy();
              if ((await protectedRoots(workspace.path, protect)).some(selected => contains(proof.root, selected))) fail('Checkout became active.', 'WORKSPACE_RETENTION_IN_USE');
              run('git', ['worktree', 'remove', '--', proof.root], { cwd: clone.root,
                env: (await import('./workspace.mjs')).workspaceDropGitEnvironment(), timeoutMs: 30000 });
              result.removed.push({ kind: 'story-worktree', ...proof, recovery: 'published-story-ref', retainedMetadata, branchDeleted: false });
              await writeAtomic(stateFile, JSON.stringify({ ...result, status: 'running' }), { mode: 0o600 });
              });
            })));
        } catch (error) { result.preserved.push({ path: entry.path, reason: error.code ?? 'unverified', message: error.message,
          ...(retainedMetadata ? { retainedMetadata } : {}) }); }
      }
    }
    const after = await workspaceCheckoutInventory(workspace.path);
    for (const clone of after.clones.filter(item => item.cleanupEligible).slice(0, 32)) {
      if (Date.now() > deadline) { result.preserved.push({ path: clone.root, reason: 'maintenance-budget' }); break; }
      const key = digest([clone.root, clone.clone.id, clone.createdAt]), previous = state.unused[key];
      const since = typeof previous === 'string' && Number.isFinite(Date.parse(previous)) && Date.parse(previous) <= now ? previous : new Date(now).toISOString();
      result.unused[key] = since;
      if (now - Date.parse(since) < settings.unusedCloneDays * DAY) continue;
      try {
        await unchangedPolicy();
        if ((await protectedRoots(workspace.path, protect)).some(root => contains(clone.root, root))) fail('Clone is in use.', 'WORKSPACE_RETENTION_IN_USE');
        const onlyPaths = [clone.root], plan = await planWorkspaceCheckoutCleanup(workspace.path, { purge: true, onlyPaths });
        if (!plan.candidates.length) { result.preserved.push(...plan.preserved); continue; }
        const beforeRetire = async () => {
          await unchangedPolicy();
          if ((await protectedRoots(workspace.path, protect)).some(root => contains(clone.root, root))) fail('Clone became active.', 'WORKSPACE_RETENTION_IN_USE');
        };
        const applied = await applyWorkspaceCheckoutCleanup(workspace.path, plan.confirmation, { purge: true, onlyPaths, beforeRetire });
        result.removed.push(...applied.retired.map(item => ({ kind: 'unused-clone', ...item })));
        delete result.unused[key];
        await writeAtomic(stateFile, JSON.stringify({ ...result, status: 'running' }), { mode: 0o600 });
      } catch (error) { result.preserved.push({ path: clone.root, reason: error.code ?? 'unverified', message: error.message,
        ...(error.details?.retired ? { retired: error.details.retired } : {}) }); }
    }
    result.preserved = result.preserved.slice(0, 256);
    // schema-transient: local maintenance journal/diagnostics; never deletion authority on its own.
    await writeAtomic(stateFile, JSON.stringify(result), { mode: 0o600 });
    return result;
  }, { timeoutMs: 1000 });
}
