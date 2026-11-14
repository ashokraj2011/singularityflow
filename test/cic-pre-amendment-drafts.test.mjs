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
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { assertCarriesClosedCode, assertDraftPostdatesAmendment, heldCodePaths, holdReturnedCode, pinReopenedStep, preAmendmentDraftRefusal, preAmendmentDraftSection,
  refusesPreAmendmentDrafts, withoutHeldCode } from '../src/amended-drafts.mjs';
import { buildRepositoryChangeSet } from '../src/repository-change-set.mjs';
import { applicationChangeSetProjection } from '../src/work-intervals.mjs';
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

test('a later code step\'s code is recorded at its closure path by path, left out of an earlier document step only while its bytes and its generation stay, and carried exactly [owner, 2026-11-14]', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-held-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const put = async (file, text) => { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Cone Tester'); git('config', 'user.email', 'cone@example.invalid');
  await put('src/a.mjs', 'export const a = 1;\n'); await put('src/b.mjs', 'export const b = 1;\n');
  git('add', '.'); git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  // The code step's code when the amendment closes its generation: an edit, a removal, a new file, and a protected path.
  await put('src/a.mjs', 'export const a = 2;\n'); await rm(path.join(root, 'src/b.mjs')); await put('src/c.mjs', 'export const c = 3;\n'); await put('ops/deploy.sh', 'echo deploy\n');
  const config = { governance: { protectedPaths: ['ops/'] } };
  const story = () => ({ workItem: { id: 'W-1' }, resolution: { spec: { preAmendmentDrafts: 'refuse' } }, phaseOrder: ['design', 'implement'], intentAmendments: [],
    phases: { design: { id: 'design', generation: 1, writeScope: 'artifact-only', requiredArtifact: { kind: 'design', path: 'artifacts/design/design.md' } },
      implement: { id: 'implement', generation: 0, writeScope: 'source-and-artifact', requiredArtifact: { kind: 'implementation-summary', path: 'artifacts/implement/implementation-summary.md' },
        generationIntent: { id: 'G-1', generation: 1, status: 'open', baseline: { commit: base } } } } });
  const workflow = story();
  const { design, implement } = workflow.phases;
  await pinReopenedStep(root, workflow, implement, { amendment: 'AMD-001', revision: null, itemRelative: 'w', at: '2026-11-14T00:00:00.000Z', config });
  const digest = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
  assert.equal(implement.generationIntent.status, 'superseded');
  assert.deepEqual(implement.scopePin.closedChangeSet, { intent: 'G-1', baseCommit: base, paths: [
    { path: 'src/a.mjs', kind: 'regular-file', sha256: digest('export const a = 2;\n') },
    { path: 'src/b.mjs', kind: 'missing', sha256: null },
    { path: 'src/c.mjs', kind: 'regular-file', sha256: digest('export const c = 3;\n') }] }, 'a protected path is never recorded');
  const all = ['ops/deploy.sh', 'src/a.mjs', 'src/b.mjs', 'src/c.mjs'];
  const left = async (paths = all, flow = workflow, phase = design) => (await withoutHeldCode(root, config, flow, phase, paths)).paths;
  assert.deepEqual(await left(), ['ops/deploy.sh'], 'exactly the recorded code stays out of the design; the protected path is still its to answer for');
  assert.deepEqual([...await heldCodePaths(root, config, workflow, design)].sort(), ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
  const changeSet = async () => applicationChangeSetProjection(await buildRepositoryChangeSet(root, { baseCommit: base }), null);
  await rm(path.join(root, 'ops'), { recursive: true });
  assert.equal(assertCarriesClosedCode(config, workflow, implement, await changeSet(), {}), undefined, 'the recorded code, and only it, is carried');
  // A path changed after the closure: the design answers for it again, and the code step's begin does not carry it.
  await put('src/a.mjs', 'export const a = 22;\n');
  const moved = await withoutHeldCode(root, config, workflow, design, all.slice(1));
  assert.deepEqual(moved, { paths: ['src/a.mjs'], changed: [{ path: 'src/a.mjs', step: 'implement', by: 'AMD-001' }] });
  let refusal = null;
  try { assertCarriesClosedCode(config, workflow, implement, await changeSet(), { workId: 'W-1' }); } catch (error) { refusal = error; }
  assert.equal(refusal?.code, 'GENERATION_DIRTY_START');
  assert.deepEqual(refusal.details.changedSinceClosure, ['src/a.mjs']);
  assert.match(refusal.message, /^implement carries only the code its generation held when AMD-001 closed it, and src\/a\.mjs changed since\./u);
  await put('src/a.mjs', 'export const a = 2;\n');
  // New code is the design's to answer for, and the begin does not carry it.
  await put('src/d.mjs', 'export const d = 4;\n');
  assert.deepEqual(await left([...all.slice(1), 'src/d.mjs']), ['src/d.mjs']);
  refusal = null;
  try { assertCarriesClosedCode(config, workflow, implement, await changeSet(), {}); } catch (error) { refusal = error; }
  assert.deepEqual(refusal?.details.changedSinceClosure, ['src/d.mjs']);
  await rm(path.join(root, 'src/d.mjs'));
  // Nothing is left out with switch 2 off, for the code step itself, or once its generation is opened again.
  const legacy = { ...workflow, resolution: { spec: { preAmendmentDrafts: 'legacy' } } };
  assert.deepEqual(await left(all.slice(1), legacy), all.slice(1));
  assert.deepEqual(await left(all.slice(1), workflow, implement), all.slice(1));
  const reopened = structuredClone(workflow);
  reopened.phases.implement.generationIntent = { id: 'G-2', generation: 1, status: 'open', baseline: { commit: base } };
  assert.deepEqual(await left(all.slice(1), reopened, reopened.phases.design), all.slice(1));
  // A return to the design with the code step's generation open records it the same way, bound to that open generation.
  const returned = story();
  await holdReturnedCode(root, config, returned, ['design', 'implement'], 'CR-001');
  assert.deepEqual(returned.phases.implement.heldCode, { by: 'CR-001', intent: 'G-1', baseCommit: base, paths: implement.scopePin.closedChangeSet.paths });
  assert.deepEqual(await left(all.slice(1), returned, returned.phases.design), []);
  returned.phases.implement.generationIntent.status = 'consumed';
  assert.deepEqual(await left(all.slice(1), returned, returned.phases.design), all.slice(1), 'once that generation is published, nothing is held');
  const legacyReturn = { ...story(), resolution: { spec: { preAmendmentDrafts: 'legacy' } } };
  await holdReturnedCode(root, config, legacyReturn, ['design', 'implement'], 'CR-001');
  assert.equal(legacyReturn.phases.implement.heldCode, undefined);
});

async function fixture(t, { refuse, protect = null, observed = false }) {
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
  if (observed) config.spec = { ...config.spec, observedDependencies: 'on' };
  if (protect) config.governance = { ...config.governance, protectedPaths: [...(config.governance?.protectedPaths ?? []), protect] };
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
  // The application files the checkout holds changed, and the ones a commit holds.
  const dirty = () => must('git', ['status', '--porcelain', '--untracked-files=all']).split('\n').filter((line) => line && !line.includes('singularity/')).sort();
  const committed = (commit) => must('git', ['show', '--name-only', '--format=', commit]).split('\n').filter(Boolean).sort();
  // What a step's publication committed, by its commit's subject.
  const published = (id, phase, generation) => committed(must('git', ['log', '-1', '--fixed-strings', `--grep=[${id}][phase:${phase}][generated:${generation}]`, '--format=%H']).trim());
  return { root, run, must, sflow, item, workflow, code, designText, snapshot, scoped, designed, amend, guard, dirty, committed, published };
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

test('a later step the amendment resets, holding a draft from before it, is pinned the same way; with switch 2 the reopened design is written with its code left in place, and the Story reads the same both ways in the middle [CIC:REQ-008, owner 2026-11-14]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const on = await fixture(t, { refuse: true });
    const off = await fixture(t, { refuse: false });
    const both = async (step) => Promise.all([on, off].map(step));
    const same = async (label) => {
      const [left, right] = await both((f) => f.snapshot('PD-3'));
      assert.deepEqual(left, right, `${label}: the Story reads the same with the switch on and off`);
    };
    const CODE = [' M src/value.mjs', ' M test/value.test.mjs'];
    // The checkout at a point in the middle: on, the code step's code stays where it is; off, the person set it aside.
    const checkouts = (label, expected) => assert.deepEqual([on.dirty(), off.dirty()], expected, label);
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
    checkouts('after the amendment is approved', [CODE, CODE]);
    const story = await on.workflow('PD-3');
    assert.deepEqual([story.currentPhase, story.phases.implement.status], ['fix-design', 'not_started']);
    assert.equal(story.phases['fix-design'].scopePin.generation, 2);
    const closed = story.phases.implement.generationIntent;
    assert.deepEqual([story.phases.implement.scopePin.generation, closed.status], [1, 'superseded']);
    assert.ok(story.phases.implement.scopePin.setAside.prompt);
    // On: the closure recorded the code the closed generation holds, path by path with its content digest, from its baseline.
    const record = story.phases.implement.scopePin.closedChangeSet;
    const digest = async (file) => `sha256:${createHash('sha256').update(await readFile(path.join(on.root, file))).digest('hex')}`;
    assert.deepEqual(record, { intent: closed.id, baseCommit: closed.baseline.commit, paths: [
      { path: 'src/value.mjs', kind: 'regular-file', sha256: await digest('src/value.mjs') },
      { path: 'test/value.test.mjs', kind: 'regular-file', sha256: await digest('test/value.test.mjs') }] });
    // Off: nothing of it.
    const storyOff = await off.workflow('PD-3');
    assert.equal(storyOff.phases.implement.scopePin, undefined);
    assert.equal(storyOff.phases.implement.generationIntent.status, 'open');
    await both((f) => f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001'));
    await both((f) => f.sflow('resume', 'PD-3'));
    await same('before the design is written again');
    await both(async (f) => {
      f.sflow('prepare', 'fix-design');
      // Composing it: on, the code is no change for the design to review; off, the checkout holds it for a person first.
      const entry = JSON.parse(f.sflow('phase', 'enter', 'fix-design', '--compose', '--json'));
      if (f === on) assert.deepEqual([entry.status, entry.contextAdmission.blockers], ['authoring-entry', []]);
      else assert.ok(entry.contextAdmission.blockers.some((blocker) => blocker.code === 'PHASE_CONTEXT_WORKTREE_REVIEW_REQUIRED'), JSON.stringify(entry.contextAdmission));
      await writeFile(f.item('PD-3', 'artifacts/fix-design/fix-design.md'), f.designText('PD-3').replace('keeps the module to a single export', 'keeps exactly one named export'));
      // Off (and on every Story pinned before the field): a document step publishes no application change, so the person
      // sets the code aside while the design is redone. On: the code stays; the design does not count it against itself.
      if (f === off) {
        const refused = f.run(['phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place', '--json']);
        assert.equal(refusedCode(refused), 'PHASE_ARTIFACT_ONLY_CHANGES', refused.stdout || refused.stderr);
        assert.match(refused.stdout, /They change PD-3:AC-001, PD-3:AC-002\./u, 'no step owns them yet, so no empty owner is named');
        assert.doesNotMatch(refused.stdout, /owned by \./u);
        f.must('git', ['checkout', '--', 'src', 'test']);
      }
      const checked = JSON.parse(f.sflow('phase', 'prepublish', 'fix-design', '--json'));
      assert.equal(checked.status, 'ready', JSON.stringify(checked.findings));
      f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    });
    await same('after the design is published again');
    checkouts('after the design is published again', [CODE, []]);
    // Its publication commits only the design, whichever way: the code is never a document step's.
    for (const f of [on, off]) assert.deepEqual(f.published('PD-3', 'fix-design', 2).filter((file) => !file.startsWith('singularity/')), []);
    assert.deepEqual((await on.workflow('PD-3')).phases['fix-design'].artifacts.map((artifact) => artifact.path), ['singularity/work-items/PD-3/artifacts/fix-design/fix-design.md']);
    await both((f) => f.sflow('submit', 'fix-design'));
    await same('after the design is submitted again');
    await both((f) => f.sflow('approve', 'fix-design', '--yes'));
    await same('after the design is written again and approved');
    checkouts('after the design is approved', [CODE, []]);
    assert.equal((await on.workflow('PD-3')).phases.implement.generationIntent.status, 'superseded', 'the code step\'s generation is still the closed one');
    const before = storyOff.phases.implement.generationIntent.id;
    // The code step, reached again, is begun and composed under the amended scope, and publishes. On, its begin carries the
    // code the closure recorded; off, the person brings the code back and it continues the generation opened before.
    await both(async (f) => {
      f.sflow('prepare', 'implement'); f.sflow('phase', 'begin', 'implement', '--json');
      await f.code('PD-3');
      f.sflow('phase', 'enter', 'implement', '--compose', '--json'); f.sflow('prepare', 'implement');
      f.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    });
    await same('after the code step is published');
    checkouts('after the code step is published', [[], []]);
    for (const f of [on, off]) assert.deepEqual(f.published('PD-3', 'implement', 1).filter((file) => !file.startsWith('singularity/')), ['src/value.mjs', 'test/value.test.mjs']);
    // On, the published generation started under the amended scope from the code the closure kept; off, it is the generation
    // begun before the amendment.
    const published = (await on.workflow('PD-3')).phases.implement.generationIntent;
    assert.deepEqual([published.status, published.scopeRevision.amendment, published.baseline.mode, published.baseline.carriedFrom, published.baseline.commit],
      ['consumed', 'AMD-001', 'carried', closed.id, closed.baseline.commit]);
    assert.notEqual(published.id, closed.id);
    assert.equal((await off.workflow('PD-3')).phases.implement.generationIntent.id, before);
  });

const errorOf = (result) => { try { const parsed = JSON.parse(result.stdout || result.stderr); return parsed.error ?? parsed; } catch { return {}; } };

test('a reopened design still answers for code changed after the closure, for new code and for a protected path, and the code step carries only what was recorded [owner, 2026-11-14]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await fixture(t, { refuse: true, protect: 'ops/' });
    const file = (relative) => path.join(f.root, relative);
    await f.scoped('PD-5');
    await f.designed('PD-5');
    f.sflow('phase', 'begin', 'implement', '--json');
    await f.code('PD-5');
    f.sflow('prepare', 'implement');
    f.sflow('phase', 'enter', 'implement', '--compose', '--json');
    // A protected file in the checkout when the amendment closes the code step's generation is never recorded for it.
    await mkdir(file('ops'), { recursive: true });
    await writeFile(file('ops/deploy.sh'), 'echo deploy\n');
    await f.amend('PD-5', (text) => text.replace('The value module stays a single export.', 'The value module keeps exactly one named export.'), 'Tighten the export clause.');
    assert.deepEqual((await f.workflow('PD-5')).phases.implement.scopePin.closedChangeSet.paths.map((entry) => entry.path), ['src/value.mjs', 'test/value.test.mjs']);
    f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001');
    f.sflow('resume', 'PD-5');
    f.sflow('prepare', 'fix-design');
    f.sflow('phase', 'enter', 'fix-design', '--compose', '--json');
    await writeFile(f.item('PD-5', 'artifacts/fix-design/fix-design.md'), f.designText('PD-5').replace('keeps the module to a single export', 'keeps exactly one named export'));
    const publish = () => f.run(['phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place', '--json']);
    const blockers = () => JSON.parse(f.sflow('phase', 'prepublish', 'fix-design', '--json')).findings.map((finding) => finding.code);
    // The protected path is refused as before.
    let refused = errorOf(publish());
    assert.deepEqual([refused.code, refused.details?.paths], ['CHANGE_SET_POLICY_VIOLATION', ['ops/']], JSON.stringify(refused).slice(0, 600));
    await rm(file('ops'), { recursive: true });
    // A path changed after the closure is the design's to answer for again; the one still as recorded stays the code step's.
    const kept = await readFile(file('src/value.mjs'), 'utf8');
    await writeFile(file('src/value.mjs'), `${kept}// edited after the amendment\n`);
    refused = errorOf(publish());
    assert.deepEqual([refused.code, refused.details?.changedPaths, refused.details?.changedSinceClosure], ['PHASE_ARTIFACT_ONLY_CHANGES', ['src/value.mjs'], ['src/value.mjs']], JSON.stringify(refused).slice(0, 600));
    assert.match(refused.message, /src\/value\.mjs changed after AMD-001 left implement's code in place for it, so this step answers for it: put back the bytes recorded then, or set it aside; implement picks up only that code\.$/u);
    assert.doesNotMatch(refused.message, /owned by \./u);
    assert.ok(blockers().includes('PHASE_ARTIFACT_ONLY_CHANGES'), 'prepublish says the same');
    await writeFile(file('src/value.mjs'), kept);
    // New code is refused as before.
    await writeFile(file('src/extra.mjs'), 'export const extra = 1;\n');
    refused = errorOf(publish());
    assert.deepEqual([refused.code, refused.details?.changedPaths], ['PHASE_ARTIFACT_ONLY_CHANGES', ['src/extra.mjs']], JSON.stringify(refused).slice(0, 600));
    await rm(file('src/extra.mjs'));
    // With only the recorded code left, the design is checked, published and submitted with it in place.
    assert.ok(!blockers().includes('PHASE_ARTIFACT_ONLY_CHANGES'));
    f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    assert.deepEqual(f.published('PD-5', 'fix-design', 2).filter((entry) => !entry.startsWith('singularity/')), []);
    f.sflow('submit', 'fix-design');
    // Its approval refuses a recorded path changed since, as it refuses any change in the checkout.
    await writeFile(file('src/value.mjs'), `${kept}// edited after the amendment\n`);
    refused = errorOf(f.run(['approve', 'fix-design', '--yes', '--json']));
    assert.deepEqual([refused.code, refused.details?.paths], ['LIFECYCLE_WORKTREE_REVIEW_REQUIRED', ['src/value.mjs']], JSON.stringify(refused).slice(0, 600));
    await writeFile(file('src/value.mjs'), kept);
    f.sflow('approve', 'fix-design', '--yes');
    assert.deepEqual(f.dirty(), [' M src/value.mjs', ' M test/value.test.mjs']);
    // The code step's begin carries exactly the recorded code: a path changed since is refused there, in that step.
    await writeFile(file('src/value.mjs'), `${kept}// edited after the amendment\n`);
    refused = errorOf(f.run(['phase', 'begin', 'implement', '--json']));
    assert.deepEqual([refused.code, refused.details?.changedSinceClosure], ['GENERATION_DIRTY_START', ['src/value.mjs']], JSON.stringify(refused).slice(0, 600));
    await writeFile(file('src/value.mjs'), kept);
    f.sflow('phase', 'begin', 'implement', '--json');
    const begun = (await f.workflow('PD-5')).phases.implement.generationIntent;
    assert.deepEqual([begun.status, begun.baseline.mode], ['open', 'carried']);
  });

test('a return to the design from a code step whose generation is open leaves its code in place for it the same way; with the switch off the design still stalls on it [owner, 2026-11-14]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const on = await fixture(t, { refuse: true });
    const off = await fixture(t, { refuse: false });
    const both = async (step) => Promise.all([on, off].map(step));
    const same = async (label) => {
      const [left, right] = await both((f) => f.snapshot('PD-6'));
      assert.deepEqual(left, right, `${label}: the Story reads the same with the switch on and off`);
    };
    const CODE = [' M src/value.mjs', ' M test/value.test.mjs'];
    await both((f) => f.scoped('PD-6'));
    await both((f) => f.designed('PD-6'));
    await both(async (f) => {
      f.sflow('phase', 'begin', 'implement', '--json');
      await f.code('PD-6');
      f.sflow('prepare', 'implement');
      f.sflow('phase', 'enter', 'implement', '--compose', '--json');
      // The code step finds a defect in the design; the design's approvers return the Story to it.
      f.sflow('upstream-issue', 'raise', '--phase', 'fix-design', '--about', 'Root cause', '--problem', 'The design names the wrong root cause for the value.');
      f.sflow('upstream-issue', 'decide', 'UPI-001', '--outcome', 'return', '--reason', 'The design must name the right root cause first.');
    });
    await same('after the return');
    assert.deepEqual([on.dirty(), off.dirty()], [CODE, CODE]);
    const open = (await on.workflow('PD-6')).phases.implement;
    assert.deepEqual([open.status, open.generationIntent.status], ['not_started', 'open'], 'a return does not close the code step\'s generation');
    assert.deepEqual([open.heldCode.by, open.heldCode.intent, open.heldCode.baseCommit, open.heldCode.paths.map((entry) => entry.path)],
      ['CR-001', open.generationIntent.id, open.generationIntent.baseline.commit, ['src/value.mjs', 'test/value.test.mjs']]);
    assert.equal((await off.workflow('PD-6')).phases.implement.heldCode, undefined);
    await both(async (f) => {
      f.sflow('prepare', 'fix-design'); f.sflow('phase', 'enter', 'fix-design', '--compose', '--json');
      await writeFile(f.item('PD-6', 'artifacts/fix-design/fix-design.md'), f.designText('PD-6').replace('holds the old value', 'holds the old literal value'));
      if (f === off) {
        const refused = errorOf(f.run(['phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place', '--json']));
        assert.equal(refused.code, 'PHASE_ARTIFACT_ONLY_CHANGES', JSON.stringify(refused).slice(0, 600));
        f.must('git', ['checkout', '--', 'src', 'test']);
      }
      f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
      f.sflow('submit', 'fix-design');
      f.sflow('approve', 'fix-design', '--yes');
    });
    await same('after the design is approved again');
    assert.deepEqual([on.dirty(), off.dirty()], [CODE, []]);
    for (const f of [on, off]) assert.deepEqual(f.published('PD-6', 'fix-design', 2).filter((entry) => !entry.startsWith('singularity/')), []);
    // The code step picks its code up in the same open generation, and publishes it.
    await both(async (f) => {
      f.sflow('prepare', 'implement'); f.sflow('phase', 'begin', 'implement', '--json');
      await f.code('PD-6');
      f.sflow('phase', 'enter', 'implement', '--compose', '--json'); f.sflow('prepare', 'implement');
      f.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    });
    await same('after the code step is published');
    for (const f of [on, off]) {
      const intent = (await f.workflow('PD-6')).phases.implement.generationIntent;
      assert.deepEqual([intent.status, intent.baseline.mode], ['consumed', 'clean']);
      assert.deepEqual(f.published('PD-6', 'implement', 1).filter((entry) => !entry.startsWith('singularity/')), ['src/value.mjs', 'test/value.test.mjs']);
    }
    assert.equal((await on.workflow('PD-6')).phases.implement.generationIntent.id, open.generationIntent.id);
  });

test('a "still holds" answered No while the amendment has the code step\'s generation closed returns to the design, which is written with that code in place [owner, 2026-11-14]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await fixture(t, { refuse: true, observed: true });
    await f.scoped('PD-7');
    await f.designed('PD-7');
    f.sflow('phase', 'begin', 'implement', '--json');
    await f.code('PD-7');
    f.sflow('prepare', 'implement');
    f.sflow('phase', 'enter', 'implement', '--compose', '--json');
    // AC-001 changes; the design does not cite it, so it is kept and asked whether it still holds; the code step is reopened in place.
    await f.amend('PD-7', (text) => text.replace('The exported value equals 2.', 'The exported value equals 2 and is a number.'), 'Say the value is numeric.');
    f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001');
    f.sflow('resume', 'PD-7');
    const closed = (await f.workflow('PD-7')).phases.implement;
    assert.deepEqual([closed.status, closed.generationIntent.status, (await f.workflow('PD-7')).phases['fix-design'].status], ['in_progress', 'superseded', 'approved']);
    f.sflow('upstream-issue', 'revalidate', 'fix-design', '--amendment', 'AMD-001', '--outcome', 'return', '--reason', 'The design leans on the old wording of the value criterion.');
    const returned = await f.workflow('PD-7');
    assert.deepEqual([returned.currentPhase, returned.phases.implement.generationIntent.status, returned.phases.implement.heldCode],
      ['fix-design', 'superseded', undefined], 'the closure\'s record is what keeps the code for it');
    f.sflow('prepare', 'fix-design'); f.sflow('phase', 'enter', 'fix-design', '--compose', '--json');
    await writeFile(f.item('PD-7', 'artifacts/fix-design/fix-design.md'), f.designText('PD-7').replace('holds the old value', 'holds the old value, a number'));
    f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place');
    f.sflow('submit', 'fix-design');
    f.sflow('approve', 'fix-design', '--yes');
    assert.deepEqual(f.dirty(), [' M src/value.mjs', ' M test/value.test.mjs']);
    f.sflow('prepare', 'implement'); f.sflow('phase', 'begin', 'implement', '--json');
    f.sflow('phase', 'enter', 'implement', '--compose', '--json'); f.sflow('prepare', 'implement');
    f.sflow('phase', 'publish', 'implement', '--authored', 'deterministic');
    const published = (await f.workflow('PD-7')).phases.implement.generationIntent;
    assert.deepEqual([published.status, published.baseline.mode, published.baseline.carriedFrom], ['consumed', 'carried', closed.generationIntent.id]);
    assert.deepEqual(f.dirty(), []);
  });

