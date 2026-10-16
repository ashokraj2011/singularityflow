/** Typed canonical reads. No CLI dispatch, console capture, process.chdir, or authoring session. */
import { createHash } from 'node:crypto';
import { warmReadRequest } from './read-worker-protocol.mjs';
import { withFreshReadScope } from './read-scope.mjs';
import { withOperationContext } from './operation-context.mjs';
import { withoutConfigurationReadScope } from './configuration-read-scope.mjs';
import { resolveModelMode } from './model-mode.mjs';
import { resolveOperation } from './command-registry.mjs';
import { resetGitProcessCaches } from './git.mjs';
import { clearGitFactCache } from './git-fact-cache.mjs';
import { resetGitBlobReadCaches } from './git-blob-batch.mjs';
import { resetRefSubjectCache } from './repository-subject-index.mjs';
import { resetConfigurationAssetPolicyCache } from './configuration-branch.mjs';

function reset() {
  resetGitProcessCaches();
  clearGitFactCache();
  resetGitBlobReadCaches();
  resetRefSubjectCache();
  resetConfigurationAssetPolicyCache();
}

export async function readWorkerValue(root, args) {
  const request = warmReadRequest(args);
  if (!request) return { kind: 'unsupported' };
  const operation = resolveOperation({ requestedCommand: request.method,
    positionals: [request.method, ...(request.workId ? [request.workId] : [])], options: { json: true } });
  if (operation.classification !== 'read' || operation.modelPolicy !== 'never') return { kind: 'unsupported' };
  reset();
  try {
    const value = await withoutConfigurationReadScope(() => withFreshReadScope(() => withOperationContext({
      operation, root, command: request.method, modelMode: resolveModelMode(args),
      argvSha256: createHash('sha256').update(JSON.stringify(args)).digest('hex')
    }, async () => {
      if (request.method === 'snapshot') {
        const { readSnapshot } = await import('./commands/snapshot.mjs');
        return readSnapshot(root, request);
      }
      if (request.method === 'status') {
        const { readStatus } = await import('./commands/status.mjs');
        return readStatus(root, request.workId);
      }
      const { resolveSnapshot } = await import('./commands/nextsteps.mjs');
      return resolveSnapshot([request.method, ...(request.workId ? [request.workId] : [])], { root });
    })));
    // Console-only diagnostics are not a private protocol. Successful structured warning fields
    // remain intact; governed failures are rendered by the one cold CLI fallback, not guessed here.
    return { kind: 'value', value };
  } finally { reset(); }
}
