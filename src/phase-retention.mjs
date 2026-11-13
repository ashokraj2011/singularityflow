/**
 * Keep the approvals rework did not touch [E2G-021, decisions D8 and D16].
 *
 * A rejection or a reopen resets its target and every phase after it, because what a later phase
 * depends on is known only once the phases before it complete again. When a phase completes and
 * the next one was approved before that reset, its approval is compared with the Story as it is
 * now: when every upstream reference it decided over is byte-identical (rule E1) and its artifacts
 * and phase inputs still verify, the approval is retained instead of the phase running again. The
 * retained approval is a new record that names the rule and the approval it carries; the reset that
 * invalidated the original stays in its history. When the only difference is a producer approved
 * again with the same authored text, which the phase saw exactly as it is now, rule E9 keeps it and
 * records which producer generations and bytes it was carried to. A phase that feeds or follows a decision, a skill
 * phase, a phase whose earlier completion was automatic, and a range a decision's loop or a changed
 * document or design source reopened always run again.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { approvalRequirementsMet } from './approval-authority.mjs';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { stepResponsibilities } from './phase-roles.mjs';
import { retainedByRule } from './evidence/equivalence-rules.mjs';
import { authoredInputsUnchanged, verifyInputsIntegrity } from './inputs.mjs';
import { authoredEquivalence, changedUpstream, phaseUpstream } from './phase-upstream.mjs';
import { snapshot } from './util.mjs';
import { decisionAfter, decisionFedBy } from './workflow-decisions.mjs';

const actorKey = (actor) => actor?.login ?? actor?.email ?? actor?.name ?? null;

/** The approvals a reset invalidated and that may be retained, or null when the phase must run again. */
export function retainableApprovals(workflow, phase, { counts = null } = {}) {
  const reset = phase?.reworkRevalidation;
  if (!reset?.retainable || phase.status !== 'not_started' || !(phase.generation > 0)
      || Number(phase.generation) !== Number(reset.generation)) return null;
  if (decisionAfter(workflow, phase.id) || decisionFedBy(workflow, phase.id)) return null;
  // On a Story SF Guard requires, only a verified or excepted approval is carried [SPEC-PSS-v1 REQ-030].
  const approvals = (phase.approvals ?? []).filter((entry) => entry?.decision === 'approved'
    && entry.invalidatedAt === reset.invalidatedAt && Number(entry.generation) === Number(phase.generation) && (!counts || counts(entry)));
  if (!approvals.length || approvals.some((entry) => !entry.upstream?.sha256)) return null;
  // Whether these approvals completed the phase, judged as they stood before the reset.
  const decided = approvals.map(({ invalidatedAt, ...approval }) => approval);
  return approvalRequirementsMet(phase.approvalPolicy, decided) ? approvals : null;
}

async function artifactsUnchanged(root, phase) {
  for (const artifact of phase.artifacts ?? []) {
    // An artifact that cannot be read is not shown unchanged: its step runs again [CIC:REQ-020].
    const current = await snapshot(path.join(root, artifact.path)).catch(() => null);
    if (!current) return false;
    if (current.exists !== artifact.exists || current.size !== artifact.size || current.sha256 !== artifact.sha256) return false;
  }
  return true;
}

