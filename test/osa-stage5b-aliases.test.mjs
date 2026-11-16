/**
 * SPEC-OSA v1.1, Stage 3 and 4 leftovers (docs/osa/stage4.md section 11, docs/osa/stage5b.md):
 *   - the Copilot hook's skill lists come from the one alias table (src/writing-aliases.mjs), and say exactly what the
 *     hand-written lists said [OSA:REQ-027];
 *   - AC-019's invocations Stage 4 left unpinned, each with its compatibility contract (parameters, explicit targets,
 *     output and error shapes, standalone behaviour): /sf-verify used off a verification step, /sf-run at the authoring
 *     boundary, and the fast-path verbs where a work type has none (docs/osa/alias-matrix.md section 8).
 * The Story cases run the real CLI and hooks on isolated quick-fix Stories with a local bare remote
 * (test/helpers/route-follower.mjs journeyRepository). Expected results are written out here.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { ASKED_FOR_SKILLS, TASK_COMPLETION_ALIASES, WRITING_ALIASES, writingAlias } from '../src/writing-aliases.mjs';
import { localAskedFor, typedInstruction } from '../src/asked-for.mjs';
import { workflowTaskCompletionRequested } from '../src/copilot-repository-boundary.mjs';
import { AUTHORING_SKILL_DECLARATION } from '../src/authoring-skills.mjs';
import { WORK_COMMANDS } from '../src/command-skills.mjs';
import { deriveMutationContract, mutationTurnMode } from '../src/phase-mutation-contract.mjs';
import { FAST_PATH_VERBS } from '../src/fast-path.mjs';
import { CLI, copilotTurn, journeyRepository, startStory, storyRecord } from './helpers/route-follower.mjs';
import { quickFixIntake } from './helpers/journey-scripts.mjs';
import { reviewStep } from './helpers/step-review.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = process.platform === 'win32' ? { skip: 'the refusing ports are shell scripts' } : {};

// ------------------------------------------------------------------------------------------- the hook's skill lists

// What the hook listed by hand before the table (copilot-repository-boundary.mjs at d5522e815): the turns whose typed
// words are kept, and the aliases outside the authoring catalog whose turn completes the step's task.
const HAND_ASKED_FOR = ['sf-code', 'sflow-code', 'sf-phase', 'sflow-phase'];
const HAND_TASK_COMPLETION = ['sflow-call', 'sflow-implement', 'sflow-specify', 'sflow-plan', 'sflow-verify', 'sflow-scenario-repair'];

test('the hook\'s skill lists are the alias table\'s, and say exactly what the hand-written lists said [OSA:REQ-027]', async () => {
  const named = (keep) => Object.entries(WRITING_ALIASES).filter(([, alias]) => keep(alias)).map(([name]) => name);
  // The lists equal the table.
  assert.deepEqual(ASKED_FOR_SKILLS, named((alias) => alias.kind === 'work-command').flatMap((name) => [`sf-${name}`, `sflow-${name}`]));
  assert.deepEqual(TASK_COMPLETION_ALIASES, named((alias) => alias.completesTask).map((name) => `sflow-${name}`));
  // asked-for.mjs keeps no list of its own: what it records follows the table.
  assert.ok(!readFileSync(path.join(root, 'src/asked-for.mjs'), 'utf8').includes("'sflow-code'"));
  for (const name of Object.keys(WRITING_ALIASES)) {
    for (const skill of [`sf-${name}`, `sflow-${name}`]) {
      const kept = await typedInstruction({ prompt: `/${skill} tighten the message` }, skill);
      assert.deepEqual(kept, ASKED_FOR_SKILLS.includes(skill) ? { text: 'tighten the message' } : null, skill);
    }
  }
  // And what they said by hand.
  assert.deepEqual(ASKED_FOR_SKILLS, HAND_ASKED_FOR);
  assert.deepEqual(TASK_COMPLETION_ALIASES.filter((skill) => !AUTHORING_SKILL_DECLARATION[skill]).sort(), [...HAND_TASK_COMPLETION].sort());
  // The work command's two names are the table's.
  assert.deepEqual(named((alias) => alias.kind === 'work-command').map((name) => `/sf-${name}`), [...WORK_COMMANDS]);
  // Behaviour unchanged for every packaged skill, typed or as a host's skill context, with an argument or a single step's word.
  const { skills } = YAML.parse(readFileSync(path.join(root, 'plugin/skills/registry.yml'), 'utf8'));
  const names = (Array.isArray(skills) ? skills : Object.keys(skills)).map((entry) => (typeof entry === 'string' ? entry : entry.id ?? entry.name))
    .map((name) => String(name).replace(/^sflow-/u, ''));
  assert.ok(names.length > 50, String(names.length));
  for (const name of names) {
    const before = Boolean(AUTHORING_SKILL_DECLARATION[`sflow-${name}`] || HAND_TASK_COMPLETION.includes(`sflow-${name}`));
    for (const prompt of [`/sf-${name}`, `/sf-${name} the parser`, `/sflow-${name} focus`, `<skill-context name="sf-${name}">x\nARGUMENTS: focus\n</skill-context>`]) {
      assert.equal(workflowTaskCompletionRequested(prompt), before, prompt);
    }
    assert.equal(workflowTaskCompletionRequested(`/sf-${name} status`), false, `/sf-${name} status is a single step`);
  }
  // Every alias in the table is a packaged skill, an authoring turn, and read by the adapter; nothing else is an alias.
  for (const [name, alias] of Object.entries(WRITING_ALIASES)) {
    assert.ok(readdirSync(path.join(root, 'plugin/skills')).includes(`sflow-${name}`), name);
    assert.notEqual(writingAlias(`/sf-${name}`, 'focus', { steps: ['implement'], stepAgent: 'focus' }), null, name);
    if (alias.completesTask) assert.equal(mutationTurnMode(`sf-${name}`), 'authoring', name);
  }
  assert.equal(writingAlias('/sf-approve'), null);
});

// ---------------------------------------------------------------------------------------------- isolated Stories

const W = 'ALS-1';
const json = (ran) => JSON.parse(ran.stdout.slice(ran.stdout.search(/^\s*\{/mu)) || 'null');
const hook = (story, event, payload) => {
  const ran = story.spawn(process.execPath, [CLI, 'hook', event], { input: JSON.stringify({ cwd: story.root, ...payload }) });
  return JSON.parse(ran.stdout || '{}');
};
const decision = (answer) => answer.permissionDecision ?? answer.hookSpecificOutput?.permissionDecision ?? 'allow';
/** What a command may not change: the Story branch, the working tree and the Story's record. */
const unchanged = (story) => {
  const before = { head: story.git('rev-parse', 'HEAD'), status: story.git('status', '--short'), record: JSON.stringify(storyRecord(story)) };
  return () => assert.deepEqual({ head: story.git('rev-parse', 'HEAD'), status: story.git('status', '--short'), record: JSON.stringify(storyRecord(story)) }, before);
};

