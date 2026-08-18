/**
 * Mapping a git repository to a capability, without asking anybody where to put a checkout.
 *
 * The capability map lives in the lead repository — that has not changed, and should not: it is
 * governed configuration and belongs in Git beside everything else it governs. What was wrong was
 * making a person clone that repository, choose a folder for it, and keep it, purely so the map
 * could be edited. Cloning is a workspace's job, and a workspace is created for doing work, not for
 * describing what exists.
 *
 * So this clones the approved `sflow/config` branch into a temporary directory, edits, pushes a
 * review branch, and discards. The lead repository is the durable record; the checkout was never
 * the point. Application branches are never written by this path: ordinary review controls still
 * decide which proposal becomes the next approved configuration revision.
 *
 * The one thing kept on the machine is a pointer: which repositories hold a map. Reading a map
 * requires knowing where it is, and asking for the same URL on every screen is a worse answer than
 * remembering the handful a person works with.
 */
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import { SingularityFlowError, run, readJson, YAML_OUTPUT } from './util.mjs';
import {
  CAPABILITIES_PATH, editCapability, validateCapabilities, capabilityTree
} from './capabilities.mjs';
import { atomicJson, remoteDefaultBranch } from './workspace.mjs';
import { defaultBranchName, head, identity } from './git.mjs';
import { GOVERNED_ROOTS, WORKFLOW_PATH, initializeDefinition, loadDefinition } from './config.mjs';
import {
  describeRepository, enableLedger, repositoryIdFromUrl, setDefaultBaseBranch
} from './bootstrap.mjs';
import {
  appendLedgerIntent, createLedgerIntent, initializeLedger, publishToStateBranch
} from './ledger.mjs';
import {
  CONFIGURATION_BRANCH, configurationBranchHead, ensureConfigurationBranch, isConfigurationAsset,
  remoteHasConfigurationBranch
} from './configuration-branch.mjs';
import { normalizeCloneStrategy } from './clone-strategy.mjs';

const PORTFOLIO_PATH = 'singularity/portfolio.yml';
const CAPABILITY_PROPOSAL_PREFIX = 'sflow/config-change/capability/';

function capabilityProposalBranch(value) {
  const branch = String(value ?? '').trim();
  if (!branch.startsWith(CAPABILITY_PROPOSAL_PREFIX)
    || !/^sflow\/config-change\/capability\/[a-z0-9._/-]+$/.test(branch)
    || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) {
    throw new SingularityFlowError(
      `Capability proposal must be a branch beneath '${CAPABILITY_PROPOSAL_PREFIX}'.`);
  }
  return branch;
}

function proposalChangedFiles(root, base, proposal) {
  const names = run('git', ['diff', '--name-only', `${base}..${proposal}`], { cwd: root })
    .stdout.split('\n').map((entry) => entry.trim()).filter(Boolean);
  const statuses = run('git', ['diff', '--name-status', `${base}..${proposal}`], { cwd: root })
    .stdout.split('\n').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [status, ...paths] = entry.split('\t');
      return { status, paths };
    });
  return { names, statuses };
}

/**
 * Portable protection probe: ask the server whether this exact proposal could update the authority
 * ref, but use Git's dry-run transport so no ref moves. A rejection proves enforcement in the
 * current actor's path. Acceptance means the remote would permit a direct update and therefore
 * requires an explicit acknowledgement before Singularity Flow performs its normal merge push.
 */
function configurationProtectionProbe(root, proposalRef) {
  const result = run('git', [
    'push', '--dry-run', '--porcelain', 'origin',
    `${proposalRef}:refs/heads/${CONFIGURATION_BRANCH}`
  ], { cwd: root, allowFailure: true });
  return {
    enforced: result.status !== 0,
    detail: (result.stderr || result.stdout || '').trim()
  };
}

function commitIdentity(root, ref) {
  const shown = run('git', ['show', '-s', '--format=%an%x00%ae', ref], { cwd: root }).stdout.trim();
  const [name = '', email = ''] = shown.split('\0');
  return { name: name || null, email: email || null };
}

