/**
 * A gateway kernel bound to this machine, this repository and this person. `[INT:CON-032]`
 *
 * Everything under `src/gateway/` is pure: the registry, policy, handle authority and clock all
 * arrive as arguments, which is what makes the kernel transport-independent and what makes the same
 * inputs produce the same resolution every time. That purity has to end somewhere, and this is the
 * somewhere — the one module that reads the world and hands the kernel a binding.
 *
 * Until now it ended nowhere. The kernel had 26 declared operations, seven implemented planners, a
 * signed handle authority, policy layers and progress contracts, and `grep gateway/ src/` returned
 * no hits outside `src/gateway/` itself. Only tests ever built one. This is its first consumer, and
 * the reason to write the binding carefully is that every later surface inherits it.
 *
 * ## Reads only, and cheaply
 *
 * `identity()` and the repository facts are read with `{ offline: true }`. A binding is computed on
 * every home render and on every action dispatch, so a network call here would be a network call in
 * the hot path — the exact defect that made the read model take 62 seconds on a real repository.
 * Freshness is declared rather than chased.
 *
 * ## `readOnly` is the default and stays that way in v1
 *
 * `createGatewayKernel({readOnly: true})` refuses `run()` unconditionally, and every implemented
 * planner is `classification: 'read'`. Both facts are load-bearing: the shell can wire the whole
 * gateway without any path through it being able to change anything, which is what makes wiring it
 * first — before the cards, before the home — a safe order to build in.
 */
import { createGatewayKernel } from './kernel.mjs';
import { createHandleAuthority } from './handles.mjs';
import { gatewayRegistry } from './operations.mjs';
import { DEFAULT_GATEWAY_POLICY, resolveGatewayPolicy } from './policy.mjs';
import { branch, head, identity, localGitDisplayName, repoRoot } from '../git.mjs';
import { worktreeFingerprint } from '../worktree-fingerprint.mjs';

/**
 * The world a handle is bound to, read once per session. `[INT:REQ-034]` `[DHR:REQ-081]`
 *
 * Every field is present and may be explicitly null, never absent — a binding with a missing field
 * cannot be told apart from one where the field did not apply, and revalidation would have to guess
 * which. `repository` and `branch` are here because a handle resolved in one checkout must not
 * execute in another, which is a thing that happens the moment someone has two clones of the same
 * repository open, and is invisible to every other field.
 */
export function hostBinding(root, { workspaceId = null, hostSessionId, subject = null, registry, policy } = {}) {
  const actor = identity(root, { offline: true });
  const workingTree = worktreeFingerprint(root);
  return Object.freeze({
    workspaceId,
    subjectKind: subject?.kind ?? null,
    subjectId: subject?.id ?? null,
    sourceCommit: head(root) ?? null,
    // Clean remains null as the explicit "no local changes" value. Once dirty, this binds the
    // handle to exact bytes rather than to the shape of `git status`.
    worktreeHash: workingTree.dirty ? workingTree.sha256 : null,
    repository: root,
    branch: branch(root) ?? null,
    lifecycleRevision: subject?.revision?.lifecycleHash ?? null,
    policyHash: policy.contentHash,
    registryHash: registry.contentHash,
    /**
     * Email before login, and never a display name.
     *
     * A binding drifts when the actor changes, so the actor has to be identified by something
     * stable. `identity()` reports whichever of these it could read without asking the network; a
     * name is the one field two people plausibly share.
     */
    actorId: actor.email ?? actor.login ?? null,
    hostSessionId
  });
}

/**
 * Build the kernel a command or an editor uses.
 *
 * `hostSessionId` is required rather than defaulted. A handle is session-bound, and a default would
 * be a shared session ID — under which a handle issued in one window verifies in another, which is
 * precisely the confusion binding exists to prevent.
 */
export function createHostGateway({
  root = repoRoot(),
  hostSessionId,
  workspaceId = null,
  subject = null,
  policyLayers = [DEFAULT_GATEWAY_POLICY],
  /**
   * Which planners this host has, supplied rather than defaulted. `[INT:CON-032]`
   *
   * It defaulted to `gatewayPlanners()`, which made this module statically import all seven — and
   * `help-explain` reaches the documentation subsystem, which resolves its own path through
   * `import.meta.url`. Harmless in the CLI and fatal in a CommonJS bundle, so the default quietly
   * decided that this module could only ever run in one kind of host.
   *
   * Which planners a build actually has was already the kernel's own distinction: the registry says
   * which planner an operation *names*, the map says which ones exist, and an operation whose
   * planner is absent gets `gateway.planner-unavailable` rather than a crash. A host that can serve
   * six of the seven is a state the contract already handles; it should not have to fake the
   * seventh to start up.
   */
  planners,
  /** Surface selection that every planner reads instead of re-deriving independently. */
  plannerContext = {},
  readOnly = true,
  now = () => Date.now()
} = {}) {
  if (!hostSessionId) {
    throw new TypeError('A host gateway requires the host session it is issuing handles for.');
  }
  if (!(planners instanceof Map)) {
    throw new TypeError('A host gateway requires the map of planners this build has.');
  }
  const registry = gatewayRegistry();
  const policy = resolveGatewayPolicy(policyLayers, { registry });

  /**
   * A thunk, not a snapshot. `[INT:REQ-036]`
   *
   * The kernel accepts either, and a host that lives longer than one command must pass the
   * function: a captured binding is compared against a handle's equally captured binding, so both
   * move together when the user switches branch and nothing detects it. An editor session is
   * exactly that host. The CLI would be safe with a value and passes the function anyway, because
   * "safe because this process is short-lived" is a property that stops being true quietly.
   */
  const binding = () => hostBinding(root, { workspaceId, hostSessionId, subject, registry, policy });
  const context = () => {
    const current = binding();
    /**
     * Presentation identity is deliberately separate from the signed binding.
     *
     * The binding keeps using email/login as the stable actor ID. Planners also receive the local
     * Git display name so a read result can address its reader, but changing that name never changes
     * authority and no handle trusts it.
     */
    const actor = identity(root, { offline: true });
    const supplied = typeof plannerContext === 'function' ? plannerContext() : plannerContext;
    return {
      actor: {
        name: localGitDisplayName(root),
        email: actor.email ?? (current.actorId?.includes('@') ? current.actorId : null),
        login: actor.login ?? (!current.actorId?.includes('@') ? current.actorId : null)
      },
      workspace: { id: current.workspaceId ?? root, name: current.workspaceId ?? root },
      repositoryId: root,
      branch: current.branch,
      storyId: current.subjectId,
      ...(supplied ?? {})
    };
  };

  return {
    root,
    binding,
    kernel: createGatewayKernel({
      registry,
      policyLayers,
      planners,
      binding,
      root,
      plannerContext: context,
      handles: createHandleAuthority({ now }),
      readOnly
    })
  };
}