/** A quick fix (a work type with no fast path) at its intake step, or with intake approved and its code step next. */
async function quickFix(t, { atCode = false } = {}) {
  const story = await journeyRepository(t);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  if (!atCode) return story;
  story.cli('prepare', 'intake');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
  assert.equal(storyRecord(story).currentPhase, 'implement');
  return story;
}

test('fast-path verbs where the work type has none: the router\'s own not-routed answer, its explicit target and shapes, nothing changed [AC-019]', async (t) => {
  const story = await quickFix(t);
  const same = unchanged(story);
  for (const verb of FAST_PATH_VERBS) {
    // No argument of the alias's own: the router names the step, and an unrouted work type is told so.
    if (verb === 'specify' || verb === 'plan') assert.deepEqual(writingAlias(`/sf-${verb}`, 'anything typed'), { router: verb });
    for (const args of [[verb, '--json'], [verb, W, '--json'], [verb, '--work-id', W, '--json']]) {
      const ran = story.raw(args);
      assert.equal(ran.status, 0, `${args.join(' ')}\n${ran.stdout.slice(-2000)}\n${ran.stderr.slice(-1000)}`);
      const result = json(ran);
      assert.deepEqual({ operation: result.operation, subject: result.subject, outcome: result.outcome },
        { operation: { id: verb, classification: 'read' }, subject: { kind: 'story', id: W },
          outcome: { status: 'refused', messageId: 'fastpath.blocked', slots: { verb, checkpoint: 'not-routed' } } }, args.join(' '));
      assert.deepEqual(result.effects, { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false });
      const plan = result.data.fastPath;
      assert.deepEqual({ verb: plan.verb, milestone: plan.milestone, outcome: plan.outcome, checkpoint: plan.checkpoint, underlyingOperations: plan.underlyingOperations },
        { verb, milestone: null, outcome: 'blocked', underlyingOperations: [],
          checkpoint: { kind: 'not-routed', reason: 'Work type \'quick-fix\' does not configure the fast path; its steps use the phase commands.' } });
      assert.deepEqual(plan.why, [{ code: 'fastpath.not-configured', source: 'config', slots: { workType: 'quick-fix', verb } }]);
      assert.deepEqual(result.why.map(({ code, slots }) => ({ code, slots })), [{ code: 'fastpath.not-configured', slots: { workType: 'quick-fix', verb } }]);
      // The Story's own next steps, never a guessed authoring action.
      assert.deepEqual(result.next.map(({ command, skill, rank }) => ({ command, skill, rank })), [{ command: 'sflow nextsteps', skill: '/sf-nextsteps', rank: 'NOW' }]);
    }
    // The text form refuses with its own exit and words, naming the work type it read.
    const text = story.raw([verb]);
    assert.equal(text.status, 2, text.stdout);
    assert.match(text.stdout, new RegExp(`${verb} cannot continue: not-routed\\.`, 'u'));
    assert.match(text.stdout, /work type quick-fix does not configure the fast path, so its steps use the phase commands/u);
    assert.match(text.stdout, /No lifecycle state, files, publications or external systems were changed\./u);
  }
  same();
  // A /sf-specify turn relays the router's next steps and may end there: the alias completes tasks, but nothing was entered.
  const turn = copilotTurn(story, 'fast-path-turn');
  assert.equal(workflowTaskCompletionRequested('/sf-specify'), true);
  turn.prompt('/sf-specify');
  assert.equal(decision(turn.tool('bash', { command: 'singularity-flow specify --json' })), 'allow');
  assert.deepEqual(hook(story, 'boundary-stop', { sessionId: 'fast-path-turn', stopReason: 'end_turn' }), {});
  same();
});

