/**
 * A bounded, machine-local UI hint emitted only after a kernel-verified Copilot binding.
 * This is not selection or lifecycle authority: the receiving window revalidates the checkout.
 * One slot per launch folder prevents another window's profile selection from hijacking it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const COPILOT_STORY_FOLLOW_MAX_AGE_MS = 120_000;
const MAX_BYTES = 16_384;
const absolute = value => typeof value === 'string' && value.length > 0 && value.length <= 8192
  && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/u.test(value);
const workId = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && !/[\u0000-\u001f\u007f]/u.test(value);
const keyPath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const canonical = async value => keyPath(await realpath(value));

/** Browsing a catalog/Story list or asking for session choices is not Story execution. */
export function copilotStoryFollowSkill(skill) {
  return ['sf-phase', 'sf-code', 'sf-next', 'sf-nextsteps', 'sf-inputs', 'sf-review-source',
    'sf-publish', 'sf-submit', 'sf-approve', 'sf-reject', 'sf-converge', 'sf-recover']
    .includes(String(skill ?? '').replace(/^sflow-/u, 'sf-'));
}

export function copilotStoryFollowDirectory(env = process.env, home = os.homedir()) {
  // Shares the existing active-workspace location, including isolated/test profiles.
  return path.join(path.dirname(path.resolve(env.SINGULARITY_FLOW_COPILOT_MODE_FILE || env.SINGULARITY_FLOW_ACTIVE_WORKSPACE
    || path.join(home, '.singularity-flow', 'active-workspace.json'))), 'copilot-story-follow');
}

export async function copilotStoryFollowFile(originPath, directory = copilotStoryFollowDirectory()) {
  if (!absolute(originPath)) return null;
  const origin = await canonical(originPath);
  return path.join(directory, `${createHash('sha256').update(origin).digest('hex')}.json`);
}

/** Call only with an already accepted Story/session; never from model prose or a tool result. */
export async function recordCopilotStoryFollow({ originPath, repositoryPath, workId: id }, {
  directory = copilotStoryFollowDirectory(), now = Date.now()
} = {}) {
  if (!absolute(originPath) || !absolute(repositoryPath) || !workId(id) || !Number.isSafeInteger(now)) return null;
  const [origin, target] = await Promise.all([canonical(originPath), canonical(repositoryPath)]);
  if (origin === target) return null;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) return null;
  const file = await copilotStoryFollowFile(origin, directory);
  // schema-transient: expiring UI delivery hint, never a governed selection or stored Story record.
  const notice = { schemaVersion: 1, kind: 'copilot-story-follow', eventId: randomUUID(), // schema-transient: expiring UI delivery, not Story/selection state
    originPath: origin, repositoryPath: target, workId: id, observedAt: now };
  const temporary = `${file}.${notice.eventId}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(notice));
    await handle.close(); handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return notice;
}

/** No Git, network, prompt text or branch enumeration. Invalid/expired hints cannot navigate. */
export async function readCopilotStoryFollow(originPath, {
  directory = copilotStoryFollowDirectory(), now = Date.now()
} = {}) {
  const file = await copilotStoryFollowFile(originPath, directory).catch(() => null);
  if (!file) return null;
  let handle;
  try {
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BYTES) return null;
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) return null;
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) return null;
    const value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (value?.schemaVersion !== 1 || value.kind !== 'copilot-story-follow' // schema-transient: validate expiring UI delivery envelope
        || !/^[a-f0-9-]{36}$/u.test(value.eventId ?? '')
        || !absolute(value.originPath) || !absolute(value.repositoryPath) || !workId(value.workId)
        || value.originPath !== await canonical(originPath)
        || !Number.isSafeInteger(value.observedAt) || now < value.observedAt
        || now - value.observedAt > COPILOT_STORY_FOLLOW_MAX_AGE_MS) return null;
    return value;
  } catch { return null; }
  finally { await handle?.close(); }
}

/** Compare against the fresh kernel projection, never treat a notification as proof. */
export function verifiedCopilotStoryFollow(notice, context) {
  return Boolean(absolute(notice?.repositoryPath) && workId(notice?.workId)
    && context?.resultType === 'execution-context' && context.schemaVersion === 1 // schema-transient: kernel execution-context response, never migrated here
    && workId(context.workspace?.id) && absolute(context.workspace?.path)
    && workId(context.repository?.id) && context.story?.id === notice.workId
    && absolute(context.worktree?.path) && keyPath(context.worktree.path) === keyPath(notice.repositoryPath));
}

/** Serialize/coalesce watcher bursts. Re-read after verification and before applying navigation. */
export function createCopilotStoryFollower({ read, verify, apply, isActive, onError = () => {} }) {
  let running = null, queued = false, stopped = false, applied = null;
  const reconcile = () => {
    queued = true;
    if (running) return running;
    running = (async () => {
      while (queued && !stopped) {
        queued = false;
        try {
          if (!isActive()) continue;
          const notice = await read();
          if (!notice || notice.eventId === applied) continue;
          const verified = await verify(notice);
          const current = async () => !stopped && isActive() && (await read())?.eventId === notice.eventId;
          if (!verified || !await current()) { queued = Boolean(verified) && !stopped && isActive(); continue; }
          await apply(verified, current);
          if (await current()) applied = notice.eventId;
        } catch (error) { onError(error); }
      }
    })().finally(() => { running = null; });
    return running;
  };
  return { reconcile, dispose: () => { stopped = true; queued = false; } };
}
