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
import { createHash } from 'node:crypto';
// Synchronous: the git side of this module is sync throughout, and `exists` from util is a promise —
// `if (!exists(p))` would be false forever, so the 'absent' branch below could never fire.
import { existsSync } from 'node:fs';
import YAML from 'yaml';

import {
  baseBranchRecord, baseRefusalReport, branchChoices, capabilityRepositories,
  parseBaseSelection, parseRemoteHeads, resolveCapabilityBase
} from './capability-branches.mjs';
import {
  assertClean, branch as currentBranch, checkout, exactRemoteBranchObservation, publicationPushOutcome,
  pushCommitToBranch, gitCommonDir, refExists, refHead, repoRoot, validBranch
} from './git.mjs';
import { workspaceRepositoryPath } from './workspace.mjs';
import {
  activeWorkspaceFile, workspaceMemberContextForRepository, workspaceRegistryFile
} from './workspace-context.mjs';
import { resolveLifecycleCapability } from './capability-context.mjs';
import {
  resolveApprovedConfigurationCapability, resolveStoryConfigurationAuthority,
  resolveStoryConfigurationSnapshotCapability
} from './configuration-branch.mjs';
import { mapLimit, nowIso, run, SingularityFlowError } from './util.mjs';
import { runRemoteGit, runRemoteGitAsync } from './git-execution.mjs';
import { incrementCommandCounter } from './dx-command-timing.mjs';
import {
  configuredRemoteAuthority, configuredRemoteIdentity, frozenRemoteTransport, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { validatePortfolio } from './initiative-config.mjs';

const DEFAULT_REMOTE_WORKERS = 4;

function assertCheckoutRemoteIdentity(root, repository, remote, { publishRequired }) {
  const expected = String(repository.url ?? '').trim();
  let fetchIdentity;
  let pushIdentity;
  try {
    fetchIdentity = configuredRemoteIdentity(root, remote, { direction: 'fetch' });
    pushIdentity = publishRequired
      ? configuredRemoteIdentity(root, remote, { direction: 'push' })
      : null;
  } catch {
    // Unsafe remote values are never copied into the refusal. Treat them as identity drift and
    // retain only the reviewed, credential-free expected URL in structured diagnostics.
    fetchIdentity = null;
    pushIdentity = null;
  }
  const fetchMatches = fetchIdentity?.url === expected;
  const pushMatches = !publishRequired || pushIdentity?.url === expected;
  if (expected && fetchMatches && pushMatches) return { fetchIdentity, pushIdentity };
  throw new SingularityFlowError(
    `Required repository '${repository.id}' no longer matches its approved Git remote. `
    + 'Repair or recreate the workspace before starting work. Nothing was changed.',
    {
      code: 'CAPABILITY_WORKSPACE_BINDING_STALE',
      details: {
        repositoryId: repository.id,
        expectedRemote: sanitizeRemote(expected),
        actualFetchRemote: fetchIdentity?.url ? sanitizeRemote(fetchIdentity.url) : null,
        actualPushRemote: pushIdentity?.url ? sanitizeRemote(pushIdentity.url) : null
      }
    }
  );
}

function approvedDeliveryRepositoryIds(capability) {
  return [...new Set((capability?.deliveries ?? [])
    .flatMap((delivery) => delivery.repositories ?? (delivery.repository ? [delivery.repository] : [])))]
    .sort();
}

function portfolioFromConfigurationSnapshot(snapshot) {
  const entry = snapshot?.assets?.find(
    (candidate) => candidate.relative === 'singularity/portfolio.yml'
  );
  if (!entry) return null;
  const actualSha256 = createHash('sha256').update(entry.contents).digest('hex');
  if (!entry.sha256 || actualSha256 !== entry.sha256) {
    throw new SingularityFlowError(
      'Verified Story configuration snapshot changed in memory: singularity/portfolio.yml.',
      { code: 'STORY_CONFIGURATION_SNAPSHOT_INVALID' }
    );
  }
  try {
    return validatePortfolio(YAML.parse(Buffer.from(entry.contents).toString('utf8')));
  } catch (error) {
    throw new SingularityFlowError(
      `Approved capability repository catalog is invalid: ${error.message}`,
      { code: 'CAPABILITY_WORKSPACE_BINDING_STALE' }
    );
  }
}

/**
 * Bind a machine-local workspace plan to the exact approved delivery definition.
 *
 * Workspace paths are navigation state. They cannot add, omit, or redirect repositories which the
 * reviewed capability and portfolio say move together. This check runs before branch inventory or
 * fetch so a stale workspace cannot contact or mutate an unrelated repository.
 */
export function assertApprovedCapabilityRepositoryPlan(
  repositories, capability, configurationSnapshot = null
) {
  if (!capability) return null;
  const planned = [...new Set((repositories ?? []).map((repository) => repository.id))].sort();
  const expected = approvedDeliveryRepositoryIds(capability);
  if (JSON.stringify(planned) !== JSON.stringify(expected)) {
    throw new SingularityFlowError(
      `Workspace repositories for capability '${capability.id}' do not match its approved delivery set. `
      + `Expected: ${expected.join(', ') || 'none'}; workspace: ${planned.join(', ') || 'none'}. `
      + 'Refresh or recreate the workspace before starting work.',
      {
        code: 'CAPABILITY_WORKSPACE_BINDING_STALE',
        details: { capabilityId: capability.id, expectedRepositories: expected, plannedRepositories: planned }
      }
    );
  }

  const portfolio = portfolioFromConfigurationSnapshot(configurationSnapshot);
  // Older approved configurations used capabilities.yml as the only repository catalog and ship
  // the starter's intentionally empty portfolio. Their exact delivery IDs are still enforced.
  // Once an approved portfolio declares any repository, its remote/default/required identity is
  // authoritative and partial definitions are refused.
  if (!portfolio || !Object.keys(portfolio.repositories ?? {}).length) {
    return { expectedRepositories: expected, identityChecked: false };
  }
  for (const repository of repositories) {
    const approved = portfolio.repositories?.[repository.id];
    if (!approved) {
      throw new SingularityFlowError(
        `Approved portfolio does not define delivery repository '${repository.id}'.`,
        { code: 'CAPABILITY_WORKSPACE_BINDING_STALE' }
      );
    }
    const mismatches = [];
    if (String(repository.url ?? '').trim() !== String(approved.url ?? '').trim()) mismatches.push('remote');
    if (String(repository.defaultBranch ?? '').trim()
        !== String(approved.defaultBranch ?? '').trim()) mismatches.push('default branch');
    if ((repository.required !== false) !== (approved.required !== false)) mismatches.push('required flag');
    if (mismatches.length) {
      throw new SingularityFlowError(
        `Workspace repository '${repository.id}' differs from the approved portfolio (${mismatches.join(', ')}). `
        + 'Refresh or recreate the workspace before starting work.',
        {
          code: 'CAPABILITY_WORKSPACE_BINDING_STALE',
          details: { capabilityId: capability.id, repositoryId: repository.id, mismatches }
        }
      );
    }
  }
  return { expectedRepositories: expected, identityChecked: true };
}

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
    const transport = frozenRemoteTransport(repository.url);
    const result = runRemoteGit(['ls-remote', '--heads', '--', transport.remote], {
      operation: 'remote-probe', timeoutMs, env: transport.env
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

/** Bounded asynchronous inventory used by interactive/desktop planning across a capability. */
export async function publishedBranchesAsync(repositories, {
  timeoutMs = 20000, workers = DEFAULT_REMOTE_WORKERS, runGit = runRemoteGitAsync
} = {}) {
  const observations = await mapLimit(repositories, workers, async (repository) => {
    incrementCommandCounter('git.remote-inventory');
    const transport = frozenRemoteTransport(repository.url);
    const result = await runGit(['ls-remote', '--heads', '--', transport.remote], {
      operation: 'remote-probe', timeoutMs, env: transport.env
    });
    return { repository, result };
  });
  const published = {};
  const unreachable = [];
  for (const { repository, result } of observations) {
    if (result.status !== 0) {
      published[repository.id] = [];
      unreachable.push({
        repository: repository.id,
        url: repository.url,
        detail: (result.stderr || result.stdout || '').trim()
      });
    } else {
      published[repository.id] = parseRemoteHeads(result.stdout);
    }
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
  capabilityId = null,
  configurationSnapshot = null
} = {}) {
  const context = await workspaceMemberContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile(), { strict: true }
  );
  const capability = capabilityId ?? context?.repositoryCapabilities?.[0] ?? null;
  if (context && capability) {
    const workspace = context.workspace;
    if (!workspace) {
      throw new SingularityFlowError(
        'The workspace capability plan is not bound to a validated manifest snapshot.',
        { code: 'ACTIVE_WORKSPACE_UNAVAILABLE' }
      );
    }
    const repositories = capabilityRepositories(workspace, capability);
    // The exact approved overlay is already active for CLI/VS Code choice collection. When a
    // caller has retained the operation snapshot, use it directly; otherwise resolve through that
    // request-local overlay (or the Story pin) before touching any capability remote. Machine-local
    // workspace membership alone is never enough to decide which repositories move together.
    const approvedCapability = configurationSnapshot
      ? (await resolveStoryConfigurationSnapshotCapability(
          configurationSnapshot, capability
        )).capability
      : await resolveLifecycleCapability(root, {
          capabilityId: capability,
          required: true,
          offline: true
        });
    assertApprovedCapabilityRepositoryPlan(
      repositories, approvedCapability, configurationSnapshot
    );
    const { published, unreachable } = await publishedBranchesAsync(repositories);
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
  const { published, unreachable } = await publishedBranchesAsync([repository]);
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
  capabilityId = null,
  configurationSnapshot = null,
  catalog: suppliedCatalog = null
} = {}) {
  // `workspace branches --preflight-story` has already paid for an exact remote inventory so it can
  // render the choices alongside the result. Reusing those immutable bytes inside the same command
  // avoids asking every capability remote the identical question twice. Mutation-time Story start
  // still obtains its own fresh catalog and re-fetches every selected ref before changing a checkout.
  const catalog = suppliedCatalog ?? await storyBaseCatalog(root, {
    remote, defaultBranch, capabilityId, configurationSnapshot
  });
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
  const { published, unreachable } = await publishedBranchesAsync(repositories);
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
  capabilityId = plan?.record?.capability ?? null,
  configurationSnapshot = null,
  workers = DEFAULT_REMOTE_WORKERS,
  runGit = runRemoteGitAsync
} = {}) {
  // Workspace registration decides which repositories move together, but the governed capability
  // catalog decides whether that identifier exists at all. Resolve the same explicit identifier
  // createWorkflow will pin before fetching, checking out, or writing any repository. This prevents
  // a stale machine-local workspace from passing UI preflight and failing only after configuration
  // has been materialized onto a new Story branch.
  let approvedCapability = null;
  if (lifecycleRoot && capabilityId) {
    const configurationAuthority = configurationSnapshot
      ? configurationSnapshot.authority
      : await resolveStoryConfigurationAuthority(lifecycleRoot, remote);
    if (configurationSnapshot) {
      approvedCapability = (await resolveStoryConfigurationSnapshotCapability(
        configurationSnapshot, capabilityId
      )).capability;
    } else if (configurationAuthority) {
      approvedCapability = (await resolveApprovedConfigurationCapability(
        configurationAuthority, capabilityId
      )).capability;
    } else {
      approvedCapability = await resolveLifecycleCapability(lifecycleRoot, {
        capabilityId,
        required: true,
        // Existence is the preflight question. Lease refresh remains part of authoritative workflow
        // creation; an unrelated state-branch outage must not disguise an invalid capability id.
        offline: true
      });
    }
    assertApprovedCapabilityRepositoryPlan(
      plan.repositories, approvedCapability, configurationSnapshot
    );
  }
  // Validate every local precondition before the first network operation. Fetches may update only
  // remote-tracking refs; checkout/index/worktree mutations still wait for the complete capability
  // to pass this stage.
  const candidates = [];
  for (const repository of plan.repositories) {
    const target = workspaceRepositoryPath({ path: workspaceRoot }, repository);
    if (!existsSync(path.join(target, '.git'))) {
      throw new SingularityFlowError(
        `Required repository '${repository.id}' is not cloned at '${target}'. Nothing was changed.`,
        { code: 'STORY_REMOTE_UNREACHABLE' }
      );
    }
    const root = repoRoot(target);
    validBranch(root, storyBranch);
    // The lifecycle repository may be executing from its dedicated Story worktree while the
    // workspace's canonical checkout intentionally contains unrelated work. Both paths share the
    // same Git common directory, so only sibling repositories still need the legacy clean-checkout
    // precondition here.
    if (!lifecycleRoot || gitCommonDir(root) !== gitCommonDir(repoRoot(lifecycleRoot))) assertClean(root);
    // Bind every checkout to the approved plan before the first fetch, dry-run push, or Git-config
    // mutation. A stale workspace path may now contain an entirely different clone; the manifest
    // URL alone does not prove the checkout at that path still belongs to the capability.
    assertCheckoutRemoteIdentity(root, repository, remote, { publishRequired });
    const fetchAuthority = configuredRemoteAuthority(root, remote, { direction: 'fetch' });
    const pushAuthority = publishRequired
      ? configuredRemoteAuthority(root, remote, { direction: 'push' }) : null;
    if (!fetchAuthority.url || (publishRequired && !pushAuthority?.url)) {
      throw new SingularityFlowError(
        `Required repository '${repository.id}' has no usable '${remote}' transport. Nothing was changed.`,
        { code: 'STORY_REMOTE_UNREACHABLE' }
      );
    }
    candidates.push({ repository, root, fetchAuthority, pushAuthority });
  }
  // All repository identities are now proven as one set. Expanding the fetch refspec is a local
  // mutation, so defer it until a later sibling cannot fail identity validation and leave earlier
  // checkouts partially changed.
  for (const candidate of candidates) {
    run('git', ['remote', 'set-branches', remote, '*'], {
      cwd: candidate.root, allowFailure: false
    });
  }
  const fetched = await mapLimit(candidates, workers, async (candidate) => {
    incrementCommandCounter('git.remote-fetch');
    const transport = frozenRemoteTransport(candidate.fetchAuthority.url);
    return {
      ...candidate,
      // Bind the fetch to the exact URL captured above. The explicit destination refspec retains
      // the normal remote-tracking layout without letting a concurrent `remote set-url` redirect it.
      result: await runGit([
        'fetch', '--prune', transport.remote,
        `+refs/heads/*:refs/remotes/${remote}/*`
      ], {
        cwd: candidate.root, operation: 'remote-configuration', allowFailure: true,
        env: transport.env
      })
    };
  });
  const failedFetch = fetched.find((entry) => entry.result.status !== 0);
  if (failedFetch) {
    throw new SingularityFlowError(
      `Cannot refresh required repository '${failedFetch.repository.id}' from '${remote}'. `
      + `${failedFetch.result.failure?.advice ?? (failedFetch.result.stderr || failedFetch.result.stdout || 'Git fetch failed').trim()} Nothing was changed.`,
      { code: failedFetch.result.failure?.code ?? 'STORY_REMOTE_UNREACHABLE' }
    );
  }

  const candidatesToProbe = [];
  for (const { repository, root, pushAuthority } of fetched) {
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
    candidatesToProbe.push({
      repository: repository.id,
      root,
      remote,
      baseBranch: base.branch,
      baseCommit: refHead(root, sourceRef),
      sourceRef,
      destinationRef: `refs/heads/${storyBranch}`,
      branch: storyBranch,
      remoteFingerprint: pushAuthority?.fingerprint ?? null,
      transportRemote: pushAuthority?.url ?? null,
      publicationAuthority: pushAuthority,
      publishRequired
    });
  }
  // A dry-run push cannot move a remote ref. Probe independent repositories with the same bounded
  // fan-out as fetch, while retaining input-order results so the first refusal remains deterministic.
  const checked = await mapLimit(candidatesToProbe, workers, async (candidate) => {
    if (!candidate.publishRequired) return { candidate, dryRun: null };
    const transport = frozenRemoteTransport(candidate.transportRemote, { push: true });
    const dryRun = await runGit([
      'push', '--dry-run', '--porcelain', transport.remote,
      `${candidate.sourceRef}:${candidate.destinationRef}`
    ], {
      cwd: candidate.root, operation: 'remote-push', allowFailure: true,
      env: transport.env
    });
    return { candidate, dryRun };
  });
  const refused = checked.find((entry) => entry.dryRun && entry.dryRun.status !== 0);
  if (refused) {
    const { candidate, dryRun } = refused;
    throw new SingularityFlowError(
      `Cannot publish Story branch '${storyBranch}' for required repository '${candidate.repository}' `
      + `to '${remote}'. Git reported: `
      + `${(dryRun.stderr || dryRun.stdout || 'remote rejected the dry-run push').trim()} Nothing was changed.`,
      { code: 'STORY_PUBLICATION_PREFLIGHT_FAILED' }
    );
  }
  return checked.map((entry) => entry.candidate);
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
        destinationRef: entry.destinationRef,
        remoteFingerprint: entry.remoteFingerprint,
        expectedRemoteSha: null,
        pushOutcome: 'not-attempted'
      }));
}

