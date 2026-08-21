/**
 * Resolution: the only place words become an operation. `[INT:REQ-032]`
 *
 * Seven steps, in one order, and the order is the safety property rather than an implementation
 * detail. Each step can only ever *narrow*: a selection handle beats a subject hint, a subject hint
 * beats a phrase, a phrase beats a goal, and legality beats all of them. Nothing later in the list
 * can widen what something earlier allowed, so there is no sequence of hints that reaches an
 * operation the user's current state does not already permit.
 *
 * The rule that does the most work is the last one before the answer `[INT:CON-036]`: when the only
 * thing that picked an operation was a goal hint — the one input a model authors freely — and the
 * survivor writes, resolution returns it as a *choice* rather than a resolution. One candidate is
 * still a candidate. The user's click is what selects it, and the model's contribution stays a
 * direction.
 *
 * Everything here is pure. The registry, policy, legal actions, handle authority and clock all
 * arrive as arguments, which is what makes the kernel transport-independent `[INT:CON-032]` and
 * makes the same inputs produce the same resolution every time `[INT:REQ-030]`.
 */
import { validateArguments } from './argument-schemas.mjs';
import { planDeveloperConversation } from './conversation.mjs';
import { BROAD_GOALS, isBroadGoal } from './goals.mjs';
import { normalizeAlias } from './registry.mjs';
import { operationPermission } from './policy.mjs';
import { effects, noEffects, preservedAll, sflowResult } from './result.mjs';
import { nearestNames } from '../util.mjs';

/** Narration IDs this module emits. Enumerated so a surface can translate them all. */
export const RESOLUTION_MESSAGES = Object.freeze([
  'gateway.resolved', 'gateway.candidates', 'gateway.clarification', 'gateway.refused'
]);

export const RESOLUTION_REASONS = Object.freeze([
  'resolution.selection-handle.invalid',
  'resolution.subject.unknown-kind',
  'resolution.goal.unknown',
  'resolution.no-match',
  'resolution.not-legal-now',
  'resolution.arguments.invalid',
  'resolution.arguments.missing',
  'resolution.denied-by-policy',
  'resolution.goal-alone-cannot-write',
  'resolution.ambiguous',
  'resolution.matched.selection-handle',
  'resolution.matched.phrase',
  'resolution.matched.conversation',
  'resolution.matched.goal'
]);

const reason = (code, extra = {}) => ({ code, source: 'registry', ...extra });
const policyReason = (code, extra = {}) => ({ code, source: 'policy', ...extra });

/** How the candidate set was narrowed, which decides whether a single survivor may be auto-selected. */
const MATCH_SELECTION_HANDLE = 'selection-handle';
const MATCH_PHRASE = 'phrase';
const MATCH_CONVERSATION = 'conversation';
const MATCH_GOAL = 'goal';

const HELP_FALLBACK = Object.freeze({
  label: 'Ask what SFlow can do',
  command: 'sflow explain',
  skill: '/sflow-about'
});

/**
 * Issue the one safe way out of a failed selection.
 *
 * Recovery used to return `goal:home`, which merely looked like a handle. The executor correctly
 * refused it because the handle authority had never issued it, leaving the reader in a loop of
 * `HANDLE_UNKNOWN` refusals. Recovery is a read, so issue a read handle for the registered Home
 * operation after the same policy and argument checks as any other resolution.
 */
function homeRecoveryAction({ registry, policy, handles, binding }) {
  const operation = registry.operations.find((entry) => entry.id === 'home.overview');
  if (!operation) return null;
  const permission = operationPermission(policy, operation.id, { registry });
  if (!permission.reachable || operation.classification !== 'read') return null;
  let args;
  try {
    args = validateArguments(operation.gateway.argumentSchema, {});
  } catch {
    return null;
  }
  const { reference } = handles.issueRead({
    operationId: operation.id,
    classification: operation.classification,
    arguments: args,
    binding
  });
  return {
    handle: reference.id,
    id: 'recover:home',
    label: 'Start again from home',
    rank: 0,
    kind: 'read',
    reasonCode: 'resolution.selection-handle.invalid',
    confirmation: permission.confirmation,
    interaction: 'recovery',
    emphasis: 'primary',
    executable: permission.executable,
    fallback: HELP_FALLBACK
  };
}

