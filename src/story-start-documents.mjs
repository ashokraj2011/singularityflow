import { addDocuments } from './documents.mjs';
import { LIFECYCLE_EVENT } from './lifecycle-event.mjs';
import { commitAndPublish } from './state-stores.mjs';

/**
 * Publish every document supplied at Story birth in one governed transaction.
 *
 * Each input retains its own label/kind semantics, but the manifest and lifecycle event are
 * committed once. This keeps exact document IDs in the finalized event while avoiding one remote
 * push per attachment.
 */
export async function publishInitialStoryDocuments(root, config, workflow, {
  workId = workflow.workItem.id,
  inputs = [],
  operation = 'supporting-document-upload'
} = {}) {
  if (!inputs.length) return [];
  let records = [];
  await commitAndPublish(
    root,
    config,
    workflow,
    { type: LIFECYCLE_EVENT.EVIDENCE_RECORDED, payload: { operation } },
    `[${workId}][documents][upload] supporting evidence`,
    [],
    {
      beforeStateWrite: async () => {
        for (const input of inputs) {
          records.push(...await addDocuments(root, config, workflow, {
            files: input.files ?? (input.type === 'file' ? [input.path] : []),
            url: input.url ?? null,
            label: input.label ?? null,
            kind: input.kind ?? null
          }));
        }
        return records;
      },
      eventFromResult: (created) => ({
        payload: {
          operation,
          documentIds: (created ?? []).map((record) => record.id)
        }
      })
    }
  );
  return records;
}
