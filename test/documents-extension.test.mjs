import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  createDocumentsCanvasResult,
  DOCUMENTS_CANVAS_ID,
  DOCUMENTS_INSTANCE_ID,
  flowArguments,
  inferWorkId,
  parseDocumentsArguments,
  renderDocumentsHtml
} from '../plugin/extensions/documents/documents.mjs';

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
  assert.equal(inferWorkId([{ path: '.singularity/work-items/WORK-123/artifacts/design/design.md' }]), 'WORK-123');
  const snapshot = {
    workId: 'WORK-123',
    cwd: '/repo',
    selectedReference: 'PHASE-DESIGN',
    documents: [{ id: 'PHASE-DESIGN', type: 'artifact', phase: 'design', label: 'Design', path: '.singularity/work-items/WORK-123/artifacts/design/design.md' }],
    details: { 'PHASE-DESIGN': { record: { id: 'PHASE-DESIGN', type: 'artifact', label: 'Design' }, content: '# Design\n\nRendered evidence', binary: false } }
  };
  const result = createDocumentsCanvasResult(snapshot);
  const html = result.html;
  assert.equal(result.type, 'html');
  assert.equal(result.status, '1 document');
  assert.match(html, /<title>Singularity Flow Documents<\/title>/);
  assert.match(html, /data-filter="generated"/);
  assert.match(html, /Search ID, phase, title, or path/);
  assert.match(html, /PHASE-DESIGN/);
  assert.match(html, /Rendered evidence/);
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

test('Documents extension returns inline HTML instead of a localhost canvas URL', async () => {
  const source = await readFile(new URL('../plugin/extensions/documents/extension.mjs', import.meta.url), 'utf8');
  assert.match(source, /createDocumentsCanvasResult\(await canvasSnapshot\(entry\)\)/);
  assert.doesNotMatch(source, /createServer|127\.0\.0\.1|url:\s*entry\.url/);
});
