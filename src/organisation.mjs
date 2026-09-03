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
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import {
  isGitRefName, mapLimit, removeTemporaryTree, SingularityFlowError, run, readJson, YAML_OUTPUT
} from './util.mjs';
import {
  CAPABILITIES_PATH, capabilityRepositories, editCapability, loadCapabilities,
  validateCapabilities, capabilityTree
} from './capabilities.mjs';
import { atomicJson, workspaceRepositoryPath } from './workspace.mjs';
import { canonicalJson } from './records.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { defaultBranchName, gitCommitIdentity, head, identity } from './git.mjs';
import { GOVERNED_ROOTS, WORKFLOW_PATH, initializeDefinition, loadDefinition } from './config.mjs';
import {
  describeRepository, enableLedger, repositoryIdFromUrl, setDefaultBaseBranch
} from './bootstrap.mjs';
import {
  appendLedgerIntent, createLedgerIntent, initializeLedger, publishToStateBranch
} from './ledger.mjs';
import {
  CONFIGURATION_BRANCH, STATE_CONFIGURATION_BRANCH, STATE_CONFIGURATION_FORMAT,
  STATE_CONFIGURATION_MANIFEST,
  canonicalConfigurationAssets, configurationAssetPaths, configurationBranchHead,
  configurationAssetPolicyFromRef, configurationTreeEntries,
  ensureConfigurationBranch, isConfigurationAsset, loadStoryConfigurationSnapshot,
  readConfigurationSource, retainStateConfigurationHistory, stateConfigurationHistoryBranch,
} from './configuration-branch.mjs';
import { mergeConfigurationAssetPolicies } from './configuration-assets.mjs';
import {
  normalizeCloneStrategy, partialCloneConfigured, partialCloneFallbackDecision
} from './clone-strategy.mjs';
import { createAndPushTransportIntent } from './transport-intents.mjs';
import {
  assertCredentialFreeRemote, classifyGitRemoteFailure, frozenRemoteTransport,
  redactDiagnosticText, safeGitDiagnosticReference, sanitizeRemote
} from './git-remote-diagnostics.mjs';
import { enterpriseGitEnvironment } from './git-enterprise-environment.mjs';
import {
  GitRemoteSession, requireRemoteObservation, runRemoteGitAsync
} from './git-execution.mjs';
import {
  forgetLeadRepository, leadRegistryFile, listLeadRepositories, listLeadRepositoryRegistryRecords,
  rememberLeadRepository
} from './lead-repositories.mjs';

export {
  forgetLeadRepository, leadRegistryFile, listLeadRepositories, rememberLeadRepository
};

const PORTFOLIO_PATH = 'singularity/portfolio.yml';
const CAPABILITY_PROPOSAL_PREFIX = 'sflow/config-change/capability/';
const CAPABILITY_INSPECTION_MAX_PROPOSALS = 64;

function quoted(value, fallback = 'VALUE') {
  const text = String(value ?? '');
  if (/^[A-Za-z0-9][A-Za-z0-9._/@:=,+-]*$/.test(text)) return text;
  return fallback;
}

/** Preserve an executable authority exactly; unsafe input becomes a non-secret placeholder. */
function commandRemote(value, fallback = 'LEAD_URL') {
  const candidate = String(value ?? '').trim();
  if (!candidate) return fallback;
  try {
    const exact = assertCredentialFreeRemote(candidate);
    // In SCP syntax `?` and `#` are valid path bytes, not URL query/fragment delimiters. Preserve
    // that transport identity internally, but do not reflect a token-shaped suffix in a suggested
    // shell command; the operator can supply the reviewed URL explicitly.
    if (!/^[A-Za-z0-9][A-Za-z0-9._/@:=,+-]*$/.test(exact)
      || /^[^/\s@]+@[^:\s]+:.+[?#]/.test(exact)) return fallback;
    return exact;
  }
  catch { return fallback; }
}

function capabilityCommand(action, {
  remote, branch = null, commit = null, acknowledge = false, reason = null
} = {}) {
  const args = ['singularity-flow', 'capability', action];
  if (branch) args.push(quoted(branch, 'PROPOSAL_BRANCH'));
  if (remote) args.push('--lead', quoted(commandRemote(remote)));
  if (commit) args.push('--confirm', quoted(commit, 'COMMIT_SHA'));
  if (reason) args.push('--reason', quoted(reason, 'REASON'));
  if (acknowledge) args.push('--acknowledge-unprotected');
  args.push('--json');
  return args.join(' ');
}

/** Executable-looking review guidance must remain safe in POSIX shells, cmd.exe, and PowerShell. */
export function capabilityProposalCommands(lead, branch, commit) {
  return {
    review: capabilityCommand('proposal', { remote: lead, branch }),
    activate: capabilityCommand('activate', { remote: lead, branch, commit })
  };
}

function capabilityRecovery({
  stage, state, remote = null, branch = null, commit = null, nextAction = null,
  recoverable = true, preserved = []
}) {
  return {
    journey: 'capability-onboarding', stage, state, recoverable,
    lead: remote ? sanitizeRemote(remote) : null,
    proposalBranch: branch,
    proposalCommit: commit,
    preserved,
    nextAction
  };
}

function capabilityProposalBranch(value) {
  const branch = String(value ?? '').trim();
  if (!branch.startsWith(CAPABILITY_PROPOSAL_PREFIX)
    || !/^sflow\/config-change\/capability\/[a-z0-9._/-]+$/.test(branch)
    || branch.includes('..') || branch.endsWith('/') || branch.includes('//')) {
    throw new SingularityFlowError(
      `Capability proposal must be a branch beneath '${CAPABILITY_PROPOSAL_PREFIX}'.`, {
        code: 'CAPABILITY_PROPOSAL_BRANCH_INVALID',
        details: capabilityRecovery({
          stage: 'review', state: 'input-refused', recoverable: true,
          nextAction: { command: 'singularity-flow capability proposals --all --json', skill: '/sf-capability-map' }
        })
      });
  }
  return branch;
}

function proposalChangedFiles(root, base, proposal, { env = process.env } = {}) {
  const names = run('git', ['diff', '--name-only', `${base}..${proposal}`], { cwd: root, env })
    .stdout.split('\n').map((entry) => entry.trim()).filter(Boolean);
  const statuses = run('git', ['diff', '--name-status', `${base}..${proposal}`], { cwd: root, env })
    .stdout.split('\n').map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const [status, ...paths] = entry.split('\t');
      return { status, paths };
    });
  return { names, statuses };
}

/** Paths whose final Git identities prove a squash/rebase applied this exact proposal content. */
function proposalContentPaths(root, base, proposal, { env = process.env } = {}) {
  return run('git', [
    'diff', '--no-renames', '--name-only', '-z', `${base}..${proposal}`
  ], { cwd: root, env }).stdout.split('\0').filter(Boolean);
}

function proposalContentIsPresent(root, base, proposal, target = 'HEAD', {
  env = process.env
} = {}) {
  const paths = proposalContentPaths(root, base, proposal, { env });
  if (!paths.length) return false;
  return run('git', ['diff', '--quiet', target, proposal, '--', ...paths], {
    cwd: root, env, allowFailure: true
  }).status === 0;
}

/** Resolve the immutable proposal base encoded in every generated review-branch name. */
function proposalBaseCommit(root, proposalBranch, ref, { env = process.env } = {}) {
  const prefix = proposalBranch.match(/-([0-9a-f]{8})$/)?.[1] ?? null;
  const revision = run('git', ['rev-list', '--parents', '-n', '1', ref], {
    cwd: root, env, allowFailure: true
  }).stdout.trim().split(/\s+/);
  const history = prefix
    ? run('git', ['rev-list', '--first-parent', ref], { cwd: root, env, allowFailure: true })
        .stdout.split('\n').map((entry) => entry.trim()).filter((entry) => entry.startsWith(prefix))
    : [];
  if (revision.length !== 2 || history.length !== 1 || history[0] === revision[0]) {
    throw new SingularityFlowError(
      `Capability proposal '${proposalBranch}' no longer has the exact configuration base encoded by its review branch.`, {
        code: 'CAPABILITY_PROPOSAL_HISTORY_INVALID'
      }
    );
  }
  return history[0];
}

function proposalConfigurationError(root, ref, { env = process.env } = {}) {
  try {
    const capabilities = run('git', ['show', `${ref}:${CAPABILITIES_PATH}`], {
      cwd: root, env, allowFailure: true
    });
    if (capabilities.status !== 0) return `missing ${CAPABILITIES_PATH}`;
    const portfolio = run('git', ['show', `${ref}:${PORTFOLIO_PATH}`], {
      cwd: root, env, allowFailure: true
    });
    validateCapabilities(
      YAML.parse(capabilities.stdout),
      portfolio.status === 0 ? YAML.parse(portfolio.stdout) : null
    );
    return null;
  } catch (error) {
    return redactDiagnosticText(error?.message ?? String(error));
  }
}

/** Find exact repository claims changed by one proposal, without treating inherited bytes as new. */
function proposalRepositoryInspection(root, ref, repositoryUrl, {
  baseRef = null, env = process.env
} = {}) {
  if (!repositoryUrl) return { complete: true, matches: [] };
  const snapshot = (candidate, { missingIsEmpty = false } = {}) => {
    const portfolio = run('git', ['show', `${candidate}:${PORTFOLIO_PATH}`], {
      cwd: root, env, allowFailure: true
    });
    if (portfolio.status !== 0) {
      return missingIsEmpty ? { complete: true, matches: [] } : { complete: false, matches: [] };
    }
    let repositories;
    try { repositories = YAML.parse(portfolio.stdout)?.repositories ?? {}; }
    catch { return { complete: false, matches: [] }; }
    const entries = Object.entries(repositories)
      .filter(([, declaration]) => declaration?.url === repositoryUrl);
    if (!entries.length) return { complete: true, matches: [] };

    const capabilities = run('git', ['show', `${candidate}:${CAPABILITIES_PATH}`], {
      cwd: root, env, allowFailure: true
    });
    if (capabilities.status !== 0 && missingIsEmpty) {
      return { complete: true, matches: entries.map(([repositoryId, declaration]) => ({
        repositoryId, repositoryUrl: declaration.url, capabilities: [],
        capabilityMetadataComplete: true
      })) };
    }
    try {
      const definition = validateCapabilities(YAML.parse(capabilities.stdout), YAML.parse(portfolio.stdout));
      const rows = flattenTree(capabilityTree(definition));
      return { complete: true, matches: entries.map(([repositoryId, declaration]) => ({
        repositoryId,
        repositoryUrl: declaration.url,
        capabilities: rows
          .filter((capability) => (capability.repositories ?? []).includes(repositoryId))
          .map((capability) => capability.id).sort(),
        capabilityMetadataComplete: true
      })) };
    } catch {
      return { complete: false, matches: entries.map(([repositoryId, declaration]) => ({
        repositoryId, repositoryUrl: declaration.url, capabilities: [],
        capabilityMetadataComplete: false
      })) };
    }
  };

  const proposed = snapshot(ref);
  if (!baseRef) return proposed;
  const base = snapshot(baseRef, { missingIsEmpty: true });
  if (!proposed.complete || !base.complete) {
    return { complete: false, matches: proposed.matches };
  }
  const proposedById = new Map(proposed.matches.map((match) => [match.repositoryId, match]));
  const baseById = new Map(base.matches.map((match) => [match.repositoryId, match]));
  const changedIds = new Set([...proposedById.keys(), ...baseById.keys()]);
  const matches = [];
  for (const repositoryId of changedIds) {
    const after = proposedById.get(repositoryId);
    const before = baseById.get(repositoryId);
    if (after?.repositoryUrl === before?.repositoryUrl
      && canonicalJson(after?.capabilities ?? []) === canonicalJson(before?.capabilities ?? [])) continue;
    // A proposal that removes this URL (or moves the repository ID to another URL) is not a
    // pending claim on the inspected repository. Only the proposed side can establish one.
    if (after) matches.push(after);
  }
  return { complete: true, matches };
}

/** Git's push --dry-run does not execute receive hooks and therefore cannot prove protection. */
function configurationProtectionProbe() {
  return {
    enforced: null,
    detail: 'branch protection cannot be proven portably without attempting the exact leased update'
  };
}

function commitIdentity(root, ref, { env = process.env } = {}) {
  const shown = run('git', ['show', '-s', '--format=%an%x00%ae', ref], {
    cwd: root, env
  }).stdout.trim();
  const [name = '', email = ''] = shown.split('\0');
  return { name: name || null, email: email || null };
}

function fullCommit(value) {
  const commit = String(value ?? '').trim().toLowerCase();
  return /^[0-9a-f]{40,64}$/.test(commit) ? commit : null;
}

function proposalAssetPolicy(root, ...refs) {
  return mergeConfigurationAssetPolicies(...refs.filter(Boolean)
    .map((ref) => configurationAssetPolicyFromRef(root, ref)));
}

function proposalAssetPolicyInEnvironment(root, refs, env) {
  return mergeConfigurationAssetPolicies(...refs.filter(Boolean)
    .map((ref) => configurationAssetPolicyFromRef(root, ref, { env })));
}

/** Recover a deleted review branch from its exact reviewed commit, when the remote still retains it. */
async function recoverMergedProposalRef(root, expectedCommit, proposalBranch, {
  env = process.env
} = {}) {
  const commit = fullCommit(expectedCommit);
  if (!commit) return null;
  const ref = `refs/singularity/capability-proposal-recovery/${commit}`;
  const available = () => run('git', ['cat-file', '-e', `${commit}^{commit}`], {
    cwd: root, env, allowFailure: true
  }).status === 0;
  const contained = () => available() && run('git', [
    'merge-base', '--is-ancestor', commit, 'HEAD'
  ], { cwd: root, env, allowFailure: true }).status === 0;
  if (!available()) {
    // GitHub and many office providers retain a just-merged review commit after deleting its source
    // branch. Ask only for the caller-confirmed full object ID; if the server no longer exposes it,
    // recovery stays fail-closed rather than guessing from the target tree.
    const recovered = await runRemoteGitAsync([
      'fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin',
      `${commit}:${ref}`
    ], { cwd: root, operation: 'remote-configuration', env });
    if (recovered.status !== 0 || !available()) return null;
  }
  // `confirm` is caller input, not a durable branch receipt. Bind it back to the immutable base
  // encoded in the proposal branch before treating an arbitrary approved ancestor as its deleted
  // source. This also supports a proposal that accumulated multiple reviewed commits while refusing
  // merge commits, unrelated history, and invented branch/commit pairs.
  let base;
  try { base = proposalBaseCommit(root, proposalBranch, commit, { env }); }
  catch { return null; }
  const changed = proposalChangedFiles(root, base, commit, { env }).names;
  const policy = proposalAssetPolicyInEnvironment(root, [base, commit], env);
  if (!changed.length || changed.some((relative) => !isConfigurationAsset(relative, policy))) return null;
  if (!contained() && !proposalContentIsPresent(root, base, commit, 'HEAD', { env })) return null;
  run('git', ['update-ref', ref, commit], { cwd: root, env });
  return ref;
}

