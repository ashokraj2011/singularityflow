import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSourceAnalysisCache } from '../src/source-analysis-cache.mjs';
import { scanSourceClauseTags } from '../src/source-clause-tags.mjs';
import { discoverDeclarations } from '../src/verification/adapters.mjs';
import { scanJavaScriptDeclarations } from '../src/verification/javascript-declarations.mjs';

test('source analysis keys exact content and scanner identity, and returns private snapshots', () => {
  const cached = createSourceAnalysisCache();
  let calls = 0;
  const read = (text = 'source', identity = 'schema/path/framework') => cached(text, identity,
    () => ({ nested: [{ call: ++calls }], optional: undefined }));
  const first = read();
  first.nested[0].call = 999;
  assert.deepEqual(read(), { nested: [{ call: 1 }], optional: undefined });
  const second = read();
  second.nested.push({ call: 999 });
  assert.equal(read().nested.length, 1);
  assert.equal(read('edited').nested[0].call, 2);
  assert.equal(read('source', 'new-schema/path/framework').nested[0].call, 3);
  assert.equal(read('source', 'schema/other-path/framework').nested[0].call, 4);
  assert.equal(read('source', 'schema/path/other-framework').nested[0].call, 5);
  assert.equal(read().nested[0].call, 1);
  assert.equal(calls, 5);
});

test('distinct UTF-16 source strings cannot alias through UTF-8 replacement characters', () => {
  const cached = createSourceAnalysisCache();
  let calls = 0;
  for (const text of ['\ud800', '\ud801', '\ufffd']) {
    const result = cached(text, 'scanner', () => ({ text, call: ++calls }));
    assert.equal(result.text, text);
  }
  assert.equal(calls, 3);
});

test('entries are LRU bounded and analysis failures are not cached', () => {
  const cached = createSourceAnalysisCache({ maximumEntries: 2 });
  let calls = 0;
  const read = text => cached(text, 'scanner', () => ++calls);
  assert.equal(read('a'), 1);
  assert.equal(read('b'), 2);
  assert.equal(read('a'), 1);
  assert.equal(read('c'), 3);
  assert.equal(read('a'), 1);
  assert.equal(read('b'), 4);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => cached('bad', 'scanner', () => { calls += 1; throw new Error('invalid'); }), /invalid/u);
  }
  assert.equal(calls, 6);
});

test('source, entry and total byte ceilings bypass or evict without changing results', () => {
  for (const limits of [
    { maximumEntries: 0 }, { maximumBytes: 0 }, { maximumEntryBytes: 0 },
    { maximumSourceCharacters: 2 }, { maximumEntryBytes: 1 }, { maximumBytes: 1 }
  ]) {
    const cached = createSourceAnalysisCache(limits);
    let calls = 0;
    const read = () => cached('long source', 'scanner', () => ({ value: ++calls }));
    assert.equal(read().value, 1);
    assert.equal(read().value, 2, JSON.stringify(limits));
  }
  const cached = createSourceAnalysisCache({ maximumBytes: 200 });
  let calls = 0;
  const read = text => cached(text, 'scanner', () => 'x'.repeat(40) + ++calls);
  assert.match(read('a'), /1$/u);
  assert.match(read('b'), /2$/u);
  assert.match(read('a'), /3$/u, 'the aggregate byte budget evicted the first entry');
  for (const value of [-1, NaN, Infinity, 0.5]) {
    assert.throws(() => createSourceAnalysisCache({ maximumEntries: value }), TypeError);
  }
});

test('declaration scans keep path, framework, revisions and diagnostics independent on repeat', () => {
  const text = "// @ac:REPLAY:AC-001\ntest('converts', () => { expect(255).toBe(255); });\n";
  const options = { sourcePath: 'test/hex.test.js', framework: 'vitest' };
  const first = scanJavaScriptDeclarations(text, options);
  const expected = structuredClone(first);
  first.declarations[0].clauseIds.length = 0;
  first.declarations[0].suitePath.push('poisoned');
  assert.deepEqual(scanJavaScriptDeclarations(text, options), expected);
  assert.notEqual(scanJavaScriptDeclarations(text, { ...options, sourcePath: 'test/other.test.js' })
    .declarations[0].logicalTestId, expected.declarations[0].logicalTestId);
  assert.notEqual(scanJavaScriptDeclarations(text, { ...options, framework: 'jest' })
    .declarations[0].logicalTestId, expected.declarations[0].logicalTestId);
  assert.notEqual(scanJavaScriptDeclarations(text.replace('toBe(255)', 'toBe(0)'), options)
    .declarations[0].declarationSha256, expected.declarations[0].declarationSha256);
  const malformed = text + "'unterminated";
  const gaps = scanJavaScriptDeclarations(malformed, options);
  assert.ok(gaps.fileGaps.length);
  gaps.fileGaps.length = 0;
  assert.ok(scanJavaScriptDeclarations(malformed, options).fileGaps.length);
});

test('source tag scans keep lexical provenance, legacy mode and caller edits isolated', () => {
  const text = '// @clause:REPLAY:REQ-001 explains conversion\nexport const message = "@clause:REPLAY:REQ-002";\n';
  const options = { sourcePath: 'src/hex.js' };
  const first = scanSourceClauseTags(text, options);
  assert.deepEqual(first, [{ clauseId: 'REPLAY:REQ-001', line: 1, tag: 'clause' }]);
  first[0].line = 999;
  assert.equal(scanSourceClauseTags(text, options)[0].line, 1);
  assert.deepEqual(scanSourceClauseTags(text.replace('// @clause:', '// literal '), options), []);
  const legacy = '// @clause:REQ-001 older annotation\n';
  assert.deepEqual(scanSourceClauseTags(legacy, options), []);
  assert.equal(scanSourceClauseTags(legacy, { ...options, legacy: true })[0].clauseId, 'REQ-001');
  const polyglot = '# @clause:REPLAY:REQ-003\n';
  assert.deepEqual(scanSourceClauseTags(polyglot, options), []);
  assert.equal(scanSourceClauseTags(polyglot, { sourcePath: 'src/hex.py' })[0].clauseId, 'REPLAY:REQ-003');
});

test('cached declaration analysis never skips fresh UTF-8 and filesystem security checks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-analysis-fresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = "// @ac:FRESH:AC-001\ntest('converts', () => { expect(1).toBe(1); });\n";
  const file = path.join(root, 'hex.test.js');
  const read = () => discoverDeclarations(root, 'vitest-static-v2', ['hex.test.js']);
  await writeFile(file, source);
  const first = (await read()).declarations[0];
  assert.ok(first);
  await writeFile(file, source.replace('toBe(1)', 'toBe(2)'));
  const changed = (await read()).declarations[0];
  assert.equal(changed.logicalTestId, first.logicalTestId);
  assert.notEqual(changed.declarationSha256, first.declarationSha256);
  await writeFile(file, Buffer.from([0xff]));
  assert.equal((await read()).fileGaps['hex.test.js'][0].code, 'TEST_SOURCE_NOT_UTF8');
  await writeFile(path.join(root, 'other.js'), source);
  await unlink(file);
  await symlink('other.js', file);
  await assert.rejects(read(), /symbolic|symlink/iu);
});
