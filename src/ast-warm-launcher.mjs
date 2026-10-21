import { spawn } from 'node:child_process';
import path from 'node:path';

import { PACKAGE_ROOT } from './package-root.mjs';
import { readStoryStartAstWarmStatus, writeStoryStartAstWarmStatus } from './ast-story-start-status.mjs';

const WORKER = path.join(PACKAGE_ROOT, 'bin', 'ast-story-start-worker.mjs');

// Keep scheduling independent of the AST parser, configuration and repository inventory graph.
export function launchDetached(root, workId) {
  const child = spawn(process.execPath, [WORKER, workId], {
    cwd: root, env: process.env, detached: process.platform !== 'win32',
    stdio: 'ignore', windowsHide: true
  });
  child.once('error', (error) => {
    void readStoryStartAstWarmStatus(root, workId).then((record) => record && writeStoryStartAstWarmStatus(root, {
      ...record, status: 'failed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      reason: error.code ?? 'AST_WARM_WORKER_START_FAILED',
      message: String(error?.message ?? error).replace(/\s+/g, ' ').trim().slice(0, 1000)
    })).catch(() => {});
  });
  child.unref();
  return { pid: child.pid ?? null };
}
