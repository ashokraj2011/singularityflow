/**
 * `needs-you`: everything waiting on you across the active workspace's repositories, oldest first, and `needs-you show
 * <KEY>`: one item's card [FPL:REQ-008 to REQ-018]. Read-only: every choice runs today's command for its kind.
 */
import { optionBoolean, SingularityFlowError } from '../util.mjs';

// `timings` and `no-model` are every command's (cli-entry.mjs reads them).
const LIST_OPTIONS = new Set(['offline', 'refresh', 'json', 'all', 'help', 'timings', 'no-model']);
const SHOW_OPTIONS = new Set(['offline', 'json', 'help', 'timings', 'no-model']);

export const NEEDS_YOU_USAGE = [
  'Usage: singularity-flow needs-you [--offline] [--refresh] [--all] [--json]',
  '       singularity-flow needs-you show <KEY> [--offline] [--json]',
  'Everything waiting on you in the active workspace\'s repositories: approvals, decisions, a step\'s next version, a',
  'task\'s intake answers, configuration changes to review and Initiative approvals, oldest first. Each repository is',
  'judged with the identity SFlow records with there. --offline shows what was kept from the last read and fetches',
  'nothing; --refresh reads every Story again. `show` prints one item\'s card: what it is about, what SFlow checked,',
  'its recommendation and the commands for its choices. Nothing is recorded here.'
].join('\n');

function refuse(message, code) {
  throw new SingularityFlowError(message, { code, details: { nextAction: { command: 'singularity-flow needs-you --help', label: 'See how needs-you is used' } } });
}

const routeLines = async (choice, indent) => {
  const { formatCommandRouteLines } = await import('../model-free-commands.mjs');
  return formatCommandRouteLines({ copilotCommand: choice.copilotCommand ?? null, command: choice.command ?? null }, { indent });
};

/** The list in the terminal, in the tab's order and words. */
export function needsYouText(result, { all = false } = {}) {
  const head = [`Needs you${result.workspace ? ` · ${result.workspace.name}` : ''}${result.checked ? ` · ${result.checked.words}` : ''}`];
  const { counts } = result;
  head.push(counts.total ? `${counts.badgeTooltip}${counts.later ? `, and ${counts.later} can wait` : ''}.` : 'Nothing waits on you now.');
  const shown = all ? result.items : result.items.slice(0, result.shown);
  const titles = { 'holds-work': 'Holds work', reviews: 'Reviews', later: 'Later' };
  const lines = [...head];
  let group = null;
  for (const item of shown) {
    if (item.group !== group) { group = item.group; lines.push('', titles[group] ?? group); }
    const story = item.story ? `${item.story.id} · ${item.story.title ?? item.story.id}` : 'Configuration';
    lines.push(`  ${item.question}`, `    ${story} · ${item.repository?.name ?? ''}`.replace(/ · $/u, ''));
    if (item.couldNotTell) lines.push('    SFlow could not tell whether this one is yours.');
    lines.push(`    ${item.recommended?.words ?? item.recommendation}`, `    Open its card: singularity-flow needs-you show ${item.key}`);
  }
  if (!all && result.more) lines.push('', `Show ${result.more} more: singularity-flow needs-you --all`);
  if (result.lines.length) lines.push('', ...result.lines);
  return `${lines.join('\n')}\n`;
}

/** One card in the terminal [FPL:REQ-013]: the question, what it is about, what SFlow checked, the recommendation, the choices. */
export async function needsYouCardText(result) {
  const { item, card } = result;
  const lines = [card.question, card.asked];
  if (card.couldNotTell) lines.push('SFlow could not tell whether this one is yours: acting on it checks it.');
  if (card.why) lines.push(`Why you: ${card.why}`);
  if (card.about?.lines?.length) lines.push('', card.about.title ?? 'What it is about', ...card.about.lines.map((line) => `  - ${line}`));
  if (card.checked?.length) lines.push('', 'What SFlow checked', ...card.checked.map((line) => `  - ${line}`));
  lines.push('', card.recommendation?.words ?? item.recommendation);
  if (card.before?.length) lines.push('', 'Decide these first:', ...card.before.map((entry) => `  ${entry.question}  (singularity-flow needs-you show ${entry.key})`));
  if (card.place?.words) lines.push('', card.place.words);
  if (!card.place?.here && item.route?.elsewhere) {
    lines.push('', `${item.repository?.name ?? 'Its repository'} is not open here. Go to it:`, ...item.route.elsewhere.commands.map((command) => `  ${command}`));
  }
  lines.push('', 'Choices');
  for (const choice of card.choices ?? []) lines.push(`  ${choice.label}${choice.recommended ? ' (recommended)' : ''}`, ...await routeLines(choice, '    '));
  if (result.next) lines.push('', `Next: ${result.next.question}  (singularity-flow needs-you show ${result.next.key})`);
  return `${lines.join('\n')}\n`;
}

export async function run(argv, { positionals = argv, options = {} } = {}) {
  const show = positionals[1] === 'show';
  if (options.help === true) return console.log(NEEDS_YOU_USAGE);
  const allowed = show ? SHOW_OPTIONS : LIST_OPTIONS;
  for (const key of Object.keys(options)) if (!allowed.has(key)) refuse(`needs-you${show ? ' show' : ''} has no --${key} option.`, 'NEEDS_YOU_OPTIONS_INVALID');
  if (!show && positionals.length > 1) refuse(`needs-you takes no ${positionals[1]}: run singularity-flow needs-you, or needs-you show <KEY>.`, 'NEEDS_YOU_OPTIONS_INVALID');
  const json = optionBoolean(options, 'json');
  const { needsYou, needsYouCard } = await import('../needs-you.mjs');
  if (show) {
    const key = positionals[2];
    if (!key || positionals.length > 3) refuse('Name one item: singularity-flow needs-you show <KEY>, with a key from singularity-flow needs-you.', 'NEEDS_YOU_KEY_REQUIRED');
    const result = await needsYouCard(key, { offline: optionBoolean(options, 'offline') });
    if (json) return console.log(JSON.stringify(result, null, 2));
    return process.stdout.write(await needsYouCardText(result));
  }
  const result = await needsYou({ offline: optionBoolean(options, 'offline'), refresh: optionBoolean(options, 'refresh') });
  if (json) return console.log(JSON.stringify(result, null, 2));
  process.stdout.write(needsYouText(result, { all: optionBoolean(options, 'all') }));
}
