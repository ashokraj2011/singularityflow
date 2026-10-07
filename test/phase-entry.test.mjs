import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { setAgentSession, restoreAgentSession } from '../src/session.mjs';
import { resolveOperation, operationCatalog } from '../src/command-registry.mjs';
import { phaseAgentResult } from '../src/phase-agent-result.mjs';
import { validatePhaseEntryRequest } from '../src/commands/phase.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin/singularity-flow.mjs');
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-phase-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-qb', 'main');
  git(root, 'config', 'user.name', 'Phase Entry Tester');
  git(root, 'config', 'user.email', 'entry@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Entry fixture\n');
  await initializeDefinition(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const source = YAML.parse(await readFile(file, 'utf8'));
  source.workItemRoot = 'team/stories';
  source.session.workItemSelection = 'reuse';
  await writeFile(file, YAML.stringify(source));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture authority');
  git(root, 'switch', '-c', 'ENTRY-1');
  const config = await loadConfig(root);
  const resolved = resolveWorkType(config, 'spec-driven-standard');
  const workflow = await createWorkflow(root, config, {
    id: 'ENTRY-1', title: 'Bundle verified phase context', baseBranch: 'main',
    workType: 'spec-driven-standard', agent: 'product-owner', resolved,
    source: { type: 'manual', key: 'ENTRY-1', title: 'Bundle verified phase context',
      description: 'Preserve phase checks while reducing repeated tool calls.',
      acceptanceCriteria: ['The phase entry operation never advances the Story.'] }
  });
  await setAgentSession(root, config, { name: 'Phase Entry Tester', email: 'entry@example.invalid' },
    workflow.phases[workflow.currentPhase].defaultAgent, 'ENTRY-1', {
      phaseId: workflow.currentPhase, source: 'test'
    });
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'accepted Story closure');
  const env = { ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(root, '.git/mode-not-set.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.git/no-workspace.json'),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.git/no-registry.json') };
  const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000
  });
  return { root, workflow, config, invoke };
}

test('phase entry is a model-free read; composition is an explicit registered mutation', () => {
  for (const compose of [false, true]) {
    const operation = resolveOperation({ requestedCommand: 'phase', positionals: ['phase', 'enter'], options: { compose } });
    assert.equal(operation.id, compose ? 'phase.enter.compose' : 'phase.enter');
    assert.equal(operation.modelPolicy, 'never');
    assert.equal(operation.classification, compose ? 'mutation' : 'read');
    assert.deepEqual(operationCatalog().find(entry => entry.id === operation.id), operation);
  }
  assert.throws(() => validatePhaseEntryRequest({ positionals: ['phase', 'enter'],
    options: { 'allow-dirty': true } }), { code: 'PHASE_ENTRY_OPTIONS_INVALID' });
  assert.throws(() => validatePhaseEntryRequest({ positionals: ['phase', 'enter'],
    options: { compose: 'false' } }), /boolean flag/);
});

