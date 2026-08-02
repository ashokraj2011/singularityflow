/**
 * Mapping a git repository to a capability, without asking anybody where to put a checkout.
 *
 * The capability map lives in the lead repository — that has not changed, and should not: it is
 * governed configuration and belongs in Git beside everything else it governs. What was wrong was
 * making a person clone that repository, choose a folder for it, and keep it, purely so the map
 * could be edited. Cloning is a workspace's job, and a workspace is created for doing work, not for
 * describing what exists.
 *
 * So this clones into a temporary directory, edits, pushes, and discards. The lead repository is
 * the durable record; the checkout was never the point.
 *
 * The one thing kept on the machine is a pointer: which repositories hold a map. Reading a map
 * requires knowing where it is, and asking for the same URL on every screen is a worse answer than
 * remembering the handful a person works with.
 */
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import { SingularityFlowError, run, readJson } from './util.mjs';
import { CAPABILITIES_PATH, validateCapabilities, capabilityTree } from './capabilities.mjs';
import { atomicJson, remoteDefaultBranch } from './workspace.mjs';
import { identity } from './git.mjs';
import { initializeDefinition } from './config.mjs';
import { describeRepository, enableLedger, repositoryIdFromUrl } from './bootstrap.mjs';
import { initializeLedger } from './ledger.mjs';

const PORTFOLIO_PATH = 'singularity/portfolio.yml';

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

/**
 * Borrow a lead repository for the length of one edit.
 *
 * A shallow clone of one branch, into a temporary directory that is removed however this ends. The
 * caller mutates the checkout and says what the commit is for; pushing and cleaning up happen here
 * so that no caller can forget either.
 */
