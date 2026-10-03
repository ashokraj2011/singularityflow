/**
 * Changed application files found by a step that does not deliver code [E2G-022].
 *
 * Every gate that meets such a change asks this one evaluator instead of composing its own advice.
 * It keeps the bytes (nothing is reverted or adopted), maps each changed path to the plan rows that
 * name it, and so to their implement and verify obligations and the code steps that own them, and
 * compiles the returns the workflow permits from where the Story stands:
 * - while the step is in progress and its approval policy may return to the owning step, which is
 *   approved, the change goes back with `reject <step> --to <owner> --repair`;
 * - once the step awaits approval, with a plain `reject <step> --to <owner>`;
 * - a completed Story reopens at the owner when its last step may return there;
 * - a path no plan row names is accounted for with `decision plan` first.
 * Any step that delivers code may own a path; nothing assumes a step named "Code". A Story that
 * plans no claims gives every change to the closest earlier code step.
 */
import path from 'node:path';
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { completionPhaseOf } from '../lifecycle-transitions.mjs';
import { loadActiveSpecRecords, mergePlannedClaimRecords, plannedSupportingFiles } from '../specifications.mjs';
import { gateRefusal } from './gate-refusal.mjs';
import { obligationId } from './vocabulary.mjs';

/** Which plan rows name a path: as a planned location (implement and verify) or a planned test (verify). */
function rowsNaming(planned, accounted, candidate) {
  const rows = [];
  for (const [clauseId, claim] of Object.entries(planned)) {
    if ((claim.expectedPaths ?? []).includes(candidate) || (accounted[clauseId] ?? []).includes(candidate)) rows.push({ clauseId, claim, as: 'source' });
    else if ((claim.tests ?? []).includes(candidate)) rows.push({ clauseId, claim, as: 'test' });
  }
  return rows;
}

/** `records` are the Story's active specification records, read from the work item when omitted. */
export async function crossPhaseChange(root, config, workflow, phase, changedPaths, { records: given = null } = {}) {
  const workId = workflow.workItem.id;
  const order = workflow.phaseOrder ?? [];
  const here = order.indexOf(phase.id);
  const codeSteps = order.slice(0, Math.max(0, here)).filter((id) => phaseRequiresCodeDelivery(workflow.phases[id]));
  const paths = [...new Set(changedPaths.filter(Boolean))].sort();
  const records = given ?? await loadActiveSpecRecords(path.join(root, config.workItemRoot ?? 'singularity/work-items', workId), workflow);
  const planned = mergePlannedClaimRecords(records.planned ?? []);
  const accounted = Object.assign({}, ...(records.planned ?? []).map((record) => record.accountedPaths ?? {}));
  const supporting = new Set(plannedSupportingFiles(records.planned ?? []));
  const plansClaims = Object.keys(planned).length > 0;
  const obligations = new Map();
  const owners = new Set();
  const unplanned = [];
  for (const candidate of paths) {
    const rows = rowsNaming(planned, accounted, candidate);
    if (!rows.length && !supporting.has(candidate) && plansClaims) unplanned.push(candidate);
    for (const { clauseId, claim, as } of rows) {
      const allocated = (claim.steps ?? []).filter((step) => codeSteps.includes(step));
      const steps = allocated.length ? allocated : codeSteps.slice(-1);
      for (const step of steps) owners.add(step);
      for (const responsibility of as === 'source' ? ['implement', 'verify'] : ['verify']) {
        const id = obligationId(workId, responsibility, clauseId);
        const entry = obligations.get(id) ?? { id, responsibility, subject: clauseId, owningSteps: steps, status: 'stale', paths: [] };
        entry.paths.push(candidate);
        obligations.set(id, entry);
      }
    }
  }
  // A path no row names, a supporting change, or a Story without planned claims belongs to the
  // closest earlier code step.
  if ((unplanned.length || !owners.size) && codeSteps.length) owners.add(codeSteps.at(-1));
  const closed = workflow.status === 'closed';
  const completion = closed ? completionPhaseOf(workflow) : null;
  const returns = order.filter((id) => owners.has(id)).map((step) => {
    if (closed) {
      const permitted = (completion?.approvalPolicy?.rejectTo ?? []).includes(step);
      return { step, permitted, command: `singularity-flow reopen ${workId} --to ${step} --reason <REASON>`,
        reason: permitted ? null : `'${completion?.id}' may not return completed work to '${step}'` };
    }
    const allowed = (phase.approvalPolicy?.rejectTo ?? []).includes(step);
    if (phase.status === 'awaiting_approval') {
      return { step, permitted: allowed, command: `singularity-flow reject ${phase.id} --to ${step} --reason <REASON>`,
        reason: allowed ? null : `'${phase.id}' may not return work to '${step}'` };
    }
    const permitted = allowed && workflow.currentPhase === phase.id && phase.status === 'in_progress' && workflow.phases[step]?.status === 'approved';
    return { step, permitted, command: `singularity-flow reject ${phase.id} --to ${step} --repair --reason <REASON>`,
      reason: permitted ? null : !allowed ? `'${phase.id}' may not return work to '${step}'` : `'${step}' is not approved yet` };
  });
  return {
    phase: phase.id, paths,
    obligations: [...obligations.values()],
    owners: order.filter((id) => owners.has(id)),
    unplanned,
    returns,
    checkpoint: returns.find((entry) => entry.permitted)?.step ?? order.filter((id) => owners.has(id)).at(-1) ?? null
  };
}

/** The sentence a refusal adds, and the gate-refusal record it carries, for a cross-phase change. */
export function describeCrossPhaseChange(change, { code, gate, workflow, phase }) {
  const permitted = change.returns.filter((entry) => entry.permitted);
  const subjects = [...new Set(change.obligations.map((entry) => entry.subject))];
  // The return comes first: it is what the reader does next.
  const sentences = [];
  if (permitted.length) sentences.push(`Return them with: ${permitted.map((entry) => entry.command).join(' or ')}.`);
  else if (change.returns.length) {
    sentences.push(`Return them to ${change.owners.join(', ')}; no return is permitted from here (${change.returns.map((entry) => entry.reason).join('; ')}), so ask for an authorized workflow return with singularity-flow nextsteps --json.`);
  }
  sentences.push('They stay in your worktree; nothing was reverted or adopted.');
  if (subjects.length) sentences.push(`They change ${subjects.join(', ')}, owned by ${change.owners.join(', ')}.`);
  if (change.unplanned.length) {
    sentences.push(`No plan row names ${change.unplanned.join(', ')}: account for each with singularity-flow decision plan --add-location <clause>=<path> --reason <reason>, or move it out of the worktree.`);
  }
  const actions = [
    ...(change.unplanned.length ? ['singularity-flow decision plan --add-location <clause>=<path> --reason <reason>'] : []),
    ...permitted.map((entry) => entry.command)
  ];
  return {
    text: sentences.join(' '),
    gate: gateRefusal({
      code, gate, subject: { workId: workflow.workItem.id, phase: phase.id, generation: phase.generation },
      obligations: change.obligations, findings: [{ code, message: `Application files changed in '${phase.id}': ${change.paths.join(', ')}.` }],
      actions, checkpoint: change.checkpoint,
      preserved: { state: 'worktree', description: `The changed files stay in the worktree: ${change.paths.join(', ')}.` }
    })
  };
}
