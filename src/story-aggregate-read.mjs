/** The Story store's exact read semantics without importing publication and ledger writers. */
import { loadWorkflow, loadWorkflowWithExecution } from './story-workflow-read.mjs';
import { workflowPath } from './story-paths.mjs';
import { revision, attachRevision } from './state-revision-read.mjs';

export async function loadStoryAggregate(root, definition, id) {
  return withRevision(root, definition, await loadWorkflow(root, definition, id));
}

/** Preserve the same revision metadata without dropping this strict load's verified catalog. */
export async function loadStoryAggregateWithExecution(root, definition, id) {
  const loaded = await loadWorkflowWithExecution(root, definition, id);
  withRevision(root, definition, loaded.workflow);
  return loaded;
}

function withRevision(root, definition, workflow) {
  return attachRevision(workflow, revision(root, workflow,
    workflowPath(root, definition, workflow.workItem?.id)));
}
