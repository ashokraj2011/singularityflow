/**
 * Resolved gateway policy: the intersection of everyone who gets a say. `[INT:CON-120]`
 *
 * Eight layers can restrict what a host model may reach, and the most restrictive applicable rule
 * wins. That is not a merge in the usual sense — later layers never overwrite earlier ones, they
 * only ever narrow. Written that way, `[INT:CON-121]` ("repository configuration must not weaken
 * central restrictions") is not a rule that has to be checked at all; it is a thing the resolution
 * function cannot express.
 *
 * It is still reported. A repository that tries to loosen a central restriction is a
 * misconfiguration someone should fix, and silently ignoring the line is how it survives for a year.
 *
 * Failure is closed and loud but not fatal `[INT:CON-122]`: a missing or unreadable policy reduces
 * the gateway to deterministic reads plus explicit commands rather than throwing, because a gateway
 * that crashes on a bad policy file is a gateway that gets its policy file deleted.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '../specifications.mjs';
import { SingularityFlowError } from '../util.mjs';
import { CONFIRMATION_CLASSES } from './result.mjs';
import { gatewayRegistry } from './operations.mjs';

/** Most authoritative first. A layer may narrow what any layer above it allowed, and nothing else. */
export const POLICY_LAYERS = Object.freeze([
  'central', 'machine', 'organization', 'repository', 'workspace', 'subject', 'identity', 'host-capability'
]);

/**
 * Confirmation classes, ordered by how much they demand of the user.
 *
 * The ordering is the whole resolution algorithm: given two opinions about one operation, take the
 * later index. `explicit-only` is the ceiling because it means the gateway will not carry the act at
 * all — the user types the command themselves.
 */
const RESTRICTIVENESS = Object.freeze(['none', 'host-confirm', 'exact-confirm', 'ceremony', 'explicit-only']);

function rank(confirmation) {
  const index = RESTRICTIVENESS.indexOf(confirmation);
  if (index < 0) throw new SingularityFlowError(`'${confirmation}' is not a confirmation class.`, { code: 'POLICY_INVALID' });
  return index;
}

/**
 * The shipped default `[INT:REQ-120]`, in registry operation IDs.
 *
 * §13 of the specification writes this list in a different vocabulary from §7's registry example —
 * `impact.quick.deterministic` against `impact.quick`, `workspace.select` against the workspace
 * switch, plus `documents.*`, `build.read` and `repository.history` that no operation is declared
 * for. Rather than invent a translation, this maps onto the operations that actually exist and the
 * compiler below refuses any entry naming one that does not, so the gap stays visible.
 *
 * Assisted variants sit at `host-confirm` rather than automatic. §13 lists only the deterministic
 * half of impact as an automatic read, and §6.1 requires a Context Receipt before assisted analysis
 * — a receipt nobody is asked to look at is a log line.
 */
export const DEFAULT_GATEWAY_POLICY = Object.freeze({
  layer: 'central',
  modelRouting: 'enabled',
  confirmation: Object.freeze({
    'home.overview': 'none',
    'goal.inspect': 'none',
    'goal.impact': 'none',
    'goal.next': 'none',
    'goal.trace': 'none',
    'developer.next': 'none',
    'work.list': 'none',
    'work.continue': 'none',
    'work.handoff': 'none',
    'work.readiness': 'none',
    'work.start.intake': 'none',
    'workspace.list': 'none',
    'repository.explore': 'none',
    'intent.trace': 'none',
    'compare': 'none',
    'impact.quick': 'none',
    'impact.what-if': 'none',
    'problem.investigate': 'none',
    'watch.list': 'none',
    'review.packet': 'none',
    'help.explain': 'none',
    'world-model.inspect': 'none',
    'world-model.next': 'none',
    'world-model.explain': 'none',

    'impact.quick.assisted': 'host-confirm',
    'impact.what-if.assisted': 'host-confirm',
    'problem.investigate.assisted': 'host-confirm',
    'workspace.switch': 'host-confirm',
    'workspace.materialize': 'host-confirm',
    'watch.create': 'host-confirm',
    'watch.revoke': 'host-confirm',
    'work.draft.save': 'host-confirm',

    'work.start': 'exact-confirm',
    'review.open': 'ceremony'
  }),
  denied: Object.freeze([])
});

/**
 * What is left when there is no usable policy. `[INT:CON-122]`
 *
 * Deterministic reads only: no model routing, and everything that writes drops to `explicit-only`,
 * which is the documented explicit-command fallback — the user can still do all of it, by typing it.
 */
function degradedPolicy(registry, problems) {
  const confirmation = {};
  for (const operation of registry.operations) {
    confirmation[operation.id] = operation.classification === 'read' && operation.modelPolicy === 'never'
      ? 'none'
      : 'explicit-only';
  }
  /**
   * A degraded policy is hashed like any other, and hashes differently.
   *
   * `degraded` is part of the addressed decisions, so a handle issued while policy was unreadable
   * does not verify once it loads — which is the right outcome: it was computed against a fallback
   * the user never chose.
   */
  return frozenPolicy({
    modelRouting: 'disabled',
    degraded: true,
    confirmation: Object.freeze(confirmation),
    denied: Object.freeze([]),
    layers: Object.freeze([]),
    problems: Object.freeze(problems)
  });
}

