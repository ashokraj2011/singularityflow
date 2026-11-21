/**
 * Generated workflows of step intents (step intents spec §9.3, Stage 2): workflows built from intents alone, with
 * random step IDs, labels drawn to mismatch their intents and random approval groups, each derived and checked:
 *
 * - it derives, loads and starts (assertWorkTypeStartable), and its routes simulate with no finding;
 * - a person approves exactly the steps §5 says: the plan of each code step and every code step, or in a workflow
 *   that changes no code its scope step and its last step;
 * - only the one §5 question step asks every time;
 * - a test or review step cites the latest code step's results while nothing since changed source;
 * - names decide nothing: the same intents under other IDs and labels give the same settings and route shape;
 * - a code step with nothing before it, or with no step that writes the requirements it builds, is refused at start
 *   with its two ways on, never started half-planned.
 *
 * Grammars: code workflows `intake? requirements? design* plan? (code test*)+ review? release? report?`, code-free
 * ones `intake? requirements? (design|test|document)+ report?`. 20 per run, seeded; SINGULARITY_FLOW_GENERATED_WORKFLOWS
 * sets the count (200 nightly) and SINGULARITY_FLOW_GENERATED_SEED the seed, which every failure names.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { approvesAutomatically } from '../src/approval-authority.mjs';
import { phaseRequiresCodeDelivery } from '../src/code-delivery-policy.mjs';
import { assertWorkTypeStartable, resolveWorkType, validateDefinition } from '../src/config.mjs';
import { DOCUMENT_INTENTS, INTENT_WORDS, STEP_INTENTS } from '../src/step-intents.mjs';
import { simulateWorkflowRoutes } from '../src/workflow-route-simulation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = YAML.parse(readFileSync(path.join(ROOT, 'templates/workflow.yml'), 'utf8'));
const COUNT = Number(process.env.SINGULARITY_FLOW_GENERATED_WORKFLOWS ?? 20);
const SEED = Number(process.env.SINGULARITY_FLOW_GENERATED_SEED ?? 20261121);

/** A small seeded generator (mulberry32), so a failing workflow can be made again from its seed. */
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

/** One workflow's intents, by the code or the code-free grammar. */
function intentsFor(random) {
  const optional = (intent, p = 0.5) => (random.chance(p) ? [intent] : []);
  if (random.chance(0.7)) {
    const blocks = [];
    for (let count = random.int(1, 2); count > 0; count -= 1) blocks.push('code', ...Array.from({ length: random.int(0, 2) }, () => 'test'));
    return [...optional('intake', 0.7), ...optional('requirements'), ...Array.from({ length: random.int(0, 2) }, () => 'design'), ...optional('plan'),
      ...blocks, ...optional('review'), ...optional('release', 0.3), ...optional('report', 0.3)];
  }
  return [...optional('intake'), ...optional('requirements'), ...Array.from({ length: random.int(1, 3) }, () => random.pick(['design', 'test', 'document'])),
    ...optional('report')];
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'sa', 'tu', 've', 'ro', 'di', 'pa'];

/** A configuration with one generated work type `gen`: random step IDs, mismatching labels and random approval groups. */
function generatedDefinition(intents, random, { ids = null, labels = null } = {}) {
  const value = structuredClone(BASE);
  value.version = 4;
  value.phases = {};
  delete value.documents;
  delete value.contextPolicy;
  delete value.mcpServers;
  // Random groups, and sometimes the profile's own, so both the profile's group and the first-group fallback run.
  const groups = Array.from({ length: random.int(1, 3) }, (_, index) => `${random.pick(SYLLABLES)}${random.pick(SYLLABLES)}-team-${index}`);
  if (random.chance(0.5)) groups.push('quality-reviewers', 'architecture-reviewers');
  value.approvalAuthorities = Object.fromEntries(groups.map((id) => [id, { label: id, allowAnyGitIdentity: true, members: [] }]));
  const stepIds = ids ?? intents.map((_, index) => `${random.pick(SYLLABLES)}${random.pick(SYLLABLES)}-${index}`);
  intents.forEach((intent, index) => {
    // A label from another intent's words: a step called "Run the tests" may be the plan.
    const other = random.pick(STEP_INTENTS.filter((candidate) => candidate !== intent && INTENT_WORDS[candidate]));
    const label = labels?.[index] ?? `${random.pick(INTENT_WORDS[other])} ${index}`.replace(/^./u, (first) => first.toUpperCase());
    value.phases[stepIds[index]] = { intent, label, artifact: { path: `artifacts/${stepIds[index]}/out.md` }, defaultTemplate: 'common/intake.md' };
  });
  value.workTypes = { gen: { label: 'Generated', phases: stepIds } };
  return { value, ids: stepIds, groups };
}

const who = (phase) => (phase.approval.mode === 'none' ? 'none' : approvesAutomatically(phase.approval) ? 'sflow' : 'person');

