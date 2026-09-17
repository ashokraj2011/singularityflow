import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import YAML from 'yaml';

import {
  normalizeRepositoryReadinessPolicy,
  validateDefinition
} from '../src/config.mjs';

const DEFAULT_POLICY = Object.freeze({
  requiredBeforeStory: false,
  dependencyHydration: 'when-detected',
  build: 'when-detected',
  structuredTests: 'required-for-code',
  applicationStart: 'when-detected',
  receiptScope: 'git-private-exact-base'
});

async function shippedDefinition() {
  return YAML.parse(await readFile(new URL('../templates/workflow.yml', import.meta.url), 'utf8'));
}

test('repository readiness defaults match the shipped workflow policy', async () => {
  const definition = await shippedDefinition();

  assert.deepEqual(normalizeRepositoryReadinessPolicy(), DEFAULT_POLICY);
  assert.deepEqual(normalizeRepositoryReadinessPolicy({}), definition.repositoryReadiness);

  delete definition.repositoryReadiness;
  validateDefinition(definition);
  assert.deepEqual(definition.repositoryReadiness, DEFAULT_POLICY);
});

test('repository readiness accepts every supported execution mode', () => {
  for (const field of ['dependencyHydration', 'build', 'applicationStart']) {
    for (const mode of ['off', 'when-detected', 'required']) {
      assert.equal(normalizeRepositoryReadinessPolicy({ [field]: mode })[field], mode);
    }
  }
  for (const mode of ['off', 'when-detected', 'required-for-code', 'required']) {
    assert.equal(normalizeRepositoryReadinessPolicy({ structuredTests: mode }).structuredTests, mode);
  }

  assert.deepEqual(normalizeRepositoryReadinessPolicy({
    requiredBeforeStory: true,
    dependencyHydration: 'required',
    build: 'off',
    structuredTests: 'when-detected',
    applicationStart: 'required',
    receiptScope: 'git-private-exact-base'
  }), {
    requiredBeforeStory: true,
    dependencyHydration: 'required',
    build: 'off',
    structuredTests: 'when-detected',
    applicationStart: 'required',
    receiptScope: 'git-private-exact-base'
  });
});

test('repository readiness is a closed, strictly typed policy', async () => {
  for (const value of [null, [], 'required', true]) {
    assert.throws(
      () => normalizeRepositoryReadinessPolicy(value),
      /repositoryReadiness must be an object/
    );
  }

  assert.throws(
    () => normalizeRepositoryReadinessPolicy({ futureControl: 'required' }),
    /unknown field 'futureControl'/
  );

  for (const [field, value, message] of [
    ['requiredBeforeStory', 'false', /requiredBeforeStory must be boolean/],
    ['dependencyHydration', null, /dependencyHydration must be off, when-detected, or required/],
    ['build', true, /build must be off, when-detected, or required/],
    ['structuredTests', 'required-for-docs', /structuredTests must be off, when-detected, required-for-code, or required/],
    ['applicationStart', 1, /applicationStart must be off, when-detected, or required/],
    ['receiptScope', 'repository-cache', /receiptScope must be git-private-exact-base/]
  ]) {
    assert.throws(() => normalizeRepositoryReadinessPolicy({ [field]: value }), message);
  }

  const definition = await shippedDefinition();
  definition.repositoryReadiness = { ...DEFAULT_POLICY, ignored: true };
  assert.throws(() => validateDefinition(definition), /unknown field 'ignored'/);
});
