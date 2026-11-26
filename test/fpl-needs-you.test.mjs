// FPL M1 (docs/SPEC-FPL-FOUR-PLACES-v1.md §3.3, §7 A1 to A3, A6, A7): what waits on one person, across the workspace.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  decisionItems, initiativeItems, intakeItem, nextVersionItem, reviewItem, stepApprovalItem, workflowDecisionItem
} from '../src/needs-you-items.mjs';
import { itemCounts, LATER_DECISION_KINDS, LIST_LIMIT, orderItems, timeWords } from '../src/needs-you-list.mjs';
import { LATER_KINDS } from '../src/decision-list.mjs';
import { initiativePendingApprovals } from '../src/initiative-approvals.mjs';
import { identityKey, keptDirectory, keptFile, writeKept } from '../src/needs-you-cache.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = { id: 'shop-web', name: 'shop-web' };
const me = { name: 'Reviewer', email: 'reviewer@example.invalid', login: null };
const GROUPS = {
  'quality-reviewers': { label: 'Quality reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.invalid' }, { name: 'Other', email: 'other@example.invalid' }] },
  'release-owners': { label: 'Release owners', members: [{ name: 'Owner', email: 'owner@example.invalid' }] }
};

/** A Story waiting at its one step, as a record (workflow.json) holds it. */
function story(id, { status = 'awaiting_approval', approvals = [], authorities = ['quality-reviewers'], generatedBy = null, allowSelfApproval = true,
  pendingDecision = null, submittedAt = '2026-11-20T09:00:00Z', groups = GROUPS, required = [], minimum = 1, workType = 'feature' } = {}) {
  return {
    schemaVersion: 11,
    workItem: { id, title: `Story ${id}`, branch: `story/${id}`, workType, createdAt: '2026-11-19T00:00:00Z',
      createdBy: { name: 'Builder', email: 'builder@example.invalid' } },
    lineage: { canonicalBranch: `story/${id}` }, status: 'in_progress', currentPhase: 'plan', phaseOrder: ['plan'],
    phases: { plan: { id: 'plan', label: 'Plan', status, generation: 1, artifacts: [], checks: [], approvals,
      approvalPolicy: { minimum, authorities, requiredAuthorities: required, allowSelfApproval }, ...(generatedBy ? { generatedBy } : {}), submittedAt,
      requiredArtifact: { path: 'plan.md' } } },
    resolution: { phases: [{ id: 'plan', label: 'Plan' }], approvalAuthorities: groups },
    history: [], ...(pendingDecision ? { pendingDecision } : {})
  };
}

test('A1 records: a step approval is listed exactly when approve would accept this person', () => {
  const listed = stepApprovalItem(story('A-1'), { repository, actor: me });
  assert.equal(listed.kind, 'step-approval');
  assert.equal(listed.question, 'Approve Plan?');
  assert.equal(listed.group, 'holds-work');
  assert.deepEqual(listed.choices.map((choice) => choice.id), ['approve', 'return']);
  assert.match(listed.choices[0].command, /^singularity-flow approve plan --work-id A-1 --fetch$/u);
  assert.equal(listed.couldNotTell, undefined);

  // Not listed: an approval they already gave, one they wrote where self-approval is off, a group they are not in.
  assert.equal(stepApprovalItem(story('A-2', { approvals: [{ decision: 'approved', actor: { email: 'reviewer@example.invalid' }, authorityGroup: 'quality-reviewers' }] }),
    { repository, actor: me }), null, 'already approved by this person');
  assert.equal(stepApprovalItem(story('A-3', { generatedBy: { email: 'reviewer@example.invalid' }, allowSelfApproval: false }), { repository, actor: me }), null,
    'the self-approval rule refuses its author');
  assert.ok(stepApprovalItem(story('A-3b', { generatedBy: { email: 'reviewer@example.invalid' }, allowSelfApproval: true }), { repository, actor: me }),
    'an author may approve where self-approval is allowed');
  assert.equal(stepApprovalItem(story('A-4', { authorities: ['release-owners'] }), { repository, actor: me }), null, 'a group they are not in');
  assert.equal(stepApprovalItem(story('A-5', { status: 'in_progress' }), { repository, actor: me }), null, 'nothing waits for approval');
  assert.equal(stepApprovalItem(story('A-6'), { repository, actor: { name: 'Nobody', email: null, login: null } }), null, 'no identity: approve refuses');

  // Enough people approved and only a required group is missing: only its members move the step.
  const required = story('A-7', { authorities: ['quality-reviewers', 'release-owners'], required: ['release-owners'],
    approvals: [{ decision: 'approved', actor: { email: 'other@example.invalid' }, authorityGroup: 'quality-reviewers' }] });
  assert.equal(stepApprovalItem(required, { repository, actor: me }), null);
  assert.ok(stepApprovalItem(required, { repository, actor: { email: 'owner@example.invalid' } }));

  // SFlow cannot tell: approval groups it cannot read are shown, labelled; the real check decides.
  const broken = story('A-8', { groups: { 'quality-reviewers': { members: 'not a list' } } });
  const unsure = stepApprovalItem(broken, { repository, actor: me });
  assert.equal(unsure.couldNotTell, true);
  assert.match(unsure.why, /SFlow could not tell whether this one is yours/u);
  // A group that names people only by GitHub login, while no login is known here.
  const logins = story('A-9', { groups: { 'quality-reviewers': { label: 'Reviewers', members: [{ githubLogin: 'someone' }] } } });
  assert.equal(stepApprovalItem(logins, { repository, actor: me }).couldNotTell, true);
});

