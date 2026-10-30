import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initializeDefinition } from '../src/config.mjs';
import {
  approveProposal, authorChange, describeChange, discardDrafts, draftLines, draftsDirectory, legacyDraftsPath, proposeDrafts, readDrafts
} from '../src/configuration-drafts.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const SET = 'sflow-studio-change-set@1';
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-drafts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  return root;
}

const skill = { op: 'skill.create', id: 'review', label: 'Review', description: 'Reviews.', instructions: 'Review it.' };
const attach = { op: 'skill.attach', skill: 'review', agent: 'qa', phases: ['verification'], use: '' };

/** A fake applier and authority, recording what the real ones would have been asked. */
function harness({ authority = true, valid = true } = {}) {
  const calls = []; const checks = [];
  return {
    calls, checks,
    apply: async (set, options = {}) => {
      calls.push({ changes: set.changes.map((change) => change.op), ...options });
      if (options.propose) return { reviewRequired: true, branch: 'sflow/config-change/workflow/studio-x', commit: 'a'.repeat(40), files: [] };
      return { valid: true, files: [{ path: 'x', action: 'create' }], summary: ['planned'] };
    },
    check: async (set, options = {}) => (checks.push(options), {
      plan: valid ? { valid: true, summary: set.changes.map(describeChange), warnings: [] }
        : { valid: false, problems: [{ message: 'There is no skill review.' }], summary: [], files: [] },
      source: authority ? { kind: 'remote', commit: 'b'.repeat(40) } : { kind: 'working-tree' }
    })
  };
}

test('with an approved configuration each change becomes a draft, checked together with the earlier drafts', async t => {
  const root = await repository(t);
  const fake = harness();
  const first = await authorChange(root, { schema: SET, changes: [skill] }, { subject: 'review', message: 'm', ...fake });
  assert.equal(first.draft, true);
  assert.deepEqual(first.drafts, { pending: 1, added: ['New skill Review (review)'], ids: [first.drafts.ids[0]] });
  assert.match(first.drafts.ids[0], /^cdr-[0-9a-f]{24}$/);
  const second = await authorChange(root, { schema: SET, changes: [attach] }, { subject: 'review', message: 'm', ...fake });
  assert.equal(second.drafts.pending, 2);
  assert.deepEqual(second.summary, ['New skill Review (review)', 'Attach skill review to agent qa in verification'],
    'the attach was checked on top of the draft that creates the skill');
  assert.deepEqual(fake.calls, [], 'saving a draft writes no configuration and proposes nothing');
  assert.deepEqual(fake.checks, [{ refreshAuthority: false }, { refreshAuthority: false }],
    'each save is checked against the configuration held on this machine, without asking the remote');
  const saved = await readDrafts(root);
  assert.deepEqual(saved.changes.map((entry) => entry.change.op), ['skill.create', 'skill.attach']);
  assert.deepEqual(saved.changes.map((entry) => entry.state), ['saved-local', 'saved-local']);
  assert.deepEqual(saved.changes[0].checkedAgainst, { commit: 'b'.repeat(40), source: 'remote' });
  assert.deepEqual(second.drafts.ids, [saved.changes[1].draftId]);
  assert.match(draftsDirectory(root), /singularity-flow[\\/]configuration-drafts[\\/]v2$/);
  assert.match(draftLines(saved).join('\n'), /2 drafts saved on this machine, not used by any Story until approved:\n {2}1\. New skill Review \(review\)/);
  assert.match(draftLines(saved).join('\n'), new RegExp(`configuration discard <NUMBER> --listing ${saved.listing} `));
});

test('without an approved configuration the change is written to the working tree as before', async t => {
  const root = await repository(t);
  const fake = harness({ authority: false });
  const result = await authorChange(root, { schema: SET, changes: [skill] }, { subject: 'review', message: 'm', ...fake });
  assert.equal(result.draft, undefined);
  assert.deepEqual(fake.calls, [{ changes: ['skill.create'], subject: 'review', message: 'm' }]);
  assert.deepEqual((await readDrafts(root)).changes, []);
});

test('a change that does not check is refused and not saved', async t => {
  const root = await repository(t);
  const result = await authorChange(root, { schema: SET, changes: [attach] }, { subject: 'review', message: 'm', ...harness({ valid: false }) });
  assert.equal(result.valid, false);
  assert.deepEqual((await readDrafts(root)).changes, []);
});

