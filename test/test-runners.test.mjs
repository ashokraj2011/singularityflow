/**
 * The runner table: what each consumer reads from it, and that a row stays consistent. The behaviour each column
 * drives is pinned by that consumer's own tests; a row that drifted from them would fail there.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_RESULT_ADAPTERS } from '../src/external-command-policy.mjs';
import { isRunnerConfigurationName, runnerNameOfAdapter, runnerNameOfLauncher, runnerNamed, runnerOfLauncher, selectingRunner, TEST_RUNNERS, TOOLS_ON_PATH } from '../src/test-runners.mjs';

test('every row has a person\'s word and the programs that start it, and no two rows claim one program', () => {
  const seen = new Set();
  for (const [key, row] of Object.entries(TEST_RUNNERS)) {
    assert.ok(row.name, key);
    assert.ok(row.launchers.length, key);
    for (const launcher of row.launchers) { assert.ok(!seen.has(launcher), `${launcher} in two rows`); seen.add(launcher); }
    if (row.adapter) assert.ok(TEST_RESULT_ADAPTERS.includes(row.adapter), `${key}: ${row.adapter} is no adapter a command can name`);
    if (row.selection) assert.ok(row.selection.valueless.every((option) => row.selection.filters.includes(option)), `${key}: a valueless option it does not filter by`);
    assert.equal(runnerNamed(row.name)?.key, key);
  }
});

test('what consumers ask of it', () => {
  assert.equal(runnerNameOfAdapter('vitest-json'), 'Vitest');
  assert.equal(runnerNameOfAdapter('junit-xml'), null, 'a JUnit report says nothing about who wrote it');
  assert.equal(runnerNameOfLauncher('react-scripts'), 'Jest');
  assert.equal(runnerNameOfLauncher('node'), null, '`node` alone says nothing about tests');
  assert.equal(runnerOfLauncher('mvnw').key, 'maven');
  assert.equal(selectingRunner('tox'), 'pytest', 'tox runs pytest for you');
  assert.equal(selectingRunner('nx'), null, 'a runner with no selection column reads the generic options');
  assert.equal(TOOLS_ON_PATH.mvn, 'Maven');
  assert.equal(isRunnerConfigurationName('playwright.config.ts'), true);
  assert.equal(isRunnerConfigurationName('conftest.py'), true);
  assert.equal(isRunnerConfigurationName('package.json'), false);
});
