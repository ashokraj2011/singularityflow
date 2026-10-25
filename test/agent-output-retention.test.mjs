/**
 * A result the agent has not read yet is never lost, and a command that ran is never shown as
 * refused because its result could not be written. `[agent-output]`
 *
 * On Windows a results folder can be held by another program or the disk can be full; the write
 * then threw after the command had committed, and the agent saw a refusal for work that was done.
 * Cleanup kept the newest 160 files, so one result with many long texts deleted its own files.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { boundedAgentOutput, boundedAgentText, completeAgentResult, DEFAULT_AGENT_OUTPUT_BYTES } from '../src/agent-output.mjs';
import { agentViewOrOutput, withCliJsonOutput } from '../src/cli-json-output.mjs';
import { codePageSafeJson } from '../src/code-page-safe-json.mjs';

async function repository(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  return root;
}

/** Collect what a block writes to stderr (or stdout) without showing it. */
async function captured(stream, block) {
  const write = stream.write;
  let text = '';
  stream.write = (chunk, encoding, callback) => {
    text += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (done) queueMicrotask(done);
    return true;
  };
  try { return { value: await block(), text }; }
  finally { stream.write = write; }
}

const committed = (root) => ({ resultType: 'sflow-approval', status: 'approved', workId: 'W', repositoryPath: root,
  act: { state: 'done', said: 'Approved and committed.', do: null },
  commit: 'a'.repeat(40), review: { body: 'x'.repeat(30_000) }, history: Array.from({ length: 80 }, (_, index) => ({ index, note: 'n'.repeat(90) })) });

test('a result that cannot be written still shows the command ran, with what fits and why', async (t) => {
  const root = await repository(t, 'sflow-agent-unkept-');
  // The results folder cannot be created: a file stands where it would go.
  await mkdir(path.join(root, '.git', 'singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git', 'singularity-flow', 'agent-results'), 'not a folder');

  const { value: text, text: stderr } = await captured(process.stderr, () => boundedAgentOutput(JSON.stringify(committed(root)), { cwd: root }));
  assert.ok(Buffer.byteLength(text) <= DEFAULT_AGENT_OUTPUT_BYTES, `${Buffer.byteLength(text)} bytes`);
  const view = JSON.parse(text);
  assert.deepEqual([view.act.state, view.act.said], ['done', 'Approved and committed.'], 'the result, not a refusal');
  assert.deepEqual([view.agentOutput.retained, view.agentOutput.state, view.agentOutput.path], [false, 'detail-unavailable', undefined]);
  assert.match(view.agentOutput.writeError, /^E[A-Z]+$/u);
  assert.match(view.agentOutput.instruction, /never run it again/u);
  assert.equal(view.commit, 'a'.repeat(40), 'small fields stay');
  assert.ok(view.omittedFields.some((entry) => entry.field === 'review'));
  assert.match(stderr, /Warning: the full result could not be written \(E[A-Z]+: .*\); the command's effects stand/u);

  const literal = await captured(process.stderr, () => boundedAgentOutput(JSON.stringify(Array.from({ length: 4000 }, (_, index) => index)), { cwd: root }));
  const literalView = JSON.parse(literal.value);
  assert.deepEqual([literalView.agentOutput.literal, literalView.agentOutput.state], ['json-array', 'detail-unavailable']);
  assert.match(literalView.agentOutput.instruction, /never run it again/u);

  const plain = await captured(process.stderr, () => boundedAgentText('a line of output\n'.repeat(5000), { cwd: root }));
  assert.ok(Buffer.byteLength(plain.value) <= DEFAULT_AGENT_OUTPUT_BYTES);
  assert.match(plain.value, /\[Output not kept\] Lines 1-\d+ of 5001 are above\. The rest could not be written here; the command ran/u);
});

test('the CLI prints a committed result, never a refusal, when its view cannot be written', async (t) => {
  const root = await repository(t, 'sflow-agent-unkept-cli-');
  await mkdir(path.join(root, '.git', 'singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.git', 'singularity-flow', 'agent-results'), 'not a folder');
  const result = committed(root);
  const { value, text: stdout } = await captured(process.stdout, () => captured(process.stderr,
    () => withCliJsonOutput(true, async () => { console.log(JSON.stringify(result, null, 2)); return 'ran'; }, { forAgent: true })));
  assert.equal(value.value, 'ran', 'the command completes');
  assert.equal(JSON.parse(stdout).act.said, 'Approved and committed.');
  assert.match(value.text, /could not be written/u);

  // Any other failure to make the view prints the whole output instead of throwing.
  const fallback = await captured(process.stderr, () => agentViewOrOutput(async () => { throw Object.assign(new Error('boom'), { code: 'EBROKEN' }); }, '{"ok":true}\n'));
  assert.equal(fallback.value, '{"ok":true}\n');
  assert.match(fallback.text, /agent view could not be made \(EBROKEN\); the whole output follows/u);
});

test('cleanup keeps every file of the result just written and every result from the last day, and removes old ones whole', async (t) => {
  const root = await repository(t, 'sflow-agent-retention-');
  const directory = path.join(root, '.git', 'singularity-flow', 'agent-results');
  await mkdir(directory, { recursive: true });
  const now = new Date('2026-10-25T12:00:00.000Z');
  const stamp = (at) => at.toISOString().replace(/[:.]/gu, '-');
  const named = (kind, minutesAgo, index) => `${kind}-${stamp(new Date(now.getTime() - minutesAgo * 60_000))}-${index.toString(16).padStart(8, '0')}`;
  const old = Array.from({ length: 30 }, (_, index) => named('old', 3 * 24 * 60 + index, index));
  const recent = Array.from({ length: 50 }, (_, index) => named('recent', 60 + index, index));
  for (const base of [...old, ...recent]) {
    await writeFile(path.join(directory, `${base}.json`), '{}\n');
    await writeFile(path.join(directory, `${base}.context.text.txt`), 'kept text\n');
  }

  // One result with far more long texts than the old 160-file limit.
  const wide = { resultType: 'wide', repositoryPath: root, ...Object.fromEntries(Array.from({ length: 200 }, (_, index) => [`field${index}`, `${index} `.repeat(2_500)])) };
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(wide), { cwd: root, now }));
  const { act: _act, ...restored } = completeAgentResult(view);
  assert.deepEqual(restored, wide, 'every file of the result just written is still there');

  const names = await readdir(directory);
  for (const base of recent) assert.ok(names.includes(`${base}.json`) && names.includes(`${base}.context.text.txt`), `${base} is less than a day old`);
  assert.deepEqual(names.filter((name) => name.startsWith('old-')), [], 'results past a day and past the newest 40 go, each one whole');
});