test('/sf-verify used off a verification step: its scope stays its own, the step\'s writer is relayed, and its turn gains nothing [AC-019]', async (t) => {
  const story = await quickFix(t, { atCode: true });
  const steps = storyRecord(story).phaseOrder;
  // On a step /sf-phase writes, the verification checklist with its scope; a step word typed is scope, never a target.
  assert.deepEqual(writingAlias('/sf-verify', 'the parser on Node 22', { steps, writer: '/sf-phase' }), { checklist: 'verification', scope: 'the parser on Node 22' });
  assert.deepEqual(writingAlias('/sf-verify', 'implement', { steps, writer: '/sflow-phase' }), { checklist: 'verification', scope: 'implement' });
  assert.deepEqual(writingAlias('/sf-verify', '', { steps }), { checklist: 'verification', scope: null }, 'its writer not read yet: the skill reads it first');
  // Its two reads, as the skill runs them: the Story's next steps, then the step it names, whose writer is not /sf-phase.
  const same = unchanged(story);
  const next = json(story.raw(['nextsteps', '--for-agent', '--json']));
  assert.equal(next.act.do.copilot, '/sf-code');
  const shown = json(story.raw(['phase', 'show', 'implement', '--for-agent', '--json']));
  assert.deepEqual({ phase: shown.phase, writer: shown.effectiveAuthoringSkill, policyVerified: shown.policyVerified },
    { phase: 'implement', writer: '/sf-code', policyVerified: true });
  same();
  // So the adapter relays the step's own work command, the kernel's route, and verifies nothing here.
  assert.deepEqual(writingAlias('/sf-verify', 'the parser', { steps, writer: shown.effectiveAuthoringSkill }), { relay: '/sf-code', scope: 'the parser' });
  assert.equal(shown.handoff[0].copilotCommand, '/sf-code');
  const skill = readFileSync(path.join(root, 'plugin/skills/sflow-verify/SKILL.md'), 'utf8');
  assert.match(skill, /If `effectiveAuthoringSkill` is not `\/sf-phase` \(a release step returns `\/sf-release`\), relay it and stop\./u);
  assert.ok(skill.indexOf('relay it and stop') < skill.indexOf('phase enter <phase> --compose'), 'the relay comes before any verification authoring');
  // Through the real hooks: its reads run, an edit gets the code step's own refusal and route, and the turn may end
  // after the relay. Its scope words are never kept as what the person asked for; the work command's are.
  const turn = copilotTurn(story, 'verify-turn');
  turn.prompt('/sf-verify the parser');
  assert.equal(decision(turn.tool('bash', { command: 'singularity-flow nextsteps --for-agent --json' })), 'allow');
  assert.equal(decision(turn.tool('bash', { command: 'singularity-flow phase show implement --for-agent --json' })), 'allow');
  const edit = turn.tool('edit', { path: path.join(story.root, 'src/value.mjs') });
  assert.equal(decision(edit), 'deny');
  assert.match(edit.permissionDecisionReason, /^PHASE_MUTATION_PATH_DENIED .*No edits until its code version is open/u);
  assert.match(edit.permissionDecisionReason, /\n- Copilot: \/sf-code\n- Shell: singularity-flow phase begin implement --json\n/u);
  assert.deepEqual(hook(story, 'boundary-stop', { sessionId: 'verify-turn', stopReason: 'end_turn' }), {});
  const gitDir = path.join(story.root, '.git');
  const kept = async () => (await localAskedFor(gitDir, { workId: W, phase: 'implement', generation: 1 })).turns.map((entry) => entry.text);
  assert.deepEqual(await kept(), []);
  copilotTurn(story, 'code-turn').prompt('/sf-code the parser');
  assert.deepEqual(await kept(), ['the parser'], 'the work command\'s words are kept, so the empty list above is /sf-verify\'s own contract');
  same();
});

