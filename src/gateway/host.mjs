/**
 * A gateway kernel bound to this machine, this repository and this person. `[INT:CON-032]`
 *
 * Everything under `src/gateway/` is pure: the registry, policy, handle authority and clock all
 * arrive as arguments, which is what makes the kernel transport-independent and what makes the same
 * inputs produce the same resolution every time. That purity has to end somewhere, and this is the
 * somewhere — the one module that reads the world and hands the kernel a binding.
 *
 * Until now it ended nowhere. The kernel had declared operations, only a subset of their planners, a
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
import { createHash } from 'node:crypto';

import { createGatewayKernel } from './kernel.mjs';
import { createHandleAuthority } from './handles.mjs';
import { gatewayRegistry } from './operations.mjs';
import { DEFAULT_GATEWAY_POLICY, resolveGatewayPolicy } from './policy.mjs';
import { noEffects, preservedAll, repositoryReference, sflowResult, TOOL_ANSWER_MAX_BYTES } from './result.mjs';
import { copilotModePresentation, readCopilotMode } from '../copilot-mode.mjs';
import { branch, head, identity, localGitDisplayName, repoRoot } from '../git.mjs';
import { operationContext, withOperationContext } from '../operation-context.mjs';
import { worktreeFingerprint } from '../worktree-fingerprint.mjs';
import { withReadScope } from '../read-scope.mjs';
import { resolvePersonalization } from '../personalization.mjs';

/**
 * Run one host handler inside the exact registered gateway operation.
 *
 * CLI commands establish this boundary in `cli-entry`. Native hosts do not pass through that
 * dispatcher, so the host adapter is the corresponding trust boundary for VS Code and any future
 * in-process transport. Keeping the wrapper here leaves the transport-neutral kernel pure while
 * ensuring a handler can never reach the model runner as an anonymous ambient callback.
 */
function runHostOperation(root, policy, request, callback, { modelCapable = false, routeModelMode = () => null } = {}) {
  const operation = request?.operation;
  if (!operation?.id || !['never', 'optional', 'required'].includes(operation.modelPolicy)) {
    throw new TypeError('A host gateway handler requires its compiled registered operation.');
  }
  const registered = operation.command
    ? operation
    : Object.freeze({ ...operation, command: operation.id });
  const parent = operationContext();
  const gatewayAllowsModel = policy.modelRouting !== 'disabled';
  const operationDigest = createHash('sha256').update(JSON.stringify([
    registered.id, request?.arguments ?? {}
  ])).digest('hex');
  return withOperationContext({
    operation: registered,
    modelMode: Object.freeze({
      enabled: modelCapable && gatewayAllowsModel && (parent?.modelMode?.enabled ?? true),
      source: !modelCapable
        ? 'gateway-pre-execution'
        : gatewayAllowsModel ? (parent?.modelMode?.source ?? 'gateway-policy') : 'gateway-policy'
    }),
    /**
     * The mode of the CLI run this gateway serves (`recommend`, `gateway serve`), else the mode the
     * host itself is set to (VS Code's `singularityFlow.modelMode`), else null. Not a permission: a
     * planner runs model-disabled above, and a read names the routes that run would offer
     * (`nextsteps`' publication route) from this instead of from its own mode.
     */
    routeModelMode: parent?.routeModelMode ?? parent?.modelMode ?? routeModelMode() ?? null,
    // Repository selection belongs to this gateway session. An ambient CLI operation can restrict
    // model policy through the inherited stack, but it cannot redirect audit records to its root.
    root,
    argvSha256: operationDigest,
    argvHash: `sha256:${operationDigest}`,
    command: registered.command,
    startedAt: new Date().toISOString()
  }, callback);
}

