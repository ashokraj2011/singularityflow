/**
 * One real choice when this machine's Node is what stops a Story's tests [bin-opr2].
 *
 * A `.nvmrc` makes SFlow run a repository's commands on the Node it names (project-node-version.mjs), and
 * the file is class build-configuration, so a person can account for it in the plan. On the real run that
 * took a question, two refused appeals, a turn of /sf-decide and a sentence typed by hand. Here it is one
 * choice: only an installed version is offered, the choice is a person's, and recording it creates the
 * file and the plan amendment together (src/engine-compatibility/native-plan-decisions.mjs).
 *
 * Reads only. An answer here informs, and refuses nothing. A value reaches this module as a version or not
 * at all, and never becomes a path: `.nvmrc` is the only file it names.
 */
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { gitCommonDir } from './git.mjs';
import { NODE_PIN_CLASS, NODE_PIN_FILE } from './node-pin-names.mjs';

export { NODE_PIN_CLASS, NODE_PIN_FILE };
const MAJOR_ONLY = /^\d{1,4}$/u;

/** The major version a person may pin: the text `22` and nothing else. */
export function nodePinVersion(value) {
  const text = String(value ?? '').trim();
  return MAJOR_ONLY.test(text) ? text : null;
}

/** The highest installed Node of a major version, or null. */
export async function installedNodeOfMajor(version, environment = process.env) {
  const { installedNodeVersions } = await import('./project-node-version.mjs');
  const major = nodePinVersion(version);
  if (!major) return null;
  return (await installedNodeVersions(environment).catch(() => [])).find((entry) => entry.split('.')[0] === major) ?? null;
}

const answerPath = (root, workId) => path.join(gitCommonDir(root), 'singularity-flow', 'test-node-runs', `${String(workId).replace(/[^A-Za-z0-9._-]+/gu, '_')}.json`);

