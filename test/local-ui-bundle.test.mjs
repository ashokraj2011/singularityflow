import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCliBundle } from '../scripts/build-cli-bundle.mjs';
import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { readPrivate, serviceDirectory } from '../src/local-ui/private-state.mjs';
import { control } from '../src/local-ui/client.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)), cli = path.join(root, 'bin/singularity-flow.mjs');
test('packaged CLI opens the independent service with original asset paths and zero startup Git calls', { timeout: 90_000 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ui-package-'));
  const outdir = path.join(root, `.bundle-test-ui-${process.pid}`);
  let descriptor;
  t.after(async () => {
    if (descriptor) await control(descriptor, 'stop', { drain: true }).catch(() => {});
    await rm(outdir, { recursive: true, force: true }); await rm(base, { recursive: true, force: true });
  });
  await buildCliBundle({ outdir });
  // Observe actual Node-launched Git calls across the CLI and daemon, without recording arguments.
  const observer = path.join(base, 'observe.mjs'), callsFile = path.join(base, 'git-calls.txt');
  await writeFile(observer, `import cp from 'node:child_process';\nimport { syncBuiltinESMExports } from 'node:module';\nimport { appendFileSync } from 'node:fs';\nimport path from 'node:path';\nfor (const key of ['spawn','spawnSync','execFile','execFileSync','execSync']) { const original=cp[key]; cp[key]=function(command,...args) { if (/^git(?:\\.exe)?$/iu.test(path.basename(String(command)))) appendFileSync(${JSON.stringify(callsFile)}, 'git\\n'); return original.call(this,command,...args); }; }\nsyncBuiltinESMExports();\n`);
  const env = { ...isolatedTestEnvironment(path.join(base, 'machine')), SINGULARITY_FLOW_BUNDLE_DIR: outdir,
    NODE_OPTIONS: `--import=${pathToFileURL(observer).href}` };
  const started = performance.now();
  const child = spawnSync(process.execPath, [cli, 'ui', 'open', '--no-open', '--json'], { cwd: base, env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  const openMs = performance.now() - started;
  const launched = JSON.parse(child.stdout);
  const directory = serviceDirectory(env); descriptor = await readPrivate(path.join(directory, 'instance.json'));
  assert.equal(launched.instance, descriptor.instance);
  assert.equal((await control(descriptor, 'status')).build.engineRoot, root.slice(0, -1), 'source paths are anchored to the selected package');
  const [index, script, views, code, codeStyle, ask, askNavigation, askHistory] = await Promise.all(
    ['/', '/app.js', '/views.js', '/code-explainer.js', '/code-explainer.css', '/ask.js', '/ask-navigation.js', '/ask-history-display.js'].map(asset => fetch(`${descriptor.origin}${asset}`))
  );
  assert.equal(index.status, 200); assert.match(await index.text(), /SFlow Workspace/u);
  assert.equal(script.status, 200); assert.match(await script.text(), /Spec Studio/u);
  assert.equal(views.status, 200); assert.match(await views.text(), /Workspace overview/u);
  assert.equal(code.status, 200); assert.match(await code.text(), /mountCodeExplainer/u);
  assert.equal(codeStyle.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.equal(ask.status, 200); assert.match(await ask.text(), /mountAsk/u);
  assert.equal(askNavigation.status, 200); assert.match(await askNavigation.text(), /askSuggestions/u);
  assert.equal(askHistory.status, 200); assert.match(await askHistory.text(), /askHistoryDisplay/u);
  const health = [];
  for (let i = 0; i < 5; i++) {
    const at = performance.now(); assert.equal((await fetch(`${descriptor.origin}/health`)).status, 200); health.push(performance.now() - at);
  }
  const status = spawnSync(process.execPath, [cli, 'ui', 'status', '--json'], { cwd: base, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(status.status, 0, status.stderr + status.stdout); assert.equal(JSON.parse(status.stdout).instance, launched.instance);
  const invalid = spawnSync(process.execPath, [cli, 'ui', 'open', '--idle-minutes', '0', '--json'], { cwd: base, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(invalid.status, 1, invalid.stderr + invalid.stdout);
  const refused = JSON.parse(invalid.stdout);
  assert.equal(refused.error.code, 'UI_IDLE_INVALID');
  assert.deepEqual(refused.remediationPlan.steps.map(step => step.command), ['singularity-flow ui --help']);
  const calls = await readFile(callsFile, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  assert.equal(calls, '', 'opening/status/static assets/health never inspect Git');
  t.diagnostic(JSON.stringify({ platform: process.platform, runtime: process.version, source: 'forced packaged CLI, fresh processes; normal OS caches',
    openMs: Math.round(openMs), healthMedianMs: Math.round(health.sort((a, b) => a - b)[2] * 100) / 100, gitCalls: 0 }));
});
test('npm package includes the service, browser and Copilot skill assets', { timeout: 60_000 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ui-pack-')); t.after(() => rm(base, { recursive: true, force: true }));
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, env: isolatedTestEnvironment(base), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  const files = new Set(JSON.parse(result.stdout)[0].files.map(file => file.path));
  for (const file of ['src/commands/ui.mjs', 'src/local-ui/cli.mjs', 'src/local-ui/client.mjs', 'src/local-ui/server.mjs',
    'src/local-ui/native-auth.mjs', 'src/local-ui/cli-recovery.mjs',
    'src/local-ui/bridge-client.mjs', 'src/local-ui/public/index.html', 'src/local-ui/public/app.js',
    'src/local-ui/public/app.css', 'src/local-ui/public/views.js', 'src/local-ui/public/code-explainer.js',
    'src/local-ui/public/code-explainer.css', 'src/ask/history-display.mjs', 'src/ask/retained-history.mjs',
    'src/git-access-history.mjs', 'src/ask/conversation.mjs', 'src/ask/evidence.mjs', 'src/ask/explanation.mjs',
    'src/task-handoff.mjs', 'src/task-admission.mjs', 'src/ask/task-handoff.mjs',
    'src/ask/shared-contract.mjs', 'src/ask/shared-provider-server.mjs', 'src/ask/shared-conversations.mjs',
    'src/ask/portable-view.mjs', 'src/ask/portable-evidence.mjs', 'src/ask/portable-task.mjs', 'src/ask/private-files.mjs',
    'src/comprehension/code-map.mjs', 'plugin/skills/sflow-ui/SKILL.md']) assert.ok(files.has(file), file);
});

test('foreground JSON readiness is visible before shutdown and the native control closes it cleanly', { timeout: 30_000 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-ui-foreground-'));
  const env = isolatedTestEnvironment(base), directory = serviceDirectory(env);
  const child = spawn(process.execPath, [cli, 'ui', 'serve', '--json'], { cwd: base, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  t.after(async () => {
    const descriptor = await readPrivate(path.join(directory, 'instance.json')).catch(() => null);
    if (descriptor) await control(descriptor, 'stop', { drain: true }).catch(() => {});
    await closed; await rm(base, { recursive: true, force: true });
  });
  let output = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Foreground readiness was buffered: ${stderr}`)), 15_000);
    child.stdout.on('data', chunk => { output += chunk.toString(); try { const value = JSON.parse(output); clearTimeout(timer); resolve(value); } catch { /* Await a complete JSON readiness frame. */ } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { if (!output) { clearTimeout(timer); reject(new Error(`Foreground exited ${code}: ${stderr}`)); } });
  });
  assert.equal(ready.status, 'running'); assert.equal(child.exitCode, null);
  const descriptor = await readPrivate(path.join(directory, 'instance.json'));
  await control(descriptor, 'stop', { drain: true });
  assert.equal(await closed, 0);
});
