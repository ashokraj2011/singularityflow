/**
 * Turning a repository that knows nothing about Singularity Flow into the one everything else
 * starts from.
 *
 * Every piece of this already existed and none of them composed. `init` governs a repository you
 * have already cloned. `workspace create` clones repositories but needs a lead that is already
 * governed. `capability add` writes a map into a repository that already has a `singularity/`
 * directory. So the first step — go from a URL and the name of what your organisation builds to a
 * repository the rest of the product can read — was the one thing you could not do with the
 * product, which is a poor place for the only chicken-and-egg problem to be.
 *
 * What this does, in the order it has to happen:
 *
 *   1. Clone the repository, or adopt a checkout that is already there.
 *   2. Write `singularity/` — workflow, portfolio, templates, agents.
 *   3. Declare the repository in the portfolio, so a capability may deliver from it.
 *   4. Name the person running this as an approval authority, because an Epic cannot start until
 *      at least one authority has a member and discovering that later is a poor greeting.
 *   5. Write the capability map with the capability described.
 *   6. Commit, create the orphan state branch, and push both.
 *
 * Step six is why this is one operation rather than a checklist: the state branch has no shared
 * ancestry with the code branch, so creating it is not something a person stumbles into.
 */
import path from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import { SingularityFlowError, run, YAML_OUTPUT } from './util.mjs';
import { initializeDefinition } from './config.mjs';
import { CAPABILITIES_PATH, CAPABILITY_KINDS, validateCapabilities } from './capabilities.mjs';
import { initializeLedger } from './ledger.mjs';
import { remoteDefaultBranch } from './workspace.mjs';
import { identity } from './git.mjs';

