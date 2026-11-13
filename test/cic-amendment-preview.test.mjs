/**
 * The exact effect of an intent amendment, before it is decided [SPEC-CIC v1.1, stage 2; CIC:REQ-012, CON-006,
 * CON-007, AC-012]. `story intent-amendment preview` shows a drafted amendment's effect and a pending one's, by the
 * computation approval itself applies (state.mjs intentAmendmentEffect), and records nothing; approving it then
 * resets, keeps and asks exactly the steps the preview named.
 *
 * The fixture adds an approved fix-design step between quick-fix's intake (the scope) and implement. The design
 * cites AC-002 only, and AC-001's statement cites AC-002, so a change to AC-002 makes AC-001 stale too.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { loadActiveSpecRecords } from '../src/specifications.mjs';
import { staleClausesOf } from '../src/scope/revisions.mjs';
import { amendmentEffectWords, amendmentRepeatWords } from '../src/decision-list.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-preview-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Cone Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'w.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'a.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'l.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'c.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cone Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'cone@example.invalid' };
  const run = (command, args, cwd = root, extra = {}) => spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root, extra = {}) => {
    const result = run(command, args, cwd, extra);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src')); await mkdir(path.join(root, 'test'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  delete config.phases['fix-design'].clarification;
  config.workTypes['quick-design'] = { ...config.workTypes['quick-fix'], phases: ['intake', 'fix-design', 'implement', 'verify'] };
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Change impact fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const itemPath = (id, ...parts) => path.join(root, 'singularity/work-items', id, ...parts);
  const intake = (id) => [
    `# ${id} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${id}:AC-001] | The exported value equals 2, in the single export ${id}:AC-002 keeps. |`, `| [${id}:AC-002] | The value module stays a single export. |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${id}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`,
    `| \`${id}:AC-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` | existing | One export remains. |`, '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');
  const designed = async (id) => {
    sflow('start', id, '--from-branch', 'main', '--work-type', 'quick-design', '--title', 'Change the value', '--description', 'Return 2.');
    sflow('prepare', 'intake');
    await writeFile(itemPath(id, 'artifacts/intake/intake.md'), intake(id));
    sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'intake');
    sflow('approve', 'intake', '--yes');
    sflow('prepare', 'fix-design');
    await writeFile(itemPath(id, 'artifacts/fix-design/fix-design.md'), [`# ${id} — Fix Design`, '', '## Root cause', '',
      'The exported constant holds the old value; nothing computes it.', '', '## Minimal safe change', '',
      `Change the literal in src/value.mjs only. ${id}:AC-002 keeps the module to a single export, so no import changes.`, '',
      '## Alternatives and regression risk', '', 'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n'));
    sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    sflow('submit', 'fix-design');
    sflow('approve', 'fix-design', '--yes');
  };
  const workflow = async (id) => JSON.parse(await readFile(itemPath(id, 'workflow.json'), 'utf8'));
  // Every file under the Story with its bytes' digest, and the checkout's commit and status: what a read must leave as it was.
  const untouched = async (id) => {
    const files = [];
    const visit = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else files.push(`${path.relative(itemPath(id), file)} ${createHash('sha256').update(await readFile(file)).digest('hex')}`);
      }
    };
    await visit(itemPath(id));
    return { files: files.sort(), head: must('git', ['rev-parse', 'HEAD']).trim(), status: must('git', ['status', '--porcelain']) };
  };
  return { base, root, sflow, run, workflow, designed, itemPath, untouched };
}

test('every surface says the effect in one set of words: why a step is reopened or runs again, why one is kept, and who is asked', () => {
  const workflow = { workItem: { id: 'W-1' }, phaseOrder: ['scope', 'design', 'plan', 'code', 'check'],
    phases: Object.fromEntries(['Scope', 'Design', 'Plan', 'Code', 'Check'].map((label) => [label.toLowerCase(), { id: label.toLowerCase(), label }])) };
  assert.deepEqual(amendmentEffectWords(workflow, { steps: [
    { phase: 'design', outcome: 'kept', generation: 1, reasons: [], inPrompt: ['W-1:AC-001', 'W-1:AC-002'] },
    { phase: 'plan', outcome: 'reopened', generation: 1, reasons: [{ kind: 'unreadable', path: 'items/W-1/plan.md' }] },
    { phase: 'code', outcome: 'reset', generation: 2, reasons: [{ kind: 'code-step', claims: 2 }, { kind: 'radius', path: 'src/a.js' }] },
    // A step that never ran reads the amended scope when it starts: nothing of it runs again.
    { phase: 'check', outcome: 'reset', generation: 0, reasons: [{ kind: 'after-reset', phase: 'plan' }] }] }), [
    'Design keeps its approval (rule E8): it cites none of the changed clauses, though AC-001 and AC-002 were in its prompt.',
    'Plan is reopened: items/W-1/plan.md is missing or cannot be read.',
    'Code runs again: it writes code, and the change affects 2 claims; src/a.js is in the change\'s reach.']);
  assert.deepEqual(amendmentEffectWords(workflow, { steps: [{ phase: 'plan', outcome: 'reopened', generation: 1, reasons: [{ kind: 'not-kept', why: 'decision' }] },
    { phase: 'code', outcome: 'reset', generation: 1, reasons: [{ kind: 'after-reset', phase: 'plan' }] }] }),
  ['Plan is reopened: it feeds or follows a decision.', 'Code runs again: it comes after Plan.']);
  // An amendment that updates the scope to what the code does asks instead of resetting [SCS:REQ-022].
  assert.deepEqual(amendmentEffectWords(workflow, { steps: [{ phase: 'design', outcome: 'still-holds', generation: 1, groups: ['product'], reasons: [] },
    { phase: 'code', outcome: 'unchanged', generation: 0, reasons: [] }] }), ['Design\'s approvers say whether it still holds, or return the Story to it.']);
  assert.deepEqual(amendmentRepeatWords(workflow, { repeated: [{ clause: 'W-1:AC-001', times: 2 }], reversed: ['W-1:AC-001'] }),
    ['AC-001 has now been changed 2 times on this Story.', 'AC-001 goes back to a statement an earlier scope revision held.']);
});

/** What approving did to each step after the scope, as the Story records it, in the preview's own terms. */
function applied(story, scope = 'intake') {
  const order = story.phaseOrder.slice(story.phaseOrder.indexOf(scope) + 1);
  return order.map((phase) => [phase, story.phases[phase].retention?.rule === 'E8' ? 'kept'
    : phase === story.currentPhase ? 'reopened' : story.phases[phase].status === 'not_started' ? 'reset' : story.phases[phase].status]);
}

