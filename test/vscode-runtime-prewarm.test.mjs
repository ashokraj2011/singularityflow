import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prewarmCliRuntime } from '../apps/vscode/src/cli/prewarm.ts';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-warm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'bundle')); await mkdir(path.join(root, 'src'));
  const stamp = 'export const BUILD_INFO = { commit: "test" };\n';
  await writeFile(path.join(root, 'src/build-info.mjs'), stamp);
  const manifest = { format: 2, layout: 'coarse-esm', stamped: true,
    buildInfoSha256: 'sha256:' + createHash('sha256').update(stamp).digest('hex') };
  await writeFile(path.join(root, 'bundle/manifest.json'), JSON.stringify(manifest));
  return { root, manifest, location: { executable: process.execPath, cli: path.join(root, 'bin/singularity-flow.mjs') } };
}
test('runtime prewarming shares one exact invocation and preserves the real host runtime environment', async t => {
  const f = await fixture(t), seen = [];
  const env = { ELECTRON_RUN_AS_NODE: '1', NODE_COMPILE_CACHE: path.join(f.root, 'cache with spaces') };
  const invoke = async options => { seen.push(options); return { prepared: true }; };
  const results = await Promise.all([prewarmCliRuntime(f.location, env, { invoke }),
    prewarmCliRuntime(f.location, env, { invoke })]);
  assert.deepEqual(results, [{ status: 'prepared' }, { status: 'prepared' }]);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args, ['--warm-runtime']);
  assert.equal(seen[0].executable, f.location.executable);
  assert.equal(seen[0].cli, f.location.cli);
  assert.equal(seen[0].repository, os.tmpdir(), 'no repository command is dispatched');
  assert.deepEqual(seen[0].env, env);
  assert.equal(seen[0].timeoutMs, 10_000);
  await prewarmCliRuntime(f.location, { ...env, NODE_COMPILE_CACHE: path.join(f.root, 'other') }, { invoke });
  assert.equal(seen.length, 2, 'a different runtime/cache environment cannot reuse preparation');
});
test('failed and unsupported warmups are optional and retryable; disabled caching never launches', async t => {
  const f = await fixture(t); let calls = 0;
  const invoke = async () => { calls++; if (calls === 1) throw new Error('timeout'); return { prepared: false }; };
  assert.equal((await prewarmCliRuntime(f.location, {}, { invoke })).status, 'failed');
  assert.equal((await prewarmCliRuntime(f.location, {}, { invoke })).status, 'unavailable');
  assert.equal(calls, 2);
  assert.equal((await prewarmCliRuntime(f.location, { SINGULARITY_FLOW_BUNDLE: 'off' }, { invoke })).status, 'unavailable');
  assert.equal(calls, 2, 'an explicit source-runtime selection is not overridden');
  assert.equal((await prewarmCliRuntime(f.location, { NODE_DISABLE_COMPILE_CACHE: '1' }, { invoke })).status, 'unavailable');
  assert.equal(calls, 2);
  assert.equal((await prewarmCliRuntime(f.location, { SINGULARITY_FLOW_BUNDLE_DIR: './bundle' }, { invoke })).status, 'unavailable');
  assert.equal((await prewarmCliRuntime(f.location, { NODE_COMPILE_CACHE: './cache' }, { invoke })).status, 'unavailable');
  assert.equal(calls, 2, 'cwd-dependent overrides are left to the real command');
  await writeFile(path.join(f.root, 'src/build-info.mjs'), 'changed build');
  assert.equal((await prewarmCliRuntime(f.location, {}, { invoke })).status, 'unavailable');
  assert.equal(calls, 2, 'stamp mismatch falls back without running source or old CLI code');
});
test('prewarming binds the actually selected bundle, not a different installation manifest', async t => {
  const f = await fixture(t), selected = path.join(f.root, 'selected bundle'); await mkdir(selected);
  await writeFile(path.join(selected, 'manifest.json'), JSON.stringify(f.manifest));
  await rm(path.join(f.root, 'bundle'), { recursive: true });
  let calls = 0;
  const env = { SINGULARITY_FLOW_BUNDLE_DIR: selected };
  assert.equal((await prewarmCliRuntime(f.location, env,
    { invoke: async () => { calls++; return { prepared: true }; } })).status, 'prepared');
  assert.equal(calls, 1);
  await writeFile(path.join(selected, 'manifest.json'), JSON.stringify({ ...f.manifest, stamped: false }));
  assert.equal((await prewarmCliRuntime(f.location, env,
    { invoke: () => assert.fail('changed selected manifest must not reuse a prepared result') })).status, 'unavailable');
});
test('cancellation cannot become a cached success and a later panel may retry', async t => {
  const f = await fixture(t), controller = new AbortController();
  let started;
  const begun = new Promise(resolve => { started = resolve; });
  const pending = prewarmCliRuntime(f.location, {}, { signal: controller.signal, invoke: async options => {
    started(); return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  await begun; controller.abort();
  assert.equal((await pending).status, 'cancelled');
  assert.equal((await prewarmCliRuntime(f.location, {}, { invoke: async () => ({ prepared: true }) })).status, 'prepared');
  assert.equal((await prewarmCliRuntime(f.location, {}, { signal: controller.signal,
    invoke: () => assert.fail('already cancelled') })).status, 'cancelled');
});
test('intake prewarms after catalog loading and cancels optional work before Start or disposal', async () => {
  const source = await readFile(new URL('../apps/vscode/src/views/intake-panel.ts', import.meta.url), 'utf8');
  assert.match(source, /this\.load\(\)\.finally\([\s\S]*?this\.client\.prewarmRuntime\(this\.runtimeWarmup\.signal\)/);
  assert.match(source, /private async start\(\): Promise<void> \{\s*this\.runtimeWarmup\.abort\(\)/);
  assert.match(source, /dispose\(\): void \{[\s\S]*?this\.runtimeWarmup\.abort\(\)/);
});

test('activation schedules definition-only preparation before a click and does not await it', async () => {
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /const readPreparation = setTimeout\([\s\S]*?void client\.prewarmReads\(activationSignal\)/u);
  assert.match(extension, /dispose: \(\) => clearTimeout\(readPreparation\)/u);
  const client = await readFile(new URL('../apps/vscode/src/cli/client.ts', import.meta.url), 'utf8');
  assert.match(client, /for \(const preparation of this\.readPreparations\) preparation\.abort\(\)/u);
});
