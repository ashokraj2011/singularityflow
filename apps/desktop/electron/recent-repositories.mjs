import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicPrivateJson, withLocalStoreMutation } from './local-store.mjs';

export const MAX_RECENT_REPOSITORIES = 10;

function normalize(entry) {
  if (!entry || typeof entry.path !== 'string' || !entry.path.trim()) return null;
  const repositoryPath = path.resolve(entry.path);
  const openedAt = Number.isFinite(Date.parse(entry.openedAt)) ? new Date(entry.openedAt).toISOString() : new Date(0).toISOString();
  return {
    path: repositoryPath,
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : path.basename(repositoryPath),
    branch: typeof entry.branch === 'string' && entry.branch.trim() ? entry.branch.trim() : null,
    openedAt
  };
}

async function writeStore(file, repositories) {
  await atomicPrivateJson(file, { schemaVersion: 1, repositories });
}

export async function readRecentRepositories(file) {
  let parsed;
  try { parsed = JSON.parse(await readFile(file, 'utf8')); } catch { return []; }
  const values = Array.isArray(parsed) ? parsed : parsed?.repositories;
  if (!Array.isArray(values)) return [];
  const unique = new Map();
  for (const value of values) {
    const entry = normalize(value);
    if (!entry) continue;
    const existing = unique.get(entry.path);
    if (!existing || entry.openedAt > existing.openedAt) unique.set(entry.path, entry);
  }
  return [...unique.values()].sort((left, right) => right.openedAt.localeCompare(left.openedAt)).slice(0, MAX_RECENT_REPOSITORIES);
}

export async function rememberRecentRepository(file, repository) {
  const entry = normalize({ ...repository, openedAt: repository.openedAt ?? new Date().toISOString() });
  if (!entry) throw new Error('A repository path is required.');
  return withLocalStoreMutation(file, async () => {
    const current = await readRecentRepositories(file);
    const repositories = [entry, ...current.filter((item) => item.path !== entry.path)].slice(0, MAX_RECENT_REPOSITORIES);
    await writeStore(file, repositories);
    return repositories;
  });
}

export async function forgetRecentRepository(file, repositoryPath) {
  const resolved = path.resolve(repositoryPath || '');
  return withLocalStoreMutation(file, async () => {
    const repositories = (await readRecentRepositories(file)).filter((item) => item.path !== resolved);
    await writeStore(file, repositories);
    return repositories;
  });
}
