import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { validateWorldModelDirectory, verifyGroundingRecord, worldModelRebuildReason, worldModelSourceSnapshot } from '../src/grounding.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function result(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env });
}

function flow(args, cwd, { allowFailure = false, persona = 'product-owner', workType = 'feature' } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Grounding Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ persona, workType })
  };
  const execution = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env });
  if (!allowFailure) assert.equal(execution.status, 0, `${args.join(' ')}\n${execution.stdout}\n${execution.stderr}`);
  return execution;
}

const mockBuilderSource = `
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const prompt = await readFile(process.argv[2], 'utf8');
const packet = prompt.match(/Packet file:\\s+([^\\n]+)/)?.[1].trim();
const assignedView = prompt.match(/Assigned view:\\s+([^\\n]+)/)?.[1].trim();
if (packet) {
  const startedAt = Date.now();
  if (process.env.SFLOW_PARALLEL_TEST_LOG) await appendFile(process.env.SFLOW_PARALLEL_TEST_LOG, JSON.stringify({ event: 'start', view: assignedView, at: startedAt }) + '\\n');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (process.env.SFLOW_MOCK_SKIP_PACKET_VIEW === assignedView) process.exit(0);
  await mkdir(path.dirname(packet), { recursive: true });
  await writeFile(packet, '# ' + assignedView + ' discovery packet\\n\\nObserved ' + assignedView + ' facts at README.md:1.\\n');
  if (process.env.SFLOW_PARALLEL_TEST_LOG) await appendFile(process.env.SFLOW_PARALLEL_TEST_LOG, JSON.stringify({ event: 'end', view: assignedView, at: Date.now() }) + '\\n');
  process.exit(0);
}
const output = prompt.match(/Output directory:\\s+([^\\n]+)/)?.[1].trim();
const requested = prompt.match(/Requested views:\\s+([^\\n]+)/)?.[1].trim().split(/,\\s*/).filter(Boolean) ?? [];
const task = prompt.match(/Optional task:\\s+([^\\n]+)/)?.[1].trim();
if (!output) throw new Error('output directory was not rendered');
if (process.argv.includes('--mutate')) await writeFile(path.join(process.cwd(), 'MUTATED.txt'), 'unexpected');
if (process.env.SFLOW_MOCK_MANIFEST_RETRY_MARKER) {
  try {
    await readFile(process.env.SFLOW_MOCK_MANIFEST_RETRY_MARKER, 'utf8');
  } catch {
    await writeFile(process.env.SFLOW_MOCK_MANIFEST_RETRY_MARKER, 'first synthesis omitted manifest\\n');
    process.exit(0);
  }
}
await mkdir(path.join(output, 'core'), { recursive: true });
await mkdir(path.join(output, 'views'), { recursive: true });
await mkdir(path.join(output, 'evidence'), { recursive: true });
await writeFile(path.join(output, 'core/summary.md'), '# Repository core\\n');
await writeFile(path.join(output, 'core/model.json'), JSON.stringify({ schema_version: '1.0' }));
const views = {};
for (const view of requested.filter((value) => value !== 'core' && value !== 'auto')) {
  await writeFile(path.join(output, 'views', view + '.md'), '# ' + view + '\\n');
  views[view] = { path: 'views/' + view + '.md', generated: true };
}
await writeFile(path.join(output, 'evidence/evidence.jsonl'), JSON.stringify({ id: 'E-1', claim: 'mock evidence' }) + '\\n');
const guides = [];
if (task && task !== 'none') {
  await mkdir(path.join(output, 'task-guides'), { recursive: true });
  await writeFile(path.join(output, 'task-guides/task.md'), '# Exact task guide\\n\\n' + task + '\\n');
  guides.push({ id: 'task', path: 'task-guides/task.md', task });
}
const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
const manifestCommit = process.env.SFLOW_MOCK_SHORT_SHA === '1' ? commit.slice(0, 7) : commit;
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({
  schema_version: '1.0', repository_commit: manifestCommit,
  core: { summary: 'core/summary.md', model: 'core/model.json' },
  views, domains: [], task_guides: guides, evidence: { path: 'evidence/evidence.jsonl' }
}));
`;