function contextualHandlers(handlers, root, policy, options = {}) {
  return new Map([...handlers].map(([name, handler]) => [
    name,
    typeof handler === 'function'
      ? (request) => runHostOperation(root, policy, request, async () => {
          const result = await handler(request);
          return options.presentation && result?.data
            ? { ...result, data: { ...result.data, personalization: request.context?.personalization } }
            : result;
        }, options)
      : handler
  ]));
}

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
  const workingTree = root ? worktreeFingerprint(root) : null;
  return Object.freeze({
    workspaceId,
    subjectKind: subject?.kind ?? null,
    subjectId: subject?.id ?? null,
    sourceCommit: root ? head(root) ?? null : null,
    // Bind even a clean tree: index visibility flags are observation state, and changing one must
    // stale a handle even when no file byte is currently dirty.
    // A rootless Home has no worktree, but handles still require the current fingerprint algorithm
    // so a read issued before repository selection can be verified. The all-zero sentinel means
    // "no repository bytes participated"; it is never used for a repository-backed handle.
    worktreeHash: workingTree?.sha256 ?? '0'.repeat(64),
    worktreeAlgorithm: workingTree?.algorithm ?? 'sflow-worktree-v2',
    repository: root ?? null,
    branch: root ? branch(root) ?? null : null,
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
    actorId: bindingActorId(root),
    hostSessionId
  });
}

/** The operation a refused tool call names: the tool's own entry point, or the explain operation. */
const TOOL_OPERATIONS = Object.freeze({
  sflow_resolve: 'gateway.resolve', sflow_read: 'gateway.read', sflow_next: 'gateway.next',
  sflow_run: 'gateway.run', sflow_explain: 'help.explain'
});

/**
 * Paused SFlow guidance answers a model's tool call before the kernel sees it.
 *
 * `singularity-flow pause on` turns SFlow's Copilot guidance off on this machine, and every CLI
 * read entry checks it before Git. The five tools are the same guidance by another door, so both
 * model-facing hosts (VS Code's language-model tools and `gateway serve`) ask this one function
 * first, before any binding, Git read or planner. It reads the bounded local preference only, so
 * a call that is not paused costs one small file read. The host's own screens (My Work, cards)
 * are not Copilot guidance and do not call it. Null when not paused.
 */
export function pausedToolAnswer(tool, mode = readCopilotMode()) {
  if (!mode?.paused) return null;
  const presentation = copilotModePresentation(mode);
  return sflowResult({
    kind: 'refusal',
    operation: { id: TOOL_OPERATIONS[tool] ?? 'gateway.resolve', classification: 'read' },
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: {} },
    effects: noEffects(),
    why: [{ code: 'gateway.copilot-paused', source: 'policy', slots: {} }],
    preserved: preservedAll('gateway.nothing-was-carried-out'),
    restState: 'blocked',
    data: {
      paused: true,
      nativeCopilot: true,
      stateAvailable: mode.stateAvailable !== false,
      agentInstruction: presentation.agentInstruction,
      commandGuidance: presentation.commandGuidance
    }
  });
}

const answerBytes = (answer) => Buffer.byteLength(JSON.stringify(answer), 'utf8');

/**
 * A next action as a model follows it, still a valid next action: the handle, what it is, how it
 * is confirmed and the routes printed without the tool. Its rank, topic, effect summary and label
 * slots are what a card draws, and the result contract fills their defaults back in.
 */
function toolNextAction({ handle, id, label, kind, reasonCode, confirmation, interaction, emphasis, fallback, hostAction }) {
  const { copyable: _copyable, ...routes } = fallback ?? {};
  return { handle, id, label, kind, reasonCode, confirmation, interaction, emphasis,
    ...(fallback ? { fallback: routes } : {}), ...(hostAction === undefined ? {} : { hostAction }) };
}

/**
 * A lifecycle step's routes and why. `argv`, `executable` and the per-platform commands spell its
 * `command` again, and `modelPolicy: 'never'` and `availability: 'available'` are every step's.
 */
function toolLifecycleAction({ argv: _argv, executable: _executable, platformCommands: _platform, copyable: _copyable,
  modelPolicy, availability, ...action }) {
  return { ...action, ...(modelPolicy === 'never' ? {} : { modelPolicy }),
    ...(availability === 'available' ? {} : { availability }) };
}

/** The lifecycle steps a person can take from this answer; the optional and later ones are `nextsteps`' list. */
const ACTIONABLE_TIMINGS = new Set(['now', 'blocked', 'alternative']);

/**
 * Home and the recommendation as a tool reads them. Whole, an approved Story's answer is about
 * 15 KB: the receipt and rail only the VS Code card draws, the card's menu again (`choiceSet`), the
 * current work twice, the worktree's hashes twice, Home's card projection (its menu, current work
 * and rail once more), and every lifecycle step to the end of the workflow with each route spelled
 * four ways. The view keeps what `/sf-recommend`, `/sf-home` and `/sf-advise` report and names what
 * it left out; `recommend --json` and the card keep everything.
 */
