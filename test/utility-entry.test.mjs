import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createWarmReadFixture } from '../scripts/warm-read-fixture.mjs';
import { validateUtilityEntry, scopedUtilityRead, withoutUtilityEntry, utilityResult } from '../src/utility-entry.mjs';
import { agentAct } from '../src/agent-output.mjs';
import { readAssetCatalog } from '../src/asset-catalog.mjs';
import { buildStudioModel } from '../src/workflow-studio.mjs';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { withReadScope, inReadScope } from '../src/read-scope.mjs';
import { withCommandTiming } from '../src/dx-timing-context.mjs';
import { loadDefinition } from '../src/config.mjs';
import { withCommandObservability } from '../src/command-observability.mjs';
import { instructionText } from '../src/instruction-library.mjs';
import { librarySkillText, skillAttachmentsText } from '../src/skill-library.mjs';

test('combined utility entry is closed to mutations, effects, ambiguous flags and prototype keys', () => {
  const flags = { json: true, 'for-agent': true, 'utility-entry': true };
  for (const positionals of [['status'], ['status', 'PERF-001'], ['agents', 'status', 'developer'],
    ['workflow', 'list'], ['skill', 'show', 'example'], ['instruction', 'list'], ['nextsteps'],
    ['phase', 'show', 'intake']]) {
    assert.doesNotThrow(() => validateUtilityEntry(positionals, flags));
  }
  for (const [positionals, options] of [
    [['status'], { ...flags, 'submit-if-ready': true }], [['report'], { ...flags, out: 'file' }],
    [['agents', 'sync', 'developer'], flags], [['workflow', 'activate', 'branch'], flags],
    [['instruction', 'edit', 'example'], flags], [['skill', 'show', 'example'], { ...flags, 'work-id': 'other' }],
    [['status'], { ...flags, 'utility-entry': 'false' }], [['status'], { ...flags, json: false }],
    [['__proto__'], flags], [['constructor'], flags], [['status', 'id', 'extra'], flags],
    [['phase', 'enter'], flags], [['inputs'], flags]
  ]) {
    assert.throws(() => validateUtilityEntry(positionals, options), { code: 'UTILITY_ENTRY_REQUEST_INVALID' });
    if (options['utility-entry'] === true && options.json === true) assert.equal(scopedUtilityRead(positionals, options), false);
  }
  assert.deepEqual(withoutUtilityEntry(['status', '--utility-entry', '--', '--utility-entry']),
    ['status', '--', '--utility-entry']);
  assert.doesNotThrow(() => validateUtilityEntry(['inputs', 'intake'], { ...flags, 'dry-run': true }));
  assert.doesNotThrow(() => validateUtilityEntry(['report'], { ...flags, format: 'json' }));
  assert.throws(() => validateUtilityEntry(['report'], flags), { code: 'UTILITY_ENTRY_REQUEST_INVALID' });
  const entry = utilityResult({ repositoryPath: '/fixture', operation: 'status' },
    { resultType: 'sflow-phase-entry', status: 'clarification-required', workId: 'EXAMPLE', phase: 'intake' });
  assert.equal(entry.workId, 'EXAMPLE');
  assert.equal(entry.phase, 'intake');
  assert.deepEqual(agentAct(entry).read, ['data.clarification', 'data.context']);
  assert.equal(utilityResult({ repositoryPath: '/fixture' }, []).workId, undefined);
});

