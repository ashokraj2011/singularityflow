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
  const domainBoundaryFiles = new Set([
    'src/state.mjs',
    'src/initiative-state.mjs',
    'src/state-stores.mjs',
    'src/projectors.mjs',
    // Epic source generators are loaded while Initiative configuration is
    // initialized, before state-stores can safely be evaluated. It is a domain
    // collaborator, not an application surface; its draft save remains explicit.
    'src/epic-sources.mjs',
    // Read-only domain projection. This legacy source contains byte-preserved
    // evidence separators and never imports either raw save primitive.
    'src/initiative-impact.mjs'
  ]);
  const sourceGateways = (await sourceFiles('src'))
    .filter((relative) => !domainBoundaryFiles.has(relative));
  const surfaceFiles = (await Promise.all([
    sourceFiles('apps'),
    sourceFiles('bin'),
    sourceFiles('plugin'),
    sourceFiles('scripts')
  ])).flat();

  const violations = [];
  for (const relative of [...sourceGateways, ...surfaceFiles]) {
    const content = await readFile(path.join(packageRoot, relative), 'utf8');
    if (RAW_STATE_IMPORT.test(content)) violations.push(relative);
  }

  assert.deepEqual(violations, [],
    'surfaces must load and mutate Story/Initiative aggregates through state-stores.mjs');
});

test('the revisioned store boundary does not expose raw persistence primitives', async () => {
  const content = await readFile(path.join(packageRoot, 'src/state-stores.mjs'), 'utf8');
  const exportBlocks = [...content.matchAll(/export\s*\{([^}]*)\}/gs)].map((match) => match[1]);
  assert.equal(exportBlocks.some((block) => /\bsaveWorkflow\b/.test(block)), false);
  assert.equal(exportBlocks.some((block) => /\bsaveInitiative\b/.test(block)), false);
  assert.match(content, /saveStoryDraft/);
  assert.match(content, /saveInitiativeDraft/);
});

test('source code cannot hard-code a direct push to an application branch', async () => {
  const violations = [];
  for (const relative of await sourceFiles('src')) {
    const lines = (await readFile(path.join(packageRoot, relative), 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (/(?:\[['"]push['"]|pushBranch\()/.test(line)
        && /(?:refs\/heads\/|HEAD:)?(?:main|master)\b/.test(line)) {
        violations.push(`${relative}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(violations, [], 'application branches may be resolved, but never literal push targets');
});

test('unscoped publishers guard before they stage or commit', async () => {
  const publishers = [
    ['src/worldmodel.mjs', 'async function publishWorldModel'],
    ['src/editor.mjs', 'export async function publishEditorConfiguration'],
    ['src/story-lineage.mjs', 'export async function attachStoryBranch']
  ];
  for (const [relative, marker] of publishers) {
    const content = await readFile(path.join(packageRoot, relative), 'utf8');
    const start = content.indexOf(marker);
    assert.notEqual(start, -1, `${relative} publisher exists`);
    const nextExport = content.indexOf('\nexport ', start + marker.length);
    const body = content.slice(start, nextExport < 0 ? content.length : nextExport);
    const guard = body.indexOf('assertNotDefaultBranch(');
    const mutation = Math.min(...['add(', "run('git', ['add'", 'saveStoryDraft(', 'commit(']
      .map((needle) => body.indexOf(needle)).filter((index) => index >= 0));
    assert.ok(guard >= 0 && guard < mutation, `${relative} must guard before its first mutation`);
  }
});
