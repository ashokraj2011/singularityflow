/**
 * XPL2 observed writes: the post-tool hook of an explicit SFlow turn records what a successful file
 * edit left (content digests and changed line ranges only), and `--subject line` attributes a line
 * to that writer only when the recorded writes explain the file's bytes exactly.
 *
 * Every write here goes through the real hook (`mutationPostToolGuard`) with the payload shape the
 * Copilot runtime sends; the "tool" is this test writing the file first, as the tool would.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { recordRepositoryBoundaryTurn } from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn, mutationPostToolGuard } from '../src/copilot-mutation-guard.mjs';
import { readLineWriter } from '../src/comprehension/xpl2/line-writer.mjs';
import { observeToolWrites, readObservedWrites, xpl2ObservedWriteDirectory } from '../src/comprehension/xpl2/observed-writes.mjs';
import { explainXpl2Subject, xpl2LineHistoryRequest } from '../src/comprehension/xpl2/subjects.mjs';
import { attributeLineWriter } from '../src/comprehension/xpl2/writer-attribution.mjs';
import { committedFilesAtRevisions, lineCommitAt } from '../src/git.mjs';
import { readGenerationSources } from '../src/comprehension/xpl2/clause-sources.mjs';
import { xpl2InputFor } from './helpers/xpl2-fixture.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');
const lines = (count, render) => `${Array.from({ length: count }, (_, index) => render(index + 1)).join('\n')}\n`;
const BASELINE = lines(12, (n) => `const v${n} = ${n};`);

async function fixture(t) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-writes-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Writes Tester'); git('config', 'user.email', 'writes@example.test');
  await writeFile(path.join(root, 'src', 'app.js'), BASELINE);
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
  /** One explicit /sf-code turn of one Copilot session; returns its payload. */
  const turn = async (sessionId) => {
    const payload = { cwd: root, sessionId, prompt: '/sf-code' };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  /** The tool writes the file, then the host runs the post-tool hook with the tool's own arguments. */
  const edit = async (payload, file, before, after, { resultType = 'success', toolName = 'edit' } = {}) => {
    const target = path.join(root, file);
    const current = await readFile(target, 'utf8');
    assert.ok(current.includes(before), `${before} is in ${file}`);
    await writeFile(target, current.replace(before, after));
    return mutationPostToolGuard({ ...payload, toolName, toolArgs: { path: target, old_str: before, new_str: after }, toolResult: { resultType } });
  };
  const view = async (line, side = 'after') => {
    const { input, diff } = await xpl2InputFor(root, base);
    const query = { subject: 'line', path: 'src/app.js', line, side };
    const request = xpl2LineHistoryRequest({ codeExplanation: input.codeExplanation, diff, context: input.context }, query);
    const history = { request, result: request?.kind === 'baseline' ? lineCommitAt(root, request.revision, request.path, request.line) : null };
    const writer = await readLineWriter({ manifest: input.manifest, baselineCommit: base, gitDirectory: path.join(root, '.git'), readBlobs: (requests) => committedFilesAtRevisions(root, requests) }, query, history);
    return { writer, model: explainXpl2Subject(input, query, { lineHistory: history, lineWriter: writer }) };
  };
  return { root, git, base, turn, edit, view, gitDirectory: path.join(root, '.git') };
}

const derived = (model, kind) => model.derived.filter((entry) => entry.kind === kind);

