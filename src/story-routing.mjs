/**
 * A Work ID decides where a command runs.
 *
 * `status --work-id hex-2018`, run in a checkout of Story hex-106, used to answer about hex-106:
 * the command read only its positional operand, and the checkout it ran in decided the rest. Here
 * a command that names a Story other than the current checkout's runs in that Story's own checkout
 * (from the machine's Story index, verified against Git), refuses with `workspace use` when the
 * Story lives in another workspace, and refuses with `session open` when this computer has no
 * checkout of it. It never falls back to the current folder's Story.
 *
 * Only commands that name a Story are affected: `--work-id`, or the operand each command declares
 * for it below. An explicit or bound checkout (`--context-root`, a VS Code window binding) still
 * wins, and a Copilot turn bound to one Story cannot run a command for another. Outside every
 * registered workspace nothing is indexed and commands run exactly where they did.
 *
 * This module is loaded only when a command has operands or `--work-id`; the Story index and Git
 * reads load only when the named Story differs from the current checkout's.
 */
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { optionString, SingularityFlowError } from './util.mjs';

// `<command> [WORK-ID]`: the first operand names the Story (HELP.md usage).
const FIRST_OPERAND = new Set(['status', 'nextsteps', 'report', 'approvals', 'progress', 'snapshot', 'recover', 'doctor',
  'reopen', 'cancel', 'sync', 'resume', 'return', 'watch', 'agent', 'specify', 'plan', 'implement', 'verify', 'converge']);
// `<command> <subcommand> [WORK-ID]`.
const SECOND_OPERAND = Object.freeze({
  receipt: ['show'], change: ['show'], tokens: ['status', 'report'], context: ['xray', 'compile'],
  impact: ['status', 'enroll', 'expansion', 'verify', 'finalize', 'doctor'], documents: ['list'],
  state: ['planes', 'reconcile'], ledger: ['reconcile'], delivery: ['workflow-status'], pr: ['describe'],
  story: ['target-origin', 'return'], decisions: ['record'],
  decision: ['show', 'plan', 'choose', 'applicability', 'scope', 'completeness', 'risk', 'witness',
    'test-risk', 'test-command', 'evidence-reuse', 'visual-profile']
});
// `story test-policy <action> [WORK-ID]`.
const STORY_TEST_POLICY_ACTIONS = new Set(['show', 'plan', 'confirm', 'repair', 'baseline', 'amend', 'attest',
  'accept-risk', 'revoke-risk', 'attest-risk', 'baseline-admission']);

/** Where a command's declared Work ID operand sits, or null when it declares none. */
export function workIdOperandIndex(command, positionals) {
  if (FIRST_OPERAND.has(command)) return 1;
  if (command === 'decisions') return positionals[1] === 'record' ? 2 : 1;
  if (command === 'story' && positionals[1] === 'test-policy') return STORY_TEST_POLICY_ACTIONS.has(positionals[2]) ? 3 : null;
  return SECOND_OPERAND[command]?.includes(positionals[1]) ? 2 : null;
}

/**
 * The Story a command names: `--work-id`, or its declared operand. Naming two different Stories
 * is refused rather than guessed at.
 */
export function namedWorkId(command, positionals, options) {
  const option = optionString(options, 'work-id');
  const index = workIdOperandIndex(command, positionals);
  const operand = index == null ? null : positionals[index] ?? null;
  if (option && operand && option !== operand) throw new SingularityFlowError(
    `This command names two Stories: '${operand}' and --work-id '${option}'. Name the Story once.`,
    { code: 'WORK_ID_CONFLICT', details: { operand, option } });
  const workId = option ?? operand;
  return workId ? { workId, index, fromOption: Boolean(option) && !operand } : null;
}

/**
 * A command whose Story is an operand read only that operand, so `--work-id` was silently ignored
 * and it answered about the checkout's own Story. Give it the operand too, in its positionals and in
 * the argv a re-parsing handler reads, right after the command (and subcommand) words.
 */
export function applyWorkIdOperand(named, positionals, argv) {
  if (!named?.fromOption || ![1, 2].includes(named.index) || positionals.length !== named.index) return;
  const command = argv.indexOf(positionals[0]);
  const at = named.index === 1 ? command : argv.indexOf(positionals[1], command + 1);
  if (command < 0 || at < 0) return;
  positionals.splice(named.index, 0, named.workId);
  argv.splice(at + 1, 0, named.workId);
}

// These work on the Story of the checkout they run in and read no Story operand. Outside a workspace
// (where nothing is indexed) a `--work-id` naming another Story is refused instead of ignored.
const CHECKOUT_STORY_COMMANDS = new Set(['phase', 'inputs', 'prepare']);