test('world-model context combines required phase views, persona views, and persona prompt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'World Model Tester'], root);
  run('git', ['config', 'user.email', 'world@example.com'], root);
  await initializeDefinition(root);
  await writeFile(path.join(root, 'README.md'), '# World model test\n');
  run('git', ['add', 'singularity', 'README.md'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const commit = run('git', ['rev-parse', 'HEAD'], root).trim();

  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git/singularity-flow/session.json'), JSON.stringify({ persona: 'developer', workId: 'WM-1' }));
  await mkdir(path.join(root, 'singularity/world-model/core'), { recursive: true });
  await mkdir(path.join(root, 'singularity/world-model/views'), { recursive: true });
  await mkdir(path.join(root, 'singularity/world-model/evidence'), { recursive: true });
  await writeFile(path.join(root, 'singularity/world-model/core/summary.md'), 'SHARED CORE\n');
  await writeFile(path.join(root, 'singularity/world-model/core/model.json'), JSON.stringify({ schema_version: '1.0' }));
  for (const view of ['architecture', 'security', 'development', 'testing']) {
    await writeFile(path.join(root, `singularity/world-model/views/${view}.md`), `${view.toUpperCase()} VIEW\n`);
  }
  await writeFile(path.join(root, 'singularity/world-model/manifest.json'), JSON.stringify({
    schema_version: '1.0',
    repository_commit: commit,
    core: { summary: 'core/summary.md', model: 'core/model.json' },
    views: Object.fromEntries(['architecture', 'security', 'development', 'testing'].map((view) => [view, { path: `views/${view}.md` }])),
    domains: [], task_guides: [], evidence: { path: 'evidence/evidence.jsonl' }
  }));
  await writeFile(path.join(root, 'singularity/world-model/evidence/evidence.jsonl'), `${JSON.stringify({ id: 'E-1', claim: 'EVIDENCE LEDGER' })}\n`);

  const output = run(process.execPath, [bin, 'wm', 'context', 'design', '--concat'], root);
  assert.match(output, /ARCHITECTURE VIEW/);
  assert.match(output, /SECURITY VIEW/);
  assert.match(output, /DEVELOPMENT VIEW/);
  assert.match(output, /TESTING VIEW/);
  assert.match(output, /Developer persona/);
  assert.match(run(process.execPath, [bin, 'wm', 'context', 'verification', '--concat'], root), /EVIDENCE LEDGER/);
  assert.doesNotMatch(run(process.execPath, [bin, 'wm', 'context', 'design', '--concat', '--no-persona'], root), /Developer persona/);
  assert.doesNotMatch(await readFile(path.join(root, 'singularity/personas/developer.md'), 'utf8'), /architect persona/i);
});

test('wm inject renders matched persona context and records the generation audit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-inject-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Injection Tester'], root);
  run('git', ['config', 'user.email', 'inject@example.com'], root);
  await initializeDefinition(root);
  await writeFile(path.join(root, 'README.md'), '# Injection test\n');
  run('git', ['add', 'singularity', 'README.md'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const commit = run('git', ['rev-parse', 'HEAD'], root).trim();
  run('git', ['switch', '-c', 'WM-1'], root);

  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.worldModel.injection.rules = [{ when: { persona: 'developer', phase: 'design', workType: 'feature' }, include: ['views/development.md'] }];
  await writeFile(definitionPath, YAML.stringify(definition));
  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git/singularity-flow/session.json'), JSON.stringify({ persona: 'developer', workId: 'WM-1' }));
  await mkdir(path.join(root, 'singularity/world-model/core'), { recursive: true });
  await mkdir(path.join(root, 'singularity/world-model/views'), { recursive: true });
  await mkdir(path.join(root, 'singularity/world-model/evidence'), { recursive: true });
  await writeFile(path.join(root, 'singularity/world-model/core/summary.md'), 'SHARED CORE\n');
  await writeFile(path.join(root, 'singularity/world-model/core/model.json'), JSON.stringify({ schema_version: '1.0' }));
  for (const view of ['architecture', 'security', 'development', 'testing']) await writeFile(path.join(root, `singularity/world-model/views/${view}.md`), view === 'development' ? 'INJECTED DEVELOPMENT VIEW\n' : `${view.toUpperCase()} VIEW\n`);
  await writeFile(path.join(root, 'singularity/world-model/evidence/evidence.jsonl'), `${JSON.stringify({ id: 'E-1', claim: 'evidence' })}\n`);
  await writeFile(path.join(root, 'singularity/world-model/manifest.json'), JSON.stringify({
    schema_version: '1.0', repository_commit: commit,
    core: { summary: 'core/summary.md', model: 'core/model.json' },
    views: Object.fromEntries(['architecture', 'security', 'development', 'testing'].map((view) => [view, { path: `views/${view}.md`, generated: true }])),
    domains: [], task_guides: [], evidence: { path: 'evidence/evidence.jsonl' }
  }));
  const sourceState = await worldModelSourceSnapshot(root, definition);
  const manifestPath = path.join(root, 'singularity/world-model/manifest.json');
  const modelManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  modelManifest.source_tree_sha256 = sourceState.sha256;
  await writeFile(manifestPath, JSON.stringify(modelManifest));
  run('git', ['add', 'singularity/workflow.yml', 'singularity/world-model'], root);
  run('git', ['commit', '-m', 'build world model'], root);
  const modelCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  const workDir = path.join(root, 'singularity/work-items/WM-1');
  await mkdir(workDir, { recursive: true });
  await writeFile(path.join(workDir, 'workflow.json'), JSON.stringify({
    workItem: { id: 'WM-1', workType: 'feature' }, currentPhase: 'design',
    resolution: { worldModelGrounding: 'enforce' },
    phases: { design: { id: 'design', status: 'in_progress', generation: 0 } }
  }));
  await writeFile(path.join(workDir, 'source.json'), JSON.stringify({ type: 'manual', labels: [] }));

  const preview = run(process.execPath, [bin, 'wm', 'inject', '--phase', 'design', '--dry-run'], root);
  assert.match(preview, /rules matched: 1/);
  assert.match(preview, /views\/development\.md/);
  const rendered = run(process.execPath, [bin, 'wm', 'compose', '--phase', 'design', '--work-id', 'WM-1', '--render-only'], root);
  assert.match(rendered, /Active Story phase contract/);
  assert.match(rendered, /Work ID: `WM-1`/);
  assert.match(rendered, /Developer persona/);
  assert.match(rendered, /INJECTED DEVELOPMENT VIEW/);
  await assert.rejects(readFile(path.join(workDir, 'context/design-gen1.json'), 'utf8'), /ENOENT/);
  const inspected = run(process.execPath, [bin, 'wm', 'show-prompt', '--phase', 'design', '--work-id', 'WM-1'], root);
  assert.match(inspected, /BEGIN plugin\/skills\/sflow-phase\/SKILL\.md/);
  assert.match(inspected, /# Generate the active phase/);
  assert.match(inspected, /BEGIN GOVERNED PHASE PROMPT/);
  assert.match(inspected, /INJECTED DEVELOPMENT VIEW/);
  assert.match(inspected, /END GOVERNED PHASE PROMPT/);
  await assert.rejects(readFile(path.join(workDir, 'context/design-gen1.json'), 'utf8'), /ENOENT/);
  const unsafeWorkId = result(process.execPath, [bin, 'wm', 'compose', '--phase', 'design', '--work-id', '../../outside', '--render-only'], root);
  assert.equal(unsafeWorkId.status, 1);
  assert.match(unsafeWorkId.stderr, /valid work ID/);
  const prompt = run(process.execPath, [bin, 'wm', 'inject', '--phase', 'design'], root);
  assert.match(prompt, /Developer persona/);
  assert.match(prompt, /INJECTED DEVELOPMENT VIEW/);
  assert.match(prompt, /Repository grounding/);
  const audit = JSON.parse(await readFile(path.join(workDir, 'context/design-gen1.json'), 'utf8'));
  assert.equal(audit.persona, 'developer');
  assert.equal(audit.modelCommit, modelCommit);
  assert.ok(audit.files.some((file) => file.path === 'singularity/world-model/views/development.md'));
  assert.ok(audit.files.some((file) => file.category === 'required'));
  assert.ok(audit.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
  assert.match(audit.renderedSha256, /^[0-9a-f]{64}$/);
  const promptPath = path.join(workDir, 'context/prompts/design-gen1.md');
  assert.ok(await readFile(promptPath, 'utf8'));
  const phase = { id: 'design', generation: 0, worldModel: { views: ['architecture', 'security'] } };
  const verificationWorkflow = { workItem: { id: 'WM-1' }, resolution: { worldModelGrounding: 'enforce' } };
  const verified = await verifyGroundingRecord(root, definition, verificationWorkflow, phase, { persona: 'developer' });
  assert.deepEqual(verified.errors, []);
  await writeFile(promptPath, 'tampered prompt\n');
  assert.match((await verifyGroundingRecord(root, definition, verificationWorkflow, phase, { persona: 'developer' })).errors.join('\n'), /prompt snapshot hash differs/);
});

test('wm build isolates the generator, commits a validated model, and tracks source-tree freshness', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-build-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Builder Tester'], root);
  run('git', ['config', 'user.email', 'builder@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  run(process.execPath, [bin, 'wm', 'init'], root);
  await writeFile(path.join(root, 'README.md'), '# Builder test\n');
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const task = 'Design the evaluation pipeline';
  const output = run(process.execPath, [bin, 'wm', 'build', '--phase', 'design', '--task', task, '--runner', `${process.execPath} ${builder} "{prompt_file}"`], root);
  assert.match(output, /World model built from source/);
  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8'));
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(manifest.source_tree_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(manifest.requested_views, ['architecture', 'security']);
  assert.match(run('git', ['log', '-1', '--format=%s'], root), /^\[world-model\]\[source:[0-9a-f]{12}\] design/);
  assert.match(run(process.execPath, [bin, 'wm', 'check'], root), /fresh:/);
  assert.match(run(process.execPath, [bin, 'wm', 'context', 'design', '--task', task, '--concat'], root), /Exact task guide/);

  await mkdir(path.join(root, 'singularity/work-items/BUILD-1'), { recursive: true });
  await writeFile(path.join(root, 'singularity/work-items/BUILD-1/workflow.json'), '{}\n');
  run('git', ['add', 'singularity/work-items'], root);
  run('git', ['commit', '-m', 'lifecycle state only'], root);
  assert.match(run(process.execPath, [bin, 'wm', 'check'], root), /fresh:/);

  await writeFile(path.join(root, 'README.md'), '# Builder test changed\n');
  const stale = result(process.execPath, [bin, 'wm', 'check'], root);
  assert.equal(stale.status, 2);
  assert.match(`${stale.stdout}${stale.stderr}`, /World model is stale/);
});

test('wm build discovers requested views concurrently and synthesizes one validated model', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-parallel-'));
  const activityLog = path.join(os.tmpdir(), `sflow-worldmodel-parallel-${process.pid}-${Date.now()}.jsonl`);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Parallel Model Tester'], root);
  run('git', ['config', 'user.email', 'parallel-model@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  run(process.execPath, [bin, 'wm', 'init'], root);
  await writeFile(path.join(root, 'README.md'), '# Parallel world-model test\n');
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'verification', '--views', 'business', '--parallel', '--workers', '2',
    '--runner', `${process.execPath} ${builder} "{prompt_file}"`
  ], root, { ...process.env, SFLOW_PARALLEL_TEST_LOG: activityLog });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stderr, /4 view workers, up to 2 concurrent/);

  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.generation, {
    parallel: true,
    strategy: 'view',
    max_workers: 2,
    discovery_views: ['business', 'development', 'security', 'testing'],
    degraded_views: []
  });
  const events = (await readFile(activityLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const firstEnd = events.findIndex((event) => event.event === 'end');
  assert.equal(events.slice(0, firstEnd).filter((event) => event.event === 'start').length, 2);
  assert.equal(events.filter((event) => event.event === 'start').length, 4);
  assert.equal(events.filter((event) => event.event === 'end').length, 4);
});

test('wm build falls back to final synthesis when an optional discovery worker omits its packet', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-discovery-fallback-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Discovery Fallback Tester'], root);
  run('git', ['config', 'user.email', 'discovery-fallback@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await writeFile(path.join(root, 'README.md'), '# Discovery fallback test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'design', '--parallel', '--workers', '2',
    '--runner', `${process.execPath} ${builder} "{prompt_file}"`
  ], root, { ...process.env, SFLOW_MOCK_SKIP_PACKET_VIEW: 'architecture' });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stderr, /architecture discovery worker did not create its analysis packet/);
  assert.match(execution.stderr, /final synthesis will inspect this view directly/);
  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.generation.discovery_views, ['security']);
  assert.deepEqual(manifest.generation.degraded_views, ['architecture']);
  assert.ok(manifest.views.architecture);
});

