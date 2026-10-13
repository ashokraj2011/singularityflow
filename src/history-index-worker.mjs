// Writes Git's changed-path index for one repository; started detached by history-index.mjs.
import { HISTORY_INDEX_WRITE } from './history-index.mjs';
import { run } from './util.mjs';

const root = process.argv[2];
if (root) run('git', HISTORY_INDEX_WRITE, { cwd: root, allowFailure: true, timeoutMs: 30 * 60 * 1000 });
