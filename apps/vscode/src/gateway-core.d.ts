/**
 * What the extension expects from the core it now bundles.
 *
 * `src/` is plain JavaScript by design — it is the CLI, and the CLI has no build step. That is a
 * good property and it stops at this boundary, where TypeScript needs to know the shape of what it
 * is importing. One declaration file rather than a `@ts-expect-error` per import: a suppression
 * says "do not check this", while a declaration says what the contract is and fails when the core
 * stops honouring it.
 *
 * These are deliberately narrow — only the exports this host uses, only the fields it reads. A
 * declaration that mirrored the whole module would be a second copy of the contract to keep level
 * with the first, which is the drift it exists to prevent.
 */
declare module '*/gateway/host.mjs' {
  export function createHostGateway(options: {
    root: string;
    hostSessionId: string;
    workspaceId?: string | null;
    subject?: unknown;
    policyLayers?: readonly unknown[];
    planners: Map<string, unknown>;
    readOnly?: boolean;
    now?: () => number;
  }): { root: string; binding: () => unknown; kernel: GatewayKernel };

  export function hostBinding(root: string, options: Record<string, unknown>): Record<string, unknown>;
}

/** Only the two entry points a read-only host calls, and what they hand back. */
interface GatewayKernel {
  resolve(request: { utterance?: string; goalHint?: string; selectionHandle?: string; arguments?: unknown },
    context?: { subject?: unknown }): Promise<SflowResult> | SflowResult;
  read(request: { resolutionId: string }): Promise<SflowResult>;
  next(request?: { scope?: string; subject?: unknown }): SflowResult;
}

/**
 * The envelope, as far as the card needs it.
 *
 * `unknown` on the arrays rather than a full mirror of `result.mjs`: the card model already accepts
 * the envelope loosely and validates what it reads, and duplicating the contract's own types here
 * would create a second definition of valid that nothing keeps aligned.
 */
interface SflowResult {
  readonly schemaVersion: number;
  readonly resultType: string;
  readonly kind: string;
  readonly operation: { readonly id: string; readonly classification: string };
  readonly outcome: { readonly status: string; readonly messageId: string; readonly slots?: Record<string, string | number> };
  readonly effects: Readonly<Record<string, boolean>>;
  readonly why: readonly unknown[];
  readonly warnings: readonly unknown[];
  readonly preserved: readonly unknown[];
  readonly checklist: readonly unknown[];
  readonly next: readonly { readonly id: string; readonly handle: string }[];
  readonly restState: string | null;
  readonly data: Readonly<Record<string, unknown>>;
}

declare module '*/gateway/executor.mjs' {
  export function createActionExecutor(options: { gateway: unknown; scope?: string }): {
    execute(action: unknown): Promise<{ outcome: string; result?: SflowResult; action?: unknown }>;
    executeById(result: unknown, actionId: string): Promise<{ outcome: string; result?: SflowResult; action?: unknown }>;
  };
}

/**
 * A planner is a function the kernel calls and whose output it validates.
 *
 * Typed as an opaque callable on purpose. The kernel re-validates every planner result through
 * `sflowResult`, so a planner cannot widen the contract by returning something result-shaped — and
 * a richer type here would imply this boundary is where that is enforced, when it is not.
 */
declare module '*/gateway/planners/home-overview.mjs' { export const homeOverview: unknown; }
declare module '*/gateway/planners/impact-quick.mjs' { export const impactQuick: unknown; }
declare module '*/gateway/planners/work-continue.mjs' { export const workContinue: unknown; }
declare module '*/gateway/planners/work-list.mjs' { export const workList: unknown; }
declare module '*/gateway/planners/work-readiness.mjs' { export const workReadiness: unknown; }
declare module '*/gateway/planners/workspace-list.mjs' { export const workspaceList: unknown; }
