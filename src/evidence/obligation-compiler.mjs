/**
 * Compile a work type's routes into the responsibilities every route guarantees [E2G-005].
 *
 * The route graph has one node per step plus the end, with edges for the natural order, every
 * decision route (an `anyStep` ask may go anywhere), and every send-back rule. A forward
 * must-analysis over bitsets computes what each step is guaranteed to have behind it on every
 * route, so the cost stays polynomial and no path is ever enumerated. Then:
 *
 * - every edge into the end must guarantee scope, plan, implement, verify and review, unless the
 *   edge declares `omits` naming each missing responsibility, a reason, and the approval group that
 *   must record an applicability decision when a Story takes that route;
 * - a step that implements must have a plan behind it on every route;
 * - evidence a step verifies must meet a review before the end on every route.
 *
 * Pure and non-throwing: problems are findings with a resolving action, so one broken workflow
 * never makes the rest of the catalog unreadable. The digest is pinned with each new Story.
 */
import { phaseRequiresCodeDelivery } from '../code-delivery-policy.mjs';
import { recordSha256 } from '../records.mjs';
import { phaseResponsibilities, reviewKind } from './responsibilities.mjs';

export const OBLIGATION_COMPILER_VERSION = 1;
export const END = '$end';
const REQUIRED = Object.freeze(['scope', 'plan', 'implement', 'verify', 'review']);
const BIT = Object.freeze({ scope: 1, plan: 2, implement: 4, verify: 8, review: 16, 'human-review': 32 });
const ALL = 63;
const WORDS = Object.freeze({
  scope: 'defined requirements (scope)', plan: 'a plan', implement: 'implementation', verify: 'verification', review: 'a review'
});

function approvalOf(phase) {
  return phase?.approvalPolicy ?? phase?.approval ?? null;
}

function bits(names) {
  return names.reduce((sum, name) => sum | BIT[name], 0);
}

function names(mask) {
  return REQUIRED.filter((name) => mask & BIT[name]);
}

function list(values) {
  return values.length <= 1 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}

/** Normalize the omissions one end edge declares; problems become findings, never throws. */
export function normalizeOmits(value, { where, authorities = {} } = {}) {
  const problems = [];
  if (value == null) return { omits: [], problems };
  if (!Array.isArray(value)) return { omits: [], problems: [`${where}.omits must be a list.`] };
  const omits = [];
  for (const [index, entry] of value.entries()) {
    const at = `${where}.omits[${index}]`;
    const responsibility = entry?.responsibility;
    const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
    const authority = entry?.authority;
    if (!REQUIRED.includes(responsibility)) problems.push(`${at}.responsibility must be one of ${REQUIRED.join(', ')}.`);
    if (reason.length < 20 || reason.length > 1000 || /\b(?:todo|tbd|fixme|placeholder)\b/i.test(reason)) {
      problems.push(`${at}.reason must be a concrete 20-1000 character explanation.`);
    }
    if (typeof authority !== 'string' || !Object.hasOwn(authorities, authority)) {
      problems.push(`${at}.authority must name an approval group that records the applicability decision.`);
    }
    if (REQUIRED.includes(responsibility)) omits.push({ responsibility, reason, authority: authority ?? null });
  }
  return { omits, problems };
}

