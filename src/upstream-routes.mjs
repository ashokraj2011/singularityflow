/**
 * The legal ways an earlier, approved phase can change, seen from where the Story stands now.
 *
 * An approved phase is never edited in place, by recovery or by a later phase. It changes only when
 * a later phase returns work to it (`reject <later> --to <earlier>`, legal once the later phase
 * awaits approval and its policy names the earlier one), or, for the step that defines scope,
 * through a reviewed intent amendment proposed from an active later phase. Every route returned
 * with a command is one the CLI accepts from the current status. A route that becomes legal only
 * later is described in words and never offered as a command, so no caller hands an agent a route
 * the CLI then refuses.
 */
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { intentAmendmentSource, latestStepBefore, scopeStepOf } from './phase-roles.mjs';
import { clauseMentionPattern } from './traceability-ids.mjs';

/**
 * The route that is open from any status of a later phase: record the defect for the earlier
 * phase's approvers and keep working [UIF-M4]. They decide a plan correction, a return, an accepted
 * risk or a dismissal; the Story completes only once it is decided. Null when the producer is not an
 * earlier phase that has run, or the Story is not in progress.
 */
export function raiseUpstreamIssueRoute(workflow, producerId, currentPhaseId) {
  const order = workflow?.phaseOrder ?? [];
  const producer = workflow?.phases?.[producerId];
  if ((workflow?.status ?? 'in_progress') !== 'in_progress' || !producer || !(Number(producer.generation) > 0)
      || producer.status === 'not_started' || !currentPhaseId || producerId === currentPhaseId
      || order.indexOf(producerId) < 0 || order.indexOf(producerId) >= order.indexOf(currentPhaseId)) return null;
  const workId = workflow.workItem?.id ?? null;
  return {
    kind: 'upstream-issue', phase: producerId, legal: true, skill: null,
    command: `singularity-flow upstream-issue raise --work-id ${workId} --phase ${producerId} --about <clause-or-section> --problem <what-is-wrong>`,
    label: `Record the defect for ${producerId}'s approvers and keep working; they decide a plan correction, a return, an accepted risk or a dismissal, and the Story completes once it is decided.`
  };
}

/** Routes, plus a sentence for each route that is not open now, for one earlier producer. */
export function upstreamChangeRoutes(workflow, producerId, { currentPhaseId = workflow?.currentPhase ?? null } = {}) {
  const workId = workflow?.workItem?.id ?? null;
  const producer = workflow?.phases?.[producerId] ?? null;
  const current = currentPhaseId ? workflow?.phases?.[currentPhaseId] ?? null : null;
  const order = workflow?.phaseOrder ?? [];
  const routes = [];
  const notes = [];
  if (!producer || !current || producerId === current.id) {
    return { producer: producerId ?? null, current: current?.id ?? null, routes, notes };
  }
  const earlier = order.includes(producerId) && order.indexOf(producerId) < order.indexOf(current.id);
  const allowed = current.approvalPolicy?.rejectTo ?? [current.id];
  const returnable = earlier && allowed.includes(producerId);
  const active = workflow.currentPhase === current.id;
  if (returnable && active && current.status === 'awaiting_approval') {
    routes.push({
      kind: 'return', phase: producerId, legal: true, skill: '/sf-reject',
      command: `singularity-flow reject ${current.id} --work-id ${workId} --to ${producerId} --reason <reason>`,
      label: `An authorized approver returns ${current.id} to ${producerId}. ${producerId} then publishes an amended generation for review, and the phases after it run again.`
    });
  } else if (returnable && active && current.status === 'in_progress') {
    notes.push(`Once ${current.id} is submitted, an authorized approver can return it to ${producerId} with: singularity-flow reject ${current.id} --to ${producerId}.`);
  } else if (earlier && !allowed.includes(producerId)) {
    notes.push(`${current.id} may not return work to ${producerId}; its allowed return targets are ${allowed.join(', ') || 'none'}. A workflow maintainer decides how ${producerId} is corrected.`);
  }
  if (scopeStepOf(workflow)?.id === producerId && intentAmendmentSource(workflow, current.id)) {
    routes.push({
      kind: 'intent-amendment', phase: producerId, legal: true, skill: null,
      command: 'singularity-flow story intent-amendment propose --file <AMENDED-SPEC.md> --reason <reason>',
      label: `Propose a reviewed amendment of the approved ${producerId} scope from ${current.id}. Its approvers decide; ${current.id} keeps its draft meanwhile.`
    });
  }
  const raised = raiseUpstreamIssueRoute(workflow, producerId, current.id);
  if (raised) routes.push(raised);
  return { producer: producerId, current: current.id, routes, notes };
}

