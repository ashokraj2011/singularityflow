import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { repoRoot } from '../git.mjs';
import { approvalInbox, approvalInboxText } from '../inbox.mjs';
import { loadConfig } from '../state-stores.mjs';
import { optionBoolean } from '../util.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => inboxCommand(options)));
}

export async function inboxCommand(options) {
  const root = repoRoot();
  const config = await loadConfig(root);
  const snapshot = await approvalInbox(root, config, { fetch: !optionBoolean(options, 'offline') });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(snapshot, null, 2));
  process.stdout.write(approvalInboxText(snapshot));
}
