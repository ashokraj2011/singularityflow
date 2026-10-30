/**
 * Every configuration draft has a correct state and a way out (SDA sweep, batch 2).
 *
 * A draft's relation to the approved configuration can change after it is saved: another clone
 * approves the same change, approves something it conflicts with, or the proposal holding it is
 * merged or closed on the Git host. Each of those used to strand the draft: proposing it failed or
 * proposed nothing and kept it, Workflow Studio could not publish anything while it waited, and a
 * proposal whose upload failed or whose branch was deleted left it listed forever. These tests check
 * each draft against a real approved configuration (a Studio plan of a repository's working tree).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { initializeDefinition } from '../src/config.mjs';
import {
  approveProposal, authorChange, describeChange, draftLines, draftNotice, draftStandings, draftsDirectory, proposeDrafts, readDrafts,
  runWithDrafts
} from '../src/configuration-drafts.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA as SET } from '../src/workflow-studio.mjs';
import { SingularityFlowError } from '../src/util.mjs';

const AUTHORITY = { kind: 'approved-configuration-ref', ref: 'refs/remotes/origin/sflow/config', commit: 'b'.repeat(40) };
const BRANCH = 'sflow/config-change/workflow/studio-other-12345678-123456789abc';

/** A repository whose working tree stands in for the approved configuration, already holding `tone`. */
async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-drafts-standing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  await initializeDefinition(root);
  const written = await planStudioChangeSet(root, { schema: SET, changes: [tone()] }, { write: true });
  assert.equal(written.valid, true, JSON.stringify(written.problems));
  return root;
}

// Labelled, as an edit writes them: an edit of an instruction created with no label writes its
// derived label, which is a change of the file.
const tone = (instructions = 'Be kind.') => ({ op: 'instruction.create', id: 'tone', label: 'Tone', description: 'Tone.', instructions });
const other = () => ({ op: 'instruction.create', id: 'other', label: 'Other', description: 'Other.', instructions: 'Other text.' });
const edit = (id, instructions) => ({ op: 'instruction.update', id, instructions });

/** Save drafts as they were saved before the approved configuration moved: each checked then, unchecked now. */
async function saved(root, changes) {
  for (const change of changes) {
    const result = await authorChange(root, { schema: SET, changes: [change] }, {
      subject: change.id, message: 'm', apply: async () => assert.fail('a draft save applies nothing'),
      check: async () => ({ plan: { valid: true, summary: [describeChange(change)], warnings: [] }, source: AUTHORITY })
    });
    assert.equal(result.saved, 'new');
  }
  return readDrafts(root);
}

/** Plans against the approved configuration (here the working tree), as the CLI's planner does. */
const plannerFor = (root) => async (work) => work((set) => planStudioChangeSet(root, set), AUTHORITY);
const studioRefusal = () => new SingularityFlowError("Workflow Studio changes were not applied: Instruction 'tone' already exists.", { code: 'STUDIO_CHANGES_INVALID' });

test('each draft is checked against the approved configuration: waiting, already approved, redundant, or in conflict', async t => {
  const root = await repository(t);
  const drafts = await saved(root, [tone(), other(), edit('other', 'Other text.'), edit('tone', 'Be kind.'), edit('gone', 'x'), tone('Be blunt.')]);
  const standings = await draftStandings(drafts.changes, (set) => planStudioChangeSet(root, set));
  assert.deepEqual(standings.map((entry) => [entry.number, entry.standing]), [
    [1, 'already-approved'], [2, 'waiting'], [3, 'redundant'], [4, 'already-approved'], [5, 'conflicts'], [6, 'conflicts']]);
  assert.match(standings[4].problem, /Instruction 'gone' does not exist/);
  assert.match(standings[5].problem, /Instruction 'tone' already exists, with other content than this draft\./);
  const text = draftLines(drafts, standings).join('\n');
  assert.match(text, /1\. New instruction Tone \(tone\) \(already approved: the approved configuration has it, so proposing settles it\)/);
  assert.match(text, /5\. Edit instruction gone\n {5}Conflicts with the approved configuration: Instruction 'gone' does not exist\.\n {5}Discard it: singularity-flow configuration discard cdr-[0-9a-f]{24}\n/);
  assert.match(text, /Next: discard or replace the drafts that conflict, then singularity-flow configuration propose/);
  // One conflict alone is named by its number in this listing.
  const one = await draftStandings(drafts.changes.slice(0, 5), (set) => planStudioChangeSet(root, set));
  assert.match(draftLines({ ...drafts, changes: drafts.changes.slice(0, 5), listing: 'abc123abc123' }, one).join('\n'),
    /Discard it: singularity-flow configuration discard 5 --listing abc123abc123\n/);
});

