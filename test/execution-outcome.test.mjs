import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveExecutionOutcome } from '../src/execution-outcome.mjs';

test('execution outcome follows the required structured precedence matrix', () => {
  const cases = [
    [{ cancelled: true, timedOut: true, exitCode: 0 }, ['cancelled', 'runtime']],
    [{ timedOut: true, spawnErrorCode: 'ENOENT', exitCode: 0 }, ['timed-out', 'runtime']],
    [{ started: false, exitCode: 0 }, ['not-started', 'runtime']],
    [{ spawnErrorCode: 'ENOENT' }, ['not-started', 'runtime']],
    [{ signal: 'SIGTERM', exitCode: null }, ['failed', 'process-signal']],
    [{ exitCode: 0 }, ['succeeded', 'process-exit']],
    [{ exitCode: 7 }, ['failed', 'process-exit']],
    [{}, ['unknown', 'unavailable']]
  ];
  for (const [input, [state, authority]] of cases) {
    const outcome = resolveExecutionOutcome(input);
    assert.equal(outcome.state, state);
    assert.equal(outcome.authority, authority);
    assert.equal(Object.isFrozen(outcome), true);
  }
});

test('execution outcome API contains no text-derived authority input', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(
    new URL('../src/execution-outcome.mjs', import.meta.url), 'utf8'
  ));
  assert.doesNotMatch(source, /raw|stdout|stderr|diagnostics|regularExpression|testCounts/);
});