test('dry runs and --propose include the drafts; one proposal holds the whole batch and clears it', async t => {
  const root = await repository(t);
  const fake = harness();
  await authorChange(root, { schema: SET, changes: [skill] }, { subject: 'review', message: 'm', ...fake });
  const preview = await authorChange(root, { schema: SET, changes: [attach] }, { dryRun: true, subject: 'review', message: 'm', ...fake });
  assert.deepEqual(preview.drafts, { pending: 1, included: 1 });
  assert.deepEqual(fake.calls.at(-1).changes, ['skill.create', 'skill.attach']);
  const proposed = await authorChange(root, { schema: SET, changes: [attach] }, { propose: true, subject: 'review', message: 'm', ...fake });
  assert.deepEqual(fake.calls.at(-1), { changes: ['skill.create', 'skill.attach'], propose: true, subject: '2-changes',
    message: '[configuration] 2 changes: New skill Review (review); Attach skill review to agent qa in verification' });
  assert.equal(proposed.nextAction, 'singularity-flow configuration approve sflow/config-change/workflow/studio-x');
  const after = await readDrafts(root);
  assert.deepEqual(after.changes, []);
  assert.equal(after.proposed.branch, 'sflow/config-change/workflow/studio-x');
  assert.equal(after.proposed.draftIds.length, 1, 'the proposal names the one draft it holds');
  assert.equal(after.revision, 1);
  await assert.rejects(proposeDrafts(root, fake), (error) => error.code === 'CONFIGURATION_DRAFTS_EMPTY'
    && /ready for approval: singularity-flow configuration approve/.test(error.message));
});

test('drafts can be discarded by number from a list, by ID, or all together; a list that moved is refused', async t => {
  const root = await repository(t);
  const fake = harness();
  const other = { op: 'instruction.create', id: 'tone', description: 'Tone.', instructions: 'Be kind.' };
  for (const change of [skill, attach, other]) await authorChange(root, { schema: SET, changes: [change] }, { subject: 'x', message: 'm', ...fake });
  const shown = await readDrafts(root);
  await assert.rejects(discardDrafts(root, { number: 4 }), (error) => error.code === 'CONFIGURATION_DRAFT_UNKNOWN');
  const first = await discardDrafts(root, { number: 1, listing: shown.listing });
  assert.deepEqual(first.removed, ['New skill Review (review)']);
  assert.deepEqual(first.removedIds, [shown.changes[0].draftId]);
  await assert.rejects(discardDrafts(root, { number: 1, listing: shown.listing }), (error) => error.code === 'CONFIGURATION_DRAFTS_CHANGED'
    && error.outcomeClass === 'REVISION_CONFLICT' && error.details.listing === first.listing, 'the numbers of an old list mean other drafts now');
  assert.equal((await readDrafts(root)).changes.length, 2, 'nothing was dropped by the refused discard');
  await assert.rejects(discardDrafts(root, { ids: ['cdr-000000000000000000000000'] }), (error) => error.code === 'CONFIGURATION_DRAFT_UNKNOWN');
  assert.deepEqual((await discardDrafts(root, { ids: [shown.changes[2].draftId] })).removed, ['New instruction tone']);
  assert.equal((await discardDrafts(root, { all: true })).pending, 0);
  await assert.rejects(discardDrafts(root, { all: true }), (error) => error.code === 'CONFIGURATION_DRAFTS_EMPTY');
});

test('a damaged drafts file is refused and left in place, never silently emptied', async t => {
  const root = await repository(t);
  await mkdir(path.dirname(legacyDraftsPath(root)), { recursive: true });
  await writeFile(legacyDraftsPath(root), '{"schema":"other"}');
  await assert.rejects(readDrafts(root), (error) => error.code === 'CONFIGURATION_DRAFTS_INVALID');
  assert.equal(await readFile(legacyDraftsPath(root), 'utf8'), '{"schema":"other"}');
  await rm(legacyDraftsPath(root));
  await authorChange(root, { schema: SET, changes: [skill] }, { subject: 'review', message: 'm', ...harness() });
  const [entry] = (await readDrafts(root)).changes;
  const file = path.join(draftsDirectory(root), `${entry.draftId}.json`);
  await writeFile(file, (await readFile(file, 'utf8')).replace('Reviews.', 'Something else.'));
  await assert.rejects(readDrafts(root), (error) => error.code === 'CONFIGURATION_DRAFTS_INVALID' && error.details.file === file,
    'a draft whose bytes no longer match its digest is refused');
});

