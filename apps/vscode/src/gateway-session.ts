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
 * ## Host-safe planners, declared explicitly
 *
 * Planners are still declared explicitly, but documentation now resolves through the shared
 * package-root boundary that esbuild replaces for CommonJS. That makes `help-explain` a real host
 * planner instead of a CLI fallback while preserving the registry-versus-map refusal for anything
 * this build genuinely does not contain.
 */
import { createActionExecutor, hostActionRefusal, receiveHostAction } from '../../../src/gateway/executor.mjs';
import { hostActionFromLink } from '../../../src/gateway/argument-schemas.mjs';
import { visibleSubjects } from '../../../src/gateway/conversation.mjs';
import {
  guideSessionScope, readGuideSession, rememberGuideSession, resetGuideSession
} from '../../../src/gateway/local-store.mjs';
import { bindingActorId, createHostGateway, pausedToolAnswer } from '../../../src/gateway/host.mjs';
import {
  astContextPlanner, astQueryPlanner, astStatusPlanner
} from '../../../src/gateway/planners/ast-intelligence.mjs';
import { developerNext } from '../../../src/gateway/planners/developer-next.mjs';
import { contextBrief } from '../../../src/gateway/planners/context-brief.mjs';
import { helpExplain } from '../../../src/gateway/planners/help-explain.mjs';
import {
  governedGoalImpactPlanner, governedGoalInspectPlanner, governedGoalNextPlanner,
  governedGoalTracePlanner
} from '../../../src/gateway/planners/governed-goal.mjs';
import { homeOverview } from '../../../src/gateway/planners/home-overview.mjs';
import { impactQuick } from '../../../src/gateway/planners/impact-quick.mjs';
import { impactWhatIf, impactWhatIfAssisted } from '../../../src/gateway/planners/impact-what-if.mjs';
import { intentTracePlanner } from '../../../src/gateway/planners/intent-trace.mjs';
import {
  problemInvestigate, problemInvestigateAssisted
} from '../../../src/gateway/planners/problem-investigate.mjs';
import { repositoryExplore } from '../../../src/gateway/planners/repository-explore.mjs';
import { reviewPacket } from '../../../src/gateway/planners/review-packet.mjs';
import { workContinue } from '../../../src/gateway/planners/work-continue.mjs';
import { workHandoff } from '../../../src/gateway/planners/work-handoff.mjs';
import { workList } from '../../../src/gateway/planners/work-list.mjs';
import { workReadiness } from '../../../src/gateway/planners/work-readiness.mjs';
import { workReturn } from '../../../src/gateway/planners/work-return.mjs';
import { workStartIntake } from '../../../src/gateway/planners/work-start-intake.mjs';
import { workspaceList } from '../../../src/gateway/planners/workspace-list.mjs';
import { watchCreatePlan, watchList, watchRevokePlan } from '../../../src/gateway/planners/watches.mjs';
import { workDraftSavePlan, workStartPlan } from '../../../src/gateway/planners/work-start.mjs';
import { workspaceSwitchPlan } from '../../../src/gateway/planners/workspace-switch.mjs';
import { reviewOpen } from '../../../src/gateway/planners/review-open.mjs';
import { gatewayMutationExecutors } from '../../../src/gateway/planners/executors.mjs';
import { comparePlanner } from '../../../src/gateway/planners/compare.mjs';
import { repositoryQuery } from '../../../src/gateway/planners/repository-query.mjs';
import { auditedKernel } from '../../../src/gateway/audit.mjs';
import {
  repositoryOpenGuide, workspaceBootstrapStatus, workspaceDoctorGuide, workspaceExploreGuide,
  workspacePrepareGuide
} from '../../../src/gateway/planners/workspace-reliability-surface.mjs';

