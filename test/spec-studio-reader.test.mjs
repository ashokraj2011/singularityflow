import assert from 'node:assert/strict';
import test from 'node:test';
import { answerSpecStudioTool, specToolInput, specToolProse, specToolState, SPEC_TOOL_ANSWER_BYTES } from '../apps/vscode/src/views/spec-studio-tool.ts';

test('long Unicode paragraphs make finite progress without splitting characters or losing text', () => {
  const text = '🙂'.repeat(9000) + '\nA final line.';
  const restored = new Map(); let from = 1, column = 0, pages = 0;
  do {
    const page = specToolProse(text, from, column);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= SPEC_TOOL_ANSWER_BYTES);
    for (const line of page.lines) { const match = /^(\d+)  ([\s\S]*)$/u.exec(line); assert.ok(match); restored.set(match[1], (restored.get(match[1]) ?? '') + match[2]); }
    assert.ok(!page.next || page.next > from || page.nextColumn > column, 'the same range cannot repeat');
    from = page.next; column = page.nextColumn ?? 0;
    assert.ok(++pages < 100);
  } while (from);
  assert.equal([...restored.values()].join('\n'), text);
});

test('oversized metadata has explicit per-part continuation instead of another unreadable state result', async () => {
  const status = { action: 'status', specId: 'SPEC-READER', prose: undefined, spec: 'The draft',
    sources: Array.from({ length: 32 }, (_, index) => ({ id: 'SRC-' + String(index).padStart(16, '0'), name: 'Source', purpose: 'A long source note. '.repeat(100) })) };
  const state = specToolState(status);
  assert.ok(Buffer.byteLength(JSON.stringify(state)) <= SPEC_TOOL_ANSWER_BYTES);
  assert.ok(state.metadataOmitted.includes('sources'));
  const runner = { run: async () => status, propose: async () => ({}) };
  const request = specToolInput({ action: 'details', spec: 'SPEC-READER', part: 'sources', from: 1 });
  const detail = await answerSpecStudioTool(request, runner);
  assert.ok(detail.next > 1);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= SPEC_TOOL_ANSWER_BYTES);
  assert.throws(() => specToolInput({ action: 'details', spec: 'SPEC-READER', part: 'permissions' }));
});

test('source pages keep original line numbers and combine character and line continuation', async () => {
  const body = 'A'.repeat(22000);
  const runner = { run: async args => { const at = args.indexOf('--column'); const column = at < 0 ? 0 : Number(args[at + 1]); return { sources: [{ source: { id: 'SRC-aaaaaaaaaaaaaaaa' }, status: 'available', text: body.slice(column), from: 17, column, path: '/exact/issued/source.txt' }] }; }, propose: async () => ({}) };
  let text = '', column = 0;
  do {
    const result = await answerSpecStudioTool({ action: 'source', spec: 'SPEC-READER', source: 'SRC-aaaaaaaaaaaaaaaa', from: 17, column }, runner);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= SPEC_TOOL_ANSWER_BYTES);
    assert.ok(result.lines.every(line => line.startsWith('17  ')));
    text += result.lines[0].slice(4);
    if (result.next === undefined) break;
    assert.ok(result.nextColumn > column);
    column = result.nextColumn;
  } while (column < body.length);
  assert.equal(text, body);
});
