/**
 * Change impact is on by default [SPEC-CIC v1.1 stage 7; CIC:REQ-018, REQ-019; owner decision 2026-11-15: "yes, turn it on
 * by default after the fix and seeded ones also"]. A workflow that does not set `spec.changeImpact` runs with it on, which
 * pins change impact and observed dependencies; `off` opts out, and so does `spec.observedDependencies: off` with no
 * `spec.changeImpact`, as a repository wrote it before the default. Every seeded workflow says `on`, and a workflow the
 * Studio or `workflow define` creates writes it out. A Story pinned before keeps its behaviour: nothing rewrites a pinned
 * policy.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { changeImpactCounts } from '../src/change-impact-counts.mjs';
import { dependencyLines } from '../src/commands/spec-dependencies.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { requirementChanges } from '../src/report.mjs';
import { editorialCarriers } from '../src/scope/carried-evidence.mjs';
import { observedDependencies } from '../src/scope/revisions.mjs';
import { normalizeSpecPolicy, workTypeSpecPolicy } from '../src/specifications.mjs';
import { defineWorkflow } from '../src/workflow-authoring.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

test('every seeded workflow has change impact on, written out in the spec block init copies [owner, 2026-11-15]', async () => {
  const template = YAML.parse(await readFile(path.join(packageRoot, 'templates', 'workflow.yml'), 'utf8'));
  assert.equal(template.spec.changeImpact, 'on', 'templates/workflow.yml says it');
  const seeded = Object.entries(template.workTypes ?? {});
  assert.ok(seeded.length >= 10, `${seeded.length} seeded workflows`);
  for (const [id, workType] of seeded) {
    const policy = workTypeSpecPolicy(template.spec, workType.spec);
    assert.deepEqual([policy.changeImpact, policy.observedDependencies], ['on', 'on'], id);
  }
  const example = YAML.parse(await readFile(path.join(packageRoot, 'examples', 'workflow-with-quality-gates.yml'), 'utf8'));
  assert.equal(example.spec.changeImpact, 'on', 'the shipped example says it too');
  // What init writes, loaded as the engine reads it: every workflow resolves with change impact on.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-default-seeded-'));
  try {
    await initializeDefinition(root);
    assert.match(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8'), /\n {2}changeImpact: on\n/u);
    const definition = await loadDefinition(root);
    assert.deepEqual([definition.spec.changeImpact, definition.spec.observedDependencies], ['on', 'on']);
    for (const id of Object.keys(definition.workTypes)) {
      const resolved = resolveWorkType(definition, id);
      assert.deepEqual([resolved.spec.changeImpact, resolved.spec.observedDependencies], ['on', 'on'], id);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a workflow that sets nothing runs with change impact on; off, or observed dependencies off alone, opts out and still loads [CIC:REQ-018]', async () => {
  assert.deepEqual([normalizeSpecPolicy({}).changeImpact, normalizeSpecPolicy({}).observedDependencies], ['on', 'on']);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-default-load-'));
  try {
    await initializeDefinition(root);
    const file = path.join(root, 'singularity', 'workflow.yml');
    const original = YAML.parse(await readFile(file, 'utf8'));
    const load = async (spec, workTypeSpec = null) => {
      const config = structuredClone(original);
      config.spec = spec;
      if (workTypeSpec) config.workTypes['quick-fix'] = { ...config.workTypes['quick-fix'], spec: workTypeSpec };
      await writeFile(file, YAML.stringify(config));
      const definition = await loadDefinition(root);
      return Object.fromEntries(['quick-fix', 'feature'].filter((id) => definition.workTypes[id])
        .map((id) => [id, [resolveWorkType(definition, id).spec.changeImpact, resolveWorkType(definition, id).spec.observedDependencies ?? 'off']]));
    };
    const { changeImpact: _changeImpact, ...unset } = original.spec;
    assert.deepEqual(await load(unset), { 'quick-fix': ['on', 'on'], feature: ['on', 'on'] }, 'no setting: on');
    assert.deepEqual(await load({ ...unset, changeImpact: 'off' }), { 'quick-fix': ['off', 'off'], feature: ['off', 'off'] });
    // A repository that turned observed dependencies off before the default kept change impact off, and still loads.
    assert.deepEqual(await load({ ...unset, observedDependencies: 'off' }), { 'quick-fix': ['off', 'off'], feature: ['off', 'off'] });
    // Switch 1 alone stays valid.
    assert.deepEqual(await load({ ...unset, changeImpact: 'off', observedDependencies: 'on' }), { 'quick-fix': ['off', 'on'], feature: ['off', 'on'] });
    // A workflow opts out on its own the same way, and does not inherit the repository's scope-change authority with it.
    assert.deepEqual(await load({ ...unset, scopeChangeAuthority: 'product-approvers' }, { observedDependencies: 'off' }), { 'quick-fix': ['off', 'off'], feature: ['on', 'on'] });
    // Only an explicit change impact on with observed dependencies off is refused, and the refusal says both ways out.
    await assert.rejects(() => load({ ...unset, changeImpact: 'on', observedDependencies: 'off' }),
      /spec\.changeImpact on records observed dependencies too: remove spec\.observedDependencies: off, or set spec\.changeImpact: off to turn both off\./u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a Story pinned before the default reads every switch off: no reader treats the missing field as on [CIC:REQ-019, AC-018]', () => {
  const pinned = { workItem: { id: 'OLD-1' }, resolution: { spec: { mode: 'record', coverage: 'record', preAmendmentDrafts: 'refuse' } },
    phaseOrder: ['intake'], phases: { intake: { id: 'intake' } },
    intentAmendments: [{ id: 'AMD-001', status: 'approved', changedClauses: ['OLD-1:AC-001'], carried: 'editorial', decision: { actor: 'a', authorityGroup: 'g' } }] };
  assert.equal(observedDependencies(pinned), false);
  assert.equal(editorialCarriers(pinned).size, 0);
  assert.equal(requirementChanges(pinned), null);
  assert.deepEqual(changeImpactCounts(pinned).switches, { changeImpact: 'off', observedDependencies: 'off', preAmendmentDrafts: 'refuse' });
  assert.match(dependencyLines(pinned, { chain: { revisions: 0, verified: true, problems: [] }, steps: [] })[0], /^OLD-1: observed dependencies are off for this Story\./u);
  // Opted out, it says how.
  const opted = { ...pinned, resolution: { spec: { ...pinned.resolution.spec, changeImpact: 'off' } } };
  assert.match(dependencyLines(opted, { chain: { revisions: 0, verified: true, problems: [] }, steps: [] })[0],
    /^OLD-1: change impact is off \(spec\.changeImpact: off, or spec\.observedDependencies: off\), and observed dependencies are off for this Story\./u);
});

test('a workflow `workflow define` creates writes its change impact out, as the repository\'s workflows get it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-default-define-'));
  try {
    await initializeDefinition(root);
    await repositoryOwnedWorkflows(root);
    await defineWorkflow(root, 'short-delivery', { phases: ['requirements', 'implementation-spec', 'implementation', 'verification'], governs: 'story' });
    const file = path.join(root, 'singularity', 'workflow.yml');
    assert.deepEqual(YAML.parse(await readFile(file, 'utf8')).workTypes['short-delivery'].spec, { changeImpact: 'on' });
    assert.equal(resolveWorkType(await loadDefinition(root), 'short-delivery').spec.changeImpact, 'on');
    // In a repository that turned it off, a new workflow says off.
    const config = YAML.parse(await readFile(file, 'utf8'));
    config.spec = { ...config.spec, changeImpact: 'off' };
    await writeFile(file, YAML.stringify(config));
    await defineWorkflow(root, 'short-delivery-two', { phases: ['requirements', 'implementation-spec', 'implementation', 'verification'], governs: 'story' });
    assert.deepEqual(YAML.parse(await readFile(file, 'utf8')).workTypes['short-delivery-two'].spec, { changeImpact: 'off' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function fixture(t, spec) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-default-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Cone Tester', SINGULARITY_FLOW_AGENT_OUTPUT: 'full',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'w.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'a.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'l.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'c.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Cone Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'cone@example.invalid' };
  const run = (command, args, cwd = root) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000), maxBuffer: 1 << 26 });
  const must = (command, args, cwd = root) => {
    const result = run(command, args, cwd);
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const sflow = (...args) => must(process.execPath, [cli, '--no-model', ...args]);
  must('git', ['init', '-q', '-b', 'main', root], base);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'src/value.mjs'), 'export const value = 1;\n');
  sflow('init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const group of Object.values(config.approvalAuthorities)) group.allowAnyGitIdentity = true;
  const { changeImpact: _seeded, ...rest } = config.spec;
  config.spec = { ...rest, ...spec };
  for (const workType of Object.values(config.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Change impact default fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  const workflow = async (id) => JSON.parse(await readFile(path.join(root, 'singularity/work-items', id, 'workflow.json'), 'utf8'));
  const start = (id) => sflow('start', id, '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Change the value', '--description', 'Return 2.');
  // The configuration's change impact settings replaced by `next`, committed on main or left in the working tree.
  const setSpec = async (next, { commit = true } = {}) => {
    if (commit) must('git', ['checkout', '-q', 'main']);
    const current = YAML.parse(await readFile(configPath, 'utf8'));
    const { changeImpact: _old, observedDependencies: _observed, ...kept } = current.spec;
    current.spec = { ...kept, ...next };
    await writeFile(configPath, YAML.stringify(current));
    if (commit) { must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Change the spec setting']); }
  };
  return { root, sflow, run, must, workflow, start, setSpec };
}

test('the default pins change impact on for a new Story; a Story started opted out stays as it was pinned when the setting changes [CIC:REQ-018, REQ-019]',
  slowLane({ timeout: 600_000 }), async (t) => {
    const f = await fixture(t, {});
    f.start('DF-1');
    const on = await f.workflow('DF-1');
    assert.deepEqual([on.resolution.spec.changeImpact, on.resolution.spec.observedDependencies], ['on', 'on'], 'no setting: on, both pinned');
    assert.match(f.sflow('spec', 'dependencies', '--work-id', 'DF-1'), /^DF-1: change impact is on, so observed dependencies are on for this Story\./u);

    // A repository that wrote observed dependencies off before the default: it loads, and its Stories pin change impact off.
    const g = await fixture(t, { observedDependencies: 'off' });
    g.start('DF-2');
    const opted = await g.workflow('DF-2');
    assert.deepEqual([opted.resolution.spec.changeImpact, Object.hasOwn(opted.resolution.spec, 'observedDependencies')], ['off', false]);
    assert.match(g.sflow('spec', 'dependencies', '--work-id', 'DF-2'), /^DF-2: change impact is off \(spec\.changeImpact: off, or spec\.observedDependencies: off\), and observed dependencies are off for this Story\./u);

    // The setting goes back to the default under the running Story: it keeps its pinned policy, byte for byte.
    const before = await readFile(path.join(g.root, 'singularity/work-items/DF-2/workflow.json'), 'utf8');
    await g.setSpec({}, { commit: false });
    g.sflow('status', 'DF-2');
    assert.match(g.sflow('spec', 'dependencies', '--work-id', 'DF-2'), /^DF-2: change impact is off/u);
    assert.equal(await readFile(path.join(g.root, 'singularity/work-items/DF-2/workflow.json'), 'utf8'), before, 'nothing rewrites a pinned policy');
  });
