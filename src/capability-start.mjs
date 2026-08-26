/**
 * Preparing a capability's repositories at one base branch, when a Story starts.
 *
 * `capability-branches.mjs` decides *what* the base should be and refuses when it cannot be honoured
 * everywhere. This module is the part that talks to git: reading which branches each repository
 * actually publishes, asking the person to choose one, and putting every repository on the Story
 * branch cut from that base.
 *
 * Split from the decision logic because the decision is worth testing exhaustively and the git calls
 * are not — and because a refusal has to be computable without a network, so that `--json` and the
 * VS Code surface can show what would happen before anything is fetched.
 */
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
// Synchronous: the git side of this module is sync throughout, and `exists` from util is a promise —
// `if (!exists(p))` would be false forever, so the 'absent' branch below could never fire.
import { existsSync } from 'node:fs';

import {
  baseBranchRecord, baseRefusalReport, branchChoices, capabilityRepositories,
  parseBaseSelection, parseRemoteHeads, resolveCapabilityBase
} from './capability-branches.mjs';
import {
  assertClean, branch as currentBranch, checkout, fetchRemote, preflightPushBranch, pushCommitToBranch,
  gitCommonDir, refExists, refHead, repoRoot
} from './git.mjs';
import { readWorkspace } from './workspace.mjs';
import { activeWorkspaceFile, workspaceContextForRepository, workspaceRegistryFile } from './workspace-context.mjs';
import { resolveLifecycleCapability } from './capability-context.mjs';
import {
  resolveApprovedConfigurationCapability, resolveStoryConfigurationAuthority
} from './configuration-branch.mjs';
import { nowIso, run, SingularityFlowError } from './util.mjs';
import { runRemoteGit } from './git-execution.mjs';

/**
 * Which branches each repository publishes.
 *
 * `ls-remote` rather than a local `git branch -r`: the question is what exists on the remote right
 * now, and a stale local clone would offer a branch that was deleted last week or hide one created
 * this morning. A repository whose remote cannot be read is reported with no branches rather than
 * skipped, so it shows up in the refusal instead of quietly not participating.
 */
export function publishedBranches(repositories, { timeoutMs = 20000 } = {}) {
  const published = {};
  const unreachable = [];
  for (const repository of repositories) {
    const result = runRemoteGit(['ls-remote', '--heads', '--', repository.url], {
      operation: 'remote-probe', timeoutMs
    });
    if (result.status !== 0) {
      published[repository.id] = [];
      unreachable.push({ repository: repository.id, url: repository.url, detail: (result.stderr || result.stdout || '').trim() });
      continue;
    }
    published[repository.id] = parseRemoteHeads(result.stdout);
  }
  return { published, unreachable };
}

/**
 * Branch inventory for a Story start, whether this checkout belongs to a capability or stands alone.
 *
 * The old `workspace branches` path only worked when the repository declared a capability. That
 * made the editor silently fall back to `defaultBaseBranch` in the common one-repository case. This
 * catalog keeps one remote-derived contract for every surface and deliberately reports an
 * unreachable remote instead of substituting local refs.
 */
export async function storyBaseCatalog(root, {
  remote = 'origin',
  defaultBranch = 'main',
  capabilityId = null
} = {}) {
  const context = await workspaceContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile()
  ).catch(() => null);
  const capability = capabilityId ?? context?.repositoryCapabilities?.[0] ?? null;
  if (context && capability) {
    const workspace = await readWorkspace(context.workspacePath);
    const repositories = capabilityRepositories(workspace, capability);
    const { published, unreachable } = publishedBranches(repositories);
    return {
      scope: 'capability',
      capability,
      remote,
      workspaceRoot: workspace.path,
      repositoryId: context.repositoryId,
      repositories,
      published,
      unreachable,
      choices: branchChoices(published)
    };
  }

  const remoteResult = run('git', ['remote', 'get-url', remote], {
    cwd: root, allowFailure: true
  });
  const repository = {
    id: path.basename(root),
    url: remoteResult.status === 0 ? remoteResult.stdout.trim() : '',
    path: root,
    defaultBranch
  };
  if (!repository.url) {
    return {
      scope: 'repository', capability: null, remote, workspaceRoot: null,
      repositoryId: repository.id, repositories: [repository],
      published: { [repository.id]: [] },
      unreachable: [{
        repository: repository.id,
        url: '',
        detail: `Remote '${remote}' is not configured.`
      }],
      choices: []
    };
  }
  const { published, unreachable } = publishedBranches([repository]);
  return {
    scope: 'repository', capability: null, remote, workspaceRoot: null,
    repositoryId: repository.id, repositories: [repository], published, unreachable,
    choices: branchChoices(published)
  };
}

