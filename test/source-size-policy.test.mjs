import assert from 'node:assert/strict';
import test from 'node:test';
import { SOURCE_LINE_BUDGETS, sourceSizeFailures } from '../scripts/source-size-policy.mjs';

test('CLI source size cannot silently regrow; native Windows paths use the same ceiling', () => {
  const ceiling = SOURCE_LINE_BUDGETS['src/cli.mjs'];
  assert.deepEqual(sourceSizeFailures('src/cli.mjs', '\n'.repeat(ceiling)), []);
  assert.equal(sourceSizeFailures('src\\cli.mjs', '\n'.repeat(ceiling + 1)).length, 1);
  assert.deepEqual(sourceSizeFailures('src/commands/new-command.mjs', '\n'.repeat(ceiling + 1)), []);
});
