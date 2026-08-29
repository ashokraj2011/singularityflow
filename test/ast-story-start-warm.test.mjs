import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

import { loadDefinition } from '../src/config.mjs';
import {
  runStoryStartAstWarmWorker, scheduleStoryStartAstWarm, storyStartAstWarmPlan
} from '../src/ast-story-start-warm.mjs';
import { readStoryStartAstWarmStatus } from '../src/ast-story-start-status.mjs';

const bin = path.resolve('bin/singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-ast-warm-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'AST Story Tester'], root);
  run('git', ['config', 'user.email', 'ast-story@example.com'], root);
  run(process.execPath, [bin, 'init'], root);
  const definitionFile = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.git.publish = 'off';
  definition.worldModel.sourceRoots = ['src'];
  await writeFile(definitionFile, YAML.stringify(definition));
  await writeFile(path.join(root, 'App.java'), 'class Outside {}\n');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'App.java'), 'package demo; public class App {}\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

function workflow(id = 'STORY-AST') {
  return { workItem: { id }, resolution: {} };
}

test('Story-start warming schedules the configured source scope and the worker reuses its cache', async () => {
  const root = await repository();
  const definition = await loadDefinition(root);
  let launched = null;
  const scheduled = await scheduleStoryStartAstWarm(root, definition, workflow(), {
    launcher: (actualRoot, workId) => {
      launched = { root: actualRoot, workId };
      return { pid: 4242 };
    }
  });
  assert.deepEqual(launched, { root, workId: 'STORY-AST' });
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.blocking, false);
  const plan = await storyStartAstWarmPlan(root, definition, workflow());
  assert.deepEqual(plan.options, { paths: ['src'] });

  const first = await runStoryStartAstWarmWorker(root, 'STORY-AST');
  assert.equal(first.status, 'complete');
  assert.equal(first.result.selected, 1);
  assert.ok(first.result.cacheMisses >= 1);
  const blobs = await readdir(path.join(root, '.git', 'singularity-flow', 'ast', 'v2', 'blobs'));
  assert.equal(blobs.length, 1);
  assert.equal(run('git', ['status', '--porcelain'], root).stdout, '',
    'derived Story-start warming must not edit the Story branch');

  const synchronous = {
    ...definition,
    ast: {
      ...definition.ast,
      warmOnStoryStart: { mode: 'before-first-phase', scope: 'configured-roots' }
    }
  };
  const reused = await scheduleStoryStartAstWarm(root, synchronous, workflow());
  assert.equal(reused.status, 'complete');
  assert.equal(reused.blocking, true);
  assert.ok(reused.result.cacheHits >= 1);
  assert.equal(reused.result.cacheMisses, 0);
  const status = await readStoryStartAstWarmStatus(root, 'STORY-AST');
  assert.equal(status.status, 'complete');
  assert.equal(status.blocking, true);
});

test('Story-start warming is skipped when AST is off and never throws when local cache writes fail', async () => {
  const root = await repository();
  const definition = await loadDefinition(root);
  let launched = false;
  const off = await scheduleStoryStartAstWarm(root, {
    ...definition, ast: { ...definition.ast, mode: 'off' }
  }, workflow('STORY-OFF'), { launcher: () => { launched = true; } });
  assert.equal(off.status, 'skipped');
  assert.equal(off.reason, 'ast-off');
  assert.equal(launched, false);

  const cacheRoot = path.join(root, '.git', 'singularity-flow');
  await rm(cacheRoot, { recursive: true, force: true });
  await writeFile(cacheRoot, 'cache path intentionally unavailable\n');
  const failed = await scheduleStoryStartAstWarm(root, definition, workflow('STORY-FAIL'), {
    launcher: () => { throw new Error('must not launch'); }
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.blocking, false);
  assert.match(failed.message, /ENOTDIR|not a directory/i);
});

test('a background worker refuses to warm a different repository revision', async () => {
  const root = await repository();
  const definition = await loadDefinition(root);
  await scheduleStoryStartAstWarm(root, definition, workflow('STORY-MOVED'), {
    launcher: () => ({ pid: 7 })
  });
  await writeFile(path.join(root, 'later.txt'), 'later\n');
  run('git', ['add', 'later.txt'], root);
  run('git', ['commit', '-m', 'move revision'], root);
  const result = await runStoryStartAstWarmWorker(root, 'STORY-MOVED');
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'repository-revision-changed');
});