async function withCapabilityProposalCheckout(url, branch, operation, { expectedCommit = null } = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.', {
    code: 'CAPABILITY_LEAD_REQUIRED',
    details: capabilityRecovery({
      stage: 'review', state: 'input-refused', recoverable: true,
      nextAction: { command: 'singularity-flow capability leads --json', skill: '/sf-capability-map' }
    })
  });
  const gitEnv = enterpriseGitEnvironment();
  const session = new GitRemoteSession({ env: gitEnv });
  const transport = frozenRemoteTransport(remote, { push: true, env: gitEnv });
  const configurationObservation = await session.observeAsync(remote, {
    includeHead: false, refs: [`refs/heads/${CONFIGURATION_BRANCH}`]
  });
  const configurationHead = configurationBranchHead(remote, {
    session, observation: configurationObservation
  });
  if (!configurationHead.reachable || !configurationHead.exists) {
    throw new SingularityFlowError(`'${sanitizeRemote(remote)}' has no '${CONFIGURATION_BRANCH}' branch. Map the first capability to initialize its configuration authority.`, {
      code: 'CAPABILITY_CONFIGURATION_BRANCH_MISSING',
      details: capabilityRecovery({
        stage: 'review', state: 'configuration-not-initialized', remote, recoverable: true,
        nextAction: { command: `singularity-flow capability map <CAPABILITY-ID> --lead ${quoted(commandRemote(remote))} --json`, skill: '/sf-capability-map' }
      })
    });
  }
  const proposalBranch = capabilityProposalBranch(branch);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-review-'));
  try {
    // `--branch` alone still negotiates every remote branch. On a monorepo that made a capability
    // approval transfer application history it never reads. The authority branch is orphaned, so
    // this branch plus the exact proposal ref fetched below is the complete review input.
    const clone = (filtered) => runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch',
      ...(filtered ? ['--filter=blob:none'] : []),
      '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    let cloned = await clone(true);
    const partial = partialCloneFallbackDecision(cloned, {
      configured: cloned.status === 0
        ? partialCloneConfigured(scratch, 'origin', (args, options) => run('git', args, {
            ...options, env: transport.env
          }))
        : null,
      fallback: 'full'
    });
    if (partial.action === 'retry-full') {
      await removeTemporaryTree(scratch);
      await mkdir(scratch, { recursive: true });
      cloned = await clone(false);
    }
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${sanitizeRemote(remote)}'. Correct Git access, then retry the same capability review.`, {
          code: 'CAPABILITY_AUTHORITY_UNAVAILABLE',
          details: capabilityRecovery({
            stage: 'review', state: 'authority-unavailable', remote, branch: proposalBranch,
            nextAction: { command: capabilityCommand('proposal', { remote, branch: proposalBranch }), skill: '/sf-capability-map' },
            preserved: ['remote-configuration', 'proposal-branch']
          })
        });
    }
    let fetched = await runRemoteGitAsync(['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin',
      `refs/heads/${proposalBranch}:refs/remotes/origin/${proposalBranch}`], {
      cwd: scratch, operation: 'remote-configuration', env: transport.env
    });
    if (partialCloneFallbackDecision(fetched, { fallback: 'full' }).action === 'retry-full') {
      fetched = await runRemoteGitAsync(['fetch', '--quiet', '--no-tags', 'origin',
        `refs/heads/${proposalBranch}:refs/remotes/origin/${proposalBranch}`], {
        cwd: scratch, operation: 'remote-configuration', env: transport.env
      });
    }
    const proposalRef = fetched.status === 0
      ? `refs/remotes/origin/${proposalBranch}`
      : await recoverMergedProposalRef(scratch, expectedCommit, proposalBranch, {
          env: transport.env
        });
    if (!proposalRef) {
      throw new SingularityFlowError(
        `Capability proposal '${proposalBranch}' does not exist on '${sanitizeRemote(remote)}'. Refresh the proposal list before retrying.`, {
          code: 'CAPABILITY_PROPOSAL_NOT_FOUND',
          details: capabilityRecovery({
            stage: 'review', state: 'proposal-not-found', remote, branch: proposalBranch,
            nextAction: { command: capabilityCommand('proposals', { remote }), skill: '/sf-capability-map' },
            preserved: ['approved-configuration', 'application-branches']
          })
        });
    }
    return await operation(scratch, remote, proposalBranch, proposalRef, {
      env: transport.env, session
    });
  } finally {
    await removeTemporaryTree(scratch);
  }
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
  const file = organisationCacheFile(remote);
  if (!existsSync(file)) return null;
  const cached = readRecord('organisation-cache', await readJson(file)).record;
  if (cached.url !== remote || !cached.organisation) return null;
  return cached;
}

