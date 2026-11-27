/**
 * What a code step's candidate may contain [E2G-027, decision D9].
 *
 * A changed file belongs to the candidate when the plan names it for this step: an expected path
 * of a row allocated here, a planned test, a supporting change, a path a plan amendment
 * accounted for, a file of one of its departures [CQF:REQ-022], or a file publication took up because
 * it changed outside the plan [WCB:REQ-010]. Test automation always belongs, because tests verify
 * rather than ship. Every other changed application file is excluded from local candidate
 * verification until publication takes it up; it is never silently discarded.
 * Tests still run in the worktree, so an excluded file that could change what they
 * execute requires isolation. File extensions do not prove irrelevance: text may be a test fixture
 * or executable MDX/doctest input. Null when the Story plans no claims, so every change is the candidate.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import path from 'node:path';
import { isAllowedTestAutomationPath } from './code-delivery-tests.mjs';
import { accountedAmendmentPaths, classificationContext, departureCandidatePaths, outsidePlanSettled } from './plan-amendments.mjs';
import { loadActiveSpecRecords, mergePlannedClaimRecords, plannedSupportingFiles } from './specifications.mjs';
import { applicationPathContext, isApplicationChangePath } from './application-paths.mjs';
import { isWorkspaceLocalPath } from './workspace-local-paths.mjs';
import { storyLocation } from './story-paths.mjs';

/** Dirty files excluded from this delivery must be accounted for before it is published. */
export async function unreconciledCandidatePaths(root, config, workflow, phase, scope = undefined) {
  scope = scope === undefined ? await codeCandidateScope(
    storyLocation(root, [config, workflow], workflow.workItem.id).directory, workflow, phase) : scope;
  if (!scope) return [];
  const context = applicationPathContext(config, workflow);
  const { inspectLifecycleWorktree } = await import('./lifecycle-worktree.mjs');
  return [...new Set(inspectLifecycleWorktree(root, config, workflow).entries.flatMap(entry =>
    [entry.path, entry.originalPath].filter(item => item?.kind === 'utf8').map(item => ({ path: item.value, untracked: entry.type === 'untracked' })))
    // A workspace-local file (an editor's settings, a local-only file, test output) stays out of the code, as any file no plan
    // names, but is never asked about [WCB:REQ-002].
    .filter(item => isApplicationChangePath(item.path, { ...context, untracked: item.untracked }) && !scope.allows(item.path)
      && !isWorkspaceLocalPath(item.path))
    .map(item => item.path))].sort();
}

// A key or certificate SFlow never commits on its own (settle-before-publication.mjs keeps the same rule).
const SECRET_SHAPED = /(?:^|\/)(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|[^/]+\.(?:pem|key|p12|pfx|keystore|jks))$/iu;

/**
 * The dirty files publication leaves out of a code step and cannot take up itself [WCB:REQ-010]: a protected path, a hard
 * stop, a key or certificate, and a file a person already holds (a departure they rejected, its file not restored; a settlement they undid; a
 * departure still waiting). Every other file no plan row names is taken up with the step at publication, so nothing read
 * before it asks about one.
 */
export async function heldCandidatePaths(root, config, workflow, phase, scope = undefined) {
  const files = await unreconciledCandidatePaths(root, config, workflow, phase, scope);
  if (!files.length) return files;
  const held = await (await import('./code-outside-plan.mjs')).personHeldFiles(workflow, phase.id);
  const guarded = [...(config?.governance?.protectedPaths ?? []), ...(workflow?.resolution?.capability?.policy?.protectedPaths ?? [])]
    .map((entry) => String(entry).replace(/\/$/u, ''));
  return files.filter((file) => held.has(file) || SECRET_SHAPED.test(file) || guarded.some((entry) => file === entry || file.startsWith(`${entry}/`)));
}

export async function codeCandidateScope(itemDirectory, workflow, phase) {
  if (!phaseRequiresCodeDelivery(phase) || workflow?.resolution?.plannedClaims?.mode !== 'required') return null;
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  const planned = mergePlannedClaimRecords(records.planned ?? []);
  const allowed = new Set();
  const others = new Set();
  for (const claim of Object.values(planned)) {
    const elsewhere = (claim.steps ?? []).length && !claim.steps.includes(phase.id);
    for (const candidate of [...(claim.expectedPaths ?? []), ...(claim.tests ?? [])]) (elsewhere ? others : allowed).add(candidate);
  }
  // A page object this Story settled as test support is one here too, as in every other reader [C3, 2026-11-19].
  for (const candidate of plannedSupportingFiles(records.planned ?? [], classificationContext(workflow))) allowed.add(candidate);
  for (const candidate of accountedAmendmentPaths(records.planned ?? [])) allowed.add(candidate);
  // A departure's files are published with the step that recorded it [CQF:REQ-022]; a file another
  // step's plan names stays that step's, so publication still refuses it here.
  for (const candidate of departureCandidatePaths(workflow, phase.id)) if (!others.has(candidate)) allowed.add(candidate);
  // A file SFlow took up with this step because it changed outside the plan, by Copilot or by a person [WCB:REQ-010].
  for (const { file } of outsidePlanSettled(workflow, phase.id)) if (!others.has(file)) allowed.add(file);
  return Object.freeze({
    allows: (candidate) => allowed.has(candidate) || isAllowedTestAutomationPath(candidate),
    /** Whether an excluded file could change what the tests execute in the worktree. */
    unsafe: () => true
  });
}

/** The paths the plan names for a code step: expected source paths and planned tests, before any change. */
export async function plannedStepPaths(itemDirectory, workflow, phase) {
  const sourcePaths = new Set(); const testPaths = new Set();
  if (!phaseRequiresCodeDelivery(phase) || workflow?.resolution?.plannedClaims?.mode !== 'required') return { sourcePaths: [], testPaths: [] };
  const records = await loadActiveSpecRecords(itemDirectory, workflow);
  for (const claim of Object.values(mergePlannedClaimRecords(records.planned ?? []))) {
    if ((claim.steps ?? []).length && !claim.steps.includes(phase.id)) continue;
    for (const candidate of claim.expectedPaths ?? []) sourcePaths.add(candidate);
    for (const candidate of claim.tests ?? []) testPaths.add(candidate);
  }
  return { sourcePaths: [...sourcePaths].sort(), testPaths: [...testPaths].sort() };
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
