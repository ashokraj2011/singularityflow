/**
 * Decision nodes: what a Story does after a phase, chosen by facts a person approved or by a person.
 *
 * A Story workflow is an ordered list of phases, and until now the only way off that line was a
 * reviewer sending work back. A decision sits after one phase and chooses what comes next:
 *
 * - `branch` — ordered rules read values the phase recorded when it was submitted ("risk: high")
 *   and choose the next phase, skipping the ones in between, or finish the Story. The last route has
 *   no rule and takes everything the others did not.
 * - `loop` — go back to an earlier phase until a goal holds, at most `maxRounds` times.
 * - `ask` — the Story pauses and a person from `by` chooses the next phase.
 *
 * None of these removes the person the kernel insists on `[SPK:CON-037]`. A route that goes back,
 * or that skips a phase a person signs off, is taken automatically only after a phase a person signs
 * off — so every round passes someone who saw what approving would do — and a loop that reaches its
 * limit stops and asks instead of carrying on. Everything here is pure: it validates configuration
 * and computes outcomes. The lifecycle owner applies them, inside its own transaction.
 */
import { createHash } from 'node:crypto';
import { phaseRequiresCodeDelivery } from './code-delivery-policy.mjs';
import { canonicalJson } from './records.mjs';
import { SingularityFlowError } from './util.mjs';

