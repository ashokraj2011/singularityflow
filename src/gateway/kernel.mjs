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
import { createHandleAuthority } from './handles.mjs';
import { DEFAULT_GATEWAY_POLICY, operationPermission, resolveGatewayPolicy } from './policy.mjs';
import { gatewayRegistry } from './operations.mjs';
import { noEffects, preservedAll, sflowResult, validateSflowResult } from './result.mjs';
import { resolveIntent } from './resolve.mjs';

export const KERNEL_MESSAGES = Object.freeze([
  'gateway.read', 'gateway.next', 'gateway.explained', 'gateway.refused'
]);

function refuse(operationId, code, source, slots = {}) {
  return sflowResult({
    kind: 'refusal',
    operation: { id: operationId, classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots },
    effects: noEffects(),
    why: [{ code, source, slots }],
    // The kernel refused before any planner ran, so nothing anywhere was touched `[DHR:REQ-061]`.
    preserved: preservedAll('gateway.nothing-was-carried-out'),
    restState: 'blocked'
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
  handles = createHandleAuthority(),
  readOnly = true
} = {}) {
  const policy = resolveGatewayPolicy(policyLayers, { registry });

  /**
   * Run a planner and hold its output to the same contract as everything else.
   *
   * Validating here rather than trusting the planner is the point of having one result contract: a
   * planner that returns something shaped like a result is exactly the thing that would otherwise
   * reach a host and be rendered as if the kernel had produced it.
   */
  async function invoke(operation, args, subject) {
    const planner = planners.get(operation.gateway.planner);
    if (typeof planner !== 'function') {
      return refuse(operation.id, 'gateway.planner-unavailable', 'unavailable', { planner: operation.gateway.planner });
    }
    const produced = await planner({ operation, arguments: args, subject, registry, policy, root });
    return validateSflowResult(produced);
  }

  return Object.freeze({
    registry,
    policy,
    handles,
    registryHash: registry.contentHash,

    /** `sflow_resolve`: the only entry point that takes words. */
    resolve(request = {}, { subject = null } = {}) {
      return resolveIntent(request, { registry, policy, handles, legalActions, binding, subject });
    },

    /** `sflow_read`: a resolved read handle, revalidated against the world, and nothing else. */
    async read({ resolutionId } = {}) {
      let record;
      try {
        record = handles.verify({ id: resolutionId }, { kind: 'read', binding });
      } catch (error) {
        // `[INT:REQ-152]` `[INT:CON-150]`: expired or drifted is refreshed from current state, never
        // carried forward. The reason code names which, so the host can re-ask rather than re-try.
        return refuse('gateway.read', `gateway.${(error.code ?? 'handle-invalid').toLowerCase().replaceAll('_', '-')}`, 'deterministic');
      }
      const operation = registry.operations.find((entry) => entry.id === record.operationId);
      const permission = operationPermission(policy, record.operationId, { registry });
      if (!permission.reachable) {
        return refuse(record.operationId, 'gateway.denied-by-policy', 'policy', { reason: permission.reason });
      }
      if (operation.classification !== 'read') {
        return refuse(record.operationId, 'gateway.not-a-read', 'registry', { classification: operation.classification });
      }
      return invoke(operation, record.arguments, record.binding);
    },

    /**
     * `sflow_next`: what is legal now, computed and never remembered. `[INT:CON-038]`
     *
     * Deliberately cheap and side-effect-free — no world model, no agent, no artifacts, no phase
     * advance. It is the call a surface makes constantly, so anything expensive here becomes a
     * reason not to call it, and a stale action list is worse than none.
     */
    next({ scope = 'home', subject = null } = {}) {
      const legal = (legalActions ? legalActions(subject) : null)
        ?? registry.operations.filter((entry) => entry.classification === 'read').map((entry) => entry.id);
      const offered = legal
        .map((id) => registry.operations.find((entry) => entry.id === id))
        .filter(Boolean)
        .map((operation) => ({ operation, permission: operationPermission(policy, operation.id, { registry }) }))
        .filter(({ permission }) => permission.reachable)
        .map(({ operation, permission }, index) => ({
          handle: `next:${operation.id}`,
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