function normalizeLayer(layer, registry, problems) {
  if (!layer || typeof layer !== 'object') {
    problems.push({ code: 'POLICY_LAYER_MALFORMED', layer: null });
    return null;
  }
  if (!POLICY_LAYERS.includes(layer.layer)) {
    problems.push({ code: 'POLICY_LAYER_UNKNOWN', layer: layer.layer ?? null });
    return null;
  }
  const confirmation = {};
  for (const [operationId, value] of Object.entries(layer.confirmation ?? {})) {
    if (!registry.operations.some((entry) => entry.id === operationId)) {
      // A rule for an operation that does not exist protects nothing and hides a rename.
      problems.push({ code: 'POLICY_UNKNOWN_OPERATION', layer: layer.layer, operationId });
      continue;
    }
    if (!CONFIRMATION_CLASSES.includes(value)) {
      problems.push({ code: 'POLICY_CONFIRMATION_INVALID', layer: layer.layer, operationId, value });
      continue;
    }
    confirmation[operationId] = value;
  }
  const denied = (layer.denied ?? []).filter((operationId) => {
    if (registry.operations.some((entry) => entry.id === operationId)) return true;
    problems.push({ code: 'POLICY_UNKNOWN_OPERATION', layer: layer.layer, operationId });
    return false;
  });
  return { layer: layer.layer, modelRouting: layer.modelRouting ?? null, confirmation, denied };
}

/**
 * Resolve the layers into one policy the gateway can answer questions from.
 *
 * Never throws. A caller that has to wrap policy resolution in a try/catch will eventually wrap it
 * in one that swallows, and a swallowed policy error is an open gateway.
 */
export function resolveGatewayPolicy(layers = [DEFAULT_GATEWAY_POLICY], { registry = gatewayRegistry() } = {}) {
  const problems = [];
  const normalized = (Array.isArray(layers) ? layers : [])
    .map((layer) => normalizeLayer(layer, registry, problems))
    .filter(Boolean);

  if (!normalized.length) {
    problems.push({ code: 'POLICY_MISSING' });
    return degradedPolicy(registry, problems);
  }

  const ordered = [...normalized].sort((a, b) => POLICY_LAYERS.indexOf(a.layer) - POLICY_LAYERS.indexOf(b.layer));
  const confirmation = {};
  const denied = new Set();
  let modelRouting = 'enabled';

  for (const operation of registry.operations) {
    /**
     * The registry's own confirmation class is the floor, not a suggestion. A policy that said
     * `none` for an approval would otherwise be a policy file that could downgrade a ceremony.
     */
    confirmation[operation.id] = operation.gateway.confirmation;
  }

  for (const layer of ordered) {
    if (layer.modelRouting === 'disabled') modelRouting = 'disabled';
    for (const operationId of layer.denied) denied.add(operationId);
    for (const [operationId, value] of Object.entries(layer.confirmation)) {
      const current = confirmation[operationId];
      if (rank(value) >= rank(current)) {
        confirmation[operationId] = value;
        continue;
      }
      // Narrowing only. The weaker value is dropped, and the attempt is reported.
      problems.push({ code: 'POLICY_WEAKENING_IGNORED', layer: layer.layer, operationId, attempted: value, kept: current });
    }
  }

  return frozenPolicy({
    modelRouting,
    degraded: false,
    confirmation: Object.freeze(confirmation),
    denied: Object.freeze([...denied].sort()),
    layers: Object.freeze(ordered.map((layer) => layer.layer)),
    problems: Object.freeze(problems)
  });
}

/**
 * Content-address the resolved policy, so a handle can be bound to it. `[INT:REQ-034]`
 *
 * A handle carries the policy it was computed under, and `frozenBinding` rejects a falsy
 * `policyHash` outright — "a handle without them binds nothing". Nothing produced one, which is why
 * the gateway could be built, tested and never wired: the first real caller cannot construct a
 * legal binding. Found on that first wiring, exactly where the plan expected the contract to have
 * a gap.
 *
 * The hash covers the *resolved decisions* rather than the layer files. Two different files that
 * resolve to the same permissions should not invalidate an outstanding confirmation, and one file
 * edited to a different permission set should — which is the resolved set, not its provenance.
 */
function frozenPolicy(policy) {
  const decisions = {
    modelRouting: policy.modelRouting,
    degraded: policy.degraded,
    confirmation: policy.confirmation,
    denied: policy.denied,
    layers: policy.layers
  };
  return Object.freeze({
    ...policy,
    contentHash: `sha256:${createHash('sha256').update(canonicalJson(decisions)).digest('hex')}`
  });
}

/**
 * What the gateway may do with one operation, right now.
 *
 * `executable` is the answer to "may an ambient tool carry this out without the user acting", and
 * it is false for anything at `ceremony` or `explicit-only` `[INT:CON-113]` `[INT:CON-123]`. A
 * destructive operation is unreachable because it is not in the registry at all; this is the second
 * lock, for the day one of them is declared.
 */
export function operationPermission(policy, operationId, { registry = gatewayRegistry() } = {}) {
  const operation = registry.operations.find((entry) => entry.id === operationId);
  if (!operation) return Object.freeze({ reachable: false, reason: 'not-registered', executable: false, confirmation: null });
  if (policy.denied.includes(operationId)) {
    return Object.freeze({ reachable: false, reason: 'denied-by-policy', executable: false, confirmation: null });
  }
  const confirmation = policy.confirmation[operationId] ?? operation.gateway.confirmation;
  if (policy.modelRouting === 'disabled' && confirmation === 'none' && operation.modelPolicy !== 'never') {
    return Object.freeze({ reachable: false, reason: 'model-routing-disabled', executable: false, confirmation });
  }
  return Object.freeze({
    reachable: true,
    reason: null,
    confirmation,
    executable: operation.executable && confirmation !== 'ceremony' && confirmation !== 'explicit-only'
  });
}
