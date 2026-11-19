import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { resolveOperation } from '../src/command-registry.mjs';
import { personAuthoredPublication, publicationArguments } from '../src/commands/phase-publish-if-ready.mjs';
import { notSubmitted, submitArguments, submitReport } from '../src/commands/submit-if-ready.mjs';
import { agentAct, completeAgentResult, withAgentRoutes } from '../src/agent-output.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

// Review findings 2026-11-17 (kernel #8, #9): /sf-submit with a typed change waiting is the person's choice to submit this
// version as it is. When its submission records decision values, or still waits for its review or its author's account, it
// named the version question they had said no to, and the agent asked it again, round and round.
test('/sf-submit after a No to the version question runs this version\'s own way on, never the question again', () => {
  const question = 'singularity-flow phase rollover code --json';
  const asked = { resultType: 'sflow-submission-readiness', classification: 'change-requested', lifecycleReady: true, confirmationRequired: false,
    phaseId: 'code', workId: 'A-1', nextSkill: '/sf-code', nextCommand: question };
  // A step that records decision values: its submission, with the values the person gives; never the question.
  const values = { ...asked, submission: 'singularity-flow submit code --work-id A-1 --decision-input risk=<risk>', decisionInputs: [{ name: 'risk' }] };
  assert.equal(submitArguments(values), null, 'a value only the person gives is never filled');
  assert.deepEqual(notSubmitted(values), { submitted: false, reason: 'decision-inputs-required', command: values.submission, skill: '/sf-submit' });
  // Its review, or its author's account, still owed: that, never the question.
  for (const otherwise of [{ classification: 'source-review-required', command: 'singularity-flow review-source context code --json', skill: '/sf-review-source' },
    { classification: 'instructions-unaccounted', command: 'singularity-flow departure account --work-id A-1 --instruction 1 --clauses <CLAUSES>', skill: '/sf-code' }]) {
    const waiting = { ...asked, lifecycleReady: false, otherwise };
    assert.equal(submitArguments(waiting), null);
    assert.deepEqual(notSubmitted(waiting), { submitted: false, reason: otherwise.classification, command: otherwise.command, skill: otherwise.skill });
    // The agent's act at /sf-submit names it, not the question.
    const act = agentAct({ ...waiting, submitIfReady: notSubmitted(waiting) });
    assert.equal(act.do?.shell, otherwise.command, JSON.stringify(act));
    assert.notEqual(act.state, 'confirm');
  }
  const act = agentAct({ ...values, submitIfReady: notSubmitted(values) });
  assert.match(act.do?.shell ?? '', /^singularity-flow submit code --work-id A-1 /u, JSON.stringify(act));
  assert.match(act.said, /decisionInputs/u);
  // Any other readiness is unchanged: its own route.
  const review = { ...asked, classification: 'source-review-required', lifecycleReady: false, nextCommand: 'singularity-flow review-source context code --json' };
  assert.deepEqual(notSubmitted(review), { submitted: false, reason: 'source-review-required', command: review.nextCommand });
});

