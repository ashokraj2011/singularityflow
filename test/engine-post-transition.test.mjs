import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {postPublicationStep, collectRequiredReceiptsAfterTransition, collectSpecUsageAfterTransition} from '../src/engine-compatibility/post-transition.mjs';
import * as presentation from '../src/phase-post-transition-guidance.mjs';

async function captureConsole(operation) {
  const old = {log: console.log, warn: console.warn};
  const lines = [];
  console.log = (...values) => lines.push(values.join(' '));
  console.warn = (...values) => lines.push(values.join(' '));
  try { return {value: await operation(), lines}; }
  finally { Object.assign(console, old); }
}

test('a native post-commit failure retains its cause as facts and emits no presentation', async () => {
  const cause = new Error('native session storage unavailable');
  const notices = [];
  const {value, lines} = await captureConsole(() => postPublicationStep('session activation', 'W-1', async () => {
    throw cause;
  }, {notice: event => notices.push(event)}));
  assert.deepEqual(lines, []);
  assert.equal(value.ok, false);
  assert.equal(value.error, cause);
  assert.equal(notices[0].error, cause);
  assert.equal(notices[0].code, 'transition.tail-failed');
  assert.deepEqual(await postPublicationStep('projection', 'W-1', async () => 42), {ok: true, value: 42});
});

test('a failing host observer cannot turn an accepted transition into another lifecycle refusal', async () => {
  const original = new Error('native tail failure');
  const observer = new Error('host observer failure');
  const result = await postPublicationStep('session activation', 'W-1', async () => {throw original;},
    {notice: async () => {throw observer;}});
  assert.equal(result.error, original);
  assert.equal(result.noticeError, observer);
  assert.equal(result.ok, false);
});

test('the legacy wrapper keeps the same recovery guidance while the native service stays silent', async () => {
  const old = await import('../src/commands/shared/post-publication-step.mjs');
  assert.equal(old.postPublicationStep, presentation.postPublicationStep);
  const {value, lines} = await captureConsole(() => old.postPublicationStep('session activation', 'W-1',
    async () => {throw new Error('permission denied');}));
  assert.equal(value.ok, false);
  assert.equal(lines[0], 'Warning: publication succeeded, but session activation could not be completed: permission denied');
  assert.ok(lines.some(line => line.includes('Copilot:')));
  assert.ok(lines.some(line => line.includes('Shell: singularity-flow resume W-1 --fetch')));
  assert.ok(lines.some(line => line.includes('VS Code (model-free):')));
});

test('optional bookkeeping stays absent, and failed usage writes remain inspectable native reports', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-post-transition-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const workflow = {workItem: {id: 'W-1'}, phaseOrder: ['specification', 'planning']};
  assert.equal(await collectRequiredReceiptsAfterTransition(root, workflow), null);
  assert.equal(await collectSpecUsageAfterTransition(root, {}, workflow, {phase: 'planning'}), null);
  const directory = path.join(root, 'singularity/work-items/W-1');
  await mkdir(directory, {recursive: true});
  await writeFile(path.join(directory, 'source.json'), JSON.stringify({specification: [{specId: 'SPEC-1', revision: 'REV-1'}]}));
  const notices = [];
  const {value, lines} = await captureConsole(() => collectSpecUsageAfterTransition(root, {}, workflow,
    {phase: 'specification', notice: event => notices.push(event)}));
  assert.deepEqual(lines, []);
  assert.equal(value.result, null);
  assert.ok(value.error instanceof Error);
  assert.equal(notices[0].error, value.error);
  assert.equal(notices[0].code, 'transition.usage-failed');
  assert.equal(await presentation.requiredReceiptsLine(null), null);
  assert.equal(presentation.specUsageLine(value), null);
});

test('native tails have no CLI imports, command rendering or console output', async () => {
  const native = await readFile(new URL('../src/engine-compatibility/post-transition.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(native, /console\.|safeCommandGuidance|printCommandRoutes|commands\//u);
  for (const name of ['git-approval', 'git-submission']) {
    const source = await readFile(new URL(`../src/engine-compatibility/${name}.mjs`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /commands\/shared\//u);
  }
});
