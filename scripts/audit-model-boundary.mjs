import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelBoundaryFailures } from './model-boundary-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sourceFiles(directory = path.join(root, 'src')) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.mjs') ? [path.relative(root, absolute)] : [];
  }));
  return nested.flat();
}

const failures = [];
for (const file of await sourceFiles()) {
  const text = await readFile(path.join(root, file), 'utf8');
  failures.push(...modelBoundaryFailures(file, text));
}

if (failures.length) {
  console.error(`Model-boundary audit failed:\n- ${failures.join('\n- ')}`);
  process.exitCode = 1;
} else {
  console.log('Model-boundary audit passed.');
}