async function withLeadCheckout(url, message, mutate) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.');

  const branch = remoteDefaultBranch(
    remote,
    run('git', ['ls-remote', '--symref', remote, 'HEAD'], { allowFailure: true }).stdout
  );
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-lead-'));
  try {
    const cloned = run('git', ['clone', '--quiet', '--depth', '1', '--branch', branch, remote, scratch],
      { allowFailure: true });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${remote}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`);
    }

    const result = await mutate(scratch, branch);

    const staged = run('git', ['add', '-A'], { cwd: scratch, allowFailure: true });
    if (staged.status !== 0) throw new SingularityFlowError('Could not stage the change.');
    if (!run('git', ['diff', '--cached', '--name-only'], { cwd: scratch }).stdout.trim()) {
      return { ...result, changed: false, pushed: false, commit: null };
    }

    const actor = identity(scratch);
    run('git', ['-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', message], { cwd: scratch });
    const commit = run('git', ['rev-parse', 'HEAD'], { cwd: scratch }).stdout.trim();

    // Pushed here rather than left for later: the temporary checkout is about to be deleted, so a
    // commit that is not pushed is a commit that never existed.
    const pushed = run('git', ['push', 'origin', `HEAD:${branch}`], { cwd: scratch, allowFailure: true });
    if (pushed.status !== 0) {
      throw new SingularityFlowError(
        `The change could not be pushed to '${remote}': ${(pushed.stderr || pushed.stdout).trim().split('\n')[0]}`);
    }
    return { ...result, changed: true, pushed: true, commit, branch };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** The capability map a lead repository holds, read without keeping a checkout. */
export async function readOrganisation(url) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A lead repository URL is required.');
  const branch = remoteDefaultBranch(
    remote,
    run('git', ['ls-remote', '--symref', remote, 'HEAD'], { allowFailure: true }).stdout
  );
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'sflow-read-'));
  try {
    const cloned = run('git', ['clone', '--quiet', '--depth', '1', '--no-checkout',
      '--branch', branch, remote, scratch], { allowFailure: true });
    if (cloned.status !== 0) {
      throw new SingularityFlowError(
        `Cannot read '${remote}': ${(cloned.stderr || cloned.stdout).trim().split('\n')[0]}`);
    }
    const shown = run('git', ['show', `HEAD:${CAPABILITIES_PATH}`], { cwd: scratch, allowFailure: true });
    if (shown.status !== 0) return { url: remote, branch, capabilities: [], repositories: {}, governed: false };

    const definition = validateCapabilities(YAML.parse(shown.stdout));
    const portfolio = run('git', ['show', `HEAD:${PORTFOLIO_PATH}`], { cwd: scratch, allowFailure: true });
    return {
      url: remote,
      branch,
      capabilities: capabilityTree(definition),
      repositories: portfolio.status === 0 ? (YAML.parse(portfolio.stdout)?.repositories ?? {}) : {},
      governed: true
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Map a git repository to a capability, in the lead repository's map.
 *
 * A capability that names a repository is a leaf that ships; one that does not groups the
 * capabilities beneath it. So `repository` is what makes this a mapping rather than a grouping, and
 * it is declared in the portfolio at the same time — a capability pointing at a repository nobody
 * configured looks fine until something tries to clone it.
 *
 * @param leadUrl the repository holding the map. When it holds none yet, this call establishes it.
 */
export async function mapCapability(leadUrl, {
  capabilityId,
  name = null,
  kind = 'service',
  parent = null,
  repositoryUrl = null,
  jiraProject = null,
  teams = []
} = {}) {
  if (!capabilityId) throw new SingularityFlowError('A capability identifier is required.');

  return withLeadCheckout(leadUrl, `Map capability ${capabilityId}`, async (root) => {
    // The first capability governs the repository it is mapped into.
    //
    // Requiring a governed lead before the first capability could be mapped was the product's one
    // circular dependency: to map a capability you needed a map, and the only way to get a map was
    // to map a capability. Governing here costs one extra write on exactly one operation — the
    // first — and every later map finds the file already there.
    const governed = existsSync(path.join(root, CAPABILITIES_PATH));
    if (!governed) {
      const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }).stdout.trim();
      await initializeDefinition(root);
      await describeRepository(root, repositoryIdFromUrl(leadUrl), leadUrl, branch, identity(root));
      // The orphan branch is named in the definition now and created when a workspace is
      // initialised, which is the point at which there is a checkout to create it from.
      await enableLedger(root, 'state');
    }

    // The repository, if one was given, declared in the portfolio so the capability may name it.
    let repositoryId = null;
    if (repositoryUrl) {
      repositoryId = repositoryIdOf(repositoryUrl);
      const branch = remoteDefaultBranch(
        repositoryUrl,
        run('git', ['ls-remote', '--symref', repositoryUrl, 'HEAD'], { allowFailure: true }).stdout
      );
      const file = path.join(root, PORTFOLIO_PATH);
      const portfolio = YAML.parseDocument(await readFile(file, 'utf8'));
      portfolio.setIn(['repositories', repositoryId], portfolio.createNode({
        url: repositoryUrl, defaultBranch: branch, required: true
      }));
      await writeFile(file, portfolio.toString({ flowCollectionPadding: false }), 'utf8');
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
    set('kind', kind);
    set('parent', parent || null);
    if (repositoryId) set('repository', repositoryId);
    if (jiraProject) set('jira.projectKey', jiraProject);
    if (teams.length) set('teams', teams);

    // Validated against the portfolio in the same checkout, so a repository the map names is one
    // the portfolio declares — refused here rather than at clone time.
    const portfolio = existsSync(path.join(root, PORTFOLIO_PATH))
      ? YAML.parse(await readFile(path.join(root, PORTFOLIO_PATH), 'utf8'))
      : null;
    validateCapabilities(document.toJS(), portfolio);
    await writeFile(file, document.toString({ flowCollectionPadding: false }), 'utf8');

    return { capabilityId, repositoryId, parent: parent || null };
  });
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

  const covered = rows.filter((row) => chosen.has(row.id)
    || row.ancestors.some((ancestor) => chosen.has(ancestor)));
  const shipping = covered.filter((row) => row.repository);
  if (!shipping.length) {
    throw new SingularityFlowError(
      'None of the chosen capabilities ships from a repository, so there would be nothing to work in.');
  }

  const lead = leadCapability ?? shipping[0].id;
  const leadRow = covered.find((row) => row.id === lead);
  if (!leadRow) {
    throw new SingularityFlowError(`Lead capability '${lead}' is not among the chosen capabilities.`);
  }
  if (!leadRow.repository) {
    throw new SingularityFlowError(
      `Lead capability '${lead}' does not ship from a repository. The lead is where the workspace's `
      + 'state branch is created, so it has to be one that does.');
  }

  const repositories = {};
  for (const row of shipping) {
    const declared = organisation.repositories?.[row.repository];
    if (!declared?.url) {
      throw new SingularityFlowError(
        `Capability '${row.id}' ships from '${row.repository}', which the organisation's portfolio `
        + 'does not declare, so there is nowhere to clone it from.');
    }
    repositories[row.repository] = {
      url: declared.url,
      defaultBranch: declared.defaultBranch ?? 'main',
      required: true,
      path: `repos/${row.repository}`
    };
  }

  return {
    repositories,
    leadRepository: leadRow.repository,
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

  const governed = existsSync(path.join(root, 'singularity/workflow.yml'));
  if (!governed) {
    await initializeDefinition(root);
    const actor = identity(root);
    const url = run('git', ['remote', 'get-url', 'origin'], { cwd: root, allowFailure: true }).stdout.trim();
    if (url) await describeRepository(root, repositoryIdFromUrl(url), url, current, actor);
    await enableLedger(root, branch);
    run('git', ['add', 'singularity'], { cwd: root });
    if (run('git', ['diff', '--cached', '--name-only'], { cwd: root }).stdout.trim()) {
      run('git', ['-c', `user.name=${actor.name || 'Singularity Flow'}`,
        '-c', `user.email=${actor.email || 'unknown@invalid'}`,
        'commit', '-m', 'Govern this repository with Singularity Flow'], { cwd: root });
    }
    if (push) run('git', ['push', 'origin', `HEAD:${current}`], { cwd: root, allowFailure: true });
  } else {
    await enableLedger(root, branch);
  }

  const existed = run('git', ['ls-remote', '--heads', 'origin', branch], { cwd: root, allowFailure: true })
    .stdout.includes(`refs/heads/${branch}`);
  const ledger = await initializeLedger(root, { enabled: true, branch, remote: push ? 'origin' : null });
  return { root, branch, governed, existed, created: Boolean(ledger?.created) };
}
