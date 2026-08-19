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
    root: string | null;
    hostSessionId: string;
    workspaceId?: string | null;
    subject?: unknown;
    policyLayers?: readonly unknown[];
    planners: Map<string, unknown>;
    plannerContext?: Record<string, unknown> | (() => Record<string, unknown>);
    readOnly?: boolean;
    now?: () => number;
  }): { root: string | null; binding: () => unknown; kernel: GatewayKernel };

  export function hostBinding(root: string | null, options: Record<string, unknown>): Record<string, unknown>;
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
/**
 * The result contract's own derivations, so a surface never repeats one. `[UXH:AC-002]`
 *
 * `primaryAction` is declared here for the status bar, which has to name the same leading step the
 * card fills a button for. Deriving it locally — `next.find(a => a.emphasis === 'primary')` — is
 * three obvious words and is precisely how the two surfaces come to disagree the day the rule
 * changes for one of them. `gateSummary` was already shared for the same reason.
 */
declare module '*/gateway/result.mjs' {
  export function primaryAction(result: unknown): { readonly id: string; readonly label: string } | null;
}

declare module '*/gateway/planners/home-overview.mjs' { export const homeOverview: unknown; }
declare module '*/gateway/planners/ast-intelligence.mjs' {
  export const astContextPlanner: unknown;
  export const astQueryPlanner: unknown;
  export const astStatusPlanner: unknown;
}
declare module '*/gateway/planners/developer-next.mjs' { export const developerNext: unknown; }
declare module '*/gateway/planners/governed-goal.mjs' {
  export const governedGoalImpactPlanner: unknown;
  export const governedGoalInspectPlanner: unknown;
  export const governedGoalNextPlanner: unknown;
  export const governedGoalTracePlanner: unknown;
}
declare module '*/gateway/planners/impact-quick.mjs' { export const impactQuick: unknown; }
declare module '*/gateway/planners/review-packet.mjs' { export const reviewPacket: unknown; }
declare module '*/gateway/planners/work-continue.mjs' { export const workContinue: unknown; }
declare module '*/gateway/planners/work-list.mjs' { export const workList: unknown; }
declare module '*/gateway/planners/work-readiness.mjs' { export const workReadiness: unknown; }
declare module '*/gateway/planners/work-return.mjs' { export const workReturn: unknown; }
declare module '*/gateway/planners/work-start-intake.mjs' { export const workStartIntake: unknown; }
declare module '*/gateway/planners/workspace-list.mjs' { export const workspaceList: unknown; }
declare module '*/gateway/planners/workspace-reliability-surface.mjs' {
  export const workspaceBootstrapStatus: unknown;
  export const workspacePrepareGuide: unknown;
  export const repositoryOpenGuide: unknown;
  export const workspaceDoctorGuide: unknown;
  export const workspaceExploreGuide: unknown;
}

declare module '*/workspace-bootstrap.mjs' {
  export function latestWorkspaceBootstrap(options?: Record<string, unknown>): Promise<any | null>;
}

declare module '*/schema-migrations.mjs' {
  export function readRecord(family: string, rawBytes: Uint8Array | string | Record<string, unknown>): {
    readonly record: Record<string, unknown>;
    readonly storedVersion: number;
    readonly migratedThrough: ReadonlyArray<{ readonly from: number; readonly to: number }>;
  };
}

declare module '*/gateway/conversation.mjs' {
  export function planDeveloperConversation(request: string): {
    readonly route: { readonly operationId: string; readonly automatic: boolean } | null;
  };
}

/**
 * The form layer's pure half.
 *
 * `formModel` returns `FormView | null` in `form-page.ts` terms, but this file must not import from
 * the host to describe the core — so the shape is `unknown` here and narrowed at the one call site.
 * The functions with rules in them are typed properly, because those are the ones a wrong call
 * would quietly break: `readDraft` returning `{}` for a stale record and `draftRecord` dropping a
 * confirmation are the contract, not implementation details.
 */
declare module '*/gateway/form-model.mjs' {
  export function formModel(schemaId: string,
    options?: { defaults?: Readonly<Record<string, unknown>> }): unknown;
  export function checkForm(schemaId: string, values: Readonly<Record<string, unknown>>): {
    readonly valid: boolean;
    readonly problems: readonly { readonly field: string | null; readonly code: string; readonly detail: string | null }[];
  };
  export function coerceForm(schemaId: string,
    values: Readonly<Record<string, unknown>>): Record<string, string | number | boolean>;
  export function restoreDraft(schemaId: string, draft: unknown): Record<string, string | number | boolean>;
  export function readDraft(schemaId: string, record: unknown): Record<string, string | number | boolean>;
  export function draftRecord(schemaId: string, values: Readonly<Record<string, unknown>>): unknown;
  export function schemaFingerprint(schemaId: string): string | null;
  export function terminalEquivalent(command: string, values: Readonly<Record<string, unknown>>): string;
  export const DRAFT_VERSION: number;
}

/**
 * The message catalog. Typed here, owned by core — see `views/result-messages.ts` for why.
 */
declare module '*/gateway/messages.mjs' {
  export const RESULT_MESSAGES: Readonly<Record<string, { readonly label: string; readonly detail?: string }>>;
  export function fill(template: string, slots?: Readonly<Record<string, string | number>>): string;
  export function message(code: string, slots?: Readonly<Record<string, string | number>>):
    { readonly label: string; readonly detail?: string };
}
