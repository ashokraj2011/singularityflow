import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { validateWorldModelDirectory, verifyGroundingRecord, worldModelRebuildReason, worldModelSourceSnapshot } from '../src/grounding.mjs';
import { registerReference, resolveReference } from '../src/harness-imports.mjs';
import { publishToStateBranch } from '../src/ledger.mjs';
import { snapshot } from '../src/util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

function result(command, args, cwd, env = process.env) {
  return spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...env, NODE_ENV: 'test' } });
}

function resultAsync(command, args, cwd, env = process.env, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: { ...env, NODE_ENV: 'test' } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function flow(args, cwd, { allowFailure = false, agent = 'product-owner', workType = 'feature' } = {}) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Grounding Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ agent, workType })
  };
  const execution = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env });
  if (!allowFailure) assert.equal(execution.status, 0, `${args.join(' ')}\n${execution.stdout}\n${execution.stderr}`);
  return execution;
}

async function configureMockProvider(root, builder, extraArguments = []) {
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.models = {
    defaultProvider: 'mock-world-model',
    providers: {
      'mock-world-model': {
        type: 'copilot-cli',
        executable: process.execPath,
        arguments: [builder, ...extraArguments]
      }
    }
  };
  await writeFile(definitionPath, YAML.stringify(definition));
}