export const DECISION_KINDS = Object.freeze(['branch', 'loop', 'ask']);
/** Route targets that are not phase IDs: the phase after the deciding one, or finishing the Story. */
export const DECISION_NEXT = 'next';
export const DECISION_END = 'end';
export const DEFAULT_DECISION_ROUNDS = 3;

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const INPUT_NAME = /^[a-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
const LIMITS = Object.freeze({ routes: 10, inputs: 10, values: 20, label: 120, value: 60, rounds: 20 });
const NUMBER_TESTS = Object.freeze(['atLeast', 'atMost', 'above', 'below']);
const ENTRY_KEYS = Object.freeze(['id', 'after', 'kind', 'label', 'inputs', 'routes', 'goal', 'back', 'maxRounds', 'by', 'anyStep']);
const INPUT_KEYS = Object.freeze(['name', 'label', 'type', 'values', 'minimum', 'maximum']);
const ROUTE_KEYS = Object.freeze(['id', 'label', 'when', 'to']);

function invalid(message) {
  return new SingularityFlowError(message, { code: 'WORKFLOW_DECISION_INVALID' });
}

function list(values) {
  const quoted = values.map((value) => `'${value}'`);
  return quoted.length < 2 ? quoted.join('') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
}

function text(value, label, { required = true, limit = LIMITS.label } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} must be non-empty text.`);
  const trimmed = value.trim();
  if (trimmed.length > limit || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw invalid(`${label} must be at most ${limit} characters on one line.`);
  }
  return trimmed;
}

/**
 * Where a route leads from the deciding phase: the next phase, a later one (skipping those between),
 * the end of the Story (skipping the rest), or back to the deciding phase or an earlier one.
 */
export function routeReach(order, afterId, to) {
  const from = order.indexOf(afterId);
  if (to === DECISION_NEXT) {
    return from + 1 < order.length
      ? { kind: 'next', target: order[from + 1], skipped: [] }
      : { kind: 'end', target: null, skipped: [] };
  }
  if (to === DECISION_END) return { kind: 'end', target: null, skipped: order.slice(from + 1) };
  const at = order.indexOf(to);
  if (at < 0) return { kind: 'unknown', target: to, skipped: [] };
  if (at <= from) return { kind: 'backward', target: to, skipped: [] };
  return { kind: at === from + 1 ? 'next' : 'forward', target: to, skipped: order.slice(from + 1, at) };
}

function normalizeInputs(value, where) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > LIMITS.inputs) {
    throw invalid(`${where}.inputs must be a list of at most ${LIMITS.inputs} values the phase records.`);
  }
  const names = new Set();
  return value.map((input, index) => {
    const label = `${where}.inputs[${index}]`;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid(`${label} must be an object.`);
    for (const key of Object.keys(input)) if (!INPUT_KEYS.includes(key)) throw invalid(`${label} contains unknown field '${key}'.`);
    if (!INPUT_NAME.test(input.name ?? '') || input.name.length > 40) {
      throw invalid(`${label}.name must start with a letter and use letters, digits and hyphens (at most 40).`);
    }
    if (names.has(input.name)) throw invalid(`${where} records '${input.name}' twice.`);
    names.add(input.name);
    const display = text(input.label, `${label}.label`, { required: false }) ?? input.name;
    if (input.type === 'number') {
      if (input.values !== undefined) throw invalid(`${label} is a number, so it takes minimum and maximum instead of values.`);
      for (const key of ['minimum', 'maximum']) {
        if (input[key] != null && !Number.isFinite(input[key])) throw invalid(`${label}.${key} must be a number.`);
      }
      if (input.minimum != null && input.maximum != null && input.minimum > input.maximum) {
        throw invalid(`${label}.minimum must not be greater than its maximum.`);
      }
      return { name: input.name, label: display, type: 'number', minimum: input.minimum ?? null, maximum: input.maximum ?? null };
    }
    if (input.type !== undefined && input.type !== 'choice') throw invalid(`${label}.type must be choice or number.`);
    if (input.minimum !== undefined || input.maximum !== undefined) throw invalid(`${label} is a choice, so it takes values instead of minimum and maximum.`);
    if (!Array.isArray(input.values) || !input.values.length || input.values.length > LIMITS.values) {
      throw invalid(`${label}.values must list 1 to ${LIMITS.values} choices.`);
    }
    const values = input.values.map((choice, valueIndex) => text(choice, `${label}.values[${valueIndex}]`, { limit: LIMITS.value }));
    if (new Set(values.map((choice) => choice.toLowerCase())).size !== values.length) throw invalid(`${label}.values must not repeat a choice.`);
    return { name: input.name, label: display, type: 'choice', values };
  });
}

/** One canonical test per input, so evaluation and display never re-interpret the YAML shorthand. */
function normalizeTest(value, input, label) {
  if (input.type === 'number') {
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalid(`${label} must be a number.`);
      return { equals: value };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw invalid(`${label} must be a number, { not: N }, or bounds such as { atLeast: N }.`);
    }
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'not') {
      if (!Number.isFinite(value.not)) throw invalid(`${label}.not must be a number.`);
      return { notEquals: value.not };
    }
    if (!keys.length || keys.some((key) => !NUMBER_TESTS.includes(key))) {
      throw invalid(`${label} may use atLeast, atMost, above and below.`);
    }
    const test = {};
    for (const key of NUMBER_TESTS) {
      if (value[key] === undefined) continue;
      if (!Number.isFinite(value[key])) throw invalid(`${label}.${key} must be a number.`);
      test[key] = value[key];
    }
    return test;
  }
  const choose = (choices, at) => {
    const array = Array.isArray(choices) ? choices : [choices];
    if (!array.length) throw invalid(`${at} must name at least one choice.`);
    return [...new Set(array.map((choice) => {
      const found = typeof choice === 'string'
        ? input.values.find((declared) => declared.toLowerCase() === choice.trim().toLowerCase())
        : undefined;
      if (!found) throw invalid(`${at} uses '${choice}', which is not one of ${input.label}'s choices (${input.values.join(', ')}).`);
      return found;
    }))];
  };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'not') throw invalid(`${label} must be a choice, a list of choices, or { not: ... }.`);
    return { notIn: choose(value.not, `${label}.not`) };
  }
  return { in: choose(value, label) };
}

