/**
 * The code a comprehension view explains: application files only.
 *
 * Singularity Flow's own files are not code to explain. That means its governed roots
 * (`singularity/`, `.github/agents/` and every root the repository configures), its machine-local
 * state under `.singularity-flow/` (Story worktrees, caches), Git metadata, and untracked
 * tool-owned output. Without this filter a Story's own records filled an explanation with dozens of
 * units nobody wrote. They are counted, never dropped silently.
 *
 * Every comprehension capture (the IDE slice, `explain code`, `explain --subject`, and the
 * `comprehension` commands that resolve its region references) builds its change set here, so a
 * region identity means the same thing to all of them.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

import { applicationPathContext, isApplicationChangePath } from '../application-paths.mjs';
import { buildRepositoryChangeSet, repositoryChangeSetDigest } from '../repository-change-set.mjs';

const MACHINE_STATE_ROOT = '.singularity-flow';
const MAX_HIDDEN_GROUPS = 20;
const MAX_DIFF_PATHS = 2_000;

/**
 * The repository's definition file as written, or an empty object when it is absent or unreadable.
 * Full definition loading validates agents and templates too, and one malformed agent file must
 * not turn a configured work-item root back into code to explain.
 */
export async function comprehensionDefinition(root) {
  try {
    const parsed = YAML.parse(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The repository's governed roots, read from its definition file itself. */
export async function comprehensionPathContext(root) {
  try {
    return applicationPathContext(await comprehensionDefinition(root));
  } catch {
    // A definition whose roots cannot be read keeps the built-in roots.
    return applicationPathContext();
  }
}

/** Whether a repository-relative path is code an explanation may show. */
export function isExplainedPath(path, pathContext, { untracked = false } = {}) {
  if (typeof path !== 'string' || !path) return false;
  if (path === MACHINE_STATE_ROOT || path.startsWith(`${MACHINE_STATE_ROOT}/`)) return false;
  try {
    return isApplicationChangePath(path, { ...pathContext, untracked });
  } catch {
    // A path no rule can classify stays visible rather than disappearing from the explanation.
    return true;
  }
}

function isExplainedEntry(entry, pathContext) {
  return [entry?.oldPath, entry?.newPath].filter(Boolean).some((candidate) => isExplainedPath(candidate, pathContext, {
    untracked: entry?.untracked === true && candidate === entry?.newPath
  }));
}

/** The first two path segments name a group: `singularity/work-items`, `.github/agents`. */
function hiddenGroup(entry) {
  const path = entry?.newPath ?? entry?.oldPath ?? '';
  return path.split('/').slice(0, 2).join('/');
}

/**
 * Project a change set onto the code it may explain. The digest is recomputed over what remains, so
 * integrity checks and region identities hold for the projection; HEAD stays, because the diff
 * preview reads the same baseline-to-working-tree interval.
 */
export function codeScopeProjection(changeSet, pathContext) {
  const { digest: _digest, ...core } = changeSet;
  const kept = [];
  const hidden = [];
  for (const entry of core.entries ?? []) (isExplainedEntry(entry, pathContext) ? kept : hidden).push(entry);
  const projection = { ...core, entries: kept };
  const groups = new Map();
  for (const entry of hidden) groups.set(hiddenGroup(entry), (groups.get(hiddenGroup(entry)) ?? 0) + 1);
  return {
    changeSet: { ...projection, digest: repositoryChangeSetDigest(projection) },
    hidden: Object.freeze({
      entries: hidden.length,
      groups: Object.freeze([...groups].sort(([left], [right]) => left.localeCompare(right, 'en'))
        .slice(0, MAX_HIDDEN_GROUPS)
        .map(([group, entries]) => Object.freeze({ group, entries })))
    })
  };
}

/**
 * Diff options for a projected change set. Git would otherwise patch the hidden files too, and the
 * preview pairs patch sections with entries one to one. Past MAX_DIFF_PATHS paths the command line
 * would grow unbounded, and such a change exceeds the preview's byte limit anyway.
 */
export function comprehensionDiffOptions(changeSet, hidden) {
  if (!hidden?.entries) return {};
  const paths = [...new Set(changeSet.entries.filter((entry) => !entry.untracked)
    .flatMap((entry) => [entry.oldPath, entry.newPath]).filter(Boolean))];
  return paths.length <= MAX_DIFF_PATHS ? { paths } : {};
}

/** A comprehension change set: the baseline-to-working-tree record, projected onto explained code. */
export async function buildComprehensionChangeSet(root, options, pathContext = null) {
  const context = pathContext ?? await comprehensionPathContext(root);
  return codeScopeProjection(await buildRepositoryChangeSet(root, options), context);
}