test('approving shows what changes, needs a yes, and activates exactly the revision that was shown', async t => {
  const root = await repository(t);
  const reviewed = { branch: 'sflow/config-change/workflow/studio-x', proposalCommit: 'c'.repeat(40), valid: true,
    changedFiles: [{ status: 'A', paths: ['singularity/skill-library/review/SKILL.md'] }], workflows: [] };
  const printed = []; const activations = [];
  const deps = {
    print: (line) => printed.push(line),
    list: async () => [{ branch: reviewed.branch, merged: false }],
    inspect: async () => reviewed,
    activate: async (_root, branch, options) => { activations.push({ branch, ...options }); return { status: 'activated', activated: true }; }
  };
  await assert.rejects(approveProposal(root, null, { ...deps }), (error) => error.code === 'CONFIGURATION_APPROVE_CONFIRMATION_REQUIRED'
    && error.message.includes(`configuration approve ${reviewed.branch} --yes`));
  assert.ok(printed.includes('  new: singularity/skill-library/review/SKILL.md'), printed.join('\n'));
  const declined = await approveProposal(root, null, { ...deps, interactive: true, ask: async () => 'n' });
  assert.equal(declined.status, 'declined');
  assert.deepEqual(activations, []);
  await approveProposal(root, null, { ...deps, interactive: true, ask: async () => 'yes' });
  assert.deepEqual(activations, [{ branch: reviewed.branch, confirm: reviewed.proposalCommit, acknowledgeUnprotected: true }]);
  await approveProposal(root, reviewed.branch, { ...deps, yes: true });
  assert.equal(activations.length, 2);
  const many = { ...deps, list: async () => [{ branch: 'one' }, { branch: 'two' }] };
  await assert.rejects(approveProposal(root, null, many), (error) => error.code === 'CONFIGURATION_APPROVE_PROPOSAL_REQUIRED'
    && /configuration approve one\n.*configuration approve two/.test(error.message));
});

