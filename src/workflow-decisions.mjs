/** Native decision presentation and record compatibility.
 * The pure compiler/interpreter lives in kernel/workflow-decisions.mjs. CLI assignments, display
 * text, canonical pending hashes and evaluated applicability retain their native ownership here.
 */
import {
  decisionAfter, decisionFedBy, decisionInputsHint, routeReach, decisionReads, decisionValues,
  reopenableSteps, decisionOutcomeFacts, pendingDecisionPayload, resolveDecisionChoicePlan,
  skippedDeliveryObligations, DECISION_END, DECISION_NEXT
} from './kernel/workflow-decisions.mjs';
export {
  DECISION_KINDS, DECISION_NEXT, DECISION_END, DEFAULT_DECISION_ROUNDS, DECISION_FIELDS, routeReach,
  normalizeDecisions, decisionReads, decisionAfter, decisionFedBy, decisionInputsHint,
  normalizeDecisionInputValues, recordedDecisionValues, testHolds, whenHolds, chooseRoute,
  decisionValues, reopenableSteps, assertChoiceKeepsDependencies
} from './kernel/workflow-decisions.mjs';
import { createHash } from 'node:crypto';
import { canonicalJson } from './foundation/record-schema.mjs';
import { SingularityFlowError } from './foundation/failures.mjs';
import { applicabilityStatus } from './evidence/applicability.mjs';

/** Plain words for a rule, for prompts, receipts and refusals. */
export function describeWhen(when, inputs) {
  return Object.entries(when ?? {}).map(([name, test]) => {
    const label = inputs.find((input) => input.name === name)?.label ?? name;
    if (test.in) return test.in.length === 1 ? `${label} is ${test.in[0]}` : `${label} is ${test.in.join(' or ')}`;
    if (test.notIn) return `${label} is not ${test.notIn.join(' or ')}`;
    if (Object.hasOwn(test, 'equals')) return `${label} is ${test.equals}`;
    if (Object.hasOwn(test, 'notEquals')) return `${label} is not ${test.notEquals}`;
    const bounds = [];
    if (test.atLeast != null) bounds.push(`at least ${test.atLeast}`);
    if (test.above != null) bounds.push(`above ${test.above}`);
    if (test.atMost != null) bounds.push(`at most ${test.atMost}`);
    if (test.below != null) bounds.push(`below ${test.below}`);
    return `${label} is ${bounds.join(' and ')}`;
  }).join(' and ');
}

/** `name=value` assignments from the command line, as one object; a name may appear once. */
export function parseDecisionAssignments(assignments = []) {
  const values = {};
  for (const assignment of assignments) {
    const raw = String(assignment ?? '');
    const at = raw.indexOf('=');
    const name = at > 0 ? raw.slice(0, at).trim() : '';
    if (!name) {
      throw new SingularityFlowError(`--decision expects name=value, got '${raw}'.`, { code: 'DECISION_INPUT_INVALID' });
    }
    if (Object.hasOwn(values, name)) {
      throw new SingularityFlowError(`--decision gives '${name}' more than once.`, { code: 'DECISION_INPUT_INVALID' });
    }
    values[name] = raw.slice(at + 1).trim();
  }
  return values;
}

/** Preserve durable native rationale strings; kernel predicates stay structured data. */
export function decisionOutcome(workflow, phase) {
  const facts = decisionOutcomeFacts(workflow, phase);
  if (!facts) return null;
  const decision = decisionAfter(workflow, phase.id);
  const inputs = decisionReads(decision);
  return { ...facts,
    ...(Object.hasOwn(facts, 'because') ? { because: facts.because ? describeWhen(facts.because, inputs) : null } : {}),
    ...(Object.hasOwn(facts, 'goal') ? { goal: facts.goal ? describeWhen(facts.goal, inputs) : null } : {})
  };
}

