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
import { bundledCliUrl, bundledCopilotHookUrl } from '../src/bundled-cli.mjs';
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
  assert.equal(bundledCopilotHookUrl(pkg, {}), null, 'older manifests use source hook execution');
  await manifest({ entries: ['cli.mjs', 'copilot-hook-runtime.mjs'] });
  assert.equal(bundledCopilotHookUrl(pkg, {}), pathToFileURL(path.join(pkg, 'bundle', 'copilot-hook-runtime.mjs')).href);
  assert.equal(bundledCopilotHookUrl(pkg, { SINGULARITY_FLOW_BUNDLE: 'off' }), null);
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE: 'off' }), null);
  await manifest({ stamped: false });
  assert.equal(bundledCliUrl(pkg, {}), null, 'a development build is never used on its own');
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), expected, 'unless forced');
  await manifest({ entries: ['cli.mjs', 'copilot-hook-runtime.mjs'] });
  assert.ok(bundledCopilotHookUrl(pkg, {}), 'a matching hook bundle exists before the build moves');
  await writeFile(path.join(pkg, 'src', 'build-info.mjs'), 'export const BUILD_INFO = { commit: null };\n');
  assert.equal(bundledCliUrl(pkg, {}), null, 'restored or edited build information: the sources');
  assert.equal(bundledCopilotHookUrl(pkg, {}), null, 'hook bundles must match the live build stamp too');
  await manifest({ format: 3 });
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), null, 'an unknown format is never run');
  await writeFile(path.join(pkg, 'bundle/cli.mjs'), 'export const main = () => {};');
  await writeFile(path.join(pkg, 'bundle/cold-core.mjs'), 'export const identity = {};');
  const coarse = { format: 2, layout: 'coarse-esm', outputs: [{ file: 'cli.mjs' }, { file: 'cold-core.mjs' }] };
  await manifest(coarse);
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), expected);
  await manifest({ ...coarse, outputs: [{ file: '../outside.mjs' }] });
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), null);
  await manifest(coarse);
  await rm(path.join(pkg, 'bundle/cold-core.mjs'));
  assert.equal(bundledCliUrl(pkg, { SINGULARITY_FLOW_BUNDLE_DIR: path.join(pkg, 'bundle') }), null, 'partial deployment uses sources');
});

