import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDocumentsCanvasResult,
  DOCUMENTS_CANVAS_ID,
  DOCUMENTS_INSTANCE_ID,
  flowArguments,
  inferWorkId,
  parseDocumentsArguments,
  renderDocumentsHtml,
  startDocumentsServer
} from '../plugin/extensions/documents/documents.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Documents extension parses list, work-item, view, and help commands safely', () => {
  assert.deepEqual(parseDocumentsArguments(''), { action: 'list', workId: null, reference: null });
  assert.deepEqual(parseDocumentsArguments('list WORK-123'), { action: 'list', workId: 'WORK-123', reference: null });
  assert.deepEqual(parseDocumentsArguments('view PHASE-DESIGN'), { action: 'view', workId: null, reference: 'PHASE-DESIGN' });
  assert.equal(parseDocumentsArguments('--help').action, 'help');
  assert.throws(() => parseDocumentsArguments('delete DOC-001'), /Unknown documents action/);
  assert.throws(() => parseDocumentsArguments('view DOC-001\u0000'), /invalid characters/);
});

test('Documents extension builds shell-free Singularity Flow argument arrays', () => {
  assert.deepEqual(flowArguments(parseDocumentsArguments('list WORK-123'), { json: true }), ['documents', 'list', 'WORK-123', '--json']);
  assert.deepEqual(flowArguments(parseDocumentsArguments('view PHASE-DESIGN'), { json: true }), ['documents', 'view', 'PHASE-DESIGN', '--json']);
  assert.deepEqual(flowArguments(parseDocumentsArguments('view artifacts/design/design.md')), ['documents', 'view', 'artifacts/design/design.md']);
});

test('Documents canvas has stable identity and renders a self-contained searchable browser', () => {
  assert.equal(DOCUMENTS_CANVAS_ID, 'singularity-flow-documents');
  assert.equal(DOCUMENTS_INSTANCE_ID, 'singularity-flow-documents');
  assert.equal(inferWorkId([{ path: 'singularity/work-items/WORK-123/artifacts/design/design.md' }]), 'WORK-123');
  const snapshot = {
    workId: 'WORK-123',
    cwd: '/repo',
    selectedReference: 'PHASE-DESIGN',
    documents: [{ id: 'PHASE-DESIGN', type: 'artifact', phase: 'design', label: 'Design', path: 'singularity/work-items/WORK-123/artifacts/design/design.md' }],
    details: { 'PHASE-DESIGN': { record: { id: 'PHASE-DESIGN', type: 'artifact', label: 'Design' }, content: '# Design\n\nRendered evidence', binary: false } }
  };
  const result = createDocumentsCanvasResult(snapshot, 'http://127.0.0.1:43123/');
  const html = renderDocumentsHtml(snapshot);
  assert.equal(result.url, 'http://127.0.0.1:43123/');
  assert.equal(result.title, 'Singularity Flow Documents');
  assert.equal(result.status, '1 document');
  assert.match(html, /<title>Singularity Flow Documents<\/title>/);
  assert.match(html, /data-filter="generated"/);
  assert.match(html, /Search ID, phase, title, or path/);
  assert.match(html, /PHASE-DESIGN/);
  assert.match(html, /Rendered evidence/);
  assert.match(html, /recordLocation/);
  assert.doesNotMatch(html, /const location\s*=/);
  assert.doesNotMatch(html, /fetch\(/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
});

test('Documents canvas safely embeds document text without closing its script', () => {
  const html = renderDocumentsHtml({
    documents: [{ id: 'DOC-001', type: 'file', label: 'Unsafe-looking text' }],
    details: { 'DOC-001': { record: { id: 'DOC-001', type: 'file', label: 'Unsafe-looking text' }, content: '</script><script>throw new Error("injected")</script>', binary: false } }
  });
  assert.doesNotMatch(html, /<\/script><script>throw/);
  assert.match(html, /\\u003c\/script>/);
});

test('Documents extension returns the SDK-supported URL and serves the embedded snapshot without restrictive CSP', async () => {
  const source = await readFile(new URL('../plugin/extensions/documents/extension.mjs', import.meta.url), 'utf8');
  assert.match(source, /createDocumentsCanvasResult\(entry\.snapshot, entry\.url\)/);
  assert.match(source, /startDocumentsServer/);
  assert.doesNotMatch(source, /Content-Security-Policy|type:\s*['"]html['"]/);
});

test('Documents loopback server renders a populated canvas at the returned URL', async () => {
  const snapshot = {
    workId: 'WORK-123',
    documents: [{ id: 'SYS-STORY', type: 'system', label: 'User story', path: 'singularity/work-items/WORK-123/USER-STORY.md' }],
    details: { 'SYS-STORY': { record: { id: 'SYS-STORY', type: 'system', label: 'User story' }, content: '# Visible story', binary: false } }
  };
  const host = await startDocumentsServer(snapshot);
  try {
    assert.match(host.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const response = await fetch(host.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.has('content-security-policy'), false);
    const html = await response.text();
    assert.match(html, /SYS-STORY/);
    assert.match(html, /Visible story/);
  } finally {
    await new Promise((resolve) => host.server.close(resolve));
  }
});

test('the second copy of a plugin in one session steps aside quietly, and only for that', async () => {
  // VS Code loads the plugin from Copilot's install and from its own copy; the host refuses whichever joins second.
  const { leaveIfTwinCopy } = await import('../plugin/extensions/twin-copy.mjs');
  const exits = [];
  const realExit = process.exit;
  process.exit = (code) => { exits.push(code); };
  try {
    for (const message of [
      'Request session.resume failed with message: Canvas "plugin:singularity-flow:documents/singularity-flow-documents" is already registered.',
      'Request session.resume failed with message: GenericFailure, External tool name clash: sflow_decide, sflow_adjudicate already registered by another connection',
      'Request session.resume failed with message: External tool name clash: sflow_decide already registered by another connection'
    ]) leaveIfTwinCopy(new Error(message));
    assert.deepEqual(exits, [0, 0, 0]);
    for (const message of [
      'Request session.resume failed with message: Extension "plugin:singularity-flow:documents" was denied permission access and will not be loaded.',
      'Request session.resume failed with message: connection lost'
    ]) assert.throws(() => leaveIfTwinCopy(new Error(message)), { message });
    assert.deepEqual(exits, [0, 0, 0], 'any other failure stays a failure');
  } finally {
    process.exit = realExit;
  }
  for (const name of ['documents', 'decisions']) {
    const source = await readFile(path.join(root, 'plugin', 'extensions', name, 'extension.mjs'), 'utf8');
    assert.match(source, /joinSession\(\{[\s\S]*\}\)\.catch\(leaveIfTwinCopy\);/u, name);
  }
});

test('Documents and Decisions share no canvas, command or tool, so they never refuse each other', async () => {
  const declared = async (name) => {
    const source = await readFile(path.join(root, 'plugin', 'extensions', name, 'extension.mjs'), 'utf8');
    return new Set([...source.matchAll(/\bname: '([^']+)'/gu)].map((match) => match[1])
      .concat(/createCanvas\(/u.test(source) ? ['canvas'] : []));
  };
  const documents = await declared('documents');
  const decisions = await declared('decisions');
  assert.ok(documents.has('documents') && documents.has('canvas'));
  assert.ok(decisions.has('sflow_decide') && decisions.has('adjudicate') && !decisions.has('canvas'));
  assert.deepEqual([...documents].filter((name) => decisions.has(name)), []);
});