function normalizeWhen(value, inputs, label, { required = false } = {}) {
  if (value == null) {
    if (required) throw invalid(`${label} must say which recorded values meet it.`);
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
    throw invalid(`${label} must map recorded values to what they must be, for example { risk: high }.`);
  }
  const when = {};
  for (const [name, test] of Object.entries(value)) {
    const input = inputs.find((candidate) => candidate.name === name);
    if (!input) {
      throw invalid(`${label} refers to '${name}', which is not one of this decision's inputs${inputs.length ? ` (${inputs.map((entry) => entry.name).join(', ')})` : ''}.`);
    }
    when[name] = normalizeTest(test, input, `${label}.${name}`);
  }
  return when;
}

function normalizeRoutes(value, { where, kind, inputs, order }) {
  const minimum = 2;
  if (!Array.isArray(value) || value.length < minimum || value.length > LIMITS.routes) {
    throw invalid(`${where}.routes must list ${minimum} to ${LIMITS.routes} ${kind === 'ask' ? 'options' : 'routes'}.`);
  }
  const ids = new Set();
  return value.map((route, index) => {
    const label = `${where}.routes[${index}]`;
    if (!route || typeof route !== 'object' || Array.isArray(route)) throw invalid(`${label} must be an object.`);
    for (const key of Object.keys(route)) if (!ROUTE_KEYS.includes(key)) throw invalid(`${label} contains unknown field '${key}'.`);
    if (!ID.test(route.id ?? '')) throw invalid(`${label}.id must be a lowercase kebab-case id.`);
    if (ids.has(route.id)) throw invalid(`${where} has two routes named '${route.id}'.`);
    ids.add(route.id);
    const display = text(route.label, `${label}.label`);
    if (typeof route.to !== 'string' || !(route.to === DECISION_NEXT || route.to === DECISION_END || order.includes(route.to))) {
      throw invalid(`${label}.to must be a phase in this workflow, next, or end.`);
    }
    const last = index === value.length - 1;
    let when = null;
    if (kind === 'ask') {
      if (route.when !== undefined) throw invalid(`${label}: an ask decision's options are chosen by a person, so they take no when.`);
    } else if (last) {
      if (route.when !== undefined) throw invalid(`${label} is the last route, so it takes everything else and needs no when.`);
    } else {
      when = normalizeWhen(route.when, inputs, `${label}.when`, { required: true });
    }
    return { id: route.id, label: display, when, to: route.to };
  });
}