/** What this host can answer without leaving the editor process. */
export function editorPlanners(): Map<string, unknown> {
  return new Map<string, unknown>([
    ['ast-context', astContextPlanner],
    ['ast-query', astQueryPlanner],
    ['ast-status', astStatusPlanner],
    ['developer-next', developerNext],
    ['context-brief', contextBrief],
    ['goal-inspect', governedGoalInspectPlanner],
    ['goal-impact', governedGoalImpactPlanner],
    ['goal-next', governedGoalNextPlanner],
    ['goal-trace', governedGoalTracePlanner],
    ['home-overview', homeOverview],
    ['help-explain', helpExplain],
    ['work-list', workList],
    ['work-continue', workContinue],
    // The Handoff view reads the packet through the kernel like any other read `[INT:REQ-178]`.
    ['work-handoff', workHandoff],
    ['work-readiness', workReadiness],
    ['work-return', workReturn],
    ['work-start-intake', workStartIntake],
    ['workspace-list', workspaceList],
    ['workspace-bootstrap-status', workspaceBootstrapStatus],
    ['workspace-prepare-guide', workspacePrepareGuide],
    ['repository-open-guide', repositoryOpenGuide],
    ['workspace-doctor-guide', workspaceDoctorGuide],
    ['workspace-explore-guide', workspaceExploreGuide],
    ['impact-quick', impactQuick],
    ['impact-what-if', impactWhatIf],
    ['impact-what-if-assisted', impactWhatIfAssisted],
    ['intent-trace', intentTracePlanner],
    ['problem-investigate', problemInvestigate],
    ['problem-investigate-assisted', problemInvestigateAssisted],
    ['repository-explore', repositoryExplore],
    ['review-packet', reviewPacket],
    ['review-open', reviewOpen],
    // The typed reads MCP has, so the two hosts answer the same corpus the same way `[INT:AC-016]`.
    ['compare', comparePlanner],
    ['repository-query', repositoryQuery],
    // Mutation planners: each returns the exact plan a person confirms in native UI `[INT:IFC-060]`.
    ['watch-list', watchList],
    ['watch-create', watchCreatePlan],
    ['watch-revoke', watchRevokePlan],
    ['work-start', workStartPlan],
    ['work-draft-save', workDraftSavePlan],
    ['workspace-switch', workspaceSwitchPlan]
  ]);
}

/**
 * The editor's route to the `start` operation: its own CLI client, supplied by the extension host.
 * Absent until activation provides it, and `work.start` plans are then shown but not carried out.
 */
type StartRoute = (argv: string[], options: { cwd: string | null }) => Promise<{ status: number | null; json: unknown }>;
let startRouteProvider: StartRoute | null = null;

export function provideStartRoute(route: StartRoute): void {
  startRouteProvider = route;
  resetGatewaySession();
}

export type GatewaySession = {
  readonly root: string | null;
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
  /**
   * The host actions this editor opens, checked again on receipt. `[INT:CON-130]` `[INT:CON-131]`
   *
   * `receive` validates against the shared allowlist and typed schema and then against this build's
   * views, and names the command to run only when every check passed. Opening the view is all a
   * host action ever does; the view does its own work behind its own confirmation.
   */
  readonly hostActions: {
    receive(candidate: unknown, options?: { fallback?: { label?: string; command?: string } | null }):
      {
        accepted: true; hostAction: { id: string; arguments: Record<string, unknown> }; command: string;
        /** What the command is run with: the accepted arguments for a view that reads them, else nothing. */
        args: readonly unknown[];
      }
      | { accepted: false; reason: string; result: any };
    refuse(action: string, reason: string, fallback?: { label?: string; command?: string } | null): any;
    fromLink(query: string): unknown;
  };
  /**
   * What the conversation remembers for this person and workspace. `[INT:CON-100]` `[INT:REQ-101]`
   *
   * Never authority: the kernel never reads it. `reset` forgets it without touching this session's
   * kernel, so pending plans, the handle authority and the selected workspace all survive.
   */
  readonly guide: {
    read(): Promise<any | null>;
    rememberResult(result: any): Promise<unknown>;
    reset(): Promise<{ cleared: boolean }>;
  };
  /**
   * A language-model tool call while SFlow guidance is paused, answered before the kernel, a binding
   * or Git: the same check `gateway serve` makes (host.mjs). Null when not paused. The editor's own
   * screens never call it; pause turns off Copilot guidance, not this window.
   */
  readonly pausedToolAnswer: (tool: string) => any | null;
  /**
   * Investigation reports this session's kernel produced, by `data.investigationId`. `[INT:IFC-061]`
   *
   * An investigation is a read and stores nothing `[INT:CON-090]`, so the Investigation view can
   * show a report only while the window that received it keeps it. Kept in memory, bounded, and
   * gone with the session: a link from anywhere else finds nothing and says so.
   */
  readonly investigations: {
    get(investigationId: string): RetainedInvestigation | null;
    list(): readonly RetainedInvestigation[];
  };
};

/** One kept investigation result, exactly as the kernel returned it. */
export type RetainedInvestigation = Readonly<{ investigationId: string; receivedAt: string; result: any }>;

const MAX_RETAINED_INVESTIGATIONS = 16;
// The reads that name their report. A bisection runs only where the CLI-side gateway carries it out.
const INVESTIGATION_OPERATIONS = new Set(['problem.investigate', 'problem.investigate.assisted']);

/**
 * The same kernel, keeping each investigation result it returns. Every other answer passes through
 * untouched; nothing it keeps is ever read back by the kernel.
 */
