import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = async (relative) => readFile(path.join(root, 'templates/artifacts', relative), 'utf8');

test('terminal Story templates show one namespace-qualified approved clause per comparison row', async () => {
  for (const relative of [
    'benchmark/conformance.md',
    'classic-delivery/code-checking.md',
    'common/conformance.md',
    'figma-mobile/conformance.md',
    'spec-code-test-loop/conformance.md',
    'spec-driven/release.md'
  ]) {
    const source = await artifact(relative);
    assert.match(source, /one exact (?:namespace-)?qualified|one exact qualified|one exact namespace-qualified/i,
      `${relative} must explain the row identity contract`);
    assert.match(source, /\| `\{\{work\.id\}\}:(?:REQ|AC)-001` \|/,
      `${relative} must model a qualified first-column clause`);
    assert.doesNotMatch(source, /^\|\s*AC-001\s*\/\s*SPEC-001\s*\|/m,
      `${relative} must not combine a criterion with a design ID`);
  }
});

test('implementation and verification templates distinguish source witnesses from executable tests', async () => {
  const implementation = await artifact('common/implementation.md');
  const verification = await artifact('common/verification.md');
  assert.match(implementation, /@clause:\{\{work\.id\}\}:REQ-001/);
  assert.match(implementation, /@ac:\{\{work\.id\}\}:AC-001/);
  assert.match(verification, /@clause:\{\{work\.id\}\}:REQ-001/);
  assert.match(verification, /@ac:\{\{work\.id\}\}:AC-001/);
  assert.match(verification, /does not establish a passing verdict/);
});
