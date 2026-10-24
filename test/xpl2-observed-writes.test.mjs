/**
 * XPL2 observed writes, recorded by the hooks an explicit SFlow Copilot turn already runs: the
 * pre-tool guard notes an allowed edit before it runs, and the session's next pre-tool call (or its
 * next prompt or end) reads the files again. `--subject line` credits a writer only for the lines its
 * own before and after bytes differ in, and only lines the tool's arguments explain.
 *
 * Every write goes through the real guard (`mutationToolGuard`) with the payload shapes the Copilot
 * runtime sends; the "tool" is this test writing the file between the two hook calls.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { endRepositoryBoundaryTurn, recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationToolGuard } from '../src/copilot-mutation-guard.mjs';
import { readGenerationSources } from '../src/comprehension/xpl2/clause-sources.mjs';
import { readLineWriter } from '../src/comprehension/xpl2/line-writer.mjs';
import { recordObservedWrite, readObservedWrites, xpl2ObservedWriteDirectory } from '../src/comprehension/xpl2/observed-writes.mjs';
import { xpl2LineHunks } from '../src/comprehension/xpl2/observed-write-recorder.mjs';
import { explainXpl2Subject, xpl2LineHistoryRequest } from '../src/comprehension/xpl2/subjects.mjs';
import { attributeLineWriter } from '../src/comprehension/xpl2/writer-attribution.mjs';
import { isAncestor, lineCommitAt, worktreeBytesAtRevision } from '../src/git.mjs';
import { xpl2InputFor } from './helpers/xpl2-fixture.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const numbered = (count, render) => `${Array.from({ length: count }, (_, index) => render(index + 1)).join('\n')}\n`;
const BASELINE = numbered(12, (n) => `const v${n} = ${n};`);

async function fixture(t, { file = 'src/app.js', content = BASELINE, configure = null } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-writes-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, path.dirname(file)), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Writes Tester'); git('config', 'user.email', 'writes@example.test');
  if (configure) configure(git);
  await writeFile(path.join(root, file), content);
  const phase = { id: 'implementation', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code', requirement: 'required' }, generationIntent: { status: 'open', generation: 1 } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: [] } };
  const workflow = { workItem: { id: 'WRT-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  const workflowFile = path.join(root, definition.workItemRoot, 'WRT-1', 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git('add', '.'); git('commit', '-qm', 'baseline');
  const base = git('rev-parse', 'HEAD');
  const accepted = { definition, workflow };
  const boundaries = path.join(directory, 'machine', 'copilot-boundaries');
  /** One explicit /sf-code turn of one Copilot session; returns its payload. */
  const turn = async (sessionId, extra = {}) => {
    const payload = { cwd: root, sessionId, prompt: '/sf-code', ...extra };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  /** The guard runs before the tool; the tool writes; the next guard call of the session settles. */
  const call = async (payload, toolName, toolArgs, write = null) => {
    const decision = await mutationToolGuard({ ...payload, toolName, toolArgs });
    if (write) await write();
    assert.deepEqual(await mutationToolGuard({ ...payload, toolName: 'view', toolArgs: { path: path.join(root, file) } }), {});
    return decision;
  };
  const edit = async (payload, before, after, target = file) => call(payload, 'edit', { path: path.join(root, target), old_str: before, new_str: after },
    async () => writeFile(path.join(root, target), (await readFile(path.join(root, target), 'utf8')).replace(before, after)));
  const view = async (line, side = 'after', target = file) => {
    const { input, diff } = await xpl2InputFor(root, base);
    const query = { subject: 'line', path: target, line, side };
    const request = xpl2LineHistoryRequest({ codeExplanation: input.codeExplanation, diff, context: input.context }, query);
    const history = { request, result: request?.kind === 'baseline' ? lineCommitAt(root, request.revision, request.path, request.line) : null };
    const writer = await readLineWriter(readers(input.manifest, base, git('rev-parse', 'HEAD')), query, history);
    return { writer, model: explainXpl2Subject(input, query, { lineHistory: history, lineWriter: writer }) };
  };
  const readers = (manifest, baselineCommit, headCommit) => ({
    manifest, baselineCommit, headCommit, gitDirectory: path.join(root, '.git'),
    readBytes: (revision, target) => worktreeBytesAtRevision(root, revision, target),
    isAncestor: (older, newer) => isAncestor(root, older, newer)
  });
  /** Ask about a committed line through blame at HEAD (the capture's baseline is HEAD itself). */
  const blamed = async (line, target = file) => {
    const head = git('rev-parse', 'HEAD');
    const { input, diff } = await xpl2InputFor(root, head);
    const query = { subject: 'line', path: target, line, side: 'before' };
    const request = xpl2LineHistoryRequest({ codeExplanation: input.codeExplanation, diff, context: input.context }, query);
    const history = { request, result: lineCommitAt(root, request.revision, request.path, request.line) };
    const writer = await readLineWriter(readers(input.manifest, head, head), query, history);
    return { writer, history, model: explainXpl2Subject(input, query, { lineHistory: history, lineWriter: writer }) };
  };
  return { root, git, base, turn, call, edit, view, blamed, boundaries, gitDirectory: path.join(root, '.git'), file };
}

