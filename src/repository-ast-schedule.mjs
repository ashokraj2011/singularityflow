import { head } from './git-execution.mjs';
import { launchDetached } from './ast-warm-launcher.mjs';
import { writeRepositoryAstWarmStatus } from './ast-story-start-status.mjs';

/** Queue advisory indexing without reading configuration or enumerating application files. */
export async function scheduleRepositoryAstWarm(root, { launcher = launchDetached } = {}) {
  let queued;
  try {
    const timestamp = new Date().toISOString();
    queued = await writeRepositoryAstWarmStatus(root, null, {
      mode: 'background', scope: 'application-code', options: null, repositoryRevision: head(root),
      blocking: false, queuedAt: timestamp, updatedAt: timestamp, startedAt: null, completedAt: null,
      reason: null, message: null, result: null, status: 'queued'
    });
    if (process.env.NODE_TEST_CONTEXT && launcher === launchDetached) {
      return await writeRepositoryAstWarmStatus(root, null, {
        ...queued, status: 'skipped', reason: 'test-runner-suppressed', completedAt: timestamp
      });
    }
    launcher(root, queued.workId);
    return { ...queued, status: 'scheduled' };
  } catch (error) {
    const failed = {
      ...queued, status: 'failed', blocking: false,
      reason: error?.code ?? 'AST_REPOSITORY_WARM_FAILED',
      message: String(error?.message ?? error).slice(0, 500),
      updatedAt: new Date().toISOString(), completedAt: new Date().toISOString()
    };
    if (queued) await writeRepositoryAstWarmStatus(root, null, failed).catch(() => {});
    return failed;
  }
}
