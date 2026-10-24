/**
 * The planners this build actually has.
 *
 * The registry declares which planner an operation *names*; this says which ones exist. They are
 * deliberately two lists rather than one, so the gap between "declared" and "implemented" is a
 * number the ratchet can hold down instead of a discovery someone makes in a demo.
 *
 * A planner is `({ operation, arguments, subject, registry, policy }) => sflow-result`. The kernel
 * validates whatever comes back, so a planner cannot widen the contract by returning something
 * result-shaped.
 */
import { helpExplain } from './help-explain.mjs';
import { autoFlightRead } from './auto-flight.mjs';
import {
  astContextPlanner, astEvidenceReplayPlanner, astHierarchyPlanner, astModulePlanner,
  astQueryPlanner, astReferencesPlanner, astStatusPlanner, astSymbolPlanner
} from './ast-intelligence.mjs';
import { developerNext } from './developer-next.mjs';
import { contextBrief } from './context-brief.mjs';
import {
  governedGoalImpactPlanner, governedGoalInspectPlanner, governedGoalNextPlanner,
  governedGoalTracePlanner
} from './governed-goal.mjs';
import { homeOverview } from './home-overview.mjs';
import { impactQuick, impactQuickAssisted } from './impact-quick.mjs';
import { impactWhatIf, impactWhatIfAssisted } from './impact-what-if.mjs';
import { intentTracePlanner } from './intent-trace.mjs';
import { problemInvestigate, problemInvestigateAssisted } from './problem-investigate.mjs';
import { repositoryExplore } from './repository-explore.mjs';
import { reviewPacket } from './review-packet.mjs';
import { workContinue } from './work-continue.mjs';
import { workHandoff } from './work-handoff.mjs';
import { workReadiness } from './work-readiness.mjs';
import { workReturn } from './work-return.mjs';
import { workList } from './work-list.mjs';
import { workStartIntake } from './work-start-intake.mjs';
import { workspaceList } from './workspace-list.mjs';
import {
  repositoryOpenGuide, workspaceBootstrapStatus, workspaceDoctorGuide, workspaceExploreGuide,
  workspacePrepareGuide
} from './workspace-reliability-surface.mjs';

/**
 * A planner loaded on first use. `[INT:CON-032]`
 *
 * The map is imported by every host that resolves anything, so a planner listed here statically is
 * on the startup path of the CLI's hooks and the editor whether or not anyone asks it a question.
 * Still a function, so the registry-versus-map distinction — and the ratchet — see it as present.
 */
const lazy = (load, name) => async (request) => (await load())[name](request);
const compare = () => import('./compare.mjs');
const repositoryQueries = () => import('./repository-query.mjs');
const reviews = () => import('./review-open.mjs');
const watches = () => import('./watches.mjs');
const starts = () => import('./work-start.mjs');
const workspaces = () => import('./workspace-switch.mjs');

export function gatewayPlanners(overrides = {}) {
  return new Map(Object.entries({
    'ast-context': astContextPlanner,
    'ast-evidence-replay': astEvidenceReplayPlanner,
    'ast-hierarchy': astHierarchyPlanner,
    'ast-module': astModulePlanner,
    'ast-query': astQueryPlanner,
    'ast-references': astReferencesPlanner,
    'ast-status': astStatusPlanner,
    'ast-symbol': astSymbolPlanner,
    'auto-flight-read': autoFlightRead,
    compare: lazy(compare, 'comparePlanner'),
    'help-explain': helpExplain,
    'developer-next': developerNext,
    'context-brief': contextBrief,
    'goal-inspect': governedGoalInspectPlanner,
    'goal-impact': governedGoalImpactPlanner,
    'goal-next': governedGoalNextPlanner,
    'goal-trace': governedGoalTracePlanner,
    'home-overview': homeOverview,
    'impact-quick': impactQuick,
    'impact-quick-assisted': impactQuickAssisted,
    'impact-what-if': impactWhatIf,
    'impact-what-if-assisted': impactWhatIfAssisted,
    'intent-trace': intentTracePlanner,
    'problem-investigate': problemInvestigate,
    'problem-investigate-assisted': problemInvestigateAssisted,
    'repository-explore': repositoryExplore,
    'repository-query': lazy(repositoryQueries, 'repositoryQuery'),
    'review-packet': reviewPacket,
    'review-open': lazy(reviews, 'reviewOpen'),
    'watch-list': lazy(watches, 'watchList'),
    /**
     * Mutation planners. Each is a read that returns the exact plan descriptor a person confirms;
     * the act is a separate host-supplied executor, so a read-only host can offer every plan and
     * carry out none of them `[INT:CON-110]`.
     */
    'watch-create': lazy(watches, 'watchCreatePlan'),
    'watch-revoke': lazy(watches, 'watchRevokePlan'),
    'work-start': lazy(starts, 'workStartPlan'),
    'work-draft-save': lazy(starts, 'workDraftSavePlan'),
    'workspace-switch': lazy(workspaces, 'workspaceSwitchPlan'),
    'workspace-materialize': lazy(workspaces, 'workspaceMaterializePlan'),
    'work-continue': workContinue,
    'work-handoff': workHandoff,
    'work-readiness': workReadiness,
    'work-return': workReturn,
    'work-list': workList,
    'work-start-intake': workStartIntake,
    'workspace-list': workspaceList,
    'workspace-bootstrap-status': workspaceBootstrapStatus,
    'workspace-prepare-guide': workspacePrepareGuide,
    'repository-open-guide': repositoryOpenGuide,
    'workspace-doctor-guide': workspaceDoctorGuide,
    'workspace-explore-guide': workspaceExploreGuide,
    ...overrides
  }));
}

export {
  astContextPlanner, astEvidenceReplayPlanner, astHierarchyPlanner, astModulePlanner,
  astQueryPlanner, astReferencesPlanner, astStatusPlanner, astSymbolPlanner,
  autoFlightRead, impactQuickAssisted,
  contextBrief, developerNext, governedGoalImpactPlanner, governedGoalInspectPlanner, governedGoalNextPlanner,
  governedGoalTracePlanner, helpExplain, homeOverview, impactQuick, impactWhatIf, impactWhatIfAssisted, problemInvestigate,
  intentTracePlanner, problemInvestigateAssisted, repositoryExplore, reviewPacket, workContinue, workHandoff,
  workList, workReadiness, workReturn, workStartIntake, workspaceList,
  repositoryOpenGuide, workspaceBootstrapStatus, workspaceDoctorGuide, workspaceExploreGuide,
  workspacePrepareGuide
};
