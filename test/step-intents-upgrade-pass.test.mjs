/**
 * Step intents Stage 5 (spec §8): the upgrade's intent pass over a repository's own workflows.
 *
 * - Real custom workflows: every shipped workflow's shape as a team's own copy (steps renamed, so SFlow reads each from
 *   its settings, never as a step it ships), each on its own and all sharing their steps. Offered, confirmed and
 *   resolved again, every workflow of the file resolves as before, as SFlow seals a Story's policy (canonical JSON),
 *   apart from the intent pins a new Story keeps (intent, intentProfile, because).
 * - Generated workflows: a team's workflow written out setting by setting from the §9.3 grammars, then changed the way
 *   teams change them; whatever it is offered and answered, confirming changes nothing it runs.
 * - Nothing changes silently: what an intent would give otherwise is kept, with "Kept as it was before step intents".
 * - Declining writes nothing; a confirmation by another screen's code writes nothing and shows the screen now.
 * - An unclear step asks the one question, two or three intents and never free text, and its workflow waits for it.
 * - What is kept as it is, and why: a step SFlow ships without its intent, a workflow Stories cannot start from today.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

import { canonicalJson } from '../src/canonical-json.mjs';
import {
  assertWorkTypeStartable, initializeDefinition, loadDefinition, loadStepIntentSettings, resolveWorkType, validateDefinition
} from '../src/config.mjs';
import { STEP_INTENTS, workTypeDerivesIntents } from '../src/phase-roles.mjs';
import { deriveWorkTypeSettings } from '../src/step-intent-settings.mjs';
import { INTENT_WORDS } from '../src/step-intents.mjs';
import {
  intentPass, intentPassLines, intentPassRoutes, KEPT_BEFORE_INTENTS
} from '../src/step-intents-upgrade.mjs';
import { refreshPackagedConfiguration, refreshSummary } from '../src/workspace-configuration-refresh.mjs';
import { openConfigurationReviews } from '../src/configuration-review-pass.mjs';
import { beforeStepIntents, SHIPPED_WORKFLOW, teamCopy } from './helpers/before-step-intents.mjs';

await loadStepIntentSettings();

const sealed = (resolved) => canonicalJson({ ...resolved, phases: resolved.phases.map(({ intent: _i, intentProfile: _p, because: _b, ...phase }) => phase) });
const resolvedOrRefused = (definition, id) => { try { return resolveWorkType(definition, id); } catch (error) { return { refused: error.message }; } };
const startable = (resolved) => { try { assertWorkTypeStartable(resolved); return 'starts'; } catch (error) { return error.code ?? error.message; } };

/** Every workflow of `before` resolves in `after` as before, apart from the pins, and starts (or is refused) as before. */
function assertRunsAsBefore(before, after, where) {
  const was = validateDefinition(structuredClone(before));
  const now = validateDefinition(structuredClone(after));
  for (const id of Object.keys(before.workTypes)) {
    const left = resolvedOrRefused(was, id);
    const right = resolvedOrRefused(now, id);
    assert.equal(left.refused ? left.refused : sealed(left), right.refused ? right.refused : sealed(right), `${where}: ${id} resolves as before`);
    if (!left.refused) assert.equal(startable(right), startable(left), `${where}: ${id} starts as before`);
  }
  return now;
}

/** Every reason the pass wrote, on steps' overrides and on workflows. */
function writtenReasons(before, after) {
  const reasons = [];
  for (const [id, type] of Object.entries(after.workTypes)) {
    for (const [setting, reason] of Object.entries(type.because ?? {})) if (before.workTypes[id]?.because?.[setting] !== reason) reasons.push(reason);
    for (const [step, override] of Object.entries(type.phaseOverrides ?? {})) {
      for (const [setting, reason] of Object.entries(override?.because ?? {})) {
        if (before.workTypes[id]?.phaseOverrides?.[step]?.because?.[setting] !== reason) reasons.push(reason);
      }
    }
  }
  return reasons;
}

/** The first choice of every question on the screen, as answers. */
const firstChoices = (pass) => Object.fromEntries(pass.workflows.flatMap((entry) => entry.rows)
  .filter((row) => row.question && row.badge === 'needs-answer').map((row) => [row.step, row.question.choices[0].intent]));

