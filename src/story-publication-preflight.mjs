import { runRemoteGitAsync } from './git-execution.mjs';
import { classifyGitRemoteFailure, frozenRemoteTransport, gitFailureDiagnostic, redactDiagnosticText } from './git-remote-diagnostics.mjs';
import { SingularityFlowError } from './util.mjs';

// This checks transport access, not application tests or provider receive hooks. The actual push
// must still run the repository's pre-push hook and satisfy its create-only remote lease.
export async function probeStoryBranchPublication(root, remote, sourceRef, destinationRef, { runGit = runRemoteGitAsync } = {}) {
  const transport = frozenRemoteTransport(remote, { push: true });
  return runGit(['push', '--dry-run', '--no-verify', '--porcelain', transport.remote,
    `${sourceRef}:${destinationRef}`], {
    cwd: root, operation: 'remote-push', allowFailure: true, env: transport.env
  });
}

export function storyPublicationPreflightError(result, { branch, remote, repository = null }) {
  const remoteFailure = { ...classifyGitRemoteFailure(result), diagnostics: gitFailureDiagnostic(result) };
  return new SingularityFlowError(
    `Cannot publish Story branch '${redactDiagnosticText(branch)}'${repository ? ` for required repository '${redactDiagnosticText(repository)}'` : ''} to '${redactDiagnosticText(remote)}'. `
    + `${remoteFailure.advice}\n${remoteFailure.diagnostics}\n`
    + 'This transport-only probe did not publish a remote Story branch or run local Git hooks. Local fetch/cache state may have refreshed; SFlow did not modify application files or the index during this probe.', {
      code: 'STORY_PUBLICATION_PREFLIGHT_FAILED',
      details: { remoteFailure, publicationPreflight: { scope: 'transport-only', localHooks: 'not-run',
        remoteStoryBranch: 'not-updated', applicationFiles: 'not-modified-by-probe',
        index: 'not-modified-by-probe', localRefs: 'may-have-refreshed', remotePolicyVerified: false } }
    });
}
