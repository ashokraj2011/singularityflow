/**
 * Keep the approvals rework did not touch [E2G-021, decisions D8 and D16].
 *
 * A rejection or a reopen resets its target and every phase after it, because what a later phase
 * depends on is known only once the phases before it complete again. When a phase completes and
 * the next one was approved before that reset, its approval is compared with the Story as it is
 * now: when every upstream reference it decided over is byte-identical (rule E1) and its artifacts
 * and phase inputs still verify, the approval is retained instead of the phase running again. The
 * retained approval is a new record that names the rule and the approval it carries; the reset that
 * invalidated the original stays in its history. A phase that feeds or follows a decision, a skill
 * phase, a phase whose earlier completion was automatic, and a range a decision's loop or a changed
 * document or design source reopened always run again.
 */
import path from 'node:path';
import { approvalRequirementsMet } from './approval-authority.mjs';
import { retainedByRule } from './evidence/equivalence-rules.mjs';
import { verifyInputsIntegrity } from './inputs.mjs';
import { changedUpstream, phaseUpstream } from './phase-upstream.mjs';
import { snapshot } from './util.mjs';
import { decisionAfter, decisionFedBy } from './workflow-decisions.mjs';

const actorKey = (actor) => actor?.login ?? actor?.email ?? actor?.name ?? null;

/** The approvals a reset invalidated and that may be retained, or null when the phase must run again. */
export function retainableApprovals(workflow, phase) {
  const reset = phase?.reworkRevalidation;
  if (!reset?.retainable || phase.status !== 'not_started' || !(phase.generation > 0)
      || Number(phase.generation) !== Number(reset.generation)) return null;
  if (decisionAfter(workflow, phase.id) || decisionFedBy(workflow, phase.id)) return null;
  const approvals = (phase.approvals ?? []).filter((entry) => entry?.decision === 'approved'
    && entry.invalidatedAt === reset.invalidatedAt && Number(entry.generation) === Number(phase.generation));
  if (!approvals.length || approvals.some((entry) => !entry.upstream?.sha256)) return null;
  // Whether these approvals completed the phase, judged as they stood before the reset.
  const decided = approvals.map(({ invalidatedAt, ...approval }) => approval);
  return approvalRequirementsMet(phase.approvalPolicy, decided) ? approvals : null;
}

async function artifactsUnchanged(root, phase) {
  for (const artifact of phase.artifacts ?? []) {
    const current = await snapshot(path.join(root, artifact.path));
    if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) return false;
  }
  return true;
}

function retain(workflow, phase, approvals, { at, actor, agent, upstream }) {
  const carried = [];
  for (const approval of approvals) {
    const { invalidatedAt, invalidationReason, invalidatedBy, retained: earlier, ...decided } = approval;
    const record = {
      ...structuredClone(decided), at,
      retained: retainedByRule('E1', { approvalAt: earlier?.approvalAt ?? approval.at, invalidatedAt, upstreamSha256: upstream.sha256 })
    };
    phase.approvals.push(record);
    carried.push(record);
  }
  // The phase reads as it did when its approval completed it, so phases that bound it as an
  // input still match it.
  const completing = [...approvals].sort((left, right) => String(left.at).localeCompare(String(right.at))).at(-1);
  phase.status = 'approved';
  phase.approvedAt = completing.retained?.approvalAt ?? completing.at;
  phase.approvedBy = actorKey(completing.actor);
  phase.retention = { rule: 'E1', at, generation: phase.generation, upstreamSha256: upstream.sha256 };
  delete phase.reworkRevalidation;
  workflow.history.push({
    at, actor: actorKey(actor), agent: agent ?? null, event: 'phase_retained', phase: phase.id,
    detail: `Retained by rule E1: everything its approval decided over is byte-identical (${approvals.length} approval${approvals.length === 1 ? '' : 's'} carried).`
  });
  return carried;
}

/**
 * After `completed` completes on the linear path: retain each following phase that qualifies, in
 * order, stopping at the first that must run again. Returns the retained phase ids with the
 * approvals carried for each, and, when a phase could have been retained but changed, which
 * references changed.
 */
export async function retainUnchangedPhases(root, config, workflow, completed, { at, actor = null, agent = null } = {}) {
  const order = workflow.phaseOrder ?? [];
  const itemRelative = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const itemDirectory = path.join(root, itemRelative);
  const retained = [];
  let stale = null;
  for (let index = order.indexOf(completed.id) + 1; index > 0 && index < order.length; index += 1) {
    const phase = workflow.phases[order[index]];
    const approvals = retainableApprovals(workflow, phase);
    if (!approvals) break;
    const upstream = await phaseUpstream(root, config, workflow, phase);
    const differing = approvals.find((entry) => entry.upstream.sha256 !== upstream?.sha256);
    if (differing) { stale = { phase: phase.id, changed: changedUpstream(differing.upstream, upstream) }; break; }
    if (!(await artifactsUnchanged(root, phase))) { stale = { phase: phase.id, changed: ['artifacts'] }; break; }
    const inputs = await verifyInputsIntegrity(root, workflow, phase, { itemDirectory, itemRelative });
    if (inputs.errors.length || inputs.warnings.length) { stale = { phase: phase.id, changed: ['inputs'] }; break; }
    retained.push({ phase: phase.id, approvals: retain(workflow, phase, approvals, { at, actor, agent, upstream }) });
  }
  return { retained, stale };
}
