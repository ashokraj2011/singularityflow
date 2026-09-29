/**
 * Whether a mutation in this repository must first check the build its approved configuration
 * requires.
 *
 * Cheap, because it runs before every mutation: one small machine-local record of the last verdict
 * per repository, and one lstat. The approved read and any install load only when this returns a
 * build.
 *
 * The verdict, not the working tree, decides. Approved configuration lives on `sflow/config`, and a
 * Story pins its own copy when it starts, so neither `main` nor a Story begun before the
 * requirement was merged carries the file. Every repository is therefore read at most once a day
 * per build. A requirement file written after a verdict of none (a new Story's copy) is read at
 * once; one that was already there, such as an unmerged draft, is not read again on every command.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILD_INFO, versionLine } from './build-info.mjs';
import { repositoryGitDirectory } from './git-directory.mjs';
import { PRODUCT_ALIGNMENT_EXEMPT_COMMANDS } from './product-alignment-gate.mjs';

export const PRODUCT_UPDATE_SWITCH = 'SINGULARITY_FLOW_PRODUCT_UPDATE';
export const PRODUCT_REQUIREMENT_CHECKS = 'requirement-checks.json';
/** How long a verdict stands before the approved requirement is read again. */
export const REQUIREMENT_VERDICT_TTL_MS = Object.freeze({
  satisfied: 24 * 60 * 60 * 1000,
  none: 24 * 60 * 60 * 1000,
  development: 24 * 60 * 60 * 1000,
  unknown: 24 * 60 * 60 * 1000,
  unavailable: 60 * 60 * 1000,
  failed: 60 * 60 * 1000
});
/** An unreachable authority is retried sooner only where a requirement is known to exist. */
export const UNAVAILABLE_WITHOUT_REQUIREMENT_FILE_TTL_MS = 6 * 60 * 60 * 1000;

export function requirementChecksFile(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, '.singularity-flow', 'installations', PRODUCT_REQUIREMENT_CHECKS);
}

export function productUpdateDisabled(environment = process.env) {
  return ['off', '0', 'false', 'no'].includes(String(environment?.[PRODUCT_UPDATE_SWITCH] ?? '').trim().toLowerCase());
}

/**
 * The last requirement verdict this machine recorded per repository, newest first. Read-only and
 * local: `singularity-flow product status` shows it without reaching any repository.
 */
export async function recordedRequirementChecks({ homeDirectory = os.homedir() } = {}) {
  let repositories;
  try { repositories = JSON.parse(await readFile(requirementChecksFile(homeDirectory), 'utf8'))?.repositories ?? {}; }
  catch { return Object.freeze([]); }
  return Object.freeze(Object.entries(repositories)
    .filter(([, entry]) => entry && typeof entry === 'object' && typeof entry.verdict === 'string')
    .map(([repository, entry]) => Object.freeze({
      repository,
      verdict: entry.verdict,
      build: typeof entry.build === 'string' ? entry.build : null,
      checkedAt: typeof entry.checkedAt === 'string' ? entry.checkedAt : null,
      required: typeof entry.required === 'string' ? entry.required : null,
      code: typeof entry.code === 'string' ? entry.code : null,
      reason: typeof entry.reason === 'string' ? entry.reason : null
    }))
    .sort((left, right) => String(right.checkedAt ?? '').localeCompare(String(left.checkedAt ?? ''))));
}

/**
 * The repository a verdict belongs to: its main checkout, whichever of its checkouts asked.
 *
 * Keyed by the asking checkout, every new Story worktree had no verdict of its own, so the "daily"
 * read of approved configuration ran on the first mutation in each one — in practice on nearly every
 * isolated Story start. The requirement belongs to the repository's approved configuration, which
 * every checkout shares. A main checkout's key is its own path, as before.
 */
export async function requirementRepositoryKey(root) {
  const shared = repositoryGitDirectory(root);
  const anchor = shared ? (path.basename(shared) === '.git' ? path.dirname(shared) : shared) : root;
  return realpath(anchor).catch(() => path.resolve(anchor));
}

/** The last requirement verdict this machine recorded for one repository, or null. Never throws. */
export async function priorRequirementCheck({ homeDirectory = os.homedir(), root } = {}) {
  try {
    const key = await requirementRepositoryKey(root);
    return JSON.parse(await readFile(requirementChecksFile(homeDirectory), 'utf8'))?.repositories?.[key] ?? null;
  } catch {
    return null;
  }
}

/** The running build line when the requirement must be checked now, or null. Never throws. */
export async function productRequirementDue({
  root,
  command,
  classification,
  homeDirectory = os.homedir(),
  environment = process.env,
  info = BUILD_INFO,
  now = Date.now()
} = {}) {
  try {
    if (!root || classification !== 'mutation' || PRODUCT_ALIGNMENT_EXEMPT_COMMANDS.has(command)) return null;
    if (productUpdateDisabled(environment)) return null;
    if (!info?.commit && !info?.sourceSha256) return null;
    const running = versionLine(info);
    const entry = await priorRequirementCheck({ homeDirectory, root });
    if (entry?.build !== running) return running;
    const requirement = await lstat(path.join(root, 'singularity', 'product.yml')).catch(() => null);
    const file = Boolean(requirement?.isFile());
    const checkedAt = Date.parse(entry.checkedAt ?? '');
    if (file && entry.verdict === 'none' && !(requirement.mtimeMs <= checkedAt)) return running;
    const ttl = entry.verdict === 'unavailable' && !file
      ? UNAVAILABLE_WITHOUT_REQUIREMENT_FILE_TTL_MS
      : REQUIREMENT_VERDICT_TTL_MS[entry.verdict];
    if (ttl && now - checkedAt < ttl) return null;
    return running;
  } catch {
    return null;
  }
}
