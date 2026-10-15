/** Plugin-only entry: the existing hook policies, without general CLI/product initialization. */
import { createHash } from 'node:crypto';
import { copilotAgentStartPayload } from './copilot-agent-start.mjs';
import { resolveOperation } from './command-registry.mjs';
import { readCopilotMode } from './copilot-mode.mjs';
import { installFileLeaseSignalHandlers } from './file-lease.mjs';
import { installGitFactStore } from './git-fact-store.mjs';
import { resolveModelMode } from './model-mode.mjs';
import { withOperationContext } from './operation-context.mjs';

export const COPILOT_PLUGIN_HOOK_ACTIONS = Object.freeze([
  'boundary-turn', 'boundary-guard', 'boundary-after', 'boundary-end', 'agent-start'
]);

async function runAgentStart(input) {
  if (readCopilotMode().paused) return console.log('{}');
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 1024 * 1024) return console.log('{}');
      chunks.push(buffer);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return console.log('{}');
    return console.log(JSON.stringify(await copilotAgentStartPayload(payload)));
  } catch { return console.log('{}'); }
}

/** Only closed plugin actions; lifecycle commands cannot be dispatched through this entry. */
export async function runCopilotHook(action, input = process.stdin) {
  if (!COPILOT_PLUGIN_HOOK_ACTIONS.includes(action)) throw new TypeError('Unsupported Copilot plugin hook action.');
  const argv = ['hook', action];
  const operation = resolveOperation({ requestedCommand: 'hook', positionals: argv, options: {} });
  const argvSha256 = createHash('sha256').update(JSON.stringify(argv)).digest('hex');
  installGitFactStore();
  const uninstall = installFileLeaseSignalHandlers();
  try {
    return await withOperationContext({ operation, modelMode: resolveModelMode(argv), root: null,
      argvSha256, argvHash: `sha256:${argvSha256}`, command: 'hook', startedAt: new Date().toISOString() }, async () => {
      if (action === 'agent-start') return runAgentStart(input);
      // These handlers own malformed input, expiry, current permissions and fail-closed decisions.
      return (await import('./copilot-repository-boundary.mjs')).runRepositoryBoundaryHook(action, input);
    });
  } finally { uninstall(); }
}