test('wm build retries final synthesis once when the builder omits manifest.json', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-synthesis-retry-'));
  const marker = path.join(os.tmpdir(), `sflow-worldmodel-synthesis-retry-${process.pid}-${Date.now()}.txt`);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Synthesis Retry Tester'], root);
  run('git', ['config', 'user.email', 'synthesis-retry@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await writeFile(path.join(root, 'README.md'), '# Synthesis retry test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'intake', '--no-parallel',
    '--runner', `${process.execPath} ${builder} "{prompt_file}"`
  ], root, { ...process.env, SFLOW_MOCK_MANIFEST_RETRY_MARKER: marker });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stderr, /did not create manifest\.json; retrying final synthesis once/);
  assert.ok(JSON.parse(await readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8')));
});

test('wm build replaces a model-supplied short commit with CLI-owned full provenance before validation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-short-sha-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Manifest Provenance Tester'], root);
  run('git', ['config', 'user.email', 'manifest-provenance@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  run(process.execPath, [bin, 'wm', 'init'], root);
  await writeFile(path.join(root, 'README.md'), '# Manifest provenance test\n');
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim();

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'requirements', '--no-parallel',
    '--runner', `${process.execPath} ${builder} "{prompt_file}"`
  ], root, { ...process.env, SFLOW_MOCK_SHORT_SHA: '1' });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);

  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8'));
  assert.equal(manifest.repository_commit, sourceCommit);
  assert.match(manifest.repository_commit, /^[0-9a-f]{40}$/);
});

