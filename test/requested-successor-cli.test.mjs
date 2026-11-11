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
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { agentAct, boundedAgentOutput } from '../src/agent-output.mjs';
import { resolveCapabilityApplication } from '../src/capability-application-context.mjs';
import { saveLocalApplicationProfile } from '../src/local-application-profile.mjs';

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
  assert.match(publication.applicationStart.words, /declares no application to start; \/sf-run-app suggest/u);
  const noApp = agentAct(publication);
  assert.equal(noApp.ask, undefined);
  assert.match(noApp.said, /declares no application to start/u);

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
  assert.deepEqual(preview.requestedChange.requests, [TYPED]);
  assert.match(preview.confirmation, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(preview.command, `singularity-flow phase rollover implementation --confirm ${preview.confirmation}`);
  // The confirmation is the person's, as for any rollover: /sf-confirm runs it once on their word.
  assert.equal(preview.copilotCommand, `/sf-confirm phase rollover implementation --confirm ${preview.confirmation}`);

  // Without the person's confirmation nothing happens.
  assert.equal(git('rev-parse', 'HEAD'), publishedHead);
  assert.deepEqual(await workflowOf(item), before);
  const stale = run(process.execPath, [CLI, '--no-model', 'phase', 'rollover', 'implementation', '--confirm', `sha256:${'0'.repeat(64)}`, '--json'], { allowFailure: true });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stdout + stale.stderr, /GENERATION_ROLLOVER_STALE/u);
  assert.deepEqual(await workflowOf(item), before);

  const opened = json(cli('phase', 'rollover', 'implementation', '--confirm', preview.confirmation, '--json'));
  assert.equal(opened.mutates, true);
  assert.equal(opened.generationIntent.generation, 2);
  assert.equal(opened.generationIntent.status, 'open');

  // Generation 2 is authored as usual: the code is editable, its tests run again and it is published.
  cli('prepare', 'implementation');
  await story.write('src/value.mjs', story.code(2));
  cli('artifact', 'scan', '--phase', 'implementation');
  // The prepublish check copies what the person asked for into the Story, as "Asked for" of generation 2.
  run(process.execPath, [CLI, '--no-model', 'phase', 'prepublish', 'implementation', '--json'], { allowFailure: true });
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  const after = await workflowOf(item);
  assert.equal(after.phases.implementation.generation, 2);
  assert.ok((after.askedFor ?? []).some((entry) => entry.phase === 'implementation' && entry.generation === 2 && entry.text === TYPED),
    JSON.stringify(after.askedFor));
  // Generation 1's publication and its bytes are intact, under generation 2.
  assert.equal(run('git', ['merge-base', '--is-ancestor', publishedHead, 'HEAD'], { allowFailure: true }).status, 0);
  assert.equal(git('show', `${publishedHead}:src/value.mjs`), story.code(1).trimEnd());
  assert.equal(JSON.parse(git('show', `${publishedHead}:singularity/work-items/${WORK}/workflow.json`)).phases.implementation.generationIntent.status, 'consumed');
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
  assert.match(Buffer.from(view).subarray(0, 400).toString('utf8'), /"ask":\{"kind":"choice","question":"[^"]*Start the application to try it now\?/u);
  assert.match(view.trimEnd().split('\n').at(-1), /^"next":"ask-person: ask the person: .*\(Start the application \/ Not now\)"\}$/u);
  // Asked once: a later read goes on with the step and does not ask again.
  const later = JSON.parse(cli('nextsteps', '--for-agent', '--json').stdout);
  assert.equal(later.act.ask, undefined);
  assert.equal(later.act.state, 'next');
  // Nothing started the application: that is the person's choice.
  const status = JSON.parse(cli('app', 'status', '--json').stdout);
  assert.equal(JSON.stringify(status).includes('"started":true'), false, JSON.stringify(status).slice(0, 400));
});
