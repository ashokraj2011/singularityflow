import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suite = process.argv[2] ?? 'all';
if (!['all', 'cli', 'desktop'].includes(suite)) throw new Error('Test suite must be all, cli, or desktop.');

const files = (await readdir(path.join(root, 'test')))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();
const selected = [];
for (const name of files) {
  const relative = path.posix.join('test', name);
  const source = await readFile(path.join(root, relative), 'utf8');
  const desktop = source.includes('apps/desktop');
  if (suite === 'all' || (suite === 'desktop' ? desktop : !desktop)) selected.push(relative);
}

if (!selected.length) throw new Error(`No ${suite} tests were discovered.`);
const result = spawnSync(process.execPath, ['--test', ...selected], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});
process.exitCode = result.status ?? 1;