test('wm build targets an existing branch without a work item or switching the active checkout', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-branch-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Branch Model Tester'], root);
  run('git', ['config', 'user.email', 'branch-model@example.com'], root);
  await initializeDefinition(root);
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await writeFile(path.join(root, 'README.md'), '# Main branch\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  run('git', ['switch', '-c', 'release/2026.07'], root);
  await writeFile(path.join(root, 'README.md'), '# Release branch\n');
  run('git', ['add', 'README.md'], root);
  run('git', ['commit', '-m', 'release source'], root);
  run('git', ['switch', 'main'], root);

  const mainBefore = run('git', ['rev-parse', 'HEAD'], root).trim();
  const releaseBefore = run('git', ['rev-parse', 'release/2026.07'], root).trim();
  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--branch', 'release/2026.07', '--local',
    '--phase', 'design', '--task', 'Ground the release',
    '--runner', `${process.execPath} ${builder} "{prompt_file}"`
  ], root);
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stderr, /World-model target: release\/2026\.07 .*active checkout unchanged/);
  assert.equal(run('git', ['branch', '--show-current'], root).trim(), 'main');
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).trim(), mainBefore);
  assert.notEqual(run('git', ['rev-parse', 'release/2026.07'], root).trim(), releaseBefore);
  assert.equal(result('git', ['cat-file', '-e', 'main:singularity/world-model/manifest.json'], root).status, 128);

  const manifest = JSON.parse(run('git', ['show', 'release/2026.07:singularity/world-model/manifest.json'], root));
  assert.equal(manifest.repository_branch, 'release/2026.07');
  assert.equal(manifest.generated_for_phase, 'design');
  assert.match(run('git', ['log', '-1', '--format=%s', 'release/2026.07'], root), /^\[world-model\]/);

  const checked = result(process.execPath, [bin, 'wm', 'check', '--branch', 'release/2026.07'], root);
  assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
  assert.match(checked.stdout, /fresh:/);
  assert.equal(run('git', ['branch', '--show-current'], root).trim(), 'main');

  const missing = result(process.execPath, [bin, 'wm', 'check', '--branch', 'missing/model'], root);
  assert.notEqual(missing.status, 0);
  assert.match(`${missing.stdout}${missing.stderr}`, /does not exist locally or on origin/);
});