function normalizeBy(value, after, authorities, where) {
  const configured = value == null ? null : Array.isArray(value) ? value : [value];
  if (configured && (!configured.length || configured.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw invalid(`${where}.by must name one or more approval groups.`);
  }
  const by = configured
    ? [...new Set(configured.map((id) => id.trim()))]
    : after.approval?.mode && after.approval.mode !== 'none' ? [...(after.approval.authorities ?? [])] : [];
  for (const id of by) {
    if (!Object.hasOwn(authorities ?? {}, id)) throw invalid(`${where}.by names unknown approval group '${id}'.`);
  }
  return by;
}

/**
 * A route that skips phases must not strand a phase it still reaches: a skipped phase that a later
 * phase reads, takes test evidence from, or that plans the claims a code phase must meet would make
 * the Story fail at that later phase instead of here, where the cause is visible.
 */
function assertRouteKeepsDependencies(where, route, reach, { order, byId, plannedClaims }) {
  if (!reach.skipped.length) return;
  const skipped = new Set(reach.skipped);
  const reached = reach.target ? order.slice(order.indexOf(reach.target)) : [];
  for (const phaseId of reached) {
    const phase = byId.get(phaseId);
    for (const input of phase.inputs ?? []) {
      if (skipped.has(input.phase) && !input.optional) {
        throw invalid(`${where} route '${route.id}' skips '${input.phase}', which '${phaseId}' reads. Mark that input optional in this workflow, or do not skip '${input.phase}'.`);
      }
    }
    if (phase.testEvidenceFrom && skipped.has(phase.testEvidenceFrom)) {
      throw invalid(`${where} route '${route.id}' skips '${phase.testEvidenceFrom}', whose test evidence '${phaseId}' reviews.`);
    }
  }
  if (plannedClaims?.mode === 'required') {
    const planners = new Set([...(plannedClaims.clausePhases ?? []), ...Object.values(plannedClaims.owners ?? {})]);
    const skippedPlanners = reach.skipped.filter((phaseId) => planners.has(phaseId));
    const reachedCode = reached.filter((phaseId) => phaseRequiresCodeDelivery(byId.get(phaseId)));
    if (skippedPlanners.length && reachedCode.length) {
      throw invalid(`${where} route '${route.id}' skips ${list(skippedPlanners)}, which plan the claims '${reachedCode[0]}' must meet.`);
    }
  }
}

/**
 * Validate and normalize a work type's decisions against its resolved phases.
 *
 * `phases` are resolved phase objects (id, approval, inputs, testEvidenceFrom, ...) in workflow
 * order; the rules above about people need the resolved approval mode, which an override may change.
 */
export function normalizeDecisions(value, {
  workTypeId = 'work type', phases = [], approvalAuthorities = {}, plannedClaims = null
} = {}) {
  if (value == null) return [];
  const prefix = `Work type '${workTypeId}' decisions`;
  if (!Array.isArray(value)) throw invalid(`${prefix} must be a list.`);
  const order = phases.map((phase) => phase.id);
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const ids = new Set();
  const afters = new Set();
  return value.map((entry, index) => {
    const label = `${prefix}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid(`${label} must be an object.`);
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) throw invalid(`${label} contains unknown field '${key}'.`);
    if (!ID.test(entry.id ?? '')) throw invalid(`${label}.id must be a lowercase kebab-case id.`);
    if (ids.has(entry.id)) throw invalid(`${prefix} name '${entry.id}' twice.`);
    ids.add(entry.id);
    const where = `${prefix} '${entry.id}'`;
    if (!order.includes(entry.after)) throw invalid(`${where}.after must name a phase in this workflow.`);
    if (afters.has(entry.after)) throw invalid(`${where}: phase '${entry.after}' already has a decision after it.`);
    afters.add(entry.after);
    const after = byId.get(entry.after);
    if (after.id === 'convergence' || after.convergence != null) {
      throw invalid(`${where} cannot follow convergence; convergence already ends in a person's disposition.`);
    }
    if (!DECISION_KINDS.includes(entry.kind)) throw invalid(`${where}.kind must be branch, loop, or ask.`);
    const kind = entry.kind;
    const display = text(entry.label, `${where}.label`);
    if (kind === 'ask' && entry.inputs !== undefined) {
      throw invalid(`${where} is an ask decision: a person chooses, so it records no inputs.`);
    }
    const inputs = normalizeInputs(entry.inputs, where);
    if (kind !== 'ask' && !inputs.length) throw invalid(`${where} must declare the inputs its rules read.`);
    let routes;
    let goal = null;
    let back = null;
    if (kind === 'loop') {
      if (entry.routes !== undefined) throw invalid(`${where} is a loop: give goal, back and maxRounds instead of routes.`);
      goal = normalizeWhen(entry.goal, inputs, `${where}.goal`, { required: true });
      if (!order.includes(entry.back) || order.indexOf(entry.back) > order.indexOf(after.id)) {
        throw invalid(`${where}.back must name '${after.id}' or an earlier phase in this workflow.`);
      }
      back = entry.back;
      routes = [
        { id: 'goal-met', label: 'Goal met', when: goal, to: DECISION_NEXT },
        { id: 'again', label: `Back to ${byId.get(back).label ?? back}`, when: null, to: back }
      ];
    } else {
      if (entry.goal !== undefined || entry.back !== undefined) throw invalid(`${where}: goal and back belong to loop decisions.`);
      routes = normalizeRoutes(entry.routes, { where, kind, inputs, order });
    }
    const reaches = routes.map((route) => routeReach(order, after.id, route.to));
    const goesBack = reaches.some((reach) => reach.kind === 'backward');
    let maxRounds = null;
    if (kind === 'ask') {
      if (entry.maxRounds !== undefined) throw invalid(`${where}.maxRounds applies to branch and loop decisions; a person chooses every round of an ask.`);
    } else if (goesBack) {
      maxRounds = entry.maxRounds ?? DEFAULT_DECISION_ROUNDS;
      if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > LIMITS.rounds) {
        throw invalid(`${where}.maxRounds must be a whole number from 1 to ${LIMITS.rounds}.`);
      }
    } else if (entry.maxRounds !== undefined) {
      throw invalid(`${where}.maxRounds needs a route that goes back.`);
    }
    if (entry.anyStep !== undefined && (kind !== 'ask' || typeof entry.anyStep !== 'boolean')) {
      throw invalid(`${where}.anyStep is true or false, and only on ask decisions.`);
    }
    if (kind !== 'ask') {
      // `[SPK:CON-037]`: a rule never moves work back, or past a person's checkpoint, on facts no
      // person approved. Approval `policy` can be waived by a predicate, so only `required` counts.
      const signedOff = after.approval?.mode === 'required';
      routes.forEach((route, routeIndex) => {
        const reach = reaches[routeIndex];
        if (reach.kind === 'backward' && !signedOff) {
          throw invalid(`${where} route '${route.id}' goes back to '${route.to}'. A rule may send work back only after a phase a person signs off: require approval on '${after.id}', or make this an ask decision.`);
        }
        const gated = reach.skipped.filter((phaseId) => (byId.get(phaseId).approval?.mode ?? 'required') !== 'none');
        if (gated.length && !signedOff) {
          throw invalid(`${where} route '${route.id}' skips ${list(gated)}, which people sign off. Only a phase a person signs off can decide to skip them: require approval on '${after.id}', or make this an ask decision.`);
        }
      });
    }
    const by = normalizeBy(entry.by, after, approvalAuthorities, where);
    if ((kind === 'ask' || goesBack) && !by.length) {
      throw invalid(`${where} needs by: the approval groups whose members ${kind === 'ask' ? 'choose' : 'decide when the rounds run out'}. '${after.id}' has no approvers to default to.`);
    }
    routes.forEach((route, routeIndex) => assertRouteKeepsDependencies(where, route, reaches[routeIndex], { order, byId, plannedClaims }));
    return {
      id: entry.id,
      after: after.id,
      kind,
      label: display,
      mode: kind === 'ask' ? 'ask' : 'auto',
      inputs,
      routes,
      ...(kind === 'loop' ? { goal, back } : {}),
      maxRounds,
      by,
      anyStep: kind === 'ask' ? entry.anyStep === true : false
    };
  });
}