const mockBuilderSource = `
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const attachmentIndex = process.argv.indexOf('--attachment');
if (attachmentIndex < 0 || !process.argv[attachmentIndex + 1]) throw new Error('prompt attachment was not provided');
const prompt = await readFile(process.argv[attachmentIndex + 1], 'utf8');
const packet = prompt.match(/Packet file:\\s+([^\\n]+)/)?.[1].trim();
const assignedView = prompt.match(/Assigned view:\\s+([^\\n]+)/)?.[1].trim();
if (packet) {
  const startedAt = Date.now();
  if (process.env.SFLOW_PARALLEL_TEST_LOG) await appendFile(process.env.SFLOW_PARALLEL_TEST_LOG, JSON.stringify({ event: 'start', view: assignedView, at: startedAt }) + '\\n');
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (process.env.SFLOW_MOCK_SKIP_ALL_PACKETS === '1' || process.env.SFLOW_MOCK_SKIP_PACKET_VIEW === assignedView) process.exit(0);
  await mkdir(path.dirname(packet), { recursive: true });
  await writeFile(packet, '# ' + assignedView + ' discovery packet\\n\\nObserved ' + assignedView + ' facts at README.md:1.\\n');
  if (process.env.SFLOW_PARALLEL_TEST_LOG) await appendFile(process.env.SFLOW_PARALLEL_TEST_LOG, JSON.stringify({ event: 'end', view: assignedView, at: Date.now() }) + '\\n');
  process.exit(0);
}
if (process.env.SFLOW_MOCK_FAIL_SYNTHESIS === '1') process.exit(9);
if (process.env.SFLOW_PARALLEL_TEST_LOG) {
  await appendFile(process.env.SFLOW_PARALLEL_TEST_LOG, JSON.stringify({ event: 'synthesis', pid: process.pid, at: Date.now() }) + '\\n');
}
if (process.env.SFLOW_MOCK_SYNTHESIS_BARRIER_DIR) {
  await mkdir(process.env.SFLOW_MOCK_SYNTHESIS_BARRIER_DIR, { recursive: true });
  await writeFile(path.join(process.env.SFLOW_MOCK_SYNTHESIS_BARRIER_DIR, String(process.pid)), 'ready\\n');
  const deadline = Date.now() + 10_000;
  while ((await readdir(process.env.SFLOW_MOCK_SYNTHESIS_BARRIER_DIR)).length < 2) {
    if (Date.now() >= deadline) throw new Error('synthesis barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
let directoryView = null;
if (process.env.SFLOW_MOCK_DIRECTORY_VIEW_RETRY_MARKER) {
  try {
    await readFile(process.env.SFLOW_MOCK_DIRECTORY_VIEW_RETRY_MARKER, 'utf8');
  } catch {
    await writeFile(process.env.SFLOW_MOCK_DIRECTORY_VIEW_RETRY_MARKER, 'first synthesis created a directory view\\n');
    directoryView = requested.find((value) => value !== 'core' && value !== 'auto') ?? null;
  }
}
await mkdir(path.join(output, 'core'), { recursive: true });
await mkdir(path.join(output, 'views'), { recursive: true });
await mkdir(path.join(output, 'evidence'), { recursive: true });
await writeFile(path.join(output, 'core/summary.md'), '# Repository core\\n');
await writeFile(path.join(output, 'core/model.json'), JSON.stringify({ schema_version: '1.0' }));
const views = {};
for (const view of requested.filter((value) => value !== 'core' && value !== 'auto')) {
  if (view === directoryView) await mkdir(path.join(output, 'views', view + '.md'), { recursive: true });
  else await writeFile(path.join(output, 'views', view + '.md'), '# ' + view + '\\n');
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

test('a phase gets the views it declared, and the agent prompt, but not the agent’s extra views', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'World Model Tester'], root);
  run('git', ['config', 'user.email', 'world@example.com'], root);
  await initializeDefinition(root);
  await writeFile(path.join(root, 'README.md'), '# World model test\n');
  run('git', ['add', 'singularity', '.github/agents', 'README.md'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const commit = run('git', ['rev-parse', 'HEAD'], root).trim();

  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git/singularity-flow/session.json'), JSON.stringify({ agent: 'developer', workId: 'WM-1' }));
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

  // `design` declares [architecture, security]; the developer agent declares development and
  // testing. The phase stated a requirement, so the agent's list is not added to it — that union was
  // how a phase asking for one view quietly received four, with nothing on screen saying so.
  const output = run(process.execPath, [bin, 'wm', 'context', 'design', '--concat'], root);
  assert.match(output, /ARCHITECTURE VIEW/);
  assert.match(output, /SECURITY VIEW/);
  assert.doesNotMatch(output, /DEVELOPMENT VIEW/, 'the agent must not add views to a phase that declared its own');
  assert.doesNotMatch(output, /TESTING VIEW/);
  assert.match(output, /Developer agent/);
  assert.match(run(process.execPath, [bin, 'wm', 'context', 'verification', '--concat'], root), /EVIDENCE LEDGER/);
  assert.doesNotMatch(run(process.execPath, [bin, 'wm', 'context', 'design', '--concat', '--no-agent'], root), /Developer agent/);
  assert.doesNotMatch(await readFile(path.join(root, '.github/agents/developer.agent.md'), 'utf8'), /architect agent/i);
});

test('wm inject renders matched agent context and records the generation audit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-inject-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Injection Tester'], root);
  run('git', ['config', 'user.email', 'inject@example.com'], root);
  await initializeDefinition(root);
  await writeFile(path.join(root, 'README.md'), '# Injection test\n');
  run('git', ['add', 'singularity', '.github/agents', 'README.md'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const commit = run('git', ['rev-parse', 'HEAD'], root).trim();
  run('git', ['switch', '-c', 'WM-1'], root);

  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.worldModel.injection.rules = [{ when: { agent: 'developer', phase: 'design', workType: 'feature' }, include: ['views/development.md'] }];
  await writeFile(definitionPath, YAML.stringify(definition));
  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git/singularity-flow/session.json'), JSON.stringify({ agent: 'developer', workId: 'WM-1' }));
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
    phases: { design: { id: 'design', status: 'in_progress', generation: 0 } },
    changeRequests: [{
      id: 'CR-007', status: 'open', sourcePhase: 'verification', sourceGeneration: 2,
      targetPhase: 'design', comment: 'Document the timeout and rollback behavior.',
      requestedAt: '2026-08-05T00:00:00.000Z', requestedBy: { name: 'Product reviewer' }
    }]
  }));
  await writeFile(path.join(workDir, 'source.json'), JSON.stringify({ type: 'manual', labels: [] }));

  const preview = run(process.execPath, [bin, 'wm', 'inject', '--phase', 'design', '--dry-run'], root);
  assert.match(preview, /rules matched: 1/);
  assert.match(preview, /views\/development\.md/);
  const rendered = run(process.execPath, [bin, 'wm', 'compose', '--phase', 'design', '--work-id', 'WM-1', '--render-only'], root);
  assert.match(rendered, /Active Story phase contract/);
  assert.match(rendered, /Work ID: `WM-1`/);
  assert.match(rendered, /Developer agent/);
  assert.match(rendered, /INJECTED DEVELOPMENT VIEW/);
  assert.match(rendered, /Open stakeholder change requests/);
  assert.match(rendered, /CR-007/);
  assert.match(rendered, /Document the timeout and rollback behavior/);
  await assert.rejects(readFile(path.join(workDir, 'context/design-gen1.json'), 'utf8'), /ENOENT/);
  const inspected = run(process.execPath, [bin, 'wm', 'show-prompt', '--phase', 'design', '--work-id', 'WM-1'], root);
  assert.match(inspected, /BEGIN plugin\/skills\/sflow-phase\/SKILL\.md/);
  assert.match(inspected, /# Generate the active phase/);
  assert.match(inspected, /BEGIN GOVERNED PHASE PROMPT/);
  assert.match(inspected, /INJECTED DEVELOPMENT VIEW/);
  assert.match(inspected, /END GOVERNED PHASE PROMPT/);
  await assert.rejects(readFile(path.join(workDir, 'context/design-gen1.json'), 'utf8'), /ENOENT/);
  run(process.execPath, [bin, 'prompt-log', 'on'], root);
  run(process.execPath, [bin, 'wm', 'show-prompt', '--phase', 'design', '--work-id', 'WM-1', '--record-audit'], root);
  const promptAuditPath = path.join(root, '.git/singularity-flow/prompt-audit/prompts.jsonl');
  let promptAudits = (await readFile(promptAuditPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(promptAudits.length, 1);
  assert.equal(promptAudits[0].source, 'vscode-governed-handoff');
  assert.equal(promptAudits[0].agent, 'developer');
  assert.equal(promptAudits[0].workId, 'WM-1');
  assert.match(promptAudits[0].prompt, /BEGIN plugin\/skills\/sflow-phase\/SKILL\.md/);
  assert.match(promptAudits[0].prompt, /INJECTED DEVELOPMENT VIEW/);
  run(process.execPath, [bin, 'wm', 'compose', '--phase', 'design', '--work-id', 'WM-1'], root);
  promptAudits = (await readFile(promptAuditPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(promptAudits.length, 2);
  assert.equal(promptAudits[1].source, 'wm-compose');
  assert.match(promptAudits[1].promptSha256, /^[a-f0-9]{64}$/);
  const unsafeWorkId = result(process.execPath, [bin, 'wm', 'compose', '--phase', 'design', '--work-id', '../../outside', '--render-only'], root);
  assert.equal(unsafeWorkId.status, 1);
  assert.match(unsafeWorkId.stderr, /valid work ID/);
  const prompt = run(process.execPath, [bin, 'wm', 'inject', '--phase', 'design'], root);
  assert.match(prompt, /Developer agent/);
  assert.match(prompt, /INJECTED DEVELOPMENT VIEW/);
  assert.match(prompt, /Repository grounding/);
  const audit = JSON.parse(await readFile(path.join(workDir, 'context/design-gen1.json'), 'utf8'));
  assert.equal(audit.agent, 'developer');
  assert.equal(audit.modelCommit, modelCommit);
  assert.ok(audit.files.some((file) => file.path === 'singularity/world-model/views/development.md'));
  assert.ok(audit.files.some((file) => file.category === 'required'));
  assert.ok(audit.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256)));
  assert.match(audit.renderedSha256, /^[0-9a-f]{64}$/);
  const promptPath = path.join(workDir, 'context/prompts/design-gen1.md');
  assert.ok(await readFile(promptPath, 'utf8'));
  const priorArtifact = 'singularity/work-items/WM-1/artifacts/intake/intake.md';
  const priorBytes = Buffer.from('# Approved intake\n\nUse the committed acceptance criteria.\n');
  await mkdir(path.dirname(path.join(root, priorArtifact)), { recursive: true });
  await writeFile(path.join(root, priorArtifact), priorBytes);
  run('git', ['add', priorArtifact], root);
  run('git', ['commit', '-m', 'approve intake fixture'], root);
  const priorCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  const registered = await registerReference(root, {
    repository: { id: 'fixture', origin: null },
    subject: { kind: 'story', id: 'WM-1', branch: 'WM-1', subjectRevision: 1 },
    artifact: { phaseId: 'intake', generation: 1, outputId: 'intake', path: priorArtifact, mediaType: 'text/markdown' },
    revision: {
      commitSha: priorCommit,
      sha256: createHash('sha256').update(priorBytes).digest('hex'),
      bytes: priorBytes.length
    },
    visibility: 'model'
  });
  const resolvedReference = await resolveReference(root, registered.handle);
  const provenancePath = 'singularity/work-items/WM-1/context/design-sources-design-gen1.json';
  await writeFile(path.join(root, provenancePath), JSON.stringify({
    workId: 'WM-1', phase: 'design', generation: 1, sourceSetSha256: 'fixture'
  }));
  const provenance = await snapshot(path.join(root, provenancePath));
  audit.references = [{
    handle: registered.handle, phase: 'intake', path: priorArtifact,
    rawSha256: resolvedReference.source.rawSha256, rawBytes: resolvedReference.source.rawBytes,
    previewSha256: resolvedReference.preview.sha256, previewBytes: resolvedReference.preview.bytes,
    renderer: resolvedReference.renderer, truncated: resolvedReference.truncated
  }];
  audit.files.push({
    path: priorArtifact, sha256: resolvedReference.source.rawSha256,
    bytes: resolvedReference.source.rawBytes, injectedBytes: resolvedReference.preview.bytes,
    truncated: resolvedReference.truncated, category: 'reference', level: null,
    reason: `intake:${registered.handle}`, handle: registered.handle,
    previewSha256: resolvedReference.preview.sha256, previewBytes: resolvedReference.preview.bytes,
    renderer: resolvedReference.renderer
  }, {
    path: provenancePath, sha256: provenance.sha256, bytes: provenance.size,
    injectedBytes: 0, truncated: false, category: 'design-source-provenance', level: 1,
    reason: 'approved source set fixture'
  });
  await writeFile(path.join(workDir, 'context/design-gen1.json'), JSON.stringify(audit));
  const phase = { id: 'design', generation: 0, worldModel: { views: ['architecture', 'security'] } };
  const verificationWorkflow = {
    workItem: { id: 'WM-1' }, currentPhase: 'design', phaseOrder: ['intake', 'design'],
    phases: { intake: { status: 'approved' }, design: { status: 'in_progress', generation: 0 } },
    resolution: {
      worldModelGrounding: 'enforce',
      harnessImports: { mode: 'record', previewTextBytes: 16384, totalEnvelopeBytes: 32768 }
    },
    lineage: { submissions: [{ phase: 'intake', projection: { references: [{ handle: registered.handle, required: true }] } }] }
  };
  const loadedDefinition = await loadDefinition(root);
  const verified = await verifyGroundingRecord(root, loadedDefinition, verificationWorkflow, phase, { agent: 'developer' });
  assert.deepEqual(verified.errors, []);
  await writeFile(promptPath, 'tampered prompt\n');
  assert.match((await verifyGroundingRecord(root, loadedDefinition, verificationWorkflow, phase, { agent: 'developer' })).errors.join('\n'), /prompt snapshot hash differs/);
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
  // This fixture deliberately exercises --local composition. The production default is governed
  // state-branch publication, where a local-only v3 model must not be consumed as shared context.
  definition.worldModel.materialization.publish = 'local';
  await writeFile(definitionPath, YAML.stringify(definition));
  run(process.execPath, [bin, 'wm', 'init'], root);
  await writeFile(path.join(root, 'README.md'), '# Builder test\n');
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await configureMockProvider(root, builder);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const task = 'Design the evaluation pipeline';
  const output = run(process.execPath, [bin, 'wm', 'build', '--phase', 'design', '--task', task], root);
  assert.match(output, /World model built from source/);
  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8'));
  const summary = await readFile(path.join(root, 'singularity/world-model/core/summary.md'), 'utf8');
  assert.match(manifest.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.match(manifest.source_tree_sha256, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(manifest.requested_views, ['architecture', 'security']);
  assert.match(summary, /singularity-flow:repository-facts:start/);
  assert.match(summary, /singularity-flow:repository-facts:end/);
  assert.match(summary, /files: 2/, 'normal model builds include CLI-derived repository facts');
  assert.match(run('git', ['log', '-1', '--format=%s'], root), /^\[world-model\]\[source:[0-9a-f]{12}\] design/);
  assert.match(run(process.execPath, [bin, 'wm', 'check'], root), /fresh:/);
  assert.match(run(process.execPath, [bin, 'wm', 'context', 'design', '--task', task, '--concat'], root), /Exact task guide/);

  // Asking for another ad-hoc guide must recognize the valid shared model as the extension base.
  // The missing guide is a materialization requirement, not an integrity failure that permits the
  // next build to discard the existing repository model.
  const anotherTask = 'Explain a separate deployment concern';
  const explicitAvailability = JSON.parse(run(process.execPath, [
    bin, 'wm', 'availability', '--phase', 'design', '--task', anotherTask, '--json'
  ], root));
  assert.equal(explicitAvailability.ready, false);
  assert.equal(explicitAvailability.taskGuide.status, 'missing');
  assert.match(explicitAvailability.action.reason, /missing explicit task guide/);
  assert.equal(explicitAvailability.extensionBase.source, 'worktree');
  assert.equal(explicitAvailability.candidates.find((candidate) => candidate.source === 'worktree').integrityValid, true);
  assert.ok(explicitAvailability.selections.every((selection) => selection.status === 'ready'));

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

test('wm build refuses a protected application branch before starting the generator', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-protected-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Protected Branch Tester'], root);
  run('git', ['config', 'user.email', 'protected@example.com'], root);
  await initializeDefinition(root);
  const builder = path.join(root, 'should-not-run.mjs');
  const marker = path.join(root, 'generator-ran.txt');
  await writeFile(builder, `import { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(marker)}, 'ran');\n`);
  await writeFile(path.join(root, 'README.md'), '# Protected branch\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const attempted = result(process.execPath, [bin, 'wm', 'build', '--phase', 'design'], root);
  assert.equal(attempted.status, 1);
  assert.match(`${attempted.stdout}${attempted.stderr}`, /cannot run on protected application branch 'main'/);
  assert.equal(existsSync(marker), false, 'the model runner was never started');
  assert.equal(existsSync(path.join(root, 'singularity/world-model')), false, 'no generated output was installed');
});

test('wm build fails before discovery when neither task routing nor a legacy model exists', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-unrouted-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Routing Guard Tester'], root);
  run('git', ['config', 'user.email', 'routing-guard@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  const marker = path.join(root, 'generator-ran.txt');
  const builder = path.join(root, 'should-not-run.mjs');
  await writeFile(builder, `import { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(marker)}, 'ran');\n`);
  await configureMockProvider(root, builder);
  await unlink(path.join(root, 'singularity/modelTiers.yml'));
  await writeFile(path.join(root, 'README.md'), '# Routing guard\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize without routing'], root);

  const attempted = result(process.execPath, [bin, 'wm', 'build', '--phase', 'design'], root);
  assert.equal(attempted.status, 1);
  assert.match(`${attempted.stdout}${attempted.stderr}`, /cannot select a model/);
  assert.equal(existsSync(marker), false, 'the model provider was never started');
  assert.equal(existsSync(path.join(root, '.git/singularity-flow/model-invocations')), false);
});

test('wm build --model records an unrouted caller-named override', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-override-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Routing Override Tester'], root);
  run('git', ['config', 'user.email', 'routing-override@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await configureMockProvider(root, builder);
  await writeFile(path.join(root, 'README.md'), '# Routing override\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'design', '--no-parallel', '--model', 'override-model'
  ], root);
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  const manifest = JSON.parse(await readFile(
    path.join(root, 'singularity/world-model/manifest.json'), 'utf8'
  ));
  assert.equal(manifest.generation.routing.mode, 'caller-named');
  assert.deepEqual(manifest.generation.routing.discovery, []);
  assert.equal(manifest.generation.routing.synthesis.task, null);
  assert.equal(manifest.generation.routing.synthesis.resolved_model, 'override-model');
  assert.equal(manifest.generation.routing.synthesis.reason, 'explicit-model-override');
  const invocationDirectory = path.join(root, '.git/singularity-flow/model-invocations');
  const [invocationFile] = (await readdir(invocationDirectory)).filter((name) => name.endsWith('.json'));
  const invocation = JSON.parse(await readFile(path.join(invocationDirectory, invocationFile), 'utf8'));
  assert.equal(invocation.model, 'override-model');
  assert.equal(invocation.routing, null);
});

test('wm light creates a compact validated repository inventory with zero model tokens', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-light-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Light Model Tester'], root);
  run('git', ['config', 'user.email', 'light-model@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  // This fixture deliberately exercises --local composition. The production default is governed
  // state-branch publication, where a local-only v3 model must not be consumed as shared context.
  definition.worldModel.materialization.publish = 'local';
  await writeFile(definitionPath, YAML.stringify(definition));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'test'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), '# Compact application\n');
  await writeFile(path.join(root, 'src/index.js'), 'export const answer = 42;\n');
  await writeFile(path.join(root, 'test/index.test.js'), 'void 42;\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'compact-application',
    scripts: { test: 'node --test', check: 'node --check src/index.js' },
    dependencies: { yaml: '^2.0.0' }
  }, null, 2));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const task = 'Design the compact application';
  const output = run(process.execPath, [bin, 'wm', 'light', '--phase', 'design', '--task', task, '--local'], root);
  assert.match(output, /built with 0 model tokens/);
  assert.match(output, /semantic analysis: not performed/);

  const modelRoot = path.join(root, 'singularity/world-model');
  const manifest = JSON.parse(await readFile(path.join(modelRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema_version, '3.0');
  assert.equal(manifest.analysis_depth, 'light');
  assert.equal(manifest.generated_for_phase, 'design');
  assert.deepEqual(manifest.generator, { type: 'deterministic-local', model: null, model_tokens: 0 });
  assert.deepEqual(manifest.requested_views, ['architecture', 'security']);
  assert.deepEqual(manifest.views_generated, ['architecture', 'security']);
  assert.equal(manifest.generation.parallel, false);
  assert.equal(manifest.task_guides[0].task, task);
  await validateWorldModelDirectory(modelRoot, {
    expectedTask: task,
    requiredSelections: [
      { kind: 'core', tier: 'brief' },
      { kind: 'view', view: 'architecture', tier: 'brief' },
      { kind: 'view', view: 'security', tier: 'brief' }
    ],
    requireEvidence: true
  });

  const promptContext = run(process.execPath, [bin, 'wm', 'context', 'design', '--depth', 'light', '--task', task, '--concat'], root);
  assert.match(promptContext, /zero model tokens/i);
  assert.match(promptContext, /deterministic repository metadata/i);
  assert.match(run(process.execPath, [bin, 'wm', 'check'], root), /fresh:/);
  assert.match(run('git', ['log', '-1', '--format=%s'], root), /^\[world-model\].*design/);

  const injectedBytes = Buffer.byteLength(await readFile(path.join(modelRoot, manifest.core.tiers.brief.path), 'utf8'))
    + Buffer.byteLength(await readFile(path.join(modelRoot, manifest.views.architecture.tiers.brief.path), 'utf8'))
    + Buffer.byteLength(await readFile(path.join(modelRoot, manifest.views.security.tiers.brief.path), 'utf8'));
  assert.ok(injectedBytes < 12 * 1024, `light prompt context should stay compact, received ${injectedBytes} bytes`);

  const rejected = result(process.execPath, [bin, 'wm', 'light', '--runner', 'copilot'], root);
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stdout}${rejected.stderr}`, /does not use --runner/);

  const depthAlias = run(process.execPath, [bin, '--no-model', 'wm', 'build', '--depth', 'light', '--views', 'development', '--local'], root);
  assert.match(depthAlias, /built with 0 model tokens/);
  assert.equal(
    JSON.parse(await readFile(path.join(modelRoot, 'manifest.json'), 'utf8')).analysis_depth,
    'light'
  );
});