test('propose settles the drafts approved elsewhere and proposes the rest; with nothing left it says so', async t => {
  const root = await repository(t);
  await saved(root, [tone(), other()]);
  const calls = [];
  const apply = async (set) => {
    calls.push(set.changes.map((change) => change.id));
    if (calls.length === 1) throw studioRefusal();
    return { reviewRequired: true, branch: BRANCH, commit: 'c'.repeat(40), files: [] };
  };
  const result = await proposeDrafts(root, { apply, planner: plannerFor(root) });
  assert.deepEqual(calls, [['tone', 'other'], ['other']], 'the approved draft is left out and the rest proposed');
  assert.deepEqual(result.drafts, { pending: 0, included: 1, settled: ['New instruction Tone (tone)'] });
  assert.equal(result.nextAction, `singularity-flow configuration approve ${BRANCH}`);
  const after = await readDrafts(root);
  assert.deepEqual(after.changes, []);
  assert.deepEqual(after.proposed.held.map((draft) => draft.change.id), ['other'], 'the proposal holds the drafts it carries');

  // Every draft approved elsewhere: nothing is proposed, and nothing stays waiting.
  const again = await repository(t);
  await saved(again, [tone(), edit('tone', 'Be kind.')]);
  const settled = await proposeDrafts(again, { apply: async () => { throw studioRefusal(); }, planner: plannerFor(again) });
  assert.equal(settled.drafts.nothingToPropose, true);
  assert.deepEqual(settled.drafts.settled, ['New instruction Tone (tone)', 'Edit instruction tone']);
  assert.deepEqual((await readDrafts(again)).changes, []);

  // A batch the approved configuration already holds is proposed as nothing: its drafts are settled.
  const noop = await repository(t);
  await saved(noop, [edit('tone', 'Be kind.')]);
  const unchanged = await proposeDrafts(noop, { apply: async () => ({ valid: true, changed: false, reviewRequired: false, branch: null, files: [],
    summary: ['Updated reusable instruction Tone.'] }), planner: plannerFor(noop) });
  assert.equal(unchanged.drafts.nothingToPropose, true);
  assert.equal(unchanged.nextAction, null);
  assert.deepEqual((await readDrafts(noop)).changes, []);
});

test('a draft that conflicts is named with its discard route, and nothing is proposed or dropped', async t => {
  const root = await repository(t);
  const drafts = await saved(root, [tone('Be blunt.'), other()]);
  let attempts = 0;
  await assert.rejects(proposeDrafts(root, { apply: async () => { attempts += 1; throw studioRefusal(); }, planner: plannerFor(root) }), (error) => {
    assert.equal(error.code, 'STUDIO_CHANGES_INVALID');
    assert.match(error.message, /A saved draft no longer applies to the approved configuration, so nothing was proposed:\n {2}1\. New instruction Tone \(tone\): Instruction 'tone' already exists, with other content than this draft\./);
    assert.match(error.message, new RegExp(`Discard it: singularity-flow configuration discard 1 --listing ${drafts.listing}`));
    assert.equal(error.details.nextAction.command, `singularity-flow configuration discard 1 --listing ${drafts.listing}`);
    assert.deepEqual(error.details.conflicts.map((entry) => entry.draftId), [drafts.changes[0].draftId]);
    return true;
  });
  assert.equal(attempts, 1, 'a batch with a conflicting draft is not proposed again without it');
  assert.equal((await readDrafts(root)).changes.length, 2);
});