const derived = (model, kind) => model.derived.filter((entry) => entry.kind === kind);
const records = async (f) => (await readObservedWrites(f.gitDirectory, { paths: [f.file] })).records;

test('XPL2 observed writes: a line is credited to the turn whose checked write changed it last, line by line', async (t) => {
  const f = await fixture(t);
  const first = await f.turn('session-one');
  assert.deepEqual(await f.edit(first, 'const v3 = 3;', 'const v3 = 300;'), {}, 'noting an edit never changes the decision');
  await f.edit(first, 'const v4 = 4;', 'const v4 = 4;\nconst v4b = 40;');
  const second = await f.turn('session-two');
  await f.edit(second, 'const v9 = 9;', 'const v9 = 900;');
  assert.deepEqual(await readdir(f.boundaries).then((names) => names.filter((name) => name.includes('pending'))), [], 'every note is settled');

  const stored = await records(f);
  assert.equal(stored.length, 3);
  assert.equal(stored[0].writer.skill, 'sf-code');
  assert.deepEqual(stored[0].subject, { workId: 'WRT-1', phase: 'implementation', generation: 1 });
  assert.equal(stored[0].head, f.base);
  assert.equal(stored[0].branch, 'main');
  assert.deepEqual(stored[0].files, [{ path: 'src/app.js', verified: true, before: sha(BASELINE),
    after: sha(BASELINE.replace('const v3 = 3;', 'const v3 = 300;')), steps: [[3, 1, 3, 1]] }]);
  assert.deepEqual(stored[1].files[0].steps, [[5, 0, 5, 1]], 'only the inserted line, not the unchanged one beside it');
  const text = (await readdir(xpl2ObservedWriteDirectory(f.gitDirectory))).length
    ? await readFile(path.join(xpl2ObservedWriteDirectory(f.gitDirectory), (await readdir(xpl2ObservedWriteDirectory(f.gitDirectory)))[0]), 'utf8') : '';
  assert.doesNotMatch(text, /const v|= 300|old_str|new_str|session-one|"lines"/u, 'paths, digests and ranges only');

  const three = await f.view(3);
  assert.equal(three.writer.status, 'attributed');
  const [statement] = derived(three.model, 'line-writer');
  assert.match(statement.text, /^After-side line 3 of src\/app\.js holds bytes that recorded write OW-[a-f0-9]{16} \(edit\) left, by the \/sf-code turn [a-f0-9]{8} of Copilot session [a-f0-9]{16}, for Story WRT-1, step implementation, generation 1\./u);
  assert.equal(derived(three.model, 'provenance-unavailable').length, 0);
  assert.equal((await f.view(5)).writer.writer.turn, three.writer.writer.turn);
  const kept = await f.view(4);
  assert.deepEqual([kept.writer.span, kept.writer.basis], ['commit', 'bytes-not-left-by-a-recorded-write'], 'the line the insertion kept is the baseline commit\'s');
  assert.match(derived(kept.model, 'line-writer-unestablished')[0].text, /The line was last changed in commit [a-f0-9]{12}; this machine holds 3 recorded writes of the file\./u);
  const ten = await f.view(10);
  assert.equal(ten.writer.status, 'attributed');
  assert.notEqual(ten.writer.writer.session, three.writer.writer.session);

  const workflow = { workItem: { id: 'WRT-1' }, phaseOrder: ['implementation'], phases: { implementation: { status: 'in_progress', generation: 1 } } };
  const sources = await readGenerationSources(f.root, workflow, { phase: 'implementation', generation: 1 });
  assert.equal(sources.writes.records.length, 3);
  const { input } = await xpl2InputFor(f.root, f.base, { workflow });
  const generation = explainXpl2Subject(input, { subject: 'generation', phase: 'implementation', generation: 1 }, { generationSources: sources });
  assert.equal(derived(generation, 'generation-write').length, 3);
});

