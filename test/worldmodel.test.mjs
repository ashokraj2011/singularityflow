import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { initializeDefinition } from '../src/config.mjs';
import { verifyGroundingRecord, worldModelSourceSnapshot } from '../src/grounding.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function result(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const prompt = await readFile(process.argv[2], 'utf8');
const output = prompt.match(/Output directory:\\s+([^\\n]+)/)?.[1].trim();
const requested = prompt.match(/Requested views:\\s+([^\\n]+)/)?.[1].trim().split(/,\\s*/).filter(Boolean) ?? [];
const task = prompt.match(/Optional task:\\s+([^\\n]+)/)?.[1].trim();
if (!output) throw new Error('output directory was not rendered');
if (process.argv.includes('--mutate')) await writeFile(path.join(process.cwd(), 'MUTATED.txt'), 'unexpected');
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
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({
  schema_version: '1.0', repository_commit: commit,
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
  assert.match(output, /Act as a developer/);
  assert.match(run(process.execPath, [bin, 'wm', 'context', 'verification', '--concat'], root), /EVIDENCE LEDGER/);
  assert.doesNotMatch(run(process.execPath, [bin, 'wm', 'context', 'design', '--concat', '--no-persona'], root), /Act as a developer/);
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
  const prompt = run(process.execPath, [bin, 'wm', 'inject', '--phase', 'design'], root);
  assert.match(prompt, /Act as a developer/);
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
