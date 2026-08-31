import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, realpath, rm } from 'node:fs/promises';
import YAML from 'yaml';
import {
  forgetWorkspace, readWorkspace, readWorkspaceRegistry, workspaceRepositoryPath, workspaceStatus
} from './workspace.mjs';
import { run, SingularityFlowError, writeAtomic } from './util.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { branch, gitCommonDir, gitDir, head, repoRoot } from './git.mjs';
import { configuredRemoteIdentity, sanitizeRemote } from './git-remote-diagnostics.mjs';

export const ACTIVE_WORKSPACE_SCHEMA_VERSION = currentSchemaVersion('active-workspace');

export function workspaceRegistryFile(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY
    || path.join(home, '.singularity-flow', 'workspaces.json'));
}

export function activeWorkspaceFile(env = process.env, home = os.homedir()) {
  return path.resolve(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE
    || path.join(home, '.singularity-flow', 'active-workspace.json'));
}

function normalized(value) {
  return String(value ?? '').trim().toLocaleLowerCase('en-US');
}

function portableStoryId(value) {
  const storyId = String(value ?? '').trim();
  if (!storyId) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(storyId)) {
    throw new SingularityFlowError('Story ID must be a portable Jira or work-item identifier.');
  }
  return storyId;
}

async function canonical(value) {
  const resolved = path.resolve(value);
  return realpath(resolved).catch(() => resolved);
}

function freezeSnapshot(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeSnapshot(child);
  return Object.freeze(value);
}

function workspaceSnapshotDigest(workspace) {
  return `sha256:${createHash('sha256').update(JSON.stringify(workspace)).digest('hex')}`;
}

function withWorkspaceSnapshot(context, workspace) {
  if (!workspace) return context;
  const snapshot = freezeSnapshot(structuredClone(workspace));
  Object.defineProperties(context, {
    // Keep the manifest out of ordinary JSON responses while making every authority-sensitive
    // consumer reuse the exact validated object which proved membership. Re-reading workspace.json
    // after this point could combine repository membership from one atomic revision with an
    // authority URL or delivery map from another.
    workspace: { value: snapshot, enumerable: false, configurable: false, writable: false },
    workspaceManifestSha256: {
      value: workspaceSnapshotDigest(snapshot), enumerable: true, configurable: false, writable: false
    }
  });
  return context;
}

async function verifiedWorkspaceMemberRepository(root, member, { strict }) {
  const expected = String(member.repository?.url ?? '').trim();
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: root, allowFailure: true });
  const actualTop = top.status === 0 && top.stdout.trim()
    ? await canonical(top.stdout.trim())
    : null;
  let actualOrigin = '';
  try {
    // Workspace manifests retain the reviewed, raw remote URL. Do not compare it with
    // `git remote get-url`: that command applies mutable url.*.insteadOf rewrites and therefore
    // proves a transport choice, not the checkout's configured repository identity.
    actualOrigin = configuredRemoteIdentity(root, 'origin', { direction: 'fetch' }).url ?? '';
  } catch {
    // Credential-bearing or otherwise unsafe remotes are identity drift. They are never copied
    // into an error object or durable diagnostic.
  }
  const valid = actualTop === root && actualOrigin && actualOrigin === expected;
  if (valid) return true;
  if (strict) {
    throw new SingularityFlowError(
      `Workspace repository '${member.repositoryId}' no longer matches its reviewed Git identity. Select or repair the workspace before governed work.`,
      {
        code: 'WORKSPACE_REPOSITORY_IDENTITY_MISMATCH',
        details: {
          repositoryId: member.repositoryId,
          expectedRemote: sanitizeRemote(expected),
          actualRemote: actualOrigin ? sanitizeRemote(actualOrigin) : null
        }
      }
    );
  }
  return false;
}

/**
 * The workspace registry is a machine-local convenience index, not governed state. A repository
 * which explicitly declares an obsolete workflow version cannot be opened by any current surface,
 * so retaining it only produces the same blocking error on every launch. Drop that registration
 * (and an active selection pointing at it) without touching the workspace directory or clone.
 *
 * Missing workflow files stay registered: an uninitialized clone is a valid setup state. YAML that
 * cannot be parsed also stays registered so Configuration can expose the file for repair. Only an
 * unambiguous, successfully parsed non-v2 declaration is discarded. There is intentionally no
 * conversion path during this POC.
 */
