import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
  const configPath = path.join(root, 'singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8')); config.git.publish = 'off'; config.worldModel.grounding = 'off'; config.documents.allowedPhases = ['intake']; await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'README.md', 'singularity'], root); run('git', ['commit', '-m', 'initialize'], root); return root;
}

test('progress and document commands upload, list, and view files, images, and Figma links', async () => {
  const root = await repository(); const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-uploads-'));
  const notes = path.join(uploads, 'research notes.md'); const image = path.join(uploads, 'wireframe.png');
  await writeFile(notes, '# Research\nCustomer workflow evidence.\n'); await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  flow(root, ['start', 'DOCS-1', '--title', 'Document intake']);

  const visualProgress = flow(root, ['progress']).stdout;
  assert.match(visualProgress, /Workflow flow:/);
  assert.match(visualProgress, /▶ Intake\s+IN PROGRESS · generation 0  ← CURRENT/);
  assert.match(visualProgress, /▼[\s\S]*○ Requirements\s+PENDING/);
  let progress = JSON.parse(flow(root, ['progress', '--json']).stdout); assert.equal(progress.percentage, 0); assert.equal(progress.currentPhase, 'intake');
  flow(root, ['documents', 'upload', notes, image, '--kind', 'research']);
  flow(root, ['documents', 'upload', '--url', 'https://www.figma.com/design/example', '--label', 'Checkout design']);

  const catalog = JSON.parse(flow(root, ['documents', 'list', '--json']).stdout); const uploaded = catalog.filter((item) => item.id.startsWith('DOC-'));
  assert.equal(uploaded.length, 3); assert.equal(uploaded[0].sha256.length, 64); assert.equal(uploaded[1].mimeType, 'image/png'); assert.equal(uploaded[2].kind, 'figma');
  assert.match(flow(root, ['documents', 'view', 'DOC-001']).stdout, /Customer workflow evidence/);
  const binary = JSON.parse(flow(root, ['documents', 'view', 'DOC-002', '--json']).stdout); assert.equal(binary.binary, true); assert.match(binary.absolutePath, /wireframe\.png$/);
  const inline = JSON.parse(flow(root, ['documents', 'preview', 'DOC-002', '--json']).stdout);
  assert.equal(inline.previewable, true); assert.equal(inline.integrity, 'verified'); assert.equal(inline.mime, 'image/png');
  assert.equal(inline.sha256, uploaded[1].sha256); assert.match(inline.dataUrl, /^data:image\/png;base64,/);
  assert.match(flow(root, ['documents', 'view', 'DOC-003']).stdout, /figma\.com\/design\/example/);
  progress = JSON.parse(flow(root, ['progress', '--json']).stdout); assert.equal(progress.documents, 3);
  assert.match(flow(root, ['gate']).stdout, /document integrity: 3 supporting inputs/);

  const workflowFile = path.join(root, 'singularity/work-items/DOCS-1/workflow.json'); const workflow = JSON.parse(await readFile(workflowFile, 'utf8')); const intake = path.join(root, 'singularity/work-items/DOCS-1', workflow.phases.intake.requiredArtifact.path);
  await writeFile(intake, (await readFile(intake, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete intake evidence with measurable acceptance outcomes and linked design context.'));
  const publication = flow(root, ['phase', 'publish', 'intake']);
  assert.match(publication.stdout, /Published intake generation 1 at [0-9a-f]{8}/);
  assert.match(publication.stdout, /Generated documents ready for review — DOCS-1 \/ intake \/ generation 1/);
  assert.match(publication.stdout, /Path: singularity\/work-items\/DOCS-1\/artifacts\/intake\/intake\.md/);
  assert.match(publication.stdout, /SHA-256: [0-9a-f]{64}/);
  assert.match(publication.stdout, /--- BEGIN singularity\/work-items\/DOCS-1\/artifacts\/intake\/intake\.md ---/);
  assert.match(publication.stdout, /Complete intake evidence/);
  assert.match(publication.stdout, /--- END singularity\/work-items\/DOCS-1\/artifacts\/intake\/intake\.md ---/);
  const review = flow(root, ['phase', 'show', 'intake']);
  assert.match(review.stdout, /Generated documents ready for review — DOCS-1 \/ intake \/ generation 1/);
  assert.match(review.stdout, /PHASE-INTAKE/);
  assert.match(review.stdout, /artifacts\/intake\/intake\.md/);
  assert.match(review.stdout, /SHA-256: [0-9a-f]{64}/);
  assert.match(review.stdout, /Complete intake evidence/);
  const reviewJson = JSON.parse(flow(root, ['phase', 'show', 'intake', '--json']).stdout);
  assert.equal(reviewJson.documents.length, 1); assert.equal(reviewJson.documents[0].id, 'PHASE-INTAKE'); assert.match(reviewJson.documents[0].content, /Complete intake evidence/);
  const submission = flow(root, ['submit']);
  assert.match(submission.stdout, /Submitted intake phase for approval/);
  assert.match(submission.stdout, /Generated documents ready for review/);
  assert.match(submission.stdout, /Complete intake evidence/);
  assert.match(submission.stdout, /Status: intake is awaiting approval with 1 generated document/);
  const approval = flow(root, ['approve', '--yes']);
  assert.match(approval.stdout, /Generated documents ready for review/);
  assert.ok(approval.stdout.indexOf('Complete intake evidence') < approval.stdout.indexOf('Reviewing DOCS-1 \/ intake'));
  progress = JSON.parse(flow(root, ['progress', '--json']).stdout); assert.equal(progress.percentage, 14); assert.equal(progress.approvedPhases, 1); assert.equal(progress.currentPhase, 'requirements');
  const late = flow(root, ['documents', 'upload', notes], { allowFailure: true }); assert.notEqual(late.status, 0); assert.match(late.stderr, /only during: intake/);
  assert.match(run('git', ['log', '--format=%s'], root).stdout, /\[DOCS-1\]\[documents\]\[upload\]/);
});

test('inline previews reject tampering and document paths outside the governed work item', async () => {
  const root = await repository(); const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-preview-'));
  const image = path.join(uploads, 'screen.png'); const pdf = path.join(uploads, 'design-spec.pdf');
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex')); await writeFile(pdf, Buffer.from('%PDF-1.4\n%%EOF\n'));
  flow(root, ['start', 'PREVIEW-1', '--title', 'Governed preview']);
  flow(root, ['documents', 'upload', image, pdf, '--kind', 'figma-export']);
  const catalog = JSON.parse(flow(root, ['documents', 'list', '--json']).stdout); const record = catalog.find((item) => item.id === 'DOC-001');
  const pdfPreview = JSON.parse(flow(root, ['documents', 'preview', 'DOC-002', '--json']).stdout);
  assert.equal(pdfPreview.mime, 'application/pdf'); assert.match(pdfPreview.dataUrl, /^data:application\/pdf;base64,/); assert.equal(pdfPreview.integrity, 'verified');

  await writeFile(path.join(root, record.path), Buffer.from('tampered'));
  const tampered = flow(root, ['documents', 'preview', 'DOC-001', '--json'], { allowFailure: true });
  assert.notEqual(tampered.status, 0); assert.match(tampered.stderr, /no longer matches its committed catalog hash/);

  const manifestPath = path.join(root, 'singularity/work-items/PREVIEW-1/documents.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.documents[0].path = 'README.md';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const escaped = flow(root, ['documents', 'preview', 'DOC-001', '--json'], { allowFailure: true });
  assert.notEqual(escaped.status, 0); assert.match(escaped.stderr, /outside work item PREVIEW-1/);
});

test('source-code documents are rendered as reviewable text instead of binary metadata', async () => {
  const root = await repository(); const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-source-documents-'));
  const java = path.join(uploads, 'RuleEngineService.java');
  await writeFile(java, 'public final class RuleEngineService {\n  boolean evaluate() { return true; }\n}\n');
  flow(root, ['start', 'SOURCE-DOCS-1', '--title', 'Source document review']);
  flow(root, ['documents', 'upload', java, '--kind', 'source']);

  const review = JSON.parse(flow(root, ['documents', 'view', 'DOC-001', '--json']).stdout);
  assert.equal(review.binary, false);
  assert.equal(review.record.mimeType, 'text/x-java-source');
  assert.match(review.content, /public final class RuleEngineService/);
  const consoleOutput = flow(root, ['documents', 'view', 'DOC-001']).stdout;
  assert.match(consoleOutput, /RuleEngineService\.java/);
  assert.match(consoleOutput, /boolean evaluate\(\) \{ return true; \}/);
});

test('document upload recursively imports an exported design directory with stable relative paths', async () => {
  const root = await repository(); const exportRoot = await mkdtemp(path.join(os.tmpdir(), 'figma-export-'));
  await mkdir(path.join(exportRoot, 'components'), { recursive: true }); await mkdir(path.join(exportRoot, 'screens/login'), { recursive: true });
  await writeFile(path.join(exportRoot, 'components/button.json'), JSON.stringify({ name: 'Button', variants: ['primary', 'disabled'] }));
  await writeFile(path.join(exportRoot, 'screens/login/default.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  flow(root, ['start', 'FIGMA-DIR-1', '--title', 'Import exported mobile design']);

  const upload = flow(root, ['documents', 'upload', exportRoot, '--kind', 'figma-export']);
  assert.match(upload.stdout, /DOC-001[\s\S]*DOC-002/);
  const records = JSON.parse(flow(root, ['documents', 'list', '--json']).stdout).filter((item) => item.id.startsWith('DOC-'));
  assert.deepEqual(records.map((item) => item.sourceRelativePath), ['components/button.json', 'screens/login/default.png']);
  assert.ok(records.every((item) => item.packageId === 'PKG-001'));
  assert.ok(records.every((item) => item.kind === 'figma-export'));
  assert.match(records[0].path, /inputs\/DOC-001\/figma-export-[^/]+\/components\/button\.json$/);
  assert.match(records[1].path, /inputs\/DOC-002\/figma-export-[^/]+\/screens\/login\/default\.png$/);
  assert.match(flow(root, ['documents', 'view', 'DOC-001']).stdout, /Button/);
  const catalog = JSON.parse(flow(root, ['documents', 'list', '--json']).stdout);
  assert.ok(catalog.some((item) => item.id === 'PACKAGE-PKG-001-INVENTORY'));
  assert.ok(catalog.some((item) => item.id === 'PACKAGE-PKG-001-GALLERY'));
  assert.match(flow(root, ['documents', 'view', 'PACKAGE-PKG-001-INVENTORY']).stdout, /Design package PKG-001/);
  assert.match(flow(root, ['documents', 'view', 'PACKAGE-PKG-001-GALLERY']).stdout, /1 image preview/);
  assert.match(flow(root, ['gate']).stdout, /document integrity: 2 supporting inputs/);
});