test('wm build discovers and models a remote-only branch without creating governed work state', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-remote-branch-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'repository');
  run('git', ['init', '--bare', '-b', 'main', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  run('git', ['config', 'user.name', 'Remote Branch Tester'], root);
  run('git', ['config', 'user.email', 'remote-branch@example.com'], root);
  await initializeDefinition(root);
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await writeFile(path.join(root, 'README.md'), '# Main\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  run('git', ['switch', '-c', 'remote/model'], root);
  await writeFile(path.join(root, 'README.md'), '# Remote model branch\n');
  run('git', ['add', 'README.md'], root);
  run('git', ['commit', '-m', 'remote source'], root);
  run('git', ['push', '-u', 'origin', 'remote/model'], root);
  run('git', ['switch', 'main'], root);
  run('git', ['branch', '--delete', '--force', 'remote/model'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--branch', 'remote/model', '--local',
    '--runner', `${process.execPath} ${builder} "{prompt_file}"`
  ], root);
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.equal(run('git', ['branch', '--show-current'], root).trim(), 'main');
  assert.equal(result('git', ['show-ref', '--verify', '--quiet', 'refs/heads/remote/model'], root).status, 0);
  const manifest = JSON.parse(run('git', ['show', 'remote/model:singularity/world-model/manifest.json'], root));
  assert.equal(manifest.repository_branch, 'remote/model');
  assert.equal(result('git', ['show-ref', '--verify', '--quiet', 'refs/heads/remote/model'], root).status, 0);
  assert.equal(result('git', ['ls-tree', '-r', '--name-only', 'remote/model', '--', 'singularity/work-items'], root).stdout.trim(), '');
});

test('world-model v2 manifests accept brief tiers and the path index', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-v2-'));
  await mkdir(path.join(directory, 'core'), { recursive: true });
  await mkdir(path.join(directory, 'views'), { recursive: true });
  await mkdir(path.join(directory, 'index'), { recursive: true });
  await mkdir(path.join(directory, 'evidence'), { recursive: true });
  await writeFile(path.join(directory, 'core/summary.brief.md'), '# Core brief\n');
  await writeFile(path.join(directory, 'core/summary.md'), '# Core summary\n');
  await writeFile(path.join(directory, 'core/model.json'), '{}\n');
  await writeFile(path.join(directory, 'views/architecture.brief.md'), '# Architecture brief\n');
  await writeFile(path.join(directory, 'views/architecture.md'), '# Architecture\n');
  await writeFile(path.join(directory, 'index/path-map.json'), '{}\n');
  await writeFile(path.join(directory, 'evidence/evidence.jsonl'), '{"id":"E-1"}\n');
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    schema_version: '2.0',
    generated_at: '2026-07-25T12:00:00.000Z',
    generated_date: '25 July 2026',
    builder_version: '2.0',
    builder_prompt_sha256: 'a'.repeat(64),
    analysis_depth: 'standard',
    repository_commit: 'b'.repeat(40),
    repository_branch: 'main',
    working_tree_clean: true,
    core: { brief: 'core/summary.brief.md', summary: 'core/summary.md', model: 'core/model.json' },
    path_index: { path: 'index/path-map.json' },
    views: { architecture: { path: 'views/architecture.md', brief_path: 'views/architecture.brief.md', generated: true } },
    domains: [], task_guides: [], evidence: { path: 'evidence/evidence.jsonl' }
  }));
  const validated = await validateWorldModelDirectory(directory);
  assert.equal(validated.manifest.schema_version, '2.0');
  assert.ok(validated.registered.includes('index/path-map.json'));
  assert.ok(validated.registered.includes('views/architecture.brief.md'));
});

