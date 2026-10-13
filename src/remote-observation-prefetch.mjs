/**
 * The Story branch's remote tip, asked for when a publishing command starts. `[perf]`
 *
 * Before it changes anything, `commitAndPublish` asks the remote for the branch's tip
 * (`ls-remote`), so a clone that fell behind is refused with nothing changed, and the push is then
 * leased to that exact tip. That round trip, about a second or more against a hosted remote,
 * waited until the command reached its publication: after about a second of local loading and
 * checking in `phase publish`, `submit` and `approve`. Those commands now ask when they have loaded
 * the Story, and the answer arrives while the checks run.
 *
 * An early answer is used only by the same ask (checkout, remote URL and branch), once, and only
 * when this process pushed nothing since it was asked: a push of its own (a retained commit
 * published first, for example) can move the tip it reports. An answer older than
 * `MAXIMUM_AGE_MS` is asked again. Anything else asks the remote at publication, exactly as before.
 * A remote that another clone moves in between is refused by the leased push, as it already could
 * be between the ask and the push. A command that ends without publishing abandons its ask instead
 * of waiting for the remote.
 *
 * Pushes are counted where every remote Git operation starts (`remotePushCount`).
 */
import { realpathSync } from 'node:fs';

import { remotePushCount } from './git-execution.mjs';

const MAXIMUM_AGE_MS = 15_000;
const asked = new Map();

// The entry and the handler may spell the same checkout differently; one ask must serve both.
function askKey(root, remote, branch) {
  let checkout = root;
  try { checkout = realpathSync(root); } catch { /* the spelling given */ }
  return JSON.stringify([checkout, remote, branch]);
}

/**
 * Ask now. `observe(root, remote, branch, { signal })` is `exactRemoteBranchObservationAsync`.
 * A failed ask is never an answer: publication then asks itself and reports the failure as before.
 */
export function prefetchRemoteBranchObservation(root, remote, branch, observe) {
  const key = askKey(root, remote, branch);
  if (asked.has(key)) return;
  const controller = new AbortController();
  const answer = Promise.resolve()
    .then(() => observe(root, remote, branch, { signal: controller.signal }))
    .then((value) => ({ value }), () => null);
  asked.set(key, { controller, answer, pushes: remotePushCount(), at: performance.now() });
}

/** The early answer to exactly this ask, once, or null: ask the remote now instead. */
export async function takeRemoteBranchObservation(root, remote, branch) {
  const key = askKey(root, remote, branch);
  const entry = asked.get(key);
  if (!entry) return null;
  asked.delete(key);
  if (entry.pushes !== remotePushCount() || performance.now() - entry.at > MAXIMUM_AGE_MS) {
    entry.controller.abort();
    return null;
  }
  const settled = await entry.answer;
  return settled && entry.pushes === remotePushCount() ? settled.value : null;
}

/** Stop every outstanding ask: the command is ending, so nobody will use the answer. */
export function abandonRemoteBranchObservations() {
  for (const { controller } of asked.values()) controller.abort();
  asked.clear();
}