function refusal(operationId, messageId, why, { next = [], restState = 'blocked' } = {}) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: operationId, classification: 'read' },
    outcome: { status: 'refused', messageId },
    effects: noEffects(),
    why,
    /**
     * Resolution turns words into an operation and stops there. Nothing was carried out, so the
     * whole-world claim is the true one — and saying it is the difference between a reader who
     * reads the reason and one who goes to check their branch `[DHR:REQ-061]`.
     */
    preserved: preservedAll('resolution.nothing-was-carried-out'),
    next,
    restState
  });
}

/**
 * The way out of a dead end. `[INT:REQ-150]`
 *
 * A refusal with nothing to do next is where a guided surface stops being guided, so an unmatched
 * utterance carries the nearest broad goals and an explicit help fallback. `nearestNames` is the
 * same typo-tolerance the CLI already uses for commands — offered as suggestions the user picks
 * from, never as a match the resolver acted on.
 */
function clarification(utterance, why, context) {
  const nearest = nearestNames(normalizeAlias(utterance).split(' ').at(-1) ?? '', BROAD_GOALS, { limit: 3 });
  const suggestions = (nearest.length ? nearest : ['home', 'work.list', 'help']);
  const offered = [];
  for (const goal of suggestions) {
    const operation = context.registry.operations.find((entry) => {
      if (entry.classification !== 'read' || !entry.gateway.goals.includes(goal)) return false;
      if (!context.permissions.get(entry.id)?.reachable) return false;
      try { validateArguments(entry.gateway.argumentSchema, {}); return true; } catch { return false; }
    });
    if (!operation) continue;
    const { reference } = context.handles.issueSelection({
      operationId: operation.id,
      classification: operation.classification,
      arguments: {},
      binding: context.binding
    });
    offered.push({
      handle: reference.id,
      id: `goal:${goal}`,
      label: goal,
      rank: offered.length,
      kind: 'clarification',
      reasonCode: 'resolution.no-match',
      confirmation: 'none',
      // A suggestion the user picks from is navigation; none of these acts on anything.
      interaction: 'navigation',
      executable: false,
      fallback: HELP_FALLBACK
    });
  }
  if (!offered.length) {
    const recovery = homeRecoveryAction(context);
    if (recovery) offered.push(recovery);
  }
  return sflowResult({
    kind: 'clarification',
    operation: { id: 'gateway.resolve', classification: 'read' },
    outcome: { status: 'succeeded', messageId: 'gateway.clarification', slots: { utterance } },
    effects: noEffects(),
    why,
    next: offered,
    restState: offered.length ? null : 'blocked'
  });
}

/**
 * The operation is clear; one of its arguments is not. Ask for it.
 *
 * Every offered continuation is `executable: false` — the user supplies the value and resolution
 * runs again from the top, rather than the host filling a blank in something already resolved.
 */
function missingArguments(incomplete, context) {
  const entries = [...incomplete.entries()];
  return sflowResult({
    kind: 'clarification',
    operation: { id: entries.length === 1 ? entries[0][0] : 'gateway.resolve', classification: 'read' },
    subject: context.subject,
    outcome: {
      status: 'succeeded',
      messageId: 'gateway.clarification',
      slots: { missing: [...new Set(entries.flatMap(([, fields]) => fields))].join(', ') }
    },
    effects: noEffects(),
    why: entries.map(([operationId, fields]) => ({
      code: 'resolution.arguments.missing',
      source: 'deterministic',
      reference: operationId,
      slots: { fields: fields.join(', ') }
    })),
    next: entries.map(([operationId, fields], index) => {
      const operation = context.registry.operations.find((entry) => entry.id === operationId);
      const { reference } = context.handles.issueSelection({
        operationId,
        classification: operation.classification,
        arguments: context.arguments,
        binding: context.binding
      });
      return {
        handle: reference.id,
        id: `needs:${operationId}`,
        label: `${operationId} — needs ${fields.join(', ')}`,
        rank: index,
        kind: 'clarification',
        reasonCode: 'resolution.arguments.missing',
        confirmation: 'none',
        /** The missing value is what the host collects, so this opens a form `[UXH:REQ-070]`. */
        interaction: 'form',
        executable: false,
        fallback: HELP_FALLBACK
      };
    }),
    restState: null
  });
}

