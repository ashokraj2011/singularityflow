/**
 * Route simulation for a resolved workflow: what happens on a pass, a repair, repeated failure,
 * unavailable evidence and a rejection, walked with the engine's own decision rules. [TAWI ENG-2]
 *
 * `workflow simulate` profiles lifecycle structure; this walks decision routes. It never starts a
 * Story. It uses `chooseRoute`, `routeReach` and the round limits exactly as a running Story does
 * (workflow-decisions.mjs), so a route the simulator reaches is one a Story can take.
 *
 * Instead of every path (which multiplies with each loop), it builds one scenario per question:
 * - pass: every decision takes its forward route, every loop meets its goal;
 * - route: each reachable route of each decision, once, with everything else passing; a route that
 *   goes back is a repair, and the next visit passes;
 * - exhausted: each rule decision that can go back keeps going back until its rounds run out, which
 *   pauses the Story for the decision's `by` group (the fixed engine behaviour);
 * - unavailable evidence: a rule decision without its recorded inputs refuses to choose, so the
 *   Story waits at that step; it is never a pass;
 * - rejection: each signed-off phase rejected to each of its `rejectTo` targets, then passing.
 *
 * Every route is also checked for reachability: values for the decision's inputs that make the
 * engine choose it (the first route whose rule holds wins, so a later route can be shadowed).
 */
import { DECISION_END, chooseRoute, routeReach } from './workflow-decisions.mjs';

const MAX_VALUE_COMBINATIONS = 4096;

/** Candidate values for one input: every choice, or the edges of every numeric test. */
function candidateValues(input, decision) {
  if (input.type !== 'number') return input.values;
  const constants = new Set([0]);
  const tests = [...decision.routes.map((route) => route.when?.[input.name]), decision.goal?.[input.name]].filter(Boolean);
  for (const test of tests) {
    for (const key of ['equals', 'notEquals', 'atLeast', 'atMost', 'above', 'below']) {
      if (Number.isFinite(test[key])) [test[key] - 1, test[key], test[key] + 1].forEach((value) => constants.add(value));
    }
  }
  if (Number.isFinite(input.minimum)) constants.add(input.minimum);
  if (Number.isFinite(input.maximum)) constants.add(input.maximum);
  return [...constants].filter((value) => (input.minimum == null || value >= input.minimum)
    && (input.maximum == null || value <= input.maximum)).sort((a, b) => a - b);
}

/** For each route, recorded input values that make the engine choose it, or null when none do. */
export function routeSelectors(decision) {
  if (decision.mode === 'ask') return new Map(decision.routes.map((route) => [route.id, { by: 'person' }]));
  const inputs = decision.inputs ?? [];
  const domains = inputs.map((input) => candidateValues(input, decision));
  const selectors = new Map(decision.routes.map((route) => [route.id, null]));
  let remaining = decision.routes.length;
  let explored = 0;
  const assign = (index, values) => {
    if (!remaining || explored >= MAX_VALUE_COMBINATIONS) return;
    if (index === inputs.length) {
      explored += 1;
      const route = chooseRoute(decision, values);
      if (route && selectors.get(route.id) === null) { selectors.set(route.id, { values: { ...values } }); remaining -= 1; }
      return;
    }
    for (const value of domains[index]) {
      assign(index + 1, { ...values, [inputs[index].name]: value });
      if (!remaining || explored >= MAX_VALUE_COMBINATIONS) return;
    }
  };
  assign(0, {});
  return selectors;
}

/**
 * The route a passing run takes: a loop's goal; otherwise the route that moves furthest forward to
 * a step, then one that ends the run, and only when every route goes back, the one that returns
 * least far. (Preferring the very next step would send a check that passes into its own repair.)
 */
