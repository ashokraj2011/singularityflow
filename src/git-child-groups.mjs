/**
 * Detached Git children end when the process that started them ends.
 *
 * Remote Git runs in its own process group so a deadline can reach its credential helpers and
 * transports with one signal (git-execution.mjs). That also means a signal sent to this process's
 * group misses it: VS Code stops a CLI call by signalling the call's group, and Copilot stops a
 * shell command the same way. A fetch blocked reading an undownloaded cloud file kept running for
 * as long as its read stayed blocked, long after the command that wanted it had gone.
 *
 * Live groups are therefore ended on exit and on SIGTERM, SIGINT and SIGHUP. A termination signal
 * nothing else handles still terminates the process, by re-raising it once the groups are gone.
 */
const live = new Set();
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
let installed = false;

function endLiveGroups() {
  for (const pid of live) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
  live.clear();
}

function onSignal(signal) {
  endLiveGroups();
  if (process.listenerCount(signal) > 1) return;
  for (const name of SIGNALS) process.removeListener(name, onSignal);
  process.removeListener('exit', endLiveGroups);
  installed = false;
  process.kill(process.pid, signal);
}

/** Track one detached child's group until it settles; returns the function that stops tracking. */
export function trackGitGroup(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return () => {};
  live.add(pid);
  if (!installed) {
    installed = true;
    process.on('exit', endLiveGroups);
    for (const name of SIGNALS) process.on(name, onSignal);
  }
  return () => { live.delete(pid); };
}
