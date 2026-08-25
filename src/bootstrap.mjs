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
 *   4. Name the person running this in every Story and Initiative approval group, so a new
 *      repository cannot defer its first authorization failure until an approval ceremony.
 *   5. Write the capability map with the capability described.
 *   6. Commit on a review branch, establish the orphan configuration and state branches, and push.
 *
 * Step six is why this is one operation rather than a checklist: the state branch has no shared
 * ancestry with the code branch, so creating it is not something a person stumbles into.
 */
import path from 'node:path';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import YAML from 'yaml';
import { SingularityFlowError, run, YAML_OUTPUT } from './util.mjs';

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

  // A freshly generated configuration must not defer its first authorization failure until the
  // first approval ceremony. Name the person establishing the authority in every Initiative group
  // and, below, every Story group. Existing memberships remain intact; bootstrap only appends the
  // current identity when it is absent.
  if (actor.email) {
    const authorities = document.getIn(['approvalAuthorities']);
    for (const item of authorities?.items ?? []) {
      const key = String(item.key?.value ?? item.key);
      const members = document.getIn(['approvalAuthorities', key, 'members']);
      const current = members?.toJSON?.() ?? [];
      if (current.some((member) => member?.email?.toLowerCase() === actor.email.toLowerCase())) continue;
      document.setIn(['approvalAuthorities', key, 'members'], document.createNode([
        ...current, { name: actor.name || actor.email, email: actor.email }
      ]));
    }
  }

  await writeFile(file, document.toString(YAML_OUTPUT), 'utf8');

  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const workflow = YAML.parseDocument(await readFile(workflowFile, 'utf8'));
  if (actor.email) {
    const authorities = workflow.getIn(['approvalAuthorities']);
    for (const item of authorities?.items ?? []) {
      const key = String(item.key?.value ?? item.key);
      const members = workflow.getIn(['approvalAuthorities', key, 'members']);
      const current = members?.toJSON?.() ?? [];
      if (current.some((member) => member?.email?.toLowerCase() === actor.email.toLowerCase())) continue;
      workflow.setIn(['approvalAuthorities', key, 'members'], workflow.createNode([
        ...current, { name: actor.name || actor.email, email: actor.email }
      ]));
    }
  }
  await writeFile(workflowFile, workflow.toString(YAML_OUTPUT), 'utf8');
  return { declared: repositoryId };
}

/** Pin a freshly initialized workflow to the application's detected integration branch. */
export async function setDefaultBaseBranch(root, defaultBranch) {
  const file = path.join(root, 'singularity/workflow.yml');
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  document.set('defaultBaseBranch', String(defaultBranch).trim());
  await writeFile(file, document.toString(YAML_OUTPUT), 'utf8');
}

export async function setGroundingMode(root, mode) {
  const file = path.join(root, 'singularity/workflow.yml');
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  const worldModel = document.get('worldModel');
  if (!worldModel) return;
  worldModel.set('grounding', String(mode).trim());
  await writeFile(file, document.toString(YAML_OUTPUT), 'utf8');
}

/**
 * Write the capability map, with the capability this bootstrap was given as its initial top-level node.
 *
 * Replaces the starter map rather than adding to it. `init` writes a placeholder capability so that
 * a repository is never without a map. Naming what the repository builds replaces that placeholder;
 * additional top-level capabilities may be added later.
 */
export async function describeCapability(root, {
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
 * @param capability what this organisation builds, as its initial top-level capability.
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
  grounding = null,
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
    // Say what is happening before the longest wait in the command. A clone of any size sat behind
    // piped stdio with nothing on screen, so bootstrap looked hung at exactly the point where it is
    // doing the most obvious work.
    console.log(`Cloning ${remote} into ${root} …`);
    const result = run('git', ['clone', '--branch', branch, remote, root], { allowFailure: true });
    if (result.status !== 0) {
      throw new SingularityFlowError(`Cannot clone '${remote}': ${(result.stderr || result.stdout).trim().split('\n')[0]}`);
    }
  }
  // Nothing is written to a code branch. The configuration authority is the orphan `sflow/config`
  // branch, and `start` materializes the approved revision from it into each Story branch — so the
  // definition never needs to exist on the application branch at all. That is the whole reason a
  // protected `main` is a non-issue here rather than something to work around.
  //
  // This used to initialize the definition into the checkout, commit it to a `sflow/govern/...`
  // review branch, push that, and seed `sflow/config` *from* the review branch. The definition then
  // existed twice, the copy on the code branch was never the authority — `start` overwrote it from
  // `sflow/config` anyway — and the merge it demanded blocked all work until someone approved a
  // pull request the design did not actually need.
  const published = { configuration: false, state: false, error: null };
  let configuration = null;
  if (!push) {
    // `--no-push` has no remote to establish the authority on, so it does the only useful thing
    // left: writes the definition into the checkout, uncommitted, so the caller can see exactly what
    // would be governed. Nothing is committed and nothing is published — inspect it, then delete it
    // or re-run without the flag.
    const { initializeDefinition } = await import('./config.mjs');
    const actor = identity(root);
    const wrote = await initializeDefinition(root);
    if (wrote.includes('singularity/workflow.yml')) await setDefaultBaseBranch(root, branch);
    await describeRepository(root, repositoryId, remote, branch, actor);
    await describeCapability(root, { capabilityId, capabilityName, kind, repositoryId, jiraProject, teams });
    if (grounding) await setGroundingMode(root, grounding);
    if (stateBranch) await enableLedger(root, stateBranch);
  }
  if (push) {
    const { ensureConfigurationBranch } = await import('./configuration-branch.mjs');
    configuration = await ensureConfigurationBranch(remote, {
      grounding,
      capability: { capabilityId, capabilityName, kind, repositoryId, jiraProject, teams }
    });
    published.configuration = true;
  }

  // The ledger is branch-independent. Keep it local when --no-push is used, and do not publish it
  // ahead of a governance proposal that failed to reach the remote.
  let ledger = null;
  if (stateBranch) {
    ledger = await initializeLedger(
      root,
      { enabled: true, branch: stateBranch, remote: 'origin' },
      { publish: push }
    );
    published.state = Boolean(push && ledger);
  }

  return {
    root,
    repositoryId,
    url: remote,
    branch,
    cloned,
    capability: capabilityId,
    configurationBranch: configuration?.branch ?? null,
    configurationCreated: Boolean(configuration?.created),
    stateBranch: stateBranch ?? null,
    ledgerCreated: Boolean(ledger?.created),
    published
  };
}