test('every shipped workflow\'s shape, as a team\'s own copy, is offered its intents and runs exactly as before once confirmed', () => {
  const value = beforeStepIntents();
  const copies = Object.keys(value.workTypes).map((id) => teamCopy(value, id, `${id}-`));
  const pass = intentPass(value, { packaged: SHIPPED_WORKFLOW });
  assert.deepEqual(pass.workflows.map((entry) => entry.workflow).sort(), [...copies].sort(), 'only the team\'s own workflows, never one SFlow ships');
  assert.equal(pass.counts.held, 0, pass.workflows.filter((entry) => entry.reason).map((entry) => `${entry.workflow}: ${entry.reason}`).join('\n'));
  assert.ok(pass.counts.workflows >= copies.length - 2, `most are ready on the rules alone (${pass.counts.workflows} of ${copies.length})`);
  assert.ok(pass.counts.kept > 0, 'some steps keep settings their intents would change');
  for (const row of pass.workflows.flatMap((entry) => entry.rows)) {
    assert.ok(STEP_INTENTS.includes(row.intent));
    assert.ok(['sure', 'suggested', 'needs-answer'].includes(row.badge), `${row.step}: ${row.badge}`);
    if (row.badge === 'needs-answer') assert.ok(row.question.choices.length >= 2 && row.question.choices.length <= 3, 'two or three intents to pick from');
  }
  // What a ready workflow keeps is said in words, beside what its intent would give.
  const kept = pass.workflows.flatMap((entry) => entry.rows).flatMap((row) => row.kept ?? []);
  assert.ok(kept.every((item) => item.today && item.intent && item.today !== item.intent));

  // Confirmed with every question answered: every workflow of the file runs as before, and every copy derives.
  const answered = intentPass(value, { packaged: SHIPPED_WORKFLOW, answers: firstChoices(pass) });
  assert.equal(answered.counts.workflows, copies.length);
  assert.equal(answered.counts.open, 0);
  assert.equal(answered.after.version, 4);
  const now = assertRunsAsBefore(value, answered.after, 'own copies');
  for (const id of copies) {
    assert.ok(workTypeDerivesIntents(answered.after, answered.after.workTypes[id]), `${id} derives from its intents`);
    assert.ok(resolveWorkType(now, id).phases.every((phase) => STEP_INTENTS.includes(phase.intent)), `${id} pins its steps' intents for a new Story`);
    // Nothing is left unexplained: every framework setting that differs from its intent says why.
    assert.deepEqual(deriveWorkTypeSettings(now, id).warnings.filter((entry) => entry.code === 'CHECK_INTENT_OVERRIDE_WITHOUT_REASON'), [], id);
  }
  for (const id of Object.keys(SHIPPED_WORKFLOW.workTypes)) {
    assert.ok(canonicalJson(answered.after.workTypes[id]) === canonicalJson(value.workTypes[id]), `${id}, which SFlow ships, is untouched`);
  }
  const reasons = writtenReasons(value, answered.after);
  assert.ok(reasons.length > 0);
  for (const reason of reasons) {
    assert.ok(reason.startsWith(KEPT_BEFORE_INTENTS), reason);
    assert.ok(reason.length >= 20 && reason.length <= 1000);
  }
  // A step that ran its own tests keeps doing so, rather than citing a code step's results.
  assert.ok(Object.values(answered.after.workTypes).some((type) => Object.values(type.phaseOverrides ?? {})
    .some((override) => override?.repositoryTests === 'off' || override?.testEvidenceFrom === false)), 'test steps keep their own tests');
});

test('team copies that share their steps: a step one workflow settles is that in all, and every workflow runs as before', () => {
  const value = beforeStepIntents();
  const copies = Object.keys(value.workTypes).map((id) => teamCopy(value, id));
  const pass = intentPass(value, { packaged: SHIPPED_WORKFLOW });
  assert.equal(pass.counts.held, 0, pass.workflows.filter((entry) => entry.reason).map((entry) => `${entry.workflow}: ${entry.reason}`).join('\n'));
  // One step, one intent: each shared step carries the same intent wherever it is used.
  const intents = new Map();
  for (const row of pass.workflows.flatMap((entry) => entry.rows)) {
    if (intents.has(row.step)) assert.equal(row.intent, intents.get(row.step), `${row.step} means one thing in every workflow`);
    intents.set(row.step, row.intent);
  }
  const answered = intentPass(value, { packaged: SHIPPED_WORKFLOW, answers: firstChoices(pass) });
  assertRunsAsBefore(value, answered.after, 'shared copies');
  assert.equal(answered.counts.workflows, copies.length);
});