test('XPL2 review 1: a whole-file rewrite is credited only for the lines it changed, never a person\'s line it kept', async (t) => {
  const f = await fixture(t);
  // A person (unrecorded) edits line 5, then the turn rewrites the whole file, changing only line 9.
  await writeFile(path.join(f.root, f.file), BASELINE.replace('const v5 = 5;', 'const v5 = 55;'));
  const payload = await f.turn('session-one');
  const content = BASELINE.replace('const v5 = 5;', 'const v5 = 55;').replace('const v9 = 9;', 'const v9 = 99;');
  await f.call(payload, 'create', { path: path.join(f.root, f.file), file_text: content }, () => writeFile(path.join(f.root, f.file), content));
  const [record] = await records(f);
  assert.deepEqual(record.files[0].steps, [[9, 1, 9, 1]]);
  assert.equal((await f.view(9)).writer.status, 'attributed');
  const five = await f.view(5);
  assert.equal(five.writer.basis, 'recorded-writes-incomplete', 'line 5 came from an unrecorded change');
  assert.match(derived(five.model, 'line-writer-unestablished')[0].text, /an unrecorded change came in between/u);
});

test('XPL2 review 4: deletions are checked by bytes, and an unchecked write leaves only its own lines unestablished', async (t) => {
  const f = await fixture(t);
  const payload = await f.turn('session-one');
  await f.edit(payload, 'const v2 = 2;\n', '');
  const [deletion] = await records(f);
  assert.deepEqual([deletion.files[0].verified, deletion.files[0].steps], [true, [[2, 1, 2, 0]]], 'an empty new_str is a checked deletion');
  // An edit tool whose effect the arguments cannot say: kept, but only its changed lines are unverified.
  const target = path.join(f.root, f.file);
  await f.call(payload, 'insert_edit_into_file', { filePath: target, code: '// ...existing code...' },
    async () => writeFile(target, (await readFile(target, 'utf8')).replace('const v6 = 6;', 'const v6 = 66;')));
  await f.edit(payload, 'const v10 = 10;', 'const v10 = 1000;');
  const stored = await records(f);
  assert.deepEqual([stored[1].files[0].verified, stored[1].files[0].steps], [false, [[5, 1, 5, 1]]]);
  assert.equal((await f.view(5)).writer.basis, 'unverified-write', 'the unchecked line itself');
  assert.equal((await f.view(9)).writer.status, 'attributed', 'a later checked line is still credited');
  assert.deepEqual([(await f.view(3)).writer.span, (await f.view(3)).writer.basis], ['commit', 'bytes-not-left-by-a-recorded-write'], 'lines outside the writes are the baseline commit\'s');
  // A person editing between the tool and the next hook call makes the call's bytes unexplained.
  await f.call(payload, 'edit', { path: target, old_str: 'const v11 = 11;', new_str: 'const v11 = 110;' }, async () => {
    await writeFile(target, (await readFile(target, 'utf8')).replace('const v11 = 11;', 'const v11 = 110;').replace('const v1 = 1;', 'const v1 = 100;'));
  });
  const last = (await records(f)).at(-1).files[0];
  assert.equal(last.verified, false);
  assert.deepEqual(last.steps, [[1, 1, 1, 1], [10, 1, 10, 1]]);
});