// File-valued options are read relative to where the person ran the command, not where it runs.
const OUTPUT_OPTIONS = new Set(['out', 'output', 'report-file', 'report-json']);
const INPUT_OPTIONS = new Set(['file', 'story-file', 'document', 'evidence-file', 'change-set', 'bundle',
  'application-file', 'text-file', 'tasks-file', 'response-file', 'request-file', 'patch', 'observation-file',
  'description-file', 'runner-provider-file', 'provider-file']);

async function exists(file) { return realpath(file).then(() => true, () => false); }

async function rebasedValue(name, value, launchDirectory) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) return value;
  const absolute = path.resolve(launchDirectory, value);
  // An input that does not exist where the command was run may be repository-relative; keep it.
  return OUTPUT_OPTIONS.has(name) || await exists(absolute) ? absolute : value;
}

/** Make relative file options absolute, in `options` and in the argv a re-parsing handler reads. */
export async function rebaseFileOptions(options, argv, launchDirectory) {
  for (const name of Object.keys(options)) {
    if (!OUTPUT_OPTIONS.has(name) && !INPUT_OPTIONS.has(name)) continue;
    const value = options[name];
    options[name] = Array.isArray(value)
      ? await Promise.all(value.map((item) => rebasedValue(name, item, launchDirectory)))
      : await rebasedValue(name, value, launchDirectory);
  }
  const end = argv.indexOf('--');
  for (let index = 0; index < (end < 0 ? argv.length : end); index += 1) {
    const token = String(argv[index]);
    const equals = /^--([a-z][a-z0-9-]*)=(.*)$/su.exec(token);
    if (equals && (OUTPUT_OPTIONS.has(equals[1]) || INPUT_OPTIONS.has(equals[1]))) {
      argv[index] = `--${equals[1]}=${await rebasedValue(equals[1], equals[2], launchDirectory)}`;
    } else if (token.startsWith('--') && (OUTPUT_OPTIONS.has(token.slice(2)) || INPUT_OPTIONS.has(token.slice(2)))
        && index + 1 < argv.length && !String(argv[index + 1]).startsWith('--')) {
      argv[index + 1] = await rebasedValue(token.slice(2), argv[index + 1], launchDirectory);
      index += 1;
    }
  }
}

const TURN_LIFETIME_MS = 30 * 60 * 1000;

/**
 * Explicit Copilot turns bound to a Story in `root` (copilot-mutation-guard.mjs records them). A
 * turn bound to Story A in this checkout must not reach Story B by naming it.
 */
async function boundTurnStories(root) {
  const { copilotModeFile } = await import('./copilot-mode.mjs');
  const directory = path.join(path.dirname(copilotModeFile()), 'copilot-boundaries');
  const names = await readdir(directory).catch(() => []);
  const canonicalRoot = await realpath(root).catch(() => path.resolve(root));
  const { samePlatformPath } = await import('./story-worktree.mjs');
  const stories = [];
  for (const name of names.filter((entry) => entry.endsWith('.mutation.json'))) {
    try {
      const value = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      const workId = value?.kind === 'copilot-mutation-contract' ? value.contract?.workId : null;
      if (!workId || !Number.isFinite(value.recordedAt) || Date.now() - value.recordedAt > TURN_LIFETIME_MS) continue;
      if (samePlatformPath(value.contract.repositoryRoot ?? '', canonicalRoot)) stories.push(workId);
    } catch { /* An unreadable record binds nothing; the guard refuses its own turn. */ }
  }
  return stories;
}

/** Uncommitted changes to this Story's own files in the checkout the command was run from. */
async function storyChangesHere(root, workflowPath) {
  const { changedPaths } = await import('./git.mjs');
  try { return changedPaths(root, [path.posix.dirname(workflowPath)]); } catch { return []; }
}

function refusal(message, code, details) { return new SingularityFlowError(message, { code, details }); }

/**
 * Where a command that names a Story runs: null to run here, else `{ root, route }` for that
 * Story's checkout. Refuses when the Story is in another workspace or has no checkout here.
 */