// ---------------------------------------------------------------------------------------------
// Generated workflows, written out the way a team has them before step intents

const COUNT = Number(process.env.SINGULARITY_FLOW_GENERATED_WORKFLOWS ?? 20);
const SEED = Number(process.env.SINGULARITY_FLOW_GENERATED_SEED ?? 20261121);

function generator(seed) {
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

/** One workflow's intents by the §9.3 grammars, always with something before its first code step. */
function intentsFor(random) {
  const optional = (intent, p = 0.5) => (random.chance(p) ? [intent] : []);
  if (random.chance(0.7)) {
    const blocks = [];
    for (let count = random.int(1, 2); count > 0; count -= 1) blocks.push('code', ...Array.from({ length: random.int(0, 2) }, () => 'test'));
    const before = [...optional('intake', 0.7), ...optional('requirements'), ...Array.from({ length: random.int(0, 2) }, () => 'design'), ...optional('plan')];
    return [...(before.length ? before : ['requirements']), ...blocks, ...optional('review'), ...optional('release', 0.3), ...optional('report', 0.3)];
  }
  return [...optional('intake'), ...optional('requirements'), ...Array.from({ length: random.int(1, 3) }, () => random.pick(['design', 'test', 'document'])),
    ...optional('report')];
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'sa', 'tu', 've', 'ro', 'di', 'pa'];

/**
 * A team's workflow `team` of these intents, as it would be written before step intents: each step's settings what its
 * intent gives, written out in full (version 3, no intent), then changed the way teams change them: a person approves
 * a step SFlow could, a test step runs its own tests, a step asks nothing or reads nothing, or one sends back to itself.
 */
function teamWorkflow(intents, random) {
  const value = beforeStepIntents();
  const ids = intents.map((_, index) => `${random.pick(SYLLABLES)}${random.pick(SYLLABLES)}-${index}`);
  const withIntents = structuredClone(value);
  withIntents.version = 4;
  intents.forEach((intent, index) => {
    // A label from another intent's words: names decide nothing.
    const other = random.pick(STEP_INTENTS.filter((candidate) => candidate !== intent && INTENT_WORDS[candidate]));
    withIntents.phases[ids[index]] = { intent, label: `${random.pick(INTENT_WORDS[other])} ${index}`.replace(/^./u, (first) => first.toUpperCase()),
      artifact: { path: `artifacts/${ids[index]}/out.md` }, defaultTemplate: 'common/intake.md' };
  });
  withIntents.workTypes.team = { label: 'Team workflow', phases: ids };
  const derivation = deriveWorkTypeSettings(validateDefinition(structuredClone(withIntents)), 'team');
  value.workTypes.team = { label: 'Team workflow', phases: ids };
  derivation.steps.forEach((step, index) => {
    const { intent: _intent, because: _because, ...settings } = structuredClone(step.settings);
    if (isAutomatic(settings) && random.chance(0.4)) delete settings.approval.automatic;
    if (settings.repositoryTests === 'run' && random.chance(0.4)) delete settings.repositoryTests;
    if (settings.testEvidenceFrom && random.chance(0.4)) delete settings.testEvidenceFrom;
    if (random.chance(0.25)) settings.clarification = { ...settings.clarification, mode: 'off' };
    if (random.chance(0.3) && !settings.testEvidenceFrom) delete settings.inputs;
    if (random.chance(0.2)) settings.approval = { ...settings.approval, rejectTo: [ids[index]] };
    value.phases[ids[index]] = settings;
  });
  const { plannedClaims, omits } = derivation.workType;
  if (plannedClaims && random.chance(0.5)) value.workTypes.team.plannedClaims = structuredClone(plannedClaims);
  if (omits.length) value.workTypes.team.omits = structuredClone(omits);
  return { value, ids };
}
const isAutomatic = (settings) => settings.approval?.automatic === 'when-ready';

test(`generated team workflows: confirmed with any answer, each runs exactly as before (${COUNT}, seed ${SEED})`, () => {
  const random = generator(SEED);
  let ready = 0;
  let started = 0;
  for (let run = 0; run < COUNT; run += 1) {
    const intents = intentsFor(random);
    const { value, ids } = teamWorkflow(intents, random);
    const where = `seed ${SEED}, workflow ${run + 1}: ${intents.join(' ')}`;
    let today;
    try { today = resolveWorkType(validateDefinition(structuredClone(value)), 'team'); } catch (error) { assert.fail(`${where}: the team's workflow loads: ${error.message}`); }
    if (startable(today) !== 'starts') continue;
    started += 1;
    const pass = intentPass(value, { packaged: SHIPPED_WORKFLOW });
    const entry = pass.workflows.find((candidate) => candidate.workflow === 'team');
    assert.ok(entry, where);
    // Structure decides, never the step's name: where SFlow is sure, it is the intent the step was written from
    // (§6.1: a first step that writes the requirements is the intake).
    entry.rows.forEach((row, index) => {
      if (row.badge !== 'sure') return;
      const expected = index === 0 && intents[index] === 'requirements' && !intents.includes('intake') ? 'intake' : intents[index];
      assert.equal(row.intent, expected, `${where}: step ${index + 1} (${ids[index]})`);
    });
    // Whatever the questions are answered with, confirming changes nothing the workflow runs.
    const answers = Object.fromEntries(entry.rows.filter((row) => row.badge === 'needs-answer').map((row, index) => {
      const choice = row.question.choices.find((option) => option.intent === intents[ids.indexOf(row.step)]) ?? row.question.choices[index % row.question.choices.length];
      return [row.step, choice.intent];
    }));
    const answered = intentPass(value, { packaged: SHIPPED_WORKFLOW, answers });
    const final = answered.workflows.find((candidate) => candidate.workflow === 'team');
    if (final.status === 'held') { assert.ok(final.reason, where); continue; }
    assert.equal(final.status, 'ready', where);
    ready += 1;
    assertRunsAsBefore(value, answered.after, where);
    assert.ok(workTypeDerivesIntents(answered.after, answered.after.workTypes.team), where);
  }
  assert.ok(started > COUNT / 2, `most generated team workflows start today (${started} of ${COUNT})`);
  assert.ok(ready >= started * 0.8, `most of those take their intents (${ready} of ${started})`);
});

// ---------------------------------------------------------------------------------------------
// The one question, declining, and what is kept as it is

/** A team's workflow whose last step is a blank Studio step (its output kind is its own ID): nothing settles it. */
function withUnclearStep() {
  const value = beforeStepIntents();
  teamCopy(value, 'classic-delivery', 'team-');
  value.phases['team-validate'] = {
    label: 'Validate', defaultTemplate: 'common/intake.md', artifact: { path: 'artifacts/team-validate/validate.md', kind: 'team-validate' },
    writeScope: 'artifact-only', approval: { authorities: ['quality-reviewers'], minimum: 1, rejectTo: ['team-validate'] }
  };
  value.workTypes['team-classic-delivery'].phases.push('team-validate');
  return value;
}

test('an unclear step asks the one question: two or three intents with words, never free text; its workflow waits for it', () => {
  const value = withUnclearStep();
  const pass = intentPass(value, { packaged: SHIPPED_WORKFLOW });
  const entry = pass.workflows.find((candidate) => candidate.workflow === 'team-classic-delivery');
  assert.equal(entry.status, 'needs-answer');
  const row = entry.rows.find((candidate) => candidate.step === 'team-validate');
  assert.equal(row.badge, 'needs-answer');
  assert.equal(row.question.question, 'What does "Validate" do?');
  assert.ok(row.question.choices.length >= 2 && row.question.choices.length <= 3);
  // Its words say test, but its output is not test results: only intents it can take and run as it does are offered,
  // and what a test step needs first is said.
  assert.deepEqual(row.question.choices.map((choice) => choice.intent), ['review', 'release', 'document']);
  assert.match(row.question.note, /^It reads like a test step, which needs its output be test results; change that in Workflow Studio/u);
  assert.ok(row.question.choices.every((choice) => STEP_INTENTS.includes(choice.intent) && /\(\w+\)$/u.test(choice.text)));
  assert.equal(pass.after, null, 'nothing is ready, so confirming writes nothing yet');
  // Each answer is one ready command, with the screen's code.
  const routes = intentPassRoutes(pass, { repository: 'payments' });
  assert.equal(routes.confirm, undefined, 'with nothing ready there is nothing to confirm without an answer');
  assert.deepEqual(routes.answers.map((answer) => answer.command), row.question.choices.map((choice) =>
    `singularity-flow workspace refresh-configuration --repository payments --confirm-intents ${pass.code} --intent team-validate=${choice.intent}`));
  const lines = intentPassLines({ ...pass, routes }).join('\n');
  assert.match(lines, /What does "Validate" do\?/u);
  assert.match(lines, /needs your answer first/u);
  // Answered, it is ready and runs as before.
  const answered = intentPass(value, { packaged: SHIPPED_WORKFLOW, answers: { 'team-validate': 'review' } });
  assert.equal(answered.workflows.find((candidate) => candidate.workflow === 'team-classic-delivery').status, 'ready');
  assert.equal(answered.workflows.flatMap((candidate) => candidate.rows).find((candidate) => candidate.step === 'team-validate').badge, 'yours');
  assertRunsAsBefore(value, answered.after, 'answered');
  // An answer that is not one of the question's choices is not taken.
  const free = intentPass(value, { packaged: SHIPPED_WORKFLOW, answers: { 'team-validate': 'test' } });
  assert.equal(free.workflows.find((candidate) => candidate.workflow === 'team-classic-delivery').status, 'needs-answer');
});

test('what keeps its settings, and why: a step SFlow ships without its intent, and a workflow no Story can start from today', () => {
  const value = beforeStepIntents();
  // A team's workflow of steps SFlow ships, beside SFlow's own workflows that use them.
  value.workTypes['team-mixed'] = { label: 'Team mixed', phases: ['intake', 'implementation', 'verification'] };
  // A team's code step with nothing before it and nothing left out: Stories cannot start from it.
  teamCopy(value, 'careful-change', 'team-');
  delete value.workTypes['team-careful-change'].omits;
  const pass = intentPass(value, { packaged: SHIPPED_WORKFLOW });
  const mixed = pass.workflows.find((entry) => entry.workflow === 'team-mixed');
  const careful = pass.workflows.find((entry) => entry.workflow === 'team-careful-change');
  if (!Object.values(SHIPPED_WORKFLOW.phases).some((step) => typeof step?.intent === 'string')) {
    // Until SFlow ships its steps' intents (Stage 4), a workflow of its steps keeps its settings, with the copy as the way on.
    assert.equal(mixed.status, 'held');
    assert.match(mixed.reason, /steps SFlow ships.*use copies of those steps in Workflow Studio/su);
  }
  assert.equal(careful.status, 'held');
  assert.match(careful.reason, /^Stories cannot start from it today, so it keeps its settings until that is fixed: .* See what to fix: singularity-flow workflow check team-careful-change$/su);
  assert.equal(pass.after, null);
  assert.equal(pass.counts.held, mixed.status === 'held' ? 2 : 1);
});

test('testEvidenceFrom: false keeps a step running its own tests: what absent says, in a workflow of intents or not', () => {
  const steps = (testing = {}) => {
    const value = beforeStepIntents();
    value.version = 4;
    const step = (intent, id, extra = {}) => [id, { intent, label: id, artifact: { path: `artifacts/${id}/out.md` }, defaultTemplate: 'common/intake.md', ...extra }];
    Object.assign(value.phases, Object.fromEntries([step('requirements', 'needs'), step('code', 'make'), step('test', 'check', testing)]));
    value.workTypes.team = { label: 'Team', phases: ['needs', 'make', 'check'] };
    return value;
  };
  const check = (value) => resolveWorkType(validateDefinition(value), 'team').phases.find((phase) => phase.id === 'check');
  assert.equal(check(steps()).testEvidenceFrom, 'make', 'a test step cites the code step\'s results by its intent');
  const reason = `${KEPT_BEFORE_INTENTS}, so it runs as it did; it runs its own tests.`;
  const kept = steps({ testEvidenceFrom: false, because: { testEvidenceFrom: reason } });
  const own = check(structuredClone(kept));
  assert.equal(own.testEvidenceFrom, undefined, 'false cites nothing');
  assert.deepEqual(own.inputs.map((input) => input.phase), ['needs', 'make'], 'it still reads what its intent reads');
  const derived = validateDefinition(structuredClone(kept));
  assert.ok(!deriveWorkTypeSettings(derived, 'team').warnings.some((entry) => entry.setting === 'testEvidenceFrom'), 'with its reason, nothing to explain');
  assert.equal(deriveWorkTypeSettings(derived, 'team').steps[2].sources.testEvidenceFrom.reason, reason);
  // Without intents it says what absent says.
  const legacy = beforeStepIntents();
  teamCopy(legacy, 'classic-delivery', 'team-');
  const plain = sealed(resolveWorkType(validateDefinition(structuredClone(legacy)), 'team-classic-delivery'));
  legacy.workTypes['team-classic-delivery'].phaseOverrides['team-intake'] = { ...legacy.workTypes['team-classic-delivery'].phaseOverrides['team-intake'], testEvidenceFrom: false };
  assert.equal(sealed(resolveWorkType(validateDefinition(structuredClone(legacy)), 'team-classic-delivery')), plain);
});

// ---------------------------------------------------------------------------------------------
// The upgrade's own path: the refresh of a configuration checkout

async function initialized(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-intent-pass-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'main');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity', 'workflow.yml');
  const value = YAML.parse(await readFile(file, 'utf8'));
  // The team's own workflow, a copy of classic delivery with steps of its own, written below what init wrote.
  const team = beforeStepIntents(value, value.version);
  teamCopy(team, 'classic-delivery', 'team-');
  const added = YAML.stringify({
    phases: Object.fromEntries(Object.entries(team.phases).filter(([id]) => id.startsWith('team-'))),
    workTypes: { 'team-classic-delivery': team.workTypes['team-classic-delivery'] }
  });
  const text = await readFile(file, 'utf8');
  const document = YAML.parseDocument(text);
  const extra = YAML.parse(added);
  for (const [id, step] of Object.entries(extra.phases)) document.setIn(['phases', id], document.createNode(step));
  document.setIn(['workTypes', 'team-classic-delivery'], document.createNode(extra.workTypes['team-classic-delivery']));
  await writeFile(file, document.toString());
  // The team's own agent drafts its steps, as every step has one.
  const steps = team.workTypes['team-classic-delivery'].phases.join(',');
  await writeFile(path.join(root, 'singularity', 'agents', 'team-delivery.agent.md'), ['---', 'name: team-delivery',
    'description: Drafts the team\'s own delivery steps.', 'model: [auto]', 'tools: [read, search, edit, execute, bash, ask_user]', 'metadata:',
    '  sflow-label: "Team delivery"', `  sflow-phases: "${steps}"`, `  sflow-default-for: "${steps}"`, '---', '', '# Team delivery agent', '',
    'Draft the step from its approved inputs, in the team\'s words.', ''].join('\n'));
  git('add', '-A');
  git('-c', 'user.name=Intent Tester', '-c', 'user.email=intents@example.invalid', 'commit', '-qm', 'init');
  return { root, file };
}

