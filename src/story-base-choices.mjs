/**
 * A new Story with no base named (STORY_BASE_REQUIRED), loaded only when start refuses for it. Its bases are named, the
 * usual one first, and refusal-remediation.mjs runs the same start again once per branch, or once with each repository's
 * own usual branch, so nobody types a branch name [audit 2026-11-19, entry 12].
 */
import { localRefHeads, remoteDefaultBranchName, remoteNames } from './git.mjs';
import { SingularityFlowError } from './util.mjs';

/** The local-only refusal, before any remote or configuration discovery, with the complete new-Story input shape. */
export function storyBaseRequired(id, { branches = [] } = {}) {
  const inspectCommand = `singularity-flow workspace branches --preflight-story ${id} --json`;
  return new SingularityFlowError(
    `Choose the branch Story '${id}' starts from${branches.length ? `: ${branches.join(', ')}` : ''}. A new manual one also needs `
    + `--work-type, --title and --description; to resume it: singularity-flow resume ${id} --fetch.`,
    { code: 'STORY_BASE_REQUIRED', details: { ...(branches.length ? { branches, defaultBranch: branches[0] } : { nextAction: inspectCommand }),
      requiredChoices: ['base', 'workflow', 'intake-source'],
      recoveryCommands: [`singularity-flow resume ${id} --fetch`] } }
  );
}

/** The bases this clone already knows, its remote's default first; nothing is fetched. */
export function localStoryBases(root) {
  const remote = remoteNames(root)[0] ?? 'origin';
  let usual = null;
  try { usual = remoteDefaultBranchName(root, {}, remote); } catch { usual = null; }
  const known = [...new Set([usual, 'main', 'master', 'develop'].filter(Boolean))];
  const present = localRefHeads(root, known.map((name) => `refs/remotes/${remote}/${name}`));
  return known.filter((name) => present.has(`refs/remotes/${remote}/${name}`));
}

/** A capability's refusal: the bases published in every repository, the usual one first, or each repository's own. */
export function capabilityBaseRequired(catalog, { usableChoices, defaults, defaultBranch, perRepository }) {
  const usual = defaults[catalog.repositoryId] ?? defaultBranch;
  const branches = usableChoices.map((choice) => choice.branch).sort((left, right) => (right === usual) - (left === usual));
  const repositoryBases = perRepository ? Object.fromEntries(catalog.repositories
    .filter((repository) => (catalog.published?.[repository.id] ?? []).includes(defaults[repository.id]))
    .map((repository) => [repository.id, defaults[repository.id]])) : null;
  return new SingularityFlowError(perRepository
    ? `No branch is published in every repository, so each one starts from its own. ${catalog.repositories.map((repository) => `${repository.id}: ${defaults[repository.id] ?? 'no default'}`).join('; ')}.`
    : branches.length ? `Choose the branch this Story starts from: ${branches.map((branch) => (branch === usual ? `${branch} (the usual one)` : branch)).join(', ')}.`
      : 'No branch to start a Story from is published yet.',
  { code: 'STORY_BASE_REQUIRED', details: { branches, defaultBranch: usual, ...(repositoryBases ? { repositoryBases } : {}) } });
}