test('utility reads preserve outputs, pause before Git and share only one read invocation', async t => {
  const fixture = await createWarmReadFixture();
  t.after(fixture.cleanup);
  for (const relative of ['singularity/skill-library/example', 'singularity/instruction-library/guide']) {
    await mkdir(path.join(fixture.repository, relative), { recursive: true });
  }
  await writeFile(path.join(fixture.repository, 'singularity/instruction-library/guide/INSTRUCTIONS.md'),
    instructionText({ id: 'guide', description: 'Repository conventions.', instructions: 'Keep keyboard navigation.' }));
  await writeFile(path.join(fixture.repository, 'singularity/skill-library/example/SKILL.md'),
    librarySkillText({ id: 'example', description: 'Verify behavior.', instructions: 'Inspect the result.', instructionRefs: ['guide'] }));
  await writeFile(path.join(fixture.repository, 'singularity/skill-library/attachments.yml'),
    skillAttachmentsText([{ id: 'example', workflow: 'chore', phases: ['intake'], use: 'Check the requested change.' }]));
  const invoke = (args, env = {}) => spawnSync(process.execPath, [fixture.cli, ...args], {
    cwd: fixture.repository, env: { ...fixture.env, SINGULARITY_FLOW_AGENT_OUTPUT: 'full', ...env },
    encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024
  });
  for (const args of [['status', 'PERF-001'], ['nextsteps', 'PERF-001'], ['logs', '--tail', '10'],
    ['progress', 'PERF-001'], ['workflow', 'list', '--for-start'],
    ['agents', 'list'], ['agents', 'mappings'], ['agents', 'status'], ['skill', 'list'], ['instruction', 'list']]) {
    const plain = invoke([...args, '--for-agent', '--json']);
    const combined = invoke([...args, '--utility-entry', '--for-agent', '--json']);
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(combined.status, 0, combined.stderr);
    const entry = JSON.parse(combined.stdout);
    assert.equal(entry.resultType, 'sflow-utility-entry');
    assert.equal(entry.readCompleted, true);
    assert.equal(await realpath(entry.repositoryPath), await realpath(fixture.repository));
    assert.deepEqual(entry.data, JSON.parse(plain.stdout), args.join(' '));
  }
  await writeFile(fixture.env.SINGULARITY_FLOW_COPILOT_MODE_FILE,
    JSON.stringify({ schemaVersion: 1, paused: true }));
  const paused = invoke(['progress', '--utility-entry', '--for-agent', '--json'], { PATH: '' });
  assert.equal(paused.status, 0, paused.stderr);
  assert.equal(JSON.parse(paused.stdout).paused ?? JSON.parse(paused.stdout).data?.paused, true);
  const invalid = invoke(['status', '--submit-if-ready', '--utility-entry', '--for-agent', '--json'], { PATH: '' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stdout + invalid.stderr, /UTILITY_ENTRY_REQUEST_INVALID|allowlisted read/);

  const full = await withApprovedConfigurationRead(fixture.repository, () => buildStudioModel(fixture.repository), { preferAuthority: true });
  const narrow = await withApprovedConfigurationRead(fixture.repository, () => readAssetCatalog(fixture.repository), { preferAuthority: true });
  for (const key of ['skills', 'instructions', 'skillProblems', 'instructionProblems', 'skillAttachmentsPath']) {
    assert.deepEqual(narrow[key], full[key], key);
  }
  const instruction = await withApprovedConfigurationRead(fixture.repository,
    () => readAssetCatalog(fixture.repository, { kind: 'instruction' }), { preferAuthority: true });
  assert.deepEqual(instruction.instructions, full.instructions);
  assert.equal(instruction.agents.length, 0);

  const counters = {};
  const timer = { increment(name, amount) { counters[name] = (counters[name] ?? 0) + amount; },
    async measure(name, fn) { return fn(); } };
  const cwd = process.cwd();
  const canonicalRoot = await realpath(fixture.repository);
  const prior = process.env.SINGULARITY_FLOW_NO_MODEL;
  process.chdir(fixture.repository);
  process.env.SINGULARITY_FLOW_NO_MODEL = '1';
  try {
    await withCommandTiming(timer, () => withReadScope(() =>
      withCommandObservability('progress', ['progress'], {}, async () => {
        assert.equal(inReadScope(), true);
        const first = await loadDefinition(canonicalRoot);
        assert.equal(await loadDefinition(canonicalRoot), first);
      })));
    assert.equal(counters['configuration.definition-load'], 1, 'accounting and handler share the same definition');
    const source = path.join(fixture.repository, 'singularity/workflow.yml');
    const original = await readFile(source, 'utf8');
    await writeFile(source, original.replace('label: Chore', 'label: Changed'));
    assert.equal((await withReadScope(() => loadDefinition(fixture.repository))).workTypes.chore.label, 'Changed',
      'a subsequent invocation sees changed bytes');
    await withCommandObservability('test', [], {}, () => assert.equal(inReadScope(), false,
      'accounting never creates an outer read scope for a writer'));
  } finally {
    process.chdir(cwd);
    if (prior === undefined) delete process.env.SINGULARITY_FLOW_NO_MODEL; else process.env.SINGULARITY_FLOW_NO_MODEL = prior;
  }
});