test('the upgrade shows the screen and writes nothing; another code writes nothing; its code writes intents, version 4 and runs as before', async (t) => {
  const { root, file } = await initialized(t);
  const original = await readFile(file, 'utf8');
  const before = await loadDefinition(root);
  const today = sealed(resolveWorkType(before, 'team-classic-delivery'));

  // The upgrade alone, which is how a person declines: the screen, its code and its commands; workflow.yml as it was.
  const shown = await refreshPackagedConfiguration(root, { repository: 'payments' });
  assert.equal(await readFile(file, 'utf8'), original, 'declining leaves the workflow as it is');
  const pass = shown.intentPass;
  assert.equal(pass.schemaVersion, 1);
  assert.deepEqual(pass.workflows.map((entry) => [entry.workflow, entry.status]), [['team-classic-delivery', 'ready']]);
  assert.match(pass.code, /^[0-9a-f]{6}$/u);
  assert.equal(pass.routes.confirm.command, `singularity-flow workspace refresh-configuration --repository payments --confirm-intents ${pass.code}`);
  assert.match(pass.summary, /^Step intents: 4 steps of your own workflows can say what they are for.* Nothing changes until you confirm: singularity-flow workspace refresh-configuration --repository payments --confirm-intents [0-9a-f]{6}$/u);
  assert.ok(!shown.files.includes('singularity/workflow.yml'));
  assert.deepEqual(refreshSummary([{ status: 'current', repository: 'payments', configurationChanged: false, intentPass: pass }]).at(-1), `payments: ${pass.summary}`);

  // Another screen's code: nothing written, and the screen as it is now with its own code.
  const stale = await refreshPackagedConfiguration(root, { repository: 'payments', stepIntents: { confirm: 'abcdef' === pass.code ? 'fedcba' : 'abcdef' } });
  assert.equal(stale.intentPass.confirmation, 'stale');
  assert.equal(stale.intentPass.code, pass.code);
  assert.equal(await readFile(file, 'utf8'), original);
  // An answer to a question the screen does not ask: nothing written.
  const refused = await refreshPackagedConfiguration(root, { repository: 'payments', stepIntents: { confirm: pass.code, answers: { 'team-testing': 'review' } } });
  assert.equal(refused.intentPass.confirmation, 'refused');
  assert.match(refused.intentPass.problems[0], /has no question on this screen/u);
  assert.equal(await readFile(file, 'utf8'), original);

  // Its code: written through the refresh's own write, version 4, each intent first among its step's keys.
  const confirmed = await refreshPackagedConfiguration(root, { repository: 'payments', stepIntents: { confirm: pass.code } });
  assert.equal(confirmed.intentPass.confirmation, 'written');
  assert.deepEqual(confirmed.intentPass.written, ['team-classic-delivery']);
  assert.ok(confirmed.files.includes('singularity/workflow.yml'));
  assert.equal(confirmed.changed, true);
  const text = await readFile(file, 'utf8');
  const written = YAML.parse(text);
  assert.equal(written.version, 4);
  assert.equal(Object.keys(written.phases['team-intake'])[0], 'intent');
  assert.match(confirmed.intentPass.summary, /^Step intents: 4 steps of 1 workflow now say what they are for.*; every workflow runs as before\.$/u);
  // Every line the confirmation did not change reads as it was.
  const kept = original.split('\n').filter((line) => !text.includes(line));
  assert.deepEqual(kept.filter((line) => !/^version:/u.test(line)), [], 'only the version line changed among the lines that were there');
  const after = await loadDefinition(root);
  assert.equal(sealed(resolveWorkType(after, 'team-classic-delivery')), today, 'it runs as before');
  for (const id of Object.keys(before.workTypes)) assert.equal(sealed(resolveWorkType(after, id)), sealed(resolveWorkType(before, id)), id);
  // The next upgrade has nothing left to offer.
  const again = await refreshPackagedConfiguration(root, { repository: 'payments' });
  assert.equal(again.intentPass, undefined);
});

