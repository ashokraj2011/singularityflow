/** Progress observation over the existing installer process owner; no second process supervisor. */
import { installerProcess } from '../install.mjs';

export async function processCommand(command, args, { onProgress, ...options } = {}) {
  let pending = Promise.resolve(), observationError = null;
  const timer = onProgress ? setInterval(() => {
    pending = pending.then(onProgress).catch(error => { observationError = error; });
  }, 3000) : null;
  try {
    const result = await installerProcess(command, args, options);
    await pending;
    if (observationError) throw observationError;
    return result;
  } finally {
    clearInterval(timer);
    await pending;
  }
}
