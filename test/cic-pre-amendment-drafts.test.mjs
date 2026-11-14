/**
 * A draft written before an approved amendment is not published [SPEC-CIC v1.1 stage 5; CIC:REQ-008 to REQ-011,
 * switch 2, owner decisions 2026-11-14]. Approving an amendment reopens the first step it resets in place. With the
 * pinned spec policy's `preAmendmentDrafts: refuse` (new Stories pin it), that step is pinned to the amended scope:
 * its earlier prompt is set aside, its open code generation closed, and its draft kept read only. Its publication then
 * refuses, by records, a draft started under the earlier scope, with its way out in the same step; the recomposed
 * prompt names the old draft as a read-only reference. With `legacy` (and on every Story pinned before the field)
 * nothing changes: the same Story walked both ways is compared at each step in the middle, not only at its end.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { assertDraftPostdatesAmendment, preAmendmentDraftRefusal, preAmendmentDraftSection, refusesPreAmendmentDrafts } from '../src/amended-drafts.mjs';
import { normalizeSpecPolicy } from '../src/specifications.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('switch 2 is pinned `refuse` for new Stories; `legacy`, and a Story pinned before the field, keep the old behaviour [CIC:REQ-018]', () => {
  assert.equal(normalizeSpecPolicy({}).preAmendmentDrafts, 'refuse');
  assert.equal(normalizeSpecPolicy({ preAmendmentDrafts: 'legacy' }).preAmendmentDrafts, 'legacy');
  assert.throws(() => normalizeSpecPolicy({ preAmendmentDrafts: 'rebase' }), /spec\.preAmendmentDrafts must be legacy or refuse/u);
  assert.equal(refusesPreAmendmentDrafts({ resolution: { spec: { preAmendmentDrafts: 'refuse' } } }), true);
  assert.equal(refusesPreAmendmentDrafts({ resolution: { spec: { preAmendmentDrafts: 'legacy' } } }), false);
  assert.equal(refusesPreAmendmentDrafts({ resolution: { spec: { mode: 'record' } } }), false, 'pinned before the field');
});

test('the refusal names its way out in the same step, and the recomposed prompt names the old draft read only, within its budget', () => {
  const workflow = { workItem: { id: 'W-1' }, resolution: { spec: { preAmendmentDrafts: 'refuse' } }, phases: {} };
  const design = { id: 'design', generation: 1, requiredArtifact: { kind: 'design' },
    scopePin: { amendment: 'AMD-001', generation: 2, revision: 2, draft: { path: 'singularity/work-items/W-1/context/superseded/design-gen2-before-AMD-001/design.md' } } };
  const section = preAmendmentDraftSection(workflow, design);
  assert.equal(section, '## Draft written before AMD-001 (read only)\n\n`singularity/work-items/W-1/context/superseded/design-gen2-before-AMD-001/design.md` is this step\'s draft '
    + 'as it stood when AMD-001 amended the scope (scope revision 2). Read it only as a reference: write this step against the amended scope, and keep from it only what still holds under it.\n');
  assert.ok(Buffer.byteLength(section) < 512, `it adds ${Buffer.byteLength(section)} bytes to the prompt`);
  assert.equal(preAmendmentDraftSection({ ...workflow, resolution: { spec: {} } }, design), '', 'nothing on a Story without the switch');
  assert.equal(preAmendmentDraftSection(workflow, { ...design, generation: 2 }), '', 'nothing once the pinned generation is published');
  const refusal = preAmendmentDraftRefusal(workflow, design, design.scopePin, ['uncomposed']);
  assert.equal(refusal.code, 'PHASE_DRAFT_PREDATES_AMENDMENT');
  assert.match(refusal.message, /^design cannot publish this draft: it has not been composed again since AMD-001 amended the scope \(scope revision 2\)\. Write it again here, in design, under the amended scope: singularity-flow phase enter design --work-id W-1 --compose --for-agent --json\. The earlier draft is kept read only at \S+; keep from it only what still holds under the amended scope\.$/u);
  assert.deepEqual(refusal.details.actions.map((action) => action.command), ['singularity-flow phase enter design --work-id W-1 --compose --for-agent --json']);
});

test('a reopened document step may keep its old text: a person publishes it as is, an agent once it is composed again under the amended scope (owner, 2026-11-14) [CIC:REQ-009]', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-same-text-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = (letter) => `sha256:${letter.repeat(64)}`;
  const workflow = { workItem: { id: 'W-1' }, resolution: { spec: { preAmendmentDrafts: 'refuse' } }, phases: {},
    scopeRevisions: [{ revision: 1, revisionSha256: digest('a') }, { revision: 2, revisionSha256: digest('b') }],
    intentAmendments: [{ id: 'AMD-001', status: 'approved' }] };
  const design = { id: 'design', generation: 1, requiredArtifact: { kind: 'design' },
    scopePin: { amendment: 'AMD-001', generation: 2, revision: 2, revisionSha256: digest('b'), draft: { path: 'w/context/superseded/design-gen2-before-AMD-001/design.md' } } };
  const check = (producer) => assertDraftPostdatesAmendment(root, workflow, design, { itemRelative: 'w', producer });
  const reasons = async (producer) => { try { await check(producer); return []; } catch (error) { assert.equal(error.code, 'PHASE_DRAFT_PREDATES_AMENDMENT'); return error.details.reasons; } };
  assert.deepEqual(await reasons('human'), [], 'a person\'s own text, composed or not, unchanged or not');
  assert.deepEqual(await reasons('governed-agent'), ['uncomposed'], 'an agent reads the amended scope only through a prompt composed under it');
  assert.deepEqual(await reasons('legacy-unspecified'), ['uncomposed']);
  await mkdir(path.join(root, 'w/context'), { recursive: true });
  const receipt = (letter) => writeFile(path.join(root, 'w/context/design-gen2.json'), JSON.stringify({ scopeRevision: { revision: letter === 'b' ? 2 : 1, revisionSha256: digest(letter), amendment: letter === 'b' ? 'AMD-001' : null } }));
  await receipt('b');
  assert.deepEqual(await reasons('governed-agent'), [], 'composed again under the amended scope, its text may be the old draft\'s');
  await receipt('a');
  assert.deepEqual(await reasons('governed-agent'), ['prompt']);
  assert.deepEqual(await reasons('human'), ['prompt'], 'a prompt composed under the earlier scope is refused whoever publishes');
});

async function fixture(t, { refuse }) {
  const base = await mkdtemp(path.join(os.tmpdir(), `sflow-cic-drafts-${refuse ? 'on' : 'off'}-`));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Cone Tester',
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'w.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'a.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'l.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'c.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cone Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'cone@example.invalid' };
  const run = (args) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: root, env, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 1 << 26 });
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 1 << 26 });
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
  if (!refuse) config.spec = { ...config.spec, preAmendmentDrafts: 'legacy' };
  config.workTypes['quick-design'] = { ...config.workTypes['quick-fix'], phases: ['intake', 'fix-design', 'implement', 'verify'] };
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Pre-amendment draft fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const item = (id, ...parts) => path.join(root, 'singularity/work-items', id, ...parts);
  const workflow = async (id) => JSON.parse(await readFile(item(id, 'workflow.json'), 'utf8'));
  const intake = (id, outcome = 'The exported value equals 2.') => [
    `# ${id} — Quick fix scope and plan`, '', '## Problem and fix', '', 'The value must be 2; change the exported constant.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|',
    `| [${id}:AC-001] | ${outcome} |`, `| [${id}:AC-002] | The value module stays a single export. |`, '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests | Fulfillment | Observable result |', '|---|---|---|---|---|',
    `| \`${id}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` | modified | The test reads 2. |`,
    `| \`${id}:AC-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` | existing | One export remains. |`, '',
    '## Out of scope', '', 'Nothing else changes in the module or its interface.', ''].join('\n');
  const designText = (id) => [`# ${id} — Fix Design`, '', '## Root cause', '', 'The exported constant holds the old value; nothing computes it.', '',
    '## Minimal safe change', '', `Change the one literal that holds the value. ${id}:AC-002 keeps the module to a single export, so no import changes.`, '',
    '## Alternatives and regression risk', '', 'A computed value was rejected as unnecessary; the only regression surface is the one test that reads it.', ''].join('\n');
  const code = async (id) => {
    await writeFile(path.join(root, 'src/value.mjs'), `// @clause:${id}:AC-001 the exported value is the number 2\n// @clause:${id}:AC-002 the single export stays\nexport const value = 2;\n`);
    await writeFile(path.join(root, 'test/value.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/value.mjs';\n"
      + `// @ac:${id}:AC-001\ntest('value', () => assert.equal(value, 2));\n// @ac:${id}:AC-002\ntest('one export', async () => assert.deepEqual(Object.keys(await import('../src/value.mjs')), ['value']));\n`);
  };
  // What a person sees of the Story at a point in the middle of it: the same both ways, whatever the switch.
  const snapshot = async (id) => {
    const story = await workflow(id);
    const list = JSON.parse(sflow('decisions', id, '--json'));
    return { status: story.status, current: story.currentPhase,
      steps: story.phaseOrder.map((phase) => [phase, story.phases[phase].status, story.phases[phase].generation]),
      history: story.history.map((entry) => [entry.event, entry.phase ?? null]),
      decisions: (list.data ?? list).items.map((entry) => [entry.kind, entry.title]) };
  };
  const scoped = async (id) => {
    sflow('start', id, '--from-branch', 'main', '--work-type', 'quick-design', '--title', 'Change the value', '--description', 'Return 2.');
    sflow('prepare', 'intake'); sflow('phase', 'enter', 'intake', '--compose', '--json');
    await writeFile(item(id, 'artifacts/intake/intake.md'), intake(id));
    sflow('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place'); sflow('submit', 'intake'); sflow('approve', 'intake', '--yes');
  };
  const designed = async (id) => {
    sflow('prepare', 'fix-design'); sflow('phase', 'enter', 'fix-design', '--compose', '--json');
    await writeFile(item(id, 'artifacts/fix-design/fix-design.md'), designText(id));
    sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place'); sflow('submit', 'fix-design'); sflow('approve', 'fix-design', '--yes');
  };
  const amend = async (id, transform, reason) => {
    const file = path.join(base, `${id}-amended.md`);
    await writeFile(file, transform(await readFile(item(id, 'artifacts/intake/intake.md'), 'utf8')));
    const { proposal } = JSON.parse(sflow('story', 'intent-amendment', 'propose', '--file', file, '--reason', reason, '--json'));
    sflow('story', 'intent-amendment', 'decide', proposal.id, '--decision', 'approve', '--confirm', proposal.id);
  };
  // The edit guard's answer to an application edit in a code turn, as a host asks it.
  const guard = (session) => {
    const hook = (event, payload) => JSON.parse(spawnSync(process.execPath, [cli, 'hook', event], { cwd: root, env, encoding: 'utf8',
      input: JSON.stringify(payload), timeout: childTimeout(60_000) }).stdout || '{}');
    hook('boundary-turn', { cwd: root, sessionId: session, prompt: '/sf-code' });
    return hook('boundary-guard', { cwd: root, sessionId: session, toolName: 'edit', toolArgs: { path: 'src/value.mjs', cwd: root } });
  };
  return { root, run, must, sflow, item, workflow, code, designText, snapshot, scoped, designed, amend, guard };
}

const refusedCode = (result) => { try { const parsed = JSON.parse(result.stdout || result.stderr); return (parsed.error ?? parsed).code; } catch { return null; } };

test('a code step reopened with a draft written before the amendment cannot publish it; it is written again in that step, and the Story reads the same both ways in the middle [CIC:REQ-008, REQ-009]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const on = await fixture(t, { refuse: true });
    const off = await fixture(t, { refuse: false });
    const both = async (step) => Promise.all([on, off].map(step));
    const same = async (label) => {
      const [left, right] = await both((f) => f.snapshot('PD-1'));
      assert.deepEqual(left, right, `${label}: the Story reads the same with the switch on and off`);
    };
    await both((f) => f.scoped('PD-1'));
    await same('after the scope is approved');
    await both((f) => f.designed('PD-1'));
    // The code step is open, its prompt composed, and its code written: then the scope changes under it.
    await both(async (f) => {
      f.sflow('phase', 'begin', 'implement', '--json');
      await f.code('PD-1');
      f.sflow('prepare', 'implement');
      f.sflow('phase', 'enter', 'implement', '--compose', '--json');
    });
    await same('with the code step drafted');
    await both((f) => f.amend('PD-1', (text) => text.replace('The exported value equals 2.', 'The exported value equals 2 and is a number.'), 'Say the value is numeric.'));
    await same('after the amendment is approved');
    const storyOn = await on.workflow('PD-1');
    const storyOff = await off.workflow('PD-1');
    // On: the reopened step is pinned, its prompt set aside, its code generation closed and its draft kept read only.
    const pin = storyOn.phases.implement.scopePin;
    assert.deepEqual([pin.amendment, pin.generation, pin.revision, pin.revisionSha256], ['AMD-001', 1, 2, storyOn.scopeRevisions.at(-1).revisionSha256]);
    assert.ok(pin.setAside.prompt.startsWith('singularity/work-items/PD-1/context/superseded/implement-gen1-'));
    assert.equal(existsSync(on.item('PD-1', 'context/implement-gen1.json')), false, 'the prompt composed before the amendment is set aside');
    assert.equal(storyOn.phases.implement.generationIntent.status, 'superseded');
    assert.equal(pin.draft.path, 'singularity/work-items/PD-1/context/superseded/implement-gen1-before-AMD-001/implementation-summary.md');
    assert.ok(existsSync(path.join(on.root, pin.draft.path)), 'the draft is kept read only');
    assert.equal(storyOn.phases.implement.generationIntent.path, 'singularity/work-items/PD-1/context/superseded/implement-gen1-before-AMD-001/generation-start.json');
    // [CIC:REQ-011] The design rule E8 kept is untouched: its approval and generation stand, and nothing is set aside.
    assert.deepEqual([storyOn.phases['fix-design'].status, storyOn.phases['fix-design'].generation, storyOn.phases['fix-design'].scopePin],
      ['approved', 1, undefined]);
    assert.equal(existsSync(on.item('PD-1', 'context/superseded/fix-design-gen2-before-AMD-001')), false);
    // Off: nothing of it.
    assert.equal(storyOff.phases.implement.scopePin, undefined);
    assert.equal(storyOff.phases.implement.generationIntent.status, 'open');
    assert.equal(existsSync(off.item('PD-1', 'context/implement-gen1.json')), true);
    assert.equal(existsSync(off.item('PD-1', 'context/superseded')), false);
    await both((f) => f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001'));
    await same('after the amendment is acknowledged');
    await both((f) => f.sflow('resume', 'PD-1'));
    await same('before the reopened step is published again');
    // [CIC:REQ-010] The guard imports nothing new: the closed generation is what denies the old draft's code further
    // edits, with the step's own way in; with the switch off its generation stays open.
    const denied = on.guard('after-amendment');
    assert.equal(denied.permissionDecision, 'deny', JSON.stringify(denied));
    assert.match(denied.permissionDecisionReason, /phase begin implement/u);
    assert.notEqual(off.guard('after-amendment').permissionDecision, 'deny');
    // Off, the hole: the draft written before the amendment publishes as it is.
    off.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    // On: refused, with its way out in this step. Its code generation was closed: it begins again, carrying the code
    // written inside the closed one from the same baseline, never as work from before the first begin.
    const closed = on.run(['phase', 'publish', 'implement', '--authored', 'deterministic', '--json']);
    assert.notEqual(closed.status, 0);
    assert.equal(refusedCode(closed), 'PHASE_DRAFT_PREDATES_AMENDMENT', closed.stdout || closed.stderr);
    assert.match(closed.stdout, /implement cannot publish this draft: its code generation was closed when AMD-001 amended the scope \(scope revision 2\)\. Write it again here, in implement, under the amended scope: singularity-flow phase begin implement --work-id PD-1 --json, then singularity-flow phase enter implement --work-id PD-1 --compose --for-agent --json\. The earlier draft is kept read only at singularity\/work-items\/PD-1\/context\/superseded\/implement-gen1-before-AMD-001\/implementation-summary\.md/u);
    assert.equal((await on.workflow('PD-1')).phases.implement.status, 'in_progress', 'nothing loops back: the step waits where it is');
    on.sflow('phase', 'begin', 'implement', '--json');
    assert.notEqual(on.guard('after-begin').permissionDecision, 'deny', 'begun again, the code step edits its code');
    const begun = (await on.workflow('PD-1')).phases.implement.generationIntent;
    assert.deepEqual([begun.status, begun.generation, begun.baseline.mode, begun.baseline.carriedFrom, begun.scopeRevision.amendment],
      ['open', 1, 'carried', storyOn.phases.implement.generationIntent.id, 'AMD-001']);
    // Its prompt was set aside: by its records, publication still refuses until the step is composed again.
    const refused = on.run(['phase', 'publish', 'implement', '--authored', 'deterministic', '--json']);
    assert.notEqual(refused.status, 0);
    assert.equal(refusedCode(refused), 'PHASE_DRAFT_PREDATES_AMENDMENT', refused.stdout || refused.stderr);
    assert.match(refused.stdout, /implement cannot publish this draft: its prompt was composed before AMD-001 amended the scope \(scope revision 2\)\. Write it again here, in implement, under the amended scope: singularity-flow phase enter implement --work-id PD-1 --compose --for-agent --json\./u);
    assert.equal((await on.workflow('PD-1')).phases.implement.status, 'in_progress');
    const entered = JSON.parse(on.sflow('phase', 'enter', 'implement', '--compose', '--json'));
    const composed = await readFile(on.item('PD-1', 'context/prompts/implement-gen1.md'), 'utf8');
    assert.ok(composed.includes(`## Draft written before AMD-001 (read only)\n\n\`${pin.draft.path}\``), JSON.stringify(entered).slice(0, 300));
    assert.deepEqual(JSON.parse(await readFile(on.item('PD-1', 'context/implement-gen1.json'), 'utf8')).scopeRevision,
      { revision: 2, revisionSha256: storyOn.scopeRevisions.at(-1).revisionSha256, amendment: 'AMD-001' });
    on.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    await same('after the reopened step is published');
  });

test('a document step reopened by an amendment: an agent\'s publication waits until it is composed again, and a person may publish the old text unchanged [CIC:REQ-009]', slowLane({ timeout: 900_000 }), async (t) => {
  const f = await fixture(t, { refuse: true });
  await f.scoped('PD-2');
  await f.designed('PD-2');
  // AC-002 changes and the design cites it: the design is reopened in place.
  await f.amend('PD-2', (text) => text.replace('The value module stays a single export.', 'The value module keeps exactly one named export.'), 'Tighten the export clause.');
  f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  f.sflow('resume', 'PD-2');
  const story = await f.workflow('PD-2');
  assert.equal(story.currentPhase, 'fix-design');
  assert.equal(story.phases['fix-design'].scopePin.draft.path, 'singularity/work-items/PD-2/context/superseded/fix-design-gen2-before-AMD-001/fix-design.md');
  f.sflow('prepare', 'fix-design');
  // A publication that may be a model's (no --authored) has read nothing composed under the amended scope.
  const uncomposed = f.run(['phase', 'publish', 'fix-design', '--json']);
  assert.notEqual(uncomposed.status, 0);
  assert.equal(refusedCode(uncomposed), 'PHASE_DRAFT_PREDATES_AMENDMENT', uncomposed.stdout || uncomposed.stderr);
  assert.match(uncomposed.stdout, /it has not been composed again since AMD-001 amended the scope/u);
  // The person finds the design still holds: the same text (nothing here writes it after the approval) publishes as
  // theirs, and its approvers approve it again.
  f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
  assert.equal((await f.workflow('PD-2')).phases['fix-design'].generation, 2);
});

test('a later step the amendment resets, holding a draft from before it, is pinned the same way; the Story reaches it and publishes it written again [CIC:REQ-008]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const on = await fixture(t, { refuse: true });
    const off = await fixture(t, { refuse: false });
    const both = async (step) => Promise.all([on, off].map(step));
    const same = async (label) => {
      const [left, right] = await both((f) => f.snapshot('PD-3'));
      assert.deepEqual(left, right, `${label}: the Story reads the same with the switch on and off`);
    };
    await both((f) => f.scoped('PD-3'));
    await both((f) => f.designed('PD-3'));
    await both(async (f) => {
      f.sflow('phase', 'begin', 'implement', '--json');
      await f.code('PD-3');
      f.sflow('prepare', 'implement');
      f.sflow('phase', 'enter', 'implement', '--compose', '--json');
    });
    // AC-002 changes and the design cites it: the design is reopened in place, and the drafted code step is reset after it.
    await both((f) => f.amend('PD-3', (text) => text.replace('The value module stays a single export.', 'The value module keeps exactly one named export.'), 'Tighten the export clause.'));
    await same('after the amendment is approved');
    const story = await on.workflow('PD-3');
    assert.deepEqual([story.currentPhase, story.phases.implement.status], ['fix-design', 'not_started']);
    assert.equal(story.phases['fix-design'].scopePin.generation, 2);
    assert.deepEqual([story.phases.implement.scopePin.generation, story.phases.implement.generationIntent.status], [1, 'superseded']);
    assert.ok(story.phases.implement.scopePin.setAside.prompt);
    assert.equal((await off.workflow('PD-3')).phases.implement.scopePin, undefined);
    await both((f) => f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001'));
    await both((f) => f.sflow('resume', 'PD-3'));
    await both(async (f) => {
      // A document step publishes no application change: the person sets the code draft aside while the design is redone.
      f.must('git', ['checkout', '--', 'src', 'test']);
      f.sflow('prepare', 'fix-design'); f.sflow('phase', 'enter', 'fix-design', '--compose', '--json');
      await writeFile(f.item('PD-3', 'artifacts/fix-design/fix-design.md'), f.designText('PD-3').replace('keeps the module to a single export', 'keeps exactly one named export'));
      f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place'); f.sflow('submit', 'fix-design'); f.sflow('approve', 'fix-design', '--yes');
    });
    await same('after the design is written again and approved');
    const before = (await off.workflow('PD-3')).phases.implement.generationIntent.id;
    // The code step, reached again, is begun, written and composed under the amended scope, and publishes.
    await both(async (f) => {
      f.sflow('prepare', 'implement'); f.sflow('phase', 'begin', 'implement', '--json');
      await f.code('PD-3');
      f.sflow('phase', 'enter', 'implement', '--compose', '--json'); f.sflow('prepare', 'implement');
      f.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    });
    await same('after the code step is published');
    // On, the published generation started under the amended scope; off, under the generation begun before the amendment.
    const published = (await on.workflow('PD-3')).phases.implement.generationIntent;
    assert.deepEqual([published.status, published.scopeRevision.amendment, published.baseline.mode], ['consumed', 'AMD-001', 'clean']);
    assert.notEqual(published.id, story.phases.implement.generationIntent.id);
    assert.equal((await off.workflow('PD-3')).phases.implement.generationIntent.id, before);
  });
