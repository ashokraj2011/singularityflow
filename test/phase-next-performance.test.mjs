import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createWarmReadFixture, bindPhaseReadFixture } from '../scripts/warm-read-fixture.mjs';
import { buildCliBundle } from '../scripts/build-cli-bundle.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

for (const storyMode of ['legacy', 'pinned', 'amended']) {
  test(`bound ${storyMode} phase entry composes context and worker guidance observes the same binding`, { timeout: 180_000 }, async t => {
    const f = await createWarmReadFixture({ storyMode, phaseReady: true, artifacts: 8 });
    const adapter = await import(pathToFileURL(path.join(f.engine, 'src/read-worker-client.mjs')).href);
    t.after(async () => { adapter.disposeReadWorkers(); await f.cleanup(); });
    f.env.SINGULARITY_FLOW_AGENT_OUTPUT = 'raw';
    await bindPhaseReadFixture(f);
    const before = f.git(['rev-parse', 'HEAD']);
    const order = structuredClone(f.state.phaseOrder);
    for (const compose of [false, true, true]) {
      const value = f.cold(['phase', 'enter', f.phaseId, '--work-id', f.workId,
        ...(compose ? ['--compose'] : []), '--for-agent', '--json']);
      assert.equal(value.ready, true); assert.equal(value.activeAgent, 'developer');
      assert.equal(value.phaseAgent.valid, true); assert.equal(value.workId, f.workId);
      assert.equal(value.contextAdmission.allowed, true);
      if (compose) {
        assert.ok(value.context?.text.length > 100);
        assert.equal(value.context.generation, 1);
        assert.ok(value.context.file?.path);
      }
      assert.equal(value.effects.testsRun, false); assert.equal(value.effects.storyAdvanced, false);
      assert.equal(value.effects.committed, false); assert.equal(value.effects.pushed, false);
    }
    const composed = spawnSync(process.execPath, [f.cli, 'phase', 'enter', '--compose', '--for-agent', '--json', '--timings'],
      { cwd: f.repository, env: f.env, encoding: 'utf8', timeout: childTimeout(90_000), maxBuffer: 40 * 1024 * 1024 });
    assert.equal(composed.status, 0, composed.stderr);
    assert.equal(JSON.parse(composed.stdout).contextAdmission.allowed, true);
    assert.match(composed.stderr, /story\.context-load=2(?:\s|$)/u,
      'entry plus one accepted load under the composition lease; no extra pre-lease policy load');
    assert.match(composed.stderr, /\[sflow startup\].*compile-cache-flush=[\d.]+ms/u);
    const args = ['nextsteps', f.workId, '--for-agent', '--json'];
    const read = () => adapter.readWithWorker({ executable: process.execPath, cli: f.cli,
      repository: f.repository, env: f.env, args });
    const cold = f.cold(args), worker = await read();
    assert.equal(worker?.kind, 'value'); assert.equal(worker.value.ready, true);
    assert.equal(worker.value.workId, cold.workId);
    assert.deepEqual(worker.value.actions, cold.actions);
    assert.deepEqual(worker.value.mutationContract, cold.mutationContract);
    assert.equal((await read()).transport, 'warm-worker');
    const privateGit = f.git(['rev-parse', '--absolute-git-dir']);
    const sessionPath = path.join(privateGit, 'singularity-flow/session.json');
    const original = await readFile(sessionPath, 'utf8'), stale = JSON.parse(original);
    stale.phaseId = 'not-current';
    await writeFile(sessionPath, JSON.stringify(stale));
    assert.equal((await read()).value.ready, false, 'a warm worker must not retain an author binding');
    await writeFile(sessionPath, original);
    assert.equal((await read()).value.ready, true);
    assert.equal(f.git(['rev-parse', 'HEAD']), before);
    assert.deepEqual(JSON.parse(await readFile(f.statePath, 'utf8')).phaseOrder, order);
    assert.equal(f.state.phases[f.phaseId].approvals.length, 0);
  });
}

