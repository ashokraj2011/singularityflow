import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runSgosProcess, stepSgosProcess
} from '../src/sgos/public-runtime.mjs';

test('public runtime cannot silently grant model invocation authority', async () => {
  for (const [name, invoke] of [
    ['stepSgosProcess', () => stepSgosProcess('/not-opened', 'PROC-NOT-OPENED', {
      allowModel: true
    })],
    ['runSgosProcess', () => runSgosProcess('/not-opened', 'PROC-NOT-OPENED', {
      allowModel: true,
      maximumParallel: 1
    })]
  ]) {
    await assert.rejects(invoke, (error) =>
      error.code === 'SGOS_PUBLIC_OPTIONS_INVALID'
      && error.details.operation === name
      && error.details.unexpected.includes('allowModel'));
  }
});