test('wm build rejects generator writes outside the isolated output', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-isolation-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Isolation Tester'], root);
  run('git', ['config', 'user.email', 'isolation@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  run(process.execPath, [bin, 'wm', 'init'], root);
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const attempted = result(process.execPath, [bin, 'wm', 'build', '--phase', 'design', '--runner', `${process.execPath} ${builder} "{prompt_file}" --mutate`], root);
  assert.notEqual(attempted.status, 0);
  assert.match(`${attempted.stdout}${attempted.stderr}`, /modified files outside its isolated output directory: MUTATED\.txt/);
  assert.equal(result('git', ['status', '--porcelain'], root).stdout, '');
});

test('enforced workflows block generation until the governed prompt is composed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-gate-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Grounding Tester'], root);
  run('git', ['config', 'user.email', 'grounding@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  run(process.execPath, [bin, 'wm', 'init'], root);
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await writeFile(path.join(root, 'README.md'), '# Grounding gate test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const task = 'Capture governed intake';
  run(process.execPath, [bin, 'wm', 'build', '--phase', 'intake', '--task', task, '--runner', `${process.execPath} ${builder} "{prompt_file}"`], root);

  flow(['start', 'GROUND-1', '--title', 'Grounded work'], root);
  const workflowPath = path.join(root, 'singularity/work-items/GROUND-1/workflow.json');
  const workflow = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(workflow.resolution.worldModelGrounding, 'enforce');
  const artifactPath = path.join(root, 'singularity/work-items/GROUND-1', workflow.phases.intake.requiredArtifact.path);
  const artifact = (await readFile(artifactPath, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete governed intake evidence with measurable scope and acceptance details.');
  await writeFile(artifactPath, `${artifact}\nAdditional observed repository evidence and constraints are recorded here.\n`);
  assert.match(flow(['nextsteps'], root).stdout, /wm compose --phase intake/);
  const blocked = flow(['phase', 'publish', 'intake'], root, { allowFailure: true });
  assert.notEqual(blocked.status, 0);
  assert.match(`${blocked.stdout}${blocked.stderr}`, /grounding composition is missing/);

  flow(['wm', 'compose', '--phase', 'intake', '--task', task], root);
  flow(['phase', 'publish', 'intake'], root);
  const published = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(published.phases.intake.generation, 1);
  assert.match(run('git', ['log', '-1', '--format=%s'], root), /^\[GROUND-1\]\[phase:intake\]\[generated:1\]/);
});

test('wm build --local commits the world model but does not push, and a new branch inherits it', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-wm-local-'));
  const remote = path.join(base, 'origin.git');
  const root = path.join(base, 'repo');
  run('git', ['init', '--bare', '-b', 'main', remote], base);
  run('git', ['init', '-b', 'main', root], base);
  run('git', ['config', 'user.name', 'Local Tester'], root);
  run('git', ['config', 'user.email', 'local@example.com'], root);
  await initializeDefinition(root);
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await writeFile(path.join(root, 'README.md'), '# Local build\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const remoteMainBefore = run('git', ['ls-remote', remote, 'refs/heads/main'], root).trim();

  // git.publish stays at its default (required); --local must still skip the push.
  const output = run(process.execPath, [bin, 'wm', 'build', '--local', '--phase', 'design', '--task', 'Design it', '--runner', `${process.execPath} ${builder} "{prompt_file}"`], root);
  assert.match(output, /local, not pushed/);

  const localHead = run('git', ['rev-parse', 'HEAD'], root).trim();
  assert.match(run('git', ['log', '-1', '--format=%s'], root), /^\[world-model\]/);
  const remoteMainAfter = run('git', ['ls-remote', remote, 'refs/heads/main'], root).trim();
  assert.equal(remoteMainAfter, remoteMainBefore, 'origin/main must be unchanged (not pushed)');

  // A work-item branch forked from local main inherits the world-model commit.
  run('git', ['switch', '-c', 'FEAT-1'], root);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).trim(), localHead);
  assert.ok(run('git', ['log', '--format=%H', 'main'], root).includes(localHead));
});

test('governed state does not make the world model stale', async () => {
  // The source-tree hash counted singularity/initiatives, so every governed commit — starting an
  // Epic, publishing a phase, recording evidence — changed it and marked the model stale. On a real
  // repository that was 48 of 70 files, so the staleness signal was permanently on and said nothing
  // about the code the model actually describes. Initiative state is per-work governance, exactly
  // like work-item state, which was already excluded.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-stale-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.email', 'wm@example.com'], root);
  run('git', ['config', 'user.name', 'World Model'], root);
  await writeFile(path.join(root, 'README.md'), '# app\n');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/Main.java'), 'class Main {}\n');
  await initializeDefinition(root);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'init'], root);

  const definition = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  const before = await worldModelSourceSnapshot(root, definition);

  // Governed state arrives; the application source is untouched. Starting an Epic writes all of
  // this in one commit: initiative state, the artifact templates, and the persona prompts. On the
  // rule-engine repository the templates alone were 22 files, so a model built minutes earlier was
  // reported stale before a line of the application had changed.
  await mkdir(path.join(root, 'singularity/initiatives/EPIC-1/artifacts'), { recursive: true });
  await writeFile(path.join(root, 'singularity/initiatives/EPIC-1/state.json'), '{"currentPhase":"epic-intake"}\n');
  await writeFile(path.join(root, 'singularity/initiatives/EPIC-1/artifacts/requirements.md'), '# REQ\n');
  await mkdir(path.join(root, 'singularity/templates/initiatives/epic'), { recursive: true });
  await writeFile(path.join(root, 'singularity/templates/initiatives/epic/requirements.md'), '# {{work.id}} requirements\n');
  await mkdir(path.join(root, 'singularity/personas'), { recursive: true });
  await writeFile(path.join(root, 'singularity/personas/product-owner.md'), 'Act as Product owner.\n');
  await mkdir(path.join(root, 'singularity/prompts'), { recursive: true });
  await writeFile(path.join(root, 'singularity/prompts/copilot-planning.md'), 'Plan.\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'start epic'], root);

  const after = await worldModelSourceSnapshot(root, definition);
  assert.equal(after.sha256, before.sha256, 'governance material must not change the source-tree hash');
  assert.ok(!after.files.some((file) => String(file.path ?? file).startsWith('singularity/')), 'nothing under the governance root is application source');

  // A real source change still moves it, or the signal would be worthless in the other direction.
  await writeFile(path.join(root, 'src/Main.java'), 'class Main { void go() {} }\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'change source'], root);
  assert.notEqual((await worldModelSourceSnapshot(root, definition)).sha256, before.sha256);
});

test('legacy world-model hashes are accepted when only governed state changed', async () => {
  // Repositories that already generated a model before the source-tree hash stopped counting
  // singularity/ governance files should not be nagged forever. If the model commit and current
  // HEAD differ only by governed state, the model is still valid for application planning.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-legacy-hash-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.email', 'wm@example.com'], root);
  run('git', ['config', 'user.name', 'World Model'], root);
  await writeFile(path.join(root, 'README.md'), '# app\n');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src/Main.java'), 'class Main {}\n');
  await initializeDefinition(root);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'init'], root);
  const definition = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  const modelCommit = run('git', ['rev-parse', 'HEAD'], root).trim();

  await mkdir(path.join(root, 'singularity/world-model'), { recursive: true });
  await writeFile(path.join(root, 'singularity/world-model/manifest.json'), JSON.stringify({
    schema_version: '2.0',
    repository_commit: modelCommit,
    source_tree_sha256: `sha256:${'a'.repeat(64)}`
  }, null, 2));
  run('git', ['add', 'singularity/world-model/manifest.json'], root);
  run('git', ['commit', '-m', 'legacy world model'], root);

  await mkdir(path.join(root, 'singularity/initiatives/EPIC-1/artifacts'), { recursive: true });
  await writeFile(path.join(root, 'singularity/initiatives/EPIC-1/state.json'), '{"currentPhase":"epic-intake"}\n');
  run('git', ['add', 'singularity/initiatives'], root);
  run('git', ['commit', '-m', 'start epic'], root);

  assert.equal(await worldModelRebuildReason(root, definition), null);

  await writeFile(path.join(root, 'README.md'), '# app changed\n');
  assert.match(await worldModelRebuildReason(root, definition), /source changes: README\.md/);
});
