/**
 * The registered World Model (WMB v4) is off unless a repository sets `worldModel.registered: on`:
 * nothing builds, reads, verifies or asks for it, a Story that pinned it continues without it, and
 * phase prompts carry the Repository brief read from the source.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { groundingMode } from '../src/grounding.mjs';
import { effectiveGroundingMode, registeredWorldModelOn } from '../src/world-model-policy.mjs';
import { enableRegisteredWorldModel } from './helpers/registered-world-model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'bin', 'singularity-flow.mjs');

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function initialized(t) {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-registered-off-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  git(repository, 'init', '-q', '-b', 'main');
  git(repository, 'config', 'user.name', 'Registered Off');
  git(repository, 'config', 'user.email', 'registered-off@example.invalid');
  await writeFile(path.join(repository, 'app.mjs'), 'export const value = 1;\n');
  await initializeDefinition(repository);
  git(repository, 'add', '-A');
  git(repository, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'initialize');
  return repository;
}

function cli(repository, ...args) {
  return spawnSync(process.execPath, [bin, '--no-model', ...args], {
    cwd: repository, encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_DISABLE_TIMING_LOG: '1' }
  });
}

test('grounding is off unless the registered World Model is on, whatever a Story pinned', () => {
  const pinnedWarn = { resolution: { worldModelGrounding: 'warn' } };
  assert.equal(registeredWorldModelOn({}), false);
  assert.equal(groundingMode({ worldModel: { grounding: 'warn' } }), 'off');
  assert.equal(groundingMode({ worldModel: { grounding: 'warn' } }, pinnedWarn), 'off', 'a Story that pinned warn continues without it');
  assert.equal(effectiveGroundingMode({ worldModel: { registered: 'off', grounding: 'enforce' } }, pinnedWarn), 'off');
  const on = { worldModel: { registered: 'on', grounding: 'enforce' } };
  assert.equal(groundingMode(on), 'warn', 'with it on, enforce still acts as warn');
  assert.equal(groundingMode(on, pinnedWarn), 'warn');
  assert.equal(groundingMode(on, { resolution: { worldModelGrounding: 'off' } }), 'off');
});

test('the packaged configuration writes registered: off, and a wrong value is refused', async (t) => {
  const repository = await initialized(t);
  assert.match(await readFile(path.join(repository, 'singularity/workflow.yml'), 'utf8'), /^ {2}registered: off$/mu);
  assert.equal((await loadDefinition(repository)).worldModel.registered, 'off');
  const file = path.join(repository, 'singularity/workflow.yml');
  await writeFile(file, (await readFile(file, 'utf8')).replace('  registered: off', '  registered: sometimes'));
  await assert.rejects(loadDefinition(repository), /worldModel\.registered must be off or on; got 'sometimes'/u);
});

test('while it is off, registered commands refuse, status answers off, and nothing asks for a build', async (t) => {
  const repository = await initialized(t);
  const status = cli(repository, 'wm', 'status', '--json');
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout), {
    format: 'registered-v4', registered: 'off', status: 'off', ready: false,
    message: 'The registered World Model is off. Phase prompts get the repository brief read from the source: singularity-flow wm brief --phase PHASE.'
  });
  const build = cli(repository, 'wm', 'build', '--json');
  assert.notEqual(build.status, 0);
  const refusal = `${build.stdout}${build.stderr}`;
  assert.match(refusal, /WMB_REGISTERED_OFF|The registered World Model is off in this repository, so wm build has nothing to work on/u);
  assert.match(refusal, /singularity-flow wm brief --phase PHASE/u);
  assert.doesNotMatch(refusal, /wm build --format registered-v4|refresh-authority/u, 'the recovery plan never suggests building it');
  const migration = cli(repository, 'wm', 'migrate-views', '--dry-run', '--json');
  assert.equal(migration.status, 0, migration.stderr);
  assert.equal(JSON.parse(migration.stdout).status, 'off');
  // A configuration still naming retired v3 views is not worth a doctor warning: views are not used.
  const file = path.join(repository, 'singularity/workflow.yml');
  await writeFile(file, (await readFile(file, 'utf8')).replace('  views: [arch.contracts@4, biz.rules@4, dev.hotspots@4, dev.impact@4]', '  views: [business, development]'));
  const doctor = cli(repository, 'doctor', '--json');
  assert.doesNotMatch(`${doctor.stdout}${doctor.stderr}`, /world-model-views|retired legacy-v3 World Model reference/u);
  assert.equal(git(repository, 'status', '--porcelain'), 'M singularity/workflow.yml', 'nothing else was written');
});

test('the grounding inspector answers off without reading the state branch', async (t) => {
  const repository = await initialized(t);
  const { inspectConfiguredGrounding, loadWorldModelConfig } = await import('../src/worldmodel.mjs');
  const inspected = await inspectConfiguredGrounding(repository, await loadWorldModelConfig(repository), 'implementation', { refreshRemote: true });
  assert.equal(inspected.off, true);
  assert.deepEqual([inspected.availability.status, inspected.availability.ready, inspected.command, inspected.reason], ['off', false, null, null]);
  // Turned on, the same repository has no published model and says how to build one.
  await enableRegisteredWorldModel(repository);
  const on = await inspectConfiguredGrounding(repository, await loadWorldModelConfig(repository), 'implementation', { refreshRemote: false });
  assert.notEqual(on.availability.status, 'off');
  assert.match(String(on.command), /wm (build|refresh-authority|doctor)/u);
});

test('a Story history pin is not consumed or verified while it is off', async () => {
  const { verifyGroundingRecord } = await import('../src/grounding.mjs');
  const workflow = {
    workItem: { id: 'OFF-1' },
    resolution: { worldModelGrounding: 'warn', worldModelHistoryPin: { status: 'active' } },
    phases: { implementation: { id: 'implementation', generation: 1 } }
  };
  const result = await verifyGroundingRecord(os.tmpdir(), { worldModel: {} }, workflow, workflow.phases.implementation, { generation: 1 });
  assert.deepEqual(result, { mode: 'off', errors: [], warnings: [], passes: [], record: null, path: null });
});

test('VS Code: the Configuration Center offers no build while it is off', async () => {
  const source = (name) => path.join(root, 'apps', 'vscode', 'src', 'views', name);
  const { configurationCenterView } = await import(source('configuration-center-model.ts'));
  const { configurationCenterHtml } = await import(source('configuration-center-page.ts'));
  const snapshot = {
    identities: { git: { name: 'Casey Dev', email: 'casey@example.com', login: 'caseydev' }, github: 'caseydev' },
    configurationState: { editor: 'effective', effective: null, candidate: null },
    worldModel: { root: 'singularity/world-model', format: 'registered-v4', registered: 'off', views: [] }
  };
  const off = configurationCenterHtml(configurationCenterView(snapshot, { name: 'Casey', role: 'architect' }), 'world-model', null, null, null, []);
  assert.match(off, /The registered World Model is off in this repository/u);
  assert.doesNotMatch(off, /data-action="(build|rebuild)-world-model"/u);
  assert.doesNotMatch(off, /no world model yet/u);
  const on = configurationCenterHtml(configurationCenterView({ ...snapshot, worldModel: { ...snapshot.worldModel, registered: 'on' } }, { name: 'Casey', role: 'architect' }), 'world-model', null, null, null, []);
  assert.match(on, /data-action="rebuild-world-model"/u);
});
