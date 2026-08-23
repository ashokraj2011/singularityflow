import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_MODEL_PROMPT_MAXIMUM_BYTES, stageModelPrompt
} from '../src/model-prompt-transport.mjs';

test('text and file prompts produce byte-identical private snapshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-stage-equivalence-'));
  const value = 'ASCII and multibyte: नमस्ते 🌍\n';
  const source = path.join(root, 'source prompt ü.md');
  await writeFile(source, value);
  const text = await stageModelPrompt({ text: value }, { tempRoot: root });
  const file = await stageModelPrompt({ file: source }, { tempRoot: root });
  try {
    assert.equal(text.sha256, file.sha256);
    assert.equal(text.bytes, file.bytes);
    assert.deepEqual(await readFile(text.file), await readFile(file.file));
    assert.equal(text.encoding, 'utf-8');
    const directoryMode = (await lstat(text.directory)).mode & 0o777;
    const fileMode = (await lstat(text.file)).mode & 0o777;
    if (process.platform !== 'win32') {
      assert.equal(directoryMode, 0o700);
      assert.equal(fileMode, 0o600);
    }
  } finally {
    await text.cleanup();
    await file.cleanup();
  }
  await text.cleanup();
  await assert.rejects(access(text.directory));
  await assert.rejects(access(file.directory));
});

test('prompt staging enforces the exact byte boundary and UTF-8 validity', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-stage-policy-'));
  const accepted = await stageModelPrompt({ text: 'x'.repeat(DEFAULT_MODEL_PROMPT_MAXIMUM_BYTES) }, { tempRoot: root });
  assert.equal(accepted.bytes, DEFAULT_MODEL_PROMPT_MAXIMUM_BYTES);
  await accepted.cleanup();
  await assert.rejects(
    () => stageModelPrompt({ text: 'x'.repeat(DEFAULT_MODEL_PROMPT_MAXIMUM_BYTES + 1) }, { tempRoot: root }),
    (error) => error.code === 'MODEL_PROMPT_LIMIT'
  );
  const invalid = path.join(root, 'invalid.md');
  await writeFile(invalid, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    () => stageModelPrompt({ file: invalid }, { tempRoot: root }),
    (error) => error.code === 'MODEL_PROMPT_ENCODING_INVALID'
  );
});

test('a staged prompt remains an immutable snapshot when its source changes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-stage-snapshot-'));
  const source = path.join(root, 'request.md');
  await writeFile(source, 'first bytes');
  const staged = await stageModelPrompt({ file: source }, { tempRoot: root });
  try {
    await writeFile(source, 'replacement bytes');
    assert.equal(await readFile(staged.file, 'utf8'), 'first bytes');
  } finally { await staged.cleanup(); }
});
