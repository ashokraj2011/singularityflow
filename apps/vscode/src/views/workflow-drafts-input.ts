/** Exclusive literal request bytes, outside the repository, for the CLI's bounded --input owner. */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WORKFLOW_DRAFT_INPUT_MAX_BYTES } from './workflow-drafts-model.ts';

interface RequestDependencies {
  remove?: (directory: string, options: { recursive: true; force: true; maxRetries: number; retryDelay: number }) => Promise<void>;
  cleanupWarning?: () => void;
}
export async function withWorkflowDraftInputFile<T>(
  text: string, invoke: (file: string) => Promise<T>, dependencies: RequestDependencies = {}
): Promise<T> {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > WORKFLOW_DRAFT_INPUT_MAX_BYTES
      || Buffer.from(text, 'utf8').toString('utf8') !== text) {
    throw new Error('The draft input exceeds the bounded interactive transport limit.');
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-workflow-draft-'));
  try {
    if (process.platform !== 'win32') await chmod(directory, 0o700);
    const file = path.join(directory, 'input.json');
    await writeFile(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return await invoke(file);
  } finally {
    // Do not replace a durable CAS acknowledgement with a cleanup failure and invite another
    // mutation. The caller separately reports cleanup trouble, without disclosing private bytes.
    try { await (dependencies.remove ?? rm)(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch { try { dependencies.cleanupWarning?.(); } catch { /* reporting cannot replace a durable acknowledgement */ } }
  }
}
