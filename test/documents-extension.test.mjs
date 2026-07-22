import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
  const html = renderDocumentsHtml();
  assert.match(html, /<title>Singularity Flow Documents<\/title>/);
  assert.match(html, /data-filter="generated"/);
  assert.match(html, /Search ID, phase, title, or path/);
  assert.match(html, /\/api\/document\?reference=/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link[^>]+href=/);
});
