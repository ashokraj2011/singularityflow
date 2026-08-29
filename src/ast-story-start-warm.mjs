import { spawn } from 'node:child_process';
import path from 'node:path';

import { normalizeAstPolicy } from './ast-policy.mjs';
import { effectiveAstMode } from './ast-mode.mjs';
import { buildAstCache } from './ast-intelligence.mjs';
import { head } from './git.mjs';
import { withWorldModelSourceScope, worldModelSourceScope } from './source-scope.mjs';
import { nowIso } from './util.mjs';
import { PACKAGE_ROOT } from './package-root.mjs';
import {
  readStoryStartAstWarmStatus, writeStoryStartAstWarmStatus
} from './ast-story-start-status.mjs';

const WORKER = path.join(PACKAGE_ROOT, 'bin', 'ast-story-start-worker.mjs');

function boundedMessage(error) {
  return String(error?.message ?? error ?? 'AST cache warming failed.').replace(/\s+/g, ' ').trim().slice(0, 1000);
}

function warmScope(definition, workflow, configuredScope) {
  if (configuredScope === 'repository') return { kind: 'repository', options: { all: true } };
  const pinned = workflow?.resolution?.worldModelSourceScope
    ?? workflow?.resolution?.capability?.sourceScope
    ?? null;
  const scope = worldModelSourceScope(withWorldModelSourceScope(definition, pinned));
  return scope.paths.length
    ? { kind: 'configured-roots', options: { paths: [...scope.paths] } }
    : { kind: 'configured-roots', options: { all: true } };
}

export async function storyStartAstWarmPlan(root, definition, workflow) {
  const policy = normalizeAstPolicy(definition.ast ?? {});
  const effective = await effectiveAstMode(policy);
  const selected = warmScope(definition, workflow, policy.warmOnStoryStart.scope);
  return {
    workId: workflow.workItem.id,
    mode: policy.warmOnStoryStart.mode,
    scope: selected.kind,
    options: selected.options,
    repositoryRevision: head(root),
    enabled: policy.warmOnStoryStart.mode !== 'off' && effective.mode !== 'off',
    disabledReason: policy.warmOnStoryStart.mode === 'off' ? 'policy-off'
      : effective.mode === 'off' ? 'ast-off' : null
  };
}

async function updateStatus(root, current, patch) {
  return writeStoryStartAstWarmStatus(root, {
    ...current,
    ...patch,
    updatedAt: nowIso()
  });
}

export async function runStoryStartAstWarmWorker(root, workId) {
  const queued = await readStoryStartAstWarmStatus(root, workId);
  if (!queued) return { status: 'unavailable', workId };
  let repositoryRevision;
  try {
    repositoryRevision = head(root);
  } catch (error) {
    return updateStatus(root, queued, {
      status: 'failed', completedAt: nowIso(), reason: error?.code ?? 'AST_REPOSITORY_UNAVAILABLE',
      message: boundedMessage(error)
    }).catch(() => ({
      ...queued, status: 'failed', completedAt: nowIso(),
      reason: error?.code ?? 'AST_REPOSITORY_UNAVAILABLE', message: boundedMessage(error)
    }));
  }
  if (repositoryRevision !== queued.repositoryRevision) {
    return updateStatus(root, queued, {
      status: 'skipped', completedAt: nowIso(),
      reason: 'repository-revision-changed',
      message: 'The repository moved before background AST warming began; no stale scope was warmed.'
    });
  }
  const running = await updateStatus(root, queued, { status: 'running', startedAt: nowIso() });
  try {
    const result = await buildAstCache(root, queued.options ?? {});
    return updateStatus(root, running, {
      status: result.status === 'disabled' ? 'skipped' : result.status === 'partial' ? 'partial' : 'complete',
      completedAt: nowIso(),
      reason: result.status === 'disabled' ? 'ast-off' : null,
      result: {
        status: result.status,
        assurance: result.assurance,
        selected: result.coverage?.selected ?? 0,
        processed: result.coverage?.processed ?? 0,
        cacheHits: result.provenance?.cache?.hits ?? 0,
        cacheMisses: result.provenance?.cache?.misses ?? 0,
        resumable: Boolean(result.resumeHandle),
        diagnostics: (result.diagnostics ?? []).map((item) => item.code).filter(Boolean).slice(0, 20)
      }
    });
  } catch (error) {
    return updateStatus(root, running, {
      status: 'failed', completedAt: nowIso(),
      reason: error?.code ?? 'AST_STORY_START_WARM_FAILED',
      message: boundedMessage(error)
    }).catch(() => ({
      ...running, status: 'failed', completedAt: nowIso(),
      reason: error?.code ?? 'AST_STORY_START_WARM_FAILED', message: boundedMessage(error)
    }));
  }
}