async function withCapabilityProposalCheckout(url, branch, operation) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.');
  if (!remoteHasConfigurationBranch(remote)) {
    throw new SingularityFlowError(`'${remote}' has no '${CONFIGURATION_BRANCH}' branch.`);
  }
  const proposalBranch = capabilityProposalBranch(branch);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-review-'));
  try {
    // `--branch` alone still negotiates every remote branch. On a monorepo that made a capability
    // approval transfer application history it never reads. The authority branch is orphaned, so
    // this branch plus the exact proposal ref fetched below is the complete review input.
    const cloned = run('git', [
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--filter=blob:none',
      '--branch', CONFIGURATION_BRANCH, remote, scratch
    ], { allowFailure: true });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${remote}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`);
    }
    const fetched = run('git', ['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin',
      `refs/heads/${proposalBranch}:refs/remotes/origin/${proposalBranch}`], {
      cwd: scratch, allowFailure: true
    });
    if (fetched.status !== 0) {
      throw new SingularityFlowError(
        `Capability proposal '${proposalBranch}' does not exist on '${remote}'.`);
    }
    return await operation(scratch, remote, proposalBranch,
      `refs/remotes/origin/${proposalBranch}`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Where the pointers live. Overridable so tests never touch a real machine's list. */
export function leadRegistryFile() {
  return process.env.SINGULARITY_FLOW_LEAD_REGISTRY
    ?? path.join(os.homedir(), '.singularity-flow', 'leads.json');
}

/** The lead repositories this machine knows about, most recently used first. */
export async function listLeadRepositories(file = leadRegistryFile()) {
  const stored = await readJson(file).catch(() => null);
  return Array.isArray(stored?.leads) ? stored.leads : [];
}

export async function rememberLeadRepository(url, file = leadRegistryFile()) {
  const remote = String(url ?? '').trim();
  if (!remote) return listLeadRepositories(file);
  const existing = await listLeadRepositories(file);
  const leads = [
    { url: remote, usedAt: new Date().toISOString() },
    ...existing.filter((lead) => lead.url !== remote)
  ].slice(0, 20);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicJson(file, { schemaVersion: 1, leads });
  return leads;
}

export async function forgetLeadRepository(url, file = leadRegistryFile()) {
  const leads = (await listLeadRepositories(file)).filter((lead) => lead.url !== url);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicJson(file, { schemaVersion: 1, leads });
  return leads;
}

/** One private cache file per lead URL; overridable so tests never touch a developer's cache. */
export function organisationCacheFile(url) {
  const directory = process.env.SINGULARITY_FLOW_ORGANISATION_CACHE
    ?? (process.env.SINGULARITY_FLOW_LEAD_REGISTRY
      ? path.join(path.dirname(process.env.SINGULARITY_FLOW_LEAD_REGISTRY), 'organisation-cache')
      : null)
    ?? path.join(os.homedir(), '.singularity-flow', 'organisation-cache');
  const key = createHash('sha256').update(String(url ?? '').trim()).digest('hex');
  return path.join(directory, `${key}.json`);
}

function cacheAgeMs(cached, at = Date.now()) {
  const written = Date.parse(cached?.cachedAt ?? '');
  return Number.isFinite(written) ? Math.max(0, at - written) : null;
}

async function readOrganisationCache(remote) {
  const cached = await readJson(organisationCacheFile(remote)).catch(() => null);
  if (cached?.schemaVersion !== 1 || cached.url !== remote || !cached.organisation) return null;
  return cached;
}

async function writeOrganisationCache(remote, tipSha, organisation) {
  const file = organisationCacheFile(remote);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicJson(file, {
    schemaVersion: 1,
    url: remote,
    tipSha,
    cachedAt: new Date().toISOString(),
    organisation
  });
}

/**
 * Borrow a lead repository for the length of one edit.
 *
 * A shallow clone of one branch, into a temporary directory that is removed however this ends. The
 * caller mutates the checkout and says what the commit is for; pushing and cleaning up happen here
 * so that no caller can forget either.
 */
async function withLeadCheckout(url, message, reviewBranchPrefix, mutate) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.');

  await ensureConfigurationBranch(remote);
  const baseBranch = CONFIGURATION_BRANCH;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-lead-'));
  try {
    const cloned = run('git', [
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--filter=blob:none', '--branch', baseBranch, remote, scratch
    ], { allowFailure: true });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${remote}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`);
    }

    const baseCommit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();
    const result = await mutate(scratch, baseBranch);

    const staged = run('git', ['add', '-A'], { cwd: scratch, allowFailure: true });
    if (staged.status !== 0) throw new SingularityFlowError('Could not stage the change.');
    if (!run('git', ['diff', '--cached', '--name-only'], { cwd: scratch }).stdout.trim()) {
      return {
        ...result, changed: false, pushed: false, commit: null,
        branch: null, baseBranch, baseCommit, reviewRequired: false
      };
    }

    // The base revision makes the proposal stable and conflict-visible. A retry against the same
    // base cannot overwrite the first proposal, while a later edit after merge naturally gets a
    // new branch name. The prefix is supplied by the operation and contains only a capability ID.
    const safePrefix = String(reviewBranchPrefix ?? 'capability-change')
      .toLowerCase().replace(/[^a-z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '');
    const reviewBranch = `sflow/config-change/${safePrefix}-${baseCommit.slice(0, 8)}`;
    const exists = run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${reviewBranch}`], {
      cwd: scratch, allowFailure: true
    }).stdout.trim();
    if (exists) {
      throw new SingularityFlowError(
        `Review branch '${reviewBranch}' already exists on '${remote}'. Review or remove that proposal before retrying.`);
    }
    run('git', ['switch', '--quiet', '-c', reviewBranch], { cwd: scratch });

    const actor = identity(scratch);
    run('git', ['-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', message], { cwd: scratch });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();

    // Pushed here rather than left for later: the temporary checkout is about to be deleted, so a
    // commit that is not pushed is a commit that never existed. This deliberately targets only a
    // new review branch. The approved configuration and orphan state branches remain unchanged.
    const pushed = run('git', ['push', '--set-upstream', 'origin',
      `HEAD:refs/heads/${reviewBranch}`], { cwd: scratch, allowFailure: true });
    if (pushed.status !== 0) {
      throw new SingularityFlowError(
        `The change could not be pushed to '${remote}': ${(pushed.stderr || pushed.stdout).trim().split('\n')[0]}`);
    }
    return {
      ...result, changed: true, pushed: true, commit,
      branch: reviewBranch, baseBranch, baseCommit, reviewRequired: true
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The lead repository's *application* default branch — which is never the branch this edit is on.
 *
 * `withLeadCheckout` borrows the repository on the configuration authority branch, so the base
 * branch it reports back is always `sflow/config`. Recording that as the repository's default
 * branch is not a cosmetic error: `defaultBranch` is what workspace creation clones, what Story
 * branches are cut from, and what drift observation compares `origin/<branch>` against, so every
 * one of them would have been pointed at the configuration branch.
 *
 * The declared value is preferred over asking the remote again, because it was computed when the
 * configuration authority was established — from a repository that had no `sflow/*` branches yet.
 * Re-deriving it now would mean asking `remoteDefaultBranch` to choose among heads this product has
 * since added to the repository itself. A declared value that is already the configuration branch
 * is the symptom rather than a preference, so it is not preserved — see `repairLeadDefaultBranch`,
 * which is what actually reaches a repository already affected.
 */
async function leadApplicationBranch(root, url) {
  const file = path.join(root, PORTFOLIO_PATH);
  if (existsSync(file)) {
    const declared = YAML.parse(await readFile(file, 'utf8'))
      ?.repositories?.[repositoryIdFromUrl(url)]?.defaultBranch;
    const branch = typeof declared === 'string' ? declared.trim() : '';
    if (branch && branch !== CONFIGURATION_BRANCH) return branch;
  }
  return remoteDefaultBranch(
    url, run('git', ['ls-remote', '--symref', url, 'HEAD'], { allowFailure: true }).stdout);
}

/**
 * Put back a lead `defaultBranch` that an affected version replaced with the configuration branch.
 *
 * Separate from `leadApplicationBranch`, and running on every map rather than only the first,
 * because the two reach different repositories. `describeRepository` is called once — when the
 * first capability governs the repository — so correcting its argument fixes repositories mapped
 * from now on and cannot reach one that was already mapped. Those keep the wrong value forever
 * otherwise, and the symptom appears far away: a Story cut from `sflow/config`.
 *
 * Writes only when the declared value is the configuration branch, so a healthy portfolio is
 * untouched and no proposal carries a line nobody asked for.
 */
async function repairLeadDefaultBranch(root, url) {
  const file = path.join(root, PORTFOLIO_PATH);
  if (!existsSync(file)) return;
  const id = repositoryIdFromUrl(url);
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  if (String(document.getIn(['repositories', id, 'defaultBranch']) ?? '') !== CONFIGURATION_BRANCH) return;
  document.setIn(['repositories', id, 'defaultBranch'], remoteDefaultBranch(
    url, run('git', ['ls-remote', '--symref', url, 'HEAD'], { allowFailure: true }).stdout));
  await writeFile(file, document.toString(YAML_OUTPUT), 'utf8');
}

/** Read the state-branch capability mirror without moving any checkout. A missing mirror is normal. */
async function capabilityMapFromState(remote, branch = 'state') {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-read-state-'));
  try {
    run('git', ['init', '--quiet', '--bare', scratch]);
    const fetched = run('git', [
      '--git-dir', scratch, 'fetch', '--quiet', '--depth', '1', remote,
      `refs/heads/${branch}:refs/heads/read-state`
    ], { allowFailure: true });
    if (fetched.status !== 0) return null;
    const shown = run('git', [
      '--git-dir', scratch, 'show', `refs/heads/read-state:${CAPABILITIES_PATH}`
    ], { allowFailure: true });
    if (shown.status !== 0) return null;
    return {
      text: shown.stdout,
      commit: run('git', ['--git-dir', scratch, 'rev-parse', 'refs/heads/read-state']).stdout.trim(),
      branch
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The capability map a lead repository holds, read without keeping a checkout.
 *
 * One `ls-remote` validates the cache against the exact configuration tip. A current cache avoids
 * every clone/fetch. On a miss, the map prefers the orphan state projection and the configuration
 * clone supplies the authoritative portfolio (and the map fallback when no projection exists).
 * When the remote is unreachable, only a previously validated cache is served, clearly marked
 * stale with its age and the remote failure.
 */
export async function readOrganisation(url, { refresh = false } = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.');
  const branch = CONFIGURATION_BRANCH;
  const cached = await readOrganisationCache(remote);
  const tip = configurationBranchHead(remote);
  if (!tip.reachable) {
    if (cached) {
      return {
        ...cached.organisation,
        cached: true,
        stale: true,
        cacheAgeMs: cacheAgeMs(cached),
        remoteError: tip.error || 'remote is unreachable'
      };
    }
    throw new SingularityFlowError(
      `Cannot read '${remote}': ${tip.error || 'the remote is unreachable and no cached organisation is available.'}`
    );
  }
  if (!tip.exists) {
    const empty = {
      url: remote, branch, sourceBranch: null, sourceCommit: null,
      capabilities: [], repositories: {}, governed: false
    };
    await writeOrganisationCache(remote, null, empty);
    return { ...empty, cached: false, stale: false, cacheAgeMs: 0, remoteError: null };
  }
  if (!refresh && cached?.tipSha === tip.sha) {
    return {
      ...cached.organisation,
      cached: true,
      stale: false,
      cacheAgeMs: cacheAgeMs(cached),
      remoteError: null
    };
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-read-'));
  try {
    const cloned = run('git', [
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--filter=blob:none', '--no-checkout', '--branch', branch, remote, scratch
    ], { allowFailure: true });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${remote}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`);
    }
    const configured = run('git', ['show', `HEAD:${CAPABILITIES_PATH}`], { cwd: scratch, allowFailure: true });
    const workflow = run('git', ['show', `HEAD:${WORKFLOW_PATH}`], { cwd: scratch, allowFailure: true });
    const stateBranch = workflow.status === 0
      ? (YAML.parse(workflow.stdout)?.ledger?.branch ?? 'state')
      : 'state';
    const state = configured.status === 0 ? await capabilityMapFromState(remote, stateBranch) : null;
    // The state branch is a mirror, never a second authority. An interrupted projection may leave
    // it behind `sflow/config`; in that case read the approved bytes rather than presenting stale
    // mirror contents as fresh merely because the remote itself is reachable.
    const currentState = state?.text === configured.stdout ? state : null;
    const shown = currentState ?? (configured.status === 0
      ? { text: configured.stdout, commit: tip.sha, branch }
      : null);
    if (!shown) {
      const empty = {
        url: remote, branch, sourceBranch: null, sourceCommit: tip.sha,
        capabilities: [], repositories: {}, governed: false
      };
      await writeOrganisationCache(remote, tip.sha, empty);
      return { ...empty, cached: false, stale: false, cacheAgeMs: 0, remoteError: null };
    }

    const definition = validateCapabilities(YAML.parse(shown.text));
    const portfolio = run('git', ['show', `HEAD:${PORTFOLIO_PATH}`], { cwd: scratch, allowFailure: true });
    const organisation = {
      url: remote,
      branch,
      sourceBranch: shown.branch,
      sourceCommit: shown.commit,
      capabilities: capabilityTree(definition),
      repositories: portfolio.status === 0 ? (YAML.parse(portfolio.stdout)?.repositories ?? {}) : {},
      governed: true
    };
    await writeOrganisationCache(remote, tip.sha, organisation);
    return {
      ...organisation,
      cached: false,
      stale: false,
      cacheAgeMs: 0,
      remoteError: null
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Map a git repository to a capability, in the lead repository's map.
 *
 * `kind` states the structural responsibility: a collection groups related capabilities, while a
 * delivery capability ships from one or more repositories. A delivery may still contain children.
 * Repositories are declared in the portfolio at the same time — a capability pointing at a
 * repository nobody configured looks fine until something tries to clone it.
 *
 * @param leadUrl the repository holding the map. When it holds none yet, this call establishes it.
 */
export async function mapCapability(leadUrl, {
  capabilityId,
  name = null,
  kind = null,
  type = null,
  parent = null,
  repositoryUrl = null,
  repositoryUrls = [],
  leadRepositoryUrl = null,
  metadata = {},
  documentation = {},
  resources = {},
  sourceRoots = [],
  sharedRoots = [],
  clone = { mode: 'full', sparseCone: [], fallback: 'refuse' },
  jiraProject = null,
  teams = []
} = {}) {
  if (!capabilityId) throw new SingularityFlowError('A capability identifier is required.');
  const cloneStrategy = normalizeCloneStrategy(clone, `Capability '${capabilityId}' clone strategy`);

  return withLeadCheckout(leadUrl, `Map capability ${capabilityId}`,
    `capability/map-${capabilityId}`, async (root) => {
    // The first capability governs the repository it is mapped into.
    //
    // Requiring a governed lead before the first capability could be mapped was the product's one
    // circular dependency: to map a capability you needed a map, and the only way to get a map was
    // to map a capability. Governing here costs one extra write on exactly one operation — the
    // first — and every later map finds the file already there.
    assertGovernanceVisible(root);
    const governed = existsSync(path.join(root, CAPABILITIES_PATH));
    if (!governed) {
      await initializeDefinition(root);
      await describeRepository(
        root, repositoryIdFromUrl(leadUrl), leadUrl,
        await leadApplicationBranch(root, leadUrl), identity(root));
      // The orphan branch is named in the definition here. It is not published until this proposal
      // is reviewed and merged; unreviewed configuration must never become an authoritative mirror.
      await enableLedger(root, 'state');
    }
    await repairLeadDefaultBranch(root, leadUrl);

    // Every repository this capability ships from, declared in the portfolio so the capability may
    // name them. A capability commonly has one; a product with a web app and a service has two.
    const urls = [...new Set([...(repositoryUrl ? [repositoryUrl] : []), ...repositoryUrls])];
    const effectiveKind = kind ?? (urls.length ? 'delivery' : 'collection');
    const repositoryIds = [];
    if (urls.length) {
      const file = path.join(root, PORTFOLIO_PATH);
      const portfolio = YAML.parseDocument(await readFile(file, 'utf8'));
      for (const url of urls) {
        const id = repositoryIdOf(url);
        repositoryIds.push(id);
        const branch = remoteDefaultBranch(
          url, run('git', ['ls-remote', '--symref', url, 'HEAD'], { allowFailure: true }).stdout);
        portfolio.setIn(['repositories', id], portfolio.createNode({
          url, defaultBranch: branch, required: true,
          ...(cloneStrategy.mode !== 'full' ? { clone: cloneStrategy } : {})
        }));
      }
      await writeFile(file, portfolio.toString(YAML_OUTPUT), 'utf8');
    }
    const repositoryId = repositoryIds[0] ?? null;
    // The lead is where this capability's governed state and world model live, so with more than
    // one repository it has to be said rather than inferred from the order they were typed in.
    const leadRepositoryId = leadRepositoryUrl ? repositoryIdOf(leadRepositoryUrl)
      : repositoryIds.length === 1 ? repositoryIds[0] : null;
    if (leadRepositoryId && !repositoryIds.includes(leadRepositoryId)) {
      throw new SingularityFlowError(
        `The lead repository must be one of this capability's repositories; '${leadRepositoryId}' is not among ${repositoryIds.join(', ') || 'any'}.`);
    }

    const file = path.join(root, CAPABILITIES_PATH);
    const document = YAML.parseDocument(await readFile(file, 'utf8'));
    const before = document.toJS() ?? {};
    if (before.capabilities?.[capabilityId]) {
      throw new SingularityFlowError(`Capability '${capabilityId}' already exists in this map.`);
    }
    if (!governed) document.setIn(['capabilities'], document.createNode({}));
    document.setIn(['capabilities', capabilityId], document.createNode({}));
    const set = (key, value) => document.setIn(['capabilities', capabilityId, ...key.split('.')], value);
    set('name', name ?? capabilityId);
    set('kind', effectiveKind);
    if (type) set('type', type);
    set('parent', parent || null);
    // One repository is written as the shorthand every existing map already uses; several are
    // written as the list, with the lead named.
    if (repositoryIds.length === 1) set('repository', repositoryIds[0]);
    else if (repositoryIds.length > 1) {
      set('repositories', repositoryIds);
      if (leadRepositoryId) set('leadRepository', leadRepositoryId);
    }
    if (Object.keys(metadata).length) set('metadata', metadata);
    if (Object.keys(documentation).length) set('documentation', documentation);
    if (Object.keys(resources).length) set('resources', resources);
    if (sourceRoots.length) set('sourceRoots', sourceRoots);
    if (sharedRoots.length) set('sharedRoots', sharedRoots);
    if (jiraProject) set('jira.projectKey', jiraProject);
    if (teams.length) set('teams', teams);

    // Validated against the portfolio in the same checkout, so a repository the map names is one
    // the portfolio declares — refused here rather than at clone time.
    const portfolio = existsSync(path.join(root, PORTFOLIO_PATH))
      ? YAML.parse(await readFile(path.join(root, PORTFOLIO_PATH), 'utf8'))
      : null;
    validateCapabilities(document.toJS(), portfolio);
    await writeFile(file, document.toString(YAML_OUTPUT), 'utf8');
    return {
      capabilityId, repositoryId, repositoryIds, leadRepositoryId, type: type ?? null,
      parent: parent || null,
      state: { published: false, reason: 'awaiting review and merge' }
    };
  });
}

/**
 * Put the capability map on the orphan state branch as well as the branch it was edited on.
 *
 * Two copies, deliberately. The branch copy is the one a person edits and reviews, and it is the
 * one a force-push or a rebase can rewrite. The state-branch copy has no shared ancestry with any
 * code branch, so it survives the history being rewritten underneath it — and it is readable from
 * the remote without a checkout, which is what the readiness probe and every organisation-level
 * read already do.
 *
 * Best effort on purpose. The map has already been written and pushed by the time this runs; a
 * repository with no state branch, or an unreachable remote, is a reason to say so and not a reason
 * to fail an edit that has already happened. The caller reports what came back.
 */
export async function publishCapabilityMap(root, { message = 'Publish the capability map' } = {}) {
  const file = path.join(root, CAPABILITIES_PATH);
  if (!existsSync(file)) return { published: false, reason: 'there is no capability map to publish' };
  const definition = await loadDefinition(root).catch(() => null);
  const ledger = definition?.ledger ?? null;
  // `enabled: false` is a decision this repository made, not a fault: it says the state branch is
  // not in use here, and publishing to a branch nobody reads would be noise.
  if (!ledger?.enabled) return { published: false, reason: 'the state branch is not enabled here' };
  if (ledger.publication === 'off') return { published: false, reason: 'state publication is disabled' };
  try {
    const result = await publishToStateBranch(
      root, ledger, { [CAPABILITIES_PATH]: await readFile(file, 'utf8') }, message);
    // Unchanged is not a failure and must not be reported as one: an edit that touched a field the
    // branch already agreed with is the ordinary case, not a problem to explain.
    if (!result.changed) return { published: false, branch: result.branch, reason: 'it is already current there' };
    return { published: true, branch: result.branch, commit: result.commit };
  } catch (error) {
    if (ledger.publication === 'required') throw error;
    return { published: false, reason: error.message };
  }
}

/**
 * Refresh the orphan capability projection from the reviewed configuration branch of a remote lead.
 *
 * This is intentionally separate from map/edit. Those operations only propose a review branch;
 * publishing before merge would make unreviewed configuration visible as governed state.
 */
export async function publishOrganisationCapabilityMap(url) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.');
  const baseBranch = CONFIGURATION_BRANCH;
  if (!remoteHasConfigurationBranch(remote)) {
    throw new SingularityFlowError(
      `Cannot publish capabilities because '${remote}' has no '${CONFIGURATION_BRANCH}' branch.`);
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-publish-map-'));
  try {
    const cloned = run('git', [
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      '--filter=blob:none', '--branch', baseBranch, remote, scratch
    ], { allowFailure: true });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${remote}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`);
    }
    const state = await publishCapabilityMap(scratch, {
      message: `Publish reviewed capability map from ${baseBranch}`
    });
    return { baseBranch, ...state };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Pending capability proposals on a lead repository, without changing either authority branch. */
export async function listCapabilityProposals(url, { includeMerged = false } = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.');
  if (!remoteHasConfigurationBranch(remote)) return [];
  const heads = run('git', ['ls-remote', '--heads', remote,
    `refs/heads/${CAPABILITY_PROPOSAL_PREFIX}*`], { allowFailure: true });
  if (heads.status !== 0) {
    throw new SingularityFlowError(
      `Cannot list capability proposals on '${remote}': ${(heads.stderr || heads.stdout).trim().split('\n')[0]}`);
  }
  const branches = heads.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line) => line.split(/\s+/)[1]?.replace(/^refs\/heads\//, '')).filter(Boolean).sort();
  const proposals = [];
  for (const branch of branches) {
    const proposal = await inspectCapabilityProposal(remote, branch);
    if (includeMerged || !proposal.merged) proposals.push(proposal);
  }
  return proposals;
}

/** Exact commits, file set, and diff a reviewer is being asked to activate. */
export async function inspectCapabilityProposal(url, branch) {
  return withCapabilityProposalCheckout(url, branch, async (root, remote, proposalBranch, ref) => {
    const targetCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
    const proposalCommit = run('git', ['rev-parse', ref], { cwd: root }).stdout.trim();
    const proposalBase = run('git', ['rev-parse', `${ref}^`], { cwd: root }).stdout.trim();
    const mergeBaseResult = run('git', ['merge-base', 'HEAD', ref], { cwd: root, allowFailure: true });
    if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
      throw new SingularityFlowError(
        `Capability proposal '${proposalBranch}' does not share history with '${CONFIGURATION_BRANCH}'.`);
    }
    const mergeBase = mergeBaseResult.stdout.trim();
    const merged = run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
      cwd: root, allowFailure: true
    }).status === 0;
    // Review the range the merge will actually apply: everything the proposal adds on top of the
    // branch point. `ref^..ref` is only the tip commit, so a proposal with an earlier commit could
    // carry a non-configuration file straight past the guard and into the configuration branch,
    // with the reviewer's diff never showing it. A merged proposal is already an ancestor of HEAD,
    // making mergeBase..ref empty, so the retrospective review keeps showing the commit itself.
    const reviewBase = merged ? proposalBase : mergeBase;
    const changed = proposalChangedFiles(root, reviewBase, ref);
    const invalidFiles = changed.names.filter((file) => !isConfigurationAsset(file));
    const diff = run('git', ['diff', '--no-ext-diff', '--unified=3', `${reviewBase}..${ref}`], {
      cwd: root
    }).stdout;
    return {
      remote,
      branch: proposalBranch,
      targetBranch: CONFIGURATION_BRANCH,
      targetCommit,
      proposalCommit,
      proposalBase,
      mergeBase,
      merged,
      valid: invalidFiles.length === 0 && changed.names.length > 0,
      invalidFiles,
      changedFiles: changed.statuses,
      diff: diff.length > 200_000 ? `${diff.slice(0, 200_000)}\n… diff truncated …\n` : diff
    };
  });
}

/**
 * Merge one exact reviewed proposal into the configuration authority, then refresh its projection.
 *
 * This is a normal non-force push. A protected `sflow/config` branch therefore refuses the push
 * and retains the proposal for the repository's PR controls instead of bypassing them.
 */
export async function activateCapabilityProposal(url, branch, {
  confirm = null,
  acknowledgeUnprotected = false
} = {}) {
  const reviewed = await withCapabilityProposalCheckout(
    url, branch, async (root, remote, proposalBranch, ref) => {
      const targetBefore = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
      const proposalCommit = run('git', ['rev-parse', ref], { cwd: root }).stdout.trim();
      if (String(confirm ?? '').trim() !== proposalCommit) {
        throw new SingularityFlowError(
          `Confirmation must be the exact proposal commit '${proposalCommit}'. Nothing was changed.`);
      }
      const mergeBaseResult = run('git', ['merge-base', 'HEAD', ref], { cwd: root, allowFailure: true });
      if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
        throw new SingularityFlowError(
          `Capability proposal '${proposalBranch}' does not share history with '${CONFIGURATION_BRANCH}'.`);
      }
      const alreadyMerged = run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
        cwd: root, allowFailure: true
      }).status === 0;
      // An externally merged generated proposal is a single commit and its merge-base with HEAD is
      // now the proposal itself. Retrospective activation still needs the reviewed file set for the
      // audit, so use that proposal commit's parent in the already-merged case.
      const reviewBase = alreadyMerged
        ? run('git', ['rev-parse', `${ref}^`], { cwd: root }).stdout.trim()
        : mergeBaseResult.stdout.trim();
      const changed = proposalChangedFiles(root, reviewBase, ref);
      if (!changed.names.length) {
        throw new SingularityFlowError(`Capability proposal '${proposalBranch}' contains no changes.`);
      }
      const invalidFiles = changed.names.filter((file) => !isConfigurationAsset(file));
      if (invalidFiles.length) {
        throw new SingularityFlowError(
          `Capability proposal contains non-configuration files: ${invalidFiles.join(', ')}.`);
      }
      const definition = await loadDefinition(root);
      if (!definition.ledger?.enabled) {
        throw new SingularityFlowError(
          'Capability activation requires the capability ledger so the review decision can be audited. Nothing was changed.'
        );
      }
      let protection = { enforced: null, detail: 'proposal is already merged' };
      if (!alreadyMerged) {
        const actor = identity(root);
        const merged = run('git', [
          '-c', `user.name=${actor.name || 'Singularity Flow'}`,
          '-c', `user.email=${actor.email || 'unknown@invalid'}`,
          'merge', '--no-ff', '--no-edit', ref
        ], { cwd: root, allowFailure: true });
        if (merged.status !== 0) {
          throw new SingularityFlowError(
            `Capability proposal cannot be merged cleanly into '${CONFIGURATION_BRANCH}'. `
            + `The proposal remains on '${proposalBranch}' for review.`);
        }
        const capabilities = YAML.parse(await readFile(path.join(root, CAPABILITIES_PATH), 'utf8'));
        const portfolio = existsSync(path.join(root, PORTFOLIO_PATH))
          ? YAML.parse(await readFile(path.join(root, PORTFOLIO_PATH), 'utf8')) : null;
        validateCapabilities(capabilities, portfolio);
        // Probe the prospective merge commit, not the proposal tip. If the authority advanced
        // after this proposal was created, pushing the proposal itself is non-fast-forward even on
        // an unprotected server and would produce a false claim that protection was enforced.
        protection = configurationProtectionProbe(root, 'HEAD');
        if (!protection.enforced && !acknowledgeUnprotected) {
          throw new SingularityFlowError(
            `'${CONFIGURATION_BRANCH}' on '${remote}' accepted the exact dry-run update, so branch `
            + 'protection is not enforced for this actor. Nothing was changed. Review the proposal '
            + 'externally or re-run with --acknowledge-unprotected to record an explicit exception.',
            { code: 'CAPABILITY_CONFIGURATION_UNPROTECTED' }
          );
        }
        const pushed = run('git', ['push', 'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`], {
          cwd: root, allowFailure: true
        });
        if (pushed.status !== 0) {
          throw new SingularityFlowError(
            `The proposal remains on '${proposalBranch}', but '${CONFIGURATION_BRANCH}' rejected the normal push: `
            + `${(pushed.stderr || pushed.stdout).trim().split('\n')[0]}. `
            + 'Merge it through the repository review controls, then publish the capability projection.');
        }
      }
      const targetCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
      const proposer = commitIdentity(root, ref);
      const approver = identity(root);
      const intent = createLedgerIntent({
        eventType: 'capability-configuration-activated',
        capabilityId: 'organisation',
        subject: {
          workId: `capability-proposal:${proposalCommit}`,
          phase: 'activation',
          generation: proposalCommit,
          branch: CONFIGURATION_BRANCH
        },
        actor: approver,
        payload: {
          proposer,
          approver: {
            name: approver.name ?? null,
            email: approver.email ?? null,
            githubLogin: approver.login ?? approver.githubLogin ?? null
          },
          proposalBranch,
          proposalCommit,
          targetBefore,
          targetCommit,
          changedFiles: changed.statuses,
          protection,
          unprotectedAcknowledged: protection.enforced === false && acknowledgeUnprotected === true
        }
      });
      let audit;
      try {
        audit = await appendLedgerIntent(root, definition.ledger, intent, targetCommit);
      } catch (error) {
        throw new SingularityFlowError(
          `Capability configuration reached '${CONFIGURATION_BRANCH}' at ${targetCommit}, but its `
          + `activation audit could not be appended: ${error.message}. Re-run the same activation to reconcile it.`
        );
      }
      return {
        remote,
        branch: proposalBranch,
        proposalCommit,
        targetBranch: CONFIGURATION_BRANCH,
        targetBefore,
        targetCommit,
        alreadyMerged,
        changedFiles: changed.statuses,
        protection,
        audit: {
          recorded: true,
          eventId: audit.eventId,
          eventType: intent.eventType,
          sequence: audit.sequence,
          ledgerCommit: audit.ledgerCommit,
          duplicate: audit.duplicate
        }
      };
    });
  const projection = await publishOrganisationCapabilityMap(url);
  return { ...reviewed, projection };
}