/**
 * Offer the branches and take a choice.
 *
 * Only called when there is a terminal and no `--from-branch`. Even one option requires an explicit
 * answer because this choice becomes permanent Story lineage.
 */
export async function askForBaseBranch(choices, { capability, repositoryCount } = {}) {
  if (!input.isTTY || !output.isTTY) return null;
  if (!choices.length) return null;
  const io = readline.createInterface({ input, output });
  try {
    const scope = capability
      ? `the ${repositoryCount} repositories in capability '${capability}'`
      : 'this repository';
    console.log(`\nBase branch for ${scope}:`);
    choices.forEach((choice, index) => {
      const scope = choice.everywhere ? `all ${choice.total}` : `${choice.present} of ${choice.total}`;
      console.log(`  ${index + 1}  ${choice.branch.padEnd(24)} (${scope})`);
    });
    const answer = (await io.question('Select: ')).trim();
    if (!answer) {
      throw new SingularityFlowError('Choose a base branch explicitly; no branch was selected.', {
        code: 'STORY_BASE_REQUIRED'
      });
    }
    const index = Number(answer);
    // A name is accepted as readily as a number: people type the branch they were told to use.
    if (!Number.isInteger(index) || index < 1 || index > choices.length) {
      const named = choices.find((choice) => choice.branch === answer);
      if (named) return named.branch;
      throw new SingularityFlowError(`'${answer}' is not one of the offered branches.`, { code: 'CAPABILITY_BRANCH_INVALID' });
    }
    return choices[index - 1].branch;
  } finally {
    io.close();
  }
}

/** Resolve the explicit remote base used by a new Story without touching any checkout. */
export async function storyBaseForRepository(root, {
  values = [],
  interactive = true,
  remote = 'origin',
  defaultBranch = 'main',
  capabilityId = null
} = {}) {
  const catalog = await storyBaseCatalog(root, { remote, defaultBranch, capabilityId });
  if (catalog.unreachable.length) {
    const first = catalog.unreachable[0];
    throw new SingularityFlowError(
      `Cannot read the published branches of ${catalog.unreachable.map((entry) => entry.repository).join(', ')}. `
      + `Remote access is required before a Story branch can be selected. First failure: ${first.detail || 'no detail reported'}`,
      { code: 'STORY_REMOTE_UNREACHABLE' }
    );
  }

  const usableChoices = catalog.choices.filter((choice) => choice.everywhere);
  let selection = parseBaseSelection(values);
  if (!selection.all && !Object.keys(selection.overrides).length && interactive) {
    const chosen = await askForBaseBranch(usableChoices, {
      capability: catalog.capability,
      repositoryCount: catalog.repositories.length
    });
    if (chosen) selection = parseBaseSelection([chosen]);
  }
  if (!selection.all && !Object.keys(selection.overrides).length) {
    throw new SingularityFlowError(
      `Choose the remote base branch explicitly with --from-branch <BRANCH>. Available: ${usableChoices.map((choice) => choice.branch).join(', ') || 'none'}.`,
      { code: 'STORY_BASE_REQUIRED' }
    );
  }
  const defaults = Object.fromEntries(catalog.repositories.map((repository) => [
    repository.id, repository.defaultBranch ?? defaultBranch
  ]));
  const resolution = resolveCapabilityBase({
    repositories: catalog.published,
    selection,
    defaults
  });
  if (!resolution.usable) {
    throw new SingularityFlowError(
      baseRefusalReport(resolution, { capability: catalog.capability ?? catalog.repositoryId }),
      { code: 'STORY_BASE_INVALID' }
    );
  }
  return {
    ...catalog,
    plan: {
      repositories: catalog.repositories,
      choices: catalog.choices,
      resolution,
      record: baseBranchRecord(resolution, {
        capability: catalog.capability,
        selectedAt: nowIso()
      })
    },
    localBase: resolution.resolved[catalog.repositoryId]?.branch ?? selection.all
  };
}

