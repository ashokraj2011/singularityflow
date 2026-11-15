/**
 * A workflow's change impact as a person reads it [CIC:REQ-018; owner, 2026-11-15]: on or off, and where that comes from, the
 * default in code (on), the repository's `spec` block, or the workflow's own. The default is applied in code
 * (specifications.mjs normalizeSpecPolicy) and never written into a configuration, so a teammate on an older SFlow build still
 * loads it. Workflow Studio, the workflow builder and `workflow check` show it.
 */
import { workTypeSpecPolicy } from './specifications.mjs';

const sets = (spec) => spec?.changeImpact !== undefined || spec?.observedDependencies === 'off';

/** `repository` is the configuration's `spec` block as written, `own` the workflow's; either may be absent. */
export function changeImpactSetting(repository = {}, own = {}) {
  let value = 'on';
  try { value = workTypeSpecPolicy(repository ?? {}, own ?? {}).changeImpact; } catch { /* configuration validation reports it */ }
  const source = sets(own) ? 'workflow' : sets(repository) ? 'repository' : 'default';
  return { value, source, text: `Change impact: ${value} (${source === 'default' ? 'default' : source === 'workflow' ? 'set by this workflow' : 'set by the repository'})` };
}