/**
 * Change a capability that is already on the map, without checking anything out.
 *
 * Same borrowed-clone path as mapping one. Requiring a full clone to correct a Confluence link or
 * add a second repository is exactly why maps go stale: the cost of the edit exceeds the cost of
 * leaving it wrong.
 */
export async function editCapabilityInOrganisation(leadUrl, capabilityId, changes = {}, {
  mode = 'set', reparentChildrenTo = undefined
} = {}) {
  if (!capabilityId) throw new SingularityFlowError('A capability identifier is required.');
  if (!['add', 'set', 'remove'].includes(mode)) {
    throw new SingularityFlowError("Capability proposal mode must be 'add', 'set', or 'remove'.");
  }
  const action = mode === 'add' ? 'Add' : mode === 'remove' ? 'Remove' : 'Update';
  return withLeadCheckout(leadUrl, `${action} capability ${capabilityId}`,
    `capability/${mode}-${capabilityId}`, async (root) => {
    assertGovernanceVisible(root);
    if (!existsSync(path.join(root, CAPABILITIES_PATH))) {
      throw new SingularityFlowError(
        `${leadUrl} holds no capability map, so there is nothing to edit. Map a capability first.`);
    }
    const portfolio = existsSync(path.join(root, PORTFOLIO_PATH))
      ? YAML.parse(await readFile(path.join(root, PORTFOLIO_PATH), 'utf8'))
      : null;
    // editCapability validates before it writes, so a refused edit leaves the map exactly as it
    // was — which matters more here than usual, because this checkout is about to be pushed.
    const result = await editCapability(root, capabilityId, changes, {
      mode, portfolio, reparentChildrenTo
    });
    return {
      capabilityId, changed: result?.changed ?? true,
      reparentedChildren: result.reparentedChildren ?? [],
      state: { published: false, reason: 'awaiting review and merge' }
    };
  });
}