test('only the exact publication command prepublish returns for the same phase is run as-is', () => {
  assert.deepEqual(publicationArguments('singularity-flow phase publish intake --authored governed-agent --channel copilot-host', 'intake'),
    ['phase', 'publish', 'intake', '--authored', 'governed-agent', '--channel', 'copilot-host']);
  assert.deepEqual(publicationArguments('singularity-flow phase publish code --authored human --channel manual-in-place --no-model', 'code'),
    ['phase', 'publish', 'code', '--authored', 'human', '--channel', 'manual-in-place', '--no-model']);
  for (const command of [
    'singularity-flow phase publish other --authored human --channel manual-in-place',
    'singularity-flow phase publish intake --authored human --channel manual-import --from draft.md',
    'singularity-flow phase publish intake --authored someone --channel manual-in-place',
    'singularity-flow approve intake --yes',
    'sflow phase publish intake --authored human --channel manual-in-place',
    null
  ]) assert.equal(publicationArguments(command, 'intake'), null, String(command));
  // It runs only the agent's own authorship or the kernel's: a person's writing, an external tool's
  // output or no author is the person's claim (as external-tool an agent's draft skipped its checks).
  for (const [command, person] of [['intake --authored governed-agent --channel copilot-host --no-model', false],
    ['convergence --authored deterministic --channel kernel-generator', false], ['intake --authored human --channel manual-in-place', true],
    ['intake --authored external-tool --channel external-tool', true], ['intake', true]]) {
    const phase = command.split(' ')[0];
    assert.equal(personAuthoredPublication(publicationArguments(`singularity-flow phase publish ${command}`, phase)), person, command);
  }
  assert.equal(personAuthoredPublication(null), false, 'nothing to run is not a person\'s claim');
  // Only the exact readiness route submits: no confirmation, no other classification or command.
  const ready = { classification: 'ready-to-attempt', lifecycleReady: true, confirmationRequired: false, nextSkill: '/sf-submit',
    phaseId: 'code', workId: 'A-1', nextCommand: 'singularity-flow submit code --work-id A-1' };
  assert.deepEqual(submitArguments(ready), ['submit', 'code', '--work-id', 'A-1']);
  for (const change of [{ confirmationRequired: true }, { classification: 'source-review-required' }, { lifecycleReady: false },
    { nextSkill: '/sf-recover' }, { nextCommand: 'singularity-flow submit code --work-id A-1 --skip-checks' }, { nextCommand: 'singularity-flow submit other --work-id A-1' }]) {
    assert.equal(submitArguments({ ...ready, ...change }), null, JSON.stringify(change));
  }
  // A change the person typed leads readiness with its version question; /sf-submit run anyway submits this version as it is
  // through `submission`, never the question's own route (daily run 2026-11-17).
  const asked = { ...ready, classification: 'change-requested', nextSkill: '/sf-code', nextCommand: 'singularity-flow phase rollover code --json',
    submission: 'singularity-flow submit code --work-id A-1' };
  assert.deepEqual(submitArguments(asked), ['submit', 'code', '--work-id', 'A-1']);
  for (const change of [{ submission: undefined }, { lifecycleReady: false }, { submission: 'singularity-flow phase rollover code --json' }]) {
    assert.equal(submitArguments({ ...asked, ...change }), null, JSON.stringify(change));
  }
  // What submit did, not the end of what it printed: the commit comes first there, and its last lines give
  // next steps from before the holds were read, so a model said nothing was committed.
  const printed = ['', 'Submitted code phase for approval.', 'Committed: request approval (A-1)', 'Push: origin/a-1', 'Review packet: kept with code generation 1',
    ...Array.from({ length: 60 }, (_, index) => `[${index}] a document`), 'Submitted code for approval with 60 generated document(s).', '  NOW   Approve code', '        Shell: singularity-flow approve code'].join('\n');
  assert.equal(submitReport(printed), 'Submitted code phase for approval.\nCommitted: request approval (A-1)\nPush: origin/a-1\nReview packet: kept with code generation 1\nSubmitted code for approval with 60 generated document(s).');
  assert.equal(submitReport('something else\nentirely\n'), 'something else\nentirely');
  const status = (options) => resolveOperation({ requestedCommand: 'status', positionals: ['status', 'A-1'], options });
  assert.equal(status({ 'submission-readiness': true, json: true }).classification, 'read');
  assert.equal(status({ 'submission-readiness': true, json: true, 'submit-if-ready': true }).classification, 'mutation');
  // It publishes, so every guard sees a mutation, unlike a plain prepublish.
  const operation = (options) => resolveOperation({ requestedCommand: 'phase', positionals: ['phase', 'prepublish', 'intake'], options });
  assert.equal(operation({ 'for-agent': true, json: true }).classification, 'read');
  assert.equal(operation({ 'for-agent': true, json: true, 'publish-if-ready': true }).classification, 'mutation');
});

