/**
 * One way to carry out an offered action, for every surface. `[UXH:REQ-031]` `[DHR:REQ-086]`
 *
 * The rule this exists to enforce is short: **a host dispatches handles, never operations.** A view
 * that can name `work.continue` can invoke it in a state where it was never offered, and every
 * safety property upstream — legality, policy, confirmation class, subject binding — was computed
 * for the moment the action *was* offered, not for the moment the button was pressed.
 *
 * The shipped extension has the other shape: 25 panels, each with its own command path, each
 * constructing what to run from what it happens to know. This is the single seam that replaces
 * them, and the reason to build it before the cards is that a card offering actions nothing can
 * safely dispatch is a card that has to grow its own dispatcher.
 *
 * ## Re-resolution is the whole job
 *
 * `[UXH:REQ-031]` says every action re-resolves through its handle before dispatch. Not "may" —
 * the gap between offering and pressing is where the world moves, and a handle carries the world it
 * was computed against precisely so that gap can be detected. So this never caches a resolution,
 * never retries a stale handle, and never falls back to the operation name when a handle fails.
 *
 * ## A failure here is a result, not an exception
 *
 * A drifted handle produces a refusal envelope with a recovery action, the same shape as any other
 * answer. A host that has to catch exceptions to render a stale confirmation will render it as an
 * error toast, which is the dead end `[UXH:CON-007]` prohibits.
 */
import { HOST_ACTIONS, validateHostAction } from './argument-schemas.mjs';
import { HANDLE_FAILURE_CODES } from './catalog.mjs';
import { SingularityFlowError } from '../util.mjs';
import { noEffects, preservedAll, sflowResult } from './result.mjs';

/**
 * Which handle failures are worth re-asking about, and which are refusals to accept.
 *
 * The distinction is the reason the kernel keeps a specific code per failure rather than flattening
 * them: `expired` and `drifted` mean "ask again and it will be recomputed", while `tampered` and
 * `kind-mismatch` mean something is wrong that asking again will not fix. Offering "try again" for
 * the second group trains people to retry things that will never work.
 */
const RECOVERABLE = Object.freeze(new Set([
  'gateway.handle-expired', 'gateway.handle-drifted', 'gateway.handle-unknown', 'gateway.handle-consumed'
]));

/**
 * The way back when a handle no longer holds.
 *
 * One action, `recovery` class, pointing at the surface the reader came from. `[INT:REQ-041]`
 * forbids a dead end and `[DHR:REQ-063]` says going back alters presentation only — so this offers
 * to recompute, never to force through.
 */
function recoveryAction(scope, issued) {
  if (!issued?.handle) return null;
  return {
    ...issued,
    id: `recover:${scope}`,
    label: 'Ask again from here',
    rank: 0,
    reasonCode: 'resolution.selection-handle.invalid',
    interaction: 'recovery',
    emphasis: 'primary',
    fallback: { label: 'Start again', command: `sflow ${scope === 'home' ? 'home' : 'explain'}` }
  };
}

function staleRefusal(code, { scope, actionId, recovery }) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: 'gateway.read', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: { action: actionId ?? 'unknown' } },
    effects: noEffects(),
    why: [{ code, source: 'deterministic', reference: actionId ?? null }],
    /**
     * The sentence that stops a reader going to check by hand `[DHR:REQ-061]`.
     *
     * A stale handle is the refusal most likely to read as "something went wrong with my work",
     * because it arrives after the reader has already decided to act. Nothing was carried out, and
     * saying so is the difference between re-asking and going to inspect the branch.
     */
    preserved: preservedAll('gateway.nothing-was-carried-out'),
    next: RECOVERABLE.has(code) && recovery ? [recoveryAction(scope, recovery)] : [],
    restState: RECOVERABLE.has(code) ? null : 'blocked'
  });
}

/**
 * Build the dispatcher a host owns.
 *
 * `gateway` is the whole host session — the kernel and the binding thunk — rather than a kernel
 * alone, because re-resolution needs the *current* world and a kernel handed a frozen binding
 * cannot supply it.
 */