/** The repository identifier a clone URL implies: the last segment, minus `.git`. */
export function repositoryIdFromUrl(url) {
  const id = String(url ?? '')
    // Trailing slashes first: a URL written `…/platform.git/` ends in a slash, so `.git$` does not
    // match and the suffix survives into the identifier.
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
 * Declare the repository, and name whoever is running this as an approver.
 *
 * Rewritten as text rather than parsed and re-emitted: the starter portfolio is mostly commentary
 * explaining each setting, and a YAML round trip would throw all of it away on the very first
 * thing anybody does to the file.
 */
export async function describeRepository(root, repositoryId, url, defaultBranch, actor) {
  const file = path.join(root, 'singularity/portfolio.yml');
  const document = YAML.parseDocument(await readFile(file, 'utf8'));

  // Edited as a document rather than as text. A first attempt appended a `repositories:` block when
  // it could not find an empty one, and the starter file declares `repositories: {}` — so the file
  // ended up with the key twice and would not parse at all. setIn knows where the key already is.
  document.setIn(['repositories', repositoryId], document.createNode({
    url, defaultBranch, required: true
  }));

  // An Epic cannot start until an approval authority has a member. Naming the person doing this is
  // the only answer that is true on a repository nobody else has touched yet; adding colleagues is
  // an edit they can make from the portfolio once there is something to approve.
  if (actor.email) {
    const authorities = document.getIn(['approvalAuthorities']);
    for (const item of authorities?.items ?? []) {
      const key = String(item.key?.value ?? item.key);
      const members = document.getIn(['approvalAuthorities', key, 'members']);
      if (members?.items?.length) continue;
      document.setIn(['approvalAuthorities', key, 'members'], document.createNode([
        { name: actor.name || actor.email, email: actor.email }
      ]));
    }
  }

  await writeFile(file, document.toString(YAML_OUTPUT), 'utf8');
  return { declared: repositoryId };
}

/**
 * Write the capability map, with the capability this bootstrap was given as its only root.
 *
 * Replaces the starter map rather than adding to it. `init` writes a placeholder root so that a
 * repository is never without a map, and a tree may have exactly one root — so adding here would
 * fail with "requires exactly one root", which describes the rule and not the situation. Naming
 * your own capability is the entire point of this operation, so the placeholder gives way to it.
 */
async function describeCapability(root, {
  capabilityId, capabilityName, kind, repositoryId, jiraProject, teams
}) {
  const capability = {
    name: capabilityName ?? capabilityId,
    kind,
    parent: null,
    ...(kind === 'delivery' ? { repository: repositoryId } : {}),
    ...(jiraProject ? { jira: { projectKey: jiraProject } } : {}),
    ...(teams.length ? { teams } : {})
  };
  const document = YAML.stringify({ version: 1, capabilities: { [capabilityId]: capability } });
  const text = [
    '# What this organisation builds. The lead repository holds this map; every other repository is',
    '# something a capability delivers.',
    '#',
    '# Kind is structural: a collection groups related capabilities; a delivery ships from one or',
    '# more repositories and may still contain children. Policy folds from this root toward each child and every fold is',
    '# monotonic, so a child may tighten what an ancestor set and can never loosen it.',
    '',
    document
  ].join('\n');

  // Validated before it is written, like every other path that touches this file.
  validateCapabilities(YAML.parse(text));
  await writeFile(path.join(root, CAPABILITIES_PATH), text, 'utf8');
}

/** Turn the ledger on in the workflow definition, so the orphan branch is actually written to. */
export async function enableLedger(root, branch) {
  const file = path.join(root, 'singularity/workflow.yml');
  const text = await readFile(file, 'utf8');
  const block = `ledger:\n  enabled: true\n  branch: ${branch}\n  remote: origin\n`;
  await writeFile(file, /^ledger:/m.test(text)
    ? text.replace(/^ledger:\n(?:[ \t]+.*\n)*/m, block)
    : `${text.replace(/\n*$/, '')}\n\n${block}`, 'utf8');
}

/**
 * @param url the repository to govern.
 * @param capability what this organisation builds, as its root capability.
 * @param into where to clone. Defaults to a directory named after the repository.
 * @param stateBranch the orphan branch recording workflow progress; null to skip it.
 * @param push whether to publish. False is for trying this out, and for tests.
 */
export async function bootstrapRepository(url, {
  capabilityId,
  capabilityName = null,
  kind = 'collection',
  jiraProject = null,
  teams = [],
  into = null,
  base = null,
  stateBranch = 'state',
  push = true
} = {}) {
  const remote = String(url ?? '').trim();
  if (!remote) throw new SingularityFlowError('A repository URL is required.');
  if (!capabilityId) throw new SingularityFlowError('A capability identifier is required.');
  if (!CAPABILITY_KINDS.includes(kind)) {
    throw new SingularityFlowError(`Capability kind must be one of: ${CAPABILITY_KINDS.join(', ')}.`);
  }

  const repositoryId = repositoryIdFromUrl(remote);
  const root = into
    ? path.resolve(into)
    : path.join(path.resolve(base ?? process.cwd()), repositoryId);

  // Named rather than left to HEAD. A repository whose HEAD points at a branch that never appeared
  // clones into a detached head on a default-named local branch, and `rev-parse --abbrev-ref HEAD`
  // then answers "HEAD" — which was recorded as the default branch and is not a branch.
  const branch = remoteDefaultBranch(
    remote,
    run('git', ['ls-remote', '--symref', remote, 'HEAD'], { allowFailure: true }).stdout
  );

  // Clone, or adopt a checkout that is already there. Adopting matters because the first attempt at
  // this may have failed after cloning, and asking somebody to delete a directory to retry is a
  // poor recovery story.
  const cloned = !existsSync(path.join(root, '.git'));
  if (cloned) {
    if (existsSync(root) && (await readdir(root)).length) {
      throw new SingularityFlowError(`${root} already exists and is not a Git repository.`);
    }
    await mkdir(path.dirname(root), { recursive: true });
    const result = run('git', ['clone', '--branch', branch, remote, root], { allowFailure: true });
    if (result.status !== 0) {
      throw new SingularityFlowError(`Cannot clone '${remote}': ${(result.stderr || result.stdout).trim().split('\n')[0]}`);
    }
  }
  const actor = identity(root);

  const wrote = await initializeDefinition(root);
  await describeRepository(root, repositoryId, remote, branch, actor);
  await describeCapability(root, {
    capabilityId, capabilityName, kind, repositoryId, jiraProject, teams
  });

  if (stateBranch) await enableLedger(root, stateBranch);

  run('git', ['add', 'singularity'], { cwd: root });
  const staged = run('git', ['diff', '--cached', '--name-only'], { cwd: root }).stdout.trim();
  let commit = null;
  if (staged) {
    run('git', ['-c', `user.name=${actor.name || 'Singularity Flow'}`,
      '-c', `user.email=${actor.email || 'unknown@invalid'}`,
      'commit', '-m', `Govern ${repositoryId} with Singularity Flow`], { cwd: root });
    commit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  }

  // The orphan branch comes after the commit: it is initialized from a worktree of this repository,
  // and it records that this repository is now governed.
  let ledger = null;
  if (stateBranch) {
    ledger = await initializeLedger(root, { enabled: true, branch: stateBranch, remote: 'origin' });
  }

  const published = { branch: false, state: false, error: null };
  if (push) {
    const pushed = run('git', ['push', 'origin', `HEAD:${branch}`], { cwd: root, allowFailure: true });
    published.branch = pushed.status === 0;
    // The ledger pushes itself during initialization, so the state branch is already published when
    // there is a remote; this only records what happened.
    published.state = Boolean(ledger && !ledger.created ? true : ledger?.created);
    if (!published.branch) {
      published.error = (pushed.stderr || pushed.stdout).trim().split('\n')[0];
    }
  }

  return {
    root,
    repositoryId,
    url: remote,
    branch,
    cloned,
    capability: capabilityId,
    stateBranch: stateBranch ?? null,
    ledgerCreated: Boolean(ledger?.created),
    wrote,
    commit,
    published
  };
}