async function writeOrganisationCache(remote, tipSha, organisation) {
  const file = organisationCacheFile(remote);
  await mkdir(path.dirname(file), { recursive: true });
  await atomicJson(file, {
    schemaVersion: currentSchemaVersion('organisation-cache'),
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
async function withLeadCheckout(url, message, reviewBranchPrefix, mutate, {
  remoteSession = null, authorityObservation = null
} = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.', {
    code: 'CAPABILITY_LEAD_REQUIRED',
    details: capabilityRecovery({
      stage: 'proposal', state: 'input-refused', recoverable: true,
      nextAction: { command: 'singularity-flow capability leads --json', skill: '/sf-capability-map' }
    })
  });

  // One combined advertisement answers both questions needed by first-map bootstrap: whether the
  // configuration authority exists and which application branch HEAD names. Existing authorities
  // pay the same one probe; new authorities no longer pay a second HEAD round trip.
  const operationSession = remoteSession ?? new GitRemoteSession({
    env: enterpriseGitEnvironment()
  });
  const observedAuthority = authorityObservation ?? await operationSession.observeAsync(remote, {
    includeHead: true, refs: [`refs/heads/${CONFIGURATION_BRANCH}`]
  });
  const approvedHead = configurationBranchHead(remote, {
    session: operationSession, observation: observedAuthority
  });
  if (!approvedHead.exists) {
    await ensureConfigurationBranch(remote, {
      remoteSession: operationSession, observedHead: approvedHead, env: operationSession.env
    });
  }
  const baseBranch = CONFIGURATION_BRANCH;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-lead-'));
  try {
    const transport = frozenRemoteTransport(remote, {
      push: true, env: operationSession.env
    });
    const clone = (filtered) => runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      ...(filtered ? ['--filter=blob:none'] : []), '--branch', baseBranch,
      transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    let cloned = await clone(true);
    const partial = partialCloneFallbackDecision(cloned, {
      configured: cloned.status === 0
        ? partialCloneConfigured(scratch, 'origin', (args, options) => run('git', args, {
            ...options, env: transport.env
          }))
        : null,
      fallback: 'full'
    });
    if (partial.action === 'retry-full') {
      await removeTemporaryTree(scratch);
      await mkdir(scratch, { recursive: true });
      cloned = await clone(false);
    }
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${sanitizeRemote(remote)}'. Correct Git access, then retry the same capability proposal.`, {
          code: 'CAPABILITY_AUTHORITY_UNAVAILABLE',
          details: capabilityRecovery({
            stage: 'proposal', state: 'authority-unavailable', remote,
            nextAction: { command: `singularity-flow capability organisation ${quoted(commandRemote(remote))} --refresh --json`, skill: '/sf-capability-map' },
            preserved: ['approved-configuration', 'application-branches']
          })
        });
    }

    const baseCommit = run('git', ['rev-parse', 'HEAD'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    const result = await mutate(scratch, baseBranch, operationSession, observedAuthority);

    const staged = run('git', ['add', '-A'], {
      cwd: scratch, env: transport.env, allowFailure: true
    });
    if (staged.status !== 0) throw new SingularityFlowError('Could not stage the change.');
    if (!run('git', ['diff', '--cached', '--name-only'], {
      cwd: scratch, env: transport.env
    }).stdout.trim()) {
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
    run('git', ['switch', '--quiet', '-c', reviewBranch], {
      cwd: scratch, env: transport.env
    });

    const actor = gitCommitIdentity(scratch, { env: transport.env });
    run('git', ['-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', message], { cwd: scratch, env: transport.env });
    const commit = run('git', ['rev-parse', 'HEAD'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();

    // Pushed here rather than left for later: the temporary checkout is about to be deleted, so a
    // commit that is not pushed is a commit that never existed. This deliberately targets only a
    // new review branch. The approved configuration and orphan state branches remain unchanged.
    const pushed = await runRemoteGitAsync([
      'push', '--porcelain', `--force-with-lease=refs/heads/${reviewBranch}:`, 'origin',
      `HEAD:refs/heads/${reviewBranch}`
    ], { cwd: scratch, operation: 'remote-push', env: transport.env });
    const diagnostic = `${pushed.stderr ?? ''}\n${pushed.stdout ?? ''}`;
    const duplicateProposal = () => new SingularityFlowError(
      `Review branch '${reviewBranch}' already exists on '${sanitizeRemote(remote)}'. The existing proposal was preserved; review and activate it instead of creating a competing proposal.`, {
        code: 'CAPABILITY_PROPOSAL_ALREADY_EXISTS',
        details: capabilityRecovery({
          stage: 'proposal', state: 'proposal-already-exists', remote, branch: reviewBranch,
          nextAction: { command: capabilityCommand('proposal', { remote, branch: reviewBranch }), skill: '/sf-capability-map' },
          preserved: ['existing-proposal', 'approved-configuration', 'application-branches']
        })
      });
    // When the independently authored commit is byte-identical, Git reports an existing ref as
    // "up to date" without evaluating the lease because no ref movement is required. It is still
    // a duplicate proposal from the caller's perspective and must point back to the preserved one.
    if (pushed.status === 0 && /up[ -]to[ -]date|everything up-to-date/i.test(diagnostic)) {
      throw duplicateProposal();
    }
    if (pushed.status !== 0) {
      if (/stale info|already exists|fetch first|non-fast-forward|reference already exists/i.test(diagnostic)) {
        throw duplicateProposal();
      }
      throw new SingularityFlowError(
        `The capability proposal could not be pushed to '${sanitizeRemote(remote)}'. No authority branch changed. ${pushed.failure?.advice ?? 'Correct Git write access and retry the same mapping command.'}`, {
          code: 'CAPABILITY_PROPOSAL_PUSH_FAILED',
          details: capabilityRecovery({
            stage: 'proposal', state: 'proposal-not-published', remote,
            nextAction: { command: `singularity-flow capability organisation ${quoted(commandRemote(remote))} --refresh --json`, skill: '/sf-capability-map' },
            preserved: ['approved-configuration', 'application-branches']
          })
        });
    }
    return {
      ...result, changed: true, pushed: true, commit,
      branch: reviewBranch, baseBranch, baseCommit, reviewRequired: true
    };
  } finally {
    await removeTemporaryTree(scratch);
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
function selectedDefaultBranch(observed) {
  return observed.defaultBranch
    ?? observed.branches.find((branch) => branch === 'main' || branch === 'master')
    ?? observed.branches[0]
    ?? null;
}

async function observedDefaultBranchAsync(url, session, observation = null) {
  const observed = observation ?? await session.observeAsync(url, { includeHead: true });
  requireRemoteObservation(observed, `capability repository '${sanitizeRemote(url)}'`);
  if (observed.defaultBranch) return observed.defaultBranch;
  const fallback = await session.observeAsync(url, { includeHead: true, includeAllHeads: true });
  requireRemoteObservation(fallback, `capability repository '${sanitizeRemote(url)}'`);
  const branch = selectedDefaultBranch(fallback);
  if (branch) return branch;
  throw new SingularityFlowError(
    `Capability repository '${sanitizeRemote(url)}' has no advertised default or application branch. Create and publish its initial branch before mapping it.`, {
      code: 'CAPABILITY_REPOSITORY_DEFAULT_BRANCH_UNKNOWN',
      details: { remote: sanitizeRemote(url), recoverable: true }
    }
  );
}

async function leadApplicationBranch(root, url, session = new GitRemoteSession(), observation = null) {
  const file = path.join(root, PORTFOLIO_PATH);
  if (existsSync(file)) {
    const declared = YAML.parse(await readFile(file, 'utf8'))
      ?.repositories?.[repositoryIdFromUrl(url)]?.defaultBranch;
    const branch = typeof declared === 'string' ? declared.trim() : '';
    if (branch && branch !== CONFIGURATION_BRANCH) return branch;
  }
  return observedDefaultBranchAsync(url, session, observation);
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
async function repairLeadDefaultBranch(
  root, url, session = new GitRemoteSession(), observation = null
) {
  const file = path.join(root, PORTFOLIO_PATH);
  if (!existsSync(file)) return;
  const id = repositoryIdFromUrl(url);
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  if (String(document.getIn(['repositories', id, 'defaultBranch']) ?? '') !== CONFIGURATION_BRANCH) return;
  document.setIn(['repositories', id, 'defaultBranch'], await observedDefaultBranchAsync(
    url, session, observation
  ));
  await writeFile(file, document.toString(YAML_OUTPUT), 'utf8');
}

function configurationAssetsFromRef(root, ref = 'HEAD', { env = process.env } = {}) {
  return configurationTreeEntries(root, ref, null, { env });
}

function configurationAssetsMatch(stateAssets, configuredAssets, configuredPaths) {
  const statePaths = Object.keys(stateAssets ?? {}).sort();
  if (JSON.stringify(statePaths) !== JSON.stringify([...configuredPaths].sort())) return false;
  return statePaths.every((relative) => {
    const state = stateAssets[relative];
    const configured = configuredAssets.get(relative);
    return configured && state.object === configured.object && state.mode === configured.mode;
  });
}

async function loadCapabilityStateSnapshot(remote, branch, commit, { env = process.env } = {}) {
  const gitEnv = enterpriseGitEnvironment(env);
  if (branch === STATE_CONFIGURATION_BRANCH) {
    return loadStoryConfigurationSnapshot({
      remote, branch, commit, source: 'verified-state-mirror'
    }, { env: gitEnv });
  }
  // Ledger branches are configurable. The Story snapshot reader intentionally recognizes only the
  // product's canonical `state` authority, so verify an explicitly configured alternative here with
  // the same complete-file, digest, Git-identity, source-commit, and operational-definition gates.
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-read-custom-state-'));
  try {
    const transport = frozenRemoteTransport(remote, { env: gitEnv });
    const clone = (filtered) => runRemoteGitAsync([
      '-c', 'core.autocrlf=false', 'clone', '--quiet', '--no-local', '--no-tags', '--single-branch',
      '--depth', '1', ...(filtered ? ['--filter=blob:none'] : []),
      '--branch', branch, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    let cloned = await clone(true);
    const partial = partialCloneFallbackDecision(cloned, {
      configured: cloned.status === 0
        ? partialCloneConfigured(scratch, 'origin', (args, options) => run('git', args, {
            ...options, env: transport.env
          }))
        : null,
      fallback: 'full'
    });
    if (partial.action === 'retry-full') {
      await removeTemporaryTree(scratch);
      await mkdir(scratch, { recursive: true });
      cloned = await clone(false);
    }
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read configured state branch '${branch}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`,
        { code: cloned.failure?.code ?? 'REMOTE_UNKNOWN' }
      );
    }
    const observedCommit = run('git', ['rev-parse', 'HEAD'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    if (observedCommit !== commit) {
      throw new SingularityFlowError(
        `Configured state branch '${branch}' moved from ${commit} to ${observedCommit} while it was being verified.`
      );
    }
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(scratch, STATE_CONFIGURATION_MANIFEST), 'utf8'));
    } catch (error) {
      throw new SingularityFlowError(`State configuration manifest is unreadable: ${error.message}`);
    }
    if (manifest?.format !== STATE_CONFIGURATION_FORMAT || manifest?.layout !== 'canonical-paths'
      || manifest?.source?.branch !== CONFIGURATION_BRANCH
      || !/^[0-9a-f]{40,64}$/.test(manifest?.source?.commit ?? '')
      || !manifest?.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)
      || !manifest?.assets || typeof manifest.assets !== 'object' || Array.isArray(manifest.assets)) {
      throw new SingularityFlowError(
        `State configuration manifest must be ${STATE_CONFIGURATION_FORMAT} with canonical files, Git identities, and an exact ${CONFIGURATION_BRANCH} source.`
      );
    }
    if (manifest.history != null
      && (manifest.history?.branch !== stateConfigurationHistoryBranch(manifest.source.commit)
        || manifest.history?.commit !== manifest.source.commit)) {
      throw new SingularityFlowError(
        'State configuration manifest contains an invalid immutable history authority.'
      );
    }
    const paths = await configurationAssetPaths(scratch);
    const declared = Object.keys(manifest.files).sort();
    if (JSON.stringify(paths) !== JSON.stringify(declared)
      || JSON.stringify(Object.keys(manifest.assets).sort()) !== JSON.stringify(declared)) {
      throw new SingularityFlowError('State configuration mirror files do not exactly match its manifest.');
    }
    const canonical = await canonicalConfigurationAssets(scratch, paths, { env: transport.env });
    for (const relative of paths) {
      const asset = canonical.get(relative);
      const declaredAsset = manifest.assets[relative];
      if (manifest.files[relative] !== asset.sha256
        || declaredAsset?.sha256 !== asset.sha256
        || declaredAsset?.object !== asset.object
        || declaredAsset?.mode !== asset.mode) {
        throw new SingularityFlowError(
          `State configuration mirror identity does not match for '${relative}'.`
        );
      }
    }
    await loadDefinition(scratch);
    return {
      observedCommit,
      sourceCommit: manifest.source.commit,
      assets: paths.map((relative) => {
        const asset = canonical.get(relative);
        return {
          relative, contents: asset.contents, sha256: asset.sha256,
          object: asset.object, gitMode: asset.mode
        };
      })
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** Read and completely verify the state-branch configuration mirror without moving a checkout. */
async function capabilityMapFromState(remote, branch = 'state', {
  env = process.env, session = null
} = {}) {
  const gitEnv = enterpriseGitEnvironment(env);
  const operationSession = session ?? new GitRemoteSession({ env: gitEnv });
  const observed = await operationSession.observeAsync(remote, {
    includeHead: false, refs: [`refs/heads/${branch}`]
  });
  if (!observed.ok) {
    return {
      invalid: true, branch, commit: null,
      error: `State configuration could not be read. ${observed.failure?.advice ?? 'Git remote access failed.'}`
    };
  }
  const commit = observed.refs.get(`refs/heads/${branch}`) ?? null;
  if (!commit) return null;
  try {
    const snapshot = await loadCapabilityStateSnapshot(remote, branch, commit, { env: gitEnv });
    const capability = snapshot.assets.find((entry) => entry.relative === CAPABILITIES_PATH);
    if (!capability) {
      return { invalid: true, branch, commit, error: `State configuration is missing ${CAPABILITIES_PATH}.` };
    }
    return {
      text: capability.contents.toString('utf8'),
      commit: snapshot.observedCommit,
      configurationCommit: snapshot.sourceCommit,
      assets: Object.fromEntries(snapshot.assets.map((entry) => [entry.relative, {
        sha256: entry.sha256, object: entry.object, mode: entry.gitMode
      }])),
      branch,
      invalid: false
    };
  } catch (error) {
    return {
      invalid: true, branch, commit,
      error: redactDiagnosticText(error?.message ?? String(error))
    };
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
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.', {
    code: 'CAPABILITY_LEAD_REQUIRED',
    details: capabilityRecovery({
      stage: 'organisation-read', state: 'input-refused', recoverable: true,
      nextAction: { command: 'singularity-flow capability leads --json', skill: '/sf-capability-map' }
    })
  });
  const branch = CONFIGURATION_BRANCH;
  const cached = await readOrganisationCache(remote);
  // Build one sanitized enterprise environment for this complete authority read. Reusing it for
  // the observation, clone, state projection and local object reads both prevents ambient Git
  // selectors from redirecting the operation and avoids repeating system/global config probes.
  const gitEnv = enterpriseGitEnvironment();
  const session = new GitRemoteSession({ env: gitEnv });
  // A current state projection is a separately moving remote ref. Include the cached projection
  // source in the same bounded observation as sflow/config so an unchanged configuration tip can
  // never make a later state publication look current forever.
  const cachedSourceBranch = String(cached?.organisation?.sourceBranch ?? '').trim();
  const observedBranches = [CONFIGURATION_BRANCH];
  if (isGitRefName(cachedSourceBranch) && cachedSourceBranch !== CONFIGURATION_BRANCH) {
    observedBranches.push(cachedSourceBranch);
  }
  const configurationObservation = await session.observeAsync(remote, {
    includeHead: false, refs: observedBranches.map((name) => `refs/heads/${name}`)
  });
  const tip = configurationBranchHead(remote, {
    session, observation: configurationObservation
  });
  if (!tip.reachable) {
    const remoteFailure = publicRemoteFailure(tip.observation?.failure);
    if (cached) {
      return {
        ...cached.organisation,
        cached: true,
        stale: true,
        cacheAgeMs: cacheAgeMs(cached),
        remoteError: tip.error || 'remote is unreachable',
        remoteFailure
      };
    }
    throw new SingularityFlowError(
      `Cannot read '${sanitizeRemote(remote)}': ${redactDiagnosticText(tip.error || 'the remote is unreachable and no cached organisation is available.')}`,
      {
        code: 'CAPABILITY_AUTHORITY_UNAVAILABLE',
        details: {
          ...capabilityRecovery({
            stage: 'organisation-read', state: 'authority-unavailable', remote,
            nextAction: { command: `singularity-flow capability organisation ${quoted(commandRemote(remote))} --refresh --json`, skill: '/sf-capability-map' },
            preserved: ['lead-registry', 'validated-organisation-cache']
          }),
          remoteFailure,
          diagnosticAction: {
            command: `singularity-flow workspace doctor --network --repository ${quoted(commandRemote(remote))} --json`,
            skill: '/sf-capability-map'
          }
        }
      }
    );
  }
  if (!tip.exists) {
    const empty = {
      url: remote, branch, configurationBranch: branch, configurationCommit: null,
      sourceBranch: null, sourceCommit: null,
      capabilities: [], repositories: {}, governed: false
    };
    await writeOrganisationCache(remote, null, empty);
    return { ...empty, cached: false, stale: false, cacheAgeMs: 0, remoteError: null };
  }
  // Older cache records predate complete state-mirror verification. Refresh them once instead of
  // preserving a capability-only projection verdict indefinitely under an unchanged config tip.
  const cachedSourceStillCurrent = !cachedSourceBranch
    || cachedSourceBranch === CONFIGURATION_BRANCH
    || (isGitRefName(cachedSourceBranch)
      && configurationObservation.refs.get(`refs/heads/${cachedSourceBranch}`)
        === cached?.organisation?.sourceCommit);
  if (!refresh && cached?.tipSha === tip.sha && cached.organisation?.stateProjection
      && cachedSourceStillCurrent) {
    return {
      ...cached.organisation,
      // Older cache records did not expose the configuration authority separately from the state
      // projection. The cache key is the freshly observed configuration tip, so it is safe to add
      // that exact binding without cloning again.
      configurationBranch: branch,
      configurationCommit: tip.sha,
      cached: true,
      stale: false,
      cacheAgeMs: cacheAgeMs(cached),
      remoteError: null
    };
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-read-'));
  try {
    const transport = frozenRemoteTransport(remote, { env: gitEnv });
    const clone = (filtered) => runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      ...(filtered ? ['--filter=blob:none'] : []),
      '--no-checkout', '--branch', branch, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    let cloned = await clone(true);
    const partial = partialCloneFallbackDecision(cloned, {
      configured: cloned.status === 0
        ? partialCloneConfigured(scratch, 'origin', (args, options) => run('git', args, {
            ...options, env: transport.env
          }))
        : null,
      fallback: 'full'
    });
    if (partial.action === 'retry-full') {
      await removeTemporaryTree(scratch);
      await mkdir(scratch, { recursive: true });
      cloned = await clone(false);
    }
    if (cloned.status !== 0) {
      const remoteFailure = publicRemoteFailure(cloned.failure);
      const diagnosis = remoteFailure
        ? `Git configuration clone failed (${remoteFailure.classification}). ${remoteFailure.advice}`
        : 'Git configuration clone failed. Correct Git access and retry.';
      throw new SingularityFlowError(
        `Cannot read '${sanitizeRemote(remote)}': ${diagnosis}`, {
          code: 'CAPABILITY_AUTHORITY_UNAVAILABLE',
          details: {
            ...capabilityRecovery({
              stage: 'organisation-read', state: 'authority-unavailable', remote,
              nextAction: { command: `singularity-flow capability organisation ${quoted(commandRemote(remote))} --refresh --json`, skill: '/sf-capability-map' },
              preserved: ['lead-registry', 'validated-organisation-cache']
            }),
            remoteFailure,
            diagnosticAction: {
              command: `singularity-flow workspace doctor --network --repository ${quoted(commandRemote(remote))} --json`,
              skill: '/sf-capability-map'
            }
          }
        });
    }
    // The authority can advance between the cache probe and this clone. Bind every comparison and
    // the resulting cache entry to the revision actually cloned; the next read will observe and
    // refresh again if the remote has already advanced beyond it.
    const configurationCommit = run('git', ['rev-parse', 'HEAD'], {
      cwd: scratch, env: transport.env
    }).stdout.trim();
    const configured = run('git', ['show', `HEAD:${CAPABILITIES_PATH}`], {
      cwd: scratch, allowFailure: true, env: transport.env
    });
    const workflow = run('git', ['show', `HEAD:${WORKFLOW_PATH}`], {
      cwd: scratch, allowFailure: true, env: transport.env
    });
    const stateBranch = workflow.status === 0
      ? (YAML.parse(workflow.stdout)?.ledger?.branch ?? 'state')
      : 'state';
    const state = configured.status === 0
      ? await capabilityMapFromState(remote, stateBranch, { env: gitEnv, session }) : null;
    const configuredAssets = configured.status === 0
      ? configurationAssetsFromRef(scratch, 'HEAD', { env: transport.env }) : new Map();
    const configuredPaths = [...configuredAssets.keys()].sort();
    // The state branch is a mirror, never a second authority. An interrupted projection may leave
    // it behind `sflow/config`; in that case read the approved bytes rather than presenting stale
    // mirror contents as fresh merely because the capability file happens to match.
    const currentState = state && !state.invalid
      && state.configurationCommit === configurationCommit
      && state.text === configured.stdout
      && configurationAssetsMatch(state.assets, configuredAssets, configuredPaths)
      ? state : null;
    const sameSourceButDifferentAssets = state && !state.invalid
      && state.configurationCommit === configurationCommit && !currentState;
    const stateProjection = currentState
      ? { status: 'current', branch: currentState.branch, commit: currentState.commit, error: null }
      : state?.invalid
        ? { status: 'invalid', branch: state.branch, commit: state.commit, error: state.error }
        : sameSourceButDifferentAssets
          ? {
              status: 'invalid', branch: state.branch, commit: state.commit,
              error: `State configuration claims ${CONFIGURATION_BRANCH}@${configurationCommit}, but its complete asset set does not match that approved commit.`
            }
        : state
          ? { status: 'stale', branch: state.branch, commit: state.commit, error: null }
          : { status: 'missing', branch: stateBranch, commit: null, error: null };
    const shown = currentState ?? (configured.status === 0
      ? { text: configured.stdout, commit: configurationCommit, branch }
      : null);
    if (!shown) {
      const empty = {
        url: remote, branch, configurationBranch: branch, configurationCommit,
        sourceBranch: null, sourceCommit: configurationCommit,
        capabilities: [], repositories: {}, governed: false, stateProjection
      };
      await writeOrganisationCache(remote, configurationCommit, empty);
      return { ...empty, cached: false, stale: false, cacheAgeMs: 0, remoteError: null };
    }

    const definition = validateCapabilities(YAML.parse(shown.text));
    const portfolio = run('git', ['show', `HEAD:${PORTFOLIO_PATH}`], {
      cwd: scratch, allowFailure: true, env: transport.env
    });
    const organisation = {
      url: remote,
      branch,
      configurationBranch: branch,
      configurationCommit,
      sourceBranch: shown.branch,
      sourceCommit: shown.commit,
      stateProjection,
      capabilities: capabilityTree(definition),
      repositories: portfolio.status === 0 ? (YAML.parse(portfolio.stdout)?.repositories ?? {}) : {},
      governed: true
    };
    await writeOrganisationCache(remote, configurationCommit, organisation);
    return {
      ...organisation,
      cached: false,
      stale: false,
      cacheAgeMs: 0,
      remoteError: null
    };
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/**
 * Locate an exact, credential-free repository URL in the approved maps this machine knows about.
 *
 * This is deliberately a read: it neither remembers a lead nor prepares a proposal. Callers can
 * therefore use it as the first step of onboarding without making the answer change underneath
 * the question. Literal URL equality is intentional here. Treating two independently supplied
 * transports as the same authority needs stronger proof than a convenient basename or a lossy
 * SSH/HTTPS rewrite.
 */
function registeredLeadDiagnosticReference(value) {
  return `registered-lead:sha256:${createHash('sha256')
    .update(String(value ?? '').trim()).digest('hex').slice(0, 16)}`;
}

/** Preserve only the closed-vocabulary diagnosis and content-free correlation evidence. */
function publicRemoteFailure(failure) {
  if (!failure || typeof failure !== 'object') return null;
  const rawEvidence = failure.evidence && typeof failure.evidence === 'object'
    ? failure.evidence : null;
  const evidence = rawEvidence ? {
    exitCode: Number.isInteger(rawEvidence.exitCode) ? rawEvidence.exitCode : null,
    signal: typeof rawEvidence.signal === 'string' ? rawEvidence.signal : null,
    timedOut: rawEvidence.timedOut === true,
    blocked: rawEvidence.blocked === true,
    diagnosticSha256: /^[a-f0-9]{64}$/.test(String(rawEvidence.diagnosticSha256 ?? ''))
      ? String(rawEvidence.diagnosticSha256) : null,
    diagnosticBytes: Number.isInteger(rawEvidence.diagnosticBytes)
      && rawEvidence.diagnosticBytes >= 0 ? rawEvidence.diagnosticBytes : null
  } : null;
  return {
    code: String(failure.code ?? 'REMOTE_UNKNOWN'),
    classification: String(failure.classification ?? 'unknown'),
    retryable: failure.retryable === true,
    advice: redactDiagnosticText(failure.advice ?? 'Inspect Git access and retry.'),
    evidence
  };
}

function registeredLeadFailure(value, error) {
  const reference = registeredLeadDiagnosticReference(value);
  let message = redactDiagnosticText(error?.message ?? String(error));
  for (const candidate of [String(value ?? '').trim(), sanitizeRemote(value)]) {
    if (candidate) message = message.replaceAll(candidate, reference);
  }
  return {
    lead: reference,
    code: error?.code ?? 'CAPABILITY_LEAD_INVALID',
    message: message || 'A registered capability authority could not be inspected.'
  };
}

function proposalTransportFailuresForInspection(proposals, lead) {
  const unique = new Map();
  for (const proposal of proposals ?? []) {
    const failure = proposal?.failure;
    const remoteFailure = publicRemoteFailure(failure?.remoteFailure);
    const diagnosticAction = failure?.diagnosticAction ?? null;
    if (!remoteFailure && !diagnosticAction?.command) continue;
    const row = {
      lead: sanitizeRemote(lead),
      code: failure?.code ?? remoteFailure?.code ?? 'CAPABILITY_PROPOSAL_INSPECTION_INCOMPLETE',
      classification: failure?.classification ?? remoteFailure?.classification ?? null,
      retryable: failure?.retryable === true || remoteFailure?.retryable === true,
      evidence: failure?.evidence ?? remoteFailure?.evidence ?? null,
      diagnosticAction,
      message: redactDiagnosticText(failure?.message
        ?? remoteFailure?.advice
        ?? 'Capability proposal transport could not be inspected.')
    };
    const key = JSON.stringify([
      row.code, row.classification, row.evidence?.diagnosticSha256 ?? null,
      row.diagnosticAction?.command ?? null
    ]);
    if (!unique.has(key)) unique.set(key, row);
  }
  return [...unique.values()];
}

export async function inspectCapabilityRepository(repositoryUrl, {
  leadUrl = null, leadUrls = [], refresh = false,
  proposalRemoteCommand = runRemoteGitAsync
} = {}) {
  const repository = assertCredentialFreeRemote(repositoryUrl);
  const suppliedLeads = [...(leadUrl == null ? [] : [leadUrl]), ...leadUrls]
    .map((url) => assertCredentialFreeRemote(url));
  const registeredLeads = [];
  const registeredLeadFailures = [];
  if (!suppliedLeads.length) {
    for (const entry of await listLeadRepositoryRegistryRecords()) {
      const candidate = String(entry?.url ?? '').trim();
      if (!candidate) continue;
      try {
        const safe = assertCredentialFreeRemote(candidate);
        if (!registeredLeads.includes(safe)) registeredLeads.push(safe);
      } catch (error) {
        registeredLeadFailures.push(registeredLeadFailure(candidate, error));
      }
    }
  }
  // On a new laptop the target itself may be the lead authority. Probe it once so an existing
  // self-hosted map is still discovered. A reachable repository with no sflow/config is only a
  // candidate, not proof that no other organisation map names it; the UI asks before establishing
  // it as the first authority.
  const baseLeads = suppliedLeads.length ? [...new Set(suppliedLeads)] : registeredLeads;
  const repositoryCandidateOnly = baseLeads.length === 0;
  const repositoryCandidateAdded = !baseLeads.includes(repository);
  const authorityScope = suppliedLeads.length ? 'explicit'
    : repositoryCandidateOnly ? 'repository-candidate' : 'registered';
  const leads = repositoryCandidateAdded ? [...baseLeads, repository] : baseLeads;

  const inspected = await mapLimit(leads, Math.max(1, Math.min(4, leads.length)), async (url) => {
    try {
      const organisation = await readOrganisation(url, { refresh });
      const repositoryEntries = Object.entries(organisation.repositories ?? {})
        .filter(([, value]) => value?.url === repository);
      const rows = flattenTree(organisation.capabilities ?? []);
      const matches = repositoryEntries.map(([repositoryId, declaration]) => ({
        lead: url,
        repositoryId,
        repositoryUrl: declaration.url,
        capabilities: rows
          .filter((capability) => (capability.repositories ?? []).includes(repositoryId))
          .map((capability) => capability.id),
        governed: organisation.governed,
        sourceBranch: organisation.sourceBranch ?? null,
        sourceCommit: organisation.sourceCommit ?? null,
        cached: Boolean(organisation.cached),
        stale: Boolean(organisation.stale)
      }));
      // A cached positive match is useful conservative evidence: it prevents a duplicate while the
      // authority is offline. Cached absence is not proof of absence, however. Represent the stale
      // read as an incomplete authority check so callers cannot turn an outage into a new mapping.
      const failureLead = sanitizeRemote(url);
      const staleRemoteFailure = publicRemoteFailure(organisation.remoteFailure);
      const failure = organisation.stale ? {
        lead: failureLead,
        code: 'CAPABILITY_AUTHORITY_STALE_CACHE',
        classification: staleRemoteFailure?.classification ?? 'unknown',
        retryable: staleRemoteFailure?.retryable ?? false,
        evidence: staleRemoteFailure?.evidence ?? null,
        diagnosticAction: {
          command: `singularity-flow workspace doctor --network --repository ${quoted(commandRemote(url))} --json`,
          skill: '/sf-capability-map'
        },
        message: `The approved capability map for '${failureLead}' could not be refreshed; the last validated cache was inspected.`
      } : null;
      let pendingProposals = [];
      let proposalCoverage = organisation.stale ? 'not-checked' : 'complete';
      let proposalFailure = null;
      let proposalTransportFailures = [];
      let proposalInspection = { total: 0, inspected: 0 };
      // The first capability itself can still be waiting on a proposal before the approved
      // configuration branch exists, so even an otherwise ungoverned target must be checked.
      if (!organisation.stale) {
        try {
          const catalog = await listCapabilityProposals(url, {
            includeDiff: false,
            repositoryUrl: repository,
            maximumProposals: CAPABILITY_INSPECTION_MAX_PROPOSALS,
            withCoverage: true,
            runRemoteCommand: proposalRemoteCommand
          });
          pendingProposals = catalog.proposals;
          proposalTransportFailures = proposalTransportFailuresForInspection(
            catalog.proposals, url
          );
          proposalInspection = {
            total: catalog.coverage.total,
            inspected: catalog.coverage.inspected
          };
          proposalCoverage = catalog.coverage.status === 'complete'
            && catalog.proposals.every((proposal) => proposal.repositoryInspectionComplete !== false)
            ? 'complete' : 'partial';
        } catch (error) {
          const remoteFailure = publicRemoteFailure(error?.details?.remoteFailure);
          proposalCoverage = 'not-checked';
          proposalFailure = {
            lead: sanitizeRemote(url),
            code: error?.code ?? 'CAPABILITY_PROPOSAL_INSPECTION_INCOMPLETE',
            classification: remoteFailure?.classification ?? null,
            retryable: remoteFailure?.retryable ?? false,
            evidence: remoteFailure?.evidence ?? null,
            diagnosticAction: error?.details?.diagnosticAction ?? null,
            message: redactDiagnosticText(error?.message ?? String(error))
          };
        }
      }
      const pendingMatches = pendingProposals.flatMap((proposal) =>
        (proposal.repositoryMatches ?? []).map((match) => ({
          lead: sanitizeRemote(url),
          repositoryId: match.repositoryId,
          repositoryUrl: match.repositoryUrl,
          capabilities: match.capabilities,
          capabilityMetadataComplete: match.capabilityMetadataComplete,
          proposalBranch: proposal.branch,
          proposalCommit: proposal.proposalCommit,
          proposalStatus: proposal.status,
          proposalValid: proposal.valid === true
        })));
      return {
        lead: url, matches, pendingMatches, failure, proposalFailure,
        proposalTransportFailures, proposalCoverage,
        proposalChecked: !organisation.stale,
        proposalInspection, stale: Boolean(organisation.stale),
        governed: Boolean(organisation.governed),
        candidate: repositoryCandidateAdded && url === repository
      };
    } catch (error) {
      const remoteFailure = publicRemoteFailure(error?.details?.remoteFailure);
      return {
        lead: url, matches: [], pendingMatches: [], stale: false, governed: false,
        proposalCoverage: 'not-checked', proposalChecked: false,
        proposalInspection: { total: 0, inspected: 0 },
        candidate: repositoryCandidateAdded && url === repository,
        failure: {
          lead: sanitizeRemote(url), code: error?.code ?? null,
          classification: remoteFailure?.classification ?? null,
          retryable: remoteFailure?.retryable ?? false,
          evidence: remoteFailure?.evidence ?? null,
          diagnosticAction: error?.details?.diagnosticAction ?? null,
          message: redactDiagnosticText(error?.message ?? String(error))
        },
        proposalFailure: null, proposalTransportFailures: []
      };
    }
  });
  const matches = inspected.flatMap((entry) => entry.matches);
  const pendingMatches = inspected.flatMap((entry) => entry.pendingMatches ?? []);
  const failures = [
    ...registeredLeadFailures,
    ...inspected.flatMap((entry) => [
      entry.failure, entry.proposalFailure, ...(entry.proposalTransportFailures ?? [])
    ]).filter(Boolean)
  ];
  const checkedLeads = inspected
    .filter((entry) => !entry.failure && (!entry.candidate || entry.governed))
    .map((entry) => entry.lead);
  const candidateLeads = inspected
    .filter((entry) => entry.candidate && !entry.failure && !entry.governed)
    .map((entry) => entry.lead);
  const staleLeads = inspected.filter((entry) => entry.stale).map((entry) => entry.lead);
  const ungovernedCandidate = repositoryCandidateOnly && candidateLeads.length > 0;
  const proposalCoverage = inspected.length === 0 ? 'not-checked'
    : inspected.every((entry) => entry.proposalCoverage === 'complete')
      ? 'complete'
      : inspected.some((entry) => entry.proposalChecked) ? 'partial' : 'not-checked';
  const proposalInspection = inspected.reduce((summary, entry) => ({
    total: summary.total + (entry.proposalInspection?.total ?? 0),
    inspected: summary.inspected + (entry.proposalInspection?.inspected ?? 0)
  }), { total: 0, inspected: 0 });
  const proposalInspectionIncomplete = proposalCoverage !== 'complete';
  const noAuthoritiesConfirmed = ungovernedCandidate && registeredLeadFailures.length === 0;
  const status = pendingMatches.length
    ? 'inconclusive'
    : matches.length > 1
      ? 'ambiguous'
      : matches.length === 1
        ? (matches[0].capabilities.length ? 'already-mapped' : 'known-repository-unassigned')
      : proposalInspectionIncomplete
        ? 'inconclusive'
      : ungovernedCandidate
        ? 'inconclusive'
        : checkedLeads.length === 0
        ? (staleLeads.length || candidateLeads.length ? 'inconclusive' : 'unreachable')
        : failures.length
          ? 'inconclusive'
          : 'not-onboarded';
  return {
    status, repositoryUrl: repository, matches, pendingMatches,
    checkedLeads, candidateLeads, staleLeads, failures,
    authorityScope,
    completeness: noAuthoritiesConfirmed ? 'no-authorities'
      : failures.length || proposalInspectionIncomplete
        ? (checkedLeads.length ? 'partial' : 'none') : 'complete',
    proposalCoverage,
    proposalInspection: {
      ...proposalInspection,
      limitPerAuthority: CAPABILITY_INSPECTION_MAX_PROPOSALS
    }
  };
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
  clone = null,
  jiraProject = null,
  teams = []
} = {}) {
  if (!capabilityId) throw new SingularityFlowError('A capability identifier is required. Use a lower-case kebab-case ID; nothing was changed.', {
    code: 'CAPABILITY_ID_REQUIRED',
    details: capabilityRecovery({
      stage: 'proposal', state: 'input-refused', remote: leadUrl, recoverable: true,
      nextAction: { command: `singularity-flow capability map <lower-case-kebab-id> --lead ${quoted(commandRemote(leadUrl))} --json`, skill: '/sf-capability-map' },
      preserved: ['approved-configuration', 'application-branches']
    })
  });
  if (!String(leadUrl ?? '').trim()) throw new SingularityFlowError('A lead repository URL is required.', {
    code: 'CAPABILITY_LEAD_REQUIRED',
    details: capabilityRecovery({
      stage: 'proposal', state: 'input-refused', recoverable: true,
      nextAction: { command: 'singularity-flow capability leads --json', skill: '/sf-capability-map' }
    })
  });
  const cloneStrategy = clone == null
    ? null
    : normalizeCloneStrategy(clone, `Capability '${capabilityId}' clone strategy`);
  // Prove every delivery repository before initializing or changing the lead authority. A failed
  // first mapping must not create `sflow/config`, and a reachable but empty remote must not be
  // silently recorded as `main`. Reuse this operation-scoped session throughout the proposal so
  // the successful probes are not repeated across office proxies.
  const urls = [...new Map([...(repositoryUrl ? [repositoryUrl] : []), ...repositoryUrls]
    .map((url) => {
      const exact = assertCredentialFreeRemote(url);
      return [exact, exact];
    })).values()];
  const remoteSession = new GitRemoteSession({ env: enterpriseGitEnvironment() });
  const leadKey = assertCredentialFreeRemote(leadUrl);
  const deliveryKeys = new Set(urls);
  const probeTargets = new Map([[leadKey, leadKey], ...urls.map((url) => [url, url])]);
  const observedEntries = await mapLimit(
    [...probeTargets], Math.max(1, Math.min(4, probeTargets.size)),
    async ([key, url]) => {
      const observation = await remoteSession.observeAsync(url, {
        includeHead: true,
        refs: key === leadKey ? [`refs/heads/${CONFIGURATION_BRANCH}`] : []
      });
      requireRemoteObservation(observation, key === leadKey
        ? `capability authority '${sanitizeRemote(url)}'`
        : `capability repository '${sanitizeRemote(url)}'`);
      const defaultBranch = deliveryKeys.has(key)
        ? await observedDefaultBranchAsync(url, remoteSession, observation)
        : null;
      return [key, { observation, defaultBranch }];
    }
  );
  const remoteObservations = new Map(observedEntries);
  const observedBranches = new Map([...remoteObservations]
    .filter(([key]) => deliveryKeys.has(key))
    .map(([key, value]) => [key, value.defaultBranch]));
  const authorityObservation = remoteObservations.get(leadKey)?.observation ?? null;

  return withLeadCheckout(leadKey, `Map capability ${capabilityId}`,
    `capability/map-${capabilityId}`, async (
      root, _baseBranch, leadRemoteSession, leadAuthorityObservation
    ) => {
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
        root, repositoryIdFromUrl(leadKey), leadKey,
        await leadApplicationBranch(
          root, leadKey, leadRemoteSession, leadAuthorityObservation
        ), gitCommitIdentity(root));
      // The orphan branch is named in the definition here. It is not published until this proposal
      // is reviewed and merged; unreviewed configuration must never become an authoritative mirror.
      await enableLedger(root, 'state');
    }
    await repairLeadDefaultBranch(
      root, leadKey, leadRemoteSession, leadAuthorityObservation
    );

    // Every repository this capability ships from, declared in the portfolio so the capability may
    // name them. A capability commonly has one; a product with a web app and a service has two.
    const effectiveKind = kind ?? (urls.length ? 'delivery' : 'collection');
    const repositoryIds = [];
    if (urls.length) {
      const file = path.join(root, PORTFOLIO_PATH);
      const portfolio = YAML.parseDocument(await readFile(file, 'utf8'));
      for (const url of urls) {
        const id = repositoryIdOf(url);
        repositoryIds.push(id);
        const branch = observedBranches.get(url);
        const existing = portfolio.getIn(['repositories', id], true)?.toJSON?.() ?? {};
        if (existing.url && existing.url !== url) {
          throw new SingularityFlowError(
            `Repository identifier '${id}' is already assigned to '${sanitizeRemote(existing.url)}'; it cannot also identify '${sanitizeRemote(url)}'. Nothing was changed.`, {
              code: 'CAPABILITY_REPOSITORY_ID_COLLISION',
              details: capabilityRecovery({
                stage: 'proposal', state: 'repository-id-collision', remote: leadKey,
                preserved: ['approved-configuration', 'application-branches']
              })
            });
        }
        const repository = { ...existing, url, defaultBranch: branch, required: true };
        if (cloneStrategy) {
          if (cloneStrategy.mode === 'full') delete repository.clone;
          else repository.clone = cloneStrategy;
        }
        portfolio.setIn(['repositories', id], portfolio.createNode(repository));
      }
      await writeFile(file, portfolio.toString(YAML_OUTPUT), 'utf8');
    }
    const repositoryId = repositoryIds[0] ?? null;
    // The lead is where this capability's governed state and world model live, so with more than
    // one repository it has to be said rather than inferred from the order they were typed in.
    const leadRepositoryRemote = leadRepositoryUrl
      ? assertCredentialFreeRemote(leadRepositoryUrl) : null;
    const leadRepositoryId = leadRepositoryRemote ? repositoryIdOf(leadRepositoryRemote)
      : repositoryIds.length === 1 ? repositoryIds[0] : null;
    if (leadRepositoryRemote && !urls.includes(leadRepositoryRemote)) {
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
  }, { remoteSession, authorityObservation });
}

/** Add one shipping repository to an existing delivery capability as a reviewed proposal. */
export async function addCapabilityRepository(leadUrl, capabilityId, repositoryUrl, {
  makeLead = false, clone = null
} = {}) {
  if (!capabilityId) throw new SingularityFlowError('A capability identifier is required.');
  if (!repositoryUrl) throw new SingularityFlowError('A repository URL is required.');
  if (!String(leadUrl ?? '').trim()) throw new SingularityFlowError('A lead repository URL is required.', {
    code: 'CAPABILITY_LEAD_REQUIRED'
  });
  const cloneStrategy = clone == null ? null
    : normalizeCloneStrategy(clone, `Capability '${capabilityId}' repository clone strategy`);
  const remoteSession = new GitRemoteSession({ env: enterpriseGitEnvironment() });
  const leadKey = assertCredentialFreeRemote(leadUrl);
  const repositoryKey = assertCredentialFreeRemote(repositoryUrl);
  const targets = new Map([[leadKey, leadKey], [repositoryKey, repositoryKey]]);
  const observations = new Map(await mapLimit(
    [...targets], Math.max(1, Math.min(2, targets.size)), async ([key, url]) => {
      const observation = await remoteSession.observeAsync(url, {
        includeHead: true,
        refs: key === leadKey ? [`refs/heads/${CONFIGURATION_BRANCH}`] : []
      });
      requireRemoteObservation(observation, key === leadKey
        ? `capability authority '${sanitizeRemote(url)}'`
        : `capability repository '${sanitizeRemote(url)}'`);
      return [key, observation];
    }
  ));
  const defaultBranch = await observedDefaultBranchAsync(
    repositoryKey, remoteSession, observations.get(repositoryKey)
  );
  return withLeadCheckout(leadKey, `Add repository to capability ${capabilityId}`,
    `capability/repository-add-${capabilityId}`, async (root) => {
      assertGovernanceVisible(root);
      const capabilityFile = path.join(root, CAPABILITIES_PATH);
      const portfolioFile = path.join(root, PORTFOLIO_PATH);
      if (!existsSync(capabilityFile) || !existsSync(portfolioFile)) {
        throw new SingularityFlowError('The approved configuration has no capability map and portfolio to update.');
      }
      const capabilities = YAML.parseDocument(await readFile(capabilityFile, 'utf8'));
      const current = capabilities.getIn(['capabilities', capabilityId], true)?.toJSON?.();
      if (!current) throw new SingularityFlowError(`Unknown capability '${capabilityId}'.`);
      if (current.kind !== 'delivery') {
        throw new SingularityFlowError(
          `Capability '${capabilityId}' is a collection. Change it to delivery in a reviewed proposal before adding a repository.`);
      }
      const repositoryId = repositoryIdOf(repositoryKey);
      const portfolio = YAML.parseDocument(await readFile(portfolioFile, 'utf8'));
      const existingRepository = portfolio.getIn(['repositories', repositoryId], true)?.toJSON?.() ?? {};
      if (existingRepository.url && existingRepository.url !== repositoryKey) {
        throw new SingularityFlowError(
          `Repository identifier '${repositoryId}' is already assigned to '${sanitizeRemote(existingRepository.url)}'; it cannot also identify '${sanitizeRemote(repositoryKey)}'. Nothing was changed.`, {
            code: 'CAPABILITY_REPOSITORY_ID_COLLISION',
            details: capabilityRecovery({
              stage: 'proposal', state: 'repository-id-collision', remote: leadKey,
              preserved: ['approved-configuration', 'application-branches']
            })
          });
      }
      const repository = {
        ...existingRepository, url: repositoryKey, defaultBranch, required: true
      };
      if (cloneStrategy) {
        if (cloneStrategy.mode === 'full') delete repository.clone;
        else repository.clone = cloneStrategy;
      }
      portfolio.setIn(['repositories', repositoryId], portfolio.createNode(repository));

      const before = capabilityRepositories(current);
      const repositories = [...new Set([...before, repositoryId])];
      capabilities.deleteIn(['capabilities', capabilityId, 'repository']);
      capabilities.setIn(['capabilities', capabilityId, 'repositories'], repositories);
      const previousLead = current.leadRepository ?? (before.length === 1 ? before[0] : null);
      if (makeLead || previousLead) {
        capabilities.setIn(['capabilities', capabilityId, 'leadRepository'],
          makeLead ? repositoryId : previousLead);
      }
      const portfolioValue = portfolio.toJS();
      validateCapabilities(capabilities.toJS(), portfolioValue);
      await writeFile(portfolioFile, portfolio.toString(YAML_OUTPUT), 'utf8');
      await writeFile(capabilityFile, capabilities.toString(YAML_OUTPUT), 'utf8');
      return {
        capabilityId, repositoryId, repositories,
        leadRepositoryId: makeLead ? repositoryId : previousLead,
        state: { published: false, reason: 'awaiting review and merge' }
      };
    }, { remoteSession, authorityObservation: observations.get(leadKey) });
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
export async function publishCapabilityMap(root, {
  message = 'Publish the capability map', env = process.env
} = {}) {
  const file = path.join(root, CAPABILITIES_PATH);
  if (!existsSync(file)) return { published: false, reason: 'there is no capability map to publish' };
  const definition = await loadDefinition(root).catch(() => null);
  const ledger = definition?.ledger ?? null;
  // `enabled: false` is a decision this repository made, not a fault: it says the state branch is
  // not in use here, and publishing to a branch nobody reads would be noise.
  if (!ledger?.enabled) return { published: false, reason: 'the state branch is not enabled here' };
  if (ledger.publication === 'off') return { published: false, reason: 'state publication is disabled' };
  try {
    // The state branch is a complete approved-configuration mirror, not a second capabilities.yml
    // slot. Publishing only the edited map invalidates its manifest and makes Story startup reject
    // the state authority. Rebuild the whole bounded mirror from the reviewed configuration tip.
    const configurationCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root, env }).stdout.trim();
    const configurationFiles = {};
    const configurationHashes = {};
    const configurationAssets = {};
    const configurationPaths = await configurationAssetPaths(root);
    const canonicalAssets = await canonicalConfigurationAssets(root, configurationPaths, { env });
    for (const relative of configurationPaths) {
      const asset = canonicalAssets.get(relative);
      configurationFiles[relative] = asset.contents;
      configurationHashes[relative] = asset.sha256;
      configurationAssets[relative] = {
        sha256: asset.sha256,
        object: asset.object,
        mode: asset.mode
      };
    }
    const history = await retainStateConfigurationHistory(
      root, ledger.remote, configurationCommit, { env }
    );
    const manifest = {
      format: STATE_CONFIGURATION_FORMAT,
      layout: 'canonical-paths',
      source: { branch: CONFIGURATION_BRANCH, commit: configurationCommit },
      history,
      files: Object.fromEntries(Object.entries(configurationHashes)
        .sort(([left], [right]) => left.localeCompare(right))),
      assets: Object.fromEntries(Object.entries(configurationAssets)
        .sort(([left], [right]) => left.localeCompare(right)))
    };
    // Retire configuration paths removed by the reviewed commit without touching runtime roots.
    const remoteRef = `refs/remotes/${ledger.remote}/${ledger.branch}`;
    const stateFetch = await runRemoteGitAsync([
      'fetch', '--quiet', '--no-tags', '--force', '--', ledger.remote,
      `+refs/heads/${ledger.branch}:${remoteRef}`
    ], { cwd: root, operation: 'remote-configuration', env });
    // A successful exact fetch is already the observation publishToStateBranch needs for its CAS.
    // Bind the publication to that SHA and do not immediately fetch the same ref a second time. If
    // the fetch failed (including an absent first state branch), retain the ordinary refresh/bootstrap
    // path rather than trusting a stale local remote-tracking ref.
    const observedStateSha = stateFetch.status === 0
      ? run('git', ['rev-parse', '--verify', `${remoteRef}^{commit}`], {
          cwd: root, env, allowFailure: true
        }).stdout.trim()
      : '';
    const observedState = /^[0-9a-f]{40,64}$/.test(observedStateSha);
    const trackedAssets = observedState
      ? [...configurationTreeEntries(root, remoteRef, null, { env }).keys()]
      : [];
    const trackedMetadata = observedState ? run('git', [
      'ls-tree', '-r', '-z', '--name-only', remoteRef, '--', 'configuration'
    ], { cwd: root, env, allowFailure: true }).stdout.split('\0').filter(Boolean) : [];
    const previousManifest = observedState
      ? run('git', ['show', `${remoteRef}:${STATE_CONFIGURATION_MANIFEST}`], {
          cwd: root, env, allowFailure: true
        })
      : { status: 1, stdout: '' };
    if (previousManifest.status === 0) {
      try {
        const previousProduct = JSON.parse(previousManifest.stdout)?.product;
        if (previousProduct) manifest.product = previousProduct;
      } catch { /* A malformed prior mirror is replaced by the validated complete mirror below. */ }
    }
    configurationFiles[STATE_CONFIGURATION_MANIFEST] = `${JSON.stringify(manifest, null, 2)}\n`;
    const desired = new Set(configurationPaths);
    const removePaths = [
      ...trackedAssets.filter((relative) => !desired.has(relative)),
      ...trackedMetadata.filter((relative) => relative.startsWith('configuration/files/'))
    ];
    const result = await publishToStateBranch(
      root, ledger, configurationFiles, message, {
        replaceRoots: ['configuration'], removePaths,
        guardedRemoteRefs: {
          [`refs/heads/${CONFIGURATION_BRANCH}`]: configurationCommit
        },
        ...(observedState ? {
          expectedRemoteSha: observedStateSha,
          baseRef: remoteRef,
          refreshRemote: false
        } : {}),
        env
      });
    // Unchanged is not a failure and must not be reported as one: an edit that touched a field the
    // branch already agreed with is the ordinary case, not a problem to explain.
    if (!result.changed) return { published: false, branch: result.branch, reason: 'it is already current there' };
    return { published: true, branch: result.branch, commit: result.commit };
  } catch (error) {
    const diagnostic = safeGitDiagnosticReference({
      status: error?.exitCode ?? 1, error
    }, 'Capability state projection failed');
    if (ledger.publication === 'required') {
      throw new SingularityFlowError(diagnostic, {
        code: error?.code ?? 'CAPABILITY_STATE_PROJECTION_FAILED'
      });
    }
    return { published: false, reason: diagnostic };
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
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.', {
    code: 'CAPABILITY_LEAD_REQUIRED',
    details: capabilityRecovery({
      stage: 'projection', state: 'input-refused', recoverable: true,
      nextAction: { command: 'singularity-flow capability leads --json', skill: '/sf-capability-map' }
    })
  });
  const baseBranch = CONFIGURATION_BRANCH;
  const gitEnv = enterpriseGitEnvironment();
  const session = new GitRemoteSession({ env: gitEnv });
  const transport = frozenRemoteTransport(remote, { push: true, env: gitEnv });
  const configurationObservation = await session.observeAsync(remote, {
    includeHead: false, refs: [`refs/heads/${CONFIGURATION_BRANCH}`]
  });
  const configurationHead = configurationBranchHead(remote, {
    session, observation: configurationObservation
  });
  if (!configurationHead.reachable || !configurationHead.exists) {
    throw new SingularityFlowError(
      `Cannot publish capabilities because '${sanitizeRemote(remote)}' has no '${CONFIGURATION_BRANCH}' branch. Activate a reviewed proposal first.`, {
        code: 'CAPABILITY_CONFIGURATION_BRANCH_MISSING',
        details: capabilityRecovery({
          stage: 'projection', state: 'configuration-not-active', remote, recoverable: true,
          nextAction: { command: capabilityCommand('proposals', { remote }), skill: '/sf-capability-map' },
          preserved: ['application-branches']
        })
      });
  }
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-publish-map-'));
  try {
    const clone = (filtered) => runRemoteGitAsync([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch', '--depth', '1',
      ...(filtered ? ['--filter=blob:none'] : []),
      '--branch', baseBranch, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    let cloned = await clone(true);
    const partial = partialCloneFallbackDecision(cloned, {
      configured: cloned.status === 0
        ? partialCloneConfigured(scratch, 'origin', (args, options) => run('git', args, {
            ...options, env: transport.env
          }))
        : null,
      fallback: 'full'
    });
    if (partial.action === 'retry-full') {
      await removeTemporaryTree(scratch);
      await mkdir(scratch, { recursive: true });
      cloned = await clone(false);
    }
    if (cloned.status !== 0) {
      const failure = cloned.failure ?? classifyGitRemoteFailure(cloned);
      throw new SingularityFlowError(
        `Cannot read '${sanitizeRemote(remote)}'. ${failure.advice}`, {
          code: failure.code,
          details: capabilityRecovery({
            stage: 'projection', state: 'authority-unavailable', remote,
            nextAction: { command: capabilityCommand('publish', { remote }), skill: '/sf-capability-map' },
            preserved: ['approved-configuration', 'application-branches']
          })
        });
    }
    const state = await publishCapabilityMap(scratch, {
      message: `Publish reviewed capability map from ${baseBranch}`,
      env: transport.env
    });
    return { baseBranch, ...state };
  } finally {
    await removeTemporaryTree(scratch);
  }
}

/** Pending capability proposals on a lead repository, without changing either authority branch. */
export async function listCapabilityProposals(url, {
  includeMerged = false, includeDiff = true,
  repositoryUrl = null, maximumProposals = null, withCoverage = false,
  env = process.env, remoteSession = null, runRemoteCommand = runRemoteGitAsync
} = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.', {
    code: 'CAPABILITY_LEAD_REQUIRED',
    details: capabilityRecovery({
      stage: 'review', state: 'input-refused', recoverable: true,
      nextAction: { command: 'singularity-flow capability leads --json', skill: '/sf-capability-map' }
    })
  });
  const inspectedRepository = repositoryUrl == null
    ? null : assertCredentialFreeRemote(repositoryUrl);
  const proposalLimit = maximumProposals == null ? null : Number(maximumProposals);
  if (proposalLimit != null && (!Number.isSafeInteger(proposalLimit) || proposalLimit < 1)) {
    throw new SingularityFlowError('Capability proposal inspection limit must be a positive integer.', {
      code: 'CAPABILITY_PROPOSAL_LIMIT_INVALID'
    });
  }
  const finish = (proposals, total = proposals.length, inspected = proposals.length) => withCoverage
    ? {
        proposals,
        coverage: {
          status: inspected < total ? 'partial' : 'complete',
          total,
          inspected,
          limit: proposalLimit
        }
      }
    : proposals;
  const gitEnv = remoteSession?.env ?? enterpriseGitEnvironment(env);
  const session = remoteSession ?? new GitRemoteSession({ env: gitEnv });
  const transport = frozenRemoteTransport(remote, { env: gitEnv });
  const advertised = await session.observeAsync(remote, {
    includeHead: false,
    refs: [`refs/heads/${CONFIGURATION_BRANCH}`, `refs/heads/${CAPABILITY_PROPOSAL_PREFIX}*`]
  });
  if (!advertised.ok) {
    const failure = advertised.failure;
    throw new SingularityFlowError(
      `Cannot list capability proposals on '${sanitizeRemote(remote)}'. ${failure.advice}`, {
        code: failure.code,
        details: {
          ...capabilityRecovery({
            stage: 'review', state: 'authority-unavailable', remote,
            nextAction: { command: capabilityCommand('proposals', { remote }), skill: '/sf-capability-map' },
            preserved: ['approved-configuration', 'proposal-branches', 'application-branches']
          }),
          remoteFailure: publicRemoteFailure(failure),
          diagnosticAction: {
            command: `singularity-flow workspace doctor --network --repository ${quoted(commandRemote(remote))} --json`,
            skill: '/sf-capability-map'
          }
        }
      });
  }
  if (!advertised.refs.has(`refs/heads/${CONFIGURATION_BRANCH}`)) return finish([]);
  const allBranches = [...advertised.refs]
    .filter(([ref]) => ref.startsWith(`refs/heads/${CAPABILITY_PROPOSAL_PREFIX}`))
    .map(([ref, proposalCommit]) => ({
      proposalCommit, branch: ref.replace(/^refs\/heads\//, '')
    }))
    .sort((left, right) => left.branch.localeCompare(right.branch));
  const branches = proposalLimit == null ? allBranches : allBranches.slice(0, proposalLimit);
  if (!branches.length) return finish([], allBranches.length, 0);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-capability-list-'));
  const proposals = [];
  try {
    const clone = (filtered) => runRemoteCommand([
      'clone', '--quiet', '--no-local', '--no-tags', '--single-branch',
      ...(filtered ? ['--filter=blob:none'] : []),
      '--branch', CONFIGURATION_BRANCH, transport.remote, scratch
    ], { operation: 'remote-configuration', env: transport.env });
    let cloned = await clone(true);
    const partial = partialCloneFallbackDecision(cloned, {
      configured: cloned.status === 0
        ? partialCloneConfigured(scratch, 'origin', (args, options) => run('git', args, {
            ...options, env: transport.env
          }))
        : null,
      fallback: 'full'
    });
    if (partial.action === 'retry-full') {
      await removeTemporaryTree(scratch);
      await mkdir(scratch, { recursive: true });
      cloned = await clone(false);
    }
    if (cloned.status !== 0) {
      const remoteFailure = publicRemoteFailure(cloned.failure);
      throw new SingularityFlowError(`Cannot read '${sanitizeRemote(remote)}'. ${cloned.failure?.advice ?? 'Git clone failed.'}`, {
        code: cloned.failure?.code ?? 'CAPABILITY_AUTHORITY_UNAVAILABLE',
        details: {
          remoteFailure,
          diagnosticAction: {
            command: `singularity-flow workspace doctor --network --repository ${quoted(commandRemote(remote))} --json`,
            skill: '/sf-capability-map'
          }
        }
      });
    }
    const proposalRefspecs = proposalLimit == null
      ? [`+refs/heads/${CAPABILITY_PROPOSAL_PREFIX}*:refs/remotes/origin/${CAPABILITY_PROPOSAL_PREFIX}*`]
      : branches.map((entry) => `+refs/heads/${entry.branch}:refs/remotes/origin/${entry.branch}`);
    let fetched = await runRemoteCommand([
      'fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', ...proposalRefspecs
    ], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
    if (partialCloneFallbackDecision(fetched, { fallback: 'full' }).action === 'retry-full') {
      fetched = await runRemoteCommand([
        'fetch', '--quiet', '--no-tags', 'origin', ...proposalRefspecs
      ], { cwd: scratch, operation: 'remote-configuration', env: transport.env });
    }
    const sharedFailure = fetched.status === 0 ? null : new SingularityFlowError(
      `Capability proposals could not be fetched. ${fetched.failure?.advice ?? 'Git fetch failed.'}`,
      {
        code: fetched.failure?.code ?? 'CAPABILITY_AUTHORITY_UNAVAILABLE',
        details: {
          remoteFailure: publicRemoteFailure(fetched.failure),
          diagnosticAction: {
            command: `singularity-flow workspace doctor --network --repository ${quoted(commandRemote(remote))} --json`,
            skill: '/sf-capability-map'
          }
        }
      }
    );
    for (const entry of branches) {
      const ref = `refs/remotes/origin/${entry.branch}`;
      try {
        if (sharedFailure) throw sharedFailure;
        // The ordinary inbox excludes merged proposals. Determine that with ancestry before
        // computing names, identities, and the full diff for a proposal the caller will discard.
        if (!includeMerged && run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
          cwd: scratch, env: transport.env, allowFailure: true
        }).status === 0) continue;
        const proposal = inspectCapabilityProposalCheckout(
          scratch, sanitizeRemote(remote), entry.branch, ref, {
            includeDiff, repositoryUrl: inspectedRepository, env: transport.env
          }
        );
        if (includeMerged || !proposal.merged) proposals.push(proposal);
      } catch (error) {
        // One corrupt or stale proposal must remain visible without hiding every healthy proposal
        // on the same lead. Only the proven unrelated-history case gets the exact-SHA discard path;
        // every other unreadable state remains inspection-only.
        // An unreadable tip is not itself evidence that this proposal introduced a repository
        // claim: the same bytes may simply have been inherited from an unknown or replaced base.
        // Preserve a pending match only when the immutable base encoded in the branch is still
        // provable and the base-vs-tip comparison can therefore establish the exact delta.
        let repositoryInspection = { complete: false, matches: [] };
        try {
          const proposalBase = proposalBaseCommit(scratch, entry.branch, ref, {
            env: transport.env
          });
          // Replacement configuration roots make ancestry unavailable even when this proposal's
          // exact delta is already approved. Comparing every changed path still proves that the
          // proposal contributes no pending repository claim in that case.
          repositoryInspection = proposalContentIsPresent(
            scratch, proposalBase, ref, 'HEAD', { env: transport.env }
          ) ? { complete: true, matches: [] } : proposalRepositoryInspection(
              scratch, ref, inspectedRepository, { baseRef: proposalBase, env: transport.env }
            );
        } catch { /* the unreadable proposal remains visible, but contributes no unproven claim */ }
        proposals.push({
          remote: sanitizeRemote(remote), branch: entry.branch,
          targetBranch: CONFIGURATION_BRANCH, targetCommit: null,
          proposalCommit: entry.proposalCommit, proposalBase: null, mergeBase: null,
          merged: false, valid: false, invalidFiles: [], changedFiles: [], diff: '',
          status: 'unreadable',
          discardable: error?.code === 'CAPABILITY_PROPOSAL_HISTORY_INVALID',
          repositoryMatches: repositoryInspection.matches,
          repositoryInspectionComplete: repositoryInspection.complete,
          failure: {
            code: error?.code ?? 'CAPABILITY_PROPOSAL_UNREADABLE',
            message: redactDiagnosticText(error?.message ?? String(error)),
            remoteFailure: publicRemoteFailure(error?.details?.remoteFailure),
            classification: error?.details?.remoteFailure?.classification ?? null,
            retryable: error?.details?.remoteFailure?.retryable === true,
            evidence: error?.details?.remoteFailure?.evidence ?? null,
            diagnosticAction: error?.details?.diagnosticAction ?? null,
            nextAction: error?.code === 'CAPABILITY_PROPOSAL_HISTORY_INVALID'
              ? {
                  command: capabilityCommand('discard-proposal', {
                    remote, branch: entry.branch, commit: entry.proposalCommit,
                    reason: '<WHY THIS STALE PROPOSAL IS NO LONGER NEEDED>'
                  }),
                  skill: '/sf-capability-map'
                }
              : error?.details?.nextAction ?? {
                  command: capabilityCommand('proposal', { remote, branch: entry.branch }),
                  skill: '/sf-capability-map'
                }
          }
        });
      }
    }
  } finally {
    await removeTemporaryTree(scratch);
  }
  return finish(proposals, allBranches.length, branches.length);
}

function inspectCapabilityProposalCheckout(root, remote, proposalBranch, ref, {
  includeDiff = true, repositoryUrl = null, env = process.env
} = {}) {
  const targetCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root, env }).stdout.trim();
  const proposalCommit = run('git', ['rev-parse', ref], { cwd: root, env }).stdout.trim();
  const mergeBaseResult = run('git', ['merge-base', 'HEAD', ref], {
    cwd: root, env, allowFailure: true
  });
  if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
    throw new SingularityFlowError(
      `Capability proposal '${proposalBranch}' does not share history with '${CONFIGURATION_BRANCH}'.`, {
        code: 'CAPABILITY_PROPOSAL_HISTORY_INVALID',
        details: capabilityRecovery({
          stage: 'review', state: 'proposal-history-invalid', remote,
          branch: proposalBranch, recoverable: true,
          preserved: ['approved-configuration', 'application-branches', 'proposal-branch']
        })
      });
  }
  const proposalBase = proposalBaseCommit(root, proposalBranch, ref, { env });
  const mergeBase = mergeBaseResult.stdout.trim();
  const ancestryMerged = run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
    cwd: root, env, allowFailure: true
  }).status === 0;
  const contentMerged = !ancestryMerged
    && proposalContentIsPresent(root, proposalBase, ref, 'HEAD', { env });
  const merged = ancestryMerged || contentMerged;
  const reviewBase = merged ? proposalBase : mergeBase;
  const changed = proposalChangedFiles(root, reviewBase, ref, { env });
  const policy = proposalAssetPolicyInEnvironment(root, [reviewBase, ref], env);
  const invalidFiles = changed.names.filter((file) => !isConfigurationAsset(file, policy));
  const configurationError = proposalConfigurationError(root, ref, { env });
  const valid = invalidFiles.length === 0 && changed.names.length > 0 && !configurationError;
  const repositoryInspection = proposalRepositoryInspection(
    root, ref, repositoryUrl, { baseRef: reviewBase, env }
  );
  const diff = includeDiff
    ? run('git', ['diff', '--no-ext-diff', '--unified=3', `${reviewBase}..${ref}`], {
        cwd: root, env
      }).stdout
    : null;
  return {
    remote,
    branch: proposalBranch,
    targetBranch: CONFIGURATION_BRANCH,
    targetCommit,
    proposalCommit,
    proposalBase,
    mergeBase,
    merged,
    mergeEvidence: ancestryMerged ? 'commit-ancestry' : contentMerged ? 'content-equivalent' : null,
    valid,
    discardable: !merged && !valid,
    status: merged ? 'merged' : valid ? 'pending-review' : 'invalid',
    configurationError,
    invalidFiles,
    repositoryMatches: repositoryInspection.matches,
    repositoryInspectionComplete: repositoryInspection.complete,
    changedFiles: changed.statuses,
    diff: diff == null ? null
      : diff.length > 200_000 ? `${diff.slice(0, 200_000)}\n… diff truncated …\n` : diff,
    diffDeferred: diff == null
  };
}