test('A1 records: a workflow decision is listed for the people its groups admit, as decision choose checks', () => {
  const pending = { key: 'route-after-plan', after: 'plan', label: 'Ship now or wait', by: ['quality-reviewers'], askedAt: '2026-11-21T08:00:00Z',
    options: [{ id: 'ship', label: 'Ship now' }, { id: 'wait', label: 'Wait a week' }] };
  const record = story('B-1', { status: 'approved', pendingDecision: pending });
  const item = workflowDecisionItem(record, { repository, actor: me });
  assert.equal(item.kind, 'workflow-decision');
  assert.equal(item.question, 'Ship now or wait?');
  assert.deepEqual(item.choices.map((choice) => choice.id), ['ship', 'wait']);
  assert.match(item.choices[0].command, /decision choose B-1 --fetch --option ship --reason "<REASON>" --expected route-after-plan/u);
  assert.equal(workflowDecisionItem(record, { repository, actor: { email: 'owner@example.invalid' } }), null, 'not in its group');
  assert.equal(workflowDecisionItem(story('B-2', { status: 'awaiting_approval', pendingDecision: pending }), { repository, actor: me }), null,
    'the step it follows is not approved yet');
});

test('A1 checkout items: open decisions this person answers, never optional or settled ones; the next version; the intake', () => {
  const workflow = story('C-1', { status: 'in_progress' });
  const decided = (allowed) => ({ allowed, groups: ['quality-reviewers'], labels: [] });
  const packet = { items: [
    { id: 'd1', kind: 'refactor-behaviour', title: 'Keep the old rounding?', decidedBy: decided(true),
      plain: { question: 'Keep the old rounding?', why: 'The refactor changes how totals round.', recommended: 'SFlow recommends: keep the old behaviour' },
      options: [{ id: 'keep', label: 'Keep the old behaviour', recommended: true, decidedBy: decided(true) }, { id: 'change', label: 'Take the new behaviour', decidedBy: decided(true) },
        { id: 'later', label: 'Ask a script', recordable: false, decidedBy: decided(true) }] },
    { id: 'd2', kind: 'departure', title: 'A file outside the plan', decidedBy: decided(true), plain: { question: 'Accept the change outside the plan?', why: 'x' },
      options: [{ id: 'accept', label: 'Accept it', decidedBy: decided(true) }] },
    { id: 'd3', kind: 'conformance-gap', title: 'Settled', settled: true, decidedBy: decided(true), plain: { question: 'Settled?' }, options: [] },
    { id: 'd4', kind: 'upstream-issue', title: 'Not theirs', decidedBy: decided(false), plain: { later: 'Waiting for Owner' }, options: [] },
    { id: 'd5', kind: 'approval', title: 'Approve Plan', decidedBy: decided(true), plain: { question: 'Approve Plan?' }, options: [] },
    { id: 'd6', kind: 'transport-intent', machine: true, decidedBy: decided(true), plain: { question: 'Retry the upload?' }, options: [] }
  ], offered: [{ id: 'd7', kind: 'scope-completeness', optional: true, decidedBy: decided(true), plain: { question: 'Review the scope?' }, options: [] }] };
  const items = decisionItems(packet, workflow, { repository });
  assert.deepEqual(items.map((item) => item.question), ['Keep the old rounding?', 'Accept the change outside the plan?']);
  assert.deepEqual(items.map((item) => item.group), ['holds-work', 'later'], 'a departure waits for the approval: Later');
  assert.deepEqual(items[0].choices.map((choice) => choice.id), ['keep', 'change'], 'only recordable choices, the recommended first');
  assert.equal(items[0].recommended.choice, 'keep');
  assert.equal(items[0].choices[0].command, 'singularity-flow decisions record C-1 --choose d1=keep');
  assert.deepEqual([...LATER_DECISION_KINDS], [...LATER_KINDS], 'the copy is the decision list\'s own');

  const opening = { workId: 'C-1', phase: 'plan', version: 2, question: 'Start Plan version 2 to take in your change?', confirmation: 'plan-2', digest: 'x' };
  const next = nextVersionItem(opening, workflow, { repository });
  assert.equal(next.kind, 'next-version');
  assert.equal(next.question, 'Start Plan version 2 to take in your change?');

  const task = { ...story('TASK-3', { status: 'in_progress', workType: 'task-fix' }), workItem: { ...story('TASK-3').workItem, workType: 'task-fix',
    createdBy: { name: 'Reviewer', email: 'reviewer@example.invalid' } } };
  const intake = intakeItem(task, { repository, actor: me, required: true, recorded: null });
  assert.equal(intake.kind, 'intake');
  assert.deepEqual(intake.choices.map((choice) => [choice.label, choice.copilotCommand]), [['Answer in Copilot chat', '/sf-task']]);
  assert.equal(intakeItem(task, { repository, actor: { email: 'other@example.invalid' }, required: true, recorded: null }), null, 'only whoever started the task');
  assert.equal(intakeItem(task, { repository, actor: me, required: true, recorded: { answers: [] } }), null, 'answered already');
});

