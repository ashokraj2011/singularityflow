/**
 * The one session-opening read (SPEC-OSA v1.1 §10, implementation plan section 6 item 7): what `/sf-session` (`session open`
 * and `session takeover`) and `/sf-resume` report once a Story's checkout is open, after each has made its own selection
 * with its own arguments. The binding, the brief and the next steps, every next step taken from the kernel's decision
 * through next steps [OSA:REQ-020]: the shared read where it applies (session-read-service.mjs), otherwise each read as its
 * own command. A read that fails leaves its part null and keeps its step result, so the caller decides whether it stops.
 */
import { step } from './cli-steps.mjs';

export async function openedSessionReads(root, workId) {
  const projection = process.env.SINGULARITY_FLOW_SESSION_READS === 'legacy' ? null
    : await (await import('./session-read-service.mjs')).readOpenedSession(root, { workId });
  if (projection) return { ...projection, steps: null };
  const status = await step(['session', 'status', '--json'], root);
  const context = await step(['session', 'context', '--work-id', workId, '--slice', 'brief', '--max-output-bytes', '32768', '--json'], root);
  const next = await step(['nextsteps', workId, '--json'], root);
  return { session: status.ok ? status.value : null, context: context.ok ? context.value : null, nextsteps: next.ok ? next.value : null,
    executionContext: null, steps: { status, context, next } };
}

/** Whether an opened session is bound to exactly this Story and agent (`null` for a closed Story). */
export const sessionBound = (session, workId, agent) => session?.ready === true && session.workId === workId
  && (session.activeAgent ?? null) === (agent ?? null);