test('a previewed amendment records nothing, and approving it resets, keeps and asks exactly what the preview named [CIC:AC-012]', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await fixture(t);
  const preview = (...args) => JSON.parse(f.sflow('story', 'intent-amendment', 'preview', ...args, '--json'));

  // CIC-1: AC-001 is revised. fix-design cites only AC-002, so rule E8 keeps it; implement is reopened.
  await f.designed('CIC-1');
  const draft = path.join(f.base, 'CIC-1-amended.md');
  await writeFile(draft, (await readFile(f.itemPath('CIC-1', 'artifacts/intake/intake.md'), 'utf8'))
    .replace('The exported value equals 2, in', 'The exported value equals 2 and is a number, in'));
  const before = await f.untouched('CIC-1');
  const drafted = preview('--file', draft);
  assert.deepEqual(await f.untouched('CIC-1'), before, 'the preview wrote nothing under the Story, committed nothing and left the checkout as it was');
  assert.equal((await f.workflow('CIC-1')).intentAmendments, undefined, 'no amendment was proposed');
  assert.equal(drafted.recorded, false);
  assert.equal(drafted.source, 'draft');
  assert.deepEqual(drafted.effect.staleClauses, ['CIC-1:AC-001']);
  assert.deepEqual(drafted.effect.dependents, []);
  assert.deepEqual(drafted.effect.steps.map((step) => [step.phase, step.outcome]), [['fix-design', 'kept'], ['implement', 'reopened'], ['verify', 'reset']]);
  assert.deepEqual(drafted.effect.steps[0].inPrompt, ['CIC-1:AC-001'], 'kept, though its prompt held the changed clause (owner decision D1, shown only)');
  assert.deepEqual(drafted.summary.slice(-2), [
    'Fix design keeps its approval (rule E8): it cites none of the changed clauses, though AC-001 was in its prompt.',
    'Implement is reopened: it writes code, and the change affects 1 claim.']);
  const words = f.sflow('story', 'intent-amendment', 'preview', '--file', draft);
  assert.match(words, /^If .*CIC-1-amended\.md is proposed \(as AMD-001\) and approved as the Story is now\. This preview records nothing\.\nIt revises AC-001\.\n/u);
  assert.match(words, /Fix design keeps its approval \(rule E8\)/u);
  const agent = f.run(process.execPath, [cli, '--no-model', 'story', 'intent-amendment', 'preview', '--file', draft, '--for-agent', '--json'], f.root,
    { SINGULARITY_FLOW_AGENT_OUTPUT: '' });
  assert.equal(agent.status, 0, agent.stderr);
  assert.ok(Buffer.byteLength(agent.stdout) <= 4_000 + 200, `the agent view stays within its 4,000 bytes (${Buffer.byteLength(agent.stdout)})`);
  assert.deepEqual(await f.untouched('CIC-1'), before, 'neither form of the preview recorded anything');

  // Proposed, the pending amendment previews the same effect; approving it applies exactly that.
  const proposed = JSON.parse(f.sflow('story', 'intent-amendment', 'propose', '--file', draft, '--reason', 'Say the value is numeric.', '--json'));
  const pending = preview(proposed.proposal.id);
  assert.equal(pending.source, 'proposal');
  assert.deepEqual(pending.effect, drafted.effect, 'the draft and the pending proposal have one effect');
  const history = (await f.workflow('CIC-1')).history.length;
  preview(proposed.proposal.id);
  assert.equal((await f.workflow('CIC-1')).history.length, history, 'a pending proposal\'s preview records no history either');
  f.sflow('story', 'intent-amendment', 'decide', proposed.proposal.id, '--decision', 'approve', '--confirm', proposed.proposal.id);
  const story = await f.workflow('CIC-1');
  assert.deepEqual(applied(story), pending.effect.steps.map((step) => [step.phase, step.outcome]));
  const application = story.intentAmendments.at(-1);
  assert.deepEqual(application.staleClauses, pending.effect.staleClauses);
  assert.deepEqual(application.standingClauses, pending.effect.standingClauses);
  assert.deepEqual(application.retainedPhases, ['fix-design']);
  // The stale set the preview computed before approval is the one the recorded scope revision makes.
  const records = await loadActiveSpecRecords(f.itemPath('CIC-1'), story);
  assert.deepEqual([...staleClausesOf(story.scopeRevisions.at(-1), records.indexes.flatMap((index) => index.clauses ?? []))].sort(), pending.effect.staleClauses);

  // CIC-2: AC-002 is revised. AC-001 depends on it; fix-design cites it, so it is reopened and every later step runs again.
  await f.designed('CIC-2');
  const second = path.join(f.base, 'CIC-2-amended.md');
  await writeFile(second, (await readFile(f.itemPath('CIC-2', 'artifacts/intake/intake.md'), 'utf8'))
    .replace('The value module stays a single export.', 'The value module keeps exactly one named export.'));
  const before2 = await f.untouched('CIC-2');
  const cited = preview('--file', second);
  assert.deepEqual(await f.untouched('CIC-2'), before2);
  assert.deepEqual(cited.effect.staleClauses, ['CIC-2:AC-001', 'CIC-2:AC-002']);
  assert.deepEqual(cited.effect.dependents, ['CIC-2:AC-001']);
  assert.deepEqual(cited.effect.steps.map((step) => [step.phase, step.outcome]), [['fix-design', 'reopened'], ['implement', 'reset'], ['verify', 'reset']]);
  assert.deepEqual(cited.effect.steps[0].reasons, [{ kind: 'cites', path: 'singularity/work-items/CIC-2/artifacts/fix-design/fix-design.md', clauses: ['CIC-2:AC-002'] }]);
  assert.equal(cited.summary[1], 'It revises AC-002. AC-001 depends on a changed clause, so its evidence is stale too.');
  assert.ok(cited.summary.includes('Fix design is reopened: it cites AC-002.'), cited.summary.join('\n'));
  const proposed2 = JSON.parse(f.sflow('story', 'intent-amendment', 'propose', '--file', second, '--reason', 'Tighten the export clause.', '--json'));
  const pending2 = preview(proposed2.proposal.id);
  assert.deepEqual(pending2.effect, cited.effect);
  // The decisions card shows the same effect, in the same words, on every host.
  const list = JSON.parse(f.sflow('decisions', 'CIC-2', '--json'));
  const item = (list.data ?? list).items.find((entry) => entry.kind === 'intent-amendment');
  assert.match(item.details.reach, /If it is approved: AC-001 depends on a changed clause\. Fix design is reopened: it cites AC-002\./u);
  assert.doesNotMatch(item.details.reach, /may reopen/u);
  f.sflow('story', 'intent-amendment', 'decide', proposed2.proposal.id, '--decision', 'approve', '--confirm', proposed2.proposal.id);
  const story2 = await f.workflow('CIC-2');
  assert.deepEqual(applied(story2), pending2.effect.steps.map((step) => [step.phase, step.outcome]));
  assert.deepEqual(story2.intentAmendments.at(-1).staleClauses, pending2.effect.staleClauses);
  assert.deepEqual(story2.intentAmendments.at(-1).affectedPhases, pending2.effect.steps.filter((step) => step.affected).map((step) => step.phase));
  assert.deepEqual(amendmentEffectWords(story2, pending2.effect).slice(0, 1), ['Fix design is reopened: it cites AC-002.']);
});