/**
 * Work out the base for every repository in the capability, asking if a terminal is available.
 *
 * Returns the resolution and the record to write. Throws with the full report when the branch cannot
 * be honoured everywhere — before any repository is touched, which is the whole point of doing the
 * resolution up front `[CAP:CON-001]`.
 */
export async function planCapabilityBase(workspace, capability, options = {}, {
  values = [], interactive = true
} = {}) {
  const repositories = capabilityRepositories(workspace, capability);
  const { published, unreachable } = publishedBranches(repositories);
  if (unreachable.length) {
    throw new SingularityFlowError(
      `Cannot read the published branches of ${unreachable.map((entry) => entry.repository).join(', ')}. `
      + 'A base branch is chosen for every repository in the capability at once, so the choice is not '
      + `offered until all of them answer. First failure: ${unreachable[0].detail || 'no detail reported'}`,
      { code: 'CAPABILITY_BRANCH_UNREACHABLE' }
    );
  }

  let selection = parseBaseSelection(values);
  const choices = branchChoices(published);
  if (!selection.all && !Object.keys(selection.overrides).length && interactive) {
    const chosen = await askForBaseBranch(choices, { capability, repositoryCount: repositories.length });
    if (chosen) selection = parseBaseSelection([chosen]);
  }

  const defaults = Object.fromEntries(repositories.map((repository) => [repository.id, repository.defaultBranch]));
  const resolution = resolveCapabilityBase({ repositories: published, selection, defaults });
  if (!resolution.usable) {
    throw new SingularityFlowError(baseRefusalReport(resolution, { capability }), { code: 'CAPABILITY_BRANCH_REFUSED' });
  }
  return {
    repositories,
    choices,
    resolution,
    record: baseBranchRecord(resolution, { capability, selectedAt: nowIso() })
  };
}

/**
 * Re-fetch and prove every required repository immediately before a Story start mutates any of
 * them. Branch discovery proves read access; this second pass binds the exact commit and exercises
 * write authorization for the exact destination ref. Keeping it separate from checkout makes a
 * refusal atomic across a capability: a dirty, missing, moved, read-only, or already-published
 * sibling leaves every checkout where it was.
 */
export async function preflightStoryRepositories(workspaceRoot, plan, storyBranch, {
  remote = 'origin', publishRequired = true, lifecycleRoot = null,
  capabilityId = plan?.record?.capability ?? null
} = {}) {
  // Workspace registration decides which repositories move together, but the governed capability
  // catalog decides whether that identifier exists at all. Resolve the same explicit identifier
  // createWorkflow will pin before fetching, checking out, or writing any repository. This prevents
  // a stale machine-local workspace from passing UI preflight and failing only after configuration
  // has been materialized onto a new Story branch.
  if (lifecycleRoot && capabilityId) {
    const configurationAuthority = await resolveStoryConfigurationAuthority(lifecycleRoot, remote);
    if (configurationAuthority) {
      await resolveApprovedConfigurationCapability(configurationAuthority, capabilityId);
    } else {
      await resolveLifecycleCapability(lifecycleRoot, {
        capabilityId,
        required: true,
        // Existence is the preflight question. Lease refresh remains part of authoritative workflow
        // creation; an unrelated state-branch outage must not disguise an invalid capability id.
        offline: true
      });
    }
  }
  const checked = [];
  for (const repository of plan.repositories) {
    const target = path.resolve(workspaceRoot ?? '', repository.path);
    if (!existsSync(path.join(target, '.git'))) {
      throw new SingularityFlowError(
        `Required repository '${repository.id}' is not cloned at '${target}'. Nothing was changed.`,
        { code: 'STORY_REMOTE_UNREACHABLE' }
      );
    }
    const root = repoRoot(target);
    // The lifecycle repository may be executing from its dedicated Story worktree while the
    // workspace's canonical checkout intentionally contains unrelated work. Both paths share the
    // same Git common directory, so only sibling repositories still need the legacy clean-checkout
    // precondition here.
    if (!lifecycleRoot || gitCommonDir(root) !== gitCommonDir(repoRoot(lifecycleRoot))) assertClean(root);
    fetchRemote(root, remote);
    const base = plan.resolution.resolved[repository.id];
    const sourceRef = `refs/remotes/${remote}/${base.branch}`;
    if (!refExists(root, sourceRef)) {
      throw new SingularityFlowError(
        `Selected base branch '${base.branch}' is no longer published for required repository `
        + `'${repository.id}' on remote '${remote}'. Nothing was changed.`,
        { code: 'STORY_BASE_INVALID' }
      );
    }
    const destinationRef = `refs/remotes/${remote}/${storyBranch}`;
    if (refExists(root, destinationRef)) {
      throw new SingularityFlowError(
        `Story branch '${storyBranch}' already exists for required repository '${repository.id}' `
        + `on '${remote}'. Resume it instead of overwriting it. Nothing was changed.`,
        { code: 'STORY_BRANCH_EXISTS' }
      );
    }
    if (publishRequired) {
      const dryRun = preflightPushBranch(root, remote, sourceRef, storyBranch);
      if (dryRun.status !== 0) {
        throw new SingularityFlowError(
          `Cannot publish Story branch '${storyBranch}' for required repository '${repository.id}' `
          + `to '${remote}'. Git reported: `
          + `${(dryRun.stderr || dryRun.stdout || 'remote rejected the dry-run push').trim()} Nothing was changed.`,
          { code: 'STORY_PUBLICATION_PREFLIGHT_FAILED' }
        );
      }
    }
    checked.push({
      repository: repository.id,
      root,
      remote,
      baseBranch: base.branch,
      baseCommit: refHead(root, sourceRef),
      sourceRef,
      destinationRef: `refs/heads/${storyBranch}`,
      branch: storyBranch,
      publishRequired
    });
  }
  return checked;
}