/** The decision pinned after a phase of this Story, or null. */
export function decisionAfter(workflow, phaseId) {
  return (workflow?.resolution?.decisions ?? []).find((decision) => decision.after === phaseId) ?? null;
}

/** The decision a phase feeds with inputs it must record at submission, or null. */
export function decisionFedBy(workflow, phaseId) {
  const decision = decisionAfter(workflow, phaseId);
  return decision?.mode === 'auto' && decision.inputs.length ? decision : null;
}

export function testHolds(test, value, input) {
  if (value == null) return false;
  if (input.type === 'number') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return false;
    if (Object.hasOwn(test, 'equals')) return number === test.equals;
    if (Object.hasOwn(test, 'notEquals')) return number !== test.notEquals;
    return (test.atLeast == null || number >= test.atLeast)
      && (test.atMost == null || number <= test.atMost)
      && (test.above == null || number > test.above)
      && (test.below == null || number < test.below);
  }
  if (test.in) return test.in.includes(value);
  if (test.notIn) return !test.notIn.includes(value);
  return false;
}

export function whenHolds(when, values, inputs) {
  return Object.entries(when ?? {}).every(([name, test]) => {
    const input = inputs.find((candidate) => candidate.name === name);
    return Boolean(input) && testHolds(test, values?.[name], input);
  });
}

