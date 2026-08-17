/**
 * The gateway, running inside the extension host. `[UXH:REQ-031]` `[DHR:REQ-086]`
 *
 * Until now the extension reached SFlow only by spawning the CLI, which is the right boundary for
 * anything that *acts* — it means the editor surfaces the CLI's guards rather than reimplementing
 * them — and the wrong one for a handle. A handle is signed per session and revalidated against the
 * world at the moment of use; it cannot survive a process that exits after every command. So every
 * card button ran a terminal command instead, and nothing re-resolved anything.
 *
 * This closes that. The kernel is pure JavaScript with no ambient state, so it runs here as
 * happily as in the CLI, and an extension host is exactly the long-lived session the binding thunk
 * was written for: it outlives branch switches, which is when a stale handle must stop verifying.
 *
 * ## Six planners, not seven, and the contract already knows
 *
 * `help-explain` reaches the documentation subsystem, which resolves its own location through
 * `import.meta.url` — correct under ESM and empty in the CommonJS bundle a VS Code extension loads.
 * Rather than shimming it, this host declares the six it has. The kernel's registry-versus-map
 * distinction covers the rest: `help.explain` resolves, finds no planner, and returns
 * `gateway.planner-unavailable`, which renders as "this build cannot answer that yet" and points at
 * the CLI. A capability the host genuinely lacks, reported as one.
 */
import { createActionExecutor } from '../../../src/gateway/executor.mjs';
import { createHostGateway } from '../../../src/gateway/host.mjs';
import { homeOverview } from '../../../src/gateway/planners/home-overview.mjs';
import { impactQuick } from '../../../src/gateway/planners/impact-quick.mjs';
import { workContinue } from '../../../src/gateway/planners/work-continue.mjs';
import { workList } from '../../../src/gateway/planners/work-list.mjs';
import { workReadiness } from '../../../src/gateway/planners/work-readiness.mjs';
import { workReturn } from '../../../src/gateway/planners/work-return.mjs';
import { workspaceList } from '../../../src/gateway/planners/workspace-list.mjs';

/** What this host can answer without leaving the editor process. */
export function editorPlanners(): Map<string, unknown> {
  return new Map<string, unknown>([
    ['home-overview', homeOverview],
    ['work-list', workList],
    ['work-continue', workContinue],
    ['work-readiness', workReadiness],
    ['work-return', workReturn],
    ['workspace-list', workspaceList],
    ['impact-quick', impactQuick]
  ]);
}

export type GatewaySession = {
  readonly root: string;
  readonly kernel: any;
  /**
   * The world as it is now, recomputed per call. `[INT:REQ-036]`
   *
   * Exposed because the host has one question the kernel does not answer: *who is this?* An
   * acknowledgement is stored per actor, and the binding already resolves the actor the same way
   * revalidation does — so the key a delta is stored under and the identity a handle is checked
   * against cannot drift apart.
   */
  readonly binding: () => { readonly actorId: string | null; readonly workspaceId: string | null };
  readonly executor: { execute(action: any): Promise<any>; executeById(result: any, id: string): Promise<any> };
};

let session: GatewaySession | null = null;
let sessionRoot: string | null = null;
let sessionWorkspaceId: string | null = null;
let sessionWorkspaceName: string | null = null;
let sessionRepositoryId: string | null = null;

/**
 * The one validated repository context every editor surface acts on.
 *
 * This is deliberately activation-local routing state, not persisted lifecycle state. The active
 * workspace remains owned by the CLI's machine-wide record; the extension resolves that record once
 * and publishes the resulting repository here so cards, forms and chrome cannot each invent a
 * different answer from the folder VS Code happens to have open.
 */
export type ActiveRepositoryContext = {
  readonly root: string;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  readonly repositoryId: string | null;
  readonly origin: string;
};

let activeContext: ActiveRepositoryContext | null = null;

/**
 * One session ID per extension activation.
 *
 * Not per command and not per window reload. Handles issued before a reload are legitimately dead —
 * the session that signed them is gone — and a stable ID across activations would let one verify
 * afterwards, which is the confusion session binding exists to prevent.
 */
