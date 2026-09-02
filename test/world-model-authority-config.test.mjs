import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { run } from '../src/util.mjs';
import { worldModelStateAuthority } from '../src/world-model/authority-config.mjs';

test('World-Model state authority prefers the ledger remote over application transport', () => {
  assert.deepEqual(worldModelStateAuthority({
    ledger: { branch: 'governed-state', remote: 'authority' },
    worldModel: { stateBranch: 'wm-state', remote: 'world-model-mirror' },
    git: { remote: 'application' }
  }), { branch: 'wm-state', remote: 'authority' });
  assert.deepEqual(worldModelStateAuthority({
    worldModel: { remote: 'world-model-mirror' }, git: { remote: 'application' }
  }), { branch: 'state', remote: 'world-model-mirror' });
  assert.deepEqual(worldModelStateAuthority({ git: { remote: 'application' } }), {
    branch: 'state', remote: 'application'
  });
  assert.deepEqual(worldModelStateAuthority({}), { branch: 'state', remote: 'origin' });
  assert.deepEqual(worldModelStateAuthority({}, {
    branch: 'injected-state', remote: 'injected-remote'
  }), { branch: 'injected-state', remote: 'injected-remote' });
  assert.deepEqual(worldModelStateAuthority({
    ledger: { branch: 'ledger-state' }, git: { remote: 'application' }
  }, {
    branch: 'resolved-state', remote: 'resolved-authority'
  }), { branch: 'resolved-state', remote: 'resolved-authority' });
});

test('canonical configuration preserves authored state-authority fallback precedence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-world-model-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await initializeDefinition(root);
  const file = path.join(root, 'singularity', 'workflow.yml');
  const authored = YAML.parse(await readFile(file, 'utf8'));
  authored.git.remote = 'application-remote';
  authored.ledger.branch = 'ledger-state';
  authored.ledger.remote = 'ledger-authority';
  authored.worldModel.stateBranch = 'world-model-state';
  authored.worldModel.remote = 'world-model-authority';
  await writeFile(file, YAML.stringify(authored));

  const explicitLedger = await loadDefinition(root);
  assert.deepEqual(worldModelStateAuthority(explicitLedger), {
    branch: 'world-model-state', remote: 'ledger-authority'
  });
  assert.equal(explicitLedger.ledger.remote, 'ledger-authority');
  assert.equal(explicitLedger.ledger.branch, 'world-model-state');

  delete authored.ledger.remote;
  await writeFile(file, YAML.stringify(authored));
  const worldModelFallback = await loadDefinition(root);
  assert.deepEqual(worldModelStateAuthority(worldModelFallback), {
    branch: 'world-model-state', remote: 'world-model-authority'
  });
  assert.equal(worldModelFallback.ledger.remote, 'world-model-authority');

  delete authored.worldModel.remote;
  await writeFile(file, YAML.stringify(authored));
  const applicationFallback = await loadDefinition(root);
  assert.deepEqual(worldModelStateAuthority(applicationFallback), {
    branch: 'world-model-state', remote: 'application-remote'
  });
  assert.equal(applicationFallback.ledger.remote, 'application-remote');
});
