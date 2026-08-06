import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { exists, nowIso, writeJson, writeText } from './util.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function compositionCacheRoot(root) {
  return path.join(root, '.git', 'singularity-flow', 'composition-cache');
}

export function compositionFingerprint(inputs) {
  return sha256(JSON.stringify(stable(inputs)));
}

export async function memoizeComposition(root, inputs, text, { enabled = true } = {}) {
  // Include the rendered bytes in the cache identity. This keeps cache entries
  // content-addressed even when a caller accidentally omits a composition input.
  const promptSha256 = sha256(text);
  const key = compositionFingerprint({ inputs, promptSha256 });
  const directory = path.join(compositionCacheRoot(root), key.slice(0, 2), key);
  const bodyFile = path.join(directory, 'prompt.md');
  const metadataFile = path.join(directory, 'metadata.json');
  if (enabled && await exists(bodyFile)) {
    const cached = await readFile(bodyFile, 'utf8');
    if (sha256(cached) === promptSha256) return { key, hit: true, text: cached, path: bodyFile };
  }
  if (enabled) {
    await mkdir(directory, { recursive: true });
    await writeText(bodyFile, text);
    await writeJson(metadataFile, {
      schemaVersion: 1,
      key,
      createdAt: nowIso(),
      promptSha256,
      promptBytes: Buffer.byteLength(text),
      inputs: stable(inputs)
    });
  }
  return { key, hit: false, text, path: enabled ? bodyFile : null };
}

async function entries(directory) {
  if (!(await exists(directory))) return [];
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await entries(absolute));
    else if (entry.name === 'metadata.json') output.push(JSON.parse(await readFile(absolute, 'utf8')));
  }
  return output;
}

export async function compositionCacheStatus(root) {
  const records = await entries(compositionCacheRoot(root));
  return {
    schemaVersion: 1,
    entries: records.length,
    bytes: records.reduce((sum, record) => sum + (record.promptBytes ?? 0), 0),
    records: records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  };
}

export async function clearCompositionCache(root) {
  const status = await compositionCacheStatus(root);
  await rm(compositionCacheRoot(root), { recursive: true, force: true });
  return { removed: status.entries, bytes: status.bytes };
}