/** The first route whose rule holds; the last route has none, so a branch or loop always chooses. */
export function chooseRoute(decision, values) {
  return decision.routes.find((route) => !route.when || whenHolds(route.when, values, decision.inputs)) ?? null;
}

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

/** How to record a decision's inputs, for refusals and prompts. */
export function decisionInputsHint(decision) {
  return decision.inputs.map((input) => input.type === 'number'
    ? `--decision ${input.name}=<number${input.minimum != null || input.maximum != null ? ` ${input.minimum ?? ''}..${input.maximum ?? ''}` : ''}>`
    : `--decision ${input.name}=<${input.values.join('|')}>`).join(' ');
}

/**
 * Check supplied values against the decision's inputs and return them normalized: a choice takes
 * its declared spelling, a number becomes a number. Every input is required — a rule reading a value
 * nobody recorded would quietly fall through to the last route.
 */
export function normalizeDecisionInputValues(decision, supplied = {}) {
  const values = {};
  const unknown = Object.keys(supplied).filter((name) => !decision.inputs.some((input) => input.name === name));
  if (unknown.length) {
    throw new SingularityFlowError(
      `Decision '${decision.label}' does not record ${list(unknown)}. It records: ${decision.inputs.map((input) => input.name).join(', ')}.`,
      { code: 'DECISION_INPUT_UNKNOWN' }
    );
  }
  const missing = [];
  for (const input of decision.inputs) {
    if (!Object.hasOwn(supplied, input.name) || String(supplied[input.name]).trim() === '') { missing.push(input.name); continue; }
    const raw = String(supplied[input.name]).trim();
    if (input.type === 'number') {
      const number = Number(raw);
      if (!Number.isFinite(number)
          || (input.minimum != null && number < input.minimum)
          || (input.maximum != null && number > input.maximum)) {
        throw new SingularityFlowError(
          `Decision input '${input.name}' must be a number${input.minimum != null ? ` from ${input.minimum}` : ''}${input.maximum != null ? ` up to ${input.maximum}` : ''}; got '${raw}'.`,
          { code: 'DECISION_INPUT_INVALID' }
        );
      }
      values[input.name] = number;
    } else {
      const found = input.values.find((choice) => choice.toLowerCase() === raw.toLowerCase());
      if (!found) {
        throw new SingularityFlowError(
          `Decision input '${input.name}' must be one of ${input.values.join(', ')}; got '${raw}'.`,
          { code: 'DECISION_INPUT_INVALID' }
        );
      }
      values[input.name] = found;
    }
  }
  if (missing.length) {
    throw new SingularityFlowError(
      `Decision '${decision.label}' after '${decision.after}' needs ${list(missing)}. Submit with ${decisionInputsHint(decision)}.`,
      { code: 'DECISION_INPUTS_MISSING', details: { decision: decision.id, missing } }
    );
  }
  return values;
}

/** The values a phase recorded for its decision this round, or null. */
export function recordedDecisionValues(phase, decision) {
  return phase?.decisionInputs?.decision === decision?.id ? phase.decisionInputs.values ?? null : null;
}

/**
 * What completing `phase` does under its decision, without changing anything.
 *
 * `{ kind: 'next' | 'forward' | 'end', target, skipped }` move on; `{ kind: 'loop', target, round }`
 * goes back; `{ kind: 'pause', reason: 'ask' | 'limit' }` waits for a person. Null when no decision
 * follows the phase, which keeps every existing workflow on its linear path.
 */
