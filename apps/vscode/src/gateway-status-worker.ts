/**
 * Status-bar gateway reads, outside the extension event loop. `[DXP:P0-003]`
 *
 * Home and readiness are real gateway reads: they bind the current Git identity, HEAD, branch,
 * index, visible worktree bytes, lifecycle records, pending publications and approval authority.
 * That exactness is required for cards and actions, but running the same synchronous Git plumbing
 * in VS Code's extension host paused every confirmed refresh for 120–155 ms.
 *
 * This worker keeps the authoritative gateway implementation and moves only its computation. It
 * returns three inert presentation facts; no handle or executable action crosses the boundary.
 */
import {
  gatewaySession, provideHomeLens, type GatewayRepositoryContext
} from './gateway-session.ts';
import { gateSummary } from './views/result-card-model.ts';
import { primaryAction } from '../../../src/gateway/result.mjs';

type Request = {
  readonly id: number;
  readonly route: GatewayRepositoryContext;
  readonly workId: string | null;
  readonly lens: string;
};

type Chrome = {
  readonly gates: ReturnType<typeof gateSummary>;
  readonly recoveryWorkId: string | null;
  readonly decisions: number;
  readonly leads: string | null;
};

async function readOperation(kernel: any, utterance: string, arguments_: Record<string, unknown> = {}) {
  const resolution = await kernel.resolve({ utterance, arguments: arguments_ });
  return resolution.kind === 'read' && resolution.next.length === 1
    ? kernel.read({ resolutionId: resolution.next[0].handle })
    : null;
}

async function statusChrome(request: Request): Promise<Chrome> {
  provideHomeLens(() => request.lens);
  const { kernel } = gatewaySession(request.route);
  const home = await readOperation(kernel, 'home');
  const readiness = request.workId
    ? await readOperation(kernel, 'am I ready', { workId: request.workId })
    : null;
  const recovery = (home?.why ?? []).find(
    (entry: { code?: string }) => entry.code === 'home.recovery-required'
  );
  return {
    gates: readiness ? gateSummary(readiness) : null,
    recoveryWorkId: recovery?.slots?.work ?? null,
    decisions: Number(home?.data?.needsYourDecision ?? 0),
    leads: home ? primaryAction(home)?.label ?? null : null
  };
}

if (typeof process.send !== 'function') {
  throw new Error('The gateway status worker requires a private IPC channel.');
}

process.on('message', async (request: Request) => {
  try {
    process.send?.({ id: request.id, value: await statusChrome(request) });
  } catch {
    // Chrome enrichment is optional. The base status line is already rendered from the confirmed
    // snapshot, and an unavailable enrichment must never turn it into an error or leak a path.
    process.send?.({ id: request.id, value: null });
  }
});

// A crashed or closing host severs IPC. Never leave a detached helper behind on the laptop.
process.on('disconnect', () => process.exit(0));