test('the bundled CLI answers exactly like the sources while opening a handful of files', { timeout: 300_000 }, async (t) => {
  const outdir = path.join(root, `.bundle-test-${process.pid}`);
  t.after(() => rm(outdir, { recursive: true, force: true }));
  const { manifest } = await buildCliBundle({ outdir });
  assert.equal(manifest.format, 2);
  assert.ok(manifest.outputs.length <= 20, 'coarse chunks, never hundreds of module files');
  const closure = file => {
    const found = new Set();
    const visit = name => { if (found.has(name)) return; found.add(name);
      for (const dependency of manifest.outputs.find(item => item.file === name)?.imports ?? []) visit(dependency); };
    visit(file);
    return manifest.outputs.filter(item => found.has(item.file));
  };
  const cliStartup = closure('cli.mjs').reduce((sum, item) => sum + item.bytes, 0);
  const hookStartup = closure('copilot-hook-runtime.mjs').reduce((sum, item) => sum + item.bytes, 0);
  assert.deepEqual(manifest.entries, ['cli.mjs', 'copilot-hook-runtime.mjs', 'history-index-worker.mjs', 'configuration-read-worker.mjs', 'read-worker.mjs', 'configuration-proposal-sync-worker.mjs']);
  const hookOutput = manifest.outputs.find(output => output.file === 'copilot-hook-runtime.mjs');
  assert.ok(hookOutput.bytes <= 8 * 1024 * 1024, `hook bundle: ${hookOutput.bytes} bytes`);
  assert.ok(hookOutput.modules <= 650, `hook bundle: ${hookOutput.modules} modules`);
  assert.ok(cliStartup < 3 * 1024 * 1024, `CLI cold parse: ${cliStartup}`);
  assert.ok(hookStartup < 3 * 1024 * 1024, `hook cold parse: ${hookStartup}`);
  const catalogClosure = closure('cold-catalogs.mjs');
  const statusClosure = closure('cold-status.mjs');
  assert.ok(statusClosure.reduce((sum, item) => sum + item.bytes, 0) < 1.5 * 1024 * 1024,
    'ordinary JSON status must not inherit catalog or review closures');
  for (const name of ['cold-catalogs.mjs', 'cold-hook-context.mjs', 'cold-narrow-reads.mjs', 'cold-compatibility.mjs']) {
    assert.ok(!statusClosure.some(item => item.file === name), `status must not statically reach ${name}`);
  }
  assert.ok(closure('cold-narrow-reads.mjs').reduce((sum, item) => sum + item.bytes, 0) < 7 * 1024 * 1024,
    'document/report reads have a separate byte ceiling, not only a file-count limit');
  assert.ok(catalogClosure.reduce((sum, item) => sum + item.bytes, 0) < 5 * 1024 * 1024,
    'catalog parsing stays bounded instead of pulling in the entire administration bundle');
  for (const name of ['cold-compatibility.mjs', 'cold-models.mjs', 'cold-intake.mjs', 'cold-phases.mjs', 'cold-hook-context.mjs']) {
    assert.ok(!catalogClosure.some(item => item.file === name), `catalogs must not statically reach ${name}`);
  }
  const text = (await Promise.all(closure('cli.mjs').map(item => readFile(path.join(outdir, item.file), 'utf8')))).join('\n');
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
  assert.equal(spawnSync('git', ['add', '.'], { cwd: repo, env }).status, 0);
  assert.equal(spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'initialized fixture'],
    { cwd: repo, env }).status, 0);
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
  for (const args of [['--version'], ['help'], ['snapshot', '--include', 'repository', '--json'], ['nextsteps', '--json'],
    ['home', '--json'], ['inbox', '--json'],
    ['agents', 'list', '--json'], ['agents', 'mappings', '--json'], ['agents', 'status', '--json'],
    ['phase', 'show', 'intake', '--json'], ['report', 'MISSING', '--format', 'json'],
    ['workflow', 'list', '--json'], ['skill', 'list', '--json'], ['instruction', 'list', '--json'],
    ['start', 'BUNDLE-NEW-STORY', '--json'],
    ['workflow', 'intent', 'preflight', '--source', 'installed', '--json'],
    ['workflow', 'markup', 'example', '--json']]) {
    const source = await runWith(args, false);
    const bundled = await runWith(args, true);
    assert.equal(bundled.status, source.status, args.join(' '));
    if (['home', 'inbox'].includes(args[0])) {
      // These issue read timestamps (and Home one-use selection handles). Every binding, action,
      // outcome and effect still compares exactly; only these deliberately fresh values differ.
      const stable = text => JSON.parse(text, (key, value) => {
        if (key === 'handle' && /^sel_[a-f0-9]+$/u.test(value)) return '<one-use-selection>';
        if (['asOf', 'generatedAt'].includes(key) && typeof value === 'string' && Number.isFinite(Date.parse(value))) return '<time-of-read>';
        return value;
      });
      assert.deepEqual(stable(bundled.stdout), stable(source.stdout), `${args[0]} preserves its result apart from fresh read values`);
    } else assert.equal(bundled.stdout, source.stdout, `${args.join(' ')} prints the same`);
    assert.ok(bundled.modules.length <= 28, `${args.join(' ')} opened ${bundled.modules.length} module files: ${bundled.modules.join(', ')}`);
    if (args[0] === '--version') assert.ok(bundled.modules.length <= 8, 'version only loads core');
    if (['snapshot', 'nextsteps', 'home', 'inbox'].includes(args[0])) assert.ok(!bundled.modules.some(url => url.endsWith('/cold-compatibility.mjs')),
      `${args[0]} must not load the general compatibility handler`);
    if (['agents', 'workflow', 'skill', 'instruction'].includes(args[0]) && ['list', 'mappings', 'status'].includes(args[1])) {
      for (const name of ['cold-compatibility.mjs', 'cold-models.mjs', 'cold-intake.mjs', 'cold-phases.mjs']) {
        assert.ok(!bundled.modules.some(url => url.endsWith('/' + name)), `${args.join(' ')} must not load ${name}`);
      }
    }
    if (args[0] === 'report' || args[0] === 'phase' && args[1] === 'show') {
      for (const file of ['cold-compatibility.mjs', 'cold-phases.mjs', 'cold-models.mjs']) {
        assert.ok(!bundled.modules.some(url => url.endsWith('/' + file)), `${args.join(' ')} must not load ${file}`);
      }
    }
    if (args[0] !== '--version') assert.ok(source.modules.length > 35, `${args.join(' ')} from the sources opened ${source.modules.length}`);
  }

  // The launcher must actually select the dedicated bundle, not just a manifest URL. Real turn
  // capture and edit denials replay identically, while the bundled entry opens only a few files.
  const beforeWarm = spawnSync('git', ['status', '--porcelain'], { cwd: repo, env, encoding: 'utf8' }).stdout;
  const warmed = await runWith(['--warm-runtime'], true);
  assert.equal(warmed.status, 0);
  const preparation = JSON.parse(warmed.stdout);
  if (preparation.prepared) {
    assert.equal(preparation.commandsExecuted, 0); assert.equal(preparation.modelsInvoked, 0);
    assert.ok(preparation.files.every(file => file.startsWith('cold-') && !file.includes('worker')));
    assert.ok(preparation.files.includes('cold-catalogs.mjs'), 'prepares catalog definitions');
    assert.ok(preparation.files.includes('cold-phases.mjs'), 'prepares phase definitions');
    assert.ok(preparation.files.includes('cold-reads.mjs'), 'prepares narrow phase-document/report definitions too');
    assert.ok(preparation.files.includes('cold-narrow-reads.mjs'), 'prepares the isolated read family');
    assert.ok(!warmed.modules.some(url => /\/(?:cold-compatibility|cold-models|read-worker|history-index-worker)\.mjs$/u.test(url)),
      'warming definitions cannot start a worker or import the compatibility/model domain');
  } else assert.equal(preparation.reason, 'cache-or-bundle-unavailable', 'Node 20/disabled cache is optional');
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: repo, env, encoding: 'utf8' }).stdout, beforeWarm);
  for (const [action, payload] of [
    ['boundary-guard', {}],
    ['agent-start', { agentName: 'product-owner', cwd: repo }],
    ['boundary-turn', { sessionId: 'bundled-hook', cwd: repo, prompt: '/sf-code' }],
    ['boundary-guard', { sessionId: 'bundled-hook', cwd: repo, toolName: 'edit', toolArgs: { path: 'src/App.jsx' } }],
    ['boundary-after', { sessionId: 'bundled-hook', cwd: repo }],
    ['boundary-end', { sessionId: 'bundled-hook', cwd: repo }]
  ]) {
    const results = [];
    for (const bundled of [false, true]) {
      const log = path.join(base, `hook-modules-${bundled}.log`);
      await rm(log, { force: true });
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href,
        path.join(root, 'plugin/hook-launcher.mjs'), action, cli], {
        cwd: repo, encoding: 'utf8', input: JSON.stringify(payload), timeout: 30000,
        env: { ...env, MODULE_LOG: log, SINGULARITY_FLOW_HOOK_RUNTIME: 'dedicated',
          SINGULARITY_FLOW_BUNDLE: bundled ? 'on' : 'off', ...(bundled ? { SINGULARITY_FLOW_BUNDLE_DIR: outdir } : {}) }
      });
      assert.equal(result.status, 0, `${action}: ${result.stderr}`);
      results.push(JSON.parse(result.stdout));
      const modules = (await readFile(log, 'utf8')).split('\n').filter(Boolean);
      if (bundled) {
        assert.ok(modules.some(url => url.endsWith('/copilot-hook-runtime.mjs') && !url.includes('/src/')),
          `${action}: the dedicated bundle ran`);
        assert.ok(modules.length <= 16, `${action}: ${modules.length} module files`);
        assert.ok(!modules.some(url => url.endsWith('/cold-compatibility.mjs')), `${action}: no general CLI chunk`);
      }
    }
    assert.deepEqual(results[1], results[0], `${action}: bundled hooks preserve the source decision`);
    if (action === 'boundary-guard' && payload.sessionId) assert.equal(results[1].permissionDecision, 'deny');
  }

  // `secrets protect` writes a hook that runs the CLI it was installed from. Bundled, its module is
  // not in src/commands/, so that path must come from the package root and never from the file.
  const hooks = {};
  for (const bundle of [false, true]) {
    const protect = await runWith(['secrets', 'protect'], bundle);
    assert.equal(protect.status, 0, `secrets protect from the ${bundle ? 'bundle' : 'sources'}`);
    hooks[bundle] = await readFile(path.join(repo, '.git', 'hooks', 'pre-commit'), 'utf8');
  }
  assert.equal(hooks.true, hooks.false, 'the bundle installs the same hook as the sources');
  assert.ok(hooks.true.includes(JSON.stringify(path.join(root, 'bin', 'singularity-flow.mjs'))), hooks.true);
});
