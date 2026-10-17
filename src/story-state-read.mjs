/** Informational recorded state only. Never an execution catalog or an admission receipt. */
import { executeGitQuery } from './git-query.mjs';
import { buildRepositorySubjectIndex, resolveContext } from './repository-subject-index.mjs';
import { scopedCommandRead } from './read-scope.mjs';
import { measureCommandSpan, incrementCommandCounter } from './dx-timing-context.mjs';
import { SingularityFlowError } from './util.mjs';
import { normalizeCurrentWorkflow } from './story-state-normalization.mjs';

export async function readStoryState(root, workId = null) {
  return scopedCommandRead(`story-state:${root}:${JSON.stringify(workId)}`, () =>
    measureCommandSpan('story.record-read', async () => {
      const reference = workId ?? executeGitQuery(root, 'repository.branch');
      if (!reference) throw new SingularityFlowError('Detached HEAD is not supported.');
      const selected = resolveContext(await buildRepositorySubjectIndex(root), {
        reference, kind: 'story', required: true
      });
      incrementCommandCounter('story.record-projections');
      return normalizeCurrentWorkflow(structuredClone(selected.state));
    }), value => structuredClone(value));
}