/** Exact commits, file set, and diff a reviewer is being asked to activate. */
export async function inspectCapabilityProposal(url, branch) {
  return withCapabilityProposalCheckout(url, branch, async (
    root, remote, proposalBranch, ref, { env }
  ) => inspectCapabilityProposalCheckout(root, remote, proposalBranch, ref, { env }));
}

function capabilityFsckCheck(id, status, summary, {
  branch = null, commit = null, remediation = null, details = null
} = {}) {
  return { id, status, summary, branch, commit, remediation, details };
}

/** Verify the approved capability authority and every retained proposal without changing a ref. */
export async function capabilityFsck(url, { workspaces = [] } = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.', {
    code: 'CAPABILITY_LEAD_REQUIRED'
  });
  const leadIdentity = assertCredentialFreeRemote(remote);
  const lead = sanitizeRemote(remote);
  const checks = [];
  let organisation = null;
  try {
    organisation = await readOrganisation(remote, { refresh: true });
    if (!organisation.governed) {
      checks.push(capabilityFsckCheck(
        'approved-capability-map', 'fail',
        `The approved '${CONFIGURATION_BRANCH}' branch has no capability map.`,
        { remediation: `singularity-flow capability map <CAPABILITY-ID> --lead ${quoted(lead)} --json` }
      ));
    } else {
      checks.push(capabilityFsckCheck(
        'approved-capability-map', organisation.stale ? 'warn' : 'pass',
        organisation.stale
          ? `Only a previously validated capability map is available; '${organisation.branch}' could not be refreshed.`
          : `Approved capability configuration is readable from '${organisation.branch}'.`,
        { branch: organisation.branch }
      ));
      const projection = organisation.stateProjection ?? {
        status: organisation.sourceBranch !== CONFIGURATION_BRANCH ? 'current' : 'missing',
        branch: organisation.sourceBranch, commit: organisation.sourceCommit, error: null
      };
      const projected = !organisation.stale && projection.status === 'current';
      const invalidProjection = projection.status === 'invalid';
      checks.push(capabilityFsckCheck(
        'state-projection', projected ? 'pass' : invalidProjection ? 'fail' : 'warn',
        projected
          ? `The approved configuration mirror is current on '${projection.branch}'.`
          : invalidProjection
            ? `The state-branch configuration mirror is invalid: ${projection.error}`
            : organisation.stale
              ? 'The state-branch projection cannot be declared current while the configuration authority is unreachable.'
              : 'The approved configuration is readable, but its state-branch mirror is absent or stale.',
        projected ? { branch: projection.branch, commit: projection.commit } : {
          remediation: capabilityCommand('publish', { remote })
        }
      ));
    }
  } catch (error) {
    checks.push(capabilityFsckCheck(
      'approved-capability-map', 'fail', redactDiagnosticText(error?.message ?? String(error)),
      { remediation: `singularity-flow capability organisation ${quoted(lead)} --refresh --json` }
    ));
  }

  const capabilityIds = (nodes, output = new Set()) => {
    for (const node of nodes ?? []) {
      if (node?.id) output.add(node.id);
      capabilityIds(node?.children, output);
    }
    return output;
  };
  const knownCapabilities = capabilityIds(organisation?.capabilities);
  const sameLeadAuthority = (candidate) => {
    try { return assertCredentialFreeRemote(candidate) === leadIdentity; }
    catch { return false; }
  };
  const matchingWorkspaces = workspaces.filter((workspace) => {
    const authority = workspace?.capabilityAuthority?.url;
    if (authority) return sameLeadAuthority(authority);
    return Object.values(workspace?.repositories ?? {})
      .some((repository) => sameLeadAuthority(repository?.url));
  });
  for (const workspace of matchingWorkspaces) {
    const requested = [...new Set([
      ...(workspace.capabilities ?? []),
      ...Object.values(workspace.repositories ?? {})
        .flatMap((repository) => repository?.capabilities ?? [])
    ])].sort();
    if (!organisation || organisation.stale) {
      checks.push(capabilityFsckCheck(
        `workspace:${workspace.id}:capability-binding`, 'warn',
        `Workspace '${workspace.name ?? workspace.id}' capability bindings could not be compared because current approved configuration is unavailable.`,
        {
          remediation: `singularity-flow capability organisation ${quoted(lead)} --refresh --json`,
          details: { workspaceId: workspace.id, requested }
        }
      ));
      checks.push(capabilityFsckCheck(
        `workspace:${workspace.id}:canonical-capability-map`, 'warn',
        'The canonical checkout was not compared with an unavailable or stale capability authority; no divergence conclusion was inferred.',
        {
          remediation: `singularity-flow capability organisation ${quoted(lead)} --refresh --json`,
          details: { workspaceId: workspace.id, repositoryId: workspace.leadRepository ?? null }
        }
      ));
      continue;
    }
    const unknown = requested.filter((capability) => !knownCapabilities.has(capability));
    checks.push(capabilityFsckCheck(
      `workspace:${workspace.id}:capability-binding`, unknown.length ? 'fail' : 'pass',
      unknown.length
        ? `Workspace '${workspace.name ?? workspace.id}' references capability IDs absent from approved '${CONFIGURATION_BRANCH}': ${unknown.join(', ')}.`
        : `Workspace '${workspace.name ?? workspace.id}' capability bindings exist in approved configuration.`,
      unknown.length ? {
        remediation: `singularity-flow capability map ${quoted(unknown[0])} --lead ${quoted(lead)} --json`,
        details: {
          workspaceId: workspace.id,
          workspacePath: workspace.path ?? null,
          unknown,
          alternatives: [
            'If the ID is correct, map, review, and activate that capability on the configuration authority.',
            `If the workspace ID is wrong, correct it with 'singularity-flow workspace update' after selecting a valid capability.`
          ]
        }
      } : { details: { workspaceId: workspace.id, requested } }
    ));

    const leadRepository = workspace.repositories?.[workspace.leadRepository];
    const canonicalRoot = leadRepository && workspace.path
      ? workspaceRepositoryPath(workspace, leadRepository)
      : null;
    const checkId = `workspace:${workspace.id}:canonical-capability-map`;
    if (!canonicalRoot || !existsSync(path.join(canonicalRoot, '.git'))) {
      checks.push(capabilityFsckCheck(
        checkId, 'warn',
        `Workspace '${workspace.name ?? workspace.id}' has no readable canonical lead checkout for branch-local capability diagnostics.`,
        { details: { workspaceId: workspace.id, repositoryId: workspace.leadRepository ?? null } }
      ));
      continue;
    }
    const sourceFile = path.join(canonicalRoot, 'singularity/configuration-source.json');
    if (existsSync(sourceFile)) {
      try {
        const pinned = await readConfigurationSource(canonicalRoot, { verify: true });
        if (!sameLeadAuthority(pinned.repository)) {
          throw new SingularityFlowError(
            `Pinned configuration names a different authority: ${sanitizeRemote(pinned.repository)}.`
          );
        }
        const storyBranch = run('git', ['branch', '--show-current'], {
          cwd: canonicalRoot, allowFailure: true
        }).stdout.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(storyBranch)) {
          throw new SingularityFlowError('Pinned configuration is not checked out on a governed Story branch.');
        }
        const localConfig = await loadDefinition(canonicalRoot);
        const workflowFile = path.join(
          canonicalRoot,
          localConfig.workItemRoot ?? 'singularity/work-items',
          storyBranch,
          'workflow.json'
        );
        const workflow = await readJson(workflowFile);
        const workflowSource = workflow?.resolution?.configurationSource;
        if (workflow?.workItem?.branch !== storyBranch
            || workflow?.lineage?.canonicalBranch !== storyBranch
            || workflowSource?.repository !== pinned.repository
            || workflowSource?.commit !== pinned.commit
            || workflowSource?.filesSha256 !== pinned.filesSha256) {
          throw new SingularityFlowError(
            'Pinned configuration is not bound to this branch\'s governed Story resolution.'
          );
        }
        checks.push(capabilityFsckCheck(
          checkId, 'info',
          `Canonical lead checkout pins reviewed configuration ${pinned.branch}@${pinned.commit.slice(0, 12)}; an older Story snapshot is intentional.`,
          {
            branch: storyBranch,
            commit: pinned.commit,
            details: { workspaceId: workspace.id, repositoryId: workspace.leadRepository }
          }
        ));
      } catch (error) {
        checks.push(capabilityFsckCheck(
          checkId, 'fail',
          `Canonical lead checkout has an invalid pinned configuration: ${redactDiagnosticText(error?.message ?? String(error))}`,
          {
            remediation: `singularity-flow workspace refresh-configuration --repository ${quoted(workspace.leadRepository)} --dry-run`,
            details: { workspaceId: workspace.id, repositoryId: workspace.leadRepository }
          }
        ));
      }
      continue;
    }
    try {
      const localDefinition = await loadCapabilities(canonicalRoot);
      if (!localDefinition) {
        checks.push(capabilityFsckCheck(
          checkId, 'pass',
          'The application checkout has no branch-local capability map shadowing approved configuration.',
          { details: { workspaceId: workspace.id, repositoryId: workspace.leadRepository } }
        ));
        continue;
      }
      const localTree = capabilityTree(localDefinition);
      const agrees = canonicalJson(localTree) === canonicalJson(organisation?.capabilities ?? []);
      checks.push(capabilityFsckCheck(
        checkId, agrees ? 'pass' : 'fail',
        agrees
          ? 'The branch-local capability map agrees with approved configuration.'
          : `The canonical application checkout carries an unpinned capability map that diverges from approved '${CONFIGURATION_BRANCH}'.`,
        agrees ? {
          details: { workspaceId: workspace.id, repositoryId: workspace.leadRepository }
        } : {
          // Configuration refresh updates the authority and its state projection; it does not own
          // application-branch files. Do not advertise that preview as a repair for this shadow.
          // Removing a repository file is intentionally left to normal source-control review.
          remediation: `Review ${CAPABILITIES_PATH} in repository '${workspace.leadRepository}' and remove it through normal source control if it is obsolete; then rerun capability fsck. No automatic deletion is performed.`,
          details: {
            workspaceId: workspace.id,
            repositoryId: workspace.leadRepository,
            branch: run('git', ['branch', '--show-current'], { cwd: canonicalRoot, allowFailure: true }).stdout.trim() || null,
            localCapabilities: [...capabilityIds(localTree)].sort(),
            approvedCapabilities: [...knownCapabilities].sort(),
            note: 'The upgraded runtime ignores this unproven local map for new Story creation; review it before any cleanup.'
          }
        }
      ));
    } catch (error) {
      checks.push(capabilityFsckCheck(
        checkId, 'fail',
        `The canonical application checkout capability map is not safe or readable: ${redactDiagnosticText(error?.message ?? String(error))}`,
        {
          remediation: `singularity-flow workspace refresh-configuration --repository ${quoted(workspace.leadRepository)} --dry-run`,
          details: { workspaceId: workspace.id, repositoryId: workspace.leadRepository }
        }
      ));
    }
  }

  let proposals = [];
  try {
    proposals = await listCapabilityProposals(remote, { includeMerged: true, includeDiff: false });
    if (!proposals.length) {
      checks.push(capabilityFsckCheck('proposal-catalog', 'pass', 'No capability proposal branches are retained.'));
    }
    for (const proposal of proposals) {
        if (proposal.merged) {
          checks.push(capabilityFsckCheck(
            `proposal:${proposal.branch}`, 'pass',
            'The retained proposal is already contained by approved configuration.',
            { branch: proposal.branch, commit: proposal.proposalCommit }
          ));
        } else if (proposal.valid) {
          checks.push(capabilityFsckCheck(
            `proposal:${proposal.branch}`, 'info', 'A valid capability proposal is waiting for review.',
            {
              branch: proposal.branch, commit: proposal.proposalCommit,
              remediation: capabilityCommand('proposal', { remote, branch: proposal.branch })
            }
          ));
        } else if (proposal.discardable) {
          checks.push(capabilityFsckCheck(
            `proposal:${proposal.branch}`, 'fail',
            `The proposal cannot be reviewed or merged because it does not share history with '${CONFIGURATION_BRANCH}'.`,
            {
              branch: proposal.branch, commit: proposal.proposalCommit,
              remediation: capabilityCommand('discard-proposal', {
                remote, branch: proposal.branch, commit: proposal.proposalCommit,
                reason: '<WHY THIS STALE PROPOSAL IS NO LONGER NEEDED>'
              }),
              details: {
                alternatives: [
                  `Recreate the capability from current '${CONFIGURATION_BRANCH}' with 'singularity-flow capability map'.`,
                  'Discard only after reviewing the exact branch and commit shown by this check.'
                ]
              }
            }
          ));
        } else {
          checks.push(capabilityFsckCheck(
            `proposal:${proposal.branch}`, 'fail',
            proposal.failure?.message ?? 'The capability proposal is not valid for activation.',
            {
              branch: proposal.branch, commit: proposal.proposalCommit,
              remediation: proposal.failure?.nextAction?.command
                ?? capabilityCommand('proposal', { remote, branch: proposal.branch })
            }
          ));
        }
    }
  } catch (error) {
    checks.push(capabilityFsckCheck(
      'proposal-catalog', 'fail', redactDiagnosticText(error?.message ?? String(error)),
      { remediation: capabilityCommand('proposals', { remote }) }
    ));
  }

  const summary = {
    passed: checks.filter((entry) => entry.status === 'pass').length,
    information: checks.filter((entry) => entry.status === 'info').length,
    warnings: checks.filter((entry) => entry.status === 'warn').length,
    failures: checks.filter((entry) => entry.status === 'fail').length
  };
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    lead,
    valid: summary.failures === 0,
    summary,
    checks,
    proposals: proposals.map((proposal) => ({
      branch: proposal.branch,
      proposalCommit: proposal.proposalCommit,
      merged: proposal.merged,
      valid: proposal.valid,
      status: proposal.status ?? (proposal.merged ? 'merged' : proposal.valid ? 'pending-review' : 'invalid'),
      discardable: proposal.discardable === true
    }))
  };
}