test('bound legacy composition survives native checkout conversion without changing pinned template bytes', { timeout: 180_000 }, async t => {
  const f = await createWarmReadFixture({ phaseReady: true });
  t.after(() => f.cleanup());
  f.env.SINGULARITY_FLOW_AGENT_OUTPUT = 'raw';
  const checkout = path.join(f.directory, 'converted-checkout');
  f.git(['clone', '--config', 'core.autocrlf=true', '-q', '--no-hardlinks', '--single-branch', '--branch', f.workId, f.repository, checkout]);
  await bindPhaseReadFixture(f, checkout);
  const value = f.cold(['phase', 'enter', f.phaseId, '--compose', '--for-agent', '--json'], { cwd: checkout });
  assert.equal(value.ready, true);
  assert.equal(value.contextAdmission.allowed, true);
  assert.ok(value.context?.text);
});

test('composition reloads under its lease rather than inheriting an advisory accepted-context memo', { timeout: 180_000 }, async t => {
  const f = await createWarmReadFixture({ phaseReady: true });
  t.after(() => f.cleanup()); await bindPhaseReadFixture(f);
  const load = await import(pathToFileURL(path.join(f.engine, 'src/accepted-story-execution.mjs')));
  const scope = await import(pathToFileURL(path.join(f.engine, 'src/read-scope.mjs')));
  const composer = await import(pathToFileURL(path.join(f.engine, 'src/worldmodel.mjs')));
  await scope.withCommandReadScope(async () => {
    assert.equal((await load.loadAcceptedStoryExecution(f.repository, f.workId)).workflow.workItem.id, f.workId);
    const saved = await readFile(f.statePath);
    try {
      await writeFile(f.statePath, '{broken workflow');
      await assert.rejects(composer.composePhasePrompt(f.repository, { workId: f.workId, phase: f.phaseId }));
    } finally { await writeFile(f.statePath, saved); }
  });
  await assert.rejects(readFile(path.join(path.dirname(f.statePath), 'context', `${f.phaseId}-gen1.json`)), { code: 'ENOENT' });
});

test('installed bound phase, composition and nextsteps do not load compatibility or model dispatch', { timeout: 180_000 }, async t => {
  const f = await createWarmReadFixture({ storyMode: 'pinned', phaseReady: true, artifacts: 8 });
  t.after(() => f.cleanup()); await bindPhaseReadFixture(f); await buildCliBundle({ root: f.engine });
  const log = path.join(f.directory, 'module-roster.log'), hook = path.join(f.directory, 'module-hook.mjs');
  await writeFile(hook, `import { register } from 'node:module';\nregister(new URL('./module-loader.mjs', import.meta.url));\n`);
  await writeFile(path.join(f.directory, 'module-loader.mjs'), `import { appendFileSync } from 'node:fs';\nexport async function resolve(specifier, context, next) { const result = await next(specifier, context); if (/cold-(?:compatibility|models)\\.mjs$/.test(result.url)) appendFileSync(process.env.SFLOW_MODULE_ROSTER, '[edge ' + context.parentURL + ' -> ' + specifier + ']\\n'); return result; }\nexport async function load(url, context, next) { appendFileSync(process.env.SFLOW_MODULE_ROSTER, url + '\\n'); return next(url, context); }\n`);
  for (const args of [
    ['phase', 'enter', f.phaseId, '--for-agent', '--json'],
    ['phase', 'enter', f.phaseId, '--compose', '--for-agent', '--json'],
    ['nextsteps', f.workId, '--for-agent', '--json']
  ]) {
    await writeFile(log, '');
    const result = spawnSync(process.execPath, [f.cli, ...args], { cwd: f.repository,
      env: { ...f.env, SINGULARITY_FLOW_BUNDLE: 'on', SINGULARITY_FLOW_AGENT_OUTPUT: 'raw',
        SFLOW_MODULE_ROSTER: log, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` },
      encoding: 'utf8', timeout: childTimeout(90_000), maxBuffer: 40 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).ready, true);
    assert.doesNotMatch(await readFile(log, 'utf8'), /\/(?:cold-compatibility|cold-models)\.mjs(?:\n|$)/u,
      `${args.join(' ')} imported an unrelated installed command domain`);
  }
});
