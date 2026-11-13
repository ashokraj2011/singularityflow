/**
 * A code step's summary written before a decision changed the step is the draft's own correction [owner, 2026-11-13].
 *
 * On a real Story the agent wrote its implementation summary ("No .nvmrc was added"), a person then chose Pin Node 22,
 * which created `.nvmrc` and amended the plan, and the next prepublish published the summary as it was. Prepublish now
 * refuses that summary with a finding its author fixes in the same draft, naming the file and the plan row; once the
 * summary is written after the change and names it, the step publishes.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { stepChangesDuringGeneration, summaryStepChangeFindings, summaryUpdateAfterDecision } from '../src/summary-step-changes.mjs';
import { approvedSpecificationStory, CLI, implementationPlan } from './helpers/submitted-planning-story.mjs';

const SUMMARY = 'singularity/work-items/W-1/artifacts/implementation/implementation-summary.md';
const started = '2026-11-13T10:00:00.000Z';
const at = (minutes) => new Date(Date.parse(started) + minutes * 60_000);
const pin = (minutes) => ({ id: 'PAM-001', at: at(minutes).toISOString(), reason: 'The tests need Node 22 on this machine.',
  changes: [{ kind: 'add-supporting', path: '.nvmrc', class: 'build-configuration', reason: 'The tests need Node 22 on this machine.' }] });
const story = (amendments) => ({ workItem: { id: 'W-1' }, currentPhase: 'implementation', planAmendments: amendments,
  phases: { implementation: { id: 'implementation', status: 'in_progress', generation: 0, generationPolicy: { task: 'code' }, requiredArtifact: { path: 'artifacts/implementation/implementation-summary.md' },
    generationIntent: { status: 'open', generation: 1, startedAt: started } } } });

async function checkout(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-summary-changes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.dirname(path.join(root, SUMMARY)), { recursive: true });
  const write = async (relative, text, minutes) => {
    await writeFile(path.join(root, relative), text);
    await utimes(path.join(root, relative), at(minutes), at(minutes));
  };
  return { root, write };
}

test('a summary written before a decision wrote a file and amended the plan is refused, naming both', async (t) => {
  const { root, write } = await checkout(t);
  const workflow = story([pin(10)]);
  const phase = workflow.phases.implementation;
  assert.deepEqual(stepChangesDuringGeneration(workflow, phase).map((change) => [change.id, change.paths]), [['PAM-001', ['.nvmrc']]]);
  // The summary at minute 5 says no .nvmrc was added; the person's pin at minute 10 creates it.
  await write(SUMMARY, '# Implementation summary\n\nNo `.nvmrc` was added.\n', 5);
  await write('.nvmrc', '22\n', 10);
  const [stale, ...rest] = await summaryStepChangeFindings(root, workflow, phase, SUMMARY);
  assert.equal(rest.length, 0);
  assert.equal(stale.code, 'artifact.summary.before-change', 'naming .nvmrc in a sentence written before the change is not enough');
  assert.equal(stale.category, 'artifact');
  assert.equal(stale.path, SUMMARY);
  assert.match(stale.message, /^The summary was written before PAM-001 changed this step: it wrote \.nvmrc and changed the plan: \.nvmrc as a supporting change, build-configuration\. Say so in the summary: name \.nvmrc and why it changed, then prepublish again\.$/u);
  assert.doesNotMatch(stale.message, /sha256|[a-f0-9]{40}/u, 'a person never reads a hash');
  // The author's turn hears it from the decision too.
  const words = await summaryUpdateAfterDecision(root, {}, workflow);
  assert.deepEqual([words.phase, words.path, words.changes, words.paths], ['implementation', SUMMARY, ['PAM-001'], ['.nvmrc']]);
  assert.match(words.words, /^This changed implementation after its summary was written \(PAM-001: \.nvmrc\)\. The step's author updates the summary at .* to say so, in the same turn when it is the authoring turn, before prepublishing/u);

  // Rewritten after the change without naming the file: still the author's correction.
  await write(SUMMARY, '# Implementation summary\n\nThe tests run on a pinned Node.\n', 12);
  const [unnamed] = await summaryStepChangeFindings(root, workflow, phase, SUMMARY);
  assert.equal(unnamed.code, 'artifact.summary.change-unnamed');
  assert.match(unnamed.message, /does not name what PAM-001 changed in this step: \.nvmrc; it changed the plan: \.nvmrc as a supporting change, build-configuration\. Name it/u);
  assert.equal(await summaryUpdateAfterDecision(root, {}, workflow), null, 'nothing to tell a turn once the summary is newer');

  // Rewritten after the change and naming it: nothing to correct.
  await write(SUMMARY, '# Implementation summary\n\n`.nvmrc` pins Node 22, added by the approved pin and listed in the plan.\n', 12);
  assert.deepEqual(await summaryStepChangeFindings(root, workflow, phase, SUMMARY), []);
});

test('only changes made while the generation was open count, and a plan-only change asks for the path it named', async (t) => {
  const { root, write } = await checkout(t);
  // Before the generation opened: not this draft's to explain.
  assert.deepEqual(stepChangesDuringGeneration(story([pin(-5)]), story([]).phases.implementation), []);
  assert.deepEqual(stepChangesDuringGeneration(story([pin(10)]), { ...story([]).phases.implementation, generationIntent: { status: 'consumed', startedAt: started } }), []);
  // A plan row added for a file the author wrote before the summary: the summary is older than the plan change.
  const location = { id: 'PAM-001', at: at(10).toISOString(), changes: [{ kind: 'add-location', clauseId: 'W-1:AC-001', path: 'src/helper.mjs' }] };
  const workflow = story([location]);
  await mkdir(path.join(root, 'src'), { recursive: true });
  await write('src/helper.mjs', 'export const approved = 2;\n', 2);
  await write(SUMMARY, '# Implementation summary\n\nThe value comes from a helper.\n', 5);
  const [finding] = await summaryStepChangeFindings(root, workflow, workflow.phases.implementation, SUMMARY);
  assert.equal(finding.code, 'artifact.summary.before-change');
  assert.match(finding.message, /before PAM-001 changed this step: it changed the plan: src\/helper\.mjs added to W-1:AC-001's row\. Say so in the summary: name src\/helper\.mjs/u);
  // Named in a summary written after: done.
  await write(SUMMARY, '# Implementation summary\n\nThe value comes from `src/helper.mjs`, now planned for AC-001.\n', 12);
  assert.deepEqual(await summaryStepChangeFindings(root, workflow, workflow.phases.implementation, SUMMARY), []);
});

const changedSummary = (lines) => ['# Implementation summary', '', '## Agent brief', '',
  'Added the value module; both clauses have one focused test that reads the approved value.', '', '## Changed components and decisions', '',
  '- `src/value.mjs` exports the approved value.', ...lines, '', '## Tests and operational notes', '', '`test/value.test.mjs` verifies the value.', ''].join('\n');

test('through the CLI: a pin recorded after the summary refuses prepublish with the author\'s fix; naming it publishes', async (t) => {
  const WORK = 'PIN-1';
  const story = await approvedSpecificationStory(t, WORK);
  const { root, cli, item } = story;
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks'); cli('approve', 'planning', '--yes');
  cli('prepare', 'implementation');
  const clauses = [`${WORK}:AC-001`, `${WORK}:REQ-002`];
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'src/value.mjs'), `${clauses.map((clause) => `// @clause:${clause} returns the approved value to its callers\n`).join('')}export const value = 1;\n`);
  await writeFile(path.join(root, 'test/value.test.mjs'), `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n${clauses.map((clause) => `// @ac:${clause}\n`).join('')}test('value', () => assert.ok(value >= 1));\n`);
  const summary = path.join(item, 'artifacts/implementation/implementation-summary.md');
  await writeFile(summary, changedSummary(['- No `.nvmrc` was added.']));
  await writeFile(path.join(item, 'artifacts/implementation/operator-notes.md'), ['# Operator notes', '', 'Nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  const check = () => {
    const result = spawnSync(process.execPath, [CLI, '--no-model', 'phase', 'prepublish', 'implementation', '--for-agent', '--json'], { cwd: root, encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester', SINGULARITY_FLOW_AGENT_OUTPUT: 'full' } });
    return JSON.parse(result.stdout);
  };
  const own = (result) => (result.findings ?? []).filter((finding) => /^artifact\.summary\./u.test(finding.code));
  assert.deepEqual(own(check()), [], 'nothing changed the step yet');

  // The summary was written a minute ago; then a person pins Node 22: the file, then the plan amendment.
  const earlier = new Date(Date.now() - 60_000);
  await utimes(summary, earlier, earlier);
  await writeFile(path.join(root, '.nvmrc'), '22\n');
  cli('decision', 'plan', '--add-supporting', '.nvmrc=build-configuration', '--supporting-reason', 'The tests need Node 22 on this machine.',
    '--reason', 'Pin Node 22 so the tests run on the Node they need here.');
  const refused = check();
  assert.equal(refused.status, 'correction-required');
  const [finding] = own(refused);
  assert.equal(finding?.code, 'artifact.summary.before-change', JSON.stringify(refused.findings));
  assert.match(finding.message, /written before PAM-001 changed this step: it wrote \.nvmrc and changed the plan: \.nvmrc as a supporting change, build-configuration/u);
  assert.equal(refused.commands.publish, null, 'nothing to publish while the summary is older than the change');
  assert.equal(refused.correction.class, 'agent-authoring', 'the draft\'s own correction, not a person\'s');
  const act = agentAct(refused);
  assert.equal(act.state, 'correct');
  assert.ok(act.fix.some((line) => /^artifact\.summary\.before-change at .*implementation-summary\.md: .*\.nvmrc/u.test(line)), JSON.stringify(act));

  // The author names it in the same draft: the step publishes.
  await writeFile(summary, changedSummary(['- `.nvmrc` pins Node 22: the person chose Pin Node 22, and the plan lists it as a supporting change.']));
  const ready = check();
  assert.deepEqual(own(ready), []);
  assert.equal(ready.status, 'ready', JSON.stringify(ready.findings));
  assert.match(ready.commands.publish, /^singularity-flow phase publish implementation /u);
  assert.match(await readFile(summary, 'utf8'), /\.nvmrc/u);
});
