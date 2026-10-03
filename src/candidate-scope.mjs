/**
 * What a code step's candidate may contain [E2G-027, decision D9].
 *
 * A changed file belongs to the candidate when the plan names it for this step: an expected path
 * of a row allocated here, a planned test, a supporting change, or a path a plan amendment
 * accounted for. Test automation always belongs, because tests verify rather than ship. Every other
 * changed application file is excluded: it stays in the worktree, untouched, and is neither adopted
 * nor committed. Tests still run in the worktree, so an excluded file that could change what they
 * execute makes the delivery unsafe and is refused; one that cannot (a note or other prose) is
 * preserved and reported. Null when the Story plans no claims, so every change is the candidate.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { isAllowedTestAutomationPath } from './code-delivery-tests.mjs';
import { accountedAmendmentPaths } from './plan-amendments.mjs';
import { loadActiveSpecRecords, mergePlannedClaimRecords, plannedSupportingFiles } from './specifications.mjs';

const PROSE = /\.(?:md|markdown|mdx|rst|adoc|txt)$/iu;

export async function codeCandidateScope(itemDirectory, workflow, phase) {
  if (!phaseRequiresCodeDelivery(phase) || workflow?.resolution?.plannedClaims?.mode !== 'required') return null;
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const planned = mergePlannedClaimRecords(records.planned ?? []);
  const allowed = new Set();
  for (const claim of Object.values(planned)) {
    if ((claim.steps ?? []).length && !claim.steps.includes(phase.id)) continue;
    for (const candidate of [...(claim.expectedPaths ?? []), ...(claim.tests ?? [])]) allowed.add(candidate);
  }
  for (const candidate of plannedSupportingFiles(records.planned ?? [])) allowed.add(candidate);
  for (const candidate of accountedAmendmentPaths(records.planned ?? [])) allowed.add(candidate);
  return Object.freeze({
    allows: (candidate) => allowed.has(candidate) || isAllowedTestAutomationPath(candidate),
    /** Whether an excluded file could change what the tests execute in the worktree. */
    unsafe: (candidate) => !PROSE.test(candidate)
  });
}

/**
 * Whether a file is prose that no code step's plan names [E2G-027]. Such a file is kept out of
 * every generation, so it is also kept out of the application tree a publication, submission or
 * approval binds: a person may edit or delete their note without making the tested code stale.
 * Never true when the Story scopes no code candidate.
 */
export async function keptOutProse(itemDirectory, workflow) {
  const scopes = [];
  for (const id of workflow?.phaseOrder ?? []) {
    const scope = await codeCandidateScope(itemDirectory, workflow, workflow.phases?.[id]).catch(() => null);
    if (scope) scopes.push(scope);
  }
  if (!scopes.length) return () => false;
  return (candidate) => PROSE.test(candidate) && scopes.every((scope) => !scope.allows(candidate));
}