/** One sentence for what an outcome does, shown before and after it happens. */
export function describeOutcome(workflow, outcome) {
  if (!outcome) return null;
  const name = (id) => workflow?.phases?.[id]?.label ?? id;
  const why = outcome.because ? ` because ${outcome.because}` : '';
  switch (outcome.kind) {
    case 'pause':
      return outcome.reason === 'limit'
        ? `'${outcome.label}' used all ${outcome.maxRounds} rounds; a person chooses what happens next.`
        : `'${outcome.label}' waits for a person to choose what happens next.`;
    case 'loop': {
      const unmet = !outcome.because && outcome.goal ? ` until ${outcome.goal}` : why;
      // A person may send it back again once the rounds are used; that round is past the limit.
      const round = !outcome.maxRounds ? ''
        : outcome.round > outcome.maxRounds ? ` (round ${outcome.round}, beyond its ${outcome.maxRounds}-round limit, chosen by a person)`
          : ` (round ${outcome.round} of ${outcome.maxRounds})`;
      return `'${outcome.label}' goes back to ${name(outcome.target)}${unmet}${round}.`;
    }
    case 'end':
      return outcome.skipped?.length
        ? `'${outcome.label}' finishes the Story${why}, skipping ${outcome.skipped.map(name).join(', ')}.`
        : `'${outcome.label}' finishes the Story${why}.`;
    case 'forward':
      return `'${outcome.label}' continues to ${name(outcome.target)}${why}, skipping ${outcome.skipped.map(name).join(', ')}.`;
    default:
      return `'${outcome.label}' continues to ${name(outcome.target)}${why}.`;
  }
}

/** Hash only the original payload, at the existing native canonical-record boundary. */
export function pendingDecisionRecord(workflow, phase, outcome, { at }) {
  const record = pendingDecisionPayload(workflow, phase, outcome, { at });
  record.key = createHash('sha256').update(canonicalJson(record)).digest('hex').slice(0, 16);
  return record;
}

/** Existing CLI diagnostic ABI over the kernel's structured choice refusals. */
export function resolveDecisionChoice(workflow, pending, { option = null, to = null } = {}) {
  try { return resolveDecisionChoicePlan(workflow, pending, { option, to }); }
  catch (error) {
    if (!(error instanceof SingularityFlowError)) throw error;
    let message;
    switch (error.code) {
      case 'DECISION_CHOICE_REQUIRED':
        message = `Choose one option with --option (${pending.options.map((entry) => entry.id).join(', ')})${pending.anyStep ? ', or a step with --to' : ''}.`; break;
      case 'DECISION_OPTION_UNKNOWN':
        message = `'${option}' is not an option of '${pending.label}'. Options: ${pending.options.map((entry) => `${entry.id} (${entry.label})`).join(', ')}.`; break;
      case 'DECISION_STEP_NOT_ALLOWED': {
        const reopen = reopenableSteps(workflow, pending);
        message = error.details?.reason === 'fixed-options'
          ? `'${pending.label}' offers fixed options; choose one with --option${reopen.length ? `, or reopen an earlier step with --to ${reopen.join('|')}` : ''}.`
          : '--to must name a phase of this Story or end.';
        break;
      }
      case 'DECISION_CONDITION_REQUIRED': {
        const decision = decisionAfter(workflow, pending.after);
        message = `Decision '${decision.label}' requires its recorded conditions. This verdict does not allow '${error.details.routeLabel}'. Repair or recheck the evidence, reopen an earlier step with singularity-flow decision choose ${workflow.workItem?.id ?? '<WORK-ID>'} --to ${reopenableSteps(workflow, pending)[0] ?? '<PHASE>'} --reason "<why>" --expected ${pending.key}, or cancel the Story; a human choice cannot manufacture a passing result.`;
        throw new SingularityFlowError(message, { code: error.code,
          details: { decision: error.details.decision, allowedOption: error.details.allowedOption } });
      }
      default: throw error;
    }
    throw new SingularityFlowError(message, { code: error.code });
  }
}

/** Evaluated no-change authority stays native; absent that proof, analyze every skipped delivery. */
export function obligationsDroppedBySkips(workflow) {
  if (workflow?.resolution?.plannedClaims?.mode !== 'required') return [];
  if (applicabilityStatus(workflow).some((entry) => entry.responsibility === 'implement' && entry.satisfied)) return [];
  return skippedDeliveryObligations(workflow);
}

/**
 * Everything a person or a screen needs about a Story's decisions, read from its pinned policy and
 * state: the decisions it carries, the one after its current phase and what that phase must record,
 * the question waiting for a person, which phases were skipped and why, and the log.
 */
/** Guidance for the legacy CLI reader, separate so workflow projections stay small. */
export function storyDecisionReadGuidance(workflow) {
  const workId = workflow?.workItem?.id ?? '<WORK-ID>';
  return {
    coverage: 'workflow-routing-and-applicability',
    instruction: 'An empty routing decisions array is not approval readiness. Use the consolidated pending-decisions command for gaps and upstream issues.',
    commandGuidance: { pendingDecisions: {
      command: `singularity-flow decisions ${workId} --json`, skill: '/sf-decide',
      copilotCommand: `/sf-decide ${workId}`, modelFreeCommand: null
    } }
  };
}