test('XPL2 review 5: VS Code replacements[] and snake_case hook payloads are recorded', async (t) => {
  const f = await fixture(t);
  const payload = await f.turn('session-one');
  const target = path.join(f.root, f.file);
  const replacements = [{ filePath: target, oldString: 'const v2 = 2;', newString: 'const v2 = 20;' },
    { filePath: target, oldString: 'const v7 = 7;', newString: 'const v7 = 70;' }];
  await f.call(payload, 'multi_replace_string_in_file', { replacements },
    async () => writeFile(target, (await readFile(target, 'utf8')).replace('const v2 = 2;', 'const v2 = 20;').replace('const v7 = 7;', 'const v7 = 70;')));
  assert.deepEqual((await records(f))[0].files[0].steps, [[2, 1, 2, 1], [7, 1, 7, 1]]);
  assert.equal((await records(f))[0].files[0].verified, true);
  // snake_case: session_id, tool_name and tool_input.
  const snake = { cwd: f.root, session_id: 'session-one' };
  await mutationToolGuard({ ...snake, tool_name: 'replace_string_in_file', tool_input: { filePath: target, oldString: 'const v8 = 8;', newString: 'const v8 = 80;' } });
  await writeFile(target, (await readFile(target, 'utf8')).replace('const v8 = 8;', 'const v8 = 80;'));
  await mutationToolGuard({ ...snake, tool_name: 'view', tool_input: { path: target } });
  assert.equal((await records(f)).length, 2);
  assert.equal((await f.view(8)).writer.status, 'attributed');
});

test('XPL2 review 2: records bind to the commit they were made on, and two writers of the same bytes are ambiguous', async (t) => {
  const f = await fixture(t);
  // The turn works on a main-only commit, so another branch from the baseline does not contain it.
  await writeFile(path.join(f.root, 'NOTES.md'), 'main only\n');
  f.git('add', 'NOTES.md');
  f.git('commit', '-qm', 'main only');
  const payload = await f.turn('session-one');
  await f.edit(payload, 'const v3 = 3;', 'const v3 = 300;');
  f.git('commit', '-qam', 'deliver on main');
  assert.equal((await f.blamed(3)).writer.status, 'attributed');
  // The same change made on another branch that does not descend from the recorded commit.
  f.git('checkout', '-q', '-b', 'other', f.base);
  f.git('commit', '-q', '--allow-empty', '-m', 'diverge');
  await writeFile(path.join(f.root, f.file), BASELINE.replace('const v3 = 3;', 'const v3 = 300;'));
  f.git('commit', '-qam', 'same bytes elsewhere');
  const elsewhere = await f.blamed(3);
  assert.equal(elsewhere.writer.status, 'unestablished');
  assert.equal(elsewhere.writer.basis, 'no-recorded-writes', 'a record made on main says nothing about this branch');

  const write = (id, turn) => ({ id, writer: { kind: 'copilot-turn', session: 's', turn }, head: 'h', files: [{ path: 'f', verified: true, before: 'b', after: 'e', steps: [[1, 1, 1, 1]] }] });
  assert.equal(attributeLineWriter({ records: [write('OW-1', 't1'), write('OW-2', 't2')], path: 'f', start: { sha256: 'b' }, end: 'e', line: 1 }).basis, 'several-writers');
  assert.equal(attributeLineWriter({ records: [write('OW-1', 't1'), write('OW-2', 't1')], path: 'f', start: { sha256: 'b' }, end: 'e', line: 1 }).status, 'attributed');
});

