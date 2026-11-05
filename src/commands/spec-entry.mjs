/**
 * `spec`: Spec Studio's everyday reads and saves run here, and every other `spec` subcommand stays in
 * the legacy dispatcher. Through that dispatcher each `spec author status` and autosave `edit` loaded
 * the whole compatibility and model graph, some hundreds of milliseconds per save, for nothing they use.
 */
import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';

const OWN_SUBCOMMANDS = new Set(['author', 'split']);

export async function load({ positionals }) {
  if (!OWN_SUBCOMMANDS.has(positionals[1])) await (await import('./legacy.mjs')).load();
}

/** The command log, harness record and soft-gate overrides the legacy dispatcher gave these. */
export async function run(argv, { positionals, options }) {
  if (!OWN_SUBCOMMANDS.has(positionals[1])) return (await import('./legacy.mjs')).run(argv);
  return withCommandObservability(positionals[0], argv, options, () => withCommandConfirmation(options,
    async () => (await import('./spec-author.mjs')).specAuthorCommand(positionals, options)));
}