export function storyDecisionView(workflow) {
  const order = workflow?.phaseOrder ?? [];
  const name = (id) => id === DECISION_END ? 'Finish the Story'
    : id === DECISION_NEXT ? 'Next step' : workflow?.phases?.[id]?.label ?? id;
  const current = workflow?.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
  const ahead = current ? decisionAfter(workflow, current.id) : null;
  const recorded = current && ahead ? decisionValues(workflow, current, ahead) : null;
  let projection = null;
  if (ahead?.mode === 'auto' && recorded && !workflow.pendingDecision) {
    try {
      const outcome = decisionOutcome(workflow, current);
      projection = { kind: outcome.kind, target: outcome.target ?? null, route: outcome.route ?? null, text: describeOutcome(workflow, outcome) };
    } catch { projection = null; }
  }
  // Where a route lands, named by the phase it reaches: 'next' is a direction, not a destination.
  const reachOf = (after, to) => {
    const reach = routeReach(order, after, to);
    return {
      reach: reach.kind, target: reach.target, skips: reach.skipped, skipLabels: reach.skipped.map(name),
      toLabel: reach.kind === 'end' ? name(DECISION_END) : reach.target ? name(reach.target) : name(to)
    };
  };
  const pending = workflow?.pendingDecision ?? null;
  return {
    schemaVersion: 1,
    resultType: 'story-decisions',
    workId: workflow?.workItem?.id ?? null,
    decisions: (workflow?.resolution?.decisions ?? []).map((decision) => ({
      id: decision.id,
      after: decision.after,
      afterLabel: name(decision.after),
      kind: decision.kind,
      label: decision.label,
      mode: decision.mode,
      by: [...decision.by],
      anyStep: decision.anyStep,
      ...(decision.enforceConditions ? { enforceConditions: true } : {}),
      maxRounds: decision.maxRounds,
      rounds: workflow.decisionRounds?.[decision.id]?.count ?? 0,
      inputs: decision.inputs,
      ...(decision.reuses?.length ? { reuses: decision.reuses } : {}),
      routes: decision.routes.map((route) => ({
        id: route.id, label: route.label, to: route.to, when: route.when,
        rule: route.when ? describeWhen(route.when, decisionReads(decision)) : null,
        ...reachOf(decision.after, route.to)
      }))
    })),
    ahead: ahead ? {
      decision: ahead.id,
      label: ahead.label,
      mode: ahead.mode,
      after: ahead.after,
      inputs: ahead.mode === 'auto' ? ahead.inputs : [],
      recorded,
      hint: ahead.mode === 'auto' && ahead.inputs.length ? decisionInputsHint(ahead) : null,
      projection
    } : null,
    pending: pending ? {
      ...pending,
      afterLabel: name(pending.after),
      options: pending.options.map((option) => ({ ...option, ...reachOf(pending.after, option.to) })),
      reopen: reopenableSteps(workflow, pending)
    } : null,
    skipped: order.filter((id) => workflow.phases?.[id]?.status === 'skipped').map((id) => ({
      phase: id, label: name(id), by: workflow.phases[id].skippedBy ?? null, at: workflow.phases[id].skippedAt ?? null
    })),
    log: [...(workflow?.decisionLog ?? [])]
  };
}

/** The submit arguments a phase needs for the decision after it, with a placeholder per value. */
export function decisionSubmitArguments(workflow, phaseId) {
  const decision = decisionFedBy(workflow, phaseId);
  return decision ? decision.inputs.map((input) => ` --decision ${input.name}=<${input.name}>`).join('') : '';
}

/**
 * Where completing a phase will lead under its decision, for guidance before it completes: the
 * computed outcome when its values are recorded, otherwise only which decision chooses.
 */
export function upcomingDecision(workflow, phase) {
  const decision = phase ? decisionAfter(workflow, phase.id) : null;
  if (!decision) return null;
  let outcome = null;
  if (decision.mode === 'auto' && decisionValues(workflow, phase, decision)) {
    try { outcome = decisionOutcome(workflow, phase); } catch { outcome = null; }
  }
  return { decision, outcome };
}