/** Delete one provably stale proposal branch with an exact remote-SHA lease. */
export async function discardStaleCapabilityProposal(url, branch, {
  confirm = null, reason = null
} = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.', {
    code: 'CAPABILITY_LEAD_REQUIRED'
  });
  const proposalBranch = capabilityProposalBranch(branch);
  const explanation = String(reason ?? '').trim();
  if (!explanation) {
    throw new SingularityFlowError('Discarding a stale capability proposal requires --reason <TEXT>. Nothing was changed.', {
      code: 'CAPABILITY_PROPOSAL_DISCARD_REASON_REQUIRED'
    });
  }
  if (explanation.length > 500) {
    throw new SingularityFlowError('Capability proposal discard reason must be 500 characters or fewer. Nothing was changed.', {
      code: 'CAPABILITY_PROPOSAL_DISCARD_REASON_INVALID'
    });
  }
  const gitEnv = enterpriseGitEnvironment();
  const session = new GitRemoteSession({ env: gitEnv });
  const transport = frozenRemoteTransport(remote, { push: true, env: gitEnv });
  const proposals = await listCapabilityProposals(remote, {
    includeMerged: true, includeDiff: false, env: gitEnv, remoteSession: session
  });
  const proposal = proposals.find((entry) => entry.branch === proposalBranch);
  if (!proposal) {
    throw new SingularityFlowError(
      `Capability proposal '${proposalBranch}' does not exist. Refresh fsck before retrying; nothing was changed.`, {
        code: 'CAPABILITY_PROPOSAL_NOT_FOUND'
      }
    );
  }
  const expected = proposal.proposalCommit;
  if (String(confirm ?? '').trim() !== expected) {
    throw new SingularityFlowError(
      `Confirmation must equal the current full proposal commit '${expected}'. Nothing was changed.`, {
        code: 'CAPABILITY_PROPOSAL_DISCARD_CONFIRMATION_MISMATCH',
        details: {
          lead: sanitizeRemote(remote), proposalBranch, proposalCommit: expected,
          nextAction: {
            command: capabilityCommand('discard-proposal', {
              remote, branch: proposalBranch, commit: expected, reason: explanation
            }),
            skill: '/sf-capability-map'
          }
        }
      }
    );
  }
  if (!proposal.discardable) {
    throw new SingularityFlowError(
      `Capability proposal '${proposalBranch}' is reviewable and cannot be discarded as stale. Review or activate it instead; nothing was changed.`, {
        code: 'CAPABILITY_PROPOSAL_DISCARD_NOT_STALE',
        details: {
          lead: sanitizeRemote(remote), proposalBranch, proposalCommit: expected,
          nextAction: {
            command: capabilityCommand('proposal', { remote, branch: proposalBranch }),
            skill: '/sf-capability-map'
          }
        }
      }
    );
  }

  const targetRef = `refs/heads/${proposalBranch}`;
  const deleted = await runRemoteGitAsync([
    'push', '--porcelain', `--force-with-lease=${targetRef}:${expected}`,
    transport.remote, `:${targetRef}`
  ], { operation: 'remote-push', env: transport.env });
  if (deleted.status !== 0) {
    throw new SingularityFlowError(
      `Stale proposal '${proposalBranch}' was not discarded. The remote may have moved or refused the exact deletion. ${deleted.failure?.advice ?? 'Refresh fsck and retry.'}`, {
        code: 'CAPABILITY_PROPOSAL_DISCARD_FAILED',
        details: {
          lead: sanitizeRemote(remote), proposalBranch, proposalCommit: expected,
          nextAction: { command: capabilityCommand('fsck', { remote }), skill: '/sf-capability-map' },
          preserved: ['proposal-branch', 'approved-configuration', 'application-branches']
        }
      }
    );
  }
  session.invalidate(remote);
  const observed = await session.observeAsync(remote, {
    includeHead: false, refs: [targetRef], refresh: true
  });
  if (!observed.ok || observed.refs.has(targetRef)) {
    throw new SingularityFlowError(
      `The remote did not verify removal of stale proposal '${proposalBranch}'. Run capability fsck before taking another action.`, {
        code: 'CAPABILITY_PROPOSAL_DISCARD_UNVERIFIED',
        details: { lead: sanitizeRemote(remote), proposalBranch, proposalCommit: expected }
      }
    );
  }
  return {
    schemaVersion: 1,
    status: 'discarded',
    discarded: true,
    lead: sanitizeRemote(remote),
    branch: proposalBranch,
    proposalCommit: expected,
    reason: explanation,
    discardedAt: new Date().toISOString(),
    preserved: ['approved-configuration', 'state-projection', 'application-branches', 'other-proposal-branches'],
    nextAction: { command: capabilityCommand('fsck', { remote }), skill: '/sf-capability-map' }
  };
}

