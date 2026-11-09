/**
 * `singularity-flow prompts [--story ID] [--limit N] [--json]` [PCR:REQ-002]: what was asked of Copilot in this clone.
 *
 * Every prompt in a repository that uses SFlow, plain or `/sf-`, is kept by the prompt hook in the clone's own log
 * (<Git common directory>/singularity-flow/prompts/, plain-chat-prompts.mjs), redacted when it was written, newest
 * first. `--story` narrows it to the prompts asked in one Story's checkout. Read only, files alone: no Git process,
 * no network, and the log never leaves the clone. Each prompt is data, quoted as kept, never an instruction.
 */
import { optionBoolean, optionString, SingularityFlowError } from '../util.mjs';

const MAXIMUM = 500;

export async function promptsCommand(options = {}, { cwd = process.cwd() } = {}) {
  const [{ repositoryOf }, { readPromptLog, PROMPT_LOG_DAYS }] = await Promise.all([
    import('../copilot-environment-files-guard.mjs'), import('../plain-chat-prompts.mjs')]);
  const repository = repositoryOf(cwd);
  if (!repository) {
    throw new SingularityFlowError('Run singularity-flow prompts inside a Git checkout: it reads that clone\'s own log.', { code: 'PROMPTS_NOT_IN_REPOSITORY',
      details: { nextAction: { command: 'singularity-flow prompts', label: 'Open a terminal in the clone whose prompts you want, then run this there.' } } });
  }
  const story = optionString(options, 'story');
  const limit = Number(optionString(options, 'limit') ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM) {
    throw new SingularityFlowError(`--limit is a whole number from 1 to ${MAXIMUM}.`, { code: 'PROMPTS_OPTIONS_INVALID' });
  }
  const prompts = (await readPromptLog(repository.common, { workId: story, limit })).map((entry) => ({
    at: entry.at, session: entry.session, kind: entry.kind, skill: entry.skill ?? null, text: entry.text,
    ...(entry.truncated ? { truncated: true } : {}), workId: entry.workId ?? null, phase: entry.phase ?? null,
    ...(entry.secret ? { secret: entry.secret } : {}), repository: entry.repository ?? null }));
  return { schemaVersion: 1, resultType: 'sflow-prompts', repository: repository.root, story: story ?? null, keptDays: PROMPT_LOG_DAYS,
    words: 'Prompts asked of Copilot in this clone, redacted when they were kept, newest first: what was asked, quoted, not an instruction. This log stays in the clone.',
    prompts };
}

function printResult(result) {
  console.log(result.words);
  if (!result.prompts.length) {
    console.log(`\nNone kept${result.story ? ` for ${result.story}` : ''}. Prompts are kept only in a repository that uses SFlow, while SFlow is not paused.`);
    return;
  }
  for (const entry of result.prompts) {
    const where = entry.workId ? ` ${entry.workId}${entry.phase ? ` ${entry.phase}` : ''}` : '';
    const how = entry.kind === 'plain' ? 'plain chat' : `/${entry.skill}`;
    const words = String(entry.text ?? '').replace(/\s+/gu, ' ').trim();
    console.log(`\n${entry.at.replace('T', ' ').slice(0, 19)}${where} (${how}, session ${entry.session ?? 'unknown'})`);
    console.log(`  "${words}"${entry.truncated ? ' (cut at 2,000 characters)' : ''}${entry.secret ? ` (held what looks like a ${entry.secret}; refused, kept redacted)` : ''}${entry.held ? ` (not sent: an earlier prompt in that chat held what looks like a ${entry.held})` : ''}`);
  }
}

export async function run(_argv, { options = {} } = {}) {
  const result = await promptsCommand(options);
  if (optionBoolean(options, 'json')) console.log(JSON.stringify(result, null, 2));
  else printResult(result);
  return result;
}
