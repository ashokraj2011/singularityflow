import { withCommandConfirmation } from '../command-confirmation.mjs';
import { withCommandObservability } from '../command-observability.mjs';
import { approvalInbox, approvalInboxText } from '../inbox.mjs';
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';
import { resolveSessionRepository } from './shared/session-repository-selection.mjs';
import { sessionDiscoveryConfiguration } from './shared/session-discovery-configuration.mjs';
import { withApprovedConfigurationRead } from '../approved-configuration-reader.mjs';

export async function run(argv, { positionals, options }) {
  return withCommandObservability(positionals[0], argv, options,
    () => withCommandConfirmation(options, () => inboxCommand(options)));
}

export async function inboxCommand(options) {
  const selected = await resolveSessionRepository({ workspaceReference: optionString(options, 'workspace'),
    repositoryId: optionString(options, 'repository'), remoteProbe: !optionBoolean(options, 'offline') });
  const root = selected.root;
  if (!root) throw new SingularityFlowError(selected.detail ?? 'Select a readable workspace repository.', {
    code: 'SESSION_REPOSITORY_UNAVAILABLE'
  });
  const { definition: config } = await withApprovedConfigurationRead(root,
    () => sessionDiscoveryConfiguration(root, selected.authority));
  const snapshot = await approvalInbox(root, config, { fetch: !optionBoolean(options, 'offline') });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(snapshot, null, 2));
  process.stdout.write(approvalInboxText(snapshot));
}
