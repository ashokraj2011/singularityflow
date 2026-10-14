import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { commandDefinition } from '../command-registry.mjs';
import { loadHelpDocument } from '../help.mjs';
import { optionBoolean } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  // Logged like every other command, as it was when cli.mjs dispatched it.
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => helpCommand(positionals, options)));
}

export async function helpCommand(positionals, options) {
  // `help <command>` and `<command> --help` answer the same question, so they render the same page —
  // but only when the name is not already a manual topic. Topics win: several of them share a name
  // with a command, and an existing topic is the richer answer. Note `commandDefinition` throws on
  // an unknown name rather than returning nothing, so the lookup has to be guarded.
  const requested = positionals[1];
  const isCommand = (name) => { try { return Boolean(commandDefinition(name)); } catch { return false; } };
  if (requested && !optionBoolean(options, 'json') && isCommand(requested)) {
    const topic = await loadHelpDocument(requested).catch(() => null);
    if (!topic) {
      const { renderCommandHelp } = await import('../help-pages.mjs');
      return console.log(renderCommandHelp(requested));
    }
  }
  const document = await loadHelpDocument(requested);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(document, null, 2));
  else process.stdout.write(document.content.endsWith('\n') ? document.content : `${document.content}\n`);
}