test('JSON for a Windows shell is ASCII and parses to the same values; other platforms keep UTF-8', async () => {
  const value = { path: 'C:\\Users\\José\\Story Ω\\review.json', said: 'Approved — next: /sf-code', mark: '✅ 🎉', plain: 'ascii' };
  const text = JSON.stringify(value, null, 2);
  const safe = codePageSafeJson(text, 'win32');
  assert.match(safe, /^[\x00-\x7f]*$/u, 'every byte reads the same in any code page');
  assert.deepEqual(JSON.parse(safe), value);
  assert.match(safe, /Jos\\u00e9/u);
  assert.match(safe, /\\ud83c\\udf89/u, 'a character outside the basic plane is escaped as its surrogate pair');
  assert.equal(codePageSafeJson(text, 'darwin'), text);
  assert.equal(codePageSafeJson(text, 'linux'), text);
  const ascii = JSON.stringify({ plain: 'ascii' });
  assert.equal(codePageSafeJson(ascii, 'win32'), ascii);

  // The CLI writes every JSON result that way on Windows, agent view or not.
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  let stdout;
  try {
    ({ text: stdout } = await captured(process.stdout, () => withCliJsonOutput(true, async () => { console.log(text); })));
  } finally { Object.defineProperty(process, 'platform', platform); }
  assert.match(stdout, /^[\x00-\x7f]*$/u);
  assert.deepEqual(JSON.parse(stdout), value);
});

test('the refusal and hook writers pass their JSON through the code-page guard', async () => {
  for (const file of ['../src/cli-failure.mjs', '../src/copilot-repository-boundary.mjs', '../src/copilot-hook-runtime.mjs']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /codePageSafeJson\(/u, file);
    assert.doesNotMatch(source, /console\.log\(JSON\.stringify\(await/u, `${file} writes no unguarded JSON result`);
  }
});
