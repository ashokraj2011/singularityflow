/**
 * Retry memory for gate refusals [E2G-024]: an identical retry of a refused transition is answered
 * from the refusal it got before, instead of running the gate's checks and tests again. Git-private
 * and disposable: losing it only means the next retry runs the checks.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { changedFiles, head } from '../git.mjs';
import { repositoryGitPath } from '../git-directory.mjs';
import { canonicalJson } from '../records.mjs';
import { SingularityFlowError } from '../util.mjs';
import { projectGateRefusal } from './gate-refusal.mjs';

const sha256 = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

function memoryFile(root, workId) {
  return repositoryGitPath(root, 'singularity-flow', 'refusals', `${String(workId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

/**
 * What a retry would be decided on, taken before anything runs: the operation and its subject, who
 * asks, the commit, and the content of every changed or untracked file. Any edit, commit or other
 * person changes it; an identical retry does not, even after a refused transaction rewrote the same
 * bytes while rolling back.
 */
export async function refusalFingerprint(root, { operation, workId, phase = null, actor = null, args = [] }) {
  const files = [];
  // Content up to a total budget, so a checkout full of large untracked files never slows a retry;
  // past it a file is identified by its size and modification time.
  let budget = 64 * 1024 * 1024;
  for (const file of changedFiles(root).slice(0, 5000)) {
    const absolute = path.join(root, file);
    const stats = await lstat(absolute).catch(() => null);
    if (!stats?.isFile()) { files.push([file, stats ? 'not-a-file' : 'absent']); continue; }
    if (stats.size > budget) { files.push([file, `size:${stats.size}:${Math.trunc(stats.mtimeMs)}`]); continue; }
    budget -= stats.size;
    files.push([file, createHash('sha256').update(await readFile(absolute)).digest('hex')]);
  }
  return sha256({ operation, workId, phase, actor, args, head: head(root), files });
}

/** Refuse at once when this exact retry was refused before and nothing it depends on changed. */
export async function assertRefusalChanged(root, workId, fingerprint) {
  let remembered = null;
  try { remembered = JSON.parse(await readFile(memoryFile(root, workId), 'utf8')); } catch { return; }
  if (remembered?.fingerprint !== fingerprint || !remembered.refusal) return;
  const refusal = projectGateRefusal(remembered.refusal);
  if (!refusal) return;
  const first = refusal.obligations[0]?.id ?? refusal.findings[0]?.message ?? refusal.code;
  throw new SingularityFlowError(
    `Story ${workId} was refused for these reasons at ${remembered.at}, and nothing it depends on has changed since `
    + `(the first: ${first}). Change something first, then retry.`
    + (refusal.actions.length ? `\nRecover:\n${refusal.actions.map((entry) => `  ${entry.command}`).join('\n')}` : ''),
    { code: 'REFUSAL_UNCHANGED', exitCode: 2, details: { gate: { ...refusal, code: 'REFUSAL_UNCHANGED' }, refusedAt: remembered.at } }
  );
}

/** Remember a gate refusal for this exact retry; a later identical retry is answered from it. */
export async function rememberRefusal(root, workId, fingerprint, refusal, at) {
  const file = memoryFile(root, workId);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const memory = {
    schemaVersion: 1, // schema-transient: disposable git-private retry memory; an unreadable or older file is ignored
    fingerprint, at, refusal: { ...refusal, fingerprint }
  };
  await writeFile(file, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o600 });
}

/** Forget a remembered refusal once the Story moved on. */
export async function forgetRefusal(root, workId) {
  await rm(memoryFile(root, workId), { force: true });
}