test('XPL2 review 6: CRLF checkouts match through checkout bytes, and LF arguments match a CRLF file', async (t) => {
  const crlf = BASELINE.replaceAll('\n', '\r\n');
  const f = await fixture(t, { content: crlf, configure: (git) => git('config', 'core.autocrlf', 'true') });
  const payload = await f.turn('session-one');
  const target = path.join(f.root, f.file);
  await f.call(payload, 'edit', { path: target, old_str: 'const v3 = 3;\nconst v4 = 4;', new_str: 'const v3 = 30;\nconst v4 = 40;' },
    async () => writeFile(target, (await readFile(target, 'utf8')).replace('const v3 = 3;\r\nconst v4 = 4;', 'const v3 = 30;\r\nconst v4 = 40;')));
  const [record] = await records(f);
  assert.deepEqual([record.files[0].verified, record.files[0].steps], [true, [[3, 2, 3, 2]]]);
  assert.equal((await f.view(3)).writer.status, 'attributed');
  f.git('commit', '-qam', 'deliver');
  assert.equal((await f.blamed(4)).writer.status, 'attributed', 'the committed LF blob is compared as CRLF');
});

test('XPL2 review 7: a quoted (non-ASCII) path from blame still finds its records', async (t) => {
  const f = await fixture(t, { file: 'src/données.js' });
  const payload = await f.turn('session-one');
  await f.edit(payload, 'const v5 = 5;', 'const v5 = 50;');
  f.git('commit', '-qam', 'deliver');
  const { writer, history } = await f.blamed(5);
  assert.equal(history.result.filename, 'src/données.js');
  assert.equal(writer.status, 'attributed');
});

test('XPL2 review 8: a full day writes its marker exclusively and never through a planted link', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-full-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = xpl2ObservedWriteDirectory(directory);
  await mkdir(store, { recursive: true });
  const now = Date.parse('2026-10-20T12:00:00.000Z');
  await writeFile(path.join(store, '2026-10-20.jsonl'), 'x'.repeat(1 << 20));
  const victim = path.join(directory, 'victim.txt');
  await writeFile(victim, 'keep');
  await symlink(victim, path.join(store, '2026-10-20.full'));
  const files = [{ path: 'a', verified: true, before: 'b', after: 'c', steps: [] }];
  assert.equal(await recordObservedWrite(directory, { source: 'test', tool: 'edit', writer: {}, files }, { now }), null);
  assert.equal(await readFile(victim, 'utf8'), 'keep');
  assert.ok((await lstat(path.join(store, '2026-10-20.full'))).isSymbolicLink());
});

test('XPL2 observed writes: unchanged notes wait, a turn end settles them, and line hunks are minimal', async (t) => {
  const f = await fixture(t);
  const payload = await f.turn('session-one');
  const target = path.join(f.root, f.file);
  // The guard notes the edit, but the tool has not run when the next call settles: it stays noted.
  await mutationToolGuard({ ...payload, toolName: 'edit', toolArgs: { path: target, old_str: 'const v2 = 2;', new_str: 'const v2 = 22;' } });
  await mutationToolGuard({ ...payload, toolName: 'view', toolArgs: { path: target } });
  assert.equal((await readdir(f.boundaries)).filter((name) => name.includes('pending')).length, 1);
  await writeFile(target, (await readFile(target, 'utf8')).replace('const v2 = 2;', 'const v2 = 22;'));
  await endRepositoryBoundaryTurn(payload);
  assert.equal((await readdir(f.boundaries)).filter((name) => name.includes('pending')).length, 0);
  assert.equal((await records(f)).length, 1);
  // A denied edit is never noted.
  const other = await f.turn('session-two');
  const denied = await mutationToolGuard({ ...other, toolName: 'edit', toolArgs: { path: path.join(f.root, '.git', 'config'), old_str: 'a', new_str: 'b' } });
  assert.equal(denied.permissionDecision, 'deny');
  assert.equal((await readdir(f.boundaries)).filter((name) => name.includes('pending')).length, 0);

  assert.deepEqual(xpl2LineHunks(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'D']), [[2, 1, 2, 1], [4, 1, 4, 1]]);
  assert.deepEqual(xpl2LineHunks(['a', 'b'], ['a', 'x', 'b']), [[2, 0, 2, 1]]);
  assert.deepEqual(xpl2LineHunks(['a', 'b', 'c'], ['a', 'c']), [[2, 1, 2, 0]]);
  assert.deepEqual(xpl2LineHunks([], ['x']), [[1, 0, 1, 1]]);
});