test('wm availability is read-only when required tiers are absent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-availability-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Availability Tester'], root);
  run('git', ['config', 'user.email', 'availability@example.com'], root);
  await initializeDefinition(root);
  await writeFile(path.join(root, 'README.md'), '# Availability test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const beforeHead = run('git', ['rev-parse', 'HEAD'], root).trim();
  const beforeStatus = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], root);
  const beforeRefs = run('git', ['for-each-ref', '--format=%(refname):%(objectname)'], root);

  const checked = flow(['wm', 'availability', '--phase', 'design', '--json'], root);
  const availability = JSON.parse(checked.stdout);
  assert.equal(availability.ready, false);
  assert.equal(availability.status, 'missing');
  assert.match(availability.action.command, /wm ensure --phase design/);
  const status = JSON.parse(flow(['wm', 'status', '--phase', 'design', '--json'], root).stdout);
  assert.equal(status.ready, false);
  assert.equal(status.status, 'missing');
  assert.equal(status.authority, availability.authority);
  assert.equal(run('git', ['rev-parse', 'HEAD'], root).trim(), beforeHead);
  assert.equal(run('git', ['status', '--porcelain=v1', '--untracked-files=all'], root), beforeStatus);
  assert.equal(run('git', ['for-each-ref', '--format=%(refname):%(objectname)'], root), beforeRefs);
  assert.equal(existsSync(path.join(root, 'singularity/world-model')), false);
});

