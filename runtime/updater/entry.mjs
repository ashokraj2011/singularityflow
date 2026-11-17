import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Node canonicalizes module filenames; argv can still contain a filesystem alias such as /var. */
export async function isMainModule(url, entry = process.argv[1]) {
  if (!entry) return false;
  const file = fileURLToPath(url);
  if (path.resolve(entry) === file) return true;
  try { return await realpath(entry) === await realpath(file); }
  catch { return false; }
}
