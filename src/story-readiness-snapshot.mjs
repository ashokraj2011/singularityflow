/** Machine-local advisory preview, never a create/publish permission or an approval receipt. */
import path from 'node:path';
import { cachedStoryReadinessPreview, repositoryCheckStatus, withFreshRepositoryChecks } from './repository-check-cache.mjs';
import { repositoryGitDirectory } from './git-directory.mjs';
import { gitFactCheckout } from './git-fact-cache.mjs';
import { activeWorkspaceFile, workspaceRegistryFile } from './workspace-context.mjs';
import { optionBoolean, optionString, optionStrings } from './util.mjs';

const presentation = new Set(['json', 'for-agent', 'timings', 'timing', 'refresh-readiness']);
export async function storyReadinessSnapshot(root, options, checkout, read) {
  if (!optionBoolean(options, 'selected-base-only') || !optionString(options, 'preflight-story')) return read();
  const identity = Object.entries(options).filter(([key]) => !presentation.has(key)).sort(([a], [b]) => a.localeCompare(b));
  const roots = checkout?.repositories?.map(entry => entry.repositoryPath) ?? [root];
  const branches = optionStrings(options, 'from-branch').map(value => value.includes('=') ? value.slice(value.indexOf('=') + 1) : value);
  const files = [activeWorkspaceFile(), workspaceRegistryFile(),
    ...(checkout?.workspacePath ? [path.join(checkout.workspacePath, 'workspace.json')] : [])];
  for (const member of roots) {
    const common = repositoryGitDirectory(member), privateGit = gitFactCheckout(member)?.gitDir;
    if (!common || !privateGit) return read();
    files.push(path.join(privateGit, 'HEAD'), path.join(privateGit, 'index'),
      path.join(common, 'config'), path.join(common, 'packed-refs'),
      path.join(common, 'singularity-flow/repository-readiness'),
      path.join(member, 'singularity/workflow.yml'), path.join(member, 'singularity/portfolio.yml'),
      path.join(member, 'singularity/work-items', optionString(options, 'preflight-story'), 'workflow.json'),
      path.join(member, '.github/agents'), path.join(member, 'singularity/skills'), path.join(member, 'singularity/instructions'));
    for (const name of [...branches, 'sflow/config', 'state']) files.push(path.join(common, 'refs/remotes/origin', name));
    files.push(path.join(common, 'refs/heads', optionString(options, 'preflight-story')));
  }
  const inspect = () => cachedStoryReadinessPreview(root, { identity, files }, read);
  const value = await (optionBoolean(options, 'refresh-readiness') ? withFreshRepositoryChecks(inspect) : inspect());
  // A receipt ID is only a handoff to the separately sealed, single-use record. Start still
  // verifies every remote input in one fresh wave. Never extend its independent 15-minute expiry.
  const receipt = value.preflight?.intakeReceipt;
  if (receipt?.issued && Date.parse(receipt.expiresAt) <= Date.now()) value.preflight.intakeReceipt = {
    issued: false, reason: 'expired-handoff' };
  const status = repositoryCheckStatus(root);
  return { ...value, readinessSnapshot: { ...status, scope: 'story-readiness-preview', provisional: true,
    publicationAccess: 'checked-on-start', refresh: { command: 'Repeat this readiness command with --refresh-readiness.' } } };
}