test('end to end: three dependent changes become one proposal, approved with one command', async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-drafts-e2e-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const machine = path.join(base, 'machine');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Draft Author',
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'), SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'), SINGULARITY_FLOW_BOOTSTRAP_STATE: path.join(machine, 'bootstrap'),
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(machine, 'organisation-cache'), SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(machine, 'transport-outbox'),
    SINGULARITY_FLOW_BOOTSTRAP_MIN_DISK_BYTES: '1',
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Draft Author',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'draft.author@example.invalid' };
  const flow = (cwd, args, status = 0, extra = {}) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8', timeout: childTimeout(180_000) });
    assert.equal(result.status, status, `singularity-flow ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const seed = path.join(base, 'seed'); const remote = path.join(base, 'remote.git'); const checkout = path.join(base, 'checkout');
  await mkdir(seed);
  git(seed, 'init', '-q', '-b', 'main');
  await writeFile(path.join(seed, 'README.md'), '# Drafts\n');
  await initializeDefinition(seed);
  git(seed, 'add', '.');
  git(seed, '-c', 'user.name=Draft Author', '-c', 'user.email=draft.author@example.invalid', 'commit', '-qm', 'seed');
  git(base, 'clone', '-q', '--bare', seed, remote);
  flow(base, ['bootstrap', remote, '--capability', 'drafts', '--into', checkout]);
  const skillFile = path.join(base, 'skill.md');
  await writeFile(skillFile, 'Write each comment <instruction>tone</instruction> and name the line.\n');

  assert.match(flow(checkout, ['instruction', 'create', 'tone', '--description', 'How to phrase comments.', '--instructions', 'Be kind and specific.']).stdout,
    /Saved as a draft; no Story uses it until it is approved\. Drafts waiting: 1\./);
  // The first save learned that the repository has an approved configuration. Later saves ask no
  // remote: with it gone, the change is checked against this checkout's configuration, and a retry
  // of the same operation returns the same draft.
  assert.equal(JSON.parse(await readFile(path.join(draftsDirectory(checkout), 'authority.json'), 'utf8')).source, 'sflow/config');
  await rename(remote, `${remote}.offline`);
  const create = ['skill', 'create', 'review', '--description', 'Reviews a change.', '--from', skillFile, '--operation-id', 'e2e-review'];
  const counted = flow(checkout, create, 0, { SINGULARITY_FLOW_SUBPROCESS_PROBE: '1' });
  assert.match(counted.stdout, /Drafts waiting: 2\./);
  // SDA §17, restated by decision D2: a draft save starts no remote or model process, and its local
  // Git reads only fall. Measured 9 (macOS, 2026-10-30; 11 before B6b batched the editor's two
  // committed files): the CLI's repository probe and command log (2), the held authority's ref (1)
  // and objects (4), and the Studio check's committed path-authority baseline in one batch (2).
  // Lower the ceiling with the count; never raise it.
  const probe = /^subprocesses: (\d+) calls/mu.exec(counted.stderr);
  assert.ok(probe, counted.stderr);
  const rows = counted.stderr.slice(probe.index).split('\n').slice(1).map((line) => /^\s+\d+x\s+\d+ ms {2}(.+)$/u.exec(line)?.[1]).filter(Boolean);
  assert.deepEqual(rows.filter((row) => !row.startsWith('git ')), [], 'a draft save starts no process but local Git');
  assert.deepEqual(rows.filter((row) => /^git (?:fetch|ls-remote|push|pull|clone)\b/u.test(row)), [], 'a draft save makes no remote contact');
  assert.ok(Number(probe[1]) <= 9, `a draft save starts at most 9 local Git processes, not ${probe[1]}:\n${counted.stderr.slice(probe.index)}`);
  const retried = JSON.parse(flow(checkout, [...create, '--json']).stdout);
  assert.equal(retried.saved, 'existing');
  assert.equal(retried.drafts.pending, 2);
  await rename(`${remote}.offline`, remote);
  assert.match(flow(checkout, ['skill', 'attach', 'review', '--agent', 'qa', '--phases', 'verification']).stdout, /Drafts waiting: 3\./);
  const listed = JSON.parse(flow(checkout, ['configuration', 'drafts', '--json']).stdout);
  assert.deepEqual(listed.drafts.map((entry) => [entry.number, entry.state]), [[1, 'saved-local'], [2, 'saved-local'], [3, 'saved-local']]);
  assert.equal(listed.drafts[1].operationId, 'e2e-review');
  assert.match(listed.drafts[0].checkedAgainst.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(listed.drafts[1].checkedAgainst, { commit: null, source: 'checkout-configuration' });
  // An index rebuild touches no draft (SDA-AC-003).
  const store = draftsDirectory(checkout);
  const snapshot = async () => Promise.all((await readdir(store)).sort().map(async (name) => [name, await readFile(path.join(store, name), 'utf8')]));
  const kept = await snapshot();
  flow(checkout, ['index', 'rebuild', '--json']);
  assert.deepEqual(await snapshot(), kept);
  assert.match(flow(checkout, ['skill', 'list']).stdout, /Drafts, not used by any Story until approved:\n {2}New skill review\n {2}Attach skill review to agent qa in verification/);
  const before = git(remote, 'rev-parse', 'sflow/config');
  assert.match(flow(checkout, ['configuration', 'propose']).stdout, /Proposed 3 drafts as one review\./);
  assert.equal(git(remote, 'rev-parse', 'sflow/config'), before, 'proposing approves nothing');
  const refused = flow(checkout, ['configuration', 'approve'], 1);
  assert.match(refused.stdout, /new: singularity\/skill-library\/review\/SKILL\.md/);
  assert.match(refused.stderr, /approve with: singularity-flow configuration approve sflow\/config-change\/\S+ --yes/);
  assert.match(flow(checkout, ['configuration', 'approve', '--yes']).stdout, /Approved\. New Stories use these changes/);
  assert.match(git(remote, 'show', 'sflow/config:singularity/skill-library/review/SKILL.md'), /<instruction>tone<\/instruction>/);
  assert.match(git(remote, 'show', 'sflow/config:singularity/skill-library/attachments.yml'), /review/);
  assert.match(flow(checkout, ['configuration', 'drafts']).stdout, /^No drafts\./);
  assert.equal(JSON.parse(await readFile(path.join(draftsDirectory(checkout), 'proposed.json'), 'utf8')).proposed, null);
});
