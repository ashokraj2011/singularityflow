import {codeCandidateScopeRequired} from './kernel/phase-policy.mjs';
import {codeDeliveryCandidateScope,plannedCodeStepPaths} from './engine-compatibility/node-source-policy.mjs';
/**
 * What a code step's candidate may contain [E2G-027, decision D9].
 *
 * A changed file belongs to the candidate when the plan names it for this step: an expected path
 * of a row allocated here, a planned test, a supporting change, or a path a plan amendment
 * accounted for. Test automation always belongs, because tests verify rather than ship. Every other
 * changed application file is excluded from local candidate verification. Publication requires the
 * person to account for it or preserve it privately first; it is never silently adopted or discarded.
 * Tests still run in the worktree, so an excluded file that could change what they
 * execute requires isolation. File extensions do not prove irrelevance: text may be a test fixture
 * or executable MDX/doctest input. Null when the Story plans no claims, so every change is the candidate.
 */
import path from 'node:path';
import { loadActiveSpecRecords } from './specifications.mjs';
import { applicationPathContext, isApplicationChangePath } from './engine-compatibility/node-source-policy.mjs';

/** Dirty files excluded from this delivery must be accounted for before it is published. */
export async function unreconciledCandidatePaths(root, config, workflow, phase, scope = undefined) {
  scope = scope === undefined ? await codeCandidateScope(
    path.join(root, config.workItemRoot ?? workflow.resolution?.workItemRoot ?? 'singularity/work-items', workflow.workItem.id), workflow, phase) : scope;
  if (!scope) return [];
  const context = applicationPathContext(config, workflow);
  const { inspectLifecycleWorktree } = await import('./lifecycle-worktree.mjs');
  return [...new Set(inspectLifecycleWorktree(root, config, workflow).entries.flatMap(entry =>
    [entry.path, entry.originalPath].filter(item => item?.kind === 'utf8').map(item => ({ path: item.value, untracked: entry.type === 'untracked' })))
    .filter(item => isApplicationChangePath(item.path, { ...context, untracked: item.untracked }) && !scope.allows(item.path))
    .map(item => item.path))].sort();
}

export async function codeCandidateScope(itemDirectory,workflow,phase) {
  if(!codeCandidateScopeRequired(workflow,phase))return null;
  const records=await loadActiveSpecRecords(itemDirectory,workflow);
  return codeDeliveryCandidateScope(records.planned??[],workflow,phase);
}

/** The paths the plan names for a code step: expected source paths and planned tests, before any change. */
export async function plannedStepPaths(itemDirectory,workflow,phase) {
  if(!codeCandidateScopeRequired(workflow,phase))return {sourcePaths:[],testPaths:[]};
  const records=await loadActiveSpecRecords(itemDirectory,workflow);
  return plannedCodeStepPaths(records.planned??[],workflow,phase);
}

/**
 * Whether a changed file is outside every code step's candidate: no step's plan names it as an
 * expected path, test, supporting change or amendment [E2G-027]. Local verification runs without
 * that file (src/candidate-isolation.mjs). Publication requires the person to reconcile its dirty
 * bytes through narrow accounting or confirmed private preservation first.
 * Null when the Story scopes no code candidate, so every change is the candidate.
 */
export async function outsideEveryCandidate(itemDirectory, workflow) {
  const scopes = [];
  for (const id of workflow?.phaseOrder ?? []) {
    const scope = await codeCandidateScope(itemDirectory, workflow, workflow.phases?.[id]).catch(() => null);
    if (scope) scopes.push(scope);
  }
  if (!scopes.length) return null;
  return (candidate) => scopes.every((scope) => !scope.allows(candidate));
}
