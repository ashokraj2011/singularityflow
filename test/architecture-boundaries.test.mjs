import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW_STATE_IMPORT = /from\s+['"][^'"]*(?:state|initiative-state)\.mjs['"]/;

async function sourceFiles(directory) {
  const absolute = path.join(packageRoot, directory);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (/\.(?:mjs|js|ts|cjs)$/.test(entry.name)) files.push(relative);
  }
  return files;
}

test('application surfaces cannot bypass the revisioned state-store boundary', async () => {
  const applicationGateways = [
    'src/cli.mjs',
    'src/doctor.mjs',
    'src/editor.mjs',
    'src/jira-doctor.mjs',
    'src/snapshot-coordinator.mjs',
    'src/state-planes.mjs',
    'src/workspace-context.mjs'
  ];
  const surfaceFiles = (await Promise.all([
    sourceFiles('apps'),
    sourceFiles('bin'),
    sourceFiles('plugin'),
    sourceFiles('scripts')
  ])).flat();

  const violations = [];
  for (const relative of [...applicationGateways, ...surfaceFiles]) {
    const content = await readFile(path.join(packageRoot, relative), 'utf8');
    if (RAW_STATE_IMPORT.test(content)) violations.push(relative);
  }

  assert.deepEqual(violations, [],
    'surfaces must load and mutate Story/Initiative aggregates through state-stores.mjs');
});
