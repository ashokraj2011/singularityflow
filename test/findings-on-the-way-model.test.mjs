/** CQF:REQ-066: what a code step does with each register item on what it touches, and where an item falls. Pure, made-up IDs. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readFindingsConfig } from '../src/findings/register/config.mjs';
import { itemKind, itemPlace, onTheWayAction, touchedModules } from '../src/findings/register/on-the-way.mjs';

const code = (fields = {}) => ({ id: 'SEC-1', feed: 'security', type: 'code', severity: 'critical', title: 'Query built from input', file: 'src/a.mjs', rule: 'js/sql-injection', ...fields });
const upgrade = (fields = {}) => ({ id: 'TLM-1', feed: 'tlm', component: 'quillmark-parse', currentVersion: '2.4.1', targetVersion: '2.4.3', ...fields });

test('decision 19: patch and minor upgrades and critical or high code findings with a known fix are fixed; a major upgrade is for a person', () => {
  assert.deepEqual(onTheWayAction(upgrade()), { action: 'fix', upgrade: 'patch', from: '2.4.1', to: '2.4.3' });
  assert.equal(onTheWayAction(upgrade({ targetVersion: '2.6.0' })).upgrade, 'minor');
  assert.deepEqual(onTheWayAction(upgrade({ targetVersion: '3.0.0' })).action, 'person');
  assert.equal(onTheWayAction(code()).action, 'fix');
  assert.equal(onTheWayAction(code({ severity: 'high', rule: null, description: 'Use a parameterised query.' })).action, 'fix');
  assert.match(onTheWayAction(code({ severity: 'medium' })).reason, /only critical and high code findings/u);
  assert.match(onTheWayAction(code({ rule: null })).reason, /no fix is known/u);
  const dependency = { id: 'SEC-2', feed: 'security', type: 'dependency', severity: 'high', package: 'vexil-router', installedVersion: '3.2.0' };
  assert.equal(itemKind(dependency), 'dependency');
  assert.equal(onTheWayAction({ ...dependency, fixedVersion: '3.2.5' }).action, 'fix');
  assert.equal(onTheWayAction({ ...dependency, fixedVersion: '4.1.0' }).action, 'person');
  assert.match(onTheWayAction(dependency).reason, /no fixed version is known/u);
  assert.match(onTheWayAction({ id: 'SEC-3', feed: 'security', type: 'configuration', severity: 'critical' }).reason, /configuration finding is listed/u);
  // The version a touched manifest pins stands in for a missing current version, and one already at the target is proven later.
  assert.equal(onTheWayAction(upgrade({ currentVersion: null }), { pinned: '^2.4.1' }).upgrade, 'patch');
  assert.match(onTheWayAction(upgrade(), { pinned: '2.4.3' }).reason, /already pins 2\.4\.3 or later/u);
  assert.match(onTheWayAction(code(), { policy: 'list' }).reason, /fixes none on the way/u);
  assert.equal(onTheWayAction(upgrade({ targetVersion: '3.0.0' }), { policy: 'list' }).action, 'person', 'a major upgrade is a person\'s under every policy');
});

test('an item falls on a planned or changed file, or on the manifest of a module a touched file belongs to', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-on-the-way-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'services', 'billing', 'src'), { recursive: true });
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'quillmark-parse': '2.4.1' } }));
  await writeFile(path.join(root, 'services', 'billing', 'package.json'), JSON.stringify({ dependencies: { 'vexil-router': '3.2.0' } }));
  await writeFile(path.join(root, 'services', 'billing', 'package-lock.json'), '{}');
  const modules = touchedModules(root, ['services/billing/src/pay.mjs']);
  assert.deepEqual(modules, [{ directory: 'services/billing', files: ['services/billing/package.json', 'services/billing/package-lock.json'] }]);
  const { readFileSync } = await import('node:fs');
  const read = (file) => { try { return readFileSync(path.join(root, file), 'utf8'); } catch { return null; } };
  const touched = { changed: new Set(['services/billing/src/pay.mjs']), planned: new Set(['src/a.mjs']), modules, read };
  assert.deepEqual(itemPlace(code(), touched), { files: ['src/a.mjs'], on: 'a file the plan names' });
  assert.equal(itemPlace(code({ file: 'src/b.mjs' }), touched), null);
  assert.deepEqual(itemPlace(upgrade({ component: 'vexil-router' }), touched),
    { files: ['services/billing/package.json'], on: 'a manifest of a module the Story touches', pinned: '3.2.0' });
  assert.equal(itemPlace(upgrade(), touched), null, 'the root module is not touched');
  assert.equal(itemPlace({ id: 'SEC-4', feed: 'security', type: 'dependency', file: 'services/billing/package-lock.json', package: 'left-out' }, touched).on,
    'a manifest of a module the Story touches');
});

test('findings.yml policy.bringIntoCodeStep is touched by default, list or off per feed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-on-the-way-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual((await readFindingsConfig(root)).policy, { security: { bringIntoCodeStep: 'touched' }, tlm: { bringIntoCodeStep: 'touched' } });
  await mkdir(path.join(root, 'singularity'));
  await writeFile(path.join(root, 'singularity', 'findings.yml'), 'schemaVersion: 1\nsecurity:\n  policy: { bringIntoCodeStep: list }\ntlm:\n  policy: { bringIntoCodeStep: always }\n');
  const config = await readFindingsConfig(root);
  assert.deepEqual(config.policy, { security: { bringIntoCodeStep: 'list' }, tlm: { bringIntoCodeStep: 'touched' } });
  assert.match(config.warnings.join(' '), /tlm\.policy\.bringIntoCodeStep is touched, list, off; touched applies/u);
});