/** Keep what `tests node` found. It is a fact for a person, never evidence. */
export async function keepNodeTry(root, workId, answer) {
  const file = answerPath(root, workId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(answer, null, 2)}\n`, { mode: 0o600 });
}

const nodeTry = async (root, workId) => {
  const answer = await readFile(answerPath(root, workId), 'utf8').then(JSON.parse, () => null);
  return Array.isArray(answer?.results) ? answer : null;
};

/** What `tests node` last found for this version, as a sentence for a person; null when nothing was asked. */
export async function nodeTryWords(root, workId, version, { head = null } = {}) {
  const answer = await nodeTry(root, workId);
  if (answer?.version !== version) return null;
  const counts = answer.results.map((entry) => (entry.tests ? `${entry.tests.passed} of ${entry.tests.discovered} passed` : entry.status)).join(', ');
  const passed = answer.results.length > 0 && answer.results.every((entry) => entry.status === 'passed');
  const later = head && answer.head !== head ? ' The code has been committed since, so that answer may be out of date.' : '';
  const unrun = answer.results.find((entry) => entry.status === 'not-run');
  if (unrun) return { passed: false, words: `Whether it passes on Node ${answer.node} is still not known: ${unrun.why ?? 'it did not run'}.${later}` };
  return { passed, words: `${passed ? 'It passes' : 'It does not pass'} on Node ${answer.node} (${counts}), on a throwaway copy of this checkout; nothing was recorded as evidence.${later}` };
}

function latestFailed(attempts, nodeCommandIds) {
  return [...attempts].filter((attempt) => attempt.status !== 'passed' && nodeCommandIds.has(attempt.commandId))
    .sort((left, right) => String(left.commandId).localeCompare(String(right.commandId)))[0] ?? null;
}

// `toolchain-version` also names Java, Python and others; the commands here are Node runners only.
const runtimeCause = (cause) => String(cause?.class ?? cause?.causeClass ?? '').split('+').includes('toolchain-version');

/**
 * What the Node here means for these test commands: the pin to offer and why, or null. `commands` are the
 * step's test commands; `attempts` their latest runs. A run that failed on the toolchain offers a pin with
 * no file reasoning: the newest installed Node of another major, which `tests node` can check.
 */
export async function nodePinOffer(root, commands, { attempts = [], environment = process.env } = {}) {
  const { runnerFamily, nodeVersion } = await import('./test-toolchain.mjs');
  const nodeCommands = commands.filter((command) => runnerFamily(command) === 'node');
  if (!nodeCommands.length) return null;
  const { nodeVersionChecks, fileReads } = await import('./test-plan.mjs');
  const check = (await nodeVersionChecks(root, nodeCommands, { environment, reads: fileReads(root) })).find((entry) => entry.pin) ?? null;
  // The version file is the answer already, unless it names a Node this machine does not have.
  if (await lstat(path.join(root, NODE_PIN_FILE)).then(() => true, () => false) && !check?.pin?.replaces) return null;
  const failed = latestFailed(attempts, new Set(nodeCommands.map((command) => command.id)));
  // A note may end on a command, with no full stop; here more words follow it.
  if (check) return { ...check.pin, running: check.node, words: /[.!?]$/u.test(check.words) ? check.words : `${check.words}.`, stage: failed ? 'failed' : 'early', commandId: failed?.commandId ?? nodeCommands[0].id };
  if (!failed || !runtimeCause(failed.cause)) return null;
  const { installedNodeVersions } = await import('./project-node-version.mjs');
  const running = await nodeVersion('node', { cwd: root, environment }).catch(() => null);
  const other = (await installedNodeVersions(environment).catch(() => [])).find((version) => version.split('.')[0] !== String(running ?? '').split('.')[0]);
  if (!other) return null;
  return { file: NODE_PIN_FILE, version: other.split('.')[0], node: other, running, stage: 'failed', commandId: failed.commandId,
    words: `The latest run of ${failed.commandId} stopped because the toolchain here is not the version the build needs${running ? `: this machine runs Node ${running}` : ''}.` };
}

/** Another major version installed here, for a Node runner's failed run; null when there is none or the repository already pins one. */
export async function otherInstalledNode(root, command, { environment = process.env } = {}) {
  const { runnerFamily, nodeVersion } = await import('./test-toolchain.mjs');
  if (runnerFamily(command) !== 'node' || await lstat(path.join(root, NODE_PIN_FILE)).then(() => true, () => false)) return null;
  const { installedNodeVersions } = await import('./project-node-version.mjs');
  const running = await nodeVersion('node', { cwd: root, environment }).catch(() => null);
  const other = (await installedNodeVersions(environment).catch(() => [])).find((version) => version.split('.')[0] !== String(running ?? '').split('.')[0]);
  return other ? { version: other.split('.')[0], node: other } : null;
}

/** The pin to offer for an open code step of a Story, as the decision list and recovery read it; null when there is none. */
export async function storyNodePin(root, config, workflow, phase, { environment = process.env, known = null, failedOnly = false } = {}) {
  if (phase?.status !== 'in_progress' || phase.generationIntent?.status !== 'open') return null;
  const [{ latestStepAttempts }, { workDirRelative }, { head }] = await Promise.all([
    import('./verification/attempts.mjs'), import('./story-paths.mjs'), import('./git.mjs')]);
  const workId = workflow.workItem.id;
  const latest = await latestStepAttempts(root, workDirRelative(config, workId), workId, phase.id).catch(() => new Map());
  const attempts = [...latest.values()];
  // A count on a read path: nothing failed, so nothing waits on a pin, and no test command is resolved to say so.
  if (failedOnly && !attempts.some((attempt) => attempt.status !== 'passed')) return null;
  const { resolveStoryLocalTestCommands } = await import('./local-test-runs.mjs');
  const commands = known ?? (await resolveStoryLocalTestCommands(root, config, workflow, { phaseId: phase.id }).catch(() => ({ commands: [] }))).commands;
  const offer = await nodePinOffer(root, commands, { attempts, environment });
  const current = head(root);
  if (offer) {
    const tried = await nodeTryWords(root, workId, offer.version, { head: current }).catch(() => null);
    return { ...offer, phase: phase.id, ...(tried ? { tried } : {}) };
  }
  // No file says the Node is at fault, but the same tests fail here and pass on another installed one: that is what `tests node` found.
  const answer = await nodeTry(root, workId).catch(() => null);
  const failed = answer?.head === current && attempts.find((attempt) => attempt.status !== 'passed' && answer.results.some((entry) => entry.commandId === attempt.commandId));
  if (!failed || !answer.results.every((entry) => entry.status === 'passed') || await lstat(path.join(root, NODE_PIN_FILE)).then(() => true, () => false)) return null;
  if (!await installedNodeOfMajor(answer.version, environment)) return null;
  const tried = await nodeTryWords(root, workId, answer.version, { head: current }).catch(() => null);
  return { file: NODE_PIN_FILE, version: answer.version, node: answer.node, running: null, stage: 'failed', commandId: failed.commandId, phase: phase.id, ...(tried ? { tried } : {}),
    words: `The latest run of ${failed.commandId} failed here, and the same tests pass on Node ${answer.node}.` };
}