function retainingInvestigations(kernel: any, kept: Map<string, RetainedInvestigation>): any {
  const keep = (result: any): any => {
    const id = result?.data?.investigationId;
    if (typeof id === 'string' && INVESTIGATION_OPERATIONS.has(result?.operation?.id) && result.kind !== 'refusal') {
      kept.delete(id);
      kept.set(id, Object.freeze({ investigationId: id, receivedAt: new Date().toISOString(), result }));
      while (kept.size > MAX_RETAINED_INVESTIGATIONS) kept.delete(kept.keys().next().value as string);
    }
    return result;
  };
  return Object.freeze({
    ...kernel,
    resolve: async (...args: unknown[]) => keep(await kernel.resolve(...args)),
    read: async (...args: unknown[]) => keep(await kernel.read(...args)),
    run: async (...args: unknown[]) => keep(await kernel.run(...args))
  });
}

/**
 * The trusted view each allowlisted host action opens in this build. `[INT:IFC-061]` `[INT:IFC-060]`
 *
 * Every allowlisted ID is listed, so a gap is a stated `null` rather than an omission: an action
 * with no view here is refused on receipt as not available in this build, with its terminal
 * fallback, never ignored. Only the ones with a view are declared to the kernel as this host's
 * capability `[INT:IFC-063]`, so a result for this editor does not offer a button that cannot open.
 */
export const EDITOR_HOST_ACTION_COMMANDS: Readonly<Record<string, string | null>> = Object.freeze({
  // Opens the Workspaces page; switching is that page's own confirmed act, never this link's.
  'vscode.selectWorkspace': 'singularityFlow.openWorkspaces',
  // Opens "Use an Existing Clone as a Workspace", which asks for the clone and confirms itself.
  'vscode.attachRepository': 'singularityFlow.adoptWorkspace',
  'vscode.openArtifact': 'singularityFlow.openPhaseArtifacts',
  // The decision is made in the Approvals page from records, never from this link's arguments.
  'vscode.openReviewCeremony': 'singularityFlow.openApprovals',
  'vscode.openJourney': 'singularityFlow.openJourney',
  'vscode.openImpact': 'singularityFlow.openImpact',
  // These four read their records from the arguments they are given, and do nothing else.
  'vscode.openInvestigation': 'singularityFlow.openInvestigation',
  'vscode.openContextReceipt': 'singularityFlow.openContextReceipt',
  'vscode.openHandoff': 'singularityFlow.openHandoff',
  'vscode.openProgress': 'singularityFlow.openProgress',
  // Focus only: no prompt is prefilled and nothing is sent.
  'vscode.focusCopilot': 'workbench.action.chat.open'
});

const EDITOR_HOST_ACTIONS = Object.freeze(Object.keys(EDITOR_HOST_ACTION_COMMANDS)
  .filter((id) => EDITOR_HOST_ACTION_COMMANDS[id]));

/**
 * The views that read the arguments a host action names. `[INT:CON-131]`
 *
 * Their command is run with exactly the arguments the schema accepted, one frozen object, and
 * re-checks them itself. Every other view opens as it does from the menu, with nothing, so a
 * command that already takes an argument of its own (Workspaces' upgrade options, the chat's query)
 * is never handed one it did not ask for.
 */
export const EDITOR_HOST_ACTIONS_WITH_ARGUMENTS: ReadonlySet<string> = new Set([
  'vscode.openInvestigation', 'vscode.openContextReceipt', 'vscode.openHandoff', 'vscode.openProgress'
]);

let session: GatewaySession | null = null;
let sessionRoot: string | null = null;
let sessionWorkspaceId: string | null = null;
let sessionWorkspaceName: string | null = null;
let sessionRepositoryId: string | null = null;
let sessionLeadRepositoryPath: string | null = null;
let sessionBootstrapId: string | null = null;

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
  readonly leadRepositoryPath?: string | null;
  readonly origin: string;
};

