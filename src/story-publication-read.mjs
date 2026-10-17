/** Story pending-publication lookup with the canonical recovery/integrity owner. */
import path from 'node:path';
import { workDir } from './story-paths.mjs';
import { hasPendingPublication } from './publication-pending.mjs';

export async function storyPublicationPending(root, config, id, { migrate = true } = {}) {
  return hasPendingPublication(root, {
    kind: 'story', id,
    legacyPath: path.join(workDir(root, config, id), 'publication-pending.json'),
    roots: { workItemRoot: config?.workItemRoot }, migrate
  });
}