export async function discardUnsupportedWorkflowWorkspaces(registryFile, selectionFile = null) {
  const entries = await readWorkspaceRegistry(registryFile);
  const removed = [];
  for (const entry of entries) {
    let lead = entry.leadRepositoryPath;
    if (!lead) {
      try {
        const workspace = await readWorkspace(entry.path);
        lead = workspaceRepositoryPath(workspace, workspace.repositories[workspace.leadRepository]);
      } catch { continue; }
    }
    let text;
    try { text = await readFile(path.join(lead, 'singularity', 'workflow.yml'), 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') continue;
      continue;
    }
    let workflow;
    try { workflow = YAML.parse(text); }
    catch { continue; }
    if (workflow?.version === 2) continue;
    removed.push({
      id: entry.id,
      name: entry.name,
      path: entry.path,
      leadRepositoryPath: lead,
      version: workflow?.version ?? null,
      reason: workflow?.version == null
        ? 'workflow.yml does not declare version 2'
        : `workflow.yml declares unsupported version ${workflow.version}`
    });
    await forgetWorkspace(registryFile, entry.path);
  }

  if (selectionFile && removed.length) {
    let selected = null;
    try { selected = JSON.parse(await readFile(selectionFile, 'utf8')); } catch { /* absent is fine */ }
    if (selected && removed.some((entry) => entry.id === selected.workspaceId
      && (!selected.workspacePath || path.resolve(entry.path) === path.resolve(selected.workspacePath)))) {
      await rm(selectionFile, { force: true });
    }
  }
  return { removed, remaining: await readWorkspaceRegistry(registryFile) };
}

export async function resolveWorkspaceReference(registryFile, reference) {
  const entries = (await readWorkspaceRegistry(registryFile)).filter((entry) => !entry.archivedAt);
  if (!entries.length) {
    throw new SingularityFlowError('No workspaces are saved. Create or open a workspace in Singularity Flow first.');
  }
  const requested = String(reference ?? '').trim();
  if (!requested) {
    if (entries.length === 1) return entries[0];
    throw new SingularityFlowError('Choose a workspace by ID, name, Jira anchor, or directory.');
  }

  const requestedPath = requested.includes(path.sep) || path.isAbsolute(requested)
    ? await canonical(requested)
    : null;
  const key = normalized(requested);
  const matches = entries.filter((entry) => {
    if (requestedPath && entry.path === requestedPath) return true;
    return [entry.id, entry.name, entry.anchorKey].some((value) => normalized(value) === key);
  });
  if (!matches.length) {
    throw new SingularityFlowError(`Workspace '${requested}' is not saved. Run 'singularity-flow workspace list'.`);
  }
  if (matches.length > 1) {
    throw new SingularityFlowError(`Workspace reference '${requested}' is ambiguous. Use its workspace ID or full directory.`);
  }
  return matches[0];
}

async function detectedStory(repositoryPath, branchName) {
  if (!branchName) return null;
  const index = await buildRepositorySubjectIndex(repositoryPath);
  const resolved = resolveContext(index, { reference: branchName, kind: 'story', required: false });
  return resolved ? portableStoryId(resolved.id) : null;
}

export function workspacePromptLabel(context) {
  const workspace = String(context?.workspaceName ?? context?.workspaceId ?? 'Workspace').trim();
  const story = String(context?.storyId ?? '').trim();
  return `${workspace}${story ? ` / ${story}` : ''} >`;
}

export async function buildWorkspaceContext(registryFile, reference, {
  repositoryId = null,
  storyId = null,
  detectStory = true
} = {}) {
  const entry = await resolveWorkspaceReference(registryFile, reference);
  const workspace = await readWorkspace(entry.path);
  const status = await workspaceStatus(workspace.path);
  const selectedRepositoryId = String(repositoryId ?? workspace.leadRepository).trim();
  const repository = status.repositories.find((item) => item.id === selectedRepositoryId);
  if (!repository) {
    throw new SingularityFlowError(`Repository '${selectedRepositoryId}' is not part of workspace '${workspace.name}'.`);
  }
  const selectedStoryId = portableStoryId(storyId)
    ?? (detectStory ? await detectedStory(repository.absolutePath, repository.branch) : null);
  let repositoryHead = null;
  if (repository.state === 'ready') {
    try { repositoryHead = head(repository.absolutePath); } catch { /* An unborn clone is reported by readiness. */ }
  }
  const context = {
    schemaVersion: ACTIVE_WORKSPACE_SCHEMA_VERSION,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePath: workspace.path,
    anchorKey: workspace.anchor.key,
    repositoryId: repository.id,
    repositoryPath: repository.absolutePath,
    canonicalRepositoryPath: repository.absolutePath,
    checkoutPath: repository.absolutePath,
    repositoryState: repository.state,
    branch: repository.branch,
    head: repositoryHead,
    capabilities: [...(workspace.capabilities ?? [])],
    repositoryCapabilities: [...(workspace.repositories[repository.id]?.capabilities ?? [])],
    storyId: selectedStoryId,
    selectionSource: 'workspace',
    selectionStatus: 'ready',
    selectionError: null,
    selectedAt: new Date().toISOString()
  };
  return { ...context, prompt: workspacePromptLabel(context) };
}

export async function activateWorkspaceContext(registryFile, selectionFile, reference, options = {}) {
  const context = await buildWorkspaceContext(registryFile, reference, options);
  await writeAtomic(selectionFile, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  return context;
}

export async function readActiveWorkspaceContext(selectionFile, registryFile, { refresh = true } = {}) {
  let selected;
  try {
    selected = readRecord('active-workspace', await readFile(selectionFile)).record;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new SingularityFlowError(`Unable to read active workspace selection: ${error.message}`);
  }
  if (!selected.workspaceId) {
    throw new SingularityFlowError('The active workspace selection is invalid. Select the workspace again.');
  }
  if (!refresh) return { ...selected, prompt: workspacePromptLabel(selected) };
  const context = await buildWorkspaceContext(registryFile, selected.workspaceId, {
    repositoryId: selected.repositoryId,
    // The selected checkout, not the canonical clone's current branch, proves the Story below.
    storyId: null
  });
  const canonicalRepositoryPath = context.repositoryPath;
  const selectedStoryId = portableStoryId(selected.storyId);
  const candidate = selected.checkoutPath ?? selected.repositoryPath;
  if (!selectedStoryId || !candidate) {
    return { ...context, selectedAt: selected.selectedAt ?? context.selectedAt };
  }
  try {
    const checkoutPath = await canonical(candidate);
    if (await canonical(gitCommonDir(checkoutPath)) !== await canonical(gitCommonDir(canonicalRepositoryPath))) {
      throw new Error('the selected checkout belongs to another Git repository');
    }
    const checkoutBranch = branch(checkoutPath);
    const checkoutStoryId = await detectedStory(checkoutPath, checkoutBranch);
    if (checkoutStoryId !== selectedStoryId) {
      throw new Error(`the selected checkout resolves to '${checkoutStoryId ?? 'no Story'}'`);
    }
    const resolved = {
      ...context,
      repositoryPath: checkoutPath,
      canonicalRepositoryPath,
      checkoutPath,
      branch: checkoutBranch,
      head: head(checkoutPath),
      storyId: selectedStoryId,
      storyWorktree: gitDir(checkoutPath) !== gitCommonDir(checkoutPath),
      selectionSource: selected.selectionSource ?? 'session-attach',
      selectionStatus: 'ready',
      selectionError: null,
      selectedAt: selected.selectedAt ?? context.selectedAt
    };
    return { ...resolved, prompt: workspacePromptLabel(resolved) };
  } catch (error) {
    const stale = {
      ...context,
      canonicalRepositoryPath,
      checkoutPath: null,
      // Preserve the explicit selection for prompts and repair UI, but mark it stale. Execution
      // resolution below refuses this record before any lifecycle command can use the canonical
      // checkout as a substitute.
      storyId: selectedStoryId,
      requestedStoryId: selectedStoryId,
      selectionSource: selected.selectionSource ?? 'session-attach',
      selectionStatus: 'stale',
      selectionError: error.message,
      selectedAt: selected.selectedAt ?? context.selectedAt
    };
    return { ...stale, prompt: workspacePromptLabel(stale) };
  }
}

/**
 * Persist the checkout proven by Story attachment or Story start.
 *
 * This is machine-local navigation state only. It never checks out a branch, changes HEAD, writes
 * governed files, or contacts a remote. The exact Git common directory and Story aggregate must
 * already agree before the selection is recorded.
 */
export async function activateWorkspaceStoryContext(
  selectionFile, registryFile, checkout, { storyId, selectionSource = 'session-attach' } = {}
) {
  const selected = await readActiveWorkspaceContext(selectionFile, registryFile, { refresh: false });
  if (!selected) return null;
  const base = await buildWorkspaceContext(registryFile, selected.workspaceId, {
    repositoryId: selected.repositoryId,
    storyId: null
  });
  const checkoutPath = await canonical(checkout);
  const canonicalRepositoryPath = await canonical(base.repositoryPath);
  if (await canonical(gitCommonDir(checkoutPath)) !== await canonical(gitCommonDir(canonicalRepositoryPath))) {
    return null;
  }
  const checkoutBranch = branch(checkoutPath);
  const actualStoryId = await detectedStory(checkoutPath, checkoutBranch);
  const expectedStoryId = portableStoryId(storyId);
  if (!actualStoryId || actualStoryId !== expectedStoryId) {
    throw new SingularityFlowError(
      `Cannot select Story '${expectedStoryId}': checkout '${checkoutPath}' resolves to '${actualStoryId ?? 'no Story'}'.`,
      {
        code: 'ACTIVE_SUBJECT_MISMATCH',
        details: { expectedWorkId: expectedStoryId, actualWorkId: actualStoryId, checkoutPath }
      }
    );
  }
  const context = {
    ...base,
    repositoryPath: checkoutPath,
    canonicalRepositoryPath,
    checkoutPath,
    branch: checkoutBranch,
    head: head(checkoutPath),
    storyId: actualStoryId,
    storyWorktree: gitDir(checkoutPath) !== gitCommonDir(checkoutPath),
    selectionSource,
    selectionStatus: 'ready',
    selectionError: null,
    selectedAt: new Date().toISOString()
  };
  await writeAtomic(selectionFile, `${JSON.stringify(context, null, 2)}\n`, { mode: 0o600 });
  return { ...context, prompt: workspacePromptLabel(context) };
}

/**
 * Resolve the checkout a lifecycle command must use.
 *
 * A linked Story worktree containing the caller wins so independent VS Code windows cannot steal
 * one another's Story. Otherwise the last explicitly attached checkout wins over the canonical
 * launch clone. A stale Story selection fails closed instead of silently routing to another Story.
 */
export async function resolveWorkspaceExecutionContext(
  selectionFile, registryFile, { cwd = process.cwd() } = {}
) {
  const selected = await readActiveWorkspaceContext(selectionFile, registryFile);
  if (!selected) return null;
  const canonicalRepositoryPath = selected.canonicalRepositoryPath ?? selected.repositoryPath;
  let currentRoot = null;
  try { currentRoot = repoRoot(cwd); } catch { /* The active workspace may still supply the checkout. */ }
  if (currentRoot) {
    try {
      const sameRepository = await canonical(gitCommonDir(currentRoot))
        === await canonical(gitCommonDir(canonicalRepositoryPath));
      const linkedWorktree = gitDir(currentRoot) !== gitCommonDir(currentRoot);
      if (sameRepository && linkedWorktree) {
        const currentBranch = branch(currentRoot);
        const currentStoryId = await detectedStory(currentRoot, currentBranch);
        if (currentStoryId) {
          const current = {
            ...selected,
            repositoryPath: currentRoot,
            checkoutPath: currentRoot,
            canonicalRepositoryPath,
            branch: currentBranch,
            head: head(currentRoot),
            storyId: currentStoryId,
            storyWorktree: true,
            selectionSource: 'current-story-worktree',
            selectionStatus: 'ready'
          };
          return { ...current, prompt: workspacePromptLabel(current) };
        }
      }
    } catch { /* A broken caller checkout cannot override the validated selection. */ }
  }
  if (selected.selectionStatus === 'stale' && selected.requestedStoryId) {
    throw new SingularityFlowError(
      `Selected Story '${selected.requestedStoryId}' no longer has a valid checkout. Reattach it before lifecycle work.`,
      {
        code: 'ACTIVE_SUBJECT_UNAVAILABLE',
        details: {
          expectedWorkId: selected.requestedStoryId,
          canonicalRepositoryPath,
          reason: selected.selectionError ?? null,
          nextCommand: `singularity-flow session attach ${selected.requestedStoryId} --json`
        }
      }
    );
  }
  return selected;
}

/** Clear the local selection only when it points at the workspace being forgotten. */
export async function clearActiveWorkspaceContext(selectionFile, workspacePath) {
  let selected;
  try { selected = readRecord('active-workspace', await readFile(selectionFile)).record; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new SingularityFlowError(`Unable to read active workspace selection: ${error.message}`);
  }
  const selectedPath = selected?.workspacePath ? await canonical(selected.workspacePath) : null;
  const forgottenPath = await canonical(workspacePath);
  if (!selectedPath || selectedPath !== forgottenPath) return false;
  await rm(selectionFile, { force: true });
  return true;
}

export async function workspaceContextForRepository(repositoryRoot, selectionFile, registryFile, { strict = false } = {}) {
  // Session-start hooks have a short timeout and may run in workspaces with many repositories.
  // The launcher/switch command already verified and refreshed this selection, so matching the
  // persisted repository here avoids a status scan of every clone on each Copilot startup.
  const selected = readActiveWorkspaceContext(selectionFile, registryFile, { refresh: false });
  const context = strict ? await selected : await selected.catch(() => null);
  if (!context) return null;
  const root = await canonical(repositoryRoot);
  const repository = await canonical(context.repositoryPath);
  if (root === repository) return context;
  // A linked Story worktree is another checkout of the same repository, not an unknown repository.
  // Match the repository-wide Git common directory so capability, configuration and audit context
  // continue to resolve after VS Code opens the isolated checkout.
  try {
    if (await canonical(gitCommonDir(root)) === await canonical(gitCommonDir(repository))) {
      return { ...context, repositoryPath: root, canonicalRepositoryPath: repository, storyWorktree: true };
    }
  } catch { /* A non-Git path is simply not the selected workspace repository. */ }
  return null;
}

/**
 * Resolve any repository which belongs to the active workspace, not only the repository currently
 * selected for navigation.
 *
 * The active selection remains a UI/session cursor. Capability and configuration authority are
 * workspace-wide, so a command launched from another member (or one of that member's linked
 * worktrees) must still retain the member's repository ID and policy. An unrelated repository must
 * never inherit the machine's last selected workspace.
 */
export async function workspaceMemberContextForRepository(
  repositoryRoot, selectionFile, registryFile, { strict = false } = {}
) {
  let selected;
  try {
    selected = await readActiveWorkspaceContext(selectionFile, registryFile, { refresh: false });
  } catch (error) {
    if (strict) throw error;
    return null;
  }
  if (!selected) return null;
  const root = await canonical(repositoryRoot);
  const selectedRepository = selected.repositoryPath
    ? await canonical(selected.repositoryPath)
    : null;
  const selectedRepositoryExact = root === selectedRepository;
  let workspacePath = selected.workspacePath ?? null;
  let workspaceSnapshot = null;
  const contextFor = (repositoryId, canonicalRepositoryPath, repositoryCapabilities) => {
    const selectedMember = repositoryId === selected.repositoryId;
    let currentBranch = null;
    let currentHead = null;
    const linkedWorktree = root !== canonicalRepositoryPath;
    try {
      currentBranch = branch(root);
      currentHead = head(root);
    } catch { /* Membership by canonical path remains useful for an unborn repository. */ }
    return withWorkspaceSnapshot({
      ...selected,
      workspacePath: workspacePath ?? selected.workspacePath ?? null,
      repositoryId,
      repositoryPath: root,
      canonicalRepositoryPath,
      checkoutPath: root,
      repositoryCapabilities: [...(repositoryCapabilities ?? [])],
      branch: currentBranch,
      head: currentHead,
      storyId: selectedMember ? selected.storyId ?? null : null,
      requestedStoryId: selectedMember ? selected.requestedStoryId ?? null : null,
      storyWorktree: linkedWorktree,
      selectionSource: selectedMember ? selected.selectionSource : 'workspace-member',
      selectionStatus: 'ready',
      selectionError: null,
      prompt: workspacePromptLabel({ ...selected, repositoryId })
    }, workspaceSnapshot);
  };

  // Older active-selection records did not retain a workspace path. A best-effort UI consumer can
  // still use that cursor for the selected checkout, but an authority-sensitive consumer must
  // recover and validate the current manifest from the machine registry. Cached capabilities are
  // navigation hints, never configuration authority.
  if (!workspacePath && strict) {
    const candidates = (await readWorkspaceRegistry(registryFile))
      .filter((entry) => !entry.archivedAt && entry.id === selected.workspaceId);
    let matches = candidates;
    if (candidates.length > 1 && selectedRepository) {
      const exactLeadMatches = [];
      for (const entry of candidates) {
        if (entry.leadRepositoryPath
          && await canonical(entry.leadRepositoryPath) === selectedRepository) {
          exactLeadMatches.push(entry);
        }
      }
      if (exactLeadMatches.length) matches = exactLeadMatches;
    }
    if (matches.length !== 1) {
      throw new SingularityFlowError(
        `The active workspace selection for '${selected.workspaceId}' cannot be revalidated. Select the workspace again.`,
        { code: 'ACTIVE_WORKSPACE_UNAVAILABLE' }
      );
    }
    workspacePath = matches[0].path;
  }

  if (!workspacePath) {
    if (!selectedRepository) return null;
    if (selectedRepositoryExact) {
      return contextFor(
        selected.repositoryId,
        selected.canonicalRepositoryPath
          ? await canonical(selected.canonicalRepositoryPath)
          : selectedRepository,
        selected.repositoryCapabilities
      );
    }
    try {
      if (await canonical(gitCommonDir(root)) === await canonical(gitCommonDir(selectedRepository))) {
        return contextFor(
          selected.repositoryId,
          selected.canonicalRepositoryPath
            ? await canonical(selected.canonicalRepositoryPath)
            : selectedRepository,
          selected.repositoryCapabilities
        );
      }
    } catch { /* A non-Git path cannot be a linked checkout of the legacy selection. */ }
    return null;
  }

  let workspace;
  try {
    workspace = await readWorkspace(workspacePath);
    workspaceSnapshot = workspace;
  } catch (error) {
    // Authority-sensitive callers fail closed because an unreadable manifest cannot disprove that
    // an adopted outside checkout belongs to this workspace. Best-effort navigation, audit and
    // metrics callers fall back to repository-local behavior instead.
    if (strict) throw error;
    return null;
  }

  // Exact canonical member paths are the common case. Resolve all of them before asking Git for any
  // common directories, so selecting the Nth repository does not spawn Git twice for every earlier
  // member.
  const members = await Promise.all(Object.entries(workspace.repositories).map(
    async ([repositoryId, repository]) => ({
      repositoryId,
      repository,
      canonicalRepositoryPath: await canonical(workspaceRepositoryPath(workspace, repository))
    })
  ));
  const exact = members.find((member) => member.canonicalRepositoryPath === root);
  if (exact) {
    if (!await verifiedWorkspaceMemberRepository(root, exact, { strict })) return null;
    return contextFor(exact.repositoryId, exact.canonicalRepositoryPath, exact.repository.capabilities);
  }

  let rootCommonDirectory;
  try { rootCommonDirectory = await canonical(gitCommonDir(root)); }
  catch { return null; }
  for (const member of members) {
    try {
      if (await canonical(gitCommonDir(member.canonicalRepositoryPath)) === rootCommonDirectory) {
        if (!await verifiedWorkspaceMemberRepository(root, member, { strict })) return null;
        return contextFor(
          member.repositoryId, member.canonicalRepositoryPath, member.repository.capabilities
        );
      }
    } catch { /* A missing or non-Git member cannot own this linked checkout. */ }
  }
  return null;
}
