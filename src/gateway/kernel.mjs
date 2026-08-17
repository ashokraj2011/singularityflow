/**
 * The gateway kernel. `[INT:CON-032]` `[INT:CON-033]`
 *
 * Transport-independent, which here means something stricter than "no imports from VS Code": every
 * capability it needs — the registry, policy, planners, the legal-action set, the clock, the handle
 * authority — arrives as an argument. There is no ambient state to differ between a VS Code call, an
 * MCP call and a test, so the three cannot drift, and the adapters have nowhere to put lifecycle
 * logic even if they wanted to.
 *
 * It is read-only until told otherwise. P1 ships the read experience and `run` refuses by
 * construction rather than by nobody having called it yet — a mutation path that exists and is
 * simply unused is one flag away from being live, and the flag is usually set by someone debugging.
 */
import { createHandleAuthority, subjectFromBinding } from './handles.mjs';
import { validateArguments } from './argument-schemas.mjs';
import { DEFAULT_GATEWAY_POLICY, operationPermission, resolveGatewayPolicy } from './policy.mjs';
import { gatewayRegistry } from './operations.mjs';
import { catalogued } from './catalog.mjs';
import {
  noEffects, PLANNER_NAVIGATION_TARGET, plannerNavigationTarget, preservedAll, sflowResult,
  validateSflowResult
} from './result.mjs';
import { resolveIntent } from './resolve.mjs';
import { SingularityFlowError } from '../util.mjs';

/**
 * Narration IDs a kernel-side result can carry, so a surface can translate all of them.
 *
 * `gateway.home` was emitted by the home planner and listed nowhere until the reason-catalog sweep
 * found it — the same gap the catalog exists to close, one level up. A message ID that no list
 * names is a message a translator will not know to write.
 */
export const KERNEL_MESSAGES = Object.freeze([
  'gateway.read', 'gateway.next', 'gateway.explained', 'gateway.refused', 'gateway.home',
  /**
   * A read that answers "am I ready?" with "no" `[UXH:REQ-062]`.
   *
   * Separate from `gateway.read` because the headline is the string most readers stop at, and
   * "Here is what SFlow found" above a list of unmet gates buries the answer in the one place it
   * had a chance to be the first thing read. The result still succeeded — the operation worked and
   * the answer is no, which is exactly why `kind` and `outcome.status` are kept apart.
   */
  'gateway.not-ready',
  /** The return briefing's own heading, so it is not narrated as a generic read. */
  'gateway.returned'
]);

/**
 * The entry points that answer as operations without being registered ones.
 *
 * `sflow_run` and `sflow_read` are tools, not registry entries, but a refusal from one still has to
 * name an `operation.id`. Enumerating them keeps "what can `operation.id` be?" answerable, which is
 * the question a host asks when it decides how to route a result.
 */
export const KERNEL_OPERATIONS = Object.freeze([
  'gateway.resolve', 'gateway.read', 'gateway.next', 'gateway.run'
]);

/**
 * A handle failure's catalog code. `[INT:REQ-152]` `[INT:CON-150]`
 *
 * The reason code is what lets the host distinguish "ask again" from "you may not" without parsing
 * a sentence, so it must survive as a *specific* code wherever handles.mjs has one. Where it does
 * not, the fallback says exactly that rather than flattening an unfamiliar failure into
 * `handle-invalid`, which would tell a host to retry something that will never succeed.
 */
function handleCode(error) {
  const named = `gateway.${String(error?.code ?? '').toLowerCase().replaceAll('_', '-')}`;
  return catalogued(named, 'gateway.handle-unrecognised');
}

/**
 * `restState` says which kind of "no" this is. `[UXH:REQ-051]`
 *
 * Every kernel refusal said `blocked`, which reads as "you may not" — right for policy, and wrong
 * for the nineteen registered operations that have no planner in any build. A reader told they are
 * blocked goes looking for the permission that would unblock them; there isn't one, because the
 * capability is simply absent here. `unavailable` says that, and the card has its own sentence for
 * it pointing at the terminal.
 */
function refuse(operationId, code, source, slots = {}, restState = 'blocked') {
  return sflowResult({
    kind: 'refusal',
    operation: { id: operationId, classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots },
    effects: noEffects(),
    why: [{ code, source, slots }],
    // The kernel refused before any planner ran, so nothing anywhere was touched `[DHR:REQ-061]`.
    preserved: preservedAll('gateway.nothing-was-carried-out'),
    restState
  });
}

/**
 * Build a kernel for one host session.
 *
 * `planners` is a Map rather than the registry's declaration list on purpose: the registry says
 * which planner an operation *names*, and this says which ones this build can actually run. When
 * they disagree the answer is a refusal that says so, not a crash and not a silent empty read.
 */