test('A1 reviews: a configuration proposal this person may approve, never their own where another person must', () => {
  const proposal = { branch: 'sflow/config-change/workflow/billing-review', proposalCommit: 'a'.repeat(40), merged: false, valid: true, state: 'proposed',
    proposer: { name: 'Builder', email: 'builder@example.invalid' }, proposalCreatedAt: '2026-11-22T10:00:00Z',
    approvalPolicy: { allowSelfApproval: false, approvers: [{ email: 'reviewer@example.invalid' }] },
    workflows: [{ id: 'classic', label: 'Classic delivery', change: 'changed' }],
    nextAction: `singularity-flow configuration approve sflow/config-change/workflow/billing-review --confirm ${'a'.repeat(40)}` };
  const item = reviewItem(proposal, { repository, actor: me });
  assert.equal(item.group, 'reviews');
  assert.equal(item.question, 'Approve the change to the workflow Classic delivery?');
  assert.equal(item.choices[0].command, proposal.nextAction);
  assert.equal(reviewItem(proposal, { repository, actor: { email: 'builder@example.invalid' } }), null, 'its proposer, with self-approval off');
  assert.equal(reviewItem({ ...proposal, merged: true }, { repository, actor: me }), null);
  assert.equal(reviewItem({ ...proposal, valid: false }, { repository, actor: me }), null, 'configuration approve refuses an invalid one');
  assert.equal(reviewItem(proposal, { repository, actor: { email: 'stranger@example.invalid' } }).couldNotTell, true,
    'the groups name others: the Git host decides, so it is shown and labelled');
});

test('Initiative approvals are the engine\'s rule now, and Needs you lists the ones that are this person\'s', () => {
  const state = { initiative: { id: 'INIT-1', title: 'Payments' }, currentPhase: 'business', phaseOrder: ['business'],
    phases: { business: { id: 'business', label: 'Business case', status: 'in_progress', outputs: {
      case: { id: 'case', label: 'Business case', sha256: 'b'.repeat(64), status: 'generated', path: 'business/case.md', generatedBy: 'builder@example.invalid' } } } },
    resolution: { phases: [{ id: 'business', outputs: [{ id: 'case', approval: { mode: 'individual', authorities: ['quality-reviewers'], minimum: 1 } }] }] } };
  const approvals = initiativePendingApprovals({ state, phaseGate: { ready: false, errors: [] }, report: { approvals: { byPhase: {} } } },
    { person: me, groupOf: (id) => GROUPS[id] ?? null });
  assert.deepEqual(approvals.pending.map((entry) => [entry.id, entry.standing, entry.expected]), [['output:business/case', 'yours', 'business:case']]);
  const items = initiativeItems(approvals, { repository, initiative: { state } });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'initiative-approval');
  assert.equal(items[0].question, 'Approve Business case?');
  const others = initiativePendingApprovals({ state, phaseGate: { ready: false, errors: [] }, report: {} }, { person: { email: 'owner@example.invalid' }, groupOf: (id) => GROUPS[id] ?? null });
  assert.equal(others.pending[0].standing, 'others');
  assert.deepEqual(initiativeItems(others, { repository, initiative: { state } }), []);
});

