/**
 * Whether a test command calls an AI model, asked once per repository and remembered [owner, 2026-11-28: "ask once,
 * remember"; stuck points, dead end 10].
 *
 * With models off, SFlow runs a test command only when it knows the command calls no AI model. A command that declares
 * no modelPolicy was skipped, and the same check skipped it again on every run. Now the person is asked once:
 * "Does `<command>` call an AI model?" The answer is kept with the repository's other SFlow records in its shared Git
 * folder (`<git-common-dir>/singularity-flow/test-model-use.json`), never a file a person edits, so every checkout and
 * worktree of the clone reads it:
 *   no   the command runs while models are off, as a command that declares modelPolicy: never does;
 *   yes  it stays skipped while models are off, and the way on is the same check with models on for that one run.
 * An answer is for the exact command (its words and working folder): a changed command is asked again. The person
 * answers (`tests model-use`), never the agent.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const TEST_MODEL_USE_FILE = path.join('singularity-flow', 'test-model-use.json');
export const MODEL_USE_ANSWERS = Object.freeze(['no', 'yes']);
/** Why the question matters, in one line every surface shows beside it. */
export const MODEL_USE_WHY = 'Models are off, so SFlow runs a test command only when it calls no AI model; your answer is kept for this repository and never asked again.';

/** The exact command an answer is for: its words and the folder it runs in, never its ID alone. */
export function commandModelKey(policy) {
  const digest = createHash('sha256').update(JSON.stringify({ argv: policy?.argv ?? null, command: policy?.command ?? null,
    workingDirectory: policy?.workingDirectory ?? null })).digest('hex');
  return { commandId: String(policy?.id ?? ''), argvSha256: digest };
}

const keyOf = ({ commandId, argvSha256 }) => `${commandId}@${argvSha256}`;
const recordFile = (commonDirectory) => path.join(commonDirectory, TEST_MODEL_USE_FILE);

/** Every answer kept for the repository whose shared Git folder is `commonDirectory`; empty when none or unreadable. */
export function readModelUse(commonDirectory) {
  try {
    const value = JSON.parse(readFileSync(recordFile(commonDirectory), 'utf8'));
    return value?.schemaVersion === 1 && value.answers && typeof value.answers === 'object' ? value.answers : {};
  } catch { return {}; }
}

/** The answer for this exact command, `no`, `yes` or null when nobody answered yet. */
export function modelUseAnswer(answers, policy) {
  const answer = answers?.[keyOf(commandModelKey(policy))]?.calls;
  return MODEL_USE_ANSWERS.includes(answer) ? answer : null;
}

/** Keep the person's answer for the command; a later answer for the same command replaces it. Returns the entry. */
export function recordModelUse(commonDirectory, { commandId, argvSha256, calls, by = null, at = new Date().toISOString() }) {
  if (!MODEL_USE_ANSWERS.includes(calls)) throw Object.assign(new Error('Answer --calls no or --calls yes.'), { code: 'TEST_MODEL_USE_INVALID' });
  if (!/^[a-f0-9]{64}$/u.test(String(argvSha256 ?? '')) || !String(commandId ?? '').trim()) {
    throw Object.assign(new Error('Name the test command and its digest as the skipped run gave them.'), { code: 'TEST_MODEL_USE_INVALID' });
  }
  const answers = { ...readModelUse(commonDirectory) };
  const entry = { commandId: String(commandId), argvSha256, calls, by, at };
  answers[keyOf(entry)] = entry;
  const file = recordFile(commonDirectory);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, answers }, null, 2)}\n`);
  renameSync(temporary, file);
  return entry;
}

/** The answer reader for the repository of checkout `root`, as the model policy takes it; null when its Git folder is unreadable. */
export async function repositoryModelUse(root) {
  try {
    const { gitCommonDir } = await import('./git-execution.mjs');
    const answers = readModelUse(gitCommonDir(root));
    return (policy) => modelUseAnswer(answers, policy);
  } catch { return null; }
}

/** The question a skipped run asks, with its one-line why, for a command nobody answered for yet. */
export function modelUseQuestion(policy) {
  const shown = policy?.command ?? (Array.isArray(policy?.argv) ? policy.argv.join(' ') : policy?.id);
  return { ...commandModelKey(policy), question: `Does \`${shown}\` call an AI model?`, why: MODEL_USE_WHY };
}
