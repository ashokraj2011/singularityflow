import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectPureModuleGraph } from './helpers/pure-module-graph.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-foundation-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
  return root;
}

test('the graph guard follows re-exports and literal dynamic imports transitively', async t => {
  const root = await fixture(t, {
    'entry.mjs': "export * from './middle.mjs';",
    'middle.mjs': "export const load = () => import('./leaf.mjs');",
    'leaf.mjs': "import fs from 'node:fs'; export const read = fs.readFile;"
  });
  const result = await inspectPureModuleGraph({ root, entries: ['entry.mjs'],
    allowed: ['entry.mjs', 'middle.mjs', 'leaf.mjs'] });
  assert.deepEqual(result.modules, ['entry.mjs', 'leaf.mjs', 'middle.mjs']);
  assert.deepEqual(result.problems, [
    { file: 'leaf.mjs', line: 1, kind: 'external-import', dependency: 'node:fs' }
  ]);
});

test('computed imports and ambient host access cannot bypass the graph guard', async t => {
  const root = await fixture(t, {
    'entry.mjs': "export const load = name => import(name); export const cwd = () => process.cwd();"
  });
  const result = await inspectPureModuleGraph({ root, entries: ['entry.mjs'], allowed: ['entry.mjs'] });
  assert.deepEqual(result.problems.map(problem => problem.kind), ['nonliteral-import', 'ambient-host-access']);
});

test('a relative import cannot escape the explicitly owned component', async t => {
  const root = await fixture(t, {
    'entry.mjs': "export * from './host.mjs';",
    'host.mjs': 'throw new Error("the guard must not evaluate or admit this module");'
  });
  const result = await inspectPureModuleGraph({ root, entries: ['entry.mjs'], allowed: ['entry.mjs'] });
  assert.deepEqual(result.modules, ['entry.mjs']);
  assert.equal(result.problems[0].kind, 'outside-boundary');
  assert.equal(result.problems[0].dependency, 'host.mjs');
});

test('comments and data named after host capabilities do not create dependencies', async t => {
  const root = await fixture(t, {
    'entry.mjs': "// import fs from 'node:fs';\nexport const data = { process: 'node:fs' };\nexport const name = data.process;"
  });
  const result = await inspectPureModuleGraph({ root, entries: ['entry.mjs'], allowed: ['entry.mjs'] });
  assert.deepEqual(result.problems, []);
});

test('a locally bound require parameter remains data rather than a CommonJS loader', async t => {
  const root = await fixture(t, {
    'entry.mjs': 'export function select({ require = [] } = {}) { return require.filter(value => value); }'
  });
  const result = await inspectPureModuleGraph({ root, entries: ['entry.mjs'], allowed: ['entry.mjs'] });
  assert.deepEqual(result.problems, []);
});

test('SDA contracts load from an empty directory with no Git or repository on PATH', async t => {
  const root = await fixture(t, {});
  const urls = Object.fromEntries([
    ['errors', 'src/foundation/failures.mjs'], ['shared', 'src/sda/shared-state-contract.mjs'],
    ['lifecycle', 'src/sda/lifecycle-authority-contract.mjs']
  ].map(([name, file]) => [name, pathToFileURL(path.join(packageRoot, file)).href]));
  const probe = `
    import assert from 'node:assert/strict';
    const { SingularityFlowError } = await import(${JSON.stringify(urls.errors)});
    const shared = await import(${JSON.stringify(urls.shared)});
    const lifecycle = await import(${JSON.stringify(urls.lifecycle)});
    assert.equal(shared.SHARED_STATE_CONTRACT, 'sda-shared-state/v1');
    assert.equal(lifecycle.LIFECYCLE_AUTHORITY_CONTRACT, 'sda-lifecycle-authority/v1');
    assert.throws(() => shared.assertNotCancelled({ aborted: true }, 'append'),
      error => error instanceof SingularityFlowError && error.code === 'SDA_OPERATION_CANCELLED');
    assert.throws(() => shared.selectSharedStateAuthority({ descriptor: {
      contract: shared.SHARED_STATE_CONTRACT, qualification: 'test-only', id: 'test-adapter'
    }}), error => error instanceof SingularityFlowError && error.code === 'SDA_ADAPTER_NOT_PRODUCTION');
    console.log('independent');
  `;
  const env = { ...process.env, SINGULARITY_FLOW_NO_NETWORK: '1' };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = '';
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '--eval', probe],
    { cwd: root, env, encoding: 'utf8', timeout: 15_000, windowsHide: true }).trim(), 'independent');
  assert.deepEqual(await readdir(root), [], 'importing contracts creates no local state');
});
