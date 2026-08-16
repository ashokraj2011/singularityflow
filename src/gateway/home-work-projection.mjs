/**
 * The shared state projection behind every home surface.
 *
 * This is deliberately a pure derivation rather than a process-global mutable store. CLI commands,
 * Copilot skills, and the long-lived VS Code host do not share a process, so an in-memory singleton
 * would give each surface a different "global" value. They can, however, share one definition of
 * current, visible, and recoverable work and derive it from the same durable records.
 */
import { WORK_GROUP_ORDER } from './work-records.mjs';

function branchesOf(item) {
  return [...new Set([item?.branch, ...(item?.branches ?? [])]
    .map((entry) => String(entry ?? '').trim()).filter(Boolean))];
}
function inRepository(item, repositoryId) {
  if (!repositoryId) return true;
  return item.repositoryId === repositoryId;
}

function matchesCurrent(item, { storyId = null, repositoryId = null, branch = null } = {}) {
  if (storyId) return item.id === storyId && inRepository(item, repositoryId);
  if (!branch || !inRepository(item, repositoryId)) return false;
  return branchesOf(item).includes(branch);
}

/**
 * Derive one answer to "what work is current here?" from governed work records.
 *
 * `repositoryScoped` is used by a planner that was handed exactly one repository but no selected
 * branch (for example a deterministic unit fixture). A workspace surface always supplies its
 * repository and branch and therefore never promotes another repository's first active item.
 */
export function deriveHomeState(records = {}, {
  storyId = null,
  repositoryId = null,
  branch = null,
  repositoryScoped = false
} = {}) {
  const items = Array.isArray(records.items) ? records.items : [];
  const groups = Object.fromEntries(WORK_GROUP_ORDER.map((group) => [
    group,
    Array.isArray(records.groups?.[group]) ? records.groups[group] : items.filter((item) => item.group === group)
  ]));
  const allItems = items.length ? items : WORK_GROUP_ORDER.flatMap((group) => groups[group]);
  const groupOf = (item) => item?.group
    ?? WORK_GROUP_ORDER.find((group) => groups[group].includes(item))
    ?? null;
  const actionable = allItems.filter((item) => groupOf(item) !== 'recently-completed');
  let currentWork = actionable.find((item) => matchesCurrent(item, { storyId, repositoryId, branch })) ?? null;

  // A repository-only read with no branch selector preserves the long-standing deterministic
  // behavior: its first recovery or active item leads. Supplying a branch disables this fallback.
  if (!currentWork && repositoryScoped && !storyId && !branch) {
    currentWork = groups['recovery-required'][0] ?? groups.active[0] ?? null;
  }

  const recoveryWork = groupOf(currentWork) === 'recovery-required' ? currentWork : null;
  const activeWork = groupOf(currentWork) === 'active' ? currentWork : null;
  const counts = Object.fromEntries(WORK_GROUP_ORDER.map((group) => [group, groups[group].length]));
  const ordered = [
    ...(recoveryWork
      ? [recoveryWork, ...groups['recovery-required'].filter((item) => item.id !== recoveryWork.id
        || item.repositoryId !== recoveryWork.repositoryId)]
      : groups['recovery-required']),
    ...(currentWork && !recoveryWork ? [currentWork] : []),
    ...groups.active.filter((item) => item.id !== currentWork?.id || item.repositoryId !== currentWork?.repositoryId),
    ...groups['waiting-on-you'].filter((item) => item.id !== currentWork?.id || item.repositoryId !== currentWork?.repositoryId),
    ...groups['waiting-on-others'].filter((item) => item.id !== currentWork?.id || item.repositoryId !== currentWork?.repositoryId),
    ...groups['recently-completed']
  ];

  return Object.freeze({
    items: allItems,
    groups,
    counts: Object.freeze(counts),
    currentWork,
    activeWork,
    recoveryWork,
    ordered: Object.freeze(ordered),
    activeCount: actionable.length,
    completedCount: counts['recently-completed'],
    visibleCount: allItems.length,
    needsYourDecision: counts['waiting-on-you']
  });
}