/** One sentence for the reader: the first legal route, or why there is none from here. */
export function upstreamRouteSummary(entry) {
  const route = entry?.routes?.[0];
  if (route) return `${route.label} Command: ${route.command}`;
  return entry?.notes?.[0] ?? `${entry?.producer ?? 'The earlier phase'} is approved; it changes only by an authorized return or amendment.`;
}

/** The statuses of an issue that still owe a person's decision: undecided, or an accepted risk that expired. */
export const OPEN_UPSTREAM_ISSUE_STATUSES = Object.freeze(['open', 'expired']);

/**
 * Each upstream issue with its latest decision, whether it is still open at `now`, and what replaced
 * it. Pure. An issue another one supersedes (raised against the wrong step) is `superseded` unless a
 * standing decision closed it: it stays in the record and the history, owes nothing, and blocks
 * nothing; its replacement carries the obligation. Its approvers may still dismiss it explicitly.
 */
export function upstreamIssueStates(workflow, now = new Date().toISOString()) {
  const decisions = workflow?.upstreamIssueDecisions ?? [];
  const replacements = new Map();
  for (const issue of workflow?.upstreamIssues ?? []) {
    if (issue?.supersedes && !replacements.has(issue.supersedes)) replacements.set(issue.supersedes, issue.id);
  }
  return (workflow?.upstreamIssues ?? []).map((issue) => {
    const decision = decisions.findLast((entry) => entry?.issue === issue.id) ?? null;
    const expired = decision?.outcome === 'accept-risk' && decision.expiresAt && Date.parse(decision.expiresAt) <= Date.parse(now);
    const supersededBy = replacements.get(issue.id) ?? null;
    const status = decision && !expired ? 'decided' : supersededBy ? 'superseded' : !decision ? 'open' : 'expired';
    return { issue, decision, status, supersededBy };
  });
}

/**
 * Fallback only for a gap with no linked issue: the latest code step, or the preceding step when
 * none delivered code. A linked evidence/scope/plan issue keeps its own actual owner instead.
 */
export function conformanceGapOwner(workflow, phaseId) {
  return latestStepBefore(workflow, phaseId, (candidate) => phaseRequiresCodeDelivery(candidate))?.id
    ?? latestStepBefore(workflow, phaseId, () => true)?.id ?? null;
}

/** Whether an upstream issue's `about` names this clause, by its exact ID or its bare label. */
export function issueNamesClause(about, clauseId) {
  return Boolean(clauseId) && clauseMentionPattern(clauseId).test(String(about ?? ''));
}

/**
 * Said wherever a partial or missing verdict needs a decision, so every surface states the rule.
 */
export const CONFORMANCE_GAP_RULE = 'Keep the honest verdict; never edit it to clear a check. Human choices: dated risk, dismissal or return. '
  + 'Accepting existing evidence never certifies a run that was not recorded.';

const displayArgument = (value) => /^[A-Za-z0-9._:/-]+$/u.test(value) || /^<[A-Za-z][A-Za-z0-9._/|-]*>$/u.test(value)
  ? value : JSON.stringify(value);
const gapChoice = (kind, owner, argv, skill, detail) => Object.freeze({
  kind, owner, argv: argv ? Object.freeze(argv) : null, skill, detail, automatic: false,
  command: argv ? ['singularity-flow', ...argv].map(displayArgument).join(' ') : null
});

/**
 * Every way out of one partial or missing clause, none of which edits the verdict: a decision on
 * its upstream issue (raising it first when none exists), a repair by return, a person's approval
 * to reuse evidence an earlier attempt already recorded, or a fresh recorded run at the code step.
 */