const HOST_SESSION_ID = `vscode_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

/**
 * The session for a repository, rebuilt when the repository changes.
 *
 * Rebuilt rather than re-bound: a different repository is a different world, and carrying the
 * handle authority across would let a handle resolved in one checkout be redeemed in another. The
 * *binding* refreshes on every call — that is the thunk — but the authority is per repository.
 */
/**
 * When this reader last said they had read the home. `[DHR:REQ-024]`
 *
 * Injected by the extension host, because it is the only party that knows: the acknowledgement is
 * kept in `globalState`, per workspace and per actor, and the gateway has no notion of either.
 * Null until one is stored, which is the honest answer before a reader has ever checked.
 */
let acknowledgedAtProvider: () => string | null = () => null;

export function provideAcknowledgedAt(provider: () => string | null): void {
  acknowledgedAtProvider = provider;
  // The session captured the previous provider in its context thunk; drop it so the next call
  // rebuilds against this one rather than answering with the value from before activation.
  resetGatewaySession();
}

export function gatewaySession(context: ActiveRepositoryContext): GatewaySession {
  const { root, workspaceId, workspaceName, repositoryId } = context;
  if (session && sessionRoot === root && sessionWorkspaceId === workspaceId
    && sessionWorkspaceName === workspaceName && sessionRepositoryId === repositoryId) return session;
  const host = createHostGateway({
    root,
    hostSessionId: HOST_SESSION_ID,
    workspaceId,
    planners: editorPlanners(),
    /**
     * The one fact the planners want and the gateway cannot know. `[DHR:REQ-024]`
     *
     * `work.return` chooses between "since you were here" and "current state" on whether it was
     * given a *when* — the distinction `[DHR:REQ-024]` exists for, since a reader shown a delta
     * reads everything absent from it as unchanged. The field was declared on the planner,
     * defaulted to null, threaded through `plannerContext`, and **supplied by nobody**: the CLI
     * passes a context that does not include it and this host passed no context at all. So the
     * briefing could only ever take the second branch, correctly and permanently.
     *
     * A thunk, not a value: the session outlives any particular acknowledgement, and a captured one
     * would keep answering with the timestamp that was current when the repository was opened.
     */
    plannerContext: () => ({
      acknowledgedAt: acknowledgedAtProvider(),
      repositoryId: repositoryId ?? root,
      ...(workspaceId ? {
        workspace: { id: workspaceId, name: workspaceName ?? workspaceId },
        workspaceName: workspaceName ?? workspaceId
      } : {})
    }),
    // Every implemented planner is a read, and `run()` refuses unconditionally `[INT:CON-033]`.
    readOnly: true
  });
  session = {
    root: host.root,
    kernel: host.kernel,
    /** `host.mjs` is untyped JavaScript; the shape asserted here is `hostBinding`'s return. */
    binding: host.binding as GatewaySession['binding'],
    executor: createActionExecutor({ gateway: host })
  };
  sessionRoot = root;
  sessionWorkspaceId = workspaceId;
  sessionWorkspaceName = workspaceName;
  sessionRepositoryId = repositoryId;
  return session;
}

/** Replace the editor's resolved routing context and retire handles from the previous one. */
export function setActiveRepositoryContext(next: ActiveRepositoryContext | null): void {
  const changed = activeContext?.root !== next?.root
    || activeContext?.workspaceId !== next?.workspaceId
    || activeContext?.workspaceName !== next?.workspaceName
    || activeContext?.repositoryId !== next?.repositoryId;
  activeContext = next ? Object.freeze({ ...next }) : null;
  if (changed) resetGatewaySession();
}

/** The validated context the editor is currently about, or null when none could be resolved. */
export function activeRepositoryContext(): ActiveRepositoryContext | null {
  return activeContext;
}

/** Test seam, and the reload path: a session must not outlive the world it was built for. */
export function resetGatewaySession(): void {
  session = null;
  sessionRoot = null;
  sessionWorkspaceId = null;
  sessionWorkspaceName = null;
  sessionRepositoryId = null;
}
