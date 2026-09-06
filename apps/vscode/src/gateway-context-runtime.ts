/**
 * Process-wide lightweight state shared by every explicit VS Code bundle. `[DXP:P2-002]`
 *
 * esbuild gives the activation entry and each lazy entry its own copy of ordinary modules. This
 * tiny external entry is therefore the authority for repository routing and providers. Merely
 * loading a lazy panel must never replace the repository selected by the activation bundle.
 */
import path from 'node:path';

import type {
  ActiveRepositoryContext, GatewayRepositoryContext, GatewaySession
} from './gateway-session.ts';

type Runtime = typeof import('./gateway-runtime.ts');

let runtime: Runtime | null = null;
let activeContext: ActiveRepositoryContext | null = null;
let acknowledgedAtProvider: () => string | null = () => null;
let homeLensProvider: () => string = () => 'developer';

function loadRuntime(): Runtime {
  if (runtime) return runtime;
  const loaded = require(path.join(__dirname, 'gateway-runtime.cjs')) as Runtime;
  loaded.provideAcknowledgedAt(acknowledgedAtProvider);
  loaded.provideHomeLens(homeLensProvider);
  loaded.setActiveRepositoryContext(activeContext);
  runtime = loaded;
  return loaded;
}

export function gatewaySession(context: GatewayRepositoryContext): GatewaySession {
  return loadRuntime().gatewaySession(context);
}

export function provideAcknowledgedAt(provider: () => string | null): void {
  acknowledgedAtProvider = provider;
  runtime?.provideAcknowledgedAt(provider);
}

export function provideHomeLens(provider: () => string): void {
  homeLensProvider = provider;
  runtime?.provideHomeLens(provider);
}

export function setActiveRepositoryContext(next: ActiveRepositoryContext | null): void {
  activeContext = next ? Object.freeze({ ...next }) : null;
  runtime?.setActiveRepositoryContext(activeContext);
}

export function activeRepositoryContext(): ActiveRepositoryContext | null {
  return activeContext;
}

export function resetGatewaySession(): void {
  runtime?.resetGatewaySession();
}

export function latestWorkspaceBootstrap(): ReturnType<Runtime['latestWorkspaceBootstrap']> {
  return loadRuntime().latestWorkspaceBootstrap();
}

export type { ActiveRepositoryContext, GatewayRepositoryContext, GatewaySession };