test('XPL2 observed writes: a line is attributed to the turn whose recorded write changed it last, line by line', async (t) => {
  const f = await fixture(t);
  const first = await f.turn('session-one');
  assert.deepEqual(await f.edit(first, 'src/app.js', 'const v3 = 3;', 'const v3 = 300;'), {}, 'recording never changes the decision');
  await f.edit(first, 'src/app.js', 'const v4 = 4;', 'const v4 = 4;\nconst v4b = 40;');
  const second = await f.turn('session-two');
  await f.edit(second, 'src/app.js', 'const v9 = 9;', 'const v9 = 900;');

  const store = await readObservedWrites(f.gitDirectory, { paths: ['src/app.js'] });
  assert.equal(store.records.length, 3);
  const [record] = store.records;
  assert.equal(record.writer.kind, 'copilot-turn');
  assert.equal(record.writer.skill, 'sf-code');
  assert.deepEqual(record.subject, { workId: 'WRT-1', phase: 'implementation', generation: 1 });
  assert.deepEqual(record.files, [{ path: 'src/app.js', verified: true, full: false, before: sha(BASELINE),
    after: sha(BASELINE.replace('const v3 = 3;', 'const v3 = 300;')), steps: [[3, 1, 3, 1]] }]);
  // Only paths, digests, tool names and identities are kept: never content or arguments.
  const stored = (await Promise.all((await readdir(xpl2ObservedWriteDirectory(f.gitDirectory)))
    .map((name) => readFile(path.join(xpl2ObservedWriteDirectory(f.gitDirectory), name), 'utf8')))).join('\n');
  assert.doesNotMatch(stored, /const v|= 300|old_str|new_str|session-one/u);

  const three = await f.view(3);
  assert.equal(three.writer.status, 'attributed');
  const [statement] = derived(three.model, 'line-writer');
  assert.match(statement.text, /^After-side line 3 of src\/app\.js holds bytes that recorded write OW-[a-f0-9]{16} \(edit\) left, by the \/sf-code turn [a-f0-9]{8} of Copilot session [a-f0-9]{16}, for Story WRT-1, step implementation, generation 1\. Recorded writes on this machine explain the file's bytes from the baseline to this capture exactly/u);
  assert.deepEqual(statement.limitations, ['machine-local-only']);
  assert.deepEqual([...statement.cites].sort(), ['SRC-MANIFEST', 'SRC-WRITES']);
  assert.equal(derived(three.model, 'provenance-unavailable').length, 0, 'an attributed line is not also called unestablished');
  // The inserted line belongs to the same first turn; line 10 (v9 after the insertion) to the second.
  assert.equal((await f.view(5)).writer.writer.turn, three.writer.writer.turn);
  const ten = await f.view(10);
  assert.equal(ten.writer.status, 'attributed');
  assert.notEqual(ten.writer.writer.turn, three.writer.writer.turn);
  assert.notEqual(ten.writer.writer.session, three.writer.writer.session);

  // The generation lists its recorded writes, each with who and which files; never their content.
  const workflow = { workItem: { id: 'WRT-1' }, phaseOrder: ['implementation'], phases: { implementation: { status: 'in_progress', generation: 1 } } };
  const sources = await readGenerationSources(f.root, workflow, { phase: 'implementation', generation: 1 });
  assert.equal(sources.writes.records.length, 3);
  assert.equal((await readGenerationSources(f.root, workflow, { phase: 'implementation', generation: 2 })).writes.records.length, 0);
  const { input } = await xpl2InputFor(f.root, f.base, { workflow });
  const generation = explainXpl2Subject(input, { subject: 'generation', phase: 'implementation', generation: 1 }, { generationSources: sources });
  const writes = derived(generation, 'generation-write');
  assert.equal(writes.length, 3);
  assert.match(writes[0].text, /^Recorded write OW-[a-f0-9]{16} \(edit\) by the \/sf-code turn [a-f0-9]{8} of Copilot session [a-f0-9]{16} at \S+ left 1 file \(src\/app\.js\); every one checked against the tool's own arguments\./u);
  assert.match(derived(generation, 'capture-state').find((entry) => entry.arguments.capture === 'writes').text,
    /^The observed-write record on this machine is readable \(it keeps 14 days\): 3 records for this generation\./u);
});

test('XPL2 observed writes: unrecorded, failed and unverifiable changes leave the writer unestablished with the precise reason', async (t) => {
  const f = await fixture(t);
  const payload = await f.turn('session-one');
  // A failed tool changed nothing it can be credited with; nothing is recorded.
  await f.edit(payload, 'src/app.js', 'const v2 = 2;', 'const v2 = 20;', { resultType: 'failure' });
  assert.equal((await readObservedWrites(f.gitDirectory, { paths: ['src/app.js'] })).status, 'absent');
  const none = await f.view(2);
  assert.equal(none.writer.basis, 'no-recorded-writes');
  assert.match(derived(none.model, 'provenance-unavailable')[0].text, /No admitted record establishes who or what produced this content\./u);
  assert.match(derived(none.model, 'line-writer-unestablished')[0].text, /^Who wrote src\/app\.js:2 \(after\) is not established by observed writes: this machine has no recorded write of the file\. The line was added or changed in this capture\.$/u);

  // The failed edit's bytes are still in the file: a later recorded edit cannot reach back to the baseline.
  await f.edit(payload, 'src/app.js', 'const v6 = 6;', 'const v6 = 60;');
  assert.equal((await f.view(6)).writer.basis, 'recorded-writes-incomplete');

  // A person (unrecorded) edits after the last recorded write.
  const f2 = await fixture(t);
  const turn2 = await f2.turn('session-two');
  await f2.edit(turn2, 'src/app.js', 'const v6 = 6;', 'const v6 = 60;');
  assert.equal((await f2.view(6)).writer.status, 'attributed');
  await writeFile(path.join(f2.root, 'src/app.js'), (await readFile(path.join(f2.root, 'src/app.js'), 'utf8')).replace('const v8 = 8;', 'const v8 = 80;'));
  const person = await f2.view(8);
  assert.equal(person.writer.basis, 'bytes-not-left-by-a-recorded-write');
  assert.equal((await f2.view(6)).writer.basis, 'bytes-not-left-by-a-recorded-write', 'not even the earlier recorded line is claimed by timing');

  // A replacement whose result occurs twice cannot be placed: kept, but unverified.
  const f3 = await fixture(t);
  const turn3 = await f3.turn('session-three');
  await f3.edit(turn3, 'src/app.js', 'const v11 = 11;', 'const v1 = 1;');
  const [ambiguous] = (await readObservedWrites(f3.gitDirectory, { paths: ['src/app.js'] })).records;
  assert.deepEqual(ambiguous.files.map((file) => [file.verified, file.reason]), [[false, 'ambiguous']]);
  assert.equal((await f3.view(11)).writer.basis, 'unverified-write');
});

test('XPL2 observed writes: a committed line is attributed through blame when the writes explain the commit exactly', async (t) => {
  const f = await fixture(t);
  const payload = await f.turn('session-one');
  await f.edit(payload, 'src/app.js', 'const v7 = 7;', 'const v7 = 70;');
  f.git('commit', '-qam', 'deliver');
  // The line is now in history: the capture's baseline is the new commit and nothing has changed since.
  const { input, diff } = await xpl2InputFor(f.root, f.git('rev-parse', 'HEAD'));
  const query = { subject: 'line', path: 'src/app.js', line: 7, side: 'before' };
  const request = xpl2LineHistoryRequest({ codeExplanation: input.codeExplanation, diff, context: input.context }, query);
  const history = { request, result: lineCommitAt(f.root, request.revision, request.path, request.line) };
  const writer = await readLineWriter({ manifest: input.manifest, baselineCommit: input.context.base, gitDirectory: f.gitDirectory, readBlobs: (requests) => committedFilesAtRevisions(f.root, requests) }, query, history);
  assert.equal(writer.status, 'attributed');
  assert.equal(writer.span, 'commit');
  const model = explainXpl2Subject(input, query, { lineHistory: history, lineWriter: writer });
  const [statement] = derived(model, 'line-writer');
  assert.match(statement.text, new RegExp(`Recorded writes on this machine explain commit ${history.result.commit.slice(0, 12)}'s change to the file, from its parent's bytes to the committed bytes exactly`, 'u'));
  assert.deepEqual([...statement.cites].sort(), ['SRC-LINE-HISTORY', 'SRC-WRITES']);
  // A line that commit did not change came from its parent: not the turn's.
  const other = await readLineWriter({ manifest: input.manifest, baselineCommit: input.context.base, gitDirectory: f.gitDirectory, readBlobs: (requests) => committedFilesAtRevisions(f.root, requests) },
    { ...query, line: 2 }, { request: { ...request, line: 2 }, result: lineCommitAt(f.root, request.revision, request.path, 2) });
  assert.equal(other.basis, 'bytes-not-left-by-a-recorded-write', 'line 2 was last changed by the first commit, whose bytes no recorded write left');
});

test('XPL2 observed writes: patches, whole-file writes and the pure chain rules', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-xpl2-observe-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  const before = lines(8, (n) => `line ${n}`);
  const after = before.replace('line 2\n', 'line two\n').replace('line 7\n', 'line 7\nline 7b\n');
  await writeFile(path.join(root, 'src/a.txt'), after);
  await writeFile(path.join(root, 'src/new.txt'), 'x\ny\n');
  const patch = ['*** Begin Patch', '*** Update File: src/a.txt', '@@', ' line 1', '-line 2', '+line two', ' line 3', '@@', ' line 6', ' line 7',
    '+line 7b', ' line 8', '*** Add File: src/new.txt', '+x', '+y', '*** End Patch'].join('\n');
  const files = await observeToolWrites({ root, calls: [{ name: 'apply_patch', args: { patch }, targets: [] }] });
  assert.deepEqual(files, [
    { path: 'src/a.txt', verified: true, full: false, before: sha(before), after: sha(after), steps: [[2, 1, 2, 1], [8, 0, 8, 1]] },
    { path: 'src/new.txt', verified: true, full: true, before: null, after: sha('x\ny\n'), steps: [[1, 0, 1, 2]] }
  ]);
  // A whole-file write whose content is not the file's bytes is not credited.
  const mismatch = await observeToolWrites({ root, calls: [{ name: 'create', args: { path: 'src/new.txt', file_text: 'x\n' }, targets: [] }] });
  assert.deepEqual(mismatch.map((file) => [file.verified, file.reason]), [[false, 'result-differs']]);
  // Paths outside the checkout or in Git's directory are never recorded.
  assert.deepEqual(await observeToolWrites({ root, calls: [{ name: 'create', args: { path: '../outside.txt', file_text: '' }, targets: [] }] }), []);

  const writer = (turn) => ({ kind: 'copilot-turn', session: 's', turn, skill: 'sf-code' });
  const record = (id, turn, file) => ({ id, writer: writer(turn), subject: null, tool: 'edit', files: [{ path: 'f', ...file }] });
  // Two histories reach the same bytes with different writers: no one is chosen.
  const forked = [
    record('OW-a', 't1', { verified: true, full: false, before: 'base', after: 'end', steps: [[1, 1, 1, 1]] }),
    record('OW-b', 't2', { verified: true, full: true, before: null, after: 'end', steps: [[1, 0, 1, 3]] })
  ];
  assert.equal(attributeLineWriter({ records: forked, path: 'f', start: { sha256: 'base' }, end: 'end', line: 1 }).basis, 'several-writers');
  // Both writes by one turn: attributed to that turn, with both writes named.
  const same = forked.map((entry) => ({ ...entry, writer: writer('t1') }));
  const both = attributeLineWriter({ records: same, path: 'f', start: { sha256: 'base' }, end: 'end', line: 1 });
  assert.deepEqual([both.status, both.writes.map((write) => write.id)], ['attributed', ['OW-a', 'OW-b']]);
  // A line the chain carried from the starting bytes is not anyone's write.
  const carried = attributeLineWriter({ records: [forked[0]], path: 'f', start: { sha256: 'base' }, end: 'end', line: 2 });
  assert.equal(carried.basis, 'unchanged-by-recorded-writes');
  // Starting bytes nobody recorded leaving: the chain does not reach.
  assert.equal(attributeLineWriter({ records: [forked[0]], path: 'f', start: { sha256: 'other' }, end: 'end', line: 1 }).basis, 'recorded-writes-incomplete');
});