/** The person approvals §5 gives these intents: each code step and its planner, or a code-free workflow's scope and last step. */
function expectedPeople(intents) {
  const codes = intents.flatMap((intent, index) => (intent === 'code' ? [index] : []));
  const scope = intents.includes('requirements') ? intents.flatMap((intent, index) => (intent === 'requirements' ? [index] : []))
    : intents.includes('plan') ? [intents.indexOf('plan')] : intents.includes('intake') ? [intents.indexOf('intake')] : [];
  if (!codes.length) return new Set([...scope, intents.length - 1]);
  const people = new Set(codes);
  for (const code of codes) {
    const before = intents.slice(0, code).map((intent, index) => [intent, index]).reverse();
    const planner = before.find(([intent]) => intent === 'plan') ?? before.find(([intent]) => intent === 'design')
      ?? before.find(([, index]) => scope.includes(index));
    if (planner) people.add(planner[1]);
  }
  return people;
}

/** What a step is, without its name: for comparing two workflows of the same intents. */
const shape = (resolved) => {
  const position = new Map(resolved.phases.map((phase, index) => [phase.id, index]));
  return resolved.phases.map((phase) => ({
    writeScope: phase.writeScope, kind: phase.artifact.kind, code: phaseRequiresCodeDelivery(phase), who: who(phase),
    questions: [phase.clarification.mode, phase.clarification.maxQuestions], repositoryTests: phase.repositoryTests ?? 'off',
    cites: phase.testEvidenceFrom ? position.get(phase.testEvidenceFrom) : null, reads: phase.inputs.map((input) => position.get(input.phase)),
    sendBack: phase.approval.rejectTo.map((id) => position.get(id))
  }));
};

test(`generated workflows of intents derive, start and get what §5 says (${COUNT}, seed ${SEED})`, () => {
  const random = generator(SEED);
  let started = 0;
  let unplanned = 0;
  for (let run = 0; run < COUNT; run += 1) {
    const intents = intentsFor(random);
    const { value, ids } = generatedDefinition(intents, random);
    const where = `seed ${SEED}, workflow ${run + 1}: ${intents.join(' ')}`;
    const definition = validateDefinition(structuredClone(value));
    const resolved = resolveWorkType(definition, 'gen');
    assert.deepEqual(resolved.phases.map((phase) => phase.intent), intents, where);
    const firstCode = intents.indexOf('code');
    const unscoped = firstCode > 0 && !['intake', 'requirements', 'plan'].some((intent) => intents.includes(intent));
    if (firstCode === 0 || unscoped) {
      // Nothing before the code step plans it, or no step writes the requirements it builds: refused at start, with
      // the two ways on (§5), never started half-planned.
      assert.throws(() => assertWorkTypeStartable(resolved), (error) => error.code === 'WORKFLOW_PLANNED_CLAIMS_MIGRATION_REQUIRED'
        && (unscoped ? /Add an intake or requirements step before it \(recommended\), or let it work without requirement IDs/u
          : /Add a short plan step before \S.* \(recommended\), or let (it plan its own change|them plan their own changes)/u).test(error.message)
        && error.details.nextAction.command === 'singularity-flow workflow studio', where);
      unplanned += 1;
      continue;
    }
    assertWorkTypeStartable(resolved);
    started += 1;
    assert.deepEqual(simulateWorkflowRoutes(resolved, { approvalAuthorities: definition.approvalAuthorities }).findings, [], where);
    // Approve twice: exactly the steps §5 gives a person.
    const people = new Set(resolved.phases.flatMap((phase, index) => (who(phase) === 'person' ? [index] : [])));
    assert.deepEqual([...people].sort(), [...expectedPeople(intents)].sort(), where);
    // Only the one question step asks every time: the intake, else a first document step.
    const asking = resolved.phases.flatMap((phase, index) => (phase.clarification.mode === 'required' ? [index] : []));
    const questionStep = intents.includes('intake') ? intents.indexOf('intake') : DOCUMENT_INTENTS.includes(intents[0]) ? 0 : null;
    assert.deepEqual(asking, questionStep == null ? [] : [questionStep], where);
    // Only code steps change source files, and each test or review step after one cites its results.
    resolved.phases.forEach((phase, index) => {
      assert.equal(phase.writeScope === 'source-and-artifact', intents[index] === 'code', where);
      const lastCode = intents.slice(0, index).lastIndexOf('code');
      const cites = ['test', 'review'].includes(intents[index]) && lastCode >= 0 ? ids[lastCode] : undefined;
      assert.equal(phase.testEvidenceFrom, cites, `${where}: step ${index + 1}`);
      if (cites) assert.ok(phase.inputs.some((input) => input.phase === cites), where);
    });
    // Names decide nothing: other IDs and labels, the same settings and route shape.
    const renamed = generatedDefinition(intents, generator(SEED + run + 1), { ids: intents.map((_, index) => `step-${index + 1}`), labels: intents.map(() => 'Step') });
    renamed.value.approvalAuthorities = value.approvalAuthorities;
    const other = resolveWorkType(validateDefinition(renamed.value), 'gen');
    assert.equal(other.obligationGraph.shapeDigest, resolved.obligationGraph.shapeDigest, where);
    assert.deepEqual(shape(other), shape(resolved), where);
  }
  assert.ok(started > COUNT / 2, `most generated workflows start (${started} of ${COUNT})`);
  assert.equal(started + unplanned, COUNT);
});
