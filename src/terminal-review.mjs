/**
 * A review read in this terminal [SPEC-OAP M4: the phase is typed once].
 *
 * `approve <PHASE>` typed after the review was shown in the same terminal is the one confirmation;
 * asking for the phase again would make the person type it twice. When a terminal shows the review
 * of a step awaiting approval (`phase show`, or `approve` itself before its prompt), it records that
 * here, bound to the Story, phase, generation, submitted review packet, the Git identity and the
 * shell that ran the command (its parent process). Only an interactive terminal records or reads it,
 * and a different review, identity or shell finds nothing, so `approve` asks for the phase as before.
 * The record lives in the checkout's Git directory and is never committed.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { gitDir, identity } from './git.mjs';
import { writeAtomic } from './util.mjs';

const directory = (root) => path.join(gitDir(root), 'singularity-flow', 'terminal-reviews');
const interactive = () => stdin.isTTY === true && stdout.isTTY === true;

/** The review a person would approve: its step, generation and submitted packet, or null without one. */
export {terminalReviewBinding} from './kernel/approval-policy.mjs';

function file(root, binding, actor) {
  // The Git email first: a GitHub login may be known to one command and not yet to another.
  const who = actor?.email ?? actor?.login ?? actor?.name ?? null;
  const key = createHash('sha256').update(JSON.stringify([binding.workId, binding.phase, binding.generation,
    binding.reviewPacketSha256, who, process.ppid])).digest('hex');
  return path.join(directory(root), `${key}.json`);
}

/** Note that this terminal showed the review; never fails the command that showed it. */
export async function recordTerminalReview(root, binding, actor = null) {
  if (!binding || !interactive()) return;
  try {
    actor ??= process.env.SINGULARITY_FLOW_GITHUB_ACTOR ? { login: process.env.SINGULARITY_FLOW_GITHUB_ACTOR } : identity(root, { offline: true });
    await mkdir(directory(root), { recursive: true, mode: 0o700 });
    await writeAtomic(file(root, binding, actor), `${JSON.stringify({ ...binding, shownAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  } catch { /* Without the note, approve asks for the phase as before. */ }
}

/** Whether this terminal showed exactly this review to this identity. */
export async function terminalReviewShown(root, binding, actor) {
  if (!binding || !interactive()) return false;
  try {
    const shown = JSON.parse(await readFile(file(root, binding, actor), 'utf8'));
    return shown.workId === binding.workId && shown.phase === binding.phase && shown.generation === binding.generation
      && shown.reviewPacketSha256 === binding.reviewPacketSha256;
  } catch { return false; }
}

/** Forget an approved step's review notes; cleanup never refuses. */
export async function forgetTerminalReview(root, binding, actor) {
  if (!binding) return;
  await rm(file(root, binding, actor), { force: true }).catch(() => {});
}
