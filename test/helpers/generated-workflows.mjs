/**
 * Generated workflows of step intents for the walk (step intents spec §9.3–§9.4, Stage 6): built from intents alone,
 * with random step IDs and labels that mismatch their intents, and random mixes of what a team changes:
 *
 *   - steps:         document, code and no-code steps, by the code grammar `intake? requirements? design* plan?
 *                    (code test*)+ review? release? report?` or the code-free one `intake? requirements?
 *                    (design|test|document)+ report?`;
 *   - review:        on (every drafted step reviewed) or off for some steps (sourceReview.skip, with its reason);
 *   - approval:      per step as its intent gives it, or changed to a person, SFlow when clean, or none, where the
 *                    engine's safety rules allow it, each with its reason;
 *   - clarification: the question step asks as its intent gives it (required), or not at all (off, with its reason);
 *   - test commands: the repository's `tests:` list present, or absent (the tests are detected).
 *
 * `generatedWorkflow(seed)` returns the generated pieces; `applyGenerated(configuration, generated)` lays them over a
 * repository's singularity/workflow.yml (as journeyRepository's `configure` edits it). Only workflows a person could
 * make are returned, as a person makes them: a draw the engine refuses to start is drawn again, and so is one the walk
 * every change runs stops (src/workflow-walk/quick.mjs), which is kept in `refused` with its stops. `draws` says how
 * many were drawn.
 */
import YAML from 'yaml';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertWorkTypeStartable, resolveWorkType, validateDefinition } from '../../src/config.mjs';
import { INTENT_WORDS, STEP_INTENTS } from '../../src/step-intents.mjs';
import { intentProfile } from '../../src/step-intent-settings.mjs';
import { quickWalkResolved, walkHosts } from '../../src/workflow-walk/quick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
export const GENERATED_WORK_TYPE = 'gen';
export const GENERATED_AGENT = 'gen-author';
const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'sa', 'tu', 've', 'ro', 'di', 'pa'];
const REASON = {
  approvalPerson: 'The team wants a person to read this step before the Story goes on.',
  approvalAutomatic: 'Its reviewer is enough here; SFlow approves it when nothing is open.',
  approvalNone: 'It only records what the team already agreed, so nobody signs it off.',
  questionsOff: 'The request arrives fully written, so this step asks nothing.',
  reviewSkip: 'These steps only restate agreed facts, so they need no independent review.'
};

/** A small seeded generator (mulberry32), so a failing workflow can be made again from its seed. */
export function generator(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (low, high) => low + Math.floor(next() * (high - low + 1));
  return { next, int, chance: (p) => next() < p, pick: (list) => list[int(0, list.length - 1)] };
}

/** One workflow's intents, by the code or the code-free grammar. */
export function intentsFor(random) {
  const optional = (intent, p = 0.5) => (random.chance(p) ? [intent] : []);
  if (random.chance(0.7)) {
    const blocks = [];
    for (let count = random.int(1, 2); count > 0; count -= 1) blocks.push('code', ...Array.from({ length: random.int(0, 2) }, () => 'test'));
    return [...optional('intake', 0.8), ...optional('requirements'), ...Array.from({ length: random.int(0, 2) }, () => 'design'), ...optional('plan', 0.6),
      ...blocks, ...optional('review'), ...optional('release', 0.3), ...optional('report', 0.3)];
  }
  return [...optional('intake'), ...optional('requirements'), ...Array.from({ length: random.int(1, 3) }, () => random.pick(['design', 'test', 'document'])),
    ...optional('report')];
}

/** One draw: the steps, their changes and the repository's tests, or null when the engine would refuse to start it. */
function draw(random) {
  const intents = intentsFor(random);
  const ids = intents.map((_, index) => `${random.pick(SYLLABLES)}${random.pick(SYLLABLES)}-${index}`);
  const phases = {};
  const changes = [];
  intents.forEach((intent, index) => {
    // A label from another intent's words: a step called "Run the tests" may be the plan. Names decide nothing.
    const other = random.pick(STEP_INTENTS.filter((candidate) => candidate !== intent && INTENT_WORDS[candidate]));
    const label = `${random.pick(INTENT_WORDS[other])} ${index}`.replace(/^./u, (first) => first.toUpperCase());
    const step = { intent, label, artifact: { path: `artifacts/${ids[index]}/out.md` }, defaultTemplate: intentProfile().intents[intent].template };
    // What the team changes on this step, where the engine allows it: refused draws are drawn again.
    const approval = random.pick(['as-intent', 'as-intent', 'person', 'automatic', 'none']);
    if (approval === 'person') { step.approval = { automatic: 'off' }; step.because = { 'approval.automatic': REASON.approvalPerson }; }
    if (approval === 'automatic') { step.approval = { automatic: 'when-ready' }; step.because = { 'approval.automatic': REASON.approvalAutomatic }; }
    if (approval === 'none') { step.approval = 'none'; step.because = { 'approval.mode': REASON.approvalNone }; }
    if (approval !== 'as-intent') changes.push(`${ids[index]}: approval ${approval}`);
    phases[ids[index]] = step;
  });
  const questions = random.chance(0.35) ? 'off' : 'as-intent';
  const asking = intents.includes('intake') ? intents.indexOf('intake') : ['requirements', 'design', 'plan', 'document'].includes(intents[0]) ? 0 : -1;
  if (questions === 'off' && asking >= 0) {
    const step = phases[ids[asking]];
    step.clarification = { mode: 'off' };
    step.because = { ...(step.because ?? {}), 'clarification.mode': REASON.questionsOff };
    changes.push(`${ids[asking]}: questions off`);
  }
  const workType = { label: 'Generated', phases: ids };
  const reviewOff = random.chance(0.35);
  if (reviewOff) {
    const skipped = ids.filter((_, index) => !['code'].includes(intents[index]) && random.chance(0.5));
    if (skipped.length) {
      workType.sourceReview = { skip: skipped };
      workType.because = { 'sourceReview.skip': REASON.reviewSkip };
      changes.push(`review off for ${skipped.join(', ')}`);
    }
  }
  const tests = random.chance(0.5);
  return { intents, ids, phases, workType, tests, review: workType.sourceReview ? 'off for some steps' : 'on', questions: asking >= 0 ? questions : 'no question step', changes };
}