test('entry bundles a custom-root Story without changing files, HEAD, index or lifecycle', async t => {
  const item = await fixture(t);
  const before = { head: git(item.root, 'rev-parse', 'HEAD'), status: git(item.root, 'status', '--porcelain=v1'),
    workflow: await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8') };
  const result = item.invoke('phase', 'enter', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entry = JSON.parse(result.stdout);
  assert.equal(entry.resultType, 'sflow-phase-entry');
  assert.equal(entry.ready, true);
  assert.equal(entry.workId, 'ENTRY-1');
  assert.equal(entry.workItemRoot, 'team/stories');
  assert.equal(entry.repositoryPath, git(item.root, 'rev-parse', '--show-toplevel'));
  assert.equal(entry.phase, item.workflow.currentPhase);
  assert.equal(entry.phaseAgent.valid, true);
  assert.equal(entry.context, null);
  assert.equal(entry.contextComposition, 'not-requested');
  assert.equal(entry.modelInvocations, 0);
  assert.equal(entry.effects.testsRun, false);
  assert.equal(entry.effects.storyAdvanced, false);
  assert.ok(entry.recovery.planId);
  assert.ok(entry.authoring.policyVerified);
  assert.equal(entry.references.status, 'not-configured');
  assert.ok(['off', 'when-needed', 'required'].includes(entry.clarification.mode));
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), before.head);
  assert.equal(git(item.root, 'status', '--porcelain=v1'), before.status);
  assert.equal(await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8'), before.workflow);
});

test('entry never interprets an explicit other Story or historical phase as selection', async t => {
  const item = await fixture(t);
  for (const [args, code] of [
    [['phase', 'enter', '--work-id', 'OTHER-1', '--compose', '--json'], 'ACTIVE_SUBJECT_MISMATCH'],
    [['phase', 'enter', 'release', '--compose', '--json'], 'PHASE_DRAFT_NOT_ACTIVE']
  ]) {
    const result = item.invoke(...args);
    assert.notEqual(result.status, 0);
    const refusal = JSON.parse(result.stdout);
    assert.equal(refusal.error.code, code, result.stderr || result.stdout);
  }
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('a missing session only returns its verified attach route, never composes context', async t => {
  const item = await fixture(t);
  await restoreAgentSession(item.root, null);
  const result = item.invoke('phase', 'enter', '--compose', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entry = JSON.parse(result.stdout);
  assert.equal(entry.status, 'binding-required');
  assert.equal(entry.ready, false);
  assert.equal(entry.authoringAllowed, false);
  assert.equal(entry.context, null);
  assert.equal(entry.phaseAgent.valid, false);
  assert.equal(entry.phaseAgent.reason, 'active-session-missing');
  assert.deepEqual(entry.next, [entry.phaseAgent.handoff]);
  assert.equal(entry.next[0].command, 'singularity-flow session attach ENTRY-1 --json');
  assert.equal(entry.next[0].copilotCommand, '/sf-session');
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('manual worktree review prevents composition while preserving changes and exact actions', async t => {
  const item = await fixture(t);
  await writeFile(path.join(item.root, 'README.md'), '# Unrelated native work\n');
  const result = item.invoke('phase', 'enter', '--compose', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entry = JSON.parse(result.stdout);
  assert.equal(entry.authoringAllowed, false);
  assert.equal(entry.context, null);
  assert.equal(entry.contextComposition, 'not-admitted');
  assert.ok(entry.recovery.actions.some(action => action.id === 'working-tree' && action.confirmation === 'human-authority'));
  assert.equal(await readFile(path.join(item.root, 'README.md'), 'utf8'), '# Unrelated native work\n');
});

test('explicit entry composition returns the governed prompt once and reuses immutable bytes', async t => {
  const item = await fixture(t);
  const before = git(item.root, 'rev-parse', 'HEAD');
  const result = item.invoke('phase', 'enter', '--compose', '--for-agent', '--json');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const entry = JSON.parse(result.stdout);
  assert.equal(entry.contextComposition, 'delivered', JSON.stringify(entry.recovery));
  assert.match(entry.context.text, /Bundle verified phase context/);
  const promptPath = path.join(item.root, 'team/stories/ENTRY-1/context/prompts', `${entry.phase}-gen1.md`);
  const initial = await readFile(promptPath, 'utf8');
  const again = item.invoke('phase', 'enter', '--compose', '--for-agent', '--json');
  assert.equal(again.status, 0, again.stderr || again.stdout);
  const reused = JSON.parse(again.stdout);
  assert.equal(reused.contextComposition, 'delivered', JSON.stringify(reused.recovery));
  assert.equal(reused.context.text, entry.context.text);
  assert.equal(await readFile(promptPath, 'utf8'), initial);
  assert.match(again.stderr, /Grounding composition reused/);
  assert.equal(git(item.root, 'rev-parse', 'HEAD'), before);
  const workflow = JSON.parse(await readFile(path.join(item.root, 'team/stories/ENTRY-1/workflow.json'), 'utf8'));
  assert.equal(workflow.phases[entry.phase].generation, 0);
  assert.equal(workflow.phases[entry.phase].status, 'in_progress');
  assert.equal(reused.effects.testsRun, false);
});

test('compact checks preserve every finding, risk choice, command guard and fresh-test requirement', () => {
  const full = { resultType: 'sflow-phase-prepublish', phase: 'custom-code', status: 'correction-required',
    artifact: { path: 'team/stories/E/artifacts/code.md', sha256: 'abc', preview: 'x'.repeat(16_000) },
    findings: [{ code: 'scope.outside', message: 'Review the exact extra path.', path: 'src/extra.js' }],
    resolution: { issues: [{ code: 'scope.outside', choices: [{ kind: 'appeal', command: 'review exact packet' }] }] },
    repairLoop: { protocol: { maximumAttempts: 3 } },
    correction: { sameTurn: false, class: 'phase-recovery' },
    commands: { publish: null, next: 'singularity-flow recover E --phase custom-code --json' },
    commandGuidance: { publish: null },
    testExecution: { status: 'not-run', commands: [{ id: 'qualityCommands[0]', argv: null }] },
    coverage: { status: 'incomplete', unclaimed: 1, blocking: true, paths: Array(100).fill('observations') },
    warnings: ['An authority pin is unavailable.'] };
  const compact = phaseAgentResult(full);
  for (const key of ['status', 'findings', 'resolution', 'repairLoop', 'correction', 'commands', 'commandGuidance', 'testExecution', 'warnings']) assert.deepEqual(compact[key], full[key]);
  assert.equal(compact.coverage.blocking, true);
  assert.equal(compact.artifact.sha256, 'abc');
  assert.ok(compact.projection.omitted.includes('artifact.preview'));
  assert.equal(compact.projection.fullCommand, 'singularity-flow phase prepublish custom-code --json');
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length / 4);
  assert.equal(full.artifact.preview.length, 16_000, 'projection cannot mutate kernel results');
});

test('CLI compact prepublish keeps the kernel findings and next actions; full JSON is unchanged', async t => {
  const item = await fixture(t);
  const fullResult = item.invoke('phase', 'prepublish', '--json');
  assert.equal(fullResult.status, 0, fullResult.stderr || fullResult.stdout);
  const full = JSON.parse(fullResult.stdout);
  assert.equal(full.projection, undefined);
  const agentResult = item.invoke('phase', 'prepublish', '--for-agent', '--json');
  assert.equal(agentResult.status, 0, agentResult.stderr || agentResult.stdout);
  const compact = JSON.parse(agentResult.stdout);
  assert.equal(compact.projection.kind, 'agent');
  for (const key of ['status', 'findings', 'advisories', 'commands', 'commandGuidance', 'testExecution', 'correction']) {
    assert.deepEqual(compact[key], full[key], key);
  }
  assert.deepEqual(compact.resolution, full.resolution);
  assert.equal(git(item.root, 'status', '--porcelain=v1'), '');
});

test('all authoring skills use a single prepublish validator pass and entry has one maintained boundary', async () => {
  for (const name of ['code', 'phase', 'design', 'requirements', 'release', 'plan', 'specify', 'verify', 'converge', 'review', 'scenario-check', 'document-intake', 'workflow-rules']) {
    const skill = await readFile(path.join(packageRoot, 'plugin/skills', `sflow-${name}`, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /draft-check[^\n]*(?:then| and )[^\n]*prepublish/);
    assert.match(skill, /phase prepublish .*--for-agent --json/);
    assert.equal([...skill.matchAll(/<!-- sflow-execution-boundary -->/g)].length, 1, name);
    if (['code', 'phase'].includes(name)) {
      assert.match(skill, /phase enter --for-agent --json/);
      assert.doesNotMatch(skill, /singularity-flow (?:pause status|session current|status --json|clarification status|story references verify)/);
    }
  }
});