test('a proposal whose upload failed holds its drafts; a proposal gone from the remote is recorded or gives its drafts back', async t => {
  const root = await repository(t);
  await saved(root, [other()]);
  const pending = new SingularityFlowError('Workflow proposal was retained but publication is needs-user.', {
    code: 'CONFIGURATION_PROPOSAL_PUBLICATION_PENDING', details: { branch: BRANCH, commit: 'c'.repeat(40), intentId: 'psh_upload' } });
  await assert.rejects(proposeDrafts(root, { apply: async () => { throw pending; }, planner: plannerFor(root) }), { code: 'CONFIGURATION_PROPOSAL_PUBLICATION_PENDING' });
  const held = await readDrafts(root);
  assert.deepEqual(held.changes, [], 'the drafts are not offered again while the proposal waits for its upload');
  assert.equal(held.proposed.branch, BRANCH);
  assert.deepEqual(held.proposed.upload, { intentId: 'psh_upload' });
  assert.match(draftLines(held).join('\n'), /Its upload has not finished; finish it first: singularity-flow sync psh_upload/);

  const gone = async () => { throw new SingularityFlowError(`Workflow proposal '${BRANCH}' is no longer advertised.`, { code: 'WORKFLOW_PROPOSAL_UNAVAILABLE' }); };
  const deps = (status, upload) => ({ yes: true, print: () => {}, list: async () => [], inspect: gone,
    activate: async () => assert.fail('nothing is activated'), status: async () => status, upload: async () => upload });
  // Not uploaded yet: finish the upload first; the drafts stay held.
  await assert.rejects(approveProposal(root, null, deps({ merged: false, branchStatus: 'absent' }, { status: 'needs-user' })), (error) =>
    error.code === 'CONFIGURATION_PROPOSAL_PUBLICATION_PENDING' && error.details.nextAction === 'singularity-flow sync psh_upload');
  assert.equal((await readDrafts(root)).proposed.branch, BRANCH);
  // Uploaded, then closed without being merged: the drafts are waiting again, and proposing is the way on.
  await assert.rejects(approveProposal(root, null, deps({ merged: false, branchStatus: 'absent' }, { status: 'succeeded' })), (error) =>
    error.code === 'CONFIGURATION_APPROVE_NOTHING' && error.details.nextAction === 'singularity-flow configuration propose'
      && /The draft it held is waiting again: New instruction Other \(other\)\./.test(error.message));
  const back = await readDrafts(root);
  assert.deepEqual(back.changes.map((draft) => draft.change), [other()]);
  assert.equal(back.proposed, null);

  // Proposed again, merged by the Git host, which deleted the branch: approving records it.
  await proposeDrafts(root, { apply: async () => ({ reviewRequired: true, branch: BRANCH, commit: 'd'.repeat(40), files: [] }), planner: plannerFor(root) });
  const printed = [];
  const merged = await approveProposal(root, null, { ...deps({ merged: true, targetBranch: 'sflow/config', targetCommit: 'e'.repeat(40) }, null), print: (line) => printed.push(line) });
  assert.equal(merged.status, 'merged');
  assert.match(printed.join('\n'), /was merged into sflow\/config through your Git host, which then removed its branch\. Recorded as approved/);
  const done = await readDrafts(root);
  assert.deepEqual([done.changes, done.proposed], [[], null]);
});

