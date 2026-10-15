/** Shared agent-start routing. Authority, mappings and trust remain in their existing owners. */
import { existsSync } from 'node:fs';
import { readCopilotMode } from './copilot-mode.mjs';

export async function copilotAgentStartPayload(payload) {
  if (readCopilotMode().paused) return {};
  const candidate = typeof payload.cwd === 'string' && existsSync(payload.cwd) ? payload.cwd : process.cwd();
  const { resolveCopilotHookRoot } = await import('./copilot-repository-boundary.mjs');
  const root = await resolveCopilotHookRoot({ ...payload, cwd: candidate });
  if (!root) return {};
  const { sessionRepositoryAuthority } = await import('./commands/shared/session-repository-authority.mjs');
  if (!await sessionRepositoryAuthority(root)) return {};
  return (await import('./agent-hooks.mjs')).copilotAgentStartHook(root, payload);
}
