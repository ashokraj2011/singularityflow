/** Historical audits judge expiring exceptions at the authenticated workflow's closing moment. */
import { nowIso } from './util.mjs';

export function terminalTransitionAt(workflow) {
  if (workflow?.status !== 'closed') return nowIso();
  const settled = (workflow.phaseOrder ?? []).map(id => workflow.phases?.[id])
    .flatMap(phase => [phase?.approvedAt, phase?.skippedAt])
    .map(value => Date.parse(value ?? '')).filter(Number.isFinite);
  return settled.length ? new Date(Math.max(...settled)).toISOString() : nowIso();
}
