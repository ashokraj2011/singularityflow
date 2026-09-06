import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { nodeTypeScriptFlags } from '../scripts/typescript-runtime.mjs';

test('TypeScript source execution uses the bounded loader throughout supported Node 20', () => {
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '20.0.0'), [
    '--experimental-loader', path.join('/fixture', 'scripts', 'typescript-test-loader.mjs')
  ]);
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '20.20.2'), [
    '--experimental-loader', path.join('/fixture', 'scripts', 'typescript-test-loader.mjs')
  ]);
});

test('TypeScript source execution selects native stripping only when Node provides it', () => {
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '22.5.1'), [
    '--experimental-loader', path.join('/fixture', 'scripts', 'typescript-test-loader.mjs')
  ]);
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '22.6.0'), [
    '--experimental-strip-types', '--no-warnings=ExperimentalWarning'
  ]);
  assert.deepEqual(nodeTypeScriptFlags('/fixture', '24.1.0'), [
    '--experimental-strip-types', '--no-warnings=ExperimentalWarning'
  ]);
  assert.throws(() => nodeTypeScriptFlags('/fixture', '19.9.0'), /Node\.js 20 or newer/);
});