test('prepublish --publish-if-ready returns the unchanged check, and publishes with its review only when ready', slowLane({ timeout: 300_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-publish-if-ready-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Publish Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Publish Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'publish.tester@example.invalid' };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  must('git', ['init', '-q', '-b', 'main', root], base);
  await writeFile(path.join(root, 'README.md'), '# Publish if ready\n');
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
  // review-every-step-cli.test.mjs.
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']);
  must('git', ['commit', '-q', '-m', 'Publish if ready fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  sflow('start', 'READY-1', '--from-branch', 'main', '--work-type', 'classic-delivery',
    '--title', 'Publish when ready', '--description', 'Prepublish publishes in the same command.');
  sflow('prepare', 'intake');

  const combined = ['phase', 'prepublish', 'intake', '--for-agent', '--json', '--publish-if-ready'];
  // The prepared template still has its TODOs: the check is returned as-is and nothing is published.
  const draft = completeAgentResult(sflow(...combined));
  const plain = completeAgentResult(sflow('phase', 'prepublish', 'intake', '--for-agent', '--json'));
  // A composed read must not inherit an approved-config overlay or cached policy from its caller.
  const { step } = await import('../src/cli-steps.mjs');
  const { withConfigurationReadRoot } = await import('../src/configuration-read-scope.mjs');
  const { withReadScope, scopedRead } = await import('../src/read-scope.mjs');
  const isolated = await withConfigurationReadRoot(root, path.join(base, 'invalid-caller-overlay'), {},
    () => withReadScope(async () => {
      await scopedRead(`config.definition:${root}:${root}:current`, () => ({ version: -1 }));
      return step(['--no-model', 'phase', 'prepublish', 'intake', '--for-agent', '--json'], root);
    }));
  assert.equal(isolated.ok, true, isolated.stderr);
  assert.equal(isolated.value.status, plain.status);
  assert.notEqual(draft.status, 'ready');
  assert.deepEqual({ ...draft, publishIfReady: undefined }, { ...plain, publishIfReady: undefined }, 'the same check, field for field');
  assert.deepEqual(draft.publishIfReady, { published: false, reason: 'not-ready', command: null });

  const item = path.join(root, 'singularity/work-items/READY-1');
  await writeFile(path.join(item, 'artifacts/intake/intake.md'), [
    '# READY-1 — Classic delivery intake', '', '## Request and outcome', '', 'Publish the intake in one command.', '',
    '## Scope and constraints', '', 'Only the intake document changes.', '', '## Acceptance criteria', '',
    '| Clause | Observable outcome |', '|---|---|', '| [READY-1:AC-001] | The intake is published once. |', '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    '| `READY-1:AC-001` | `README.md` | `none` |', '', '## Initial evidence', '', 'The fixture README.', ''].join('\n'));
  sflow('wm', 'compose', '--phase', 'intake');
  sflow('clarification', 'record', 'intake', '--question', 'Is one publication enough?', '--answer', 'Yes.');
  // With the kernel's model off, a person's own check still names their manual route; an agent's
  // names its own authorship. As `--authored human` an agent's draft skipped the clarification
  // record and session proof an agent's draft gets (live reruns, 2026-11-01).
  assert.equal(JSON.parse(sflow('phase', 'prepublish', 'intake', '--json')).commands.publish,
    'singularity-flow phase publish intake --authored human --channel manual-in-place --no-model');
  const published = completeAgentResult(sflow(...combined));
  assert.equal(published.status, 'ready');
  assert.equal(published.publishIfReady.published, true);
  // Done: nothing in the result offers it again, or a model runs it and makes a pointless generation (bin-opr2).
  assert.equal(published.commands.publish, null);
  assert.equal(published.publishIfReady.command, undefined);
  assert.equal(published.publishIfReady.review.phase, 'intake');
  // What follows comes first, with its routes: an agent reading from the top ended at "published"
  // without offering the next step. The prepublish fields after it describe the draft before publication.
  assert.deepEqual(Object.keys(published).slice(0, 2), ['act', 'publishIfReady']);
  assert.match(published.publishIfReady.next.instruction, /Say to run it in a new chat: it needs nothing from this one\./u, 'a /sf-submit route starts fresh');
  // It owes no review, so the turn that wrote it submits it now, by /sf-submit's own entry: no separate /sf-submit turn
  // (owner, 2026-11-19, ceremony cut 2). The step's next action stays its submission, for a person or another chat.
  const inTurn = 'singularity-flow status READY-1 --submission-readiness --for-agent --json --submit-if-ready';
  assert.deepEqual(published.publishIfReady.next.inTurn, { command: inTurn, skill: '/sf-submit', reason: 'Submit the published version now, in the turn that wrote it.' });
  assert.equal(published.act.state, 'submit');
  assert.deepEqual(published.act.do, { reason: 'Submit the published version now, in the turn that wrote it.', copilot: '/sf-submit', shell: inTurn, vscode: null });
  assert.match(published.publishIfReady.next.instruction, /^Published\. End the reply with this next action/u);
  assert.deepEqual(published.publishIfReady.next.commandGuidance, { copilotCommand: '/sf-submit',
    command: 'singularity-flow submit intake --work-id READY-1', modelFreeCommand: '@sflow /submit intake --work-id READY-1' });
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.equal(workflow.phases.intake.generation, 1);
  assert.deepEqual([workflow.phases.intake.authorship[0].producer, workflow.phases.intake.authorship[0].channel,
    workflow.phases.intake.authorship[0].changeOrigins], ['governed-agent', 'copilot-host', ['copilot']]);
  assert.ok(workflow.phases.intake.generatedAgent, 'the agent that wrote it is named');
  assert.equal(must('git', ['status', '--porcelain']), '', 'the publication was committed');

  // Submission: readiness says ready-to-attempt, so the same command submits and shows the review.
  const submitted = completeAgentResult(sflow('status', 'READY-1', '--submission-readiness', '--json', '--submit-if-ready'));
  assert.equal(submitted.classification, 'ready-to-attempt');
  assert.equal(submitted.submitIfReady.submitted, true);
  assert.equal(submitted.submitIfReady.command, 'singularity-flow submit intake --work-id READY-1');
  assert.equal(submitted.submitIfReady.review.phase, 'intake');
  assert.equal(Object.keys(submitted)[0], 'submitIfReady', 'submission readiness is not an agent result');
  assert.match(submitted.submitIfReady.next.instruction, /^Submitted\. End the reply with this next action/u);
  assert.deepEqual(submitted.submitIfReady.next.commandGuidance, { copilotCommand: '/sf-approve intake --work-id READY-1',
    command: 'singularity-flow approve intake --work-id READY-1 --fetch', modelFreeCommand: '@sflow /approve intake --work-id READY-1' });
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.intake.status, 'awaiting_approval');
  const again = completeAgentResult(sflow('status', 'READY-1', '--submission-readiness', '--json', '--submit-if-ready'));
  assert.deepEqual(again.submitIfReady, { submitted: false, reason: again.classification, command: again.nextCommand ?? null });
  assert.notEqual(again.classification, 'ready-to-attempt');

  // Approval: readiness, the receipt and the review arrive together; nothing is answered or approved.
  const packet = completeAgentResult(sflow('choices', 'begin', 'approve', 'READY-1', '--json', '--review-packet'));
  assert.equal(packet.approvalContext.phase, 'intake');
  assert.equal(packet.ready, false);
  assert.match(packet.token, /^[0-9a-f-]{36}$/u);
  assert.equal(packet.approvalPacket.readiness.classification, again.classification);
  assert.equal(packet.approvalPacket.review.phase, 'intake');
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).phases.intake.status, 'awaiting_approval');

  const unsupported = run(process.execPath, [cli, '--no-model', 'phase', 'prepublish', 'intake', '--publish-if-ready']);
  assert.notEqual(unsupported.status, 0);
  assert.match(unsupported.stdout + unsupported.stderr, /--publish-if-ready requires --for-agent --json/u);
});