test('A2, A7: one order (Holds work oldest first, then Reviews, then Later by expiry) and the badge counts Holds work and Reviews', () => {
  const item = (key, group, waitingSince, extra = {}) => ({ key, group, waitingSince, repository: { name: extra.repository ?? 'r' }, story: { id: extra.story ?? key }, ...extra });
  const items = [
    item('later-2', 'later', '2026-11-01T00:00:00Z', { expires: '2026-12-20T00:00:00Z' }),
    item('review-1', 'reviews', '2026-11-02T00:00:00Z'),
    item('work-new', 'holds-work', '2026-11-22T00:00:00Z'),
    item('later-1', 'later', '2026-11-10T00:00:00Z', { expires: '2026-12-01T00:00:00Z' }),
    item('work-old', 'holds-work', '2026-11-01T00:00:00Z'),
    item('work-tie-b', 'holds-work', '2026-11-05T00:00:00Z', { repository: 'b' }),
    item('work-tie-a', 'holds-work', '2026-11-05T00:00:00Z', { repository: 'a' })
  ];
  const ordered = orderItems(items);
  assert.deepEqual(ordered.map((entry) => entry.key), ['work-old', 'work-tie-a', 'work-tie-b', 'work-new', 'review-1', 'later-1', 'later-2']);
  assert.deepEqual(orderItems([...items].reverse()).map((entry) => entry.key), ordered.map((entry) => entry.key), 'the same records give the same order');
  const counts = itemCounts(ordered);
  assert.equal(counts.badge, 5);
  assert.equal(counts.later, 2);
  assert.equal(counts.badgeTooltip, '5 things need you');
  assert.equal(counts.badgeLabel, 'Needs you: 5 waiting');
  assert.equal(itemCounts([items[2]]).badgeTooltip, '1 thing needs you');
  assert.equal(LIST_LIMIT, 50);
  const now = new Date('2026-11-26T15:00:00');
  assert.equal(timeWords(new Date('2026-11-26T10:42:00'), now), '10:42');
  assert.equal(timeWords(new Date('2026-11-25T10:42:00'), now), 'yesterday');
  assert.equal(timeWords(new Date('2026-11-23T10:42:00'), now), 'Monday');
});

// --- The read across a real workspace (git fixtures) ---

function ensureReady(fixture) {
  delete fixture.env.SINGULARITY_FLOW_TEST_IDENTITY;
  return fixture;
}

async function publishStory(f, state) {
  const { appendLedgerIntent, createLedgerIntent } = await import('../src/ledger.mjs');
  const { storyLifecycleProgress } = await import('../src/session-roster.mjs');
  const branch = state.workItem.branch;
  f.git(f.source, 'switch', '--quiet', '-c', branch, 'main');
  const file = path.join(f.source, f.definition.workItemRoot, state.workItem.id, 'workflow.json');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state));
  f.git(f.source, 'add', '.'); f.git(f.source, 'commit', '--quiet', '-m', `record ${state.workItem.id}`);
  f.git(f.source, 'push', '--quiet', 'origin', branch);
  const commit = f.git(f.source, 'rev-parse', 'HEAD');
  await appendLedgerIntent(f.source, { ...f.definition.ledger, pinTransport: 'none' }, createLedgerIntent({
    eventType: 'binding', capabilityId: 'fixture', actor: { name: 'Fixture', email: 'fixture@example.invalid' },
    subject: { kind: 'story', workId: state.workItem.id, branch, workType: state.workItem.workType, title: state.workItem.title, status: state.status,
      currentPhase: state.currentPhase, aliases: [], progress: storyLifecycleProgress(state) }
  }), commit);
  f.git(f.source, 'switch', '--quiet', 'main');
  return commit;
}

