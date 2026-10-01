import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import YAML from 'yaml';
import { loadDefinition } from '../src/config.mjs';
import { renderActiveStoryEvidence } from '../src/evidence-context.mjs';
import { loadStoryAggregate } from '../src/state-stores.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Office Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(root, args, options = {}) { return run(process.execPath, [bin, ...args], root, options); }

/** A real ZIP container, deflated the way Office writes it. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.from(content, 'utf8');
    const body = deflateRawSync(raw);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

function docx(paragraphs) {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  return zip([['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${body}</w:body></w:document>`]]);
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-office-documents-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Office Tester'], root); run('git', ['config', 'user.email', 'office@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Office\n'); flow(root, ['init']);
  const configPath = path.join(root, 'singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off'; config.worldModel.grounding = 'off'; config.documents.allowedPhases = ['intake'];
  config.approvalSecurity = { profile: 'poc' };
  // These fixtures exercise supporting documents, not the pre-Story test-readiness gate.
  config.repositoryReadiness.requiredBeforeStory = false;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'README.md', 'singularity', '.github/agents'], root); run('git', ['commit', '-m', 'initialize'], root);
  const remote = `${root}.git`;
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-u', 'origin', 'main'], root);
  return root;
}

test('a DOCX is read as its extracted text in documents view and in prompts, never as bytes', async () => {
  const root = await repository();
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-docx-'));
  const brief = path.join(uploads, 'retry brief.docx');
  await writeFile(brief, docx(['Retry policy', 'A failed payment is retried once after 30 seconds.']));
  flow(root, ['start', 'OFFICE-1', '--from-branch', 'main', '--title', 'Read an Office brief']);
  flow(root, ['documents', 'upload', brief, '--name', 'Retry brief']);
  const [record] = JSON.parse(flow(root, ['documents', 'list', '--json']).stdout).filter((item) => item.id.startsWith('DOC-'));
  assert.equal(record.mimeType, DOCX);

  const printed = flow(root, ['documents', 'view', 'Retry brief']).stdout;
  assert.match(printed, /Text extracted from this file \(the original is binary\)/);
  assert.match(printed, /retried once after 30 seconds/);
  const viewed = JSON.parse(flow(root, ['documents', 'view', 'DOC-001', '--json']).stdout);
  assert.equal(viewed.binary, true);
  assert.equal(viewed.rendition.status, 'extracted');
  assert.equal(viewed.rendition.extractor, 'source-text');

  const definition = await loadDefinition(root);
  const workflow = await loadStoryAggregate(root, definition, 'OFFICE-1');
  const rendered = await renderActiveStoryEvidence(root, definition, workflow);
  assert.match(rendered.markdown, /## DOC-001 — Retry brief[\s\S]*Text extracted from this [^\n]* file \(extractor v1\); its original bytes are not included\.[\s\S]*retried once after 30 seconds/);
  assert.doesNotMatch(rendered.markdown, /Inspect this verified file/);
  const [entry] = rendered.entries;
  assert.equal(entry.injectedBytes, 0, 'no original byte is injected');
  assert.equal(entry.rendition.version, 1);
  assert.match(entry.rendition.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(rendered.files[0].rendition, entry.rendition, 'the receipt records the same rendition as the prompt entry');
});

test('a secret inside a DOCX is refused before its bytes are copied', async () => {
  const root = await repository();
  const uploads = await mkdtemp(path.join(os.tmpdir(), 'sflow-docx-secret-'));
  const credential = `ghp_${'k'.repeat(36)}`;
  const leaky = path.join(uploads, 'setup notes.docx');
  await writeFile(leaky, docx(['Deployment notes', `token = "${credential}"`])); // sflow-allow-secret: invented input verifies upload refusal
  flow(root, ['start', 'OFFICE-2', '--from-branch', 'main', '--title', 'Refuse a leaky Office file']);
  const refused = flow(root, ['documents', 'upload', leaky, '--name', 'Setup notes'], { allowFailure: true });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Document upload was refused before any bytes were copied/);
  assert.doesNotMatch(refused.stderr, new RegExp(credential));
  assert.equal(run('git', ['ls-files', 'singularity/work-items/OFFICE-2/inputs'], root).stdout.trim(), '');
});
