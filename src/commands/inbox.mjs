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

/**
 * The inbox of a workspace member that is not cloned yet, read from its remote by URL exactly as
 * session candidates are: no application checkout is created. Offline, it says what it could not
 * read and how the member is cloned.
 */
async function deferredInbox(selected, { offline }) {
  const context = selected.workspaceContext;
  const base = { repositoryId: context.repositoryId, repositoryState: 'deferred', materialize: selected.materialize };
  if (offline) {
    return { remote: 'origin', fetched: false, source: 'deferred-repository', stateRef: null, repositoryPath: null,
      generatedAt: new Date().toISOString(), count: 0, items: [], unavailableCount: 0, unavailable: [],
      ...base, detail: `${selected.detail} Run the inbox without --offline to read its Stories from the remote.` };
  }
  const { readWorkspace } = await import('../workspace-manifest.mjs');
  const workspace = await readWorkspace(context.workspacePath);
  const member = workspace.repositories?.[context.repositoryId];
  const lead = workspace.repositories?.[workspace.leadRepository];
  const configurationUrl = workspace.capabilityAuthority?.url ?? lead?.url;
  if (workspace.id !== context.workspaceId || !member?.url || !configurationUrl) {
    throw new SingularityFlowError(selected.detail, { code: 'SESSION_REPOSITORY_UNAVAILABLE' });
  }
  const { discoverRemoteStoryCandidatesByUrl } = await import('../session-remote-url-discovery.mjs');
  const roster = await discoverRemoteStoryCandidatesByUrl(member.url, { configurationUrl, includeState: true });
  return { ...await approvalInbox(null, null, { roster }), ...base };
}

export async function inboxCommand(options) {
  const selected = await resolveSessionRepository({ workspaceReference: optionString(options, 'workspace'),
    repositoryId: optionString(options, 'repository'), remoteProbe: !optionBoolean(options, 'offline') });
  const root = selected.root;
  if (!root && selected.reason === 'workspace-repository-deferred') {
    const snapshot = await deferredInbox(selected, { offline: optionBoolean(options, 'offline') });
    if (optionBoolean(options, 'json')) return console.log(JSON.stringify(snapshot, null, 2));
    return process.stdout.write(snapshot.detail ? `${snapshot.detail}\n` : approvalInboxText(snapshot));
  }
  if (!root) throw new SingularityFlowError(selected.detail ?? 'Select a readable workspace repository.', {
    code: 'SESSION_REPOSITORY_UNAVAILABLE'
  });
  const { definition: config } = await withApprovedConfigurationRead(root,
    () => sessionDiscoveryConfiguration(root, selected.authority));
  const snapshot = await approvalInbox(root, config, { fetch: !optionBoolean(options, 'offline') });
  if (optionBoolean(options, 'json')) return console.log(JSON.stringify(snapshot, null, 2));
  process.stdout.write(approvalInboxText(snapshot));
}
