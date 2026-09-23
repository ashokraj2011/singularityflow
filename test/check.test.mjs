import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isModelRoutingSource, portableCheckPath } from '../scripts/check-path-policy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('model-name routing source selection is identical for POSIX and Windows paths', () => {
  const cases = [
    ['plugin/skills/sflow-plan/SKILL.md', true],
    ['templates/workflow.yml', true],
    ['templates/agents/developer.agent.md', true],
    ['src/command-registry.mjs', true],
    ['templates/modelTiers.yml', false],
    ['test/model-tiers.test.mjs', false],
    ['docs/model-routing.md', false]
  ];
  for (const [relative, expected] of cases) {
    assert.equal(isModelRoutingSource(relative), expected, relative);
    const windows = relative.replaceAll('/', '\\');
    assert.equal(isModelRoutingSource(windows), expected, windows);
    assert.equal(portableCheckPath(windows), relative, windows);
  }
});

test('deterministic check ignores generated files excluded by Git', async () => {
  const directory = path.join(root, 'coverage', 'ignored-check-probe');
  const probe = path.join(directory, 'invalid-generated-file.mjs');
  await mkdir(directory, { recursive: true });
  await writeFile(probe, 'this is intentionally invalid generated JavaScript\n');
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'scripts/check.mjs')], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /invalid-generated-file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the generated operation catalog is current and has one canonical final newline', async () => {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/generate-operation-catalog.mjs')], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const catalog = await readFile(path.join(root, 'docs', 'OPERATION-MODEL-POLICY.md'), 'utf8');
  assert.ok(catalog.endsWith('\n'));
  assert.ok(!catalog.endsWith('\n\n'), 'generated catalogs must not create a trailing blank line');
});
