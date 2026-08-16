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
import { homeOverview } from './home-overview.mjs';
import { impactQuick } from './impact-quick.mjs';
import { workContinue } from './work-continue.mjs';
import { workReadiness } from './work-readiness.mjs';
import { workReturn } from './work-return.mjs';
import { workList } from './work-list.mjs';
import { workspaceList } from './workspace-list.mjs';

export function gatewayPlanners(overrides = {}) {
  return new Map(Object.entries({
    'help-explain': helpExplain,
    'home-overview': homeOverview,
    'impact-quick': impactQuick,
    'work-continue': workContinue,
    'work-readiness': workReadiness,
    'work-return': workReturn,
    'work-list': workList,
    'workspace-list': workspaceList,
    ...overrides
  }));
}

export { helpExplain, homeOverview, impactQuick, workContinue, workList, workReadiness, workReturn, workspaceList };
