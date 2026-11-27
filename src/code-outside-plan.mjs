/**
 * Code outside the plan [WCB, docs/SPEC-WCB-WATCH-CODE-BASE-v1.md]: owner, 2026-11-27, "If any code changes that was
 * not agreed upon in planning phase, surface it, let copilot explain if it has touched, add the reason in documents and
 * carry forward. If human has done, let them do it and move forward."
 *
 *   governedCodeBase   where a code step's first work interval starts: where code was last governed [REQ-008]
 *   codeCommittedWithoutCodeStep  code committed on a Story with no code step, its one stop [REQ-017]
 *   codeLeftInCheckout the code base files a Story with no code step leaves in the checkout, listed at its approval [REQ-017]
 *
 * Nothing here refuses, asks or holds.
 */
import { applicationPathContext, isApplicationChangePath } from './application-paths.mjs';
import { isWorkspaceLocalPath } from './workspace-local-paths.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';

/**
 * The commit a code step's first work interval starts from [WCB:REQ-008]: the latest published commit of an earlier code
 * step, else the Story's base, when a commit since then changed an application file (code committed while a document
 * step was open), so the code step's change set holds it and its clause and test checks cover it. Null otherwise: the
 * interval starts at HEAD, as it always did.
 */
export async function governedCodeBase(root, config, workflow, phase) {
  if (!phaseRequiresCodeDelivery(phase) || Number(phase?.generation ?? 0) > 0 || phase?.generationIntent) return null;
  try {
    const [{ commitIsAncestor, committedChangedPaths, head }, { publishedGenerationCommit }] = await Promise.all([
      import('./git.mjs'), import('./generation-publication-store.mjs')]);
    const order = workflow.phaseOrder ?? [];
    const earlier = order.slice(0, Math.max(0, order.indexOf(phase.id))).map((id) => workflow.phases?.[id])
      .filter((step) => phaseRequiresCodeDelivery(step) && Number(step?.generation ?? 0) > 0);
    let base = workflow.workItem?.baseCommit ?? null;
    const last = earlier.at(-1);
    if (last) {
      try { base = publishedGenerationCommit(root, workflow, last, last.generation) ?? base; } catch { /* The Story's base. */ }
    }
    const current = head(root);
    if (!base || base === current || !commitIsAncestor(root, base, current)) return null;
    const context = applicationPathContext(config, workflow);
    const code = committedChangedPaths(root, base).filter((file) => !isWorkspaceLocalPath(file) && isApplicationChangePath(file, context));
    return code.length ? base : null;
  } catch { return null; }
}

/**
 * Code committed on the branch of a Story with no code step at all [WCB:REQ-017]: a docs, investigate or review task, or a
 * team workflow with none. Nothing would check it against a clause and a test, and it would reach the pull request, so it is
 * the one code base change such a Story stops for. Only commits on the Story's own line (no merge brings one) that changed
 * a code base file count; `{ paths, commits, takeOut }`, commits newest first, or null. A Story with a code step, or no
 * base, is never asked.
 */
export async function codeCommittedWithoutCodeStep(root, config, workflow) {
  if ((workflow?.phaseOrder ?? []).some((id) => phaseRequiresCodeDelivery(workflow.phases?.[id]))) return null;
  const base = workflow?.workItem?.baseCommit;
  if (!base) return null;
  try {
    const { commitChangedPaths, commitsChangingSince, committedChangedPaths } = await import('./git.mjs');
    const context = applicationPathContext(config, workflow);
    const code = (file) => !isWorkspaceLocalPath(file) && isApplicationChangePath(file, context);
    const changed = committedChangedPaths(root, base).filter(code);
    if (!changed.length) return null;
    const commits = commitsChangingSince(root, base, changed, { limit: 20 });
    const paths = [...new Set(commits.flatMap((entry) => commitChangedPaths(root, entry.commit)).filter((file) => changed.includes(file)))].sort();
    if (!commits.length || !paths.length) return null;
    return { paths, commits, takeOut: `git revert --no-edit ${commits.map((entry) => entry.commit.slice(0, 12)).join(' ')}` };
  } catch { return null; }
}

/**
 * The code base files left uncommitted in the checkout of a Story with no code step [WCB:REQ-017]: nothing delivers them,
 * so its approval lists them as not part of the task, and nothing stops for them. Null for a Story with a code step.
 */
export async function codeLeftInCheckout(root, config, workflow) {
  if ((workflow?.phaseOrder ?? []).some((id) => phaseRequiresCodeDelivery(workflow.phases?.[id]))) return null;
  try {
    const { inspectLifecycleWorktree } = await import('./lifecycle-worktree.mjs');
    const context = applicationPathContext(config, workflow);
    return [...new Set(inspectLifecycleWorktree(root, config, workflow).entries.flatMap((entry) => [entry.path, entry.originalPath]
      .filter((item) => item?.kind === 'utf8' && !isWorkspaceLocalPath(item.value)
        && isApplicationChangePath(item.value, { ...context, untracked: entry.type === 'untracked' })).map((item) => item.value)))].sort();
  } catch { return null; }
}