/**
 * Whether each repository a capability ships from is actually ready to be worked in.
 *
 * Two questions, asked of the remote rather than of a clone: does the orphan state branch exist,
 * and is there a world model. Both are things you otherwise discover at the moment you need them —
 * a phase that will not ground, a workspace with nowhere to record its governance — and both are
 * answerable in one `ls-remote` per repository.
 *
 * The world model is looked for on the state branch first and the default branch second, in that
 * order, because that is the order every reader resolves it in.
 */
export async function capabilityReadiness(leadUrl, { stateBranch = 'state', outputDir = 'singularity/world-model' } = {}) {
  const organisation = await readOrganisation(leadUrl);
  const repositories = organisation.repositories ?? {};
  const rows = {};
  for (const [id, declared] of Object.entries(repositories)) {
    const url = declared?.url;
    if (!url) continue;
    const refs = run('git', ['ls-remote', '--heads', url], { allowFailure: true }).stdout;
    const hasState = refs.includes(`refs/heads/${stateBranch}`);
    const defaultBranch = declared.defaultBranch ?? 'main';
    // GitHub and many corporate Git servers disable `git archive --remote`. Fetch the one shallow
    // commit into a temporary bare repository and inspect it there instead; this works over the
    // same HTTPS/SSH transports used by clone and leaves no checkout behind.
    const modelOn = async (branch) => {
      if (!refs.includes(`refs/heads/${branch}`)) return false;
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-ready-'));
      try {
        run('git', ['init', '--quiet', '--bare', scratch]);
        const fetched = run('git', ['fetch', '--quiet', '--depth', '1', url, `refs/heads/${branch}`], {
          cwd: scratch,
          allowFailure: true
        });
        if (fetched.status !== 0) return false;
        return run('git', ['cat-file', '-e', `FETCH_HEAD:${outputDir}/manifest.json`], {
          cwd: scratch,
          allowFailure: true
        }).status === 0;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    };
    const onState = hasState && await modelOn(stateBranch);
    rows[id] = {
      url,
      stateBranch: hasState ? stateBranch : null,
      hasStateBranch: hasState,
      // Which copy a command would actually read, said plainly rather than left to be worked out.
      worldModel: onState ? 'state-branch' : await modelOn(defaultBranch) ? defaultBranch : null
    };
  }
  return rows;
}

/**
 * The world model for a capability, at any level of the tree.
 *
 * A capability that ships has one: the model in its lead repository, resolved state-branch-first
 * like every other read. A capability that groups others has no repository to hold one, so its
 * model is the union of its children's — composed when asked and stored nowhere.
 *
 * Storing it would be the obvious alternative and it is the wrong one. A grouping's model contains
 * nothing that is not already in its children, so a stored copy is a second thing to build, to
 * invalidate when a child rebuilds, and to be wrong. Composition cannot go stale, because there is
 * nothing to go stale.
 *
 * Nothing is fetched here. It reports which parts exist and where each comes from, which is what a
 * reader needs to decide whether to trust the grounding — the parts themselves are resolved by
 * whoever is about to read them.
 */
export function composeCapabilityWorldModel(organisation, capabilityId, readiness = {}) {
  const rows = flattenTree(organisation.capabilities ?? []);
  const target = rows.find((row) => row.id === capabilityId);
  if (!target) throw new SingularityFlowError(`Unknown capability '${capabilityId}'.`);

  const modelFor = (row) => {
    const lead = row.leadRepository ?? row.repositories?.[0] ?? null;
    if (!lead) return null;
    const state = readiness[lead];
    return {
      capability: row.id,
      name: row.name,
      repository: lead,
      // Where a reader would actually find it, or null when nobody has built one yet.
      branch: state?.worldModel ?? null,
      present: Boolean(state?.worldModel)
    };
  };

  if (target.repositories?.length) {
    const own = modelFor(target);
    return {
      capability: capabilityId,
      name: target.name,
      composed: false,
      sources: own ? [own] : [],
      // A capability that ships from several repositories still has one model: the lead's. The
      // others are where its code lives, not where its understanding of itself lives.
      alsoShipsFrom: (target.repositories ?? []).filter((id) => id !== own?.repository)
    };
  }

  // Every shipping capability beneath this one, however deep. A grouping of groupings composes
  // through them without needing a model of its own at each level.
  const beneath = rows
    .filter((row) => row.ancestors.includes(capabilityId) && row.repositories?.length)
    .map(modelFor)
    .filter(Boolean);
  return {
    capability: capabilityId,
    name: target.name,
    composed: true,
    sources: beneath,
    alsoShipsFrom: []
  };
}

/** Depth-first with ancestors, matching what capabilityTree consumers already expect. */
function flattenTree(nodes, ancestors = []) {
  return nodes.flatMap((node) => [
    { ...node, depth: ancestors.length, ancestors },
    ...flattenTree(node.children ?? [], [...ancestors, node.id])
  ]);
}

/** The repository identifier a clone URL implies. */
export function repositoryIdOf(url) {
  const id = String(url ?? '').trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop()
    ?.normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (!id) throw new SingularityFlowError(`Cannot derive a repository identifier from '${url}'.`);
  return id;
}

/**
 * Refuse to govern a repository that ignores the folder the governance lives in.
 *
 * `singularity/` is deliberately visible — it is the product's whole premise that the state is
 * readable in the repository rather than hidden in a dotfile. A `.gitignore` that excludes it, or
 * excludes something inside it, makes every governed write a no-op that reports success: the file
 * is written, `git add` silently skips it, and the commit lands without it. That is a very quiet
 * way to lose an audit trail, so it is checked rather than hoped for.
 */
export function assertGovernanceVisible(root, paths = [CAPABILITIES_PATH, PORTFOLIO_PATH, 'singularity/workflow.yml']) {
  const ignored = [];
  for (const relative of paths) {
    const result = run('git', ['check-ignore', '-q', '--', relative], { cwd: root, allowFailure: true });
    // 0 means ignored, 1 means not ignored, anything else means git could not tell us.
    if (result.status === 0) ignored.push(relative);
  }
  if (!ignored.length) return { visible: true, ignored: [] };
  throw new SingularityFlowError(
    `Git is ignoring ${ignored.join(', ')}, so governed writes would be silently dropped. `
    + 'Remove the matching .gitignore rule: singularity/ is meant to be visible and committed.');
}

/**
 * The repositories a set of capabilities implies, ready to become a workspace's repository plan.
 *
 * Choosing a capability means the things beneath it, the way choosing a directory means its
 * contents — so a grouping brings in everything it groups. The lead capability is the one whose
 * repository the workspace treats as its lead, which is where the orphan state branch is created
 * when the workspace is initialised.
 */
export function resolveWorkspacePlan(organisation, { capabilities = [], leadCapability = null } = {}) {
  const { flattenCapabilityTree } = { flattenCapabilityTree: flatten };
  const rows = flattenCapabilityTree(organisation.capabilities ?? []);
  const chosen = new Set(capabilities);
  if (!chosen.size) throw new SingularityFlowError('A workspace needs at least one capability.');

  for (const id of chosen) {
    if (!rows.some((row) => row.id === id)) {
      throw new SingularityFlowError(`Unknown capability '${id}' in this organisation.`);
    }
  }

  // Every repository a capability ships from, not the first one. A product with a web app and a
  // service is two, and a workspace that cloned one of them is a workspace missing half the work.
  const shipsFrom = (row) => (row.repositories?.length
    ? row.repositories
    : (row.repository ? [row.repository] : []));

  const covered = rows.filter((row) => chosen.has(row.id)
    || row.ancestors.some((ancestor) => chosen.has(ancestor)));
  const shipping = covered.filter((row) => shipsFrom(row).length);
  if (!shipping.length) {
    throw new SingularityFlowError(
      'None of the chosen capabilities ships from a repository, so there would be nothing to work in.');
  }

  const lead = leadCapability ?? shipping[0].id;
  const leadRow = covered.find((row) => row.id === lead);
  if (!leadRow) {
    throw new SingularityFlowError(`Lead capability '${lead}' is not among the chosen capabilities.`);
  }
  const leadShips = shipsFrom(leadRow);
  if (!leadShips.length) {
    throw new SingularityFlowError(
      `Lead capability '${lead}' does not ship from a repository. The lead is where the workspace's `
      + 'state branch is created, so it has to be one that does.');
  }
  // With several, the capability's own lead decides — the state branch goes in one repository, and
  // which one is a decision the map records rather than one the ordering of a list makes.
  const leadRepository = leadRow.leadRepository ?? leadShips[0];

  const repositories = {};
  for (const row of shipping) {
    for (const id of shipsFrom(row)) {
      const declared = organisation.repositories?.[id];
      if (!declared?.url) {
        throw new SingularityFlowError(
          `Capability '${row.id}' ships from '${id}', which the organisation's portfolio `
          + 'does not declare, so there is nowhere to clone it from.');
      }
      repositories[id] = {
        url: declared.url,
        defaultBranch: declared.defaultBranch ?? 'main',
        required: true,
        path: `repos/${id}`,
        clone: declared.clone ?? { mode: 'full' },
        capabilities: [...new Set([...(repositories[id]?.capabilities ?? []), row.id])].sort()
      };
    }
  }

  return {
    repositories,
    leadRepository,
    leadCapability: lead,
    capabilities: [...chosen].sort()
  };
}

/** Depth-first, with ancestors — the same shape capabilityTree consumers expect. */
function flatten(nodes, ancestors = []) {
  return nodes.flatMap((node) => [
    { ...node, depth: ancestors.length, ancestors },
    ...flatten(node.children ?? [], [...ancestors, node.id])
  ]);
}

/**
 * Make the workspace's lead repository carry the governed state branch.
 *
 * Called when a workspace is initialised, which is the moment there is finally a checkout to create
 * the branch from. The branch is an orphan: it has no shared ancestry with any code branch and is
 * never merged into one, so a rebase of the work cannot rewrite the record of it.
 *
 * Checks before it creates, in both directions. A lead that is already governed keeps its own
 * definition; a lead that already has the branch is left alone. Neither is an error — re-running
 * this on an established workspace should do nothing and say so.
 */
export async function initializeWorkspaceState(leadDirectory, { branch = 'state', push = true } = {}) {
  const root = path.resolve(leadDirectory);
  if (!existsSync(path.join(root, '.git'))) {
    throw new SingularityFlowError(`${root} is not a Git repository, so it cannot carry the state branch.`);
  }

  // A delivery repository is not usually governed in its own right — the map lives in the lead of
  // the organisation. But the state branch is written to by the repository the work happens in, so
  // that repository needs a definition naming the branch.
  // A checkout with no commit on the current branch cannot carry a governed branch, and the raw
  // git error for it names an ambiguous argument, which describes git and not the situation.
  const current = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, allowFailure: true })
    .stdout.trim();
  if (!current || current === 'HEAD') {
    throw new SingularityFlowError(
      `${root} has no branch checked out, so there is nothing to base the ${branch} branch on. `
      + 'This usually means the clone landed on a branch the remote does not have.');
  }

  const workflowPath = path.join(root, 'singularity/workflow.yml');
  const governed = existsSync(workflowPath);
  const workflowText = governed ? await readFile(workflowPath, 'utf8') : '';
  const needsGovernanceProposal = !governed || !/^ledger:\s*$/m.test(workflowText);
  let governanceBranch = current;
  let governancePublished = true;
  let publicationError = null;
  if (needsGovernanceProposal) {
    const applicationBranch = defaultBranchName(root);
    if (current !== applicationBranch) {
      throw new SingularityFlowError(
        `Cannot initialize repository governance from '${current}'. Switch to the application branch '${applicationBranch}' first.`
      );
    }
    const repositoryId = repositoryIdFromUrl(
      run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true }).stdout.trim() || path.basename(root)
    );
    governanceBranch = `sflow/govern/${repositoryId}-${head(root).slice(0, 8)}`;
    const remoteReview = run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${governanceBranch}`], {
      cwd: root, allowFailure: true
    }).stdout.trim();
    if (remoteReview) {
      throw new SingularityFlowError(
        `Governance review branch '${governanceBranch}' already exists. Review or remove that proposal before retrying.`
      );
    }
    const localReview = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${governanceBranch}`], {
      cwd: root, allowFailure: true
    });
    if (localReview.status === 0) {
      throw new SingularityFlowError(
        `Local governance review branch '${governanceBranch}' already exists. Resume or remove it before retrying.`
      );
    }
    run('git', ['switch', '-c', governanceBranch], { cwd: root });
    if (!governed) {
      await initializeDefinition(root);
      await setDefaultBaseBranch(root, applicationBranch);
    }
    const actor = identity(root);
    const url = run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true }).stdout.trim();
    if (!governed && url) {
      await describeRepository(root, repositoryIdFromUrl(url), url, applicationBranch, actor);
    }
    await enableLedger(root, branch);
    run('git', ['add', '--', ...GOVERNED_ROOTS], { cwd: root });
    if (run('git', ['diff', '--cached', '--name-only'], { cwd: root }).stdout.trim()) {
      run('git', ['-c', `user.name=${actor.name || 'Singularity Flow'}`,
        '-c', `user.email=${actor.email || 'unknown@invalid'}`,
        'commit', '-m', 'Govern this repository with Singularity Flow'], { cwd: root });
    }
    if (push) {
      const pushed = run('git', ['push', '-u', 'origin', `HEAD:refs/heads/${governanceBranch}`], {
        cwd: root, allowFailure: true
      });
      governancePublished = pushed.status === 0;
      publicationError = governancePublished ? null : (pushed.stderr || pushed.stdout).trim().split('\n')[0];
      if (governancePublished && url) {
        await ensureConfigurationBranch(url, { sourceBranch: governanceBranch });
      }
    }
  }

  const existed = run('git', ['ls-remote', '--heads', 'origin', branch], { cwd: root, allowFailure: true })
    .stdout.includes(`refs/heads/${branch}`);
  const ledger = await initializeLedger(
    root,
    { enabled: true, branch, remote: push ? 'origin' : null },
    { publish: push && governancePublished }
  );
  return {
    root,
    branch,
    governed,
    existed,
    created: Boolean(ledger?.created),
    governanceBranch,
    reviewRequired: needsGovernanceProposal,
    governancePublished: push ? governancePublished : false,
    publicationError,
    pinRepair: ledger?.pinRepair ?? null
  };
}
