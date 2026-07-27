import { resolve } from 'node:path'

import {
  activateWorkspace,
  eventHorizonStatus,
  openEventHorizonWindow as openUpstreamWindow,
  registerEventHorizonHandlers,
  registerProvider,
  setHostContext,
  startStandalone,
  type EventHorizonStatus
} from 'event-horizon/core'
import { singularityFlowProvider } from 'event-horizon/providers/singularity-flow'

import { isFlowWorkspaceContext, type FlowWorkspaceContext } from '@flow/flowContext'

/**
 * Singularity Flow's host for Event Horizon.
 *
 * Everything below is integration: it supplies Flow's workspace context and
 * workflow provider to an unmodified upstream tool. Upstream lives in a pinned
 * submodule at vendor/event-horizon and is never patched here — when it gains a
 * feature, the submodule pointer moves and this file is usually untouched.
 *
 * Historically this file *was* upstream's, edited in place, which made the copy
 * a fork that drifted three commits behind within a day. The extension points
 * it needed — an in-process window API, a host-context channel, and UI slots —
 * now exist upstream, so the fork is no longer necessary.
 */

let providerRegistered = false

function ensureProvider(): void {
  if (providerRegistered) return
  providerRegistered = true
  try {
    registerProvider(singularityFlowProvider())
  } catch {
    // Already registered via EVENT_HORIZON_PROVIDERS — not an error.
  }
}

export interface OpenEventHorizonOptions {
  cwd?: string
  /** Flow's projection of the current workspace, validated before use. */
  flowContext?: FlowWorkspaceContext | null
}

/**
 * Publishes Flow's workspace context for a directory.
 *
 * Validation lives here rather than upstream because the contract is Flow's.
 * Upstream stores the value opaquely and hands it back to our UI slot, which is
 * the only code that knows its shape — so core never has to learn it.
 */
export function setFlowContext(cwd: string, context?: FlowWorkspaceContext | null): void {
  if (context != null && !isFlowWorkspaceContext(context)) {
    throw new Error('Flow supplied an invalid Event Horizon context.')
  }
  setHostContext(resolve(cwd), context ?? null)
}

/**
 * Opens (or focuses) the Event Horizon surface for a repository.
 *
 * Reopening the same repository reuses its session rather than starting a
 * second agent on it — upstream's activateWorkspace decides that, keyed on the
 * resolved path.
 */
export function openEventHorizonWindow(options: OpenEventHorizonOptions = {}): void {
  ensureProvider()
  if (options.cwd) setFlowContext(options.cwd, options.flowContext)
  openUpstreamWindow({ cwd: options.cwd })
}

/**
 * Activates a repository's session without necessarily surfacing the window —
 * used when Flow switches the active repository while the workbench is already
 * open.
 */
export async function activateFlowWorkspace(
  cwd: string,
  flowContext?: FlowWorkspaceContext | null
): Promise<void> {
  ensureProvider()
  setFlowContext(cwd, flowContext)
  await activateWorkspace(cwd)
}

export { registerEventHorizonHandlers, eventHorizonStatus }
export type { EventHorizonStatus, FlowWorkspaceContext }

// Standalone launch only. Skipped when Flow embeds this module in its own
// process, so importing it attaches nothing and starts nothing.
if (!process.env.EVENT_HORIZON_EMBEDDED && !process.env.SINGULARITY_FLOW_EMBED_EVENT_HORIZON) {
  ensureProvider()
  void startStandalone()
}