/**
 * The lifecycle repository publishes its governed opening commit through the normal Story unit of
 * work. Every other capability repository still needs the same remote Story ref so another machine
 * can materialize the complete capability rather than finding only the lead branch.
 */
export function capabilityPublicationPlan(preflight, lifecycleRoot) {
  const primary = repoRoot(lifecycleRoot);
  return (preflight ?? [])
    .filter((entry) => entry.publishRequired
      && gitCommonDir(repoRoot(entry.root)) !== gitCommonDir(primary))
    .map((entry) => ({
      schemaVersion: 1,
      repository: entry.repository,
      root: entry.root,
      remote: entry.remote,
      branch: entry.branch,
      commit: entry.baseCommit,
      destinationRef: entry.destinationRef
    }));
}

/** Publish exact preflight-bound sibling commits, returning a resumable remainder on failure. */
export function publishCapabilityRepositories(entries = []) {
  const published = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const result = pushCommitToBranch(entry.root, entry.remote, entry.commit, entry.branch);
    if (result.status !== 0) {
      return {
        published,
        pending: entries.slice(index),
        error: (result.stderr || result.stdout || 'remote rejected the Story branch').trim()
      };
    }
    published.push({
      repository: entry.repository,
      remote: entry.remote,
      branch: entry.branch,
      ref: entry.destinationRef,
      commit: entry.commit,
      pushed: true
    });
  }
  return { published, pending: [], error: null };
}

/**
 * Put every repository in the capability on the Story branch, cut from its resolved base.
 *
 * Sequential and fail-fast. A parallel version would be faster and would also leave a half-prepared
 * capability behind on the first failure, which is worse than waiting: the repositories are already
 * validated as a set, so a failure here is an unexpected local condition and stopping at it keeps
 * the damage to one repository.
 *
 * A dirty repository is refused rather than stashed. Uncommitted work in a sibling repository is not
 * this command's to move.
 */
export function rollbackCapabilityRepositories(prepared, storyBranch) {
  const failures = [];
  for (const entry of [...(prepared ?? [])].reverse()) {
    if (entry.action !== 'switched' || !entry.from) continue;
    const restored = run('git', ['switch', entry.from], { cwd: entry.target, allowFailure: true });
    if (restored.status !== 0) {
      failures.push(`${entry.repository}: ${(restored.stderr || restored.stdout).trim() || 'switch failed'}`);
      continue;
    }
    if (entry.checkoutMode?.startsWith('created-from-')) {
      const removed = run('git', ['branch', '-D', storyBranch], { cwd: entry.target, allowFailure: true });
      if (removed.status !== 0) {
        failures.push(`${entry.repository}: ${(removed.stderr || removed.stdout).trim() || 'branch cleanup failed'}`);
      }
    }
  }
  return failures;
}