function homeToolView(answer, whole) {
  const { latestReceipt, rail, choiceSet, activeWork, guidance, localChanges, homeProjection, ...data } = answer.data ?? {};
  const { revision: _revision, ...subject } = answer.subject ?? {};
  const repeated = activeWork !== undefined && JSON.stringify(activeWork) === JSON.stringify(data.currentWork);
  // What only the card has; the menu (`choiceSet`), a repeated `activeWork` and hashes are elsewhere here.
  const leftOut = [['latestReceipt', latestReceipt], ['rail', rail]]
    .filter(([, value]) => value !== undefined).map(([key]) => `data.${key}`);
  const actions = Array.isArray(guidance?.actions) ? guidance.actions : null;
  const more = actions?.filter((action) => !ACTIONABLE_TIMINGS.has(action.timing)) ?? [];
  return {
    ...answer,
    // The model reads the Story, not the hashes its handles are bound to; the kernel checks those.
    ...(answer.subject ? { subject } : {}),
    data: {
      ...data,
      ...(repeated || activeWork === undefined ? {} : { activeWork }),
      // Of the card projection, only how fresh each source is and Home's health are not repeated here.
      ...(homeProjection && typeof homeProjection === 'object' ? {
        homeProjection: (({ resultType, schemaVersion, asOf, sources, health }) =>
          ({ resultType, schemaVersion, asOf, sources, health }))(homeProjection)
      } : homeProjection === undefined ? {} : { homeProjection }),
      ...(localChanges === undefined ? {} : {
        localChanges: localChanges && typeof localChanges === 'object'
          ? (({ worktreeHash: _hash, worktreeAlgorithm: _algorithm, ...rest }) => rest)(localChanges) : localChanges
      }),
      ...(guidance === undefined ? {} : {
        guidance: actions ? {
          ...guidance,
          actions: actions.filter((action) => ACTIONABLE_TIMINGS.has(action.timing)).map(toolLifecycleAction),
          ...(more.length ? { moreActions: { count: more.length, read: '/sf-nextsteps' } } : {})
        } : guidance
      }),
      toolView: { leftOut, whole }
    }
  };
}

const TOOL_VIEWS = Object.freeze({
  'home.overview': (answer) => homeToolView(answer, 'singularity-flow home --json'),
  'developer.next': (answer) => homeToolView(answer, 'singularity-flow recommend --json')
});

/**
 * What a model reads from one tool call: the kernel's answer whole when it fits one tool result,
 * else its tool view, else a refusal. Both Copilot hosts move a longer result out of the
 * conversation (`TOOL_ANSWER_MAX_BYTES`), where a skill turn cannot read it, so a refused answer
 * sends the skill to its CLI command instead. Both hosts ask this last (`gateway serve` and VS
 * Code's language-model tools); their own screens read the kernel's answer whole.
 *
 * A run's answer, and any answer that records an effect, is sent whole: a refusal would read as
 * nothing having happened.
 */
export function boundedToolAnswer(tool, answer) {
  if (tool === 'sflow_run' || !answer || typeof answer !== 'object' || answerBytes(answer) <= TOOL_ANSWER_MAX_BYTES) return answer;
  if (Object.values(answer.effects ?? {}).some(Boolean)) return answer;
  const compact = Array.isArray(answer.next) ? { ...answer, next: answer.next.map(toolNextAction) } : answer;
  const view = TOOL_VIEWS[answer.operation?.id]?.(compact) ?? compact;
  const bytes = answerBytes(view);
  if (bytes <= TOOL_ANSWER_MAX_BYTES) return view;
  return sflowResult({
    kind: 'refusal',
    operation: { id: answer.operation?.id ?? TOOL_OPERATIONS[tool] ?? 'gateway.resolve', classification: 'read' },
    subject: answer.subject ?? null,
    outcome: { status: 'refused', messageId: 'gateway.refused', slots: {} },
    effects: noEffects(),
    why: [{ code: 'gateway.tool-answer-too-long', source: 'deterministic', reference: answer.subject?.id ?? null,
      slots: { bytes: String(bytes), limit: String(TOOL_ANSWER_MAX_BYTES) } }],
    preserved: preservedAll('gateway.nothing-was-carried-out'),
    restState: 'blocked'
  });
}