test('an answer without the screen\'s code is refused before anything runs, with the command that shows the screen', async (t) => {
  const cwd = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-intent-pass-cli-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bin = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'singularity-flow.mjs');
  const result = spawnSync(process.execPath, [bin, 'workspace', 'refresh-configuration', '--intent', 'team-validate=test', '--json'], { cwd, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /STEP_INTENTS_CONFIRMATION_REQUIRED/u);
  assert.match(output, /singularity-flow workspace refresh-configuration --dry-run/u);
});

test('the upgrade\'s pass names each repository whose own workflows can say what each step is for, and writes none of them', async () => {
  const screen = { code: 'a1b2c3', summary: 'Step intents: 4 steps of your own workflows can say what they are for. Nothing changes until you confirm: x',
    counts: { workflows: 1, steps: 4, kept: 1, open: 0, held: 0 }, workflows: [{ workflow: 'team' }] };
  const calls = [];
  const refresh = async (options) => {
    calls.push(options);
    return { results: [{ status: 'current', repository: 'payments', configurationChanged: false, intentPass: screen },
      { status: 'current', repository: 'catalog', configurationChanged: false }] };
  };
  const result = await openConfigurationReviews({ registryFile: '/registry.json', refresh });
  assert.equal(result.outcome, 'current');
  assert.deepEqual(result.stepIntents, [{ repository: 'payments', code: 'a1b2c3', summary: screen.summary, counts: screen.counts }]);
  assert.ok(calls.every((options) => options.stepIntents == null), 'the pass never confirms a screen');
});