function passingRoute(decision, order, selectors) {
  const reachable = decision.routes.filter((route) => selectors.get(route.id));
  if (decision.kind === 'loop') return reachable.find((route) => route.id === 'goal-met') ?? reachable[0] ?? null;
  const score = (route) => {
    const reach = routeReach(order, decision.after, route.to);
    const at = order.indexOf(reach.target);
    if (reach.kind === 'next' || reach.kind === 'forward') return 2 * order.length + at;
    if (reach.kind === 'end') return 2 * order.length - 1;
    if (reach.kind === 'backward') return at;
    return -1;
  };
  return [...reachable].sort((a, b) => score(b) - score(a))[0] ?? null;
}

/**
 * Simulate `resolved` (a `resolveWorkType` result). `approvalAuthorities` names the declared
 * authority groups, so a `by` group or approver that names nothing is reported.
 */
export function simulateWorkflowRoutes(resolved, { approvalAuthorities = null } = {}) {
  const phases = resolved.phases ?? [];
  const order = phases.map((phase) => phase.id);
  const byPhase = new Map(phases.map((phase) => [phase.id, phase]));
  const decisions = resolved.decisions ?? [];
  const decisionAfter = new Map(decisions.map((decision) => [decision.after, decision]));
  const selectors = new Map(decisions.map((decision) => [decision.id, routeSelectors(decision)]));
  const findings = [];
  const scenarios = [];
  const authorities = approvalAuthorities ? new Set(Object.keys(approvalAuthorities)) : null;
  const limit = Math.max(8, order.length * (2 + Math.max(0, ...decisions.map((decision) => decision.maxRounds ?? 1))) * 2);

  /**
   * Walk from `start` with `policy(decision, visit)` choosing a route. Returns the path and how it
   * ended: at the end, paused for a person, or stopped by the step guard (a defect).
   */
  const walk = (start, policy, { rounds = new Map(), path = [], choices = [] } = {}) => {
    let index = order.indexOf(start);
    const visits = new Map();
    while (index >= 0 && index < order.length) {
      if (path.length > limit) return { path, choices, outcome: 'unbounded' };
      const phaseId = order[index];
      path.push(phaseId);
      const decision = decisionAfter.get(phaseId);
      if (!decision) { index += 1; continue; }
      const visit = (visits.get(decision.id) ?? 0) + 1;
      visits.set(decision.id, visit);
      const route = policy(decision, visit);
      if (!route) return { path, choices, outcome: 'blocked', at: phaseId, decision: decision.id };
      const reach = routeReach(order, phaseId, route.to);
      if (reach.kind === 'backward' && decision.mode !== 'ask') {
        const used = rounds.get(decision.id) ?? 0;
        if (used >= decision.maxRounds) {
          choices.push({ decision: decision.id, route: route.id, round: used, limit: true });
          return { path, choices, outcome: 'pause', at: phaseId, decision: decision.id, pausedFor: [...decision.by] };
        }
        rounds.set(decision.id, used + 1);
      }
      choices.push({ decision: decision.id, route: route.id, ...(selectors.get(decision.id).get(route.id) ?? {}) });
      if (reach.kind === 'end' || route.to === DECISION_END) { path.push('end'); return { path, choices, outcome: 'end' }; }
      if (reach.kind === 'unknown') return { path, choices, outcome: 'blocked', at: phaseId, decision: decision.id, reason: `route '${route.id}' names '${route.to}'` };
      index = order.indexOf(reach.target);
    }
    path.push('end');
    return { path, choices, outcome: 'end' };
  };
  const pass = (decision) => passingRoute(decision, order, selectors.get(decision.id));
  const reachableRoutes = (decision) => decision.routes.filter((route) => selectors.get(decision.id).get(route.id));

  /**
   * The routes to take, decision by decision, on the shortest way from the first step to `phaseId`
   * (breadth-first over steps and reachable routes), or null when no route leads there.
   */
  const steering = (phaseId) => {
    if (!order.length) return null;
    const parent = new Map([[order[0], null]]);
    const queue = [order[0]];
    while (queue.length) {
      const current = queue.shift();
      if (current === phaseId) break;
      const decision = decisionAfter.get(current);
      const edges = decision
        ? reachableRoutes(decision).map((route) => ({ to: routeReach(order, current, route.to).target, decision: decision.id, route }))
        : [{ to: order[order.indexOf(current) + 1] ?? null }];
      for (const edge of edges) {
        if (!edge.to || parent.has(edge.to)) continue;
        parent.set(edge.to, { from: current, decision: edge.decision, route: edge.route });
        queue.push(edge.to);
      }
    }
    if (!parent.has(phaseId)) return null;
    const plan = new Map();
    for (let step = parent.get(phaseId); step; step = parent.get(step.from)) if (step.decision) plan.set(step.decision, step.route);
    return plan;
  };
  /** Steer to `decision`, act there with `atTarget`, and pass elsewhere; `persistent` keeps steering. */
  const toward = (decision, atTarget, { persistent = false } = {}) => {
    const plan = steering(decision.after) ?? new Map();
    return (current, visit) => {
      if (current.id === decision.id) return atTarget(visit);
      if (plan.has(current.id) && (persistent || visit === 1)) return plan.get(current.id);
      return pass(current);
    };
  };

  for (const decision of decisions) {
    for (const route of decision.routes) {
      if (!selectors.get(decision.id).get(route.id)) {
        findings.push({ code: 'WORKFLOW_ROUTE_UNREACHABLE', severity: 'error', decision: decision.id,
          message: `Decision '${decision.id}' route '${route.id}' can never be chosen: an earlier route's rule always holds first.` });
      }
    }
    if (decision.mode !== 'ask' && decision.maxRounds != null && !decision.by?.length) {
      findings.push({ code: 'WORKFLOW_ROUTE_PAUSE_UNOWNED', severity: 'error', decision: decision.id,
        message: `Decision '${decision.id}' goes back but names no by group to decide when its rounds run out.` });
    }
    for (const group of decision.by ?? []) {
      if (authorities && !authorities.has(group)) {
        findings.push({ code: 'WORKFLOW_AUTHORITY_UNKNOWN', severity: 'error', decision: decision.id,
          message: `Decision '${decision.id}' names by group '${group}', which is not a declared approval authority.` });
      }
    }
  }
  for (const phase of phases) {
    for (const group of phase.approval?.mode === 'required' ? phase.approval.authorities ?? [] : []) {
      if (authorities && !authorities.has(group)) {
        findings.push({ code: 'WORKFLOW_AUTHORITY_UNKNOWN', severity: 'error', phase: phase.id,
          message: `Step '${phase.id}' is approved by '${group}', which is not a declared approval authority.` });
      }
    }
  }

  const record = (id, kind, run, extra = {}) => scenarios.push({ id, kind, ...extra, path: run.path, outcome: run.outcome,
    ...(run.pausedFor ? { pausedFor: run.pausedFor } : {}), ...(run.at ? { at: run.at } : {}), choices: run.choices });
  if (order.length) {
    const run = walk(order[0], pass);
    record('pass', 'pass', run);
    if (run.outcome !== 'end') {
      findings.push({ code: 'WORKFLOW_ROUTE_NO_END', severity: 'error',
        message: `A passing run does not reach the end: it ${run.outcome === 'pause' ? `pauses at '${run.at}'` : run.outcome === 'blocked' ? `stops at '${run.at}'` : 'never stops'}.` });
    }
  }
  for (const decision of decisions) {
    for (const route of decision.routes) {
      if (!selectors.get(decision.id).get(route.id)) continue;
      const reach = routeReach(order, decision.after, route.to);
      const run = walk(order[0], toward(decision, (visit) => (visit === 1 ? route : pass(decision))));
      const kind = reach.kind === 'backward' ? 'repair' : 'route';
      record(`${decision.id}:${route.id}`, kind, run, { decision: decision.id, route: route.id });
      if (run.outcome !== 'end') {
        findings.push({ code: 'WORKFLOW_ROUTE_NO_END', severity: 'error', decision: decision.id,
          message: `Taking '${route.id}' at '${decision.id}' never reaches the end (${run.outcome}${run.at ? ` at '${run.at}'` : ''}).` });
      }
    }
    const back = decision.routes.find((route) => routeReach(order, decision.after, route.to).kind === 'backward'
      && selectors.get(decision.id).get(route.id));
    if (back && decision.mode !== 'ask') {
      const run = walk(order[0], toward(decision, () => back, { persistent: true }));
      record(`${decision.id}:exhausted`, 'exhausted', run, { decision: decision.id, route: back.id, maxRounds: decision.maxRounds });
      // Steering through another decision that goes back can exhaust that one first; either way a
      // person must be asked. Only a run that never pauses is a defect.
      if (run.outcome !== 'pause' || !run.pausedFor?.length) {
        findings.push({ code: 'WORKFLOW_ROUTE_EXHAUSTION', severity: 'error', decision: decision.id,
          message: `Repeated failure at '${decision.id}' does not pause for a person after ${decision.maxRounds} rounds (${run.outcome}).` });
      }
    }
    if (decision.mode !== 'ask') {
      // Missing recorded inputs refuse the choice (DECISION_INPUTS_MISSING): the Story waits there.
      const run = walk(order[0], toward(decision, () => null));
      record(`${decision.id}:unavailable-evidence`, 'unavailable-evidence', run, { decision: decision.id,
        detail: 'The decision inputs were not recorded; the engine refuses to choose a route, so the Story waits at this step.' });
    }
  }
  for (const phase of phases) {
    if (phase.approval?.mode !== 'required') continue;
    for (const target of phase.approval.rejectTo ?? []) {
      if (!byPhase.has(target) || order.indexOf(target) > order.indexOf(phase.id)) {
        findings.push({ code: 'WORKFLOW_REJECTION_TARGET', severity: 'error', phase: phase.id,
          message: `Rejecting '${phase.id}' returns to '${target}', which is not this step or an earlier one.` });
        continue;
      }
      const prefix = walk(order[0], (current) => pass(current));
      const reached = prefix.path.indexOf(phase.id);
      if (reached < 0) continue;
      const run = walk(target, pass, { path: [...prefix.path.slice(0, reached + 1), `rejected:${target}`], choices: [] });
      record(`${phase.id}:rejected:${target}`, 'rejection', run, { phase: phase.id, rejectTo: target });
      if (run.outcome !== 'end') {
        findings.push({ code: 'WORKFLOW_ROUTE_NO_END', severity: 'error', phase: phase.id,
          message: `After rejecting '${phase.id}' to '${target}', a passing run does not reach the end.` });
      }
    }
  }
  const reached = new Set(scenarios.flatMap((scenario) => scenario.path));
  for (const phaseId of order) {
    if (!reached.has(phaseId)) {
      findings.push({ code: 'WORKFLOW_PHASE_UNREACHABLE', severity: 'error', phase: phaseId,
        message: `No route reaches step '${phaseId}'.` });
    }
  }
  if (scenarios.some((scenario) => scenario.outcome === 'unbounded')) {
    findings.push({ code: 'WORKFLOW_ROUTE_UNBOUNDED', severity: 'error', message: 'A route repeats without a bound.' });
  }
  return {
    schemaVersion: 1,
    resultType: 'workflow-route-simulation',
    workflow: resolved.id ?? null,
    status: findings.some((finding) => finding.severity === 'error') ? 'failed' : 'passed',
    counts: Object.fromEntries(['pass', 'route', 'repair', 'exhausted', 'unavailable-evidence', 'rejection']
      .map((kind) => [kind, scenarios.filter((scenario) => scenario.kind === kind).length])),
    coverage: { phases: { reached: order.filter((phaseId) => reached.has(phaseId)).length, total: order.length },
      routes: decisions.flatMap((decision) => decision.routes.map((route) => ({ decision: decision.id, route: route.id,
        reachable: Boolean(selectors.get(decision.id).get(route.id)) }))) },
    scenarios,
    findings
  };
}

