/**
 * Lazy runtime entry for interactive gateway cards and actions. `[DXP:P2-002]`
 *
 * Keep this as a separate bundle: importing the planner graph into `extension.cjs` makes VS Code
 * parse several megabytes before its first sidebar paint, even in a window that never opens My
 * Work or asks `@sflow` a question.
 */
export {
  gatewaySession, provideAcknowledgedAt, provideHomeLens, resetGatewaySession,
  setActiveRepositoryContext
} from './gateway-session.ts';
// Rootless Home is an interactive gateway concern too. Keeping bootstrap discovery here avoids
// parsing the workspace/configuration/model graph merely because the Navigator view activated.
export { latestWorkspaceBootstrap } from '../../../src/workspace-bootstrap.mjs';