/** Every AI port on PATH refuses and records the call, so a command run with the model on cannot reach one. */
function refusingPorts(base) {
  const bin = path.join(base, 'refusing-ports');
  const log = path.join(base, 'ports-invoked.log');
  mkdirSync(bin, { recursive: true });
  for (const name of ['copilot', 'github-copilot-cli']) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit 97\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  return { env: { SINGULARITY_FLOW_NO_MODEL: '0', PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    invoked: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []) };
}

/** What a guided run printed at the authoring boundary: the step's work command, as the action map names it, and its label. */
function boundaryRoute(stdout) {
  const found = /Write it in the step's work command, which publishes it once its checks pass:\n {2}([^\n]+):\n {2}- Copilot: ([^\n]+)\n {2}- Shell: ([^\n]+)\n/u.exec(stdout);
  assert.ok(found, stdout.slice(-1500));
  return { label: found[1], copilot: found[2], shell: found[3] };
}

test('/sf-run at the authoring boundary: its guided run stops there with the step\'s route, takes no task, and its turn is the work command\'s [AC-019]', posix, async (t) => {
  assert.deepEqual(writingAlias('/sf-run', 'focus on errors'), { standalone: 'guided-run', focus: 'focus on errors' });
  // The model on, every AI port refusing: the guided run's own answer, as a person in Copilot gets it. The ports live in
  // the journey's own folder, which journeyRepository removes; every command the Story runs reads this environment.
  const story = await journeyRepository(t);
  const ports = refusingPorts(story.base);
  Object.assign(story.env, ports.env);
  startStory(story, W, { workType: 'quick-fix', title: 'Change the value', description: 'Return 2.' });
  // Its phase-authoring use is the work command's turn, with the same permission on this step [§10].
  const contract = (skill) => deriveMutationContract({ definition: { workItemRoot: 'singularity/work-items' }, workflow: storyRecord(story), turnMode: mutationTurnMode(skill) });
  assert.equal(mutationTurnMode('sf-run'), 'authoring');
  assert.deepEqual(contract('sf-run'), contract('sf-code'));
  // Arguments are emphasis only: the guard runs `run` as the skill types it, never with a task or a repair wrapper.
  const turn = copilotTurn(story, 'run-turn');
  turn.prompt('/sf-run focus on errors');
  assert.equal(decision(turn.tool('bash', { command: 'singularity-flow run' })), 'allow');
  for (const command of ['singularity-flow run make it return 2', 'singularity-flow run --repair-on-fault -- npm test']) {
    const refused = turn.tool('bash', { command });
    assert.equal(decision(refused), 'deny', command);
    assert.match(refused.permissionDecisionReason, /^PHASE_MUTATION_OPERATION_NOT_ALLOWED: this turn does not run this SFlow command\./u, command);
  }
  const run = (step) => {
    const kernel = json(story.raw(['nextsteps', '--for-agent', '--json'])).act.do;
    const ran = story.raw(['run']);
    assert.equal(ran.status, 0, `${ran.stdout.slice(-3000)}\n${ran.stderr.slice(-1500)}`);
    assert.match(ran.stdout, new RegExp(`Next step prepared: generate '${step}' using singularity/work-items/${W}/artifacts/${step}/`, 'u'));
    assert.match(ran.stdout, /Guided run stopped at the authoring boundary or required human review shown above\.\nFollow only the exact next action returned by preparation\.\n$/u);
    const phase = storyRecord(story).phases[step];
    assert.deepEqual({ status: phase.status, generation: phase.generation, published: phase.generationPublications.length, opened: phase.versionOpening?.version ?? null },
      { status: 'in_progress', generation: 0, published: 0, opened: step === 'implement' ? 1 : null }, `${step}: prepared; nothing written, published or submitted`);
    return { kernel, route: boundaryRoute(ran.stdout) };
  };
  // What it returns at the boundary is the map's route for the step, its work command (D1; D5 for a kernel-built step), as
  // the kernel names it, never the publication (/sf-publish <step>) [docs/osa/stage5b.md section 5, decision 3]; the skill
  // then loads that work command once.
  const intake = run('intake');
  assert.deepEqual(intake.route, { label: 'Work command', copilot: '/sf-phase', shell: 'singularity-flow prepare intake' });
  assert.equal(intake.kernel.copilot, '/sf-phase');
  // The publication a model never wrote is still refused: its own checks refuse the prepared draft.
  const early = story.raw(['phase', 'publish', 'intake', '--authored', 'governed-agent', '--channel', 'copilot-host', '--json']);
  assert.notEqual(early.status, 0, early.stdout.slice(-1500));
  assert.equal(storyRecord(story).phases.intake.generation, 0, 'nothing published');
  await story.write(`${story.item}/artifacts/intake/intake.md`, quickFixIntake(W));
  story.cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
  reviewStep((args) => JSON.parse(story.cli(...args)), 'intake');
  story.cli('submit', 'intake');
  story.cli('approve', 'intake', '--yes');
  // A kernel-built step (D5): the same, its work command, which builds it with its generator.
  const code = run('implement');
  assert.deepEqual(code.route, { label: 'Work command', copilot: '/sf-code', shell: 'singularity-flow prepare implement' });
  assert.equal(code.kernel.copilot, '/sf-code');
  assert.equal(storyRecord(story).phases.implement.versionOpening.consent, null, 'version 1 owes no yes');
  assert.deepEqual(ports.invoked(), [], 'no AI port was called');
});
