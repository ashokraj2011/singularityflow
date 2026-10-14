/**
 * The bundled CLI's one entry (scripts/build-cli-bundle.mjs): the dispatcher and its error boundary
 * in the same file, so both share one copy of every module they have in common.
 */
export { main } from './cli-entry.mjs';
export { reportCliFailure } from './cli-failure.mjs';