/**
 * Who a binding is for: email before login, and never a display name.
 *
 * Its own function so every surface that keys something per person — a handle binding, the guide
 * session `[INT:CON-101]` — names the same person the same way, from the CLI and the editor alike.
 */
export function bindingActorId(root) {
  const actor = identity(root ?? process.cwd(), { offline: true });
  return actor.email ?? actor.login ?? (root ? null : 'machine:git-identity-unconfigured');
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
   * It defaulted to `gatewayPlanners()`, which made every host statically import every planner.
   * Hosts still declare their available planners explicitly: packaging support is now shared, but
   * a small host must not acquire unrelated capabilities merely because another host contains them.
   *
   * Which planners a build actually has was already the kernel's own distinction: the registry says
   * which planner an operation *names*, the map says which ones exist, and an operation whose
   * planner is absent gets `gateway.planner-unavailable` rather than a crash. A host that can serve
   * six of the seven is a state the contract already handles; it should not have to fake the
   * seventh to start up.
   */
  planners,
  planBuilders = new Map(),
  mutationExecutors = new Map(),
  /** Surface selection that every planner reads instead of re-deriving independently. */
  plannerContext = {},
  readOnly = true,
  /** How this host collects confirmations; see createGatewayKernel `[INT:IFC-063]`. */
  hostCapabilities = { confirmationChannel: 'native' },
  /**
   * The model mode this host is set to, as `resolveModelMode` returns it, or a thunk for one: the
   * routes a read offers when no CLI run is serving it (VS Code's `singularityFlow.modelMode`).
   */
  routeModelMode = null,
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
  const hostRouteModelMode = typeof routeModelMode === 'function' ? routeModelMode : () => routeModelMode;
  const contextualPlanners = contextualHandlers(planners, root, policy,
    { presentation: true, routeModelMode: hostRouteModelMode });
  const contextualPlanBuilders = contextualHandlers(planBuilders, root, policy);
  // Only execution occurs after the exact confirmation receipt has redeemed. Planning stages get
  // the registered identity for provenance, but remain model-disabled even under a permissive
  // ambient CLI context.
  const contextualMutationExecutors = contextualHandlers(
    mutationExecutors, root, policy, { modelCapable: true }
  );

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
    const identityRoot = root ?? process.cwd();
    const actor = identity(identityRoot, { offline: true });
    const gitName = localGitDisplayName(identityRoot);
    const supplied = typeof plannerContext === 'function' ? plannerContext() : plannerContext;
    return {
      actor: {
        name: gitName,
        email: actor.email ?? (current.actorId?.includes('@') ? current.actorId : null),
        login: actor.login ?? (!current.actorId?.includes('@') ? current.actorId : null)
      },
      // A standalone repository has no workspace, and its checkout path is not an ID for one.
      workspace: current.workspaceId ? { id: current.workspaceId, name: current.workspaceId } : null,
      branch: current.branch,
      storyId: current.subjectId,
      workId: current.subjectId,
      workKind: current.subjectKind,
      ...(supplied ?? {}),
      /**
       * Planners echo this into results, so a host without a registered ID still gets a name
       * rather than the root. It follows the supplied context, which may say null.
       */
      repositoryId: supplied?.repositoryId ?? repositoryReference(root),
      personalization: resolvePersonalization({ actor: { name: gitName },
        profileName: supplied?.replyProfileName, allowGit: false })
    };
  };

  const kernel = createGatewayKernel({
    registry,
    policyLayers,
    planners: contextualPlanners,
    binding,
    root,
    plannerContext: context,
    handles: createHandleAuthority({ now }),
    readOnly,
    hostCapabilities,
    planBuilders: contextualPlanBuilders,
    mutationExecutors: contextualMutationExecutors,
    now
  });
  const scopedKernel = Object.freeze({
    ...kernel,
    // Revalidation and the planner both need the current tree. They share one exact fingerprint
    // during a read, while resolve and a later dispatch still recompute so byte drift invalidates
    // the handle as designed.
    read: (request) => withReadScope(() => kernel.read(request))
  });

  return {
    root,
    binding,
    kernel: scopedKernel
  };
}
