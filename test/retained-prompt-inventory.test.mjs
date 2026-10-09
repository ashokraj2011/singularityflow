import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { retainedPromptInventory } from '../src/retained-prompt-inventory.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-size-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'context/prompts'), { recursive: true });
  return root;
}
const hash = value => createHash('sha256').update(value).digest('hex');

test('inventory reports sizes, exact-receipt sections and duplicates without leaking bodies or writing', async t => {
  const root = await fixture(t); const text = 'PRIVATE-BODY café and 未知';
  for (const phase of ['design', 'implementation']) {
    await writeFile(path.join(root, `context/prompts/${phase}-gen1.md`), text);
    await writeFile(path.join(root, `context/${phase}-gen1.json`), JSON.stringify({ renderedSha256: hash(text),
      promptBudget: { sections: [{ id: 'agent-skills', included: true, bytes: 12, mandatory: true }] } }));
  }
  const before = await readFile(path.join(root, 'context/design-gen1.json'));
  const result = await retainedPromptInventory(root);
  assert.equal(result.prompts.length, 2); assert.equal(result.duplicatePrompts.length, 1);
  assert.equal(result.adjacentCommonPrefixes[0].commonBytes, Buffer.byteLength(text));
  assert.equal(result.sections[0].bytes, 24);
  assert.equal(result.prompts[0].receiptStatus, 'digest-matched');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE-BODY|café|未知/);
  assert.equal(result.providerUsage, 'not-observed');
  assert.deepEqual(await readFile(path.join(root, 'context/design-gen1.json')), before);
});

test('bad or stale receipts never contribute section totals', async t => {
  const root = await fixture(t);
  for (const [phase, receipt] of [['design', '{'], ['coding', JSON.stringify({ renderedSha256: 'a'.repeat(64), promptBudget: { sections: [] } })]]) {
    await writeFile(path.join(root, `context/prompts/${phase}-gen1.md`), 'payload');
    await writeFile(path.join(root, `context/${phase}-gen1.json`), receipt);
  }
  const result = await retainedPromptInventory(root);
  assert.deepEqual(result.sections, []);
  assert.deepEqual(new Set(result.prompts.map(entry => entry.receiptStatus)), new Set(['malformed', 'digest-mismatch']));
});

test('empty selected directories are safe and missing receipts are explicit', async t => {
  const root = await fixture(t);
  assert.deepEqual((await retainedPromptInventory(root)).prompts, []);
  await writeFile(path.join(root, 'context/prompts/design-gen1.md'), 'text');
  assert.equal((await retainedPromptInventory(root)).prompts[0].receiptStatus, 'missing');
});

test('prompt and receipt symlinks, directory symlinks, oversize files and excessive counts refuse', async t => {
  for (const target of ['prompt', 'receipt', 'directory', 'oversize', 'count']) {
    const root = await fixture(t); const file = path.join(root, 'context/prompts/design-gen1.md');
    await writeFile(file, target === 'oversize' ? Buffer.alloc(2 * 1024 * 1024 + 1) : 'text');
    if (target === 'prompt') { await rm(file); await symlink('../design-gen1.json', file); await writeFile(path.join(root, 'context/design-gen1.json'), '{}'); }
    if (target === 'receipt') await symlink('prompts/design-gen1.md', path.join(root, 'context/design-gen1.json'));
    if (target === 'directory') { await rm(path.join(root, 'context/prompts'), { recursive: true }); await symlink(root, path.join(root, 'context/prompts')); }
    if (target === 'count') for (let index = 2; index < 258; index++) await writeFile(path.join(root, `context/prompts/design-gen${index}.md`), 'x');
    await assert.rejects(retainedPromptInventory(root), { code: 'PROMPT_INVENTORY_UNSAFE' }, target);
  }
});