export async function routeNamedStory({ command, positionals, options, argv, root, env = process.env }) {
  const named = namedWorkId(command, positionals, options);
  if (!named) return null;
  applyWorkIdOperand(named, positionals, argv);
  const index = await import('./story-index.mjs');
  // A placeholder here is the command's own storage refusal to make, not this lookup's.
  const facts = await index.checkoutGitFacts(root).catch(() => null);
  const current = facts ? await index.storyInCheckout(root, { facts }).catch(() => null) : null;
  if (current && (current.workId === named.workId || current.aliases.includes(named.workId))) return null;
  const member = await index.checkoutMembership(root, { env }).catch(() => null);
  const { workId } = named;
  if (!member) {
    if (current && named.fromOption && CHECKOUT_STORY_COMMANDS.has(command)) throw refusal(
      `This checkout holds Story ${current.workId}, and --work-id names ${workId}. ${command} works on the Story of the checkout it runs in, `
      + `so it was not run. Run it in ${workId}'s checkout.`,
      'ACTIVE_SUBJECT_MISMATCH', { expectedWorkId: workId, actualWorkId: current.workId, repositoryPath: root });
    return null;
  }
  const { valid, unavailable } = await index.lookupStoryCheckouts(workId, { env });
  const active = await activeWorkspaceId(env);
  const here = new Set([member.workspace.id, active].filter(Boolean));
  const local = valid.filter((entry) => here.has(entry.workspace.id));
  const sameRepository = local.filter((entry) => entry.repository.key === member.repositoryKey);
  const candidates = sameRepository.length ? sameRepository : local;
  if (candidates.length > 1) throw refusal(
    `Story ${workId} has more than one checkout in this workspace (${candidates.map((entry) => entry.checkoutPath).join(', ')}). `
    + 'Nothing was run. Keep the copy you work in and remove the other with git worktree remove after checking it holds nothing you need.',
    'STORY_CHECKOUT_AMBIGUOUS', { workId, storyCheckout: { workId, checkoutPaths: candidates.map((entry) => entry.checkoutPath) },
      nextAction: `singularity-flow workspace stories ${workId}` });
  const entry = candidates[0];
  if (!entry) {
    const elsewhere = valid.find((item) => !here.has(item.workspace.id));
    if (elsewhere) throw index.storyElsewhereError(workId, elsewhere, { sameWorkspace: false, operation: `${command}` });
    if (unavailable.length) throw refusal(
      `Story ${workId}'s checkout at ${unavailable[0].checkoutPath} is not on this computer: ${unavailable[0].reason}. Nothing was run. `
      + 'Download the folder (or keep it on this computer) and run the command again.',
      'STORY_CHECKOUT_UNAVAILABLE', { workId, storyCheckout: { workId, checkoutPath: unavailable[0].checkoutPath, workspace: unavailable[0].workspace },
        nextAction: `singularity-flow workspace stories ${workId}` });
    const routes = index.storyCheckoutRoutes(workId, { workspace: member.workspace }, { sameWorkspace: true });
    throw refusal(`Story ${workId} has no checkout on this computer, so this command was not run here, in ${current?.workId ?? 'a checkout without a Story'}. `
      + `Open it first. ${routes.text}.`, 'STORY_CHECKOUT_REQUIRED', { workId, nextAction: routes.commands[0], recoveryCommands: routes.commands });
  }
  const bound = (await boundTurnStories(root)).filter((story) => story !== workId);
  if (bound.length) throw refusal(
    `This checkout's Copilot turn is bound to Story ${bound[0]}, so it cannot run a command for ${workId}. Nothing was run. `
    + `Open ${workId} in a chat of its own. Copilot: /sf-session ${workId}; Shell: singularity-flow session open ${workId}; VS Code (model-free): not available for this action.`,
    'ACTIVE_SUBJECT_MISMATCH', { expectedWorkId: bound[0], actualWorkId: workId, repositoryPath: root, nextAction: `singularity-flow session open ${workId}` });
  if (await classification(command, positionals, options) === 'mutation') {
    const changes = await storyChangesHere(root, entry.workflowPath);
    if (changes.length) throw refusal(
      `${root} has uncommitted changes to Story ${workId}'s files (${changes.slice(0, 3).join('; ')}), but its checkout is ${entry.checkoutPath}. `
      + 'Nothing was run, so those changes are not left behind. Move or commit them in the Story\'s own checkout, or discard them here, then run the command again.',
      'STORY_CHANGES_IN_OTHER_COPY', { workId, repositoryPath: root, paths: changes.slice(0, 20),
        storyCheckout: { workId, checkoutPath: entry.checkoutPath, branch: entry.branch, workspace: entry.workspace } });
  }
  await rebaseFileOptions(options, argv, process.cwd());
  return { root: entry.checkoutPath, route: { workId, checkoutPath: entry.checkoutPath, from: root,
    workspace: entry.workspace, branch: entry.branch } };
}

/** The resolved operation's classification; an operation that cannot be resolved counts as a mutation. */
async function classification(command, positionals, options) {
  try {
    const { resolveOperation } = await import('./command-registry.mjs');
    return resolveOperation({ requestedCommand: command, positionals: [command, ...positionals.slice(1)], options }).classification;
  } catch { return 'mutation'; }
}

async function activeWorkspaceId(env) {
  try {
    const { activeWorkspaceFile } = await import('./workspace-context.mjs');
    return JSON.parse(await readFile(activeWorkspaceFile(env), 'utf8'))?.workspaceId ?? null;
  } catch { return null; }
}
