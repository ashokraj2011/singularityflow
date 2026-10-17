import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { coarseChunkAssignment } from '../scripts/build-cold-cli-bundle.mjs';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { agentAct } from '../src/agent-output.mjs';

test('intake action asks for choices once and does not loop after selected-base preflight', () => {
  const choices = agentAct({ resultType: 'intake-entry', status: 'choices-ready' });
  assert.equal(choices.state, 'ask-person');
  assert.ok(choices.read.includes('intake'));
  const passed = agentAct({ resultType: 'intake-entry', status: 'preflight-ready' });
  assert.equal(passed.state, 'next'); assert.match(passed.said, /Do not repeat preflight/);
  assert.equal(agentAct({ resultType: 'intake-entry', paused: true }).state, 'paused');
});

test('coarse families share one module identity and never import worker programs', () => {
  for (const root of ['/engine', 'C:\\engine']) {
    const id = name => path.join(root, 'src', name).replaceAll('\\', '/');
    const graph = new Map([
      [id('cli-bundle-entry.mjs'), { importedIds: [id('shared.mjs')], isExternal: false }],
      [id('copilot-hook-runtime.mjs'), { importedIds: [id('shared.mjs')], isExternal: false }],
      [id('read-worker.mjs'), { importedIds: [id('worker-protocol.mjs')], isExternal: false }],
      [id('history-index-worker.mjs'), { importedIds: [id('worker-protocol.mjs')], isExternal: false }],
      [id('shared.mjs'), { importedIds: [], isExternal: false }],
      [id('commands/agents.mjs'), { importedIds: [id('catalog-shared.mjs'), id('shared.mjs')], isExternal: false }],
      [id('commands/workflow-list.mjs'), { importedIds: [id('catalog-shared.mjs')], isExternal: false }],
      [id('catalog-shared.mjs'), { importedIds: [], isExternal: false }],
      [id('editor.mjs'), { importedIds: [id('catalog-shared.mjs')], isExternal: false }],
      [id('worker-protocol.mjs'), { importedIds: [], isExternal: false }]
    ]);
    const owners = coarseChunkAssignment(root, { getModuleIds: () => graph.keys(), getModuleInfo: key => graph.get(key) }, {
      cli: 'src/cli-bundle-entry.mjs', hook: 'src/copilot-hook-runtime.mjs',
      worker: 'src/read-worker.mjs', history: 'src/history-index-worker.mjs'
    });
    assert.equal(owners.get(id('shared.mjs')), 'core');
    assert.equal(owners.get(id('worker-protocol.mjs')), 'worker-protocol');
    assert.equal(owners.get(id('commands/agents.mjs')), 'catalogs');
    assert.equal(owners.get(id('commands/workflow-list.mjs')), 'catalogs');
    assert.equal(owners.get(id('catalog-shared.mjs')), 'catalogs');
    assert.equal(owners.get(id('editor.mjs')), 'compatibility', 'editing cannot enlarge the catalog family');
    for (const program of ['cli-bundle-entry.mjs', 'copilot-hook-runtime.mjs', 'read-worker.mjs', 'history-index-worker.mjs']) {
      assert.equal(owners.has(id(program)), false, `${root}: ${program} remains private`);
    }
  }
});

test('intake entry checks pause before Git, and reports dirty work without catalog lookups', async t => {
  const f = await createWarmReadFixture(); t.after(f.cleanup);
  const mode = path.join(f.directory, 'mode.json');
  await writeFile(mode, JSON.stringify({ schemaVersion: 1, paused: true }));
  const args = ['workspace', 'branches', '--entry', '--work-id', 'ENTRY-1', '--for-agent', '--json'];
  const paused = spawnSync(process.execPath, [f.cli, ...args], { cwd: f.directory,
    env: { ...f.env, PATH: path.join(f.directory, 'absent-programs') }, encoding: 'utf8' });
  assert.equal(paused.status, 0, paused.stderr);
  assert.equal(JSON.parse(paused.stdout).paused, true, 'no Git installation required while paused');
  await writeFile(mode, JSON.stringify({ schemaVersion: 1, paused: false }));
  await writeFile(path.join(f.repository, 'unreviewed.txt'), 'keep this work');
  const dirty = spawnSync(process.execPath, [f.cli, ...args], { cwd: f.repository, env: f.env, encoding: 'utf8' });
  assert.equal(dirty.status, 0, dirty.stderr);
  const packet = JSON.parse(dirty.stdout);
  assert.equal(packet.status, 'worktree-review-required');
  assert.equal(packet.ready, false);
  assert.match(JSON.stringify(packet.changes), /unreviewed.txt/);
  assert.equal(f.git(['branch', '--list', 'ENTRY-1']), '');
});
