/** Private, read-only visual comparisons. No file, command or shared-store side effects. */
import { randomUUID } from 'node:crypto';

export const WORKFLOW_DRAFT_COMPARISON_SCHEME = 'singularity-flow-workflow-draft-compare';

export interface WorkflowDraftComparison {
  draftId: string;
  checkpointName: string;
  checkpointText: string;
  sharedName: string;
  sharedText: string;
  checkpointId: string;
  baseRevision: number;
  currentRevision: number;
}

/** Contents live only while their virtual documents are open; opaque URIs reveal no text/path. */
export class WorkflowDraftComparisonBuffers {
  private readonly documents = new Map<string, string>();
  add(value: WorkflowDraftComparison): { left: string; right: string; title: string } {
    if (!/^WFD-[A-Z0-9]{6,32}$/u.test(value.draftId)
        || !/^[a-f0-9-]{36}$/u.test(value.checkpointId)
        || ![value.baseRevision, value.currentRevision].every((revision) => Number.isSafeInteger(revision) && revision >= 1)
        || ![value.checkpointName, value.sharedName].every((name) => typeof name === 'string'
          && Buffer.byteLength(name, 'utf8') <= 512 && !/[\0\r\n]/u.test(name))
        || ![value.checkpointText, value.sharedText].every((text) => typeof text === 'string'
          && Buffer.byteLength(text, 'utf8') <= 5 * 1024 * 1024)) {
      throw new Error('The private comparison exceeds its bounded literal-text contract. No document was opened.');
    }
    if (this.documents.size > 6) throw new Error('Close an earlier private comparison before opening another. Its contents have not been discarded.');
    const id = randomUUID();
    const left = `${WORKFLOW_DRAFT_COMPARISON_SCHEME}:/${id}/private.txt`;
    const right = `${WORKFLOW_DRAFT_COMPARISON_SCHEME}:/${id}/shared.txt`;
    this.documents.set(left, `Display name: ${value.checkpointName}\n\n${value.checkpointText}`);
    this.documents.set(right, `Display name: ${value.sharedName}\n\n${value.sharedText}`);
    return { left, right, title: `${value.draftId} · private checkpoint (base ${value.baseRevision}) ↔ shared revision ${value.currentRevision}` };
  }
  content(uri: string): string | undefined { return this.documents.get(uri); }
  release(uri: string): void { this.documents.delete(uri); }
  clear(): void { this.documents.clear(); }
}
