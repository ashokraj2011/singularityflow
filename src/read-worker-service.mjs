/** Typed canonical reads. No CLI dispatch, console capture, process.chdir, or authoring session. */
import { createHash } from 'node:crypto';
import { warmReadRequest } from './read-worker-protocol.mjs';
import { withFreshReadScope, withCommandReadScope } from './read-scope.mjs';
import { withOperationContext } from './operation-context.mjs';
import { withoutConfigurationReadScope } from './configuration-read-scope.mjs';
import { resolveModelMode } from './model-mode.mjs';
import { resolveOperation } from './command-registry.mjs';
import { resetGitDirCache } from './git-execution.mjs';
import { clearGitFactCache } from './git-fact-cache.mjs';
import { resetGitBlobReadCaches } from './git-blob-batch.mjs';
import { resetRefSubjectCache } from './repository-subject-index.mjs';
let fullReset = null;

async function reset(full = false) {
  if (full && !fullReset) {
    const [git, configuration] = await Promise.all([import('./git.mjs'), import('./configuration-branch.mjs')]);
    fullReset = () => { git.resetGitProcessCaches(); configuration.resetConfigurationAssetPolicyCache(); };
  }
  resetGitDirCache();
  fullReset?.();
  clearGitFactCache();
  resetGitBlobReadCaches();
  resetRefSubjectCache();
}

/** Definition preparation only: no handler, repository read, model or receipt is executed. */
export async function prepareReadWorkerDefinitions({ policy = false } = {}) {
  await Promise.all([import('./commands/status.mjs'), import('./commands/progress.mjs'),
    import('./commands/report.mjs')]);
  if (policy) await import('./commands/nextsteps.mjs');
}

export async function readWorkerValue(root, args) {
  const request = warmReadRequest(args);
  if (!request) return { kind: 'unsupported' };
  const operation = resolveOperation({ requestedCommand: request.method,
    positionals: [request.method, ...(request.workId ? [request.workId] : [])], options: { json: true } });
  if (operation.classification !== 'read' || operation.modelPolicy !== 'never') return { kind: 'unsupported' };
  await reset(!['status', 'progress', 'report'].includes(request.method));
  try {
    const value = await withoutConfigurationReadScope(() => withFreshReadScope(() => withCommandReadScope(() => withOperationContext({
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
      if (request.method === 'progress') {
        const { readProgress } = await import('./commands/progress.mjs');
        return readProgress(root, request.workId);
      }
      if (request.method === 'report') {
        const { readReport } = await import('./commands/report.mjs');
        return readReport(root, request.workId);
      }
      const { resolveSnapshot } = await import('./commands/nextsteps.mjs');
      return resolveSnapshot([request.method, ...(request.workId ? [request.workId] : [])], { root });
    }))));
    // Console-only diagnostics are not a private protocol. Successful structured warning fields
    // remain intact; governed failures are rendered by the one cold CLI fallback, not guessed here.
    return { kind: 'value', value };
  } finally { await reset(); }
}