function candidateResult(candidates, handles, context, why) {
  /**
   * Every candidate carries a signed, short-lived handle `[INT:REQ-033]`.
   *
   * The next turn refers to a handle, not to a restated operation name — otherwise "the second one"
   * would be resolved by matching words again, and the whole point of offering a bounded choice is
   * that the choosing already happened.
   */
  const offered = candidates.map((operation, index) => {
    const { reference } = handles.issueSelection({
      operationId: operation.id,
      classification: operation.classification,
      arguments: context.arguments,
      binding: context.binding
    });
    const { confirmation } = context.permissions.get(operation.id);
    return {
      handle: reference.id,
      /**
       * The operation ID, not the rotating handle. A candidate list recomputed on refresh must put
       * the same choice under the same identity or the user's keyboard focus moves under them.
       */
      id: `candidate:${operation.id}`,
      label: operation.gateway.aliases.en.phrases[0],
      rank: index,
      kind: operation.classification === 'authorization' ? 'ceremony' : 'candidates',
      reasonCode: 'resolution.ambiguous',
      confirmation,
      /**
       * A candidate for an authorization is still shown with ceremony weight. Picking it leads to
       * the decision, and a reader who cannot see which of several choices is the one that signs
       * something is being asked to find out by clicking.
       */
      interaction: confirmation === 'ceremony' ? 'ceremony' : 'navigation',
      // Ambiguity is precisely the state where nothing may lead. The user's click decides.
      emphasis: 'secondary',
      executable: false,
      fallback: HELP_FALLBACK
    };
  });
  return sflowResult({
    kind: 'candidates',
    operation: { id: 'gateway.resolve', classification: 'read' },
    outcome: { status: 'succeeded', messageId: 'gateway.candidates', slots: { count: offered.length } },
    effects: noEffects(),
    why,
    next: offered,
    restState: null
  });
}

function resolvedResult(operation, args, handles, context, why, matchedBy = MATCH_PHRASE) {
  const permission = context.permissions.get(operation.id);
  const kind = operation.classification === 'authorization'
    ? 'ceremony'
    : operation.classification === 'read' ? 'read' : 'plan';

  /**
   * A ceremony is a destination, not a handle. Issuing one would create a token that looks
   * executable to a host that stopped reading at `next[]` `[INT:CON-113]`.
   */
  const reference = kind === 'ceremony'
    ? null
    : (kind === 'read'
      ? handles.issueRead({ operationId: operation.id, classification: operation.classification, arguments: args, binding: context.binding }).reference
      : handles.issueSelection({ operationId: operation.id, classification: operation.classification, arguments: args, binding: context.binding }).reference);

  return sflowResult({
    kind,
    operation: { id: operation.id, classification: operation.classification },
    subject: context.subject,
    outcome: { status: 'succeeded', messageId: 'gateway.resolved', slots: { operation: operation.id } },
    // Resolution computes; it does not act. Even for a mutation, resolving changes nothing yet.
    effects: effects(),
    why,
    next: [{
      handle: reference?.id ?? `ceremony:${operation.id}`,
      id: `resolved:${operation.id}`,
      label: operation.gateway.aliases.en.phrases[0],
      rank: 0,
      kind,
      reasonCode: matchedBy === MATCH_CONVERSATION
        ? 'resolution.matched.conversation'
        : matchedBy === MATCH_GOAL
          ? 'resolution.matched.goal'
          : matchedBy === MATCH_SELECTION_HANDLE
            ? 'resolution.matched.selection-handle'
            : 'resolution.matched.phrase',
      confirmation: permission.confirmation,
      interaction: permission.confirmation === 'ceremony' ? 'ceremony' : (kind === 'read' ? 'read' : 'form'),
      /**
       * Resolution ended in exactly one operation, which is the definition of a legal next action
       * `[UXH:REQ-023]`. This is the only site in the resolver entitled to a filled button, and it
       * is entitled to it because ambiguity was already ruled out above.
       */
      emphasis: 'primary',
      executable: kind === 'read' && permission.executable,
      fallback: HELP_FALLBACK
    }],
    restState: null,
    data: { arguments: args }
  });
}

