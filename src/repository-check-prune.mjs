/** Deferred maintenance of bounded, owner-checked private acceleration slots. */
import { lstatSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

export async function pruneProvenanceSlots(directory, prefix, current, owned) {
  const candidates = [];
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/u.test(name.slice(prefix.length))) continue;
    const file = path.join(directory, name);
    try {
      const info = lstatSync(file);
      if (info.isFile() && owned(info) && info.nlink === 1) candidates.push({ file, modified: info.mtimeMs });
    } catch { /* Another request can retire a cache slot concurrently. */ }
  }
  candidates.sort((a, b) => Number(b.file === current) - Number(a.file === current) || b.modified - a.modified);
  for (const entry of candidates.slice(4)) await unlink(entry.file).catch(() => {});
}
