import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Document Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', persona: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(root, args, options = {}) { return run(process.execPath, [bin, ...args], root, options); }

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-documents-')); run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Document Tester'], root); run('git', ['config', 'user.email', 'documents@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Documents\n'); flow(root, ['init']);
  const configPath = path.join(root, '.singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8')); config.git.publish = 'off'; config.documents.allowedPhases = ['intake']; await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'README.md', '.singularity'], root); run('git', ['commit', '-m', 'initialize'], root); return root;
}

test('progress and document commands upload, list, and view files, images, and Figma links', async () => {
  const root = await repository(); const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-uploads-'));
  const notes = path.join(uploads, 'research notes.md'); const image = path.join(uploads, 'wireframe.png');
  await writeFile(notes, '# Research\nCustomer workflow evidence.\n'); await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  flow(root, ['start', 'DOCS-1', '--title', 'Document intake']);

  let progress = JSON.parse(flow(root, ['progress', '--json']).stdout); assert.equal(progress.percentage, 0); assert.equal(progress.currentPhase, 'intake');
  flow(root, ['documents', 'upload', notes, image, '--kind', 'research']);
  flow(root, ['documents', 'upload', '--url', 'https://www.figma.com/design/example', '--label', 'Checkout design']);

  const catalog = JSON.parse(flow(root, ['documents', 'list', '--json']).stdout); const uploaded = catalog.filter((item) => item.id.startsWith('DOC-'));
  assert.equal(uploaded.length, 3); assert.equal(uploaded[0].sha256.length, 64); assert.equal(uploaded[1].mimeType, 'image/png'); assert.equal(uploaded[2].kind, 'figma');
  assert.match(flow(root, ['documents', 'view', 'DOC-001']).stdout, /Customer workflow evidence/);
  const binary = JSON.parse(flow(root, ['documents', 'view', 'DOC-002', '--json']).stdout); assert.equal(binary.binary, true); assert.match(binary.absolutePath, /wireframe\.png$/);
  assert.match(flow(root, ['documents', 'view', 'DOC-003']).stdout, /figma\.com\/design\/example/);
  progress = JSON.parse(flow(root, ['progress', '--json']).stdout); assert.equal(progress.documents, 3);
  assert.match(flow(root, ['gate']).stdout, /document integrity: 3 supporting inputs/);

  const workflowFile = path.join(root, '.singularity/work-items/DOCS-1/workflow.json'); const workflow = JSON.parse(await readFile(workflowFile, 'utf8')); const intake = path.join(root, '.singularity/work-items/DOCS-1', workflow.phases.intake.requiredArtifact.path);
  await writeFile(intake, (await readFile(intake, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete intake evidence with measurable acceptance outcomes and linked design context.'));
  flow(root, ['phase', 'publish', 'intake']); flow(root, ['submit']); flow(root, ['approve', '--yes']);
  progress = JSON.parse(flow(root, ['progress', '--json']).stdout); assert.equal(progress.percentage, 14); assert.equal(progress.approvedPhases, 1); assert.equal(progress.currentPhase, 'requirements');
  const late = flow(root, ['documents', 'upload', notes], { allowFailure: true }); assert.notEqual(late.status, 0); assert.match(late.stderr, /only during: intake/);
  assert.match(run('git', ['log', '--format=%s'], root).stdout, /\[DOCS-1\]\[documents\]\[upload\]/);
});