test('availability applies staleness policy independently from grounding mode', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-staleness-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Staleness Tester'], root);
  run('git', ['config', 'user.email', 'staleness@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.worldModel.grounding = 'warn';
  definition.worldModel.staleness = 'warn';
  definition.worldModel.materialization.publish = 'local';
  await writeFile(definitionPath, YAML.stringify(definition));
  await writeFile(path.join(root, 'README.md'), '# Staleness policy\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize staleness fixture'], root);
  flow(['wm', 'light', '--phase', 'design'], root);
  await writeFile(path.join(root, 'README.md'), '# Staleness policy\n\nsource moved\n');
  run('git', ['add', 'README.md'], root);
  run('git', ['commit', '-m', 'move source'], root);

  const setStaleness = async (policy) => {
    const current = YAML.parse(await readFile(definitionPath, 'utf8'));
    current.worldModel.staleness = policy;
    await writeFile(definitionPath, YAML.stringify(current));
  };
  const availability = () => JSON.parse(flow([
    'wm', 'availability', '--phase', 'design', '--depth', 'light', '--json'
  ], root).stdout);

  const warned = availability();
  assert.equal(warned.ready, true);
  assert.equal(warned.status, 'stale');
  assert.equal(warned.staleness.warns, true);

  await setStaleness('fail');
  const failed = availability();
  assert.equal(failed.ready, false);
  assert.equal(failed.staleness.blocks, true);

  await setStaleness('ignore');
  const ignored = availability();
  assert.equal(ignored.ready, true);
  assert.equal(ignored.staleness.ignored, true);
});

