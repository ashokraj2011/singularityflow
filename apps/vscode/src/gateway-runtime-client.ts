/**
 * Lazy facade over `gateway-runtime.cjs`. `[DXP:P2-002]`
 *
 * This module is bundled into several entries. It therefore delegates state to the small explicit
 * `gateway-context-runtime.cjs` entry: every surface sees one repository selection without loading
 * the much larger planner runtime during activation.
 */
import path from 'node:path';

import type { ActiveRepositoryContext, GatewayRepositoryContext, GatewaySession } from './gateway-session.ts';

type ContextRuntime = typeof import('./gateway-context-runtime.ts');

let shared: ContextRuntime | null = null;

function sharedRuntime(): ContextRuntime {
  // A computed absolute path is deliberate: esbuild must leave this require outside every caller
  // bundle. Node's module cache then makes this small entry the process-wide routing authority.
  return shared ??= require(path.join(__dirname, 'gateway-context-runtime.cjs')) as ContextRuntime;
}

export function gatewaySession(context: GatewayRepositoryContext): GatewaySession {
  return sharedRuntime().gatewaySession(context);
}

export function provideAcknowledgedAt(provider: () => string | null): void {
  sharedRuntime().provideAcknowledgedAt(provider);
}

export function provideHomeLens(provider: () => string): void {
  sharedRuntime().provideHomeLens(provider);
}

export function setActiveRepositoryContext(next: ActiveRepositoryContext | null): void {
  sharedRuntime().setActiveRepositoryContext(next);
}

export function activeRepositoryContext(): ActiveRepositoryContext | null {
  return sharedRuntime().activeRepositoryContext();
}

export function resetGatewaySession(): void {
  sharedRuntime().resetGatewaySession();
}

export function latestWorkspaceBootstrap(): ReturnType<ContextRuntime['latestWorkspaceBootstrap']> {
  return sharedRuntime().latestWorkspaceBootstrap();
}

export type { ActiveRepositoryContext, GatewayRepositoryContext, GatewaySession };
