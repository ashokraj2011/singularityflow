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

/**
 * Repository-level warm records live beside the Story-start ones, under keys no Work ID can take:
 * `@repository` for a whole repository's application code, `@repository:<path>` for one folder or
 * file of a repository too large to index whole. The same worker runs both.
 */
export const REPOSITORY_AST_WARM_KEY = '@repository';

export function repositoryAstWarmKey(scope = null) {
  return scope ? `${REPOSITORY_AST_WARM_KEY}:${scope}` : REPOSITORY_AST_WARM_KEY;
}

function isRepositoryWarmKey(workId) {
  return String(workId ?? '').startsWith(REPOSITORY_AST_WARM_KEY);
}

/** The repository warm record for `scope`, or null when there is none or it cannot be read. */
export async function readRepositoryAstWarmStatus(root, scope = null) {
  try {
    return await readStoryStartAstWarmStatus(root, repositoryAstWarmKey(scope));
  } catch {
    // A damaged disposable status record does not make AST or repository access unavailable.
    return null;
  }
}

export async function writeRepositoryAstWarmStatus(root, scope, record) {
  return writeStoryStartAstWarmStatus(root, { ...record, workId: repositoryAstWarmKey(scope) });
}

export async function latestStoryStartAstWarmStatus(root) {
  const records = [];
  for (const entry of await readdir(statusDirectory(root), { withFileTypes: true })
    .catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const { record } = readRecord('ast-story-start-warm', await readFile(path.join(statusDirectory(root), entry.name)));
      if (!isRepositoryWarmKey(record?.workId)) records.push(record);
    } catch {
      // A damaged disposable status record does not make AST or repository access unavailable.
    }
  }
  return records.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0] ?? null;
}
