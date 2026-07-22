import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(root, 'bin', 'singularity-flow.mjs');

function run(...args) {
  return spawnSync(process.execPath, [executable, ...args], {
    cwd: root,
    encoding: 'utf8'
  });
}

test('top-level version flags print only the package version', () => {
  for (const argument of ['--version', '-v', 'version']) {
    const result = run(argument);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '0.8.0');
  }
});

test('top-level help flags print usage', () => {
  for (const argument of ['--help', '-h']) {
    const result = run(argument);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Singularity Flow 0\.8\.0/m);
    assert.match(result.stdout, /singularity-flow start <WORK-ID>/);
    assert.match(result.stdout, /singularity-flow report \[WORK-ID\]/);
    assert.match(result.stdout, /singularity-flow nextsteps \[WORK-ID\]/);
    assert.match(result.stdout, /singularity-flow inputs \[PHASE\]/);
    assert.match(result.stdout, /singularity-flow persona \[WORK-ID\]/);
  }
});

test('package exposes the sflow-next executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['sflow-next'], 'bin/sflow-next.mjs');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].bin['sflow-next'], 'bin/sflow-next.mjs');
  assert.match(await readFile(path.join(root, 'bin/sflow-next.mjs'), 'utf8'), /main\(\['next'/);
});

test('about identifies the brand and exposes the short command namespace', async () => {
  const result = run('about');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Singularity Flow 0\.8\.0/m);
  assert.match(result.stdout, /Singularity product\s+brand/);
  assert.match(result.stdout, /Copilot: \/sflow-<action>/);
  assert.match(result.stdout, /Atomic Git commit\/push state transfer/);
  assert.match(result.stdout, /token and model usage/);
});

test('package exposes the standalone sflow-about executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['sflow-about'], 'bin/sflow-about.mjs');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].bin['sflow-about'], 'bin/sflow-about.mjs');
  assert.match(await readFile(path.join(root, 'bin/sflow-about.mjs'), 'utf8'), /main\(\['about'/);
});

test('package exposes the standalone sflow-persona executable', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.bin['sflow-persona'], 'bin/sflow-persona.mjs');
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].bin['sflow-persona'], 'bin/sflow-persona.mjs');
  assert.match(await readFile(path.join(root, 'bin/sflow-persona.mjs'), 'utf8'), /main\(\['persona'/);
});

test('help command loads the canonical manual and focused topics', () => {
  const manual = run('help');
  assert.equal(manual.status, 0, manual.stderr);
  assert.match(manual.stdout, /^# Singularity Flow Help/m);
  assert.match(manual.stdout, /## Troubleshooting/);
  const topic = run('help', 'git-state-transfer-and-recovery');
  assert.equal(topic.status, 0, topic.stderr);
  assert.match(topic.stdout, /## Git state transfer and recovery/);
  assert.doesNotMatch(topic.stdout, /## Jira intake/);
});