/** A rootless Home is a real gateway context, but it has no repository bytes to bind. */
export type GatewayRepositoryContext = {
  readonly root: string | null;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  readonly repositoryId: string | null;
  readonly leadRepositoryPath?: string | null;
  readonly origin: string;
  readonly bootstrap?: any;
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
let homeLensProvider: () => string = () => 'developer';
let chatProfileNameProvider: () => string | undefined = () => undefined;

export function provideAcknowledgedAt(provider: () => string | null): void {
  acknowledgedAtProvider = provider;
  // The session captured the previous provider in its context thunk; drop it so the next call
  // rebuilds against this one rather than answering with the value from before activation.
  resetGatewaySession();
}

/** Presentation lens only; governed authority continues to come from pinned workflow records. */
export function provideHomeLens(provider: () => string): void {
  homeLensProvider = provider;
}

export function provideChatProfileName(provider: () => string): void {
  chatProfileNameProvider = provider;
}

export function gatewaySession(context: GatewayRepositoryContext): GatewaySession {
  const { root, workspaceId, workspaceName, repositoryId, leadRepositoryPath = root, bootstrap = null } = context;
  const bootstrapId = bootstrap?.bootstrapId ?? null;
  if (session && sessionRoot === root && sessionWorkspaceId === workspaceId
    && sessionWorkspaceName === workspaceName && sessionRepositoryId === repositoryId
    && sessionLeadRepositoryPath === leadRepositoryPath
    && sessionBootstrapId === bootstrapId) return session;
  // One entry per person and workspace; the actor is the one the handle binding names, without
  // fingerprinting the worktree just to learn who that is.
  const guideOwner = () => ({ actorId: bindingActorId(root), scope: guideSessionScope({ workspaceId, root }) });
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
      lens: homeLensProvider(),
      replyProfileName: chatProfileNameProvider(),
      // Null without a workspace: the host then names the checkout, never by its path.
      repositoryId,
      leadRepositoryPath,
      bootstrap,
      ...(workspaceId ? {
        workspace: { id: workspaceId, name: workspaceName ?? workspaceId },
        workspaceName: workspaceName ?? workspaceId
      } : {})
    }),
    /**
     * Mutations are carried out here only after a receipt redeems, and the receipt only exists once a
     * person confirms in native UI the extension draws `[INT:CON-111]`. The executors are the acts;
     * the planners above only plan them.
     */
    readOnly: false,
    hostCapabilities: { confirmationChannel: 'native', hostActions: EDITOR_HOST_ACTIONS },
    mutationExecutors: gatewayMutationExecutors({ runStart: startRouteProvider })
  });
  const investigations = new Map<string, RetainedInvestigation>();
  // One kernel for every caller, so a report read from a card, a tool or a form is the one kept.
  const kernel = retainingInvestigations(host.kernel, investigations);
  session = {
    root: host.root,
    // Every call is recorded for the Logs view, without what anyone typed `[INT:IFC-070]`.
    kernel: auditedKernel(kernel, { host: 'vscode', modelSelected: false }),
    /** `host.mjs` is untyped JavaScript; the shape asserted here is `hostBinding`'s return. */
    binding: host.binding as GatewaySession['binding'],
    executor: createActionExecutor({ gateway: { ...host, kernel } }),
    hostActions: {
      receive(candidate, { fallback = null } = {}) {
        const received = receiveHostAction(candidate, { available: EDITOR_HOST_ACTIONS, fallback });
        if (!received.accepted) return received;
        const { id, arguments: accepted } = received.hostAction;
        return {
          ...received,
          command: EDITOR_HOST_ACTION_COMMANDS[id] as string,
          args: EDITOR_HOST_ACTIONS_WITH_ARGUMENTS.has(id) ? Object.freeze([Object.freeze({ ...accepted })]) : Object.freeze([])
        };
      },
      refuse: (action, reason, fallback = null) => hostActionRefusal({ action, reason }, { fallback }),
      fromLink: (query) => hostActionFromLink(query)
    },
    guide: {
      read: async () => readGuideSession(guideOwner()),
      rememberResult: async (result) => rememberGuideSession(guideOwner(), {
        presentationWorkspaceId: workspaceId,
        subject: result?.subject?.id ? { kind: result.subject.kind, id: result.subject.id } : null,
        visibleSubjects: visibleSubjects(result),
        pending: ['candidates', 'clarification'].includes(result?.kind)
          ? { kind: result.kind, handle: result.next?.[0]?.handle ?? null } : null,
        // The store keeps read and selection handles only; a plan handle stays in the kernel.
        lastResultHandles: (result?.next ?? []).map((action: { handle?: string }) => action.handle),
        lastMenu: (result?.next ?? []).map((action: { id?: string }) => action.id)
      }),
      reset: async () => resetGuideSession(guideOwner())
    },
    pausedToolAnswer: (tool) => pausedToolAnswer(tool),
    investigations: {
      get: (investigationId) => investigations.get(investigationId) ?? null,
      list: () => Object.freeze([...investigations.values()].reverse())
    }
  };
  sessionRoot = root;
  sessionWorkspaceId = workspaceId;
  sessionWorkspaceName = workspaceName;
  sessionRepositoryId = repositoryId;
  sessionLeadRepositoryPath = leadRepositoryPath;
  sessionBootstrapId = bootstrapId;
  return session;
}

/** Replace the editor's resolved routing context and retire handles from the previous one. */
export function setActiveRepositoryContext(next: ActiveRepositoryContext | null): void {
  const changed = activeContext?.root !== next?.root
    || activeContext?.workspaceId !== next?.workspaceId
    || activeContext?.workspaceName !== next?.workspaceName
    || activeContext?.repositoryId !== next?.repositoryId
    || activeContext?.leadRepositoryPath !== next?.leadRepositoryPath;
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
  sessionLeadRepositoryPath = null;
  sessionBootstrapId = null;
}
