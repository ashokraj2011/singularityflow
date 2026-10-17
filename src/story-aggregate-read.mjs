/** The Story store's exact read semantics without importing publication and ledger writers. */
import { loadWorkflow } from './story-workflow-read.mjs';
import { workflowPath } from './story-paths.mjs';
import { revision, attachRevision } from './state-revision-read.mjs';

export async function loadStoryAggregate(root, definition, id) {
  const aggregate = await loadWorkflow(root, definition, id);
  return attachRevision(aggregate, revision(root, aggregate,
    workflowPath(root, definition, aggregate.workItem?.id)));
}
