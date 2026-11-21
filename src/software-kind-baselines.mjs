/**
 * Baseline acceptance criteria by kind of software (step intents spec §12.2, owner 2026-11-20): what holds for any
 * change to a web app, a backend, a job, a CLI, a library, a mobile app or infrastructure, whatever the request says.
 * Arshy closed with a graph that resized on every keystroke, because no requirement said it must not.
 *
 * When a person has confirmed the kind of this repository's projects (`capability kind`, software-kind-record.mjs),
 * the step that defines the Story's scope is given these criteria to add as ordinary acceptance criteria: they get
 * tests, a review and coverage like any other. The person may drop any of them, with a reason. Nothing here asks a
 * model or detects a kind: a kind nobody confirmed adds nothing.
 *
 * Pure: it reads only what it is given.
 */
import { KIND_WORDS } from './software-kind-record.mjs';

const freeze = (value) => Object.freeze(Object.fromEntries(Object.entries(value).map(([key, list]) => [key, Object.freeze([...list])])));

/** The baseline criteria of each kind, in the spec's words (§12.2). */
export const BASELINE_CRITERIA = freeze({
  web: [
    'No layout jump or resize while typing, clicking or scrolling.',
    'No browser console errors in normal use.',
    'Works at phone, laptop and wide widths.',
    'Main actions work by keyboard and have labels.'
  ],
  backend: [
    'Bad input gets a 4xx response with a clear message, never a 500.',
    'Changed endpoints keep their contract, or the change is declared.',
    'No unhandled exceptions or stack traces in the logs during normal calls.',
    'Secrets and personal data never appear in logs.',
    'Auth rules hold on every changed endpoint.'
  ],
  job: [
    'Runs to completion on sample input.',
    'Running it twice does no harm (it is idempotent), or the plan says why not.',
    'Failures are reported with a non-zero status and a clear message.'
  ],
  cli: [
    'Exit codes are correct: 0 on success, non-zero on failure.',
    'Errors go to stderr.',
    '--help describes changed options.',
    'Bad arguments get a usage message, not a crash.'
  ],
  library: [
    'Public API changes are intentional and versioned: no accidental breaking change.',
    'Examples in the docs still compile.'
  ],
  mobile: [
    'Changed screens work in portrait and landscape.',
    'No crash on the main flow.',
    'Text and controls are accessible.'
  ],
  artifact: [
    'It validates (for example terraform validate or plan, kubectl --dry-run, a migration dry run).',
    'Migrations are reversible or declared one-way, and lose no data.'
  ]
});

/**
 * The baseline criteria for confirmed projects (`[{ id, name?, root?, kind }]`), one entry per kind with the projects
 * of that kind: `[{ kind, words, projects, criteria }]`, in a stable order. Empty when none is confirmed.
 */
export function baselineCriteriaFor(projects) {
  const byKind = new Map();
  for (const project of Array.isArray(projects) ? projects : []) {
    if (!Object.hasOwn(BASELINE_CRITERIA, project?.kind)) continue;
    const name = String(project.name ?? project.root ?? project.id ?? '').trim() || 'this repository';
    byKind.set(project.kind, [...new Set([...(byKind.get(project.kind) ?? []), name])]);
  }
  return Object.keys(BASELINE_CRITERIA).filter((kind) => byKind.has(kind))
    .map((kind) => ({ kind, words: KIND_WORDS[kind], projects: byKind.get(kind), criteria: [...BASELINE_CRITERIA[kind]] }));
}

/** The prompt section of the step that defines the scope: empty when no kind is confirmed. */
export function baselineCriteriaSection(projects) {
  const kinds = baselineCriteriaFor(projects);
  if (!kinds.length) return '';
  const lines = ['## Baseline acceptance criteria for this kind of software', '',
    `A person confirmed what kind of software this repository is: ${kinds.map((entry) => `${entry.projects.join(', ')} ${entry.projects.length === 1 ? 'is' : 'are'} ${entry.words}`).join('; ')}. `
      + 'These criteria hold for any change to such software, whatever the request says. Add each one to the acceptance criteria as an ordinary criterion, with its own anchor, so later steps test and review it like any other.', ''];
  for (const entry of kinds) {
    lines.push(`${entry.words.replace(/^a /u, 'For a ').replace(/^an /u, 'For an ').replace(/^infrastructure/u, 'For infrastructure')}:`);
    for (const criterion of entry.criteria) lines.push(`- ${criterion}`);
    lines.push('');
  }
  lines.push('A person may drop any of them, with a reason. When your clarifying questions are on, ask once whether each one applies, listing them all; leave out only those the person drops, '
    + 'and list each under the out-of-scope section with the person\'s reason in their words. When you cannot ask, add them all: the person drops one when they review this step, saying why.');
  return lines.join('\n');
}