/**
 * Resolve one utterance into exactly one of: a resolution, candidates, a clarification, a ceremony,
 * or a refusal.
 */
export function resolveIntent(request = {}, {
  registry, policy, handles, legalActions = null, binding, subject = null
} = {}) {
  const { utterance = '', goalHint = null, arguments: proposed = {}, selectionHandle = null } = request;
  const why = [];

  const permissions = new Map(registry.operations.map((operation) => [
    operation.id, operationPermission(policy, operation.id, { registry })
  ]));
  const context = { arguments: proposed, binding, subject, permissions, registry, policy, handles };

  // ---- 1. A selection handle is an answer already given, so nothing below may reopen it.
  let matchedBy = null;
  let pool = registry.operations.filter((operation) => permissions.get(operation.id).reachable);

  if (selectionHandle) {
    let record = null;
    try {
      record = handles.verify({ id: selectionHandle }, { kind: 'selection', binding, consume: true });
    } catch (error) {
      const recovery = homeRecoveryAction({ registry, policy, handles, binding });
      return refusal('gateway.resolve', 'gateway.refused', [
        { code: 'resolution.selection-handle.invalid', source: 'deterministic', reference: error.code ?? null }
      ], { next: recovery ? [recovery] : [], restState: recovery ? null : 'blocked' });
    }
    pool = pool.filter((operation) => operation.id === record.operationId);
    // The handle is the selected answer in full: operation and the arguments the kernel validated
    // when it issued it. Re-reading `request.arguments` here lets the next caller erase those
    // arguments by sending only the opaque handle, which is exactly what every host is required to
    // do. The result was a second clarification asking for a work ID already present in the signed
    // choice.
    context.arguments = record.arguments;
    matchedBy = MATCH_SELECTION_HANDLE;
    why.push(reason('resolution.matched.selection-handle'));
  }

  // ---- 2. An explicit subject hint narrows by what the operation can be about.
  if (!matchedBy && subject?.kind) {
    const narrowed = pool.filter((operation) => operation.gateway.subjects.includes(subject.kind));
    if (!narrowed.length) {
      return refusal('gateway.resolve', 'gateway.refused',
        [reason('resolution.subject.unknown-kind', { slots: { subjectKind: subject.kind } })],
        { next: [], restState: 'blocked' });
    }
    pool = narrowed;
  }

  // ---- 3. An exact registered phrase, matched against the normalized form and nothing looser.
  if (!matchedBy && utterance) {
    const phrase = normalizeAlias(utterance);
    const exact = pool.filter((operation) => Object.values(operation.gateway.aliases)
      .some((block) => block.normalized.includes(phrase)));
    if (exact.length) {
      pool = exact;
      matchedBy = MATCH_PHRASE;
      why.push(reason('resolution.matched.phrase', { slots: { phrase } }));
    }
  }

  // ---- 3b. Ordinary language may select only a deterministic read planner. The route never
  //          becomes a mutation; it reconstructs current state and lets the user choose from the
  //          legal actions that state exposes.
  if (!matchedBy && utterance) {
    const conversation = planDeveloperConversation(utterance);
    if (conversation.route) {
      const routed = pool.filter((operation) => operation.id === conversation.route.operationId);
      if (routed.length) {
        pool = routed;
        matchedBy = MATCH_CONVERSATION;
        if (conversation.route.operationId === 'work.start.intake' && conversation.route.work) {
          context.arguments = {
            ...context.arguments,
            shape: conversation.route.work.shape,
            source: conversation.route.work.source,
            ...(conversation.route.work.category ? { workType: conversation.route.work.category } : {})
          };
        }
        if (conversation.route.operationId === 'problem.investigate') {
          context.arguments = { ...context.arguments, symptom: utterance };
        }
        why.push(reason('resolution.matched.conversation', {
          reference: conversation.route.id,
          slots: { intent: conversation.intent, skill: conversation.route.recommendedSkill }
        }));
      }
    }
  }

  // ---- 4. The broad goal hint, validated against a closed vocabulary.
  if (!matchedBy && goalHint) {
    if (!isBroadGoal(goalHint)) {
      return refusal('gateway.resolve', 'gateway.refused',
        [reason('resolution.goal.unknown', { slots: { goal: goalHint } })],
        { next: [], restState: 'blocked' });
    }
    pool = pool.filter((operation) => operation.gateway.goals.includes(goalHint));
    matchedBy = MATCH_GOAL;
    why.push(reason('resolution.matched.goal', { slots: { goal: goalHint } }));
  }

  if (!matchedBy || !pool.length) {
    return clarification(utterance, [reason('resolution.no-match', { slots: { utterance } })], context);
  }

  // ---- 5. Intersect with what is legal right now. A legal-action set that was not supplied is
  //         treated as "unknown", not as "everything" — the fail-closed reading.
  if (legalActions) {
    const legal = pool.filter((operation) => legalActions.includes(operation.id));
    if (!legal.length) {
      return refusal(pool[0].id, 'gateway.refused',
        [{ code: 'resolution.not-legal-now', source: 'lifecycle', slots: { considered: pool.length } }],
        { next: [], restState: 'blocked' });
    }
    pool = legal;
  }

  // ---- 6. Typed arguments, against the operation's own schema. An operation whose arguments do not
  //         validate is not a candidate; it is a question.
  const typed = [];
  const invalid = [];
  const incomplete = new Map();
  for (const operation of pool) {
    try {
      typed.push([operation, validateArguments(operation.gateway.argumentSchema, context.arguments)]);
    } catch (error) {
      if (error.code === 'MISSING_OPERATION_ARGUMENT') {
        incomplete.set(operation.id, [...(incomplete.get(operation.id) ?? []), error.details.field]);
        continue;
      }
      invalid.push({ code: 'resolution.arguments.invalid', source: 'deterministic', reference: operation.id, slots: { detail: error.message } });
    }
  }
  /**
   * Nothing typed, and the only thing wrong was that something was not said yet.
   *
   * This is the difference between "no" and "which one?". Returning a refusal here is what makes a
   * guided surface feel like a form validator: the user asked to open a review packet without naming
   * a Story, which is the most natural thing in the world to say, and the answer has to be a
   * question `[INT:REQ-150]`.
   */
  if (!typed.length && incomplete.size && !invalid.length) {
    return missingArguments(incomplete, context);
  }
  if (!typed.length) {
    return refusal(pool[0].id, 'gateway.refused', invalid.length ? invalid : [
      reason('resolution.arguments.invalid')
    ], { next: [], restState: 'blocked' });
  }

  // ---- 7. One answer.
  if (typed.length > 1) {
    return candidateResult(typed.map(([operation]) => operation), handles, context,
      [...why, reason('resolution.ambiguous', { slots: { count: typed.length } })]);
  }

  const [operation, args] = typed[0];
  /**
   * `[INT:CON-036]`. A goal hint is the one input the model authors, so it may narrow to a write but
   * may not choose one. A single survivor is returned as a choice the user makes, not a resolution.
   */
  if ([MATCH_GOAL, MATCH_CONVERSATION].includes(matchedBy) && operation.classification !== 'read') {
    return candidateResult([operation], handles, context,
      [...why, policyReason('resolution.goal-alone-cannot-write', { slots: { operation: operation.id } })]);
  }

  return resolvedResult(operation, args, handles, context, why, matchedBy);
}