export function conformanceGapRoutes(workflow, phaseId, gap, issue = null) {
  const workId = workflow?.workItem?.id ?? '<WORK-ID>';
  const owner = gap.owner ?? '<EARLIER-STEP>';
  const clause = gap.clauseId;
  const current = workflow?.phases?.[phaseId] ?? null;
  const returnable = (target) => (current?.approvalPolicy?.rejectTo ?? [phaseId]).includes(target);
  const submitted = current?.status === 'awaiting_approval';
  const codeStep = latestStepBefore(workflow, phaseId, (candidate) => phaseRequiresCodeDelivery(candidate))?.id ?? null;
  const reject = (target) => ['reject', phaseId, '--work-id', workId, '--to', target, '--reason', '<why>'];
  const later = submitted ? '' : ` once ${phaseId} is submitted`;
  const decide = issue ? ['upstream-issue', 'decide', issue.id, '--work-id', workId] : null;
  return Object.freeze([
    issue
      ? gapChoice('decide-upstream-issue', owner, [...decide, '--outcome', 'accept-risk', '--expires', '<YYYY-MM-DD>', '--reason', '<why>'], '/sf-decide',
        `${issue.id}: ${owner}'s approvers decide ${clause}; keep the verdict.`)
      : gapChoice('raise-upstream-issue', owner, ['upstream-issue', 'raise', '--phase', owner, '--about', clause,
        '--problem', '<what the delivered change is missing>', '--work-id', workId], '/sf-decide',
      `${clause}: report once to ${owner}'s approvers.`),
    issue
      ? gapChoice('repair-return', owner, [...decide, '--outcome', 'return', '--reason', '<why>'], '/sf-decide',
        `Return via ${issue.id} to ${owner}; keep working files.`)
      : gapChoice('repair-return', owner, returnable(owner) ? reject(owner) : null, returnable(owner) ? '/sf-reject' : null,
        returnable(owner) ? `Return to ${owner}${later}; retest ${clause}.`
          : `${owner}'s approvers can return it through an issue.`),
    // The person's own terminal step: no turn records a reuse, so no skill is its route.
    gapChoice('evidence-reuse', 'phase-approval-authority', ['decision', 'evidence-reuse', workId, '--phase', owner, '--from-attempt', '<ATTEMPT-ID>', '--reason', '<TEXT>'], null,
      `${clause}: reuse retains its producer. Accepting existing evidence never certifies a run that was not recorded.`),
    gapChoice('fresh-recorded-run', codeStep ?? owner, codeStep && returnable(codeStep) ? reject(codeStep) : null, codeStep && returnable(codeStep) ? '/sf-reject' : null,
      codeStep ? `Return to ${codeStep}${later}; a document step such as ${phaseId} cannot record test runs.`
        : 'No code step records tests here.')
  ]);
}

/**
 * Whether a person has decided each partial or missing clause [owner decision 2026-10-19]. A clause
 * is decided by a linked upstream issue (authored reference, source provenance or exact clause)
 * whose latest decision accepts the risk (unexpired at `now`) or dismisses it, or by verified reuse.
 * Approval of the conformance step and the terminal gate
 * both call this, so they agree. Anything else carries its routes; none edits the verdict.
 */
export function conformanceGapDecisions(workflow, phaseId, gaps, { now = new Date().toISOString(), reused = [] } = {}) {
  const states = upstreamIssueStates(workflow, now);
  const owner = conformanceGapOwner(workflow, phaseId);
  const order = workflow?.phaseOrder ?? Object.keys(workflow?.phases ?? {});
  const earlier = order.slice(0, Math.max(0, order.indexOf(phaseId)));
  const eligible = states.filter((state) => !state.supersededBy && earlier.includes(state.issue.phase));
  return (gaps ?? []).flatMap((gap) => {
    // Exact row/source-item links take precedence over generic clause mentions. A decided issue
    // about the same clause but another problem must not clear the report's explicitly named gap.
    // A retained report may still cite the original issue. Follow only recorded supersession,
    // never a similar title or a new owner guessed from its prose; protect against corrupt cycles.
    const refs = new Set((gap.issueRefs ?? []).map((id) => {
      let state = states.find((entry) => entry.issue.id === id);
      for (let round = 0; state?.supersededBy && round < states.length; round += 1) {
        state = states.find((entry) => entry.issue.id === state.supersededBy);
      }
      return state?.issue.id;
    }));
    const referenced = eligible.filter((state) => refs.has(state.issue.id));
    const named = referenced.length ? referenced : eligible.filter((state) => issueNamesClause(state.issue.about, gap.clauseId)
      || issueNamesClause(state.issue.impact, gap.clauseId));
    const pendingIssues = named.filter((state) => OPEN_UPSTREAM_ISSUE_STATUSES.includes(state.status));
    const covering = named.findLast((state) => state.status === 'decided' && ['accept-risk', 'dismiss'].includes(state.decision?.outcome));
    if (covering && !pendingIssues.length) {
      return Object.freeze({ ...gap, owner: covering.issue.phase, status: 'decided', issue: covering.issue.id,
        outcome: covering.decision.outcome, expiresAt: covering.decision.expiresAt ?? null, choices: Object.freeze([]) });
    }
    // A person approved reusing a run an earlier step recorded for this clause (decision
    // evidence-reuse, still bound to unchanged source): that is the human decision for the gap. It is
    // labelled as that step's run and never certifies a run this report's steps did not record.
    const reuse = (reused ?? []).find((entry) => (entry.clauses ?? []).some((id) => String(id).toUpperCase() === String(gap.clauseId).toUpperCase()));
    if (reuse) {
      return Object.freeze({ ...gap, owner: reuse.recordedBy ?? owner, status: 'decided', issue: reuse.id, outcome: 'evidence-reuse',
        expiresAt: reuse.expiresAt ?? null, reuse: reuse.label, choices: Object.freeze([]) });
    }
    // A superseded issue owes nothing; its replacement names the clause if it carries the gap.
    return (pendingIssues.length ? pendingIssues : [null]).map((pending) => {
      const gapOwner = pending?.issue.phase ?? owner;
      return Object.freeze({ ...gap, owner: gapOwner, status: pending ? pending.status === 'expired' ? 'expired' : 'undecided' : 'unraised',
        issue: pending?.issue.id ?? null, outcome: null, expiresAt: pending?.decision?.expiresAt ?? null,
        choices: conformanceGapRoutes(workflow, phaseId, { ...gap, owner: gapOwner }, pending?.issue ?? null) });
    });
  });
}

