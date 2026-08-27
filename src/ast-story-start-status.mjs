import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { currentSchemaVersion, readRecord } from './schema-migrations.mjs';
import { writeJson } from './util.mjs';

const SCHEMA_VERSION = currentSchemaVersion('ast-story-start-warm');

function statusDirectory(root) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'ast', 'v2', 'story-start');
}

function statusPath(root, workId) {
  const name = createHash('sha256').update(String(workId)).digest('hex');
  return path.join(statusDirectory(root), `${name}.json`);
}

export async function writeStoryStartAstWarmStatus(root, record) {
  const next = { ...record, schemaVersion: SCHEMA_VERSION };
  await writeJson(statusPath(root, next.workId), next);
  return next;
}

export async function readStoryStartAstWarmStatus(root, workId) {
  try {
    return readRecord('ast-story-start-warm', await readFile(statusPath(root, workId))).record;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function latestStoryStartAstWarmStatus(root) {
  const records = [];
  for (const entry of await readdir(statusDirectory(root), { withFileTypes: true })
    .catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      records.push(readRecord(
        'ast-story-start-warm',
        await readFile(path.join(statusDirectory(root), entry.name))
      ).record);
    } catch {
      // A damaged disposable status record does not make AST or repository access unavailable.
    }
  }
  return records.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] ?? null;
}
