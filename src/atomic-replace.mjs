/** Windows mutation-only replacement; read-only CLI startup never loads this retry loop. */
import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

export async function replaceWithSharingRetry(source, target, { renameCommand = rename, wait = delay } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try { await renameCommand(source, target); return; }
    catch (error) {
      // Retry only the same complete temporary file. Never delete the destination, copy over it,
      // or hide the final native error. The five waits total 620 ms.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt >= 5) throw error;
      await wait(20 * 2 ** attempt);
    }
  }
}