export function decisionOutcome(workflow, phase) {
  const decision = decisionAfter(workflow, phase.id);
  if (!decision) return null;
  const base = { decision: decision.id, label: decision.label, after: phase.id };
  if (decision.mode === 'ask') return { ...base, kind: 'pause', reason: 'ask', by: 'person' };
  const values = recordedDecisionValues(phase, decision);
  if (!values) {
    throw new SingularityFlowError(
      `Decision '${decision.label}' after '${phase.id}' has no recorded inputs. Submit '${phase.id}' with ${decisionInputsHint(decision)}.`,
      { code: 'DECISION_INPUTS_MISSING', details: { decision: decision.id } }
    );
  }
  const route = chooseRoute(decision, values);
  const reach = routeReach(workflow.phaseOrder, phase.id, route.to);
  const because = route.when ? describeWhen(route.when, decision.inputs) : null;
  // A loop goes back on its fallback route, which has no rule of its own; say which goal is unmet.
  const goal = decision.kind === 'loop' ? describeWhen(decision.goal, decision.inputs) : null;
  if (reach.kind === 'backward') {
    const used = workflow.decisionRounds?.[decision.id]?.count ?? 0;
    if (used >= decision.maxRounds) {
      return { ...base, kind: 'pause', reason: 'limit', route: route.id, routeLabel: route.label, round: used, maxRounds: decision.maxRounds, values, because, goal, by: 'rule' };
    }
    return { ...base, kind: 'loop', route: route.id, routeLabel: route.label, target: reach.target, round: used + 1, maxRounds: decision.maxRounds, values, because, goal, by: 'rule' };
  }
  return { ...base, kind: reach.kind, route: route.id, routeLabel: route.label, target: reach.target, skipped: reach.skipped, values, because, by: 'rule' };
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
      const round = outcome.maxRounds ? ` (round ${outcome.round} of ${outcome.maxRounds})` : '';
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

/**
 * The record of a Story waiting for a person. Its key binds a choice to exactly this question, so a
 * stale screen or a second person cannot answer a decision that has since changed.
 */
export function pendingDecisionRecord(workflow, phase, outcome, { at }) {
  const decision = decisionAfter(workflow, phase.id);
  const record = {
    schemaVersion: 1,
    decision: decision.id,
    label: decision.label,
    after: phase.id,
    reason: outcome.reason,
    askedAt: at,
    round: outcome.round ?? null,
    maxRounds: decision.maxRounds,
    by: [...decision.by],
    anyStep: decision.anyStep,
    values: recordedDecisionValues(phase, decision),
    options: decision.routes.map((route) => ({ id: route.id, label: route.label, to: route.to }))
  };
  record.key = createHash('sha256').update(canonicalJson(record)).digest('hex').slice(0, 16);
  return record;
}

/**
 * Resolve a person's choice for a pending decision: one of its options, or — when the decision
 * allows any step — a phase named directly. Returns where it leads, never applies it.
 */
export function resolveDecisionChoice(workflow, pending, { option = null, to = null } = {}) {
  if (!pending) throw new SingularityFlowError('This Story is not waiting for a decision.', { code: 'DECISION_NOT_PENDING' });
  if (Boolean(option) === Boolean(to)) {
    throw new SingularityFlowError(
      `Choose one option with --option (${pending.options.map((entry) => entry.id).join(', ')})${pending.anyStep ? ', or a step with --to' : ''}.`,
      { code: 'DECISION_CHOICE_REQUIRED' }
    );
  }
  let route;
  if (option) {
    route = pending.options.find((entry) => entry.id === option);
    if (!route) {
      throw new SingularityFlowError(`'${option}' is not an option of '${pending.label}'. Options: ${pending.options.map((entry) => `${entry.id} (${entry.label})`).join(', ')}.`,
        { code: 'DECISION_OPTION_UNKNOWN' });
    }
  } else {
    if (!pending.anyStep) {
      throw new SingularityFlowError(`'${pending.label}' offers fixed options; choose one with --option.`, { code: 'DECISION_STEP_NOT_ALLOWED' });
    }
    if (!(to === DECISION_END || workflow.phaseOrder.includes(to))) {
      throw new SingularityFlowError(`--to must name a phase of this Story or end.`, { code: 'DECISION_STEP_NOT_ALLOWED' });
    }
    route = { id: 'step', label: to === DECISION_END ? 'Finish the Story' : `Go to ${workflow.phases[to]?.label ?? to}`, to };
  }
  const reach = routeReach(workflow.phaseOrder, pending.after, route.to);
  return { route, reach };
}

/**
 * The same dependency rule the configuration enforces, for a step a person names at run time: a
 * choice must not skip a phase that a phase it still reaches reads.
 */
export function assertChoiceKeepsDependencies(workflow, pending, reach, plannedClaims = workflow?.resolution?.plannedClaims) {
  const order = workflow.phaseOrder;
  const byId = new Map(order.map((id) => [id, {
    ...workflow.phases[id],
    inputs: workflow.phases[id]?.inputs ?? [],
    testEvidenceFrom: workflow.resolution?.phases?.find((phase) => phase.id === id)?.testEvidenceFrom,
    artifact: workflow.resolution?.phases?.find((phase) => phase.id === id)?.artifact,
    generation: workflow.resolution?.phases?.find((phase) => phase.id === id)?.generation
  }]));
  try {
    assertRouteKeepsDependencies(`Decision '${pending.label}'`, { id: 'chosen' }, reach, { order, byId, plannedClaims });
  } catch (error) {
    throw new SingularityFlowError(error.message.replace(" route 'chosen'", ''), { code: 'DECISION_STEP_NOT_ALLOWED' });
  }
}

/**
 * Everything a person or a screen needs about a Story's decisions, read from its pinned policy and
 * state: the decisions it carries, the one after its current phase and what that phase must record,
 * the question waiting for a person, which phases were skipped and why, and the log.
 */
export function storyDecisionView(workflow) {
  const order = workflow?.phaseOrder ?? [];
  const name = (id) => id === DECISION_END ? 'Finish the Story'
    : id === DECISION_NEXT ? 'Next step' : workflow?.phases?.[id]?.label ?? id;
  const current = workflow?.currentPhase ? workflow.phases?.[workflow.currentPhase] ?? null : null;
  const ahead = current ? decisionAfter(workflow, current.id) : null;
  const recorded = current && ahead ? recordedDecisionValues(current, ahead) : null;
  let projection = null;
  if (ahead?.mode === 'auto' && recorded && !workflow.pendingDecision) {
    try {
      const outcome = decisionOutcome(workflow, current);
      projection = { kind: outcome.kind, target: outcome.target ?? null, route: outcome.route ?? null, text: describeOutcome(workflow, outcome) };
    } catch { projection = null; }
  }
  const reachOf = (after, to) => {
    const reach = routeReach(order, after, to);
    return { reach: reach.kind, target: reach.target, skips: reach.skipped };
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
      maxRounds: decision.maxRounds,
      rounds: workflow.decisionRounds?.[decision.id]?.count ?? 0,
      inputs: decision.inputs,
      routes: decision.routes.map((route) => ({
        id: route.id, label: route.label, to: route.to, toLabel: name(route.to), when: route.when,
        rule: route.when ? describeWhen(route.when, decision.inputs) : null,
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
      options: pending.options.map((option) => ({ ...option, toLabel: name(option.to), ...reachOf(pending.after, option.to) }))
    } : null,
    skipped: order.filter((id) => workflow.phases?.[id]?.status === 'skipped').map((id) => ({
      phase: id, label: name(id), by: workflow.phases[id].skippedBy ?? null, at: workflow.phases[id].skippedAt ?? null
    })),
    log: [...(workflow?.decisionLog ?? [])]
  };
}