function retain(workflow, phase, approvals, { at, actor, agent, upstream, rule = 'E1', producers = [] }) {
  const carried = [];
  for (const approval of approvals) {
    const { invalidatedAt, invalidationReason, invalidatedBy, retained: earlier, ...decided } = approval;
    const record = {
      ...structuredClone(decided), at,
      retained: retainedByRule(rule, { approvalAt: earlier?.approvalAt ?? approval.at, invalidatedAt, upstreamSha256: upstream.sha256 })
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
  // Under E9 the producers' approval is not final yet; settling the retained phase binds the exact
  // generations and bytes it is carried to (inputBindings, state.mjs settleRetainedPhases).
  phase.retention = { rule, at, generation: phase.generation, upstreamSha256: upstream.sha256,
    ...(rule === 'E9' ? { authoredProducers: producers, inputBindings: [] } : {}) };
  delete phase.reworkRevalidation;
  const why = rule === 'E9'
    ? `${producers.join(', ')} came back with the same authored text and everything else is byte-identical`
    : 'everything its approval decided over is byte-identical';
  workflow.history.push({
    at, actor: actorKey(actor), agent: agent ?? null, event: 'phase_retained', phase: phase.id,
    detail: `Retained by rule ${rule}: ${why} (${approvals.length} approval${approvals.length === 1 ? '' : 's'} carried).`
  });
  return carried;
}

/**
 * Rule E8 candidates: the approved steps right after the scope step, in order up to the first that
 * does not qualify, whose approvals still decide over exactly the Story as it stands. Checked before
 * an intent amendment changes anything, so the amendment is the only change they would see; it then
 * keeps those whose artifacts cite none of its clauses. Code steps, and steps that feed or follow a
 * decision or run a skill, always run again; so does a step that plans when the amendment adds a
 * clause, since a new clause cites nothing yet and still has to be planned, unless the amendment carries
 * that plan's rows, signed by its approvers (`correctedPlans`) [PHR:REQ-008].
 *
 * The one other change a step may stand through is a Story decision recorded after its approval, so its
 * approval never decided over it, that names nothing the step cites and not the step itself (laterDecisions):
 * a plan amendment for a clause it does not cite, a risk accepted on a later step's obligation, a source
 * statement's disposition. Only lists that grow by appended entries are read this way; any other change, or
 * a later decision that names a cited clause or the step, runs the step again as before. The map carries
 * them as `laterDecisions`, by step, for the history line that says why the step was kept.
 */
/** The Story's plan corrections as they stood when `phase` was approved (a list started since was not there then). */
function asApproved(workflow, phase) {
  const approvedAt = Date.parse(phase.approvedAt);
  const kept = (workflow.planAmendments ?? []).filter((entry) => !(Date.parse(entry?.at) > approvedAt));
  return { ...workflow, planAmendments: kept.length ? kept : undefined };
}

export async function amendmentRetentionCandidates(root, config, workflow, specification, { addsClauses = false, correctedPlans = new Set() } = {}) {
  const counts = await presenceCountsOf(root, workflow);
  const order = workflow.phaseOrder ?? [];
  const candidates = new Map();
  candidates.laterDecisions = new Map();
  for (let index = order.indexOf(specification?.id) + 1; index > 0 && index < order.length; index += 1) {
    const phase = workflow.phases[order[index]];
    if (phase?.status !== 'approved' || phaseRequiresCodeDelivery(phase)
        || decisionAfter(workflow, phase.id) || decisionFedBy(workflow, phase.id)
        || workflow.resolution?.phases?.find((entry) => entry.id === phase.id)?.kind === 'skill'
        || (addsClauses && stepResponsibilities(workflow, phase.id).includes('plan') && !correctedPlans.has(phase.id))) break;
    const approvals = (phase.approvals ?? []).filter((entry) => entry?.decision === 'approved' && !entry.invalidatedAt
      && Number(entry.generation) === Number(phase.generation) && (!counts || counts(entry)));
    if (!approvals.length || approvals.some((entry) => !entry.upstream?.sha256)
        || !approvalRequirementsMet(phase.approvalPolicy, approvals)) break;
    // A plan whose rows the amendment carries is read as its approval decided over it: the plan corrections its
    // approvers recorded since are their own decisions on the plan, not a change behind its approval [PHR:REQ-008].
    const decidedOver = correctedPlans.has(phase.id) ? asApproved(workflow, phase) : workflow;
    const upstream = await phaseUpstream(root, config, decidedOver, phase);
    let later = [];
    if (!upstream || approvals.some((entry) => entry.upstream.sha256 !== upstream.sha256)) {
      later = await unrelatedLaterDecisions(root, config, decidedOver, phase, approvals);
      if (!later) break;
    }
    if (!(await artifactsUnchanged(root, phase))) break;
    candidates.set(phase.id, approvals);
    if (later.length) candidates.laterDecisions.set(phase.id, later);
  }
  return candidates;
}

// The Story decision lists that grow only by appended entries (a revocation is its own entry), and the
// source statement dispositions, whose later entry only marks the one it replaces withdrawn.
const LATER_DECISION_LISTS = Object.freeze(['planAmendments', 'riskDecisions', 'qualityRiskDecisions', 'scopeDispositions']);
const after = (value, time) => Date.parse(value) > time;

/** The Story as its decisions stood at `at`, and the entries recorded since, from the lists that can say. */
function decisionsAsOf(workflow, at) {
  const time = Date.parse(at);
  const view = { ...workflow };
  const later = [];
  if (Number.isNaN(time)) return { view, later };
  for (const key of LATER_DECISION_LISTS) {
    if (!Array.isArray(workflow[key])) continue;
    const kept = [];
    for (const entry of workflow[key]) {
      if (after(entry?.at, time)) later.push({ list: key, entry });
      else if (key === 'scopeDispositions' && after(entry?.withdrawnAt, time)) {
        // Withdrawn since: what it said is a change too, checked like a later entry.
        const { withdrawnAt: _withdrawn, ...asItStood } = entry;
        kept.push(asItStood);
        later.push({ list: key, entry, withdrawn: true });
      } else kept.push(entry);
    }
    view[key] = kept.length ? kept : undefined;
  }
  return { view, later };
}

/**
 * Rule E8's later decisions for `phase`: the entries recorded after its approvals, when they are all that
 * differs from what those approvals decided over, and none names a clause the step's artifacts cite or the
 * step itself. Null when anything else changed or any entry names one of those; the step then runs again.
 */
async function unrelatedLaterDecisions(root, config, workflow, phase, approvals) {
  const later = new Map();
  for (const at of new Set(approvals.map((entry) => entry.at))) {
    const { view, later: since } = decisionsAsOf(workflow, at);
    if (!since.length) return null;
    const upstream = await phaseUpstream(root, config, view, phase);
    if (!upstream || approvals.filter((entry) => entry.at === at).some((entry) => entry.upstream.sha256 !== upstream.sha256)) return null;
    for (const item of since) later.set(item.entry, item);
  }
  const { clauseReferences } = await import('./specifications.mjs');
  const cited = new Set();
  for (const artifact of phase.artifacts ?? []) {
    const text = await readFile(path.join(root, artifact.path), 'utf8').catch(() => null);
    if (text === null) return null;
    for (const clause of clauseReferences(text)) cited.add(String(clause).toUpperCase());
  }
  const id = phase.id.replace(/[^A-Za-z0-9_-]/gu, (character) => `\\${character}`);
  const step = new RegExp(`(?:^|[^A-Za-z0-9_.-])${id}(?:$|[^A-Za-z0-9_.-])`, 'u');
  for (const { entry } of later.values()) {
    const text = JSON.stringify(entry);
    if (clauseReferences(text).some((clause) => cited.has(String(clause).toUpperCase())) || step.test(text)) return null;
  }
  return [...later.values()].map(({ list, entry, withdrawn }) => ({ list,
    id: `${entry.id ?? entry.item ?? (entry.revokes ? `${entry.revokes} revoked` : list)}${withdrawn ? ' withdrawn' : ''}`, at: withdrawn ? entry.withdrawnAt : entry.at }));
}

/**
 * After `completed` completes on the linear path: retain each following phase that qualifies, in
 * order, stopping at the first that must run again. Returns the retained phase ids with the
 * approvals carried for each, and, when a phase could have been retained but changed, which
 * references changed.
 */
export async function retainUnchangedPhases(root, config, workflow, completed, { at, actor = null, agent = null } = {}) {
  const counts = await presenceCountsOf(root, workflow);
  const order = workflow.phaseOrder ?? [];
  const itemRelative = path.posix.join(config.workItemRoot ?? 'singularity/work-items', workflow.workItem.id);
  const itemDirectory = path.join(root, itemRelative);
  const retained = [];
  let stale = null;
  for (let index = order.indexOf(completed.id) + 1; index > 0 && index < order.length; index += 1) {
    const phase = workflow.phases[order[index]];
    const approvals = retainableApprovals(workflow, phase, { counts });
    if (!approvals) break;
    const upstream = await phaseUpstream(root, config, workflow, phase);
    const differing = approvals.find((entry) => entry.upstream.sha256 !== upstream?.sha256);
    // Rule E9: the only difference is producers approved again with the same authored text.
    const relied = differing ? approvals.map((entry) => authoredEquivalence(entry.upstream, upstream)) : [];
    if (differing && relied.some((producers) => !producers?.length)) {
      stale = { phase: phase.id, changed: changedUpstream(differing.upstream, upstream) }; break;
    }
    if (!(await artifactsUnchanged(root, phase))) { stale = { phase: phase.id, changed: ['artifacts'] }; break; }
    const producers = [...new Set(relied.flat())];
    if (producers.length) {
      if (!(await authoredInputsUnchanged(root, workflow, phase, producers, { itemDirectory }))) { stale = { phase: phase.id, changed: ['inputs'] }; break; }
      retained.push({ phase: phase.id, approvals: retain(workflow, phase, approvals, { at, actor, agent, upstream, rule: 'E9', producers }) });
      continue;
    }
    const inputs = await verifyInputsIntegrity(root, workflow, phase, { itemDirectory, itemRelative });
    if (inputs.errors.length || inputs.warnings.length) { stale = { phase: phase.id, changed: ['inputs'] }; break; }
    retained.push({ phase: phase.id, approvals: retain(workflow, phase, approvals, { at, actor, agent, upstream }) });
  }
  return { retained, stale };
}

/** SF Guard's approval-counting predicate for a Story it applies to, or null (SPEC-PSS-v1 REQ-030). */
async function presenceCountsOf(root, workflow) {
  return workflow?.resolution?.presence ? (await import('./presence/person-records.mjs')).presenceCountsFor(root, workflow) : null;
}
