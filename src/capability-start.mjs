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
import { assertClean, branch as currentBranch, checkout, repoRoot } from './git.mjs';
import { readWorkspace } from './workspace.mjs';
import { activeWorkspaceFile, workspaceContextForRepository, workspaceRegistryFile } from './workspace-context.mjs';
import { nowIso, run, SingularityFlowError } from './util.mjs';

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
    const result = run('git', ['ls-remote', '--heads', '--', repository.url], {
      allowFailure: true, timeoutMs
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
 * Offer the branches and take a choice.
 *
 * Only called when there is a terminal and no `--from-branch`. The default is the first entry, which
 * is the most widely published branch — pressing return does the unsurprising thing.
 */
export async function askForBaseBranch(choices, { capability, repositoryCount } = {}) {
  if (!input.isTTY || !output.isTTY) return null;
  if (!choices.length) return null;
  const io = readline.createInterface({ input, output });
  try {
    console.log(`\nBase branch for the ${repositoryCount} repositories in capability '${capability}':`);
    choices.forEach((choice, index) => {
      const scope = choice.everywhere ? `all ${choice.total}` : `${choice.present} of ${choice.total}`;
      console.log(`  ${index + 1}  ${choice.branch.padEnd(24)} (${scope})`);
    });
    const answer = (await io.question(`Select [1]: `)).trim();
    if (!answer) return choices[0].branch;
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
export function prepareCapabilityRepositories(workspaceRoot, plan, storyBranch, { remote = 'origin' } = {}) {
  const prepared = [];
  for (const repository of plan.repositories) {
    const target = path.resolve(workspaceRoot, repository.path);
    const base = plan.resolution.resolved[repository.id];
    if (!existsSync(path.join(target, '.git'))) {
      prepared.push({ repository: repository.id, target, base: base.branch, action: 'absent' });
      continue;
    }
    const root = repoRoot(target);
    assertClean(root);
    const already = currentBranch(root);
    checkout(root, storyBranch, { base: base.branch, fetch: true, remote, preferRemoteBase: true });
    prepared.push({
      repository: repository.id,
      target: root,
      base: base.branch,
      source: base.source,
      action: already === storyBranch ? 'already-on-branch' : 'switched',
      from: already
    });
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
