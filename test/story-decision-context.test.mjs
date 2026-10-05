import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { createWorkflow } from '../src/state.mjs';
import { loadStoryDecisionExecution, storyDecisionArguments } from '../src/story-decision-context.mjs';
import { run } from '../src/util.mjs';

const ID = 'PIN-DECISION';
const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-decision-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: root });
  run('git', ['config', 'user.name', 'Decision Owner'], { cwd: root });
  run('git', ['config', 'user.email', 'decision@example.invalid'], { cwd: root });
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const raw = YAML.parse(await readFile(file, 'utf8'));
  raw.git.publish = 'off';
  for (const authority of Object.values(raw.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(file, YAML.stringify(raw));
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'Initialize decision fixture'], { cwd: root });
  run('git', ['switch', '-q', '-c', ID], { cwd: root });
  const config = await loadDefinition(root);
  await withOperationContext({ operation: { id: 'test.decision', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' }, root, command: 'test' }, () => createWorkflow(root, config, {
    id: ID, title: 'Accepted decision', baseBranch: 'main', workType: 'spec-driven-standard',
    source: { type: 'manual', key: ID, title: 'Accepted decision', description: 'Implement the agreed outcome.', acceptanceCriteria: ['The outcome is verified.'] }
  }));
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'Accept execution snapshot'], { cwd: root });
  return { root, file, raw };
}

test('decision arguments retain explicit and legacy forms with exact accepted phase disambiguation', () => {
  for (const action of ['approve', 'reject']) {
    assert.deepEqual(storyDecisionArguments(['saved-phase'], [action, 'saved-phase'], {}, action),
      { requestedId: undefined, requestedPhase: 'saved-phase', implicitLegacyWorkId: false });
    assert.deepEqual(storyDecisionArguments([], [action, 'saved-phase'], { 'work-id': ID }, action),
      { requestedId: ID, requestedPhase: 'saved-phase', implicitLegacyWorkId: false });
    assert.deepEqual(storyDecisionArguments(['saved-phase'], [action, ID], { phase: 'saved-phase' }, action),
      { requestedId: ID, requestedPhase: 'saved-phase', implicitLegacyWorkId: true });
    assert.deepEqual(storyDecisionArguments([], [action], { 'work-id': ID, phase: 'saved-phase' }, action),
      { requestedId: ID, requestedPhase: 'saved-phase', implicitLegacyWorkId: false });
    assert.throws(() => storyDecisionArguments(['saved-phase'], [action, 'saved-phase'], { phase: 'other' }, action), /two different phases/);
  }
});

test('approve and reject use saved templates and agents even when live resources are unavailable', async (t) => {
  const { root, file, raw } = await fixture(t);
  raw.phases.specification.template = 'unavailable-new-spec.md';
  raw.workTypes['spec-driven-standard'].templateOverrides.specification = 'unavailable-new-spec.md';
  await writeFile(file, YAML.stringify(raw));
  // Also break discovery of the live agent without touching its accepted Git closure.
  await writeFile(path.join(root, '.github/agents/product-owner.agent.md'), '---\ninvalid: [\n');
  const before = run('git', ['status', '--porcelain'], { cwd: root }).stdout;
  for (const action of ['approve', 'reject']) {
    const context = await loadStoryDecisionExecution(root, [action, 'specification'], { 'work-id': ID }, action);
    assert.equal(context.workflow.workItem.id, ID);
    assert.ok(context.executionCatalog.phaseTemplates.specification.text.length > 0);
    assert.doesNotMatch(context.workflow.resolution.templates.specification.path, /unavailable-new-spec/);
    assert.equal(context.definition.agentCatalog.find((agent) => agent.id === 'product-owner').scope, 'workflow-snapshot');
    const result = spawnSync(process.execPath, [cli, action, 'specification', '--work-id', ID, '--json'], {
      cwd: root, encoding: 'utf8', timeout: 30000
    });
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /requires status awaiting_approval.*specification.*in_progress/s);
    assert.doesNotMatch(output, /Template missing|unavailable-new-spec|agent frontmatter/i);
  }
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, before);
});

test('an accepted phase removed from the live catalog is still a phase, not a branch name', async (t) => {
  const { root, file, raw } = await fixture(t);
  // Rename the live phase and all its references. The machine bootstrap stays structurally
  // valid, but only the accepted Story catalog still contains the old phase identity.
  const replacement = YAML.stringify(raw).replaceAll('specification', 'new-scope');
  await writeFile(file, replacement);
  const before = run('git', ['status', '--porcelain'], { cwd: root }).stdout;
  for (const action of ['approve', 'reject']) {
    const context = await loadStoryDecisionExecution(root, [action, 'specification'], {}, action);
    assert.equal(context.requestedId, undefined);
    assert.equal(context.requestedPhase, 'specification');
    assert.ok(context.workflow.phases.specification);
    const result = spawnSync(process.execPath, [cli, action, 'specification', '--json'], {
      cwd: root, encoding: 'utf8', timeout: 30000
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /requires status awaiting_approval.*specification.*in_progress/s);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: root }).stdout.trim(), ID);
  }
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, before);
});

test('explicit and legacy target selection check out only the existing Story and then load its accepted resources', async (t) => {
  const { root, file, raw } = await fixture(t);
  raw.workTypes['spec-driven-standard'].templateOverrides.specification = 'unavailable-new-spec.md';
  await writeFile(file, YAML.stringify(raw));
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-q', '-m', 'Refresh target authoring resources'], { cwd: root });
  for (const [positionals, options] of [
    [['approve', 'specification'], { 'work-id': ID }],
    [['reject', ID], { phase: 'specification' }],
    [['approve', ID], {}]
  ]) {
    run('git', ['switch', '-q', 'main'], { cwd: root });
    const context = await loadStoryDecisionExecution(root, positionals, options, positionals[0]);
    assert.equal(context.workflow.workItem.id, ID);
    assert.equal(run('git', ['branch', '--show-current'], { cwd: root }).stdout.trim(), ID);
    assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, '');
  }
  run('git', ['switch', '-q', 'main'], { cwd: root });
  await assert.rejects(loadStoryDecisionExecution(root, ['approve', 'not-a-story'], { phase: 'specification' }, 'approve'),
    /not a configured phase or an available Work ID/);
  assert.equal(run('git', ['branch', '--show-current'], { cwd: root }).stdout.trim(), 'main');
});

test('a corrupted accepted closure pointer is refused, never replaced by live resources', async (t) => {
  const { root } = await fixture(t);
  const context = await loadStoryDecisionExecution(root, ['approve', 'specification'], {}, 'approve');
  const workflow = structuredClone(context.workflow);
  workflow.workflowSnapshot.snapshotHash = `sha256:${'0'.repeat(64)}`;
  await writeFile(path.join(root, 'singularity/work-items', ID, 'workflow.json'), `${JSON.stringify(workflow, null, 2)}\n`);
  const before = run('git', ['status', '--porcelain'], { cwd: root }).stdout;
  for (const action of ['approve', 'reject']) {
    await assert.rejects(loadStoryDecisionExecution(root, [action, 'specification'], {}, action),
      (error) => /WFA_/.test(error.code ?? ''));
  }
  assert.equal(run('git', ['status', '--porcelain'], { cwd: root }).stdout, before);
});
