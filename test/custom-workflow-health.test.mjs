/**
 * The repository's own workflows, checked once by each SFlow version [owner, 2026-11-22: "A way to identify and fix
 * the issues in existing custom workflows"] (src/custom-workflow-health.mjs).
 *
 * - `singularity-flow check` names each custom workflow with a problem, in plain words, with its one fix route; SFlow's
 *   own workflows are never listed.
 * - It is checked again only when SFlow's build or the committed configuration changes; otherwise it is kept.
 * - A Copilot session's start says the same, from what was kept, so the person hears it before a Story meets it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { customWorkflowHealth, fixRoute, healthWords } from '../src/custom-workflow-health.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Health Tester' };

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** A repository with SFlow's workflows and one of the team's own: a code step with nothing before it that plans or scopes it. */
async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-health-'));
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Health Tester'], ['config', 'user.email', 'health@example.com']]) run('git', args, root);
  await writeFile(path.join(root, 'README.md'), '# Health\n');
  run(process.execPath, [bin, 'init'], root);
  const file = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(file, 'utf8'));
  config.workTypes['team-solo'] = { label: 'Team solo', description: 'The team\'s one-step change.', phases: ['implementation', 'verification'] };
  await writeFile(file, YAML.stringify(config));
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'team workflow'], root);
  return root;
}

test('the words and the route: each custom workflow with a problem, what it is, and how to fix it', () => {
  assert.deepEqual(fixRoute('team-solo'), { copilot: '/sf-fix-workflow team-solo', shell: 'singularity-flow workflow fix team-solo' });
  assert.equal(healthWords({ attention: [] }), null);
  const words = healthWords({ attention: [{ id: 'team-solo', label: 'Team solo', problems: 2, warnings: 1,
    findings: [{ code: 'CHECK_PLANNED_CLAIMS', severity: 'problem', title: 'A code step has no requirements step before it' }], fix: fixRoute('team-solo') }] });
  assert.equal(words, 'This SFlow found a custom workflow to fix before a Story meets it:\n'
    + 'Team solo (team-solo): 2 problems and 1 warning, for example "A code step has no requirements step before it". '
    + 'Fix: /sf-fix-workflow team-solo (or in your terminal: singularity-flow workflow fix team-solo).');
});

test('singularity-flow check names the custom workflow, never SFlow\'s own, and keeps the result until the build or configuration changes', async () => {
  const root = await repository();
  try {
    const started = Date.now();
    const first = JSON.parse(run(process.execPath, [bin, 'check', '--json'], root));
    const seconds = (Date.now() - started) / 1000;
    const data = first.data ?? first;
    const custom = data.customWorkflows;
    assert.ok(custom, JSON.stringify(Object.keys(data)));
    assert.equal(custom.source, 'fresh');
    assert.equal(custom.workflows, 1, 'only the team\'s own workflow is checked, never one SFlow ships');
    assert.deepEqual(custom.attention.map((entry) => entry.id), ['team-solo']);
    const [solo] = custom.attention;
    assert.ok(solo.problems >= 1, JSON.stringify(solo));
    assert.equal(solo.findings[0].severity, 'problem');
    assert.deepEqual(solo.fix, fixRoute('team-solo'));
    const next = (first.next ?? []).find((entry) => entry.id === 'custom-workflow.fix.team-solo');
    assert.ok(next, JSON.stringify(first.next));
    assert.match(next.label, /^Fix workflow Team solo: \d+ problems?/u);
    assert.equal(next.command, 'singularity-flow workflow fix team-solo');
    assert.ok(seconds < 60, `the check took ${seconds} s`);

    // A Copilot session's start says it to the person once, from what was kept.
    const [{ sessionStartAgentHook }, { loadDefinition }] = await Promise.all([import('../src/agent-hooks.mjs'), import('../src/config.mjs')]);
    const start = await sessionStartAgentHook(root, await loadDefinition(root), null, { sessionId: 'health-session', source: 'startup' });
    assert.match(start.additionalContext, /Tell the person this once, in plain words, before other work, and offer the fix; never fix it yourself without their yes: This SFlow found a custom workflow to fix before a Story meets it: Team solo \(team-solo\): /u);
    assert.match(start.additionalContext, /Fix: \/sf-fix-workflow team-solo \(or in your terminal: singularity-flow workflow fix team-solo\)\.$/u);

    // The same build and configuration: kept, not checked again.
    const again = JSON.parse(run(process.execPath, [bin, 'check', '--json'], root));
    assert.equal((again.data ?? again).customWorkflows.source, 'kept');
    // The team changes the workflow (a requirements step before the code): it is checked again, with what is left now.
    const file = path.join(root, 'singularity/workflow.yml');
    const config = YAML.parse(await readFile(file, 'utf8'));
    config.workTypes['team-solo'].phases = ['requirements', 'implementation', 'verification'];
    await writeFile(file, YAML.stringify(config));
    run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'requirements first'], root);
    const changed = await customWorkflowHealth(root);
    assert.equal(changed.source, 'fresh');
    assert.notDeepEqual(changed.attention.find((entry) => entry.id === 'team-solo')?.findings, solo.findings);
    // Once nothing is wrong, nothing is said.
    assert.equal(healthWords({ attention: [] }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a repository with only SFlow\'s own workflows has nothing to fix, and a check that cannot run says nothing', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-health-shipped-'));
  try {
    run('git', ['init', '-b', 'main'], root);
    assert.equal(await customWorkflowHealth(root, { refresh: true }), null, 'no SFlow configuration: nothing to say');
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    await writeFile(path.join(root, 'singularity', 'workflow.yml'), YAML.stringify({ version: 4, workTypes: { feature: { phases: ['intake'] } } }));
    // Only SFlow's own workflows: nothing is checked at all.
    let asked = null;
    const shipped = await customWorkflowHealth(root, { refresh: true, check: async (_at, ids) => { asked = ids; return { configuration: { valid: true }, workflows: [] }; } });
    assert.deepEqual([asked, shipped.workflows, shipped.attention], [[], [], []]);
    assert.equal(await customWorkflowHealth(root, { refresh: true, check: async () => { throw new Error('no configuration'); } }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
