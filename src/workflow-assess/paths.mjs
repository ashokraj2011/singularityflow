/** Where Copilot writes its own findings for `workflow assess --verify`: a private file of this computer, one per repository and workflow. */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { workflowBuildStateRoot } from '../workflow-build/store.mjs';

export function copilotFindingsPath(root, workflowId, { env = process.env } = {}) {
  let resolved = path.resolve(root);
  try { resolved = realpathSync.native(resolved); } catch { /* the path as given */ }
  const repository = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  return path.join(workflowBuildStateRoot(env), 'workflow-assess', repository, `${workflowId}.copilot-findings.json`);
}