export function createGatewayKernel({
  registry = gatewayRegistry(),
  policyLayers = [DEFAULT_GATEWAY_POLICY],
  planners = new Map(),
  legalActions = null,
  binding,
  /** Planners that read a repository get it from here, never from the ambient working directory. */
  root = null,
  /** Host-owned identity/workspace selection, recomputed for long-lived surfaces when supplied as a function. */
  plannerContext = {},
  handles = createHandleAuthority(),
  readOnly = true
} = {}) {
  const policy = resolveGatewayPolicy(policyLayers, { registry });

  /**
   * The world *now*, not the world this kernel was built in. `[INT:REQ-036]`
   *
   * `binding` may be a value or a function, and long-lived hosts must pass a function. A kernel
   * that captures one binding at construction compares a handle's snapshot against its own equally
   * stale snapshot, so both sides move together and drift detection sees nothing. Harmless in a CLI
   * process that lives for one command; a hole in an editor session that lives for hours, where the
   * failure is a handle resolved on `main` still verifying after the user switched branch.
   *
   * Recomputing costs a few Git reads per call. That is the right trade at a dispatch boundary and
   * the wrong one in a render loop, which is why the host recomputes here and not per frame.
   */
  const currentBinding = () => (typeof binding === 'function' ? binding() : binding);
  const currentLegalActions = (subject) => typeof legalActions === 'function'
    ? legalActions(subject)
    : legalActions;

  /**
   * Turn planner suggestions into authority-issued selections.
   *
   * Prefixes such as `home:` and `goal:` remain display placeholders inside pure planner tests.
   * They never cross the kernel boundary. The operation must exist, be reachable under current
   * policy, and accept the planner's exact arguments before the handle authority signs it.
   */
  function sealPlannerNavigation(result, issuedAgainst) {
    if (!(result.next ?? []).length) return result;
    const next = result.next.map((action, index) => {
      if (action.confirmation === 'ceremony' || action.executable === true) return action;
      const target = plannerNavigationTarget(action);
      if (!target?.operationId) {
        throw new SingularityFlowError(
          `Planner '${result.operation.id}' returned navigation next[${index}] without a target operation.`,
          { code: 'PLANNER_NAVIGATION_TARGET_MISSING' }
        );
      }
      const operation = registry.operations.find((entry) => entry.id === target.operationId);
      if (!operation) {
        throw new SingularityFlowError(
          `Planner '${result.operation.id}' targeted unregistered operation '${target.operationId}'.`,
          { code: 'PLANNER_NAVIGATION_TARGET_UNKNOWN' }
        );
      }
      const permission = operationPermission(policy, operation.id, { registry });
      if (!permission.reachable) {
        throw new SingularityFlowError(
          `Planner '${result.operation.id}' targeted operation '${operation.id}', which current policy cannot reach.`,
          { code: 'PLANNER_NAVIGATION_TARGET_DENIED' }
        );
      }
      const args = validateArguments(operation.gateway.argumentSchema, target.arguments);
      const { reference } = handles.issueSelection({
        operationId: operation.id,
        classification: operation.classification,
        arguments: args,
        binding: issuedAgainst
      });
      const { [PLANNER_NAVIGATION_TARGET]: _target, ...visible } = action;
      return { ...visible, handle: reference.id };
    });
    return sflowResult({ ...result, next });
  }

  /**
   * Run a planner and hold its output to the same contract as everything else.
   *
   * Validating here rather than trusting the planner is the point of having one result contract: a
   * planner that returns something shaped like a result is exactly the thing that would otherwise
   * reach a host and be rendered as if the kernel had produced it.
   */
  async function invoke(operation, args, subject, issuedAgainst = currentBinding()) {
    const planner = planners.get(operation.gateway.planner);
    if (typeof planner !== 'function') {
      // A capability this build genuinely lacks, reported as absent rather than as forbidden.
      return refuse(operation.id, 'gateway.planner-unavailable', 'unavailable',
        { planner: operation.gateway.planner }, 'unavailable');
    }
    const context = typeof plannerContext === 'function'
      ? plannerContext({ operation, arguments: args, subject })
      : plannerContext;
    const produced = validateSflowResult(
      await planner({ operation, arguments: args, subject, registry, policy, root, context: context ?? {} })
    );
    return validateSflowResult(sealPlannerNavigation(produced, issuedAgainst));
  }

  return Object.freeze({
    registry,
    policy,
    handles,
    registryHash: registry.contentHash,

    /** `sflow_resolve`: the only entry point that takes words. */
    resolve(request = {}, { subject = null } = {}) {
      return resolveIntent(request, {
        registry,
        policy,
        handles,
        legalActions: currentLegalActions(subject),
        binding: currentBinding(),
        subject
      });
    },

    /** `sflow_read`: a resolved read handle, revalidated against the world, and nothing else. */
    async read({ resolutionId } = {}) {
      let record;
      try {
        record = handles.verify({ id: resolutionId }, { kind: 'read', binding: currentBinding() });
      } catch (error) {
        // `[INT:REQ-152]` `[INT:CON-150]`: expired or drifted is refreshed from current state, never
        // carried forward. The reason code names which, so the host can re-ask rather than re-try.
        return refuse('gateway.read', handleCode(error), 'deterministic');
      }
      const operation = registry.operations.find((entry) => entry.id === record.operationId);
      const permission = operationPermission(policy, record.operationId, { registry });
      if (!permission.reachable) {
        return refuse(record.operationId, 'gateway.denied-by-policy', 'policy', { reason: permission.reason });
      }
      if (operation.classification !== 'read') {
        return refuse(record.operationId, 'gateway.not-a-read', 'registry', { classification: operation.classification });
      }
      /**
       * The handle's binding, converted rather than passed. `[INT:REQ-035]`
       *
       * A planner is given a subject, and what arrived here was a binding — the same facts under
       * different names and a different nesting, so `sflowResult` found none of them and declared a
       * revision of nulls on every read the gateway served. See `subjectFromBinding`.
       *
       * The binding is the right source: it is what the handle was signed against and what
       * revalidation just compared, so a result's declared revision is the revision its own
       * authorization was checked against rather than a second read that could disagree with it.
       */
      return invoke(operation, record.arguments, subjectFromBinding(record.binding), record.binding);
    },

    /**
     * `sflow_next`: what is legal now, computed and never remembered. `[INT:CON-038]`
     *
     * Deliberately cheap and side-effect-free — no world model, no agent, no artifacts, no phase
     * advance. It is the call a surface makes constantly, so anything expensive here becomes a
     * reason not to call it, and a stale action list is worse than none.
     */
    next({ scope = 'home', subject = null } = {}) {
      const issuedAgainst = currentBinding();
      const legal = currentLegalActions(subject)
        ?? registry.operations.filter((entry) => entry.classification === 'read').map((entry) => entry.id);
      const offered = legal
        .map((id) => registry.operations.find((entry) => entry.id === id))
        .filter(Boolean)
        .map((operation) => ({ operation, permission: operationPermission(policy, operation.id, { registry }) }))
        .filter(({ permission }) => permission.reachable)
        .map(({ operation, permission }, index) => ({ operation, permission, index }))
        .map(({ operation, permission, index }) => ({
          handle: permission.confirmation === 'ceremony'
            ? `ceremony:${operation.id}`
            : handles.issueSelection({
                operationId: operation.id,
                classification: operation.classification,
                // Selection is allowed to precede form collection. Resolution restores these
                // exact bytes and either validates them or asks for the missing typed fields.
                arguments: {},
                binding: issuedAgainst
              }).reference.id,
          id: `legal:${operation.id}`,
          label: operation.gateway.aliases.en.phrases[0],
          rank: index,
          kind: operation.classification === 'authorization' ? 'ceremony' : operation.classification === 'read' ? 'read' : 'plan',
          reasonCode: 'gateway.legal-now',
          confirmation: permission.confirmation,
          interaction: permission.confirmation === 'ceremony'
            ? 'ceremony'
            : (operation.classification === 'read' ? 'read' : 'form'),
          /**
           * "Everything legal now" is a list, not a recommendation `[INT:CON-038]`. Emphasising one
           * of them would be this call quietly answering a question it was not asked — which is what
           * the home planner exists to answer, from ordering rules a reader can check.
           */
          emphasis: 'secondary',
          executable: false,
          fallback: { label: 'Ask what SFlow can do', command: 'sflow explain' }
        }));

      return sflowResult({
        kind: 'read',
        operation: { id: 'gateway.next', classification: 'read' },
        subject,
        outcome: { status: 'succeeded', messageId: 'gateway.next', slots: { scope, count: offered.length } },
        effects: noEffects(),
        next: offered,
        // An empty legal set is an answer, and it needs somewhere to stop rather than a dead end.
        restState: offered.length ? null : 'informational'
      });
    },

    /** `sflow_explain`: bounded, cited, and never a way to turn an answer into an act `[INT:CON-040]`. */
    async explain({ question, topic, subject = null } = {}) {
      const operation = registry.operations.find((entry) => entry.id === 'help.explain');
      const permission = operationPermission(policy, 'help.explain', { registry });
      if (!permission.reachable) return refuse('help.explain', 'gateway.denied-by-policy', 'policy');
      return invoke(operation, { question, ...(topic ? { topic } : {}) }, subject);
    },

    /**
     * `sflow_run`: refused while the gateway is read-only.
     *
     * P1's boundary, enforced here rather than by the absence of callers. The refusal is a real
     * result with a real reason, so a host that reaches this discovers a documented state instead of
     * an exception it will decide to catch.
     */
    async run({ planId } = {}) {
      if (readOnly) {
        return refuse('gateway.run', 'gateway.read-only', 'policy', { planId: planId ? 'supplied' : 'absent' });
      }
      return refuse('gateway.run', 'gateway.not-implemented', 'unavailable', { phase: 'P2' });
    }
  });
}