function needsYouCli(f, args, { cwd = f.original } = {}) {
  const child = spawnSync(process.execPath, [path.join(root, 'bin/singularity-flow.mjs'), 'needs-you', ...args], {
    cwd, env: f.env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  return child;
}

async function lastTiming(checkout) {
  const lines = (await readFile(path.join(checkout, '.git/singularity-flow/dx/timings.jsonl'), 'utf8').catch(() => '')).trim().split('\n');
  try { return JSON.parse(lines.at(-1)); } catch { return null; }
}

test('A1, A3, A6: the workspace read lists this person\'s items across repositories, keeps them, and paints offline with no Git', async (t) => {
  const { createSessionListingFixture } = await import('../scripts/session-listing-benchmark.mjs');
  const app = ensureReady(await createSessionListingFixture()); t.after(app.cleanup);
  const api = await createSessionListingFixture(); t.after(api.cleanup);
  const workspacePath = path.join(app.directory, 'workspace');
  // Members: app (the lead, cloned), api (cloned), web (not cloned: read from its remote URL).
  app.git(app.directory, 'clone', '--quiet', api.remote, path.join(workspacePath, 'repos', 'api'));
  const manifestFile = path.join(workspacePath, 'workspace.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.repositories.api = { url: api.remote, path: 'repos/api', defaultBranch: 'main', capabilities: [] };
  manifest.repositories.web = { url: api.remote, path: 'repos/web', defaultBranch: 'main', capabilities: [] };
  await writeFile(manifestFile, JSON.stringify(manifest));
  const [{ rememberWorkspace }, { readWorkspace }] = await Promise.all([import('../src/workspace.mjs'), import('../src/workspace-manifest.mjs')]);
  await rememberWorkspace(app.env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(workspacePath));
  for (const clone of [app.original, path.join(workspacePath, 'repos', 'api')]) {
    app.git(clone, 'config', 'user.email', 'reviewer@example.invalid'); app.git(clone, 'config', 'user.name', 'Reviewer');
  }
  // app: a plan approval for this person, one they gave, one they wrote with self-approval off, one for a group they are not in.
  await publishStory(app, story('APP-1', { submittedAt: '2026-11-20T09:00:00Z' }));
  await publishStory(app, story('APP-2', { approvals: [{ decision: 'approved', actor: { email: 'reviewer@example.invalid' }, authorityGroup: 'quality-reviewers', at: '2026-11-20T10:00:00Z' }] }));
  await publishStory(app, story('APP-3', { generatedBy: { email: 'reviewer@example.invalid' }, allowSelfApproval: false }));
  await publishStory(app, story('APP-4', { authorities: ['release-owners'] }));
  // api: a workflow decision for this person.
  await publishStory(api, story('API-1', { status: 'approved', pendingDecision: { key: 'route-after-plan', after: 'plan', label: 'Ship now or wait',
    by: ['quality-reviewers'], askedAt: '2026-11-21T08:00:00Z', options: [{ id: 'ship', label: 'Ship now' }, { id: 'wait', label: 'Wait a week' }] } }));

  const first = needsYouCli(app, ['--json']);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const listed = JSON.parse(first.stdout);
  assert.equal(listed.resultType, 'sflow-needs-you');
  assert.deepEqual(listed.items.map((item) => [item.repository.id, item.story?.id, item.kind]),
    [['app', 'APP-1', 'step-approval'], ['api', 'API-1', 'workflow-decision'], ['web', 'API-1', 'workflow-decision']],
    'listed: the plan approval (app), the workflow decision (api, and web read from its URL); not listed: APP-2, APP-3, APP-4');
  assert.deepEqual(listed.scope.repositories.map((entry) => [entry.id, entry.read]), [['app', 'fresh'], ['api', 'fresh'], ['web', 'fresh']]);
  assert.equal(listed.scope.repositories[0].identity.email, 'reviewer@example.invalid', 'each repository names the identity it used');
  assert.equal(listed.counts.badge, 3);
  assert.equal(listed.items[0].route.checksOut, true);
  assert.match(listed.items[0].route.words, /^Approving checks out APP-1 in app\.$/u);
  assert.equal(listed.items[0].route.here, true, 'the window is the app clone');
  assert.match(listed.items[1].route.elsewhere.commands[0], /^singularity-flow session open API-1 --workspace readiness-bench --repository api$/u);
  assert.equal(listed.otherWorkspaces, 0);

  // A6: a second read with no Story changed reads no workflow.json.
  const second = JSON.parse(needsYouCli(app, ['--json']).stdout);
  assert.deepEqual(second.items.map((item) => item.key), listed.items.map((item) => item.key), 'the same records give the same items');
  assert.deepEqual(second.scope.repositories.find((entry) => entry.id === 'app').stories, { read: 0, kept: 4 });

  // A3: offline paints from what is kept and starts no Git fetch.
  const offline = needsYouCli(app, ['--offline', '--json', '--timings']);
  assert.equal(offline.status, 0, offline.stderr);
  const painted = JSON.parse(offline.stdout);
  assert.deepEqual(painted.items.map((item) => item.key), listed.items.map((item) => item.key));
  assert.deepEqual(painted.scope.repositories.map((entry) => entry.read), ['kept', 'kept', 'kept']);
  const timing = await lastTiming(app.original);
  assert.equal(timing?.counters?.['git.remote.total'] ?? 0, 0, 'an offline read fetches nothing');

  // A3: with api's remote unreachable, app's items still show, with one line for api and web and their last-known time.
  await rename(api.remote, `${api.remote}.away`);
  t.after(() => rename(`${api.remote}.away`, api.remote).catch(() => {}));
  const partial = JSON.parse(needsYouCli(app, ['--json']).stdout);
  assert.deepEqual(partial.scope.repositories.map((entry) => [entry.id, entry.read]), [['app', 'fresh'], ['api', 'kept'], ['web', 'kept']]);
  assert.ok(partial.items.some((item) => item.story?.id === 'APP-1'));
  assert.ok(partial.items.some((item) => item.repository.id === 'api'), 'api keeps its last-known items');
  assert.equal(partial.lines.filter((line) => /^api could not be read \(.+\); showing \d\d:\d\d\.$/u.test(line)).length, 1, partial.lines.join('\n'));

  // The terminal says the same, in the same order.
  const text = needsYouCli(app, ['--offline']).stdout;
  assert.match(text, /Holds work\n {2}Approve Plan\?\n {4}APP-1 · Story APP-1 · app/u);
});

test('A6: a 20-repository, 400-Story workspace paints from what is kept in under 500 ms', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-needs-you-scale-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json') };
  const workspacePath = path.join(base, 'workspace');
  await mkdir(workspacePath, { recursive: true });
  const repositories = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`repo-${index}`,
    { url: `https://example.invalid/repo-${index}.git`, path: `repos/repo-${index}`, defaultBranch: 'main', capabilities: [] }]));
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify({ version: 1, id: 'scale', name: 'Scale', createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z', anchor: { provider: 'workspace', key: 'scale', title: 'Scale', fetchedAt: '2026-11-01T00:00:00Z' },
    leadRepository: 'repo-0', repositories }));
  const [{ rememberWorkspace }, { readWorkspace }, { activateWorkspaceContext }] = await Promise.all([import('../src/workspace.mjs'),
    import('../src/workspace-manifest.mjs'), import('../src/workspace-context.mjs')]);
  await rememberWorkspace(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, await readWorkspace(workspacePath));
  await activateWorkspaceContext(env.SINGULARITY_FLOW_WORKSPACE_REGISTRY, env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, 'scale', { detectStory: false });
  const directory = keptDirectory(env);
  const identity = identityKey(me);
  for (const [id, entry] of Object.entries(repositories)) {
    const stories = {};
    for (let index = 0; index < 20; index += 1) {
      const record = story(`${id.toUpperCase()}-${index}`, { submittedAt: new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString() });
      const item = stepApprovalItem(record, { repository: { id, name: id }, actor: me });
      stories[record.workItem.id] = { commit: 'c'.repeat(40), items: [{ ...item, route: { checksOut: true, words: 'x' } }] };
    }
    await writeKept(keptFile(directory, { workspaceId: 'scale', repositoryId: id, url: entry.url }), { repository: { id, name: id, url: entry.url },
      workspaceId: 'scale', lastIdentity: identity, byIdentity: { [identity]: { identity: me, at: '2026-11-26T10:31:00Z', stateCommit: 'd'.repeat(40), stories } } });
  }
  const { needsYou } = await import('../src/needs-you.mjs');
  await needsYou({ offline: true, env, cwd: base });
  const started = performance.now();
  const painted = await needsYou({ offline: true, env, cwd: base });
  const elapsed = performance.now() - started;
  assert.equal(painted.items.length, 400);
  assert.equal(painted.shown, 50);
  assert.equal(painted.more, 350);
  assert.equal(painted.counts.badge, 400);
  assert.ok(elapsed < 500, `painted in ${Math.round(elapsed)} ms`);
});
