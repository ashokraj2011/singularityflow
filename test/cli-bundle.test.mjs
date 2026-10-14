import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { COMMAND_REGISTRY } from '../src/command-registry.mjs';
import { COMMAND_LOADERS } from '../src/command-loaders.mjs';
import { bundledCliUrl } from '../src/bundled-cli.mjs';
import { buildCliBundle } from '../scripts/build-cli-bundle.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin', 'singularity-flow.mjs');

test('every command module has a literal loader, so the bundle carries it', () => {
  const paths = [...new Set(COMMAND_REGISTRY.map((definition) => definition.modulePath))].sort();
  assert.deepEqual(Object.keys(COMMAND_LOADERS).sort(), paths);
  for (const [modulePath, loader] of Object.entries(COMMAND_LOADERS)) {
    assert.equal(loader.toString(), `() => import('${modulePath}')`, modulePath);
  }
});

test('the bundle runs only for the stamped build it was made for, unless it is forced or switched off', async (t) => {
  const pkg = await mkdtemp(path.join(os.tmpdir(), 'sflow-bundle-select-'));
  t.after(() => rm(pkg, { recursive: true, force: true }));
  await mkdir(path.join(pkg, 'src'));
  await mkdir(path.join(pkg, 'bundle'));
  const buildInfo = 'export const BUILD_INFO = { commit: "abc" };\n';
  await writeFile(path.join(pkg, 'src', 'build-info.mjs'), buildInfo);
  const digest = `sha256:${createHash('sha256').update(buildInfo).digest('hex')}`;
  const manifest = (fields) => writeFile(path.join(pkg, 'bundle', 'manifest.json'),
    JSON.stringify({ format: 1, entries: ['cli.mjs'], stamped: true, buildInfoSha256: digest, ...fields }));
  const expected = pathToFileURL(path.join(pkg, 'bundle', 'cli.mjs')).href;

  assert.equal(bundledCliUrl(pkg, {}), null, 'no manifest: the sources');
  await manifest({});
  assert.equal(bundledCliUrl(pkg, {}), expected, 'the stamped build it was made for');
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE: 'off' }), null);
  await manifest({ stamped: false });
  assert.equal(bundledCliUrl(pkg, {}), null, 'a development build is never used on its own');
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), expected, 'unless forced');
  await manifest({});
  await writeFile(path.join(pkg, 'src', 'build-info.mjs'), 'export const BUILD_INFO = { commit: null };\n');
  assert.equal(bundledCliUrl(pkg, {}), null, 'restored or edited build information: the sources');
  await manifest({ format: 2 });
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), null, 'an unknown format is never run');
});

test('the bundled CLI answers exactly like the sources while opening a handful of files', { timeout: 300_000 }, async (t) => {
  const outdir = path.join(root, `.bundle-test-${process.pid}`);
  t.after(() => rm(outdir, { recursive: true, force: true }));
  const { manifest } = await buildCliBundle({ outdir });
  assert.deepEqual(manifest.entries, ['cli.mjs', 'history-index-worker.mjs', 'configuration-read-worker.mjs', 'configuration-proposal-sync-worker.mjs']);
  const text = await readFile(path.join(outdir, 'cli.mjs'), 'utf8');
  assert.doesNotMatch(text, /node_modules\/(?:typescript|pyright|sql\.js|@agentclientprotocol)\//u, 'large or file-based packages stay external');
  assert.match(text, /\.\.\/src\/build-info\.mjs/u, 'the install stamp is read live from src/');

  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-bundle-run-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1',
    SINGULARITY_FLOW_GIT_FACT_STORE: 'off', HOME: path.join(base, 'home'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Bundle Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'bundle@example.invalid' };
  assert.equal(spawnSync('git', ['init', '-q', '-b', 'main', repo], { env }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, '--no-model', 'init'], { cwd: repo, env }).status, 0);
  // Count every module file the process loads, from the loader thread, synchronously.
  const hook = path.join(base, 'count.mjs');
  await writeFile(hook, `import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(\`
import { appendFileSync } from 'node:fs';
export async function load(url, context, next) {
  const result = await next(url, context);
  if (url.startsWith('file:')) appendFileSync(process.env.MODULE_LOG, url + '\\\\n');
  return result;
}\`));
`);
  const runWith = async (args, bundle) => {
    const log = path.join(base, `modules-${bundle ? 'bundle' : 'source'}.log`);
    await rm(log, { force: true });
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, cli, ...args], {
      cwd: repo, encoding: 'utf8', env: { ...env, MODULE_LOG: log, ...(bundle ? { SINGULARITY_FLOW_BUNDLE_DIR: outdir } : { SINGULARITY_FLOW_BUNDLE: 'off' }) }
    });
    const modules = (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return { status: result.status, stdout: result.stdout, modules };
  };
  for (const args of [['--version'], ['help'], ['nextsteps', '--json']]) {
    const source = await runWith(args, false);
    const bundled = await runWith(args, true);
    assert.equal(bundled.status, source.status, args.join(' '));
    assert.equal(bundled.stdout, source.stdout, `${args.join(' ')} prints the same`);
    assert.ok(bundled.modules.length <= 8, `${args.join(' ')} opened ${bundled.modules.length} module files: ${bundled.modules.join(', ')}`);
    if (args[0] !== '--version') assert.ok(source.modules.length > 100, `${args.join(' ')} from the sources opened ${source.modules.length}`);
  }
});