export function preflightIncludesRepository(preflight, repositoryRoot) {
  if (!preflight?.length) return false;
  const common = gitCommonDir(repoRoot(repositoryRoot));
  return preflight.some((entry) => gitCommonDir(repoRoot(entry.root)) === common);
}

/** The exact frozen push authority captured for one repository during Story preflight. */
export function preflightPublicationAuthority(preflight, repositoryRoot) {
  if (!preflight?.length) return null;
  const common = gitCommonDir(repoRoot(repositoryRoot));
  return preflight.find((entry) => gitCommonDir(repoRoot(entry.root)) === common)
    ?.publicationAuthority ?? null;
}

/** Publish exact preflight-bound sibling commits, returning a resumable remainder on failure. */
export function publishCapabilityRepositories(entries = []) {
  const published = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const authority = configuredRemoteAuthority(entry.root, entry.remote);
    if (!entry.remoteFingerprint || !authority.url
        || authority.fingerprint !== entry.remoteFingerprint) {
      return {
        published,
        pending: [
          { ...entry, pushOutcome: 'rejected' },
          ...entries.slice(index + 1).map((pending) => ({
            ...pending, pushOutcome: pending.pushOutcome ?? 'not-attempted'
          }))
        ],
        error: `Configured remote '${entry.remote}' for '${entry.repository}' changed after Story preflight`
      };
    }
    const priorOutcome = entry.pushOutcome ?? 'not-attempted';
    if (priorOutcome === 'transport-indeterminate') {
      const observed = exactRemoteBranchObservation(
        entry.root, authority.url, entry.branch
      );
      if (!observed.reachable || observed.malformed) {
        return {
          published,
          pending: [entry, ...entries.slice(index + 1)],
          error: !observed.reachable
            ? `Cannot verify the prior indeterminate publication for '${entry.repository}' because its remote is unavailable`
            : `Cannot verify the prior indeterminate publication for '${entry.repository}' because its remote advertisement is ambiguous`
        };
      }
      if (observed.sha === entry.commit) {
        published.push({
          repository: entry.repository,
          remote: entry.remote,
          branch: entry.branch,
          ref: entry.destinationRef,
          commit: entry.commit,
          pushed: true,
          reconciled: true
        });
        continue;
      }
      if (observed.sha !== null) {
        return {
          published,
          pending: [
            { ...entry, pushOutcome: 'rejected' },
            ...entries.slice(index + 1).map((pending) => ({
              ...pending, pushOutcome: pending.pushOutcome ?? 'not-attempted'
            }))
          ],
          error: `Remote Story branch '${entry.branch}' for '${entry.repository}' contains a different commit`
        };
      }
    }
    // Story publication is create-only. Bind the final push to an absent destination so a branch
    // created after dry-run can never be mistaken for this operation's publication, even when its
    // commit happens to be an ancestor (or the same commit).
    const result = pushCommitToBranch(entry.root, entry.remote, entry.commit, entry.branch, {
      expectedRemoteSha: entry.expectedRemoteSha ?? null,
      transportRemote: authority.url,
      upstreamRemote: authority.remote
    });
    if (result.status !== 0) {
      const currentOutcome = publicationPushOutcome(result);
      // A returned definitive rejection supersedes an older ambiguous attempt. Equality was already
      // checked above while that ambiguity was authoritative; retaining it after a known collision
      // would let a later sync claim another actor's identical ref.
      const pushOutcome = currentOutcome === 'transport-indeterminate'
        ? 'transport-indeterminate'
        : 'rejected';
      return {
        published,
        pending: [
          { ...entry, pushOutcome },
          ...entries.slice(index + 1).map((pending) => ({
            ...pending, pushOutcome: pending.pushOutcome ?? 'not-attempted'
          }))
        ],
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
  remote = 'origin', lifecycleRoot = null, fetched = false
} = {}) {
  const prepared = [];
  try {
    for (const repository of plan.repositories) {
      const target = workspaceRepositoryPath({ path: workspaceRoot }, repository);
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
        base: base.branch, fetch: !fetched, remote, preferRemoteBase: true
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
   * repository that is not part of it. `workspaceMemberContextForRepository` proves membership by
   * canonical path or Git common-directory identity without requiring this member to be selected.
   */
  const context = await workspaceMemberContextForRepository(
    root, activeWorkspaceFile(), workspaceRegistryFile(), { strict: true }
  );
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

  const workspace = context.workspace;
  if (!workspace) {
    throw new SingularityFlowError(
      'The workspace capability plan is not bound to a validated manifest snapshot.',
      { code: 'ACTIVE_WORKSPACE_UNAVAILABLE' }
    );
  }
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
