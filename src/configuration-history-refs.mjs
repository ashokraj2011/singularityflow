/** A history identity survives branch retirement through an exact lightweight archive tag. */
import { SingularityFlowError } from './util.mjs';

export function configurationHistoryRefs(commit) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit ?? '')) {
    throw new SingularityFlowError('Configuration history needs an exact commit identity.', {
      code: 'CONFIGURATION_HISTORY_ID_INVALID'
    });
  }
  const name = `sflow/config-history/${commit}`;
  return { name, branch: `refs/heads/${name}`, archive: `refs/tags/${name}` };
}

/** Both names must be direct refs to the named commit; neither may mask a collision. */
export function retainedConfigurationHistoryRef(refs, commit) {
  const history = configurationHistoryRefs(commit);
  for (const ref of [history.branch, history.archive]) {
    const actual = refs.get(ref);
    if (actual != null && actual !== commit) throw new SingularityFlowError(
      'Configuration history identity is occupied by a different object. Preserve it for review.', {
        code: 'STATE_CONFIGURATION_HISTORY_COLLISION', details: { ref, sourceCommit: commit, actualCommit: actual }
      });
  }
  return refs.has(history.branch) ? history.branch : refs.has(history.archive) ? history.archive : null;
}