test('a refused step is relayed with its own recovery plan, not one rebuilt from its code', async () => {
  const { stop } = await import('../src/cli-steps.mjs');
  const { reportCliFailure } = await import('../src/cli-failure.mjs');
  const refusal = { schemaVersion: 1, resultType: 'sflow-refusal-plan', status: 'failed',
    error: { code: 'CODE_DELIVERY_TEST_FAILED', message: 'Required tests failed.', details: { commandId: 'unit' },
      diagnosticAction: { command: 'singularity-flow recover A-1 --phase code --json' } },
    remediationPlan: { steps: [{ id: 'recover', command: 'singularity-flow recover A-1 --phase code --json' }] } };
  let error;
  try { stop({ ok: false, status: 3, value: refusal, stdout: JSON.stringify(refusal), stderr: '' }, 'phase publish'); }
  catch (caught) { error = caught; }
  assert.equal(error.code, 'CODE_DELIVERY_TEST_FAILED');
  assert.equal(error.exitCode, 3);
  const printed = [];
  const log = console.log;
  const previousExitCode = process.exitCode;
  console.log = (text) => printed.push(text);
  try { await reportCliFailure(error, ['phase', 'prepublish', 'code', '--for-agent', '--json', '--publish-if-ready']); }
  finally { console.log = log; }
  assert.equal(process.exitCode, 3);
  process.exitCode = previousExitCode;
  // The agent's copy leads with `act` from the step's own plan; the rest is the step's refusal unchanged.
  // Its last line repeats act's next action for a host that keeps only the tail (agent-output.mjs nextOf).
  const { act, next: last, ...relayed } = JSON.parse(printed.join('\n'));
  assert.match(last, /recover A-1 --phase code/u);
  assert.deepEqual(relayed, await withAgentRoutes(refusal), 'the step\'s refusal, field for field, with agent routes');
  assert.deepEqual([act.state, act.do.shell], ['refused', 'singularity-flow recover A-1 --phase code --for-agent --json']);
});