// The routes a code step's entry and its recovery plan give for the checkout: [id, command] of each action.
const entryRoutes = (f, phase) => {
  const entry = JSON.parse(f.sflow('phase', 'enter', phase, '--compose', '--for-agent', '--json'));
  return (entry.next ?? []).map((action) => [action.id, action.commandGuidance?.command ?? action.command ?? null]);
};
const planRoutes = (f, id, phase) => JSON.parse(f.sflow('recover', id, '--phase', phase, '--json')).actions
  .map((action) => [action.id, action.commandGuidance?.command ?? action.command ?? null]);

test('before a closed generation begins again, recovery routes exactly its recorded code to `phase begin`, never to a reviewed commit; anything beyond the record, and code a return left open, keep their routes [paid run, 2026-11-14]',
  slowLane({ timeout: 900_000 }), async (t) => {
    const [f, r] = await Promise.all([fixture(t, { refuse: true }), fixture(t, { refuse: true })]);
    // f: the amendment closes the code step's generation; the design is written again with its code in place and approved.
    await f.scoped('PD-8');
    await f.designed('PD-8');
    f.sflow('phase', 'begin', 'implement', '--json');
    await f.code('PD-8');
    f.sflow('prepare', 'implement');
    f.sflow('phase', 'enter', 'implement', '--compose', '--json');
    await f.amend('PD-8', (text) => text.replace('The value module stays a single export.', 'The value module keeps exactly one named export.'), 'Tighten the export clause.');
    f.sflow('story', 'intent-amendment', 'acknowledge', 'AMD-001');
    f.sflow('resume', 'PD-8');
    f.sflow('prepare', 'fix-design'); f.sflow('phase', 'enter', 'fix-design', '--compose', '--json');
    await writeFile(f.item('PD-8', 'artifacts/fix-design/fix-design.md'), f.designText('PD-8').replace('keeps the module to a single export', 'keeps exactly one named export'));
    f.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place'); f.sflow('submit', 'fix-design'); f.sflow('approve', 'fix-design', '--yes');
    assert.deepEqual(f.dirty(), [' M src/value.mjs', ' M test/value.test.mjs']);
    const BEGIN = 'singularity-flow phase begin implement --json';
    // Exactly the recorded code: the entry, before `phase begin`, routes it there; nothing offers to commit it as reviewed.
    for (const routes of [entryRoutes(f, 'implement'), planRoutes(f, 'PD-8', 'implement')]) {
      assert.deepEqual(routes.filter(([id]) => id === 'working-tree'), [['working-tree', BEGIN]], JSON.stringify(routes));
      assert.ok(!routes.some(([id]) => id === 'commit-reviewed-worktree'), JSON.stringify(routes));
    }
    // A recorded file changed since: beyond the record, the routes are today's, and the begin refuses it in this step.
    const kept = await readFile(path.join(f.root, 'src/value.mjs'), 'utf8');
    await writeFile(path.join(f.root, 'src/value.mjs'), `${kept}// edited after the amendment\n`);
    const beyond = entryRoutes(f, 'implement');
    assert.ok(!beyond.some(([, command]) => command === BEGIN), JSON.stringify(beyond));
    assert.ok(beyond.some(([id]) => id === 'commit-reviewed-worktree'), JSON.stringify(beyond));
    assert.equal(errorOf(f.run(['phase', 'begin', 'implement', '--json'])).code, 'GENERATION_DIRTY_START');
    await writeFile(path.join(f.root, 'src/value.mjs'), kept);
    // The route it named carries the code.
    f.sflow('phase', 'begin', 'implement', '--json');
    assert.deepEqual((await f.workflow('PD-8')).phases.implement.generationIntent.baseline.mode, 'carried');

    // r: a return to the design leaves the code step's open generation and its code in place (`heldCode`). Reached again, the
    // generation is still open: its code is that generation's draft to continue, and nothing routes it to a begin.
    await r.scoped('PD-9');
    await r.designed('PD-9');
    r.sflow('phase', 'begin', 'implement', '--json');
    await r.code('PD-9');
    r.sflow('prepare', 'implement');
    r.sflow('phase', 'enter', 'implement', '--compose', '--json');
    r.sflow('upstream-issue', 'raise', '--phase', 'fix-design', '--about', 'Root cause', '--problem', 'The design names the wrong root cause for the value.');
    r.sflow('upstream-issue', 'decide', 'UPI-001', '--outcome', 'return', '--reason', 'The design must name the right root cause first.');
    assert.ok((await r.workflow('PD-9')).phases.implement.heldCode);
    r.sflow('prepare', 'fix-design'); r.sflow('phase', 'enter', 'fix-design', '--compose', '--json');
    await writeFile(r.item('PD-9', 'artifacts/fix-design/fix-design.md'), r.designText('PD-9').replace('holds the old value', 'holds the old literal value'));
    r.sflow('phase', 'publish', 'fix-design', '--authored', 'human', '--channel', 'manual-in-place'); r.sflow('submit', 'fix-design'); r.sflow('approve', 'fix-design', '--yes');
    const held = entryRoutes(r, 'implement');
    assert.deepEqual(held.filter(([id]) => id === 'working-tree'), [['working-tree', 'singularity-flow phase prepublish implement --json']], JSON.stringify(held));
    assert.ok(!held.some(([, command]) => command === BEGIN), JSON.stringify(held));
  });