/** Build the route graph of a resolved work type. */
export function routeGraph(workType) {
  const phases = workType.phases ?? [];
  const order = phases.map((phase) => phase.id);
  const decisions = workType.decisions ?? [];
  const edges = [];
  const naturalOmits = workType.omits ?? [];
  for (const [index, phase] of phases.entries()) {
    const next = order[index + 1] ?? END;
    const decision = decisions.find((entry) => entry.after === phase.id);
    if (!decision) {
      edges.push({ from: phase.id, to: next, kind: 'next', decision: null, route: null, omits: next === END ? naturalOmits : [] });
    } else if (decision.anyStep) {
      for (const target of [...order.filter((id) => id !== phase.id), END]) {
        edges.push({ from: phase.id, to: target, kind: 'route', decision: decision.id, route: target === END ? 'any-step:end' : `any-step:${target}`, omits: [] });
      }
    } else {
      for (const route of decision.routes ?? []) {
        const to = route.to === 'end' ? END : route.to === 'next' ? next : route.to;
        const omits = route.omits ?? (route.to === 'next' && to === END ? naturalOmits : []);
        edges.push({ from: phase.id, to, kind: 'route', decision: decision.id, route: route.id, omits });
      }
    }
    for (const back of approvalOf(phase)?.rejectTo ?? []) {
      if (back !== phase.id && order.indexOf(back) >= 0 && order.indexOf(back) < index) {
        edges.push({ from: phase.id, to: back, kind: 'rework', decision: null, route: null, omits: [] });
      }
    }
  }
  for (const loop of workType.reworkLoops ?? []) {
    if (order.includes(loop.from) && order.includes(loop.to)) {
      edges.push({ from: loop.from, to: loop.to, kind: 'rework', decision: null, route: null, omits: [] });
    }
  }
  const unique = new Map(edges.map((edge) => [`${edge.from}>${edge.to}>${edge.kind}>${edge.decision}>${edge.route}`, edge]));
  return { order, edges: [...unique.values()] };
}

