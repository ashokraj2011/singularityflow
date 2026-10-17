/** Pure session shape, shared by executable definitions and recorded state hydration. */
import { SingularityFlowError } from './util.mjs';
export function normalizeSessionPolicy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SingularityFlowError('session must be an object.');
  for (const key of Object.keys(value)) if (!['workItemSelection', 'requireBeforeTools'].includes(key)) throw new SingularityFlowError(`session contains unknown field '${key}'.`);
  const workItemSelection = value.workItemSelection ?? 'off';
  if (!['off', 'reuse', 'prompt'].includes(workItemSelection)) throw new SingularityFlowError('session.workItemSelection must be off, reuse, or prompt.');
  if (value.requireBeforeTools != null && typeof value.requireBeforeTools !== 'boolean') throw new SingularityFlowError('session.requireBeforeTools must be boolean.');
  return {
    workItemSelection,
    requireBeforeTools: value.requireBeforeTools ?? false
  };
}
