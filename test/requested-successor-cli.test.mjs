/**
 * The owner's raj-calc Story (2026-11-10): Code generation 1 was published, not submitted, and the person
 * found a bug and asked /sf-code to fix it. The guard kept generation 1 locked, `phase rollover` needed
 * changed bytes, and the agent could only offer /sf-submit. Now what the person asked for opens generation 2
 * in the same step, once they confirm it; generation 1 and its evidence stay as published.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { approvedSpecificationStory, implementationPlan, CLI } from './helpers/submitted-planning-story.mjs';
import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationPostToolGuard, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { agentAct, boundedAgentOutput } from '../src/agent-output.mjs';
import { resolveCapabilityApplication } from '../src/capability-application-context.mjs';
import { saveLocalApplicationProfile } from '../src/local-application-profile.mjs';
import { confirmCode } from '../src/confirm-code.mjs';

const WORK = 'REDRAFT-1';
const ASKED = 'when I enter anything in f(x)= the screen size keeps changing';
// What the prompt hook keeps: everything typed after the skill's name.
const TYPED = `implementation ${ASKED}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function publishedCodeStory(t, { application = null } = {}) {
  const story = await approvedSpecificationStory(t, WORK);
  const { root, cli, item } = story;
  const write = async (relative, text) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), text); };
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  const code = (value) => `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = ${value};\n`;
  await write('src/value.mjs', code(1));
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => assert.ok(value >= 1));\n`);
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses have one focused test that reads the approved value.', '', '## Changed components and decisions', '',
    '- `src/value.mjs` exports the approved value.', '', '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value.', ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  if (application) {
    const context = await resolveCapabilityApplication(root, { subjectPath: '' });
    await saveLocalApplicationProfile(root, context, { start: [application], tests: [] });
  }
  const published = cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json').stdout;
  return { ...story, write, code, published };
}

const json = (result) => JSON.parse(result.stdout);
const workflowOf = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));

test('a change the person asks for after Code is published opens generation 2 in the same step, only on their confirmation', async (t) => {
  const story = await publishedCodeStory(t);
  const { root, cli, run, item, git } = story;
  const before = await workflowOf(item);
  assert.equal(before.phases.implementation.generation, 1);
  assert.equal(before.phases.implementation.generationIntent.status, 'consumed');
  const publishedHead = git('rev-parse', 'HEAD');
  // No application is declared here: nothing to start, said in one line with the route that declares one.
  const publication = JSON.parse(story.published);
  assert.equal(publication.applicationStart.declared, false);
  assert.match(publication.applicationStart.words, /has no saved start entry yet; \/sf-run-app suggest \(singularity-flow app suggest\) detects one, asks you which to keep and saves it on this checkout only/u);
  // Asked only when an application is declared (owner, 2026-11-19, ceremony cut 8): nothing is asked, and the line stays in
  // applicationStart.words for a view that shows it.
  const noApp = agentAct(publication);
  assert.equal(noApp.ask, undefined);
  assert.notEqual(noApp.state, 'ask-person');

  // Nothing asked for yet: rollover says how to ask, and Code is offered both ways after publication.
  const unasked = run(process.execPath, [CLI, '--no-model', 'phase', 'rollover', 'implementation', '--json'], { allowFailure: true });
  assert.notEqual(unasked.status, 0);
  assert.match(unasked.stdout + unasked.stderr, /GENERATION_CHANGE_NOT_REQUESTED/u);
  // Its way out is in the step: say what to change. Never recover, reject or end.
  const plan = JSON.parse(unasked.stdout).remediationPlan;
  assert.equal(plan.steps[0].command, 'singularity-flow phase rollover implementation --reason "<what to change>" --json', JSON.stringify(plan.steps));
  const offered = json(cli('nextsteps', '--json'));
  const commands = offered.actions.map((action) => action.command);
  assert.ok(commands.some((command) => /^singularity-flow submit implementation/u.test(command)), JSON.stringify(commands));
  assert.ok(commands.includes('singularity-flow phase rollover implementation --reason "<what to change>" --json'), JSON.stringify(commands));

  // A /sf-decide turn with nothing to decide ends on the Story's next step, never on nothing to do.
  const decide = json(cli('decisions', WORK, '--for-agent', '--json'));
  assert.equal(decide.data.status, 'nothing-to-decide');
  assert.equal(decide.act.state, 'next');
  assert.deepEqual([decide.act.do.copilot, decide.act.do.shell], ['/sf-submit', 'singularity-flow submit implementation']);
  assert.match(decide.actNext, /^next: \/sf-submit/u);

  // The person types /sf-code with what to change; the prompt hook keeps the words for generation 2.
  const hook = { cwd: await realpath(root), sessionId: 'redraft', prompt: `/sf-code ${TYPED}` };
  await recordRepositoryBoundaryTurn(hook, { captureMutation: (payload, record) => captureMutationTurn(payload, record, { resolveRoot: async () => hook.cwd }) });
  // Generation 1 stays locked to the agent: no edit of the published code.
  const edit = await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(hook.cwd, 'src/value.mjs'), old_str: 'value = 1', new_str: 'value = 2' } });
  assert.equal(edit.permissionDecision, 'deny', JSON.stringify(edit));

  // The Code entry leads with starting generation 2 for it, before submit.
  const entry = json(cli('phase', 'enter', '--compose', '--for-agent', '--json'));
  assert.equal(entry.act.do.shell, 'singularity-flow phase rollover implementation --json', JSON.stringify(entry.act));
  assert.match(entry.actNext ?? entry.next, /phase rollover implementation --json/u);
  const shell = (command) => mutationToolGuard({ ...hook, toolName: 'bash', toolArgs: { command, cwd: hook.cwd } });
  assert.deepEqual(await shell('singularity-flow phase rollover implementation --json'), {}, 'the preview runs in the Code turn');
  const preview = json(cli('phase', 'rollover', 'implementation', '--json'));
  assert.equal(preview.kind, 'requested-change');
  assert.deepEqual([preview.fromGeneration, preview.toGeneration], [1, 2]);
  // The step's name typed after the command is its target, not part of what the person asked for (OSA Stage 4, REQ-027).
  assert.deepEqual(preview.requestedChange.requests, [ASKED]);
  assert.match(preview.confirmation, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(preview.command, `singularity-flow phase rollover implementation --confirm ${preview.confirmation}`);
  // The confirmation is the person's, as for any rollover: /sf-confirm runs it once on their word.
  assert.equal(preview.copilotCommand, `/sf-confirm ${confirmCode(preview.command)}`);
  assert.ok(preview.command.endsWith(`--confirm ${preview.confirmation}`));

  // Without the person's confirmation nothing happens.
  assert.equal(git('rev-parse', 'HEAD'), publishedHead);
  assert.deepEqual(await workflowOf(item), before);
  const stale = run(process.execPath, [CLI, '--no-model', 'phase', 'rollover', 'implementation', '--confirm', `sha256:${'0'.repeat(64)}`, '--json'], { allowFailure: true });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /GENERATION_ROLLOVER_STALE/u);
  assert.deepEqual(await workflowOf(item), before);

  // In this Code turn the confirmation opens nothing without the person's yes [OSA:REQ-030]: the agent asks the preview's
  // own question, with its actual numbers (no tests were recorded for version 1, so none are promised) [§7.1].
  // Its actual numbers, and version 1's tests because its publication recorded a passing run [OSA §7.1].
  assert.equal(preview.question, 'Start version 2 of Implementation? Published version 1 and its recorded tests will stay unchanged.');
  const unasked2 = run(process.execPath, [CLI, '--no-model', 'phase', 'rollover', 'implementation', '--confirm', preview.confirmation, '--json'], { allowFailure: true });
  assert.notEqual(unasked2.status, 0);
  assert.equal(JSON.parse(unasked2.stdout).error.code, 'VERSION_CONSENT_REQUIRED');
  assert.deepEqual(await workflowOf(item), before, 'refused, it opened nothing');
  // The person's yes reaches SFlow as the host hands it to the post-tool hook; the guard keeps it for this exact version.
  await mutationPostToolGuard({ ...hook, toolName: 'ask_user', toolArgs: { question: preview.question },
    toolResult: { resultType: 'success', textResultForLlm: 'User responded: Yes' } });
  assert.deepEqual(await shell(preview.command), {}, 'the confirmation passes on the person\'s yes');
  const opened = json(cli('phase', 'rollover', 'implementation', '--confirm', preview.confirmation, '--json'));
  assert.equal(opened.mutates, true);
  assert.equal(opened.generationIntent.generation, 2);
  assert.equal(opened.generationIntent.status, 'open');
  // One opening operation, shared: its record, the person's receipt and the reserved number, pushed with the Story.
  assert.equal(opened.opening.version, 2);
  assert.equal(opened.opening.pushed, true);
  assert.equal(opened.opening.consent.surface, 'question-tool');
  assert.equal(git('rev-parse', 'HEAD'), git('rev-parse', 'origin/' + git('branch', '--show-current')));

  // Generation 2 is authored as usual: the code is editable, its tests run again and it is published.
  cli('prepare', 'implementation');
  await story.write('src/value.mjs', story.code(2));
  cli('artifact', 'scan', '--phase', 'implementation');
  // The prepublish check copies what the person asked for into the Story, as "Asked for" of generation 2.
  run(process.execPath, [CLI, '--no-model', 'phase', 'prepublish', 'implementation', '--json'], { allowFailure: true });
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  const after = await workflowOf(item);
  assert.equal(after.phases.implementation.generation, 2);
  assert.ok((after.askedFor ?? []).some((entry) => entry.phase === 'implementation' && entry.generation === 2 && entry.text === ASKED),
    JSON.stringify(after.askedFor));
  // Generation 1's publication and its bytes are intact, under generation 2.
  assert.equal(run('git', ['merge-base', '--is-ancestor', publishedHead, 'HEAD'], { allowFailure: true }).status, 0);
  assert.equal(git('show', `${publishedHead}:src/value.mjs`), story.code(1).trimEnd());
  assert.equal(JSON.parse(git('show', `${publishedHead}:singularity/work-items/${WORK}/workflow.json`)).phases.implementation.generationIntent.status, 'consumed');
});

// Daily run 2026-11-17: `/sf-code <words>` after publication got an entry whose act said "preview version 2" while its edit
// permission said "No direct edits: this step is not being written now" and the kernel's next was `submit-version`; the agent
// told the person they had asked for nothing. Typed with the step's name it went on. One answer now, either way.
test('a change typed after /sf-code, with or without the step\'s name, is one version question for the entry, its permission, the kernel and the guard', async (t) => {
  for (const [name, typed] of [['without the step', ASKED], ['with the step', TYPED]]) {
    const story = await publishedCodeStory(t);
    const { root, cli } = story;
    const hook = { cwd: await realpath(root), sessionId: `typed-${name.replaceAll(' ', '-')}`, prompt: `/sf-code ${typed}` };
    let turn = null;
    await recordRepositoryBoundaryTurn(hook, { captureMutation: async (payload, record) => {
      turn = await captureMutationTurn(payload, record, { resolveRoot: async () => hook.cwd });
      return turn;
    } });
    // The guard reads the words in the turn that typed them: its rules ask the version question.
    assert.match(turn?.additionalContext ?? '', /No edits before the person's yes to version 2 of implementation/u, name);
    assert.doesNotMatch(turn?.additionalContext ?? '', /not being written now/u, name);
    const edit = await mutationToolGuard({ ...hook, toolName: 'edit', toolArgs: { path: path.join(hook.cwd, 'src/value.mjs'), old_str: 'value = 1', new_str: 'value = 2' } });
    assert.equal(edit.permissionDecision, 'deny', name);
    assert.match(edit.permissionDecisionReason, /person's yes to version 2 of implementation[\s\S]*singularity-flow phase rollover implementation --json/u, name);
    // The entry's act: the engine's own question first, its preview the one thing to run on a yes.
    const agent = json(cli('phase', 'enter', '--compose', '--for-agent', '--json'));
    assert.equal(agent.act.state, 'confirm', name);
    assert.equal(agent.act.ask.question, 'Start version 2 of Implementation? Published version 1 and its recorded tests will stay unchanged.', name);
    assert.equal(agent.act.do.shell, 'singularity-flow phase rollover implementation --json', name);
    // The full entry: its permission and the kernel's next say the same; submitting it as it stands is still offered, after.
    const entry = json(cli('phase', 'enter', '--json'));
    assert.equal(entry.status, 'successor-confirmation-required', name);
    assert.deepEqual(entry.successor.requests, [ASKED], name);
    assert.equal(entry.mutationContract.policy.step.next, 'open-version:implementation@2', name);
    assert.deepEqual(entry.mutationContract.policy.step.reasons, ['CHANGE_REQUESTED', 'CONSENT_REQUIRED'], name);
    assert.equal(entry.mutationContract.next[0].command, 'singularity-flow phase rollover implementation --json', name);
    assert.match(entry.mutationContract.summary, /person's yes to version 2 of implementation/u, name);
    const routes = entry.next.map((action) => action.commandGuidance?.command ?? action.command);
    assert.equal(routes[0], 'singularity-flow phase rollover implementation --json', name);
    assert.ok(routes.slice(1).some((command) => /^singularity-flow submit implementation\b/u.test(command ?? '')), `${name}: ${JSON.stringify(routes)}`);
    // The person's own views lead with the same question, never /sf-submit: next steps, submission readiness, phase show.
    const steps = json(cli('nextsteps', '--json')).actions;
    assert.equal(steps.find((action) => action.timing === 'now')?.command, 'singularity-flow phase rollover implementation --json', `${name}: ${JSON.stringify(steps)}`);
    assert.ok(steps.some((action) => action.timing !== 'now' && /^singularity-flow submit implementation\b/u.test(action.command ?? '')), name);
    const readiness = json(cli('status', WORK, '--submission-readiness', '--json'));
    assert.deepEqual([readiness.classification, readiness.nextCommand, readiness.nextSkill?.split(' ')[0]],
      ['change-requested', 'singularity-flow phase rollover implementation --json', '/sf-code'], name);
    // Submitting this version as it is stays the person's choice: /sf-submit's own command runs it.
    assert.match(readiness.submission ?? '', new RegExp(`^singularity-flow submit implementation --work-id ${WORK}\\b`, 'u'), name);
    const shown = json(cli('phase', 'show', 'implementation', '--json'));
    assert.equal(shown.continuation?.nextAction?.command, 'singularity-flow phase rollover implementation --json', `${name}: ${JSON.stringify(shown.continuation).slice(0, 800)}`);
  }
});

test('after Code is published with its tests passing, the person is asked once whether to start the application', async (t) => {
  const application = { id: 'web', argv: ['node', 'server.mjs', '4599'], url: 'http://127.0.0.1:4599/', ready: { http: '/', timeoutMs: 5000 } };
  const story = await publishedCodeStory(t, { application });
  const { root, cli } = story;
  const publication = JSON.parse(story.published);
  assert.equal(publication.applicationStart.declared, true);
  assert.deepEqual(publication.applicationStart.choices.map((choice) => choice.id), ['start', 'not-now']);
  assert.equal(publication.applicationStart.choices[0].copilotCommand, '/sf-run-app start');
  // Not now: the step goes on, submit first, then its next generation for a change.
  assert.deepEqual(publication.applicationStart.choices[1].routes.map((route) => route.command),
    ['singularity-flow submit implementation', 'singularity-flow phase rollover implementation --reason "<what to change>" --json']);
  // Its words name those routes, in order: "submit it" sat over a review route first (agent-text audit, 2026-11-11).
  const onward = publication.applicationStart.choices[1].routes.map((route) => route.copilotCommand ?? route.command);
  assert.equal(publication.applicationStart.choices[1].description, `Go on with the step: ${onward.join(', then ')}.`);
  // The agent view asks it first, in the first 400 bytes, and its last line names it.
  const view = await boundedAgentOutput(story.published, { cwd: root });
  const asked = JSON.parse(view);
  assert.equal(asked.act.state, 'ask-person');
  assert.deepEqual(asked.act.ask.choices.map((choice) => choice.label), ['Start the application', 'Not now']);
  assert.match(Buffer.from(view).subarray(0, 400).toString('utf8'), /"ask":\{"kind":"choice","question":"Version 1 of Implementation passes its tests\. Start the application to try it\?/u);
  assert.match(view.trimEnd().split('\n').at(-1), /^"next":"ask-person: ask the person: .*\(Start the application \/ Not now\)"\}$/u);
  // Asked once: a later read goes on with the step and does not ask again.
  const later = JSON.parse(cli('nextsteps', '--for-agent', '--json').stdout);
  assert.equal(later.act.ask, undefined);
  assert.equal(later.act.state, 'next');
  // Nothing started the application: that is the person's choice.
  const status = JSON.parse(cli('app', 'status', '--json').stdout);
  assert.equal(JSON.stringify(status).includes('"started":true'), false, JSON.stringify(status).slice(0, 400));
});
