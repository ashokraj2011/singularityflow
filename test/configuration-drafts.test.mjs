import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { initializeDefinition } from '../src/config.mjs';
import {
  approveProposal, authorChange, describeChange, discardDrafts, draftLines, draftsPath, proposeDrafts, readDrafts
} from '../src/configuration-drafts.mjs';

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
  const calls = [];
  return {
    calls,
    apply: async (set, options = {}) => {
      calls.push({ changes: set.changes.map((change) => change.op), ...options });
      if (options.propose) return { reviewRequired: true, branch: 'sflow/config-change/workflow/studio-x', commit: 'a'.repeat(40), files: [] };
      return { valid: true, files: [{ path: 'x', action: 'create' }], summary: ['planned'] };
    },
    check: async (set) => ({
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
  assert.deepEqual(first.drafts, { pending: 1, added: ['New skill Review (review)'] });
  const second = await authorChange(root, { schema: SET, changes: [attach] }, { subject: 'review', message: 'm', ...fake });
  assert.equal(second.drafts.pending, 2);
  assert.deepEqual(second.summary, ['New skill Review (review)', 'Attach skill review to agent qa in verification'],
    'the attach was checked on top of the draft that creates the skill');
  assert.deepEqual(fake.calls, [], 'saving a draft writes no configuration and proposes nothing');
  const saved = await readDrafts(root);
  assert.deepEqual(saved.changes.map((entry) => entry.change.op), ['skill.create', 'skill.attach']);
  assert.match(draftsPath(root), /singularity-flow[\\/]configuration-drafts[\\/]drafts\.json$/);
  assert.match(draftLines(saved).join('\n'), /2 drafts, not used by any Story until approved:\n {2}1\. New skill Review \(review\)/);
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
  await assert.rejects(proposeDrafts(root, fake), (error) => error.code === 'CONFIGURATION_DRAFTS_EMPTY'
    && /ready for approval: singularity-flow configuration approve/.test(error.message));
});

test('drafts can be discarded one at a time or all together', async t => {
  const root = await repository(t);
  const fake = harness();
  await authorChange(root, { schema: SET, changes: [skill] }, { subject: 'review', message: 'm', ...fake });
  await authorChange(root, { schema: SET, changes: [attach] }, { subject: 'review', message: 'm', ...fake });
  await assert.rejects(discardDrafts(root, { number: 3 }), (error) => error.code === 'CONFIGURATION_DRAFT_UNKNOWN');
  assert.deepEqual((await discardDrafts(root, { number: 1 })).removed, ['New skill Review (review)']);
  assert.equal((await discardDrafts(root, { all: true })).pending, 0);
});

test('a damaged drafts file is refused, never silently emptied', async t => {
  const root = await repository(t);
  await mkdir(path.dirname(draftsPath(root)), { recursive: true });
  await writeFile(draftsPath(root), '{"schema":"other"}');
  await assert.rejects(readDrafts(root), (error) => error.code === 'CONFIGURATION_DRAFTS_INVALID');
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
  const flow = (cwd, args, status = 0) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', timeout: 180_000 });
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
  flow(checkout, ['skill', 'create', 'review', '--description', 'Reviews a change.', '--from', skillFile]);
  assert.match(flow(checkout, ['skill', 'attach', 'review', '--agent', 'qa', '--phases', 'verification']).stdout, /Drafts waiting: 3\./);
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
  assert.equal(JSON.parse(await readFile(draftsPath(checkout), 'utf8')).proposed, null);
});
