import { readFile } from 'node:fs/promises';

import { createGovernedGoal } from '../../src/governed-goals.mjs';

const control = JSON.parse(await readFile(process.argv[2], 'utf8'));
await createGovernedGoal(control.context, control.personal, {
  id: control.id,
  config: control.config,
  now: () => new Date(control.now),
  fault: async (point) => {
    if (point === control.faultPoint) process.kill(process.pid, 'SIGKILL');
  }
});
process.exitCode = 91;
