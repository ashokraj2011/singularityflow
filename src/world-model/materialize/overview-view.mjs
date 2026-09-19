import { normalizeWmpOverviewViewReference } from '../registry/views.mjs';
import {
  renderPersistedOverviewViewV1
} from './persisted-overview-renderer-v1.mjs';

export * from './persisted-overview-renderer-v1.mjs';

/**
 * Active compatibility surface for callers that select a view by alias or reference.
 *
 * Historical replay bypasses this adapter and supplies the exact retained View Contract to the
 * immutable v1 renderer. A future registry or active-writer change therefore cannot alter v1.
 */
export function renderPersistedOverviewView({ view, viewContract = null, ...input } = {}) {
  const contract = viewContract ?? normalizeWmpOverviewViewReference(view).contract;
  return renderPersistedOverviewViewV1({ ...input, viewContract: contract });
}