/** One line for an undecided gap: its verdict and who decides it next. */
export function conformanceGapLine(gap) {
  const owner = gap.owner ?? 'the owning step';
  const state = gap.status === 'expired' ? `${gap.issue}'s accepted risk expired at ${gap.expiresAt}; ${owner}'s approvers decide it again`
    : gap.status === 'undecided' ? `${gap.issue} awaits ${owner}'s approvers`
      : `no linked issue; raise one against ${owner}`;
  return `${gap.clauseId} remains ${gap.verdict}: ${state}`;
}

/**
 * The refusal shared by conformance approval and the terminal gate, or null when a person decided
 * every gap. Its details carry each clause's routes and the exact commands, never a verdict edit.
 */
export function conformanceGapRefusal(workflow, phaseId, gaps, { now = new Date().toISOString(), reused = [] } = {}) {
  const open = conformanceGapDecisions(workflow, phaseId, gaps, { now, reused }).filter((gap) => gap.status !== 'decided');
  if (!open.length) return null;
  const seen = new Set();
  const recoveryCommands = open.flatMap((gap) => gap.choices).filter((choice) => choice.command && !seen.has(choice.command) && seen.add(choice.command))
    .map((choice) => Object.freeze({ command: choice.command, skill: choice.skill, label: choice.detail }));
  return Object.freeze({
    gaps: Object.freeze(open), lines: Object.freeze(open.map(conformanceGapLine)),
    details: Object.freeze({
      workId: workflow?.workItem?.id ?? null, phase: phaseId, route: '/sf-decide', rule: CONFORMANCE_GAP_RULE,
      conformanceGaps: open.map(({ clauseId, verdict, line, owner, status, issue, expiresAt, choices }) => ({ clauseId, verdict, line, owner, status, issue, expiresAt, choices })),
      nextAction: recoveryCommands[0] ?? null, recoveryCommands
    })
  });
}

// The decision list's own words, here because every lifecycle command already loads this module:
// the plain sentence that leads a refusal or next step for pending decisions, and the one route to them.
function titleCase(id) {
  return String(id ?? 'step').split(/[-_]/u).filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
}

/** A step's name as people see it. */
export function stepName(workflow, phaseId) {
  return workflow?.phases?.[phaseId]?.label ?? titleCase(phaseId);
}

/**
 * "Release can't be approved yet: 1 decision needed." A step not yet submitted "needs N decisions
 * before it can be approved"; `refused` always says it can't be, as a refusal does.
 */
export function decisionHeadline(workflow, phaseId, count, { refused = false } = {}) {
  const phase = workflow?.phases?.[phaseId];
  const name = stepName(workflow, phaseId);
  if (!count) return `${name} has nothing waiting for a decision.`;
  const verb = ['none', 'policy'].includes(phase?.approvalPolicy?.mode) ? 'completed' : 'approved';
  const needed = `${count} ${count === 1 ? 'decision' : 'decisions'}`;
  return refused || phase?.status === 'awaiting_approval' ? `${name} can't be ${verb} yet: ${needed} needed.`
    : `${name} needs ${needed} before it can be ${verb}.`;
}

/** The route every refusal for pending decisions leads with: the decision list, never record IDs. */
export function decisionListRoute(workId) {
  return { command: `singularity-flow decisions ${workId}`, skill: '/sf-decide', copilotCommand: `/sf-decide ${workId}`,
    label: 'Open the decision list: each decision in plain words, with its choices, recorded with one confirmation.' };
}

/** "Decide them in one place: Copilot /sf-decide W; Shell singularity-flow decisions W." */
export function decisionListRouteLine(workId) {
  const route = decisionListRoute(workId);
  return `Decide them in one place. Copilot: ${route.copilotCommand} · Shell: ${route.command}`;
}