export function prepareCapabilityRepositories(workspaceRoot, plan, storyBranch, {
  remote = 'origin', lifecycleRoot = null
} = {}) {
  const prepared = [];
  try {
    for (const repository of plan.repositories) {
      const target = path.resolve(workspaceRoot, repository.path);
      const base = plan.resolution.resolved[repository.id];
      if (!existsSync(path.join(target, '.git'))) {
        prepared.push({ repository: repository.id, target, base: base.branch, action: 'absent' });
        continue;
      }
      const root = repoRoot(target);
      if (lifecycleRoot && gitCommonDir(root) === gitCommonDir(repoRoot(lifecycleRoot))) {
        prepared.push({
          repository: repository.id,
          target: repoRoot(lifecycleRoot),
          base: base.branch,
          source: base.source,
          action: 'isolated-worktree'
        });
        continue;
      }
      assertClean(root);
      const already = currentBranch(root);
      const checkoutMode = checkout(root, storyBranch, {
        base: base.branch, fetch: true, remote, preferRemoteBase: true
      });
      prepared.push({
        repository: repository.id,
        target: root,
        base: base.branch,
        source: base.source,
        action: already === storyBranch ? 'already-on-branch' : 'switched',
        from: already,
        checkoutMode
      });
    }
  } catch (error) {
    const rollbackFailures = rollbackCapabilityRepositories(prepared, storyBranch);
    if (rollbackFailures.length) {
      throw new SingularityFlowError(
        `${error.message} Capability checkout rollback also failed for ${rollbackFailures.join('; ')}.`,
        { code: error.code ?? 'STORY_CAPABILITY_PREPARATION_FAILED', cause: error }
      );
    }
    throw error;
  }
  return prepared;
}

/**
 * Resolve one base branch across the capability this repository belongs to.
 *
 * Returns null — and the caller behaves exactly as before — when there is no active workspace, the
 * repository declares no capability, or nothing was asked for and there is no terminal to ask at.
 * A workspace-less repository is a supported way to use this product and must not start failing
 * because a multi-repository feature exists.
 */
export async function capabilityBaseForRepository(root, { values = [], interactive = true } = {}) {
  /**
   * Scoped to this repository, not to whatever the machine last selected.
   *
   * `readActiveWorkspaceContext` answers "which workspace is selected on this machine", which is a
   * different question and the wrong one: a workspace selected elsewhere must not govern a
   * repository that is not part of it. `workspaceContextForRepository` returns a context only when
   * the selection actually names this root.
   */
  const context = await workspaceContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile()
  ).catch(() => null);
  if (!context) {
    if (values.length) {
      throw new SingularityFlowError(
        '--from-branch chooses one base branch for every repository in a capability, and this '
        + 'repository is not inside an active workspace. Use --base for a single repository.',
        { code: 'CAPABILITY_BRANCH_INVALID' }
      );
    }
    return null;
  }
  const capability = context.repositoryCapabilities?.[0] ?? null;
  if (!capability) {
    if (values.length) {
      throw new SingularityFlowError(
        `--from-branch needs a capability, and repository '${context.repositoryId}' declares none in `
        + `workspace '${context.workspaceName}'. Use --base for a single repository.`,
        { code: 'CAPABILITY_BRANCH_INVALID' }
      );
    }
    return null;
  }
  // Nothing asked for and no terminal to ask at: leave the single-repository path untouched rather
  // than reading every remote in the capability to answer a question nobody posed.
  if (!values.length && !interactive) return null;

  const workspace = await readWorkspace(context.workspacePath);
  const plan = await planCapabilityBase(workspace, capability, {}, { values, interactive });
  return {
    capability,
    workspaceRoot: workspace.path,
    plan,
    // The repository this command is running in takes its base from the same resolution as its
    // siblings; there is no second decision for it.
    localBase: plan.resolution.resolved[context.repositoryId]?.branch ?? null
  };
}

/** One line per repository, so the reader can see the whole capability moved together. */
export function printCapabilityBase(plan, prepared) {
  const { requested } = plan.resolution;
  console.log(`\nCapability base: ${requested ?? 'each repository’s default branch'}`);
  for (const entry of prepared) {
    const note = entry.action === 'absent'
      ? 'not cloned in this workspace — materialize it to include it'
      : `${entry.base}${entry.source === 'override' ? ' (override)' : ''}`;
    console.log(`  ${entry.repository.padEnd(22)} ${note}`);
  }
}
