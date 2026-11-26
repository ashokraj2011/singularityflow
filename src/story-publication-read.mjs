/** Story pending-publication lookup with the canonical recovery/integrity owner. */
import path from 'node:path';
import { hasPendingPublication } from './publication-pending.mjs';
import { storyLocation } from './story-paths.mjs';

export async function storyPublicationPending(root, config, id, { migrate = true } = {}) {
  return hasPendingPublication(root, {
    kind: 'story', id,
    legacyPath: storyLocation(root, config, id).file('publication-pending.json'),
    roots: { workItemRoot: config?.workItemRoot }, migrate
  });
}