test('a batch a surface builds itself is not blocked by a stale draft: it is left out, and settled once the batch is applied', async t => {
  const root = await repository(t);
  const drafts = await saved(root, [tone(), edit('gone', 'x'), other()]);
  const studio = { schema: SET, changes: [{ op: 'instruction.create', id: 'third', description: 'Third.', instructions: 'Third text.' }] };
  const preview = await runWithDrafts(root, studio, (set) => planStudioChangeSet(root, set), { planner: plannerFor(root), preview: true });
  assert.equal(preview.result.valid, true, JSON.stringify(preview.result.problems));
  assert.deepEqual(preview.included, ['New instruction Other (other)']);
  assert.deepEqual(preview.leftOut.map((entry) => [entry.number, entry.standing, entry.discard ?? null]), [
    [1, 'already-approved', null], [2, 'conflicts', `singularity-flow configuration discard 2 --listing ${drafts.listing}`]]);
  assert.equal((await readDrafts(root)).changes.length, 3, 'a preview settles nothing');
  // The proposal is refused while the stale drafts are in it, as the approved configuration refuses them.
  const applied = await runWithDrafts(root, studio, async (set) => {
    if (set.changes.some((change) => ['tone', 'gone'].includes(change.id))) throw studioRefusal();
    return { valid: true, written: set.changes.map((change) => change.id) };
  }, { planner: plannerFor(root) });
  assert.deepEqual(applied.result.written, ['other', 'third']);
  assert.deepEqual((await readDrafts(root)).changes.map((draft) => draft.change), [edit('gone', 'x')],
    'the applied draft and the one already approved are settled; the conflicting one keeps waiting');
});

test('a draft that no longer applies does not block saving or previewing another change; both name it', async t => {
  const root = await repository(t);
  const drafts = await saved(root, [tone('Be blunt.')]);
  const check = async (set) => ({ plan: await planStudioChangeSet(root, set), source: AUTHORITY });
  const named = new RegExp(`Draft 1, New instruction Tone \\(tone\\), was left out: Instruction 'tone' already exists, with other content than this draft\\. `
    + `It stays waiting; discard it: singularity-flow configuration discard 1 --listing ${drafts.listing}`);
  const result = await authorChange(root, { schema: SET, changes: [other()] }, { subject: 'other', message: 'm',
    apply: async () => assert.fail('a draft save applies nothing'), check, planner: plannerFor(root) });
  assert.equal(result.saved, 'new');
  assert.match(result.warnings.map((warning) => warning.message).join('\n'), named);
  assert.deepEqual((await readDrafts(root)).changes.map((draft) => draft.change.id), ['tone', 'other'], 'the stale draft keeps waiting');
  const third = { op: 'instruction.create', id: 'third', description: 'Third.', instructions: 'Third text.' };
  const preview = await authorChange(root, { schema: SET, changes: [third] }, { dryRun: true, subject: 'third', message: 'm',
    apply: async (set) => planStudioChangeSet(root, set), check, planner: plannerFor(root) });
  assert.equal(preview.valid, true, JSON.stringify(preview.problems));
  assert.deepEqual(preview.files.map((file) => file.path).sort(), ['singularity/instruction-library/other/INSTRUCTIONS.md', 'singularity/instruction-library/third/INSTRUCTIONS.md']);
  assert.deepEqual(preview.drafts, { pending: 2, included: 1 });
  assert.equal(preview.warnings.filter((warning) => warning.code === 'CONFIGURATION_DRAFT_LEFT_OUT').length, 1);
});

test('a change the approved configuration already holds is not saved as a draft', async t => {
  const root = await repository(t);
  const result = await authorChange(root, { schema: SET, changes: [edit('tone', 'Be kind.')] }, {
    subject: 'tone', message: 'm', apply: async () => assert.fail('nothing is applied'),
    check: async (set) => ({ plan: await planStudioChangeSet(root, set), source: AUTHORITY })
  });
  assert.equal(result.saved, 'unchanged');
  assert.deepEqual(result.drafts.unchanged, ['Edit instruction tone']);
  assert.deepEqual((await readDrafts(root)).changes, []);
});

test('a list that shows drafts never hides them without a word when the store cannot be read', async t => {
  const root = await repository(t);
  await saved(root, [other()]);
  const [draft] = (await readDrafts(root)).changes;
  const file = path.join(draftsDirectory(root), `${draft.draftId}.json`);
  await writeFile(file, (await readFile(file, 'utf8')).replace('sflow-configuration-draft@2', 'sflow-configuration-draft@3'));
  const notice = await draftNotice(root, 'instruction');
  assert.equal(notice.unavailable.code, 'SCHEMA_VERSION_FUTURE');
  assert.match(notice.lines.join('\n'), /Drafts saved on this machine are not shown: .*newer Singularity Flow.*\nSee why: singularity-flow product status/s);
});