function launchDetached(root, workId) {
  const child = spawn(process.execPath, [WORKER, workId], {
    cwd: root,
    env: process.env,
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true
  });
  child.once('error', (error) => {
    void readStoryStartAstWarmStatus(root, workId).then((record) => record && updateStatus(root, record, {
      status: 'failed', completedAt: nowIso(), reason: error.code ?? 'AST_WARM_WORKER_START_FAILED',
      message: boundedMessage(error)
    })).catch(() => {});
  });
  child.unref();
  return { pid: child.pid ?? null };
}

/**
 * Schedule optional derived-cache work only after Story publication is durable.
 * Every local I/O, process, adapter, and AST failure is converted to status data; callers never
 * throw from this boundary and therefore can never roll a Story back because AST is unavailable.
 */
export async function scheduleStoryStartAstWarm(root, definition, workflow, { launcher = launchDetached } = {}) {
  try {
    const plan = await storyStartAstWarmPlan(root, definition, workflow);
    if (!plan.enabled) return {
      mode: plan.mode, scope: plan.scope, status: 'skipped', reason: plan.disabledReason, blocking: false
    };
    const queuedAt = nowIso();
    const blocking = plan.mode === 'before-first-phase';
    const queued = await writeStoryStartAstWarmStatus(root, {
      workId: plan.workId,
      mode: plan.mode,
      scope: plan.scope,
      options: plan.options,
      repositoryRevision: plan.repositoryRevision,
      status: 'queued',
      blocking,
      queuedAt,
      updatedAt: queuedAt,
      startedAt: null,
      completedAt: null,
      reason: null,
      message: null,
      result: null
    });
    if (plan.mode === 'before-first-phase') {
      const completed = await runStoryStartAstWarmWorker(root, plan.workId);
      // This mode deliberately completes the cache before start returns. Report that wait honestly
      // so callers and timings do not present a potentially long inline build as background work.
      return { ...completed, blocking: true };
    }
    // Node's test runner may launch hundreds of Story fixtures concurrently. Dedicated tests inject
    // a launcher and exercise the worker directly; ordinary product processes always launch it.
    if (process.env.NODE_TEST_CONTEXT && launcher === launchDetached) {
      return updateStatus(root, queued, {
        status: 'skipped', completedAt: nowIso(), reason: 'test-runner-suppressed',
        message: 'Background worker launch is suppressed inside the Node test runner.'
      });
    }
    try {
      launcher(root, plan.workId);
      return { mode: plan.mode, scope: plan.scope, status: 'scheduled', blocking: false };
    } catch (error) {
      const failed = await updateStatus(root, queued, {
        status: 'failed', completedAt: nowIso(),
        reason: error?.code ?? 'AST_WARM_WORKER_START_FAILED', message: boundedMessage(error)
      }).catch(() => null);
      return failed ? { ...failed, blocking: false } : {
        mode: plan.mode, scope: plan.scope, status: 'failed', blocking: false,
        reason: error?.code ?? 'AST_WARM_WORKER_START_FAILED', message: boundedMessage(error)
      };
    }
  } catch (error) {
    return {
      mode: definition?.ast?.warmOnStoryStart?.mode ?? 'background',
      scope: definition?.ast?.warmOnStoryStart?.scope ?? 'configured-roots',
      status: 'failed', blocking: false,
      reason: error?.code ?? 'AST_STORY_START_WARM_FAILED',
      message: boundedMessage(error)
    };
  }
}
