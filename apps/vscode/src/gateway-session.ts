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
import * as vscode from 'vscode';

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
export function gatewaySession(root: string, workspaceId: string | null = null): GatewaySession {
  if (session && sessionRoot === root) return session;
  const host = createHostGateway({
    root,
    hostSessionId: HOST_SESSION_ID,
    workspaceId,
    planners: editorPlanners(),
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
  return session;
}

/** The repository the editor is currently about, or null when nothing governed is open. */
export function activeRepository(): string | null {
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? null;
}

/** Test seam, and the reload path: a session must not outlive the world it was built for. */
export function resetGatewaySession(): void {
  session = null;
  sessionRoot = null;
}
