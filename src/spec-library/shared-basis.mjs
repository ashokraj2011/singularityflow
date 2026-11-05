/** Laptop-only sharing acknowledgement. It never advances or rewrites a document snapshot. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareSharedPublicationStorage, sharedPublicationStorageDirectory } from '../publication-storage.mjs';
import { writeAtomic } from '../util.mjs';
import { currentSchemaVersion, readRecord } from '../schema-migrations.mjs';
import { requireSpecId } from './ids.mjs';

const filename = specId => 'basis-' + requireSpecId(specId) + '.json';
export async function sharedBasis(root, specId) {
  const text = await readFile(path.join(sharedPublicationStorageDirectory(root, 'spec-sync'), filename(specId)), 'utf8')
    .catch(error => error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : Promise.reject(error));
  return text ? readRecord('spec-shared-basis', text).record : null;
}
export async function recordSharedBasis(root, specId, basis) {
  const directory = await prepareSharedPublicationStorage(root, 'spec-sync', 'Specification sharing state');
  await writeAtomic(path.join(directory, filename(specId)), JSON.stringify({ schemaVersion: currentSchemaVersion('spec-shared-basis'), ...basis }) + '\n', { mode: 0o600 });
}
