/**
 * Where a bounded `--for-agent` result keeps its complete copy: `.sflow/out/` at the top of the
 * checkout the agent works in. `[agent-output]`
 *
 * The copy used to live in the Git directory. For a Story worktree that is the main clone's
 * `.git/worktrees/-w-<24 hex>/singularity-flow/agent-results/`, a path of about 230 characters with
 * two similar IDs in it, and agents misread it: 24 of 839 reads failed in recorded Copilot sessions
 * (2026-10-26), with spliced IDs, doubled segments, dropped digits, or the checkout guessed as the
 * prefix. In the checkout, every returned path carries the one ID the agent already uses as its cwd.
 *
 * The folder is SFlow's own disposable output, never source. One line in the clone's common
 * `info/exclude` (shared by every worktree; the team's .gitignore is never edited) keeps it out of
 * `git status`, staging and every clean-checkout check. The few checks that also list ignored files
 * skip this folder alone, by `isAgentOutputPath`.
 */
import { constants as fsConstants, readdirSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {AGENT_OUTPUT_FOLDER,AGENT_OUTPUT_EXCLUDE,isAgentOutputPath} from './foundation/agent-output-paths.mjs';
export {AGENT_OUTPUT_FOLDER,AGENT_OUTPUT_EXCLUDE,isAgentOutputPath} from './foundation/agent-output-paths.mjs';

// What an agent's file tool shows in one read. Copilot 1.0.95 (2026-10-22) cut a ranged read at about
// 20,000 characters; Copilot 1.0.100 in VS Code (2026-10-27) cut every ranged read after 8,193 to 9,233
// bytes ("Output truncated") and refused an 8,909-byte file whole ("File too large to read at once").
// Each cut read was read again in slices, and a source review that never got its specification text
// ended without reviewing. So a range SFlow names is at most 7,000 bytes. Here, beside the folder,
// because both the result writer and the Copilot edit guard (for any file read) use it.
export const READ_CHUNK_BYTES = 7_000;

/** 1-based inclusive line ranges of at most `chunkBytes` each; a longer single line is its own range. */
export function lineRanges(text, chunkBytes = READ_CHUNK_BYTES) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const ranges = [];
  let start = 1, size = 0;
  lines.forEach((line, index) => {
    const length = Buffer.byteLength(line) + 1;
    if (size && size + length > chunkBytes) { ranges.push([start, index]); start = index + 1; size = 0; }
    size += length;
  });
  if (lines.length) ranges.push([start, lines.length]);
  return ranges;
}
const EXCLUDE_COMMENT = '# Singularity Flow: agent results (.sflow/out), machine-local, never commit them';

/** Whether a repository-relative path, in Git's `/` spelling, is the output folder or inside it. */

/**
 * Whether an ignored entry Git lists in the checkout at `root` is the output folder: the folder or
 * a file in it, or `.sflow/` holding nothing else. A team that ignores all of `.sflow/` makes Git
 * name that folder instead of ours.
 */
export function isAgentOutputEntry(root, relative) {
  const value = String(relative ?? '').replace(/\/$/u, '');
  if (isAgentOutputPath(value)) return true;
  const [parent, folder] = AGENT_OUTPUT_FOLDER.split('/');
  if (value !== parent) return false;
  try { return readdirSync(path.join(root, parent)).every((name) => name === folder); } catch { return false; }
}

/** Porcelain v1 status text, of the checkout at `root`, without the ignored output folder's own lines. */
export function withoutAgentOutputStatus(text, root) {
  return String(text ?? '').split(/\r?\n/u).filter((line) => !(line.startsWith('!! ') && isAgentOutputEntry(root, line.slice(3)))).join('\n').trim();
}

const absent = (error) => error?.code === 'ENOENT' ? null : Promise.reject(error);
// The errno a link or a wrong kind of entry would raise, so the view's `writeError` reads the same.
const unsafe = (file, info, what) => Object.assign(new Error(`${file} is not ${what}; no result was written.`),
  { code: info.isSymbolicLink() ? 'ELOOP' : 'ENOTDIR' });

/**
 * The output folder in `root`, created as real directories. A link or a file at either level is
 * refused: cleanup removes old results there, so it must never reach a folder a repository names.
 */
export async function agentOutputDirectory(root) {
  let cursor = root;
  const parts = AGENT_OUTPUT_FOLDER.split('/');
  for (const [index, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    let info = await lstat(cursor).catch(absent);
    if (!info) {
      // `.sflow` is shared with test reports; only the results folder itself is private.
      await mkdir(cursor, index === parts.length - 1 ? { mode: 0o700 } : {}).catch((error) => error?.code === 'EEXIST' ? null : Promise.reject(error));
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe(cursor, info, 'a real folder');
  }
  return cursor;
}

/**
 * Exclude the folder in the clone's common `info/exclude`, once. It is written before any result,
 * so no file of SFlow's ever shows in `git status`; a failure here keeps the result unwritten.
 */
export async function excludeAgentOutput(commonDirectory) {
  const file = path.join(commonDirectory, 'info', 'exclude');
  const info = await lstat(file).catch(absent);
  if (info && (info.isSymbolicLink() || !info.isFile())) throw unsafe(file, info, 'a regular file');
  const text = info ? await readFile(file, 'utf8') : '';
  if (text.split(/\r?\n/u).includes(AGENT_OUTPUT_EXCLUDE)) return;
  await mkdir(path.dirname(file), { recursive: true });
  // Two commands writing at once may both add the line; a repeated exclude line is harmless.
  await appendFile(file, `${text && !text.endsWith('\n') ? '\n' : ''}${EXCLUDE_COMMENT}\n${AGENT_OUTPUT_EXCLUDE}\n`,
    { encoding: 'utf8', flag: fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0) });
}
