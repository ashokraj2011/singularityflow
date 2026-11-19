/** The one process that waits for an idle laptop and then starts the automatic work queued meanwhile (automatic-work.mjs). */
import { runQueuedAutomaticWork } from './automatic-work.mjs';

await runQueuedAutomaticWork().catch(() => { process.exitCode = 1; });
