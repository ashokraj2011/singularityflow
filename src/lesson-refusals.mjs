/**
 * What a Story's steps were refused, kept on this machine for its lessons [LRN:REQ-001].
 *
 * A refused command rolls its Story transaction back, so nothing a refusal writes may live in the work tree. This one
 * appends a line outside it, under Git's common directory, and never throws: losing a line loses a lesson, never work.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git-execution.mjs';

const WORDS_LIMIT = 240;

export function refusalHistoryFile(root, workId) {
  return path.join(gitCommonDir(root), 'singularity-flow', 'lessons', 'refusals', `${encodeURIComponent(workId)}.jsonl`);
}

function firstLine(text) {
  const line = String(text ?? '').split('\n').map((item) => item.trim()).find(Boolean) ?? '';
  return line.length > WORDS_LIMIT ? `${line.slice(0, WORDS_LIMIT - 1)}…` : line;
}

/** Note one refusal of a Story step: its code, its step, its first line and the way on SFlow offered. */
export async function rememberRefusal(cwd, error, plan) {
  try {
    const context = plan?.context;
    if (context?.scope !== 'phase' || !context.workId || !context.phaseId || !error?.code) return;
    const way = (plan.steps ?? []).find((item) => item && item.kind !== 'diagnostic' && (item.command || item.label));
    const line = {
      code: String(error.code), phase: String(context.phaseId), at: new Date().toISOString(),
      words: firstLine(error.message), way: way ? firstLine(way.command ?? way.label) : null
    };
    const file = refusalHistoryFile(cwd, context.workId);
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(line)}\n`);
  } catch { /* a lesson's source, never the work's */ }
}

/** A Story's refusals on this machine, oldest first; a line that cannot be read is skipped. */
export async function storyRefusals(root, workId) {
  let text = '';
  try { text = await readFile(refusalHistoryFile(root, workId), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