/**
 * Merge one exact reviewed proposal into the configuration authority, then refresh its projection.
 *
 * This is an exact leased push: it can never replace an authority revision that was not reviewed.
 * A protected `sflow/config` branch refuses it and retains the proposal for repository PR controls.
 */
export async function activateCapabilityProposal(url, branch, {
  confirm = null,
  acknowledgeUnprotected = false
} = {}) {
  const reviewed = await withCapabilityProposalCheckout(
    url, branch, async (root, remote, proposalBranch, ref, { env, session }) => {
      const targetBefore = run('git', ['rev-parse', 'HEAD'], { cwd: root, env }).stdout.trim();
      const proposalCommit = run('git', ['rev-parse', ref], { cwd: root, env }).stdout.trim();
      if (String(confirm ?? '').trim() !== proposalCommit) {
        const nextAction = {
          command: capabilityCommand('activate', {
            remote, branch: proposalBranch, commit: proposalCommit
          }),
          skill: '/sf-capability-map'
        };
        throw new SingularityFlowError(
          `Confirmation must be the exact proposal commit '${proposalCommit}'. Nothing was changed. Re-run: ${nextAction.command}`, {
            code: 'CAPABILITY_PROPOSAL_CONFIRMATION_MISMATCH',
            details: capabilityRecovery({
              stage: 'activation', state: 'confirmation-required', remote,
              branch: proposalBranch, commit: proposalCommit, nextAction,
              preserved: ['proposal-branch', 'approved-configuration', 'application-branches']
            })
          });
      }
      const mergeBaseResult = run('git', ['merge-base', 'HEAD', ref], {
        cwd: root, env, allowFailure: true
      });
      if (mergeBaseResult.status !== 0 || !mergeBaseResult.stdout.trim()) {
        const nextAction = {
          command: capabilityCommand('discard-proposal', {
            remote, branch: proposalBranch, commit: proposalCommit,
            reason: '<WHY THIS STALE PROPOSAL IS NO LONGER NEEDED>'
          }),
          skill: '/sf-capability-map'
        };
        throw new SingularityFlowError(
          `Capability proposal '${proposalBranch}' does not share history with '${CONFIGURATION_BRANCH}'. Nothing was changed. Run capability fsck, then recreate or discard only the exact preserved proposal.`, {
            code: 'CAPABILITY_PROPOSAL_HISTORY_INVALID',
            details: capabilityRecovery({
              stage: 'activation', state: 'proposal-invalid', remote,
              branch: proposalBranch, commit: proposalCommit, nextAction,
              preserved: ['proposal-branch', 'approved-configuration', 'application-branches']
            })
          });
      }
      const proposalBase = proposalBaseCommit(root, proposalBranch, ref, { env });
      const ancestryMerged = run('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], {
        cwd: root, env, allowFailure: true
      }).status === 0;
      const contentMerged = !ancestryMerged
        && proposalContentIsPresent(root, proposalBase, ref, 'HEAD', { env });
      let alreadyMerged = ancestryMerged || contentMerged;
      let mergeEvidence = ancestryMerged ? 'commit-ancestry'
        : contentMerged ? 'content-equivalent' : null;
      // An externally merged generated proposal is a single commit and its merge-base with HEAD is
      // now the proposal itself. Retrospective activation still needs the reviewed file set for the
      // audit, so use that proposal commit's parent in the already-merged case.
      const reviewBase = alreadyMerged
        ? proposalBase
        : mergeBaseResult.stdout.trim();
      // Once a provider merged the branch, this process can prove the resulting target but cannot
      // honestly reconstruct the authority tip immediately before that external action.
      let auditedTargetBefore = alreadyMerged ? null : targetBefore;
      const changed = proposalChangedFiles(root, reviewBase, ref, { env });
      if (!changed.names.length) {
        const nextAction = { command: capabilityCommand('proposal', { remote, branch: proposalBranch }), skill: '/sf-capability-map' };
        throw new SingularityFlowError(`Capability proposal '${proposalBranch}' contains no changes. Nothing was changed; inspect or replace the preserved proposal.`, {
          code: 'CAPABILITY_PROPOSAL_EMPTY',
          details: capabilityRecovery({
            stage: 'activation', state: 'proposal-invalid', remote,
            branch: proposalBranch, commit: proposalCommit, nextAction,
            preserved: ['proposal-branch', 'approved-configuration', 'application-branches']
          })
        });
      }
      const policy = proposalAssetPolicyInEnvironment(root, [reviewBase, ref], env);
      const invalidFiles = changed.names.filter((file) => !isConfigurationAsset(file, policy));
      if (invalidFiles.length) {
        const nextAction = { command: capabilityCommand('proposal', { remote, branch: proposalBranch }), skill: '/sf-capability-map' };
        throw new SingularityFlowError(
          `Capability proposal contains non-configuration files: ${invalidFiles.join(', ')}. Nothing was changed; replace it with a configuration-only proposal.`, {
            code: 'CAPABILITY_PROPOSAL_FILES_INVALID',
            details: capabilityRecovery({
              stage: 'activation', state: 'proposal-invalid', remote,
              branch: proposalBranch, commit: proposalCommit, nextAction,
              preserved: ['proposal-branch', 'approved-configuration', 'application-branches']
            })
          });
      }
      const definition = await loadDefinition(root);
      if (!definition.ledger?.enabled) {
        const nextAction = { command: 'singularity-flow workspace refresh-configuration --dry-run --json', skill: '/sf-workspace' };
        throw new SingularityFlowError(
          'Capability activation requires the capability ledger so the review decision can be audited. Nothing was changed; refresh or repair the approved configuration, then retry.', {
            code: 'CAPABILITY_ACTIVATION_LEDGER_REQUIRED',
            details: capabilityRecovery({
              stage: 'activation', state: 'configuration-repair-required', remote,
              branch: proposalBranch, commit: proposalCommit, nextAction,
              preserved: ['proposal-branch', 'approved-configuration', 'application-branches']
            })
          }
        );
      }
      let protection = { enforced: null, detail: 'proposal is already merged' };
      const validateEffectiveCapabilities = async () => {
        const capabilities = YAML.parse(await readFile(path.join(root, CAPABILITIES_PATH), 'utf8'));
        const portfolio = existsSync(path.join(root, PORTFOLIO_PATH))
          ? YAML.parse(await readFile(path.join(root, PORTFOLIO_PATH), 'utf8')) : null;
        try {
          validateCapabilities(capabilities, portfolio);
        } catch (error) {
          const nextAction = { command: capabilityCommand('proposal', { remote, branch: proposalBranch }), skill: '/sf-capability-map' };
          throw new SingularityFlowError(
            `Capability proposal is not operational: ${redactDiagnosticText(error?.message ?? String(error))}. Nothing was changed; correct the preserved proposal and review it again.`, {
              code: 'CAPABILITY_PROPOSAL_CONFIGURATION_INVALID',
              details: capabilityRecovery({
                stage: 'activation', state: 'proposal-invalid', remote,
                branch: proposalBranch, commit: proposalCommit, nextAction,
                preserved: ['proposal-branch', 'approved-configuration', 'application-branches']
              })
            });
        }
      };
      if (!alreadyMerged) {
        const actor = identity(root, { env });
        const merged = run('git', [
          '-c', `user.name=${actor.name || 'Singularity Flow'}`,
          '-c', `user.email=${actor.email || 'unknown@invalid'}`,
          'merge', '--no-ff', '--no-edit', ref
        ], { cwd: root, env, allowFailure: true });
        if (merged.status !== 0) {
          const nextAction = { command: capabilityCommand('proposal', { remote, branch: proposalBranch }), skill: '/sf-capability-map' };
          throw new SingularityFlowError(
            `Capability proposal cannot be merged cleanly into '${CONFIGURATION_BRANCH}'. `
            + `The proposal remains on '${proposalBranch}' for review. Rebase or replace it against the current approved configuration.`, {
              code: 'CAPABILITY_PROPOSAL_CONFLICT',
              details: capabilityRecovery({
                stage: 'activation', state: 'proposal-conflicted', remote,
                branch: proposalBranch, commit: proposalCommit, nextAction,
                preserved: ['proposal-branch', 'approved-configuration', 'application-branches']
              })
            });
        }
        await validateEffectiveCapabilities();
        // Git dry-run skips receive hooks, so it cannot distinguish an unprotected authority from a
        // protected one. Require either external review or an explicit direct-push acknowledgement;
        // the subsequent exact leased push is the only honest provider observation.
        protection = configurationProtectionProbe();
        if (protection.enforced !== true && !acknowledgeUnprotected) {
          const nextAction = {
            command: capabilityCommand('activate', {
              remote, branch: proposalBranch, commit: proposalCommit, acknowledge: true
            }),
            skill: '/sf-capability-map'
          };
          throw new SingularityFlowError(
            `Git cannot prove whether '${CONFIGURATION_BRANCH}' on '${sanitizeRemote(remote)}' is protected without `
            + 'attempting the real update. Nothing was changed. Review and merge the proposal externally, '
            + `or explicitly acknowledge a direct-push attempt. Re-run: ${nextAction.command}`,
            {
              code: 'CAPABILITY_CONFIGURATION_UNPROTECTED',
              details: capabilityRecovery({
                stage: 'activation', state: 'unprotected-acknowledgement-required', remote,
                branch: proposalBranch, commit: proposalCommit, nextAction,
                preserved: ['proposal-branch', 'approved-configuration', 'application-branches']
              })
            }
          );
        }
        const proposedMergeCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root, env }).stdout.trim();
        let pushed = await runRemoteGitAsync([
          'push', '--porcelain',
          `--force-with-lease=refs/heads/${CONFIGURATION_BRANCH}:${targetBefore}`,
          'origin', `HEAD:refs/heads/${CONFIGURATION_BRANCH}`
        ], {
          cwd: root, operation: 'remote-push', env
        });
        const targetRef = `refs/heads/${CONFIGURATION_BRANCH}`;
        const transition = pushed.status === 0
          ? pushed.stdout.split(/\r?\n/).map((line) => {
            const [flag, refspec] = line.split('\t');
            return refspec?.endsWith(`:${targetRef}`) ? flag : null;
          }).find((flag) => flag !== null)
          : null;
        if (pushed.status !== 0 || (transition !== ' ' && transition !== '+')) {
          // Git can either reject the stale lease or elide an unchanged update as `=` when another
          // actor acquires the old->new transition around receive-pack. Re-read the exact authority
          // in both cases. Matching bytes are an external merge, never a direct activation by this
          // reviewer; any other result takes the ordinary recoverable failure path.
          const authority = await session.observeAsync(remote, {
            includeHead: false, refs: [targetRef], refresh: true
          });
          if (authority.ok && authority.refs.get(targetRef) === proposedMergeCommit) {
            alreadyMerged = true;
            mergeEvidence = 'concurrent-identical-commit';
            auditedTargetBefore = null;
            protection = {
              enforced: null,
              detail: 'matching configuration commit was installed by a concurrent external action'
            };
            pushed = { ...pushed, status: 0 };
          } else if (pushed.status === 0) {
              pushed = {
                ...pushed,
                status: 1,
                stderr: `stale info: '${CONFIGURATION_BRANCH}' did not perform the explicitly leased transition`
              };
          }
        }
        if (pushed.status !== 0) {
          const failure = pushed.failure ?? classifyGitRemoteFailure(pushed);
          const pushDiagnostic = `${pushed.stderr ?? ''}\n${pushed.stdout ?? ''}`;
          const nextAction = {
            command: capabilityCommand('activate', {
              remote, branch: proposalBranch, commit: proposalCommit, acknowledge: true
            }),
            skill: '/sf-capability-map'
          };
          // A failed push is not automatically a review decision. Authentication, connectivity,
          // a missing remote, and unsupported transports need their own repair path; only an
          // enforced authority that rejects a non-retryable update is sent to repository review.
          const repositoryRequestedReview = ['authorization-denied', 'unknown'].includes(failure.classification)
            && /protected branch|branch protection|review required|pull request|required reviews?/i
              .test(pushDiagnostic);
          const reviewRequired = repositoryRequestedReview;
          protection = reviewRequired
            ? { enforced: true, detail: 'the real exact update was refused by repository review controls' }
            : { enforced: null, detail: 'the real exact update failed without review-control evidence' };
          return {
            status: reviewRequired ? 'review-required' : 'activation-pending',
            activated: false,
            remote: sanitizeRemote(remote),
            branch: proposalBranch,
            proposalCommit,
            targetBranch: CONFIGURATION_BRANCH,
            targetBefore,
            targetCommit: targetBefore,
            proposedMergeCommit,
            alreadyMerged: false,
            changedFiles: changed.statuses,
            protection,
            failure: {
              code: reviewRequired ? 'CAPABILITY_ACTIVATION_REVIEW_REQUIRED' : failure.code,
              classification: failure.classification,
              retryable: failure.retryable,
              message: reviewRequired
                ? `The proposal is preserved. Merge '${proposalBranch}' into '${CONFIGURATION_BRANCH}' through the repository review controls.`
                : `The proposal is preserved. ${failure.advice}`,
              diagnostic: safeGitDiagnosticReference(pushed, 'Capability activation was refused')
            },
            externalAction: reviewRequired ? {
              action: 'merge-proposal', sourceBranch: proposalBranch,
              targetBranch: CONFIGURATION_BRANCH, proposalCommit
            } : null,
            nextAction,
            preserved: ['proposal-branch', 'approved-configuration', 'application-branches'],
            audit: { recorded: false },
            projection: null
          };
        }
        if (!alreadyMerged) {
          protection = {
            enforced: false,
            detail: 'the real exact leased update was accepted for this actor'
          };
        }
      }
      // Validate the effective approved commit in both paths. A proposal merged externally used to
      // skip this gate and could be audited and projected even when its capability forest was
      // invalid.
      if (alreadyMerged) await validateEffectiveCapabilities();
      const targetCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root, env }).stdout.trim();
      const proposer = commitIdentity(root, ref, { env });
      const approver = identity(root, { env });
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
          targetBefore: auditedTargetBefore,
          targetCommit,
          mergeEvidence,
          changedFiles: changed.statuses,
          protection,
          unprotectedAcknowledged: !alreadyMerged
            && protection.enforced !== true && acknowledgeUnprotected === true
        }
      });
      let audit;
      try {
        audit = await appendLedgerIntent(root, definition.ledger, intent, targetCommit, {
          env, transportRemote: remote
        });
      } catch (error) {
        const nextAction = {
          command: capabilityCommand('activate', {
            remote, branch: proposalBranch, commit: proposalCommit
          }),
          skill: '/sf-capability-map'
        };
        throw new SingularityFlowError(
          `Capability configuration reached '${CONFIGURATION_BRANCH}' at ${targetCommit}, but its `
          + `activation audit could not be appended. ${safeGitDiagnosticReference({
            status: error?.exitCode ?? 1, error
          }, 'Activation audit append failed')}. Re-run to reconcile: ${nextAction.command}`,
          {
            code: 'CAPABILITY_ACTIVATION_AUDIT_PENDING',
            details: capabilityRecovery({
              stage: 'activation-audit', state: 'configuration-active-audit-pending', remote,
              branch: proposalBranch, commit: proposalCommit, nextAction,
              preserved: ['approved-configuration', 'proposal-branch', 'application-branches']
            })
          }
        );
      }
      const activated = {
        status: 'activated',
        activated: true,
        remote,
        branch: proposalBranch,
        proposalCommit,
        targetBranch: CONFIGURATION_BRANCH,
        targetBefore: auditedTargetBefore,
        targetCommit,
        alreadyMerged,
        mergeEvidence,
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
      // The checkout already contains the exact approved configuration commit this activation just
      // validated and (when necessary) pushed. Keep it alive through projection instead of deleting
      // it and cloning the same authority again. Audit remains first: a projection failure therefore
      // has the same recoverable "activation complete, projection pending" contract as before.
      try {
        const projectionAuthority = await session.observeAsync(remote, {
          includeHead: false,
          refs: [`refs/heads/${CONFIGURATION_BRANCH}`],
          refresh: true
        });
        requireRemoteObservation(projectionAuthority, 'configuration authority before projection');
        const currentAuthority = projectionAuthority.refs.get(`refs/heads/${CONFIGURATION_BRANCH}`) ?? null;
        if (currentAuthority !== targetCommit) {
          throw new SingularityFlowError(
            `Approved configuration advanced from ${targetCommit} to ${currentAuthority ?? 'an unavailable ref'} before state projection. Re-publish the current authority instead of mirroring stale bytes.`,
            { code: 'CAPABILITY_PROJECTION_AUTHORITY_MOVED' }
          );
        }
        const state = await publishCapabilityMap(root, {
          message: `Publish reviewed capability map from ${CONFIGURATION_BRANCH}`,
          env
        });
        const projection = { baseBranch: CONFIGURATION_BRANCH, ...state };
        const projectionPending = !projection.published && !projection.branch
          && projection.reason !== 'state publication is disabled';
        const nextAction = projectionPending
          ? { command: capabilityCommand('publish', { remote: url }), skill: '/sf-capability-map' }
          : null;
        return {
          ...activated,
          status: projectionPending ? 'activation-complete-projection-pending'
            : projection.published || projection.branch ? 'activated' : 'activated-without-projection',
          projection: projectionPending ? { ...projection, pending: true, nextAction } : projection,
          nextAction
        };
      } catch (error) {
        const nextAction = { command: capabilityCommand('publish', { remote: url }), skill: '/sf-capability-map' };
        return {
          ...activated,
          status: 'activation-complete-projection-pending',
          projection: {
            published: false, pending: true,
            reason: redactDiagnosticText(error?.message ?? String(error)),
            nextAction
          },
          nextAction
        };
      }
    }, { expectedCommit: confirm });
  return reviewed;
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
  const entries = Object.entries(repositories).filter(([, declared]) => Boolean(declared?.url));
  const workers = Math.max(1, Math.min(4, entries.length || 1));
  // One session is deliberately shared by the whole readiness operation. Apart from coalescing
  // identical remotes, this makes the worker limit real: the old synchronous `observe` blocked the
  // event loop inside each worker, so four repositories paid four serial office-proxy delays before
  // their fetches could become concurrent.
  const gitEnv = enterpriseGitEnvironment();
  const session = new GitRemoteSession({ env: gitEnv });
  const resolved = await mapLimit(entries, workers, async ([id, declared]) => {
    const url = declared?.url;
    const advertised = await session.observeAsync(url, { includeHead: false, includeAllHeads: true });
    const refs = advertised.refs;
    const hasState = advertised.ok && refs.has(`refs/heads/${stateBranch}`);
    const defaultBranch = declared.defaultBranch ?? 'main';
    const inspect = [...new Set([stateBranch, defaultBranch])]
      .filter((branch) => advertised.ok && refs.has(`refs/heads/${branch}`));
    const models = new Map();
    if (inspect.length) {
      const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-ready-'));
      try {
        const transport = frozenRemoteTransport(url, { env: gitEnv });
        run('git', ['init', '--quiet', '--bare', scratch], { env: transport.env });
        const fetched = await runRemoteGitAsync([
          '--git-dir', scratch, 'fetch', '--quiet', '--depth', '1', transport.remote,
          ...inspect.map((branch, index) => `refs/heads/${branch}:refs/heads/read-${index}`)
        ], { operation: 'remote-configuration', env: transport.env });
        if (fetched.status === 0) {
          inspect.forEach((branch, index) => {
            models.set(branch, run('git', [
              '--git-dir', scratch, 'cat-file', '-e',
              `refs/heads/read-${index}:${outputDir}/manifest.json`
            ], { allowFailure: true, env: transport.env }).status === 0);
          });
        }
      } finally {
        await removeTemporaryTree(scratch);
      }
    }
    const onState = hasState && models.get(stateBranch) === true;
    return [id, {
      url,
      stateBranch: hasState ? stateBranch : null,
      hasStateBranch: hasState,
      // Which copy a command would actually read, said plainly rather than left to be worked out.
      worldModel: onState ? 'state-branch' : models.get(defaultBranch) ? defaultBranch : null
    }];
  });
  return Object.fromEntries(resolved);
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
  const inspectAction = {
    command: `singularity-flow capability organisation ${quoted(commandRemote(organisation.url))} --readiness --refresh --json`,
    skill: '/sf-workspace-bootstrap'
  };
  if (!chosen.size) throw new SingularityFlowError('A workspace needs at least one capability.', {
    code: 'WORKSPACE_CAPABILITY_SELECTION_REQUIRED',
    details: capabilityRecovery({
      stage: 'workspace-plan', state: 'selection-required', remote: organisation.url,
      nextAction: inspectAction, preserved: ['capability-map', 'workspace-registry']
    })
  });

  for (const id of chosen) {
    if (!rows.some((row) => row.id === id)) {
      throw new SingularityFlowError(`Unknown capability '${id}' in this organisation. Refresh the approved map and select an active capability.`, {
        code: 'WORKSPACE_CAPABILITY_UNKNOWN',
        details: capabilityRecovery({
          stage: 'workspace-plan', state: 'capability-unknown', remote: organisation.url,
          nextAction: inspectAction, preserved: ['capability-map', 'workspace-registry']
        })
      });
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
      'None of the chosen capabilities ships from a repository, so there would be nothing to work in.', {
        code: 'WORKSPACE_CAPABILITY_HAS_NO_DELIVERY',
        details: capabilityRecovery({
          stage: 'workspace-plan', state: 'delivery-required', remote: organisation.url,
          nextAction: inspectAction, preserved: ['capability-map', 'workspace-registry']
        })
      });
  }

  const lead = leadCapability ?? shipping[0].id;
  const leadRow = covered.find((row) => row.id === lead);
  if (!leadRow) {
    throw new SingularityFlowError(`Lead capability '${lead}' is not among the chosen capabilities. Select a delivery capability included by this workspace.`, {
      code: 'WORKSPACE_LEAD_CAPABILITY_OUTSIDE_SELECTION',
      details: capabilityRecovery({
        stage: 'workspace-plan', state: 'lead-selection-invalid', remote: organisation.url,
        nextAction: inspectAction, preserved: ['capability-map', 'workspace-registry']
      })
    });
  }
  const leadShips = shipsFrom(leadRow);
  if (!leadShips.length) {
    throw new SingularityFlowError(
      `Lead capability '${lead}' does not ship from a repository. The lead is where the workspace's `
      + 'state branch is created, so it has to be one that does.', {
        code: 'WORKSPACE_LEAD_CAPABILITY_HAS_NO_DELIVERY',
        details: capabilityRecovery({
          stage: 'workspace-plan', state: 'lead-delivery-required', remote: organisation.url,
          nextAction: inspectAction, preserved: ['capability-map', 'workspace-registry']
        })
      });
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
          + 'does not declare, so there is nowhere to clone it from.', {
            code: 'WORKSPACE_CAPABILITY_REPOSITORY_UNDECLARED',
            details: capabilityRecovery({
              stage: 'workspace-plan', state: 'repository-undeclared', remote: organisation.url,
              nextAction: inspectAction, preserved: ['capability-map', 'workspace-registry']
            })
          });
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
export async function initializeWorkspaceState(leadDirectory, {
  branch = 'state', push = true, transport = {}
} = {}) {
  const root = path.resolve(leadDirectory);
  // Establish the operation environment before the first repository lookup. GIT_DIR and
  // GIT_WORK_TREE are repository selectors, so reading HEAD or origin with the ambient process
  // environment first could select an attacker-controlled repository and only sanitize later.
  const gitEnv = enterpriseGitEnvironment(transport.env ?? process.env);
  if (!existsSync(path.join(root, '.git'))) {
    throw new SingularityFlowError(`${root} is not a Git repository, so it cannot carry the state branch.`);
  }

  // A delivery repository is not usually governed in its own right — the map lives in the lead of
  // the organisation. But the state branch is written to by the repository the work happens in, so
  // that repository needs a definition naming the branch.
  // A checkout with no commit on the current branch cannot carry a governed branch, and the raw
  // git error for it names an ambiguous argument, which describes git and not the situation.
  const current = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root, env: gitEnv, allowFailure: true
  })
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
  let publicationIntent = null;
  const url = run('git', ['remote', 'get-url', 'origin'], {
    cwd: root, env: gitEnv, allowFailure: true
  }).stdout.trim();
  const repositoryId = repositoryIdFromUrl(url || path.basename(root));
  const exactTransport = url
    ? frozenRemoteTransport(assertCredentialFreeRemote(url), { push: true, env: gitEnv })
    : null;
  const observeBranch = async (candidate) => {
    if (!exactTransport) {
      throw new SingularityFlowError('Workspace initialization requires a readable credential-free origin URL.', {
        code: 'REMOTE_NOT_FOUND'
      });
    }
    const observed = await runRemoteGitAsync([
      'ls-remote', '--heads', '--', exactTransport.remote, `refs/heads/${candidate}`
    ], { cwd: root, operation: 'remote-probe', env: exactTransport.env });
    if (observed.status !== 0) {
      throw new SingularityFlowError(
        `Cannot inspect '${sanitizeRemote(url)}' before workspace initialization. ${observed.failure?.advice ?? 'Git remote access failed.'}`,
        { code: observed.failure?.code ?? 'REMOTE_UNKNOWN' }
      );
    }
    return observed.stdout.trim();
  };
  let resumeGovernancePublication = false;
  if (!needsGovernanceProposal && current.startsWith('sflow/govern/')) {
    resumeGovernancePublication = !(await observeBranch(current));
  }
  if (needsGovernanceProposal) {
    const trackedHead = run('git', [
      'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'
    ], { cwd: root, env: gitEnv, allowFailure: true }).stdout.trim();
    const applicationBranch = trackedHead.startsWith('origin/')
      ? trackedHead.slice('origin/'.length)
      : (trackedHead || 'main');
    if (current !== applicationBranch) {
      throw new SingularityFlowError(
        `Cannot initialize repository governance from '${current}'. Switch to the application branch '${applicationBranch}' first.`
      );
    }
    const sourceHead = run('git', ['rev-parse', 'HEAD'], { cwd: root, env: gitEnv }).stdout.trim();
    governanceBranch = `sflow/govern/${repositoryId}-${sourceHead.slice(0, 8)}`;
    const remoteReview = await observeBranch(governanceBranch);
    if (remoteReview) {
      throw new SingularityFlowError(
        `Governance review branch '${governanceBranch}' already exists. Review or remove that proposal before retrying.`
      );
    }
    const localReview = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${governanceBranch}`], {
      cwd: root, env: gitEnv, allowFailure: true
    });
    if (localReview.status === 0) {
      throw new SingularityFlowError(
        `Local governance review branch '${governanceBranch}' already exists. Resume or remove it before retrying.`
      );
    }
    run('git', ['switch', '-c', governanceBranch], { cwd: root, env: gitEnv });
    if (!governed) {
      await initializeDefinition(root);
      await setDefaultBaseBranch(root, applicationBranch);
    }
    const actor = gitCommitIdentity(root, { env: gitEnv });
    if (!governed && url) {
      await describeRepository(root, repositoryIdFromUrl(url), url, applicationBranch, actor);
    }
    await enableLedger(root, branch);
    run('git', ['add', '--', ...GOVERNED_ROOTS], { cwd: root, env: gitEnv });
    if (run('git', ['diff', '--cached', '--name-only'], { cwd: root, env: gitEnv }).stdout.trim()) {
      run('git', ['-c', `user.name=${actor.name || 'Singularity Flow'}`,
        '-c', `user.email=${actor.email || 'unknown@invalid'}`,
        'commit', '-m', 'Govern this repository with Singularity Flow'], { cwd: root, env: gitEnv });
    }
  }
  if (push && (needsGovernanceProposal || resumeGovernancePublication)) {
    publicationIntent = await createAndPushTransportIntent({
      repositoryRoot: root,
      remote: 'origin',
      sourceCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root, env: gitEnv }).stdout.trim(),
      targetRef: `refs/heads/${governanceBranch}`,
      expectedRemote: null,
      scope: { operation: 'sflow.initialize', repositoryId, governanceBranch }
    }, { ...transport, env: gitEnv });
    governancePublished = publicationIntent.status === 'succeeded';
    publicationError = governancePublished
      ? null
      : `Transport ${publicationIntent.intentId} is ${publicationIntent.status}`;
  }
  if (push && governancePublished && url && governanceBranch.startsWith('sflow/govern/')) {
    await ensureConfigurationBranch(url, {
      sourceBranch: governanceBranch,
      publisherRoot: root,
      transport: { ...transport, env: gitEnv },
      env: gitEnv
    });
  }

  const existed = (await observeBranch(branch)).includes(`refs/heads/${branch}`);
  const ledger = await initializeLedger(
    root,
    { enabled: true, branch, remote: push ? 'origin' : null },
    {
      publish: push && governancePublished,
      // Ledger owns its own single-use alias. Passing an already frozen alias makes Git apply one
      // rewrite and then attempt to resolve the intermediate alias as an SSH host because url.*
      // rewrites are not recursive.
      env: gitEnv,
      transportRemote: url || undefined
    }
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
    publicationIntent: publicationIntent ? {
      intentId: publicationIntent.intentId,
      status: publicationIntent.status,
      sourceCommit: publicationIntent.sourceCommit,
      targetRef: publicationIntent.targetRef
    } : null,
    pinRepair: ledger?.pinRepair ?? null
  };
}