export function createActionExecutor({ gateway, scope = 'home' } = {}) {
  if (!gateway?.kernel) throw new TypeError('An action executor requires a host gateway.');
  const { kernel } = gateway;

  /**
   * Carry out one action from a result's `next[]`.
   *
   * Takes the action record rather than a bare handle string. A host that passes the whole record
   * cannot accidentally pass an ID it composed, and `executable` can be honoured here rather than
   * being a field every view is trusted to check — `[INT:CON-113]` says an authorization is never
   * executable by an ambient tool, and this is the one place that can be enforced rather than
   * documented.
   */
  async function execute(action) {
    if (!action?.handle) {
      throw new SingularityFlowError('An action must carry the handle it was offered with.',
        { code: 'ACTION_WITHOUT_HANDLE' });
    }

    /**
     * A ceremony is a destination, never a dispatch `[INT:CON-113]` `[UXH:REQ-084]`.
     *
     * Returned as the action itself so the host opens the ceremony surface. Executing it here would
     * be this module deciding that a signature had been given, which is the one decision it must
     * never make on someone's behalf.
     */
    if (action.confirmation === 'ceremony' || action.interaction === 'ceremony') {
      return { outcome: 'ceremony', action };
    }

    /**
     * A host action opens a trusted view, and is never a kernel call. `[INT:CON-130]`
     *
     * Handed back like a ceremony: the host validates it again and opens the view it names. Nothing
     * here reads, resolves or runs, so a host action cannot enter the plan, receipt or publication
     * path even by mistake — there is no kernel call on this branch to make one.
     */
    if (action.hostAction != null || action.kind === 'host-action') {
      return { outcome: 'host-action', action };
    }

    /**
     * A plan is confirmed, never dispatched. `[INT:CON-039]` `[INT:CON-111]`
     *
     * Pressing a plan's button hands the host its review — the exact preview, effects and hash —
     * so the host can collect the confirmation in its own trusted UI and exchange it for a receipt.
     * Nothing here runs the plan: `sflow_run` needs that receipt, and only the host has it.
     */
    if (kernel.handles?.kind?.(action.handle) === 'plan') {
      try {
        return { outcome: 'confirm', action, review: kernel.planReview(action.handle) };
      } catch (error) {
        const code = `gateway.${String(error?.code ?? '').toLowerCase().replaceAll('_', '-')}`;
        const resolved = await kernel.resolve({ utterance: scope === 'home' ? 'home' : 'help' });
        const recovery = resolved.next?.find((entry) => entry.executable === true) ?? null;
        return {
          outcome: 'stale',
          result: staleRefusal(HANDLE_FAILURE_CODES.includes(code) ? code : 'gateway.handle-unrecognised', {
            scope, actionId: action.id, recovery
          })
        };
      }
    }

    if (action.executable === false) {
      /**
       * Not executable means the user's click *selects* it and resolution runs again from the top.
       * That is how a menu item rendered ten minutes ago cannot act on a world that has moved.
       */
      const resolved = await kernel.resolve({ selectionHandle: action.handle });
      return { outcome: 'resolved', result: resolved };
    }

    const result = await kernel.read({ resolutionId: action.handle });

    /**
     * The kernel already refuses a stale handle. This re-shapes the refusal into one that offers a
     * way back, because the kernel is deliberately transport-independent and "what the reader can
     * do next in this surface" is the host's question, not its.
     */
    if (result.kind === 'refusal' && HANDLE_FAILURE_CODES.includes(result.why[0]?.code)) {
      // Ask the kernel for a current, signed read handle. A recovery prefix is not authority and is
      // intentionally unusable; the button must be as bound and expiring as every other read.
      const resolved = await kernel.resolve({ utterance: scope === 'home' ? 'home' : 'help' });
      const recovery = resolved.next?.find((entry) => entry.executable === true) ?? null;
      return {
        outcome: 'stale',
        result: staleRefusal(result.why[0].code, { scope, actionId: action.id, recovery })
      };
    }
    return { outcome: 'read', result };
  }

  return Object.freeze({
    execute,

    /**
     * Look up an action by its stable id and dispatch it. `[UXH:REQ-030]`
     *
     * The form a checklist row uses: a row names its fix action by `id`, and the contract already
     * rejects a row naming an action the result did not offer, so this cannot be handed an id that
     * was never on screen.
     */
    async executeById(result, actionId) {
      const action = (result?.next ?? []).find((entry) => entry.id === actionId);
      if (!action) {
        throw new SingularityFlowError(`'${actionId}' is not an action this result offered.`,
          { code: 'ACTION_NOT_OFFERED', details: { actionId } });
      }
      return execute(action);
    }
  });
}

/**
 * The receiving host's refusal of a host action, as a result like any other. `[INT:CON-131]`
 *
 * A host action that fails on receipt is never opened, and the reader is told so on a card rather
 * than by silence: what was refused and why, that nothing was opened or changed, and — when the
 * action came with one — the terminal continuation instead `[INT:REQ-130]`.
 */
export function hostActionRefusal({ action = 'unknown', reason = 'malformed' } = {}, { fallback = null } = {}) {
  const continuation = fallback?.command ? [{
    handle: 'host-action:fallback', id: 'host-action:fallback', label: fallback.label ?? 'Do it from a terminal instead',
    rank: 0, kind: 'read', reasonCode: 'gateway.host-action-fallback', confirmation: 'none',
    interaction: 'navigation', emphasis: 'primary', executable: false,
    fallback: { label: fallback.label ?? 'Do it from a terminal instead', command: fallback.command }
  }] : [];
  return sflowResult({
    kind: 'refusal',
    operation: { id: 'gateway.host-action', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: { action, reason } },
    effects: noEffects(),
    why: [{ code: 'gateway.host-action-refused', source: 'deterministic', slots: { action, reason } }],
    preserved: preservedAll('gateway.nothing-was-carried-out'),
    next: continuation,
    // A view this build lacks is unavailable here; anything else was refused, and retrying it elsewhere will not help.
    restState: continuation.length ? null : (reason === 'not-available-in-this-build' ? 'unavailable' : 'blocked')
  });
}

/**
 * Validate a host action again where it is received, before anything is opened.
 * `[INT:IFC-061]` `[INT:CON-130]` `[INT:CON-131]`
 *
 * The kernel already checked it when it was emitted; this is the receiving extension's own check,
 * because a deep link or a stale card did not necessarily come from this kernel. Against the same
 * allowlist and typed schema, and then against `available` — the actions this build has a view
 * for. An allowlisted action without one is refused as not available here, never quietly ignored.
 */
export function receiveHostAction(candidate, { available = HOST_ACTIONS, fallback = null } = {}) {
  const checked = validateHostAction(candidate);
  if (!checked.ok) {
    return Object.freeze({ accepted: false, reason: checked.reason, result: hostActionRefusal(checked, { fallback }) });
  }
  if (!available.includes(checked.hostAction.id)) {
    const refused = { action: checked.hostAction.id, reason: 'not-available-in-this-build' };
    return Object.freeze({ accepted: false, reason: refused.reason, result: hostActionRefusal(refused, { fallback }) });
  }
  return Object.freeze({ accepted: true, hostAction: checked.hostAction });
}