/** Compile a resolved work type. Returns the graph, findings and the pinned digests. */
export function compileObligationGraph(workType, { authorities = workType.approvalAuthorities ?? {} } = {}) {
  const workTypeId = workType.id ?? 'work-type';
  const phases = workType.phases ?? [];
  const findings = [];
  const finding = (code, severity, message, resolvingAction, subject = {}) =>
    findings.push({ code, severity, message, resolvingAction, subject: { workType: workTypeId, ...subject } });
  if (!phases.length) {
    finding('OBLIGATION_GRAPH_EMPTY', 'error', `Work type '${workTypeId}' has no steps.`, 'Add the steps this work type runs.');
    return { compilerVersion: OBLIGATION_COMPILER_VERSION, nodes: [], edges: [], endpoints: [], findings, digest: null, shapeDigest: null };
  }
  if (workType.plannedClaims?.mode === 'retired-opt-out') {
    finding('OBLIGATION_OPT_OUT_RETIRED', 'error', `Work type '${workTypeId}' opts out of planned claims, which is no longer allowed.`,
      'Plan the claims in a step before the code step (plannedClaims mode required). A work type that defines no requirement clauses declares omits for scope instead, with a concrete reason and the approval group that records the applicability decision.');
  }
  const naturalOmits = normalizeOmits(workType.omits, { where: `Work type '${workTypeId}'`, authorities });
  for (const problem of naturalOmits.problems) {
    finding('OBLIGATION_OMIT_INVALID', 'error', problem, 'Name the responsibility, a concrete reason and the approval group that decides.');
  }
  const routedOmits = [];
  const decisions = (workType.decisions ?? []).map((decision) => ({
    ...decision,
    routes: (decision.routes ?? []).map((route) => {
      if (route.omits === undefined) return route;
      const normalized = normalizeOmits(route.omits, { where: `Decision '${decision.id}' route '${route.id}'`, authorities });
      for (const problem of normalized.problems) routedOmits.push(problem);
      return { ...route, omits: normalized.omits };
    })
  }));
  for (const problem of routedOmits) {
    finding('OBLIGATION_OMIT_INVALID', 'error', problem, 'Name the responsibility, a concrete reason and the approval group that decides.');
  }
  const { order, edges } = routeGraph({ ...workType, decisions, omits: naturalOmits.omits });
  const hasCodeStep = phases.some((phase) => phaseRequiresCodeDelivery(phase));
  const nodes = phases.map((phase) => ({
    id: phase.id,
    responsibilities: phaseResponsibilities(phase, { plannedClaims: workType.plannedClaims, hasCodeStep }),
    reviewKind: reviewKind(phase)
  }));
  const gen = new Map(nodes.map((node) => [node.id, bits(node.responsibilities) | (node.reviewKind === 'human' ? BIT['human-review'] : 0)]));
  const forward = edges.filter((edge) => edge.to !== END);
  const preds = new Map(order.map((id) => [id, []]));
  for (const edge of forward) preds.get(edge.to)?.push(edge.from);

  // Reachability first: a step no route reaches owes nothing and guarantees nothing.
  const reachable = new Set([order[0]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of forward) {
      if (reachable.has(edge.from) && !reachable.has(edge.to)) { reachable.add(edge.to); changed = true; }
    }
  }
  // Forward must-analysis: what every route into a step is guaranteed to have done.
  const into = new Map(order.map((id) => [id, id === order[0] ? 0 : ALL]));
  const out = new Map(order.map((id) => [id, (into.get(id) | gen.get(id))]));
  for (let changed = true; changed;) {
    changed = false;
    for (const id of order) {
      if (!reachable.has(id)) continue;
      const incoming = preds.get(id).filter((from) => reachable.has(from));
      let mask = id === order[0] ? 0 : ALL;
      for (const from of incoming) mask &= out.get(from);
      if (id !== order[0] && !incoming.length) mask = 0;
      const after = mask | gen.get(id);
      if (mask !== into.get(id) || after !== out.get(id)) { into.set(id, mask); out.set(id, after); changed = true; }
    }
  }

  const describe = (edge) => edge.route
    ? `route '${edge.route}' of decision '${edge.decision}' after '${edge.from}'`
    : `finishing after '${edge.from}'`;
  const endpoints = [];
  for (const edge of edges.filter((candidate) => candidate.to === END && reachable.has(candidate.from))) {
    const guaranteed = names(out.get(edge.from));
    const omitted = edge.omits.map((entry) => entry.responsibility);
    const missing = REQUIRED.filter((name) => !guaranteed.includes(name) && !omitted.includes(name));
    const unnecessary = omitted.filter((name) => guaranteed.includes(name));
    endpoints.push({ from: edge.from, decision: edge.decision, route: edge.route, guaranteed, missing, omits: edge.omits });
    if (missing.length) {
      finding('OBLIGATION_ROUTE_DROPS_RESPONSIBILITY', 'error',
        `Work type '${workTypeId}': ${describe(edge)} ends the Story without ${list(missing.map((name) => WORDS[name]))}.`,
        'Route through steps that define requirements, plan, implement, verify and review, or declare omits on this route naming each responsibility, a concrete reason and the approval group that must record why it does not apply.',
        { phase: edge.from, decision: edge.decision, route: edge.route, missing });
    }
    if (unnecessary.length) {
      finding('OBLIGATION_OMIT_UNNECESSARY', 'warning',
        `Work type '${workTypeId}': ${describe(edge)} omits ${list(unnecessary)}, which every route to it already meets.`,
        'Remove the omission so no applicability decision is asked for a responsibility that is met.',
        { phase: edge.from, decision: edge.decision, route: edge.route });
    }
    if (!missing.includes('review') && !omitted.includes('review') && !(out.get(edge.from) & BIT['human-review'])) {
      finding('OBLIGATION_REVIEW_POLICY_ONLY', 'warning',
        `Work type '${workTypeId}': only automatic policy approvals review the Story on ${describe(edge)}; no person reviews it.`,
        'Require a person\'s approval on at least one step every route to this end passes.',
        { phase: edge.from, decision: edge.decision, route: edge.route });
    }
  }

  // Backward: does every route from a step end through an edge that omits a responsibility? A
  // route that omits plan with an applicability decision may implement without one.
  const omittedOnEveryRoute = (responsibility) => {
    const omitted = new Map(order.map((id) => [id, true]));
    for (let changed = true; changed;) {
      changed = false;
      for (const id of order) {
        const outgoing = edges.filter((edge) => edge.from === id);
        const value = outgoing.length > 0 && outgoing.every((edge) => edge.to === END
          ? edge.omits.some((entry) => entry.responsibility === responsibility)
          : omitted.get(edge.to));
        if (value !== omitted.get(id)) { omitted.set(id, value); changed = true; }
      }
    }
    return omitted;
  };
  const planOmitted = omittedOnEveryRoute('plan');
  const reviewOmitted = omittedOnEveryRoute('review');
  for (const node of nodes) {
    if (!reachable.has(node.id)) continue;
    if (node.responsibilities.includes('implement') && !(into.get(node.id) & BIT.plan) && !planOmitted.get(node.id)) {
      finding('OBLIGATION_IMPLEMENT_WITHOUT_PLAN', 'error',
        `Work type '${workTypeId}': '${node.id}' can write repository source on a route where no step planned the change first.`,
        'Put the step that plans the claims (its planned-claims owner) before it on every route.',
        { phase: node.id });
    }
  }

  // Backward must-analysis: from each step, does every route meet a review before the end?
  const succ = new Map(order.map((id) => [id, []]));
  for (const edge of edges) succ.get(edge.from)?.push(edge.to);
  const reviewed = new Map([...order.map((id) => [id, false]), [END, false]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of order) {
      const value = Boolean(gen.get(id) & BIT.review) || (succ.get(id).length > 0 && succ.get(id).every((to) => reviewed.get(to)));
      if (value !== reviewed.get(id)) { reviewed.set(id, value); changed = true; }
    }
  }
  for (const node of nodes) {
    if (!reachable.has(node.id) || !node.responsibilities.includes('verify') || node.responsibilities.includes('review')
        || reviewOmitted.get(node.id)) continue;
    if (!succ.get(node.id).every((to) => reviewed.get(to))) {
      finding('OBLIGATION_VERIFY_WITHOUT_REVIEW', 'error',
        `Work type '${workTypeId}': the evidence '${node.id}' produces can reach the end without a review.`,
        'Require approval on that step, or on a later step every route from it passes.',
        { phase: node.id });
    }
  }

  const graph = {
    nodes: nodes.map((node) => ({ id: node.id, responsibilities: node.responsibilities, reviewKind: node.reviewKind })),
    edges: edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind, decision: edge.decision, route: edge.route, omits: edge.omits }))
  };
  // A consistent rename of every step leaves the shape digest unchanged [E2G criterion 1].
  const position = new Map(order.map((id, index) => [id, `step-${index + 1}`]));
  const rename = (id) => (id === END ? END : position.get(id) ?? id);
  const shape = {
    nodes: graph.nodes.map((node) => ({ ...node, id: rename(node.id) })),
    edges: graph.edges.map((edge) => ({
      ...edge, from: rename(edge.from), to: rename(edge.to),
      route: edge.route?.startsWith('any-step:') ? `any-step:${rename(edge.route.slice(9) === 'end' ? END : edge.route.slice(9))}` : edge.route
    }))
  };
  return {
    compilerVersion: OBLIGATION_COMPILER_VERSION,
    ...graph,
    endpoints,
    findings,
    digest: `sha256:${recordSha256({ compilerVersion: OBLIGATION_COMPILER_VERSION, ...graph })}`,
    shapeDigest: `sha256:${recordSha256({ compilerVersion: OBLIGATION_COMPILER_VERSION, ...shape })}`
  };
}

/** What a Story pins: the graph and its digests. Findings belong to the catalog, not the Story. */
export function pinnedObligationGraph(compiled) {
  return structuredClone({
    compilerVersion: compiled.compilerVersion, digest: compiled.digest, shapeDigest: compiled.shapeDigest,
    nodes: compiled.nodes, edges: compiled.edges, endpoints: compiled.endpoints
  });
}

/** True when the compiled graph lets a Story start: no error-level finding. */
export function obligationGraphStartable(compiled) {
  return !(compiled?.findings ?? []).some((entry) => entry.severity === 'error');
}
