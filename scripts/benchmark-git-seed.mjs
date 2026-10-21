/** Seed only a new disposable benchmark repository, without thousands of loose-object writes.
 * Real measured clones/checkouts remain unchanged. Every generated file retains its unique bytes.
 */
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function seedBenchmarkRepository(root, git, message = 'Benchmark fixture') {
  if (git(['for-each-ref', '--count=1', '--format=%(refname)']).trim()) {
    throw new Error('Benchmark seeding requires a new repository without existing refs.');
  }
  const paths = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  if (paths.length > 25000 || /[\r\n]/u.test(message)) throw new Error('Invalid benchmark seed bounds.');
  const header = Buffer.from(`commit refs/heads/main\ncommitter Benchmark Fixture <fixture@example.invalid> ${Math.floor(Date.now() / 1000)} +0000\ndata ${Buffer.byteLength(message)}\n${message}\n`);
  const chunks = [header];
  let total = 0;
  for (const relative of paths) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error('Unsafe benchmark seed path.');
    const file = path.join(root, relative), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (total += info.size) > 32 * 1024 * 1024) {
      throw new Error('Benchmark seed requires bounded regular files.');
    }
    const bytes = await readFile(file);
    chunks.push(Buffer.from(`M ${(info.mode & 0o111) && process.platform !== 'win32' ? '100755' : '100644'} inline ${JSON.stringify(relative)}\ndata ${bytes.length}\n`), bytes, Buffer.from('\n'));
  }
  chunks.push(Buffer.from('\ndone\n'));
  git(['-c', 'fastimport.unpackLimit=0', 'fast-import', '--quiet'], { input: Buffer.concat(chunks) });
  // Files already exist with their exact fixture bytes. Populate only the index, not another
  // checkout or arbitrary reset; the guard above refuses any pre-existing repository history.
  git(['read-tree', 'HEAD']);
}
