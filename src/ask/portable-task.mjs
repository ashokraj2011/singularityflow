import { conversationStore } from './conversation-store.mjs';
import { readEvidence } from './evidence.mjs';

export async function attachSharedTask(store, conversation, task) {
  if (task.status !== 'accepted' || conversation.taskPublication || conversation.taskAdmissionId !== task.id) return conversation;
  const taskPublication = await store.sources.taskPublication(task);
  return taskPublication ? store.update(conversation.id, conversation.revision, { taskPublication }) : conversation;
}

export async function syncSharedTask(root, task) {
  const id = task.request.origin.conversationId;
  if (!id.startsWith('askp-') || task.status !== 'accepted') return {};
  try {
    const store = await conversationStore({ root, context: {}, audience: 'person', portable: true });
    const current = await store.read(id);
    const saved = await attachSharedTask(store, current, task);
    return { conversation: { id, revision: saved.revision }, sharedTask: saved.taskPublication ? 'published' : 'local-only' };
  } catch {
    // The execution receipt and Story keep their own authority after a provider failure.
    return { sharedTask: 'local-only' };
  }
}

export async function sharedTaskStatus(root, sources, link) {
  const { currentWork } = await sources.verify(link);
  await readEvidence(root, link, { audience: 'person', detail: false });
  return { status: 'accepted', workId: currentWork.id, workStatus: currentWork.workStatus, phase: currentWork.phase };
}