test('governed materialization publishes to the orphan state branch when ledger events are disabled', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-governed-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Governed Model Tester'], root);
  run('git', ['config', 'user.email', 'governed-model@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.ledger.enabled = false;
  definition.worldModel.materialization.publish = 'governed';
  await writeFile(definitionPath, YAML.stringify(definition));
  await writeFile(path.join(root, 'README.md'), '# Governed model test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const built = flow(['wm', 'light', '--phase', 'design'], root);
  assert.match(built.stdout, /published to the .*state.* branch/i);
  // `wm light` deliberately materializes the phase's brief tier, so availability must ask for the
  // same exact plan. A standard-depth availability check should continue to report the missing
  // architecture/full selection rather than silently accepting the brief.
  const refreshed = flow(['wm', 'availability', '--phase', 'design', '--depth', 'light', '--json'], root);
  const availability = JSON.parse(refreshed.stdout);
  assert.equal(availability.ready, true);
  assert.equal(availability.source, 'state-branch');
  const configured = YAML.parse(await readFile(definitionPath, 'utf8'));
  const stateBranch = configured.ledger.branch;
  assert.match(
    run('git', ['ls-tree', '-r', '--name-only', stateBranch], root),
    /singularity\/world-model\/manifest\.json/
  );

  // Simulate the old additive publisher leaving a file from an earlier model generation. The next
  // generated publication must make the configured output directory match its manifest-controlled
  // source tree, without requiring an operator to edit the orphan branch by hand.
  await publishToStateBranch(root, configured.ledger, {
    'singularity/world-model/views/obsolete.md': '# obsolete view\n'
  }, 'Simulate an obsolete generated view');
  assert.match(
    run('git', ['ls-tree', '-r', '--name-only', stateBranch], root),
    /singularity\/world-model\/views\/obsolete\.md/
  );
  const rebuilt = flow(['wm', 'light', '--phase', 'design'], root);
  assert.match(rebuilt.stdout, /published to the .*state.* branch/i);
  assert.doesNotMatch(
    run('git', ['ls-tree', '-r', '--name-only', stateBranch], root),
    /singularity\/world-model\/views\/obsolete\.md/
  );
});

test('progressive governed generation preserves earlier views across independent clones', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-cross-clone-'));
  const remote = path.join(base, 'application.git');
  const seed = path.join(base, 'seed');
  run('git', ['init', '-q', '-b', 'main', '--bare', remote], base);
  run('git', ['init', '-q', '-b', 'main', seed], base);
  run('git', ['config', 'user.name', 'Seed User'], seed);
  run('git', ['config', 'user.email', 'seed@example.com'], seed);
  await initializeDefinition(seed);
  const definitionPath = path.join(seed, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.ledger.enabled = false;
  definition.worldModel.materialization.publish = 'governed';
  const builder = path.join(seed, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await configureMockProvider(seed, builder);
  // configureMockProvider rewrites the definition, so apply the materialization choices last.
  const configured = YAML.parse(await readFile(definitionPath, 'utf8'));
  configured.git.publish = 'off';
  configured.ledger.enabled = false;
  configured.worldModel.materialization.publish = 'governed';
  await writeFile(definitionPath, YAML.stringify(configured));
  await writeFile(path.join(seed, 'README.md'), '# Cross-clone progressive model\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '-qm', 'initialize'], seed);
  run('git', ['remote', 'add', 'origin', remote], seed);
  run('git', ['push', '-q', '-u', 'origin', 'main'], seed);

  const clone = (name) => {
    const directory = path.join(base, name);
    run('git', ['clone', '-q', remote, directory], base);
    run('git', ['config', 'user.name', `${name} User`], directory);
    run('git', ['config', 'user.email', `${name}@example.com`], directory);
    return directory;
  };
  const cloneA = clone('clone-a');
  const cloneB = clone('clone-b');
  const providerLog = path.join(base, 'provider.jsonl');

  // Contributor A publishes only Intake's deterministic brief selections.
  const first = flow(['wm', 'light', '--phase', 'intake'], cloneA);
  assert.match(first.stdout, /published to the .*state.* branch/i);
  const firstManifest = JSON.parse(run('git', [
    'show', 'origin/state:singularity/world-model/manifest.json'
  ], cloneA));
  assert.equal(firstManifest.views.business.tiers.brief.status, 'ready');

  // Contributor B cloned before A published. Its build must fetch the state branch, use A's exact
  // same-source snapshot as the extension base, and publish the union rather than replacing it.
  assert.equal(existsSync(path.join(cloneB, 'singularity/world-model')), false);
  const second = result(process.execPath, [bin, 'wm', 'build', '--phase', 'design'], cloneB, {
    ...process.env,
    SFLOW_PARALLEL_TEST_LOG: providerLog
  });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const secondManifest = JSON.parse(run('git', [
    'show', 'origin/state:singularity/world-model/manifest.json'
  ], cloneB));
  assert.equal(secondManifest.views.business.tiers.brief.status, 'ready',
    'the earlier contributor\'s business brief survives');
  assert.equal(secondManifest.views.architecture.tiers.full.status, 'ready',
    'the later contributor adds architecture/full');
  const providerCallsAfterBuild = existsSync(providerLog)
    ? (await readFile(providerLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length
    : 0;
  assert.ok(providerCallsAfterBuild > 0, 'clone B invoked the configured provider');

  // A third contributor consumes both retained selections from the governed branch. Availability
  // is read-only, so no provider call or worktree model is needed.
  const cloneC = clone('clone-c');
  const intake = flow(['wm', 'availability', '--phase', 'intake', '--depth', 'light', '--json'], cloneC);
  const design = flow(['wm', 'availability', '--phase', 'design', '--json'], cloneC);
  assert.equal(JSON.parse(intake.stdout).ready, true);
  assert.equal(JSON.parse(design.stdout).ready, true);
  assert.equal(JSON.parse(design.stdout).authority, 'remote-governed');
  assert.equal(existsSync(path.join(cloneC, 'singularity/world-model')), false);
  const providerCallsAfterAvailability = existsSync(providerLog)
    ? (await readFile(providerLog, 'utf8')).trim().split(/\r?\n/).filter(Boolean).length
    : 0;
  assert.equal(providerCallsAfterAvailability, providerCallsAfterBuild,
    'clone C required zero provider invocations');
});

test('a governed publisher merges a winner that landed before its first publication fetch', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-before-fetch-'));
  const remote = path.join(base, 'application.git');
  const seed = path.join(base, 'seed');
  run('git', ['init', '-q', '-b', 'main', '--bare', remote], base);
  run('git', ['init', '-q', '-b', 'main', seed], base);
  run('git', ['config', 'user.name', 'Seed User'], seed);
  run('git', ['config', 'user.email', 'seed@example.com'], seed);
  await initializeDefinition(seed);
  const builder = path.join(seed, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await configureMockProvider(seed, builder);
  const definitionPath = path.join(seed, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.ledger.enabled = false;
  definition.worldModel.materialization.publish = 'governed';
  await writeFile(definitionPath, YAML.stringify(definition));
  await writeFile(path.join(seed, 'README.md'), '# Winner before fetch\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '-qm', 'initialize'], seed);
  run('git', ['remote', 'add', 'origin', remote], seed);
  run('git', ['push', '-q', '-u', 'origin', 'main'], seed);
  flow(['wm', 'light', '--phase', 'intake'], seed);

  const clone = (name) => {
    const directory = path.join(base, name);
    run('git', ['clone', '-q', remote, directory], base);
    run('git', ['config', 'user.name', `${name} User`], directory);
    run('git', ['config', 'user.email', `${name}@example.com`], directory);
    return directory;
  };
  // Both contributors clone before either focused view is published. Architecture wins before the
  // security publisher performs its first state-branch fetch.
  const cloneA = clone('clone-a');
  const cloneB = clone('clone-b');
  const providerLog = path.join(base, 'provider.jsonl');
  const environment = { ...process.env, SFLOW_PARALLEL_TEST_LOG: providerLog };
  const architecture = result(process.execPath, [
    bin, 'wm', 'build', '--view', 'architecture', '--tier', 'full'
  ], cloneA, environment);
  assert.equal(architecture.status, 0, `${architecture.stdout}\n${architecture.stderr}`);
  const security = result(process.execPath, [
    bin, 'wm', 'build', '--view', 'security', '--tier', 'full'
  ], cloneB, environment);
  assert.equal(security.status, 0, `${security.stdout}\n${security.stderr}`);

  const observer = clone('observer');
  const manifest = JSON.parse(run('git', ['show', 'origin/state:singularity/world-model/manifest.json'], observer));
  assert.equal(manifest.views.architecture.tiers.full.status, 'ready');
  assert.equal(manifest.views.security.tiers.full.status, 'ready');
  const events = (await readFile(providerLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter((event) => event.event === 'synthesis').length, 2,
    'premerging a fetched winner never reinvokes either provider');
});

test('a lease loser refetches and preserves both view fragments without a second provider invocation', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-cas-'));
  const remote = path.join(base, 'application.git');
  const seed = path.join(base, 'seed');
  run('git', ['init', '-q', '-b', 'main', '--bare', remote], base);
  run('git', ['init', '-q', '-b', 'main', seed], base);
  run('git', ['config', 'user.name', 'Seed User'], seed);
  run('git', ['config', 'user.email', 'seed@example.com'], seed);
  await initializeDefinition(seed);
  const builder = path.join(seed, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await configureMockProvider(seed, builder);
  const definitionPath = path.join(seed, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.ledger.enabled = false;
  definition.worldModel.materialization.publish = 'governed';
  await writeFile(definitionPath, YAML.stringify(definition));
  await writeFile(path.join(seed, 'README.md'), '# Concurrent world-model publication\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '-qm', 'initialize'], seed);
  run('git', ['remote', 'add', 'origin', remote], seed);
  run('git', ['push', '-q', '-u', 'origin', 'main'], seed);

  // Establish a common governed base before cloning the two contributors. Their provider calls
  // then finish together and race only the compare-and-swap publication, which is the condition
  // this regression exercises.
  flow(['wm', 'light', '--phase', 'intake'], seed);
  const clone = (name) => {
    const directory = path.join(base, name);
    run('git', ['clone', '-q', remote, directory], base);
    run('git', ['config', 'user.name', `${name} User`], directory);
    run('git', ['config', 'user.email', `${name}@example.com`], directory);
    return directory;
  };
  const cloneA = clone('clone-a');
  const cloneB = clone('clone-b');
  const providerLog = path.join(base, 'provider.jsonl');
  const barrier = path.join(base, 'synthesis-barrier');
  const loserReady = path.join(base, 'loser-ready');
  const releaseLoser = path.join(base, 'release-loser');
  const hookSource = ({ ready = null, waitFor }) => `#!/usr/bin/env node
const fs = require('node:fs');
const input = fs.readFileSync(0, 'utf8');
if (!input.includes('refs/heads/state')) process.exit(0);
${ready ? `fs.writeFileSync(${JSON.stringify(ready)}, 'ready\\n');` : ''}
const deadline = Date.now() + 15000;
while (!fs.existsSync(${JSON.stringify(waitFor)})) {
  if (Date.now() >= deadline) { console.error('state publication hook timed out'); process.exit(1); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
`;
  await writeFile(path.join(cloneA, '.git/hooks/pre-push'), hookSource({ waitFor: loserReady }));
  await chmod(path.join(cloneA, '.git/hooks/pre-push'), 0o755);
  await writeFile(path.join(cloneB, '.git/hooks/pre-push'), hookSource({ ready: loserReady, waitFor: releaseLoser }));
  await chmod(path.join(cloneB, '.git/hooks/pre-push'), 0o755);
  const environment = {
    ...process.env,
    SFLOW_PARALLEL_TEST_LOG: providerLog,
    SFLOW_MOCK_SYNTHESIS_BARRIER_DIR: barrier
  };
  const architecturePromise = resultAsync(
    process.execPath, [bin, 'wm', 'build', '--view', 'architecture', '--tier', 'full'], cloneA, environment
  );
  const securityPromise = resultAsync(
    process.execPath, [bin, 'wm', 'build', '--view', 'security', '--tier', 'full'], cloneB, environment
  );
  const readyDeadline = Date.now() + 15_000;
  while (!existsSync(loserReady)) {
    if (Date.now() >= readyDeadline) throw new Error('lease-loser publication did not reach its pre-push hook');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const architecture = await architecturePromise;
  await writeFile(releaseLoser, 'release\n');
  const security = await securityPromise;
  assert.equal(architecture.status, 0, `${architecture.stdout}\n${architecture.stderr}`);
  assert.equal(security.status, 0, `${security.stdout}\n${security.stderr}`);

  const observer = clone('observer');
  const manifest = JSON.parse(run('git', ['show', 'origin/state:singularity/world-model/manifest.json'], observer));
  assert.equal(manifest.views.business.tiers.brief.status, 'ready');
  assert.equal(manifest.views.architecture.tiers.full.status, 'ready');
  assert.equal(manifest.views.security.tiers.full.status, 'ready');
  const events = (await readFile(providerLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter((event) => event.event === 'synthesis').length, 2,
    'the compare-and-swap loser reuses its validated fragment instead of invoking the provider again');
});

test('governed world-model publication failure fails build and ensure before local installation', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-publish-failure-'));
  const remote = path.join(base, 'application.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  run('git', ['init', '-q', '-b', 'main', '--bare', remote], base);
  run('git', ['init', '-q', '-b', 'main', seed], base);
  run('git', ['config', 'user.name', 'Seed User'], seed);
  run('git', ['config', 'user.email', 'seed@example.com'], seed);
  await initializeDefinition(seed);
  const definitionPath = path.join(seed, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.ledger.enabled = false;
  definition.worldModel.materialization.publish = 'governed';
  await writeFile(definitionPath, YAML.stringify(definition));
  await writeFile(path.join(seed, 'README.md'), '# Publication failure test\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '-qm', 'initialize'], seed);
  run('git', ['remote', 'add', 'origin', remote], seed);
  run('git', ['push', '-q', '-u', 'origin', 'main'], seed);
  run('git', ['clone', '-q', remote, work], base);
  run('git', ['config', 'user.name', 'Work User'], work);
  run('git', ['config', 'user.email', 'work@example.com'], work);

  flow(['wm', 'light', '--phase', 'intake'], work);
  const manifestPath = path.join(work, 'singularity/world-model/manifest.json');
  const installedBeforeFailure = await readFile(manifestPath, 'utf8');
  const remoteBeforeFailure = run('git', ['rev-parse', 'refs/heads/state'], remote).trim();

  // Make the existing model stale, then make the remote reject the governed commit point. A
  // warning followed by local installation would leave this contributor believing it had
  // published grounding that no other clone can observe.
  await writeFile(path.join(work, 'README.md'), '# Publication failure test\n\nchanged source\n');
  run('git', ['add', 'README.md'], work);
  run('git', ['commit', '-qm', 'change source'], work);
  const hook = path.join(remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\necho governed state rejected >&2\nexit 1\n');
  await chmod(hook, 0o755);

  const direct = flow(['wm', 'light', '--phase', 'intake'], work, { allowFailure: true });
  assert.notEqual(direct.status, 0);
  assert.match(`${direct.stdout}\n${direct.stderr}`, /Unable to publish to the state branch/);
  assert.match(`${direct.stdout}\n${direct.stderr}`, /validated snapshot was retained/);
  const recoveryRoot = path.join(work, '.git/singularity-flow/world-model-recovery');
  assert.ok((await readdir(recoveryRoot)).length >= 1, 'the validated generation survives transport failure');
  assert.equal(await readFile(manifestPath, 'utf8'), installedBeforeFailure,
    'failed governed publication does not install a private replacement locally');
  assert.equal(run('git', ['rev-parse', 'refs/heads/state'], remote).trim(), remoteBeforeFailure,
    'the remote governed state remains unchanged');

  const ensured = flow(['wm', 'ensure', '--phase', 'intake', '--depth', 'light'], work, { allowFailure: true });
  assert.notEqual(ensured.status, 0);
  assert.match(`${ensured.stdout}\n${ensured.stderr}`, /Unable to publish to the state branch/);
  assert.equal(await readFile(manifestPath, 'utf8'), installedBeforeFailure,
    'ensure follows the same fail-before-install contract');

  const listed = JSON.parse(flow(['wm', 'recovery', 'list', '--json'], work).stdout);
  assert.ok(listed.recoveries.length >= 2, 'each failed validated publication remains discoverable');
  const retained = listed.recoveries.find((entry) => entry.status === 'pending');
  assert.ok(retained?.id);
  const inspected = JSON.parse(flow(['wm', 'recovery', 'inspect', retained.id, '--json'], work).stdout);
  assert.equal(inspected.sourceHash, retained.sourceHash);
  assert.match(inspected.manifestSha256, /^[a-f0-9]{64}$/);
  const unconfirmed = flow(['wm', 'recovery', 'publish', retained.id, '--confirm', 'wrong'], work, { allowFailure: true });
  assert.notEqual(unconfirmed.status, 0);
  assert.match(`${unconfirmed.stdout}\n${unconfirmed.stderr}`, new RegExp(`--confirm ${retained.id}`));

  await unlink(hook);
  const recovered = JSON.parse(flow([
    'wm', 'recovery', 'publish', retained.id, '--confirm', retained.id, '--json'
  ], work).stdout);
  assert.equal(recovered.providerInvoked, false);
  assert.ok(recovered.state.commit);
  assert.notEqual(await readFile(manifestPath, 'utf8'), installedBeforeFailure,
    'the exact retained generation is installed only after governed publication succeeds');
  const afterRecovery = JSON.parse(flow(['wm', 'recovery', 'inspect', retained.id, '--json'], work).stdout);
  assert.equal(afterRecovery.status, 'published');
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
  await configureMockProvider(root, builder);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'verification', '--views', 'business', '--parallel', '--workers', '2'
  ], root, { ...process.env, SFLOW_PARALLEL_TEST_LOG: activityLog });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stderr, /4 pending view workers, up to 2 concurrent/);

  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8'));
  const {
    routing, rebuild_reason: rebuildReason,
    synthesis_composition: synthesisComposition, ...generation
  } = manifest.generation;
  assert.deepEqual(generation, {
    parallel: true,
    strategy: 'view',
    max_workers: 2,
    discovery_views: ['business', 'development', 'security', 'testing'],
    degraded_views: [],
    resumed_views: [],
    pending_views_at_start: ['business', 'development', 'security', 'testing'],
    requested_mode: 'agentic',
    effective_mode: 'agentic'
  });
  assert.equal(rebuildReason, 'policy-forced');
  assert.deepEqual(synthesisComposition, {
    candidatePacketBytes: 276,
    selectedPacketBytes: 276,
    omittedPacketBytes: 0,
    packetSummaries: 4,
    packetExpansionHandles: 4,
    admissionAssurance: 'estimated',
    safeToEnforce: false,
    maximumSynthesisInputTokens: 24000,
    compositionLimitTokens: 22976,
    recoveryReserveTokens: 1024,
    synthesisOverflow: 'summarize-or-refuse'
  });
  assert.equal(routing.mode, 'task-routed');
  assert.deepEqual(routing.discovery.map((entry) => entry.view), [
    'business', 'development', 'security', 'testing'
  ]);
  assert.ok(routing.discovery.every((entry) => entry.task === 'analyze' && entry.origin === 'generated'));
  assert.equal(routing.synthesis.task, 'reason');
  assert.equal(routing.synthesis.mapping_revision, routing.discovery[0].mapping_revision);
  const invocationDirectory = path.join(root, '.git/singularity-flow/model-invocations');
  const invocationFiles = (await readdir(invocationDirectory)).filter((name) => name.endsWith('.json'));
  const invocations = await Promise.all(invocationFiles.map(async (name) => (
    JSON.parse(await readFile(path.join(invocationDirectory, name), 'utf8'))
  )));
  assert.equal(invocations.filter((entry) => entry.routing?.task === 'analyze').length, 4);
  assert.equal(invocations.filter((entry) => entry.routing?.task === 'reason').length, 1);
  const status = JSON.parse(run(process.execPath, [
    bin, 'wm', 'status', '--phase', 'verification', '--views', 'business', '--json'
  ], root));
  assert.equal(status.generationDiagnostics.routing.synthesis.task, 'reason');
  assert.equal(status.localBuildDiagnostics.availability, 'available');
  assert.equal(status.localBuildDiagnostics.status, 'completed');
  assert.equal(status.localBuildDiagnostics.requestedMode, 'agentic');
  assert.deepEqual(status.localBuildDiagnostics.views.generated, [
    'business', 'development', 'security', 'testing'
  ]);
  assert.ok(status.localBuildDiagnostics.stages.discovery.durationMs >= 0);
  assert.ok(status.localBuildDiagnostics.stages.synthesis.durationMs >= 0);
  assert.ok(status.localBuildDiagnostics.stages.total.durationMs >= 0);
  assert.equal(status.localBuildDiagnostics.invocations.length, 5);
  assert.ok(status.localBuildDiagnostics.invocations.every((entry) => entry.promptBytes > 0));
  assert.deepEqual(
    status.localBuildDiagnostics.invocations.map((entry) => entry.usage.status),
    ['unavailable', 'unavailable', 'unavailable', 'unavailable', 'unavailable']
  );
  const events = (await readFile(activityLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  const firstEnd = events.findIndex((event) => event.event === 'end');
  assert.equal(events.slice(0, firstEnd).filter((event) => event.event === 'start').length, 2);
  assert.equal(events.filter((event) => event.event === 'start').length, 4);
  assert.equal(events.filter((event) => event.event === 'end').length, 4);
});

test('wm build checkpoints completed discovery and resumes only pending views after a failed process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-resume-'));
  const activityLog = path.join(os.tmpdir(), `sflow-worldmodel-resume-${process.pid}-${Date.now()}.jsonl`);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Resume Model Tester'], root);
  run('git', ['config', 'user.email', 'resume-model@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await configureMockProvider(root, builder);
  await writeFile(path.join(root, 'README.md'), '# Resumable world-model test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const args = [
    bin, 'wm', 'build', '--phase', 'design', '--parallel', '--workers', '2'
  ];
  const first = result(process.execPath, args, root, {
    ...process.env,
    SFLOW_PARALLEL_TEST_LOG: activityLog,
    SFLOW_MOCK_FAIL_SYNTHESIS: '1',
    SFLOW_MOCK_SKIP_PACKET_VIEW: 'architecture'
  });
  assert.notEqual(first.status, 0);
  assert.match(`${first.stdout}${first.stderr}`, /Model provider 'mock-world-model' exited with status 9/);
  assert.match(first.stderr, /checkpoint retained in the repository: 1 completed, 1 pending/);
  assert.equal((await lstat(path.join(root, 'singularity/world-model/.checkpoints'))).isDirectory(), true);
  const firstEvents = (await readFile(activityLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(firstEvents.filter((event) => event.event === 'start').length, 2);
  assert.equal(firstEvents.filter((event) => event.event === 'start' && event.view === 'security').length, 1);

  const second = result(process.execPath, args, root, {
    ...process.env,
    SFLOW_PARALLEL_TEST_LOG: activityLog
  });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.match(second.stderr, /World-model resume: 1 completed view packet reused; 1 pending/);
  const allEvents = (await readFile(activityLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(allEvents.filter((event) => event.event === 'start').length, 3);
  assert.equal(allEvents.filter((event) => event.event === 'start' && event.view === 'security').length, 1);

  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.generation.resumed_views, ['security']);
  assert.deepEqual(manifest.generation.pending_views_at_start, ['architecture']);
  await assert.rejects(() => lstat(path.join(root, 'singularity/world-model/.checkpoints')), { code: 'ENOENT' });
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
  await configureMockProvider(root, builder);
  await writeFile(path.join(root, 'README.md'), '# Discovery fallback test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'design', '--parallel', '--workers', '2'
  ], root, { ...process.env, SFLOW_MOCK_SKIP_PACKET_VIEW: 'architecture' });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stderr, /architecture discovery worker did not create its analysis packet/);
  assert.match(execution.stderr, /final synthesis will inspect this view directly/);
  const manifest = JSON.parse(await readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.generation.discovery_views, ['security']);
  assert.deepEqual(manifest.generation.degraded_views, ['architecture']);
  assert.ok(manifest.views.architecture);
});

test('wm build does not synthesize when every discovery worker omits its packet', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-discovery-empty-'));
  const activityLog = path.join(os.tmpdir(), `sflow-worldmodel-discovery-empty-${process.pid}-${Date.now()}.jsonl`);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Discovery Empty Tester'], root);
  run('git', ['config', 'user.email', 'discovery-empty@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await configureMockProvider(root, builder);
  await writeFile(path.join(root, 'README.md'), '# Empty discovery test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'design', '--parallel', '--workers', '2'
  ], root, {
    ...process.env, SFLOW_MOCK_SKIP_ALL_PACKETS: '1', SFLOW_PARALLEL_TEST_LOG: activityLog
  });
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /discovery produced no usable packets; final synthesis was not started/);
  const events = (await readFile(activityLog, 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(events.filter((event) => event.event === 'start').length, 2);
  assert.equal(events.filter((event) => event.event === 'synthesis').length, 0);
  const audits = (await readdir(path.join(root, '.git/singularity-flow/model-invocations')))
    .filter((name) => name.endsWith('.json'));
  assert.equal(audits.length, 2);
  for (const name of audits) {
    const audit = JSON.parse(await readFile(path.join(root, '.git/singularity-flow/model-invocations', name), 'utf8'));
    assert.deepEqual(audit.toolPolicy, {
      mode: 'allowlist', names: ['read_file', 'search', 'create_file']
    });
  }
});

test('wm build fails fast when the builder omits manifest.json', async () => {
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
  await configureMockProvider(root, builder);
  await writeFile(path.join(root, 'README.md'), '# Synthesis retry test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'intake', '--no-parallel'
  ], root, { ...process.env, SFLOW_MOCK_MANIFEST_RETRY_MARKER: marker });
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /completed without manifest\.json; recovery was not repeated/);
  const audits = (await readdir(path.join(root, '.git/singularity-flow/model-invocations')))
    .filter((name) => name.endsWith('.json'));
  assert.equal(audits.length, 1, 'a no-output synthesis must not spend a second model call');
  const audit = JSON.parse(await readFile(path.join(root, '.git/singularity-flow/model-invocations', audits[0]), 'utf8'));
  assert.deepEqual(audit.toolPolicy, {
    mode: 'allowlist', names: ['read_file', 'search', 'edit_file', 'create_file']
  });
  await assert.rejects(() => readFile(path.join(root, 'singularity/world-model/manifest.json'), 'utf8'), /ENOENT/);
});

test('wm build retries final synthesis when a declared view is a directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-view-retry-'));
  const marker = path.join(os.tmpdir(), `sflow-worldmodel-view-retry-${process.pid}-${Date.now()}.txt`);
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'View Recovery Tester'], root);
  run('git', ['config', 'user.email', 'view-recovery@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  await writeFile(definitionPath, YAML.stringify(definition));
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await configureMockProvider(root, builder);
  await writeFile(path.join(root, 'README.md'), '# View recovery test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'intake', '--no-parallel'
  ], root, { ...process.env, SFLOW_MOCK_DIRECTORY_VIEW_RETRY_MARKER: marker });
  assert.equal(execution.status, 0, `${execution.stdout}\n${execution.stderr}`);
  assert.match(execution.stderr, /view 'business' must be a regular file.*retrying final synthesis once without repeating discovery/s);
  const view = await readFile(path.join(root, 'singularity/world-model/views/business.brief.md'), 'utf8');
  assert.match(view, /^# business/m);
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
  await configureMockProvider(root, builder);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim();

  const execution = result(process.execPath, [
    bin, 'wm', 'build', '--phase', 'requirements', '--no-parallel'
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
  await configureMockProvider(root, builder);
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
    '--phase', 'design', '--task', 'Ground the release'
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
  await configureMockProvider(root, builder);
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
    bin, 'wm', 'build', '--branch', 'remote/model', '--local'
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
  await configureMockProvider(root, builder, ['--mutate']);
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const attempted = result(process.execPath, [bin, 'wm', 'build', '--phase', 'design'], root);
  assert.notEqual(attempted.status, 0);
  // The guard still fires and still names the file. The message now also says what survived: the
  // checkpoint lives in the repository, not in the worktree that was mutated, so completed packets
  // are kept and the rerun resumes instead of starting over.
  assert.match(`${attempted.stdout}${attempted.stderr}`, /modified the analysis worktree: MUTATED\.txt/);
  assert.match(`${attempted.stdout}${attempted.stderr}`, /completed view packets? (?:was|were) kept|Rerun the same wm build/);

  // The mutation happened in the disposable analysis worktree, so nothing of it reaches the real
  // repository — that is still the property worth asserting.
  const dirty = result('git', ['status', '--porcelain'], root).stdout.trim().split('\n').filter(Boolean);
  assert.equal(dirty.filter((line) => line.includes('MUTATED')).length, 0, 'the mutation leaked into the repository');

  // What may remain is the checkpoint, and only the checkpoint. It is deliberately kept now: it
  // holds completed discovery packets, it lives in the repository rather than in the worktree that
  // was mutated, and deleting it discarded finished work for a fault it had no part in.
  for (const line of dirty) {
    assert.match(line, /singularity\/world-model\/?$|singularity\/world-model\/\.checkpoints/,
      `a failed build left something other than its checkpoint: ${line}`);
  }
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
  await configureMockProvider(root, builder);
  await writeFile(path.join(root, 'README.md'), '# Grounding gate test\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  const task = 'Capture governed intake';
  run(process.execPath, [bin, 'wm', 'build', '--phase', 'intake', '--task', task], root);

  // Pinned here, immediately before the Story snapshots it. The shipped default is `warn`, and this
  // test is about the enforcing mode, so it says so rather than depending on the template — and it
  // must be set after `wm init` and the provider setup, both of which rewrite workflow.yml.
  const enforcing = YAML.parse(await readFile(definitionPath, 'utf8'));
  enforcing.worldModel.grounding = 'enforce';
  await writeFile(definitionPath, YAML.stringify(enforcing));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'enforce grounding'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);

  flow(['start', 'GROUND-1', '--from-branch', 'main', '--title', 'Grounded work'], root);
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

  const composed = flow(['wm', 'compose', '--phase', 'intake', '--task', task], root);
  assert.match(composed.stdout, /Human clarification checkpoint/);
  assert.match(composed.stdout, /clarification mode `required`/);
  assert.match(composed.stdout, /interactive `ask_user` tool/);
  const unanswered = flow(['phase', 'publish', 'intake', '--authored', 'governed-agent', '--channel', 'copilot-host'], root, { allowFailure: true });
  assert.notEqual(unanswered.status, 0);
  assert.match(`${unanswered.stdout}${unanswered.stderr}`, /clarification response is missing/);
  flow(['clarification', 'record', 'intake', '--question', 'Is this objective and scope correct?', '--answer', 'Yes; use the stated outcome and boundaries.'], root);
  flow(['phase', 'publish', 'intake', '--authored', 'governed-agent', '--channel', 'copilot-host'], root);
  const published = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(published.phases.intake.generation, 1);
  assert.equal(published.phases.intake.clarifications[0].responses, 1);
  assert.match(run('git', ['log', '-1', '--format=%s'], root), /^\[GROUND-1\]\[phase:intake\]\[generated:1\]/);
});

test('next --yes enters shared semantic ensure and prepares configured next-phase grounding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-next-phase-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Next Grounding Tester'], root);
  run('git', ['config', 'user.email', 'next-grounding@example.com'], root);
  await initializeDefinition(root);
  const builder = path.join(root, 'mock-worldmodel-builder.mjs');
  await writeFile(builder, mockBuilderSource);
  await configureMockProvider(root, builder);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.worldModel.grounding = 'enforce';
  definition.worldModel.materialization = {
    mode: 'on-demand', publish: 'governed', lookahead: 'next-phase', depth: 'phase', confirmation: 'prompt'
  };
  await writeFile(definitionPath, YAML.stringify(definition));
  await writeFile(path.join(root, 'README.md'), '# Next phase grounding\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize semantic next fixture'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);

  const task = 'Prepare semantic phase grounding';
  flow(['start', 'NEXT-PHASE-1', '--from-branch', 'main', '--title', task], root);
  const prepared = flow(['next', '--yes', '--task', task], root);
  assert.doesNotMatch(`${prepared.stdout}${prepared.stderr}`, /MODEL_FORBIDDEN|forbids model execution/);
  assert.match(prepared.stderr, /repository world model is shared across Stories/);
  assert.match(prepared.stdout, /Building the configured phase-depth world model for phase 'intake'/);
  assert.match(prepared.stdout, /World model built from source/);
  assert.match(prepared.stdout, /Preparing configured next-phase grounding for 'requirements'/);
  assert.match(prepared.stdout, /Next step prepared: generate 'intake'/);

  const intake = JSON.parse(flow(['wm', 'availability', '--phase', 'intake', '--json'], root).stdout);
  const requirements = JSON.parse(flow(['wm', 'availability', '--phase', 'requirements', '--json'], root).stdout);
  assert.equal(intake.ready, true);
  assert.equal(requirements.ready, true);
  assert.equal(intake.source, 'state-branch');
  assert.equal(requirements.source, 'state-branch');
  const explicitTaskGuide = JSON.parse(flow(['wm', 'availability', '--phase', 'intake', '--task', task, '--json'], root).stdout);
  assert.equal(explicitTaskGuide.ready, false);
  assert.equal(explicitTaskGuide.taskGuide.status, 'missing');
});

test('--no-model wm ensure honors deterministic light materialization policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-no-model-ensure-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'No Model Tester'], root);
  run('git', ['config', 'user.email', 'no-model@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.worldModel.materialization = {
    mode: 'on-demand', publish: 'local', lookahead: 'none', depth: 'light', confirmation: 'automatic'
  };
  await writeFile(definitionPath, YAML.stringify(definition));
  await writeFile(path.join(root, 'README.md'), '# No-model ensure\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize no-model ensure fixture'], root);

  const ensured = flow(['--no-model', 'wm', 'ensure', '--phase', 'design'], root);
  assert.doesNotMatch(`${ensured.stdout}${ensured.stderr}`, /requires a model|MODEL_UNAVAILABLE/);
  assert.match(ensured.stdout, /Light world model built with 0 model tokens/);
  const availability = JSON.parse(flow(['wm', 'availability', '--phase', 'design', '--depth', 'light', '--json'], root).stdout);
  assert.equal(availability.ready, true);
});

test('--no-model wm ensure labels a phase-depth deterministic fallback as degraded', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-no-model-phase-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'No Model Phase Tester'], root);
  run('git', ['config', 'user.email', 'no-model-phase@example.com'], root);
  await initializeDefinition(root);
  const definitionPath = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.git.publish = 'off';
  definition.worldModel.materialization = {
    mode: 'on-demand', publish: 'local', lookahead: 'none', depth: 'phase', confirmation: 'prompt'
  };
  await writeFile(definitionPath, YAML.stringify(definition));
  await writeFile(path.join(root, 'README.md'), '# No-model phase fallback\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize no-model phase fixture'], root);

  const ensured = flow(['--no-model', 'wm', 'ensure', '--phase', 'design', '--json'], root);
  const result = JSON.parse(ensured.stdout.slice(ensured.stdout.indexOf('{')));
  assert.equal(result.degraded.code, 'MODEL_DISABLED_LIGHT_FALLBACK');
  assert.match(result.degraded.reason, /without semantic analysis/);
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
  await configureMockProvider(root, builder);
  await writeFile(path.join(root, 'README.md'), '# Local build\n');
  run('git', ['add', '.'], root);
  run('git', ['commit', '-m', 'initialize'], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  const remoteMainBefore = run('git', ['ls-remote', remote, 'refs/heads/main'], root).trim();

  // git.publish stays at its default (required); --local must still skip the push.
  const output = run(process.execPath, [bin, 'wm', 'build', '--local', '--phase', 'design', '--task', 'Design it'], root);
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
  // this in one commit: initiative state, the artifact templates, and the agent prompts. On the
  // rule-engine repository the templates alone were 22 files, so a model built minutes earlier was
  // reported stale before a line of the application had changed.
  await mkdir(path.join(root, 'singularity/initiatives/EPIC-1/artifacts'), { recursive: true });
  await writeFile(path.join(root, 'singularity/initiatives/EPIC-1/state.json'), '{"currentPhase":"epic-intake"}\n');
  await writeFile(path.join(root, 'singularity/initiatives/EPIC-1/artifacts/requirements.md'), '# REQ\n');
  await mkdir(path.join(root, 'singularity/templates/initiatives/epic'), { recursive: true });
  await writeFile(path.join(root, 'singularity/templates/initiatives/epic/requirements.md'), '# {{work.id}} requirements\n');
  await mkdir(path.join(root, 'singularity/agents'), { recursive: true });
  await writeFile(path.join(root, 'singularity/agents/product-owner.md'), 'Act as Product owner.\n');
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

test('wm cleanup removes a worktree whose recorded builder process is dead', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-worldmodel-cleanup-repo-'));
  run('git', ['init', '-b', 'main'], root);
  run('git', ['config', 'user.email', 'wm@example.com'], root);
  run('git', ['config', 'user.name', 'World Model'], root);
  await writeFile(path.join(root, 'README.md'), '# cleanup\n');
  run('git', ['add', 'README.md'], root);
  run('git', ['commit', '-m', 'init'], root);

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-world-model-'));
  const worktree = path.join(temporary, 'repository');
  await writeFile(path.join(temporary, 'singularity-flow-owner.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'analysis',
    pid: 999999,
    createdAt: new Date(0).toISOString(),
    repositoryGitDirectory: path.join(root, '.git')
  }));
  run('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], root);

  const cleanup = result(process.execPath, [bin, 'wm', 'cleanup', '--json'], root);
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const report = JSON.parse(cleanup.stdout);
  assert.equal(report.removed.length, 1);
  assert.equal(path.basename(path.dirname(report.removed[0])), path.basename(temporary));
  assert.doesNotMatch(run('git', ['worktree', 'list', '--porcelain'], root), new RegExp(worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await assert.rejects(lstat(temporary), /ENOENT/);
});