/** The repository's one test command when the draw has one: the value module's own test, run as the walk runs it. */
export const TEST_COMMANDS = Object.freeze([{ id: 'value-unit', kind: 'test', level: 'unit', argv: ['node', '--test', 'test/value.test.mjs'], workingDirectory: '.',
  affectedRoots: ['.'], modelPolicy: 'never', result: { adapter: 'node-tap', path: '.sflow/results/value-unit.tap', minimumDiscovered: 1 } }]);

/** `configuration` (workflow.yml as parsed) with the generated work type, its steps, its groups and its tests. */
export function applyGenerated(configuration, generated) {
  configuration.version = Math.max(Number(configuration.version) || 0, 4);
  for (const [id, step] of Object.entries(generated.phases)) configuration.phases[id] = structuredClone(step);
  configuration.workTypes[GENERATED_WORK_TYPE] = structuredClone(generated.workType);
  if (generated.tests) configuration.tests = structuredClone(TEST_COMMANDS);
  else delete configuration.tests;
  return configuration;
}

/** Each approval group as Workflow Studio shows it (src/workflow-studio.mjs groupStatus), for the walk. */
export function groupsOf(value) {
  return new Map(Object.entries(value.approvalAuthorities ?? {}).map(([id, group]) => [id, { id, label: group.label ?? id,
    status: (group.members ?? []).length ? 'people' : group.allowAnyGitIdentity ? 'anyone' : (group.githubTeams ?? []).length ? 'teams'
      : value.approvalSecurity?.autoEnrollNewIdentities === false ? 'blocked' : 'auto' }]));
}

/** The walk every change runs, on a resolved generated workflow. */
export const walkGenerated = (resolved, value) => quickWalkResolved(resolved, { approvalAuthorities: value.approvalAuthorities, groups: groupsOf(value), hosts: walkHosts() });

const whereOf = (seed, generated) => `seed ${seed}: ${generated.intents.join(' ')}; review ${generated.review}; questions ${generated.questions}; `
  + `tests ${generated.tests ? 'configured' : 'detected'}${generated.changes.length ? `; ${generated.changes.join('; ')}` : ''}`;

/**
 * A generated workflow a person could make, from `seed`: drawn until one starts and the walk on change finds no stop
 * in it (at most 50 draws). `where` names it for a failure message; `refused` holds each draw the walk stopped.
 */
export function generatedWorkflow(seed) {
  const random = generator(seed);
  const refused = [];
  for (let draws = 1; draws <= 50; draws += 1) {
    const generated = draw(random);
    const value = applyGenerated(structuredClone(BASE), generated);
    let resolved;
    try {
      resolved = resolveWorkType(validateDefinition(structuredClone(value)), GENERATED_WORK_TYPE);
      assertWorkTypeStartable(resolved);
    } catch { continue; }
    const walk = walkGenerated(resolved, value);
    if (walk.stops.length) { refused.push({ where: whereOf(seed, generated), stops: walk.stops }); continue; }
    return { ...generated, seed, draws, value, resolved, refused, walk, where: whereOf(seed, generated) };
  }
  throw new Error(`seed ${seed}: no workflow a person could make in 50 draws`);
}

/** The agent file that drafts every generated step: random step IDs have no shipped agent. */
export function generatedAgentFile(newAgentFile, ids) {
  return newAgentFile({ id: GENERATED_AGENT, label: 'Generated author', description: 'Drafts every step of a generated workflow.',
    tools: ['read', 'search', 'edit', 'execute'], phases: ids, defaultFor: ids, instructions: 'Write the step as its template asks.' });
}
