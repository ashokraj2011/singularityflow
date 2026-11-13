/**
 * One pending list [docs/SPEC-OAP-ONE-APPROVAL-PATH-v1.md, M3].
 *
 * The decision list is the one list of everything a person must do on a Story: the kinds it always
 * had, the routing decision, intent and forward amendments, appeals, owed sign-offs, every refusal
 * the approval check names that nothing else carries, what did not publish, and, last, the step's
 * approval itself. These tests pin that every pending concept the spec names has an item kind (or is
 * a machine item), that every approval-check hold lands on the list, and that `decisions`,
 * readiness, `nextsteps`, the VS Code inbox and Reviews, the Navigator badge and the journey report
 * the same open count for one Story.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { APPROVAL_HOLD_OWNERS } from '../src/approval-check.mjs';
import { PENDING_CONCEPTS, PENDING_ITEM_KINDS, decisionPacket, holdItemKind, pendingSummary } from '../src/decision-list.mjs';
import { specification, submittedPlanningStory } from './helpers/submitted-planning-story.mjs';

const WORK = 'HEX-3002';
const AT = '2026-10-24T12:00:00.000Z';
const SPEC = new URL('../docs/SPEC-OAP-ONE-APPROVAL-PATH-v1.md', import.meta.url);
const LIST_SOURCE = new URL('../src/decision-list.mjs', import.meta.url);
// The spec's own words for each place that once listed pending work, and the registry key for it.
const SPEC_WORDS = Object.freeze({
  'unpushed commits': 'unpushed-commits', 'transport intents': 'transport-intents', 'decision list': 'decision-list',
  'routing decision': 'routing-decision', 'owed witnesses/scope items': 'owed-witnesses-and-scope-items',
  'intent amendments': 'intent-amendments', 'forward amendments': 'forward-amendments', appeals: 'appeals',
  'repair journal': 'repair-journal', 'TRP risks': 'trp-risks', 'quality risks': 'quality-risks'
});

test('every pending concept the spec names has an item kind on the list, or is a machine item', async () => {
  const spec = await readFile(SPEC, 'utf8');
  const row = spec.split('\n').find((line) => line.startsWith('| Separate places that list pending work |'));
  const named = /\(([^)]+)\)/u.exec(row)[1].split(/,\s*/u);
  assert.deepEqual(named, Object.keys(SPEC_WORDS), 'the spec table still names these concepts');
  assert.deepEqual(Object.keys(PENDING_CONCEPTS).sort(), Object.values(SPEC_WORDS).sort());
  const source = await readFile(LIST_SOURCE, 'utf8');
  for (const [concept, entry] of Object.entries(PENDING_CONCEPTS)) {
    assert.ok(entry.kinds.length, concept);
    for (const kind of entry.kinds) assert.ok(PENDING_ITEM_KINDS.includes(kind), `${concept}: ${kind} is not an item kind`);
    for (const code of entry.codes ?? []) assert.ok(APPROVAL_HOLD_OWNERS[code], `${concept}: ${code} is not an approval-check hold`);
  }
  // Each item kind is written by a builder (above the registries) or by the list itself (decisionPacket).
  const builders = source.slice(0, source.indexOf('export const APPROVAL_HOLDING_KINDS'))
    + source.slice(source.indexOf('export function decisionPacket('), source.indexOf('export function pendingSummary('));
  for (const kind of PENDING_ITEM_KINDS) assert.ok(builders.includes(`'${kind}'`), `no builder writes ${kind}`);
  assert.deepEqual(PENDING_CONCEPTS['unpushed-commits'].machine && PENDING_CONCEPTS['transport-intents'].machine, true);
});

test('every refusal the approval check can name lands on the list', () => {
  for (const [code, owner] of Object.entries(APPROVAL_HOLD_OWNERS)) {
    const kind = holdItemKind({ code, owner, summary: '' });
    assert.ok(PENDING_ITEM_KINDS.includes(kind), `${code} has no item kind (${kind})`);
  }
  assert.equal(holdItemKind({ code: 'APPROVAL_CHECKLIST_INCOMPLETE', owner: 'you-decide' }), 'approval', 'answered in the approval itself');
  assert.equal(holdItemKind({ code: 'PHASE_VALIDATION_FAILED', owner: 'someone-decides', summary: 'The accepted test-run risk expired.' }), 'test-run-risk');
});

/** A Story whose planning awaits approval, with product approvers this actor is not one of. */
function story() {
  return {
    workItem: { id: WORK, title: 'One list', workType: 'demo', branch: WORK }, currentPhase: 'planning', phaseOrder: ['specification', 'planning'], status: 'in_progress',
    resolution: { approvalAuthorities: {
      architecture: { label: 'Architecture reviewers', allowAnyGitIdentity: true, members: [] },
      product: { label: 'Product approvers', allowAnyGitIdentity: false, members: [{ name: 'Product Owner', email: 'product.owner@example.test' }] } } },
    phases: {
      specification: { id: 'specification', label: 'Specification', status: 'approved', generation: 1, approvals: [], approvalPolicy: { authorities: ['product'], minimum: 1 } },
      planning: { id: 'planning', label: 'Planning', status: 'awaiting_approval', generation: 1, approvals: [], approvalPolicy: { authorities: ['architecture'], minimum: 1 } }
    }
  };
}

const hold = (code, owner, summary) => ({ code, owner, who: owner, summary, action: { label: summary, command: `singularity-flow recover ${WORK} --json` } });

function facts() {
  return {
    phaseId: 'planning', endsStory: false, gaps: [], issues: [], evidence: [], visual: [], testRisks: [], testCommands: [],
    scopePhase: 'specification',
    approvalCheck: { holds: [
      hold('APPROVAL_INTENT_AMENDMENT_PENDING', 'someone-decides', 'Approving planning waits for intent amendment AMD-002 to be decided.'),
      hold('TRP_PHASE_GATE_BLOCKED', 'someone-decides', 'The test and recovery agreement blocks planning.'),
      hold('PHASE_VALIDATION_FAILED', 'someone-decides', 'The accepted test-run risk for unit expired.'),
      hold('APPROVAL_CHECKLIST_INCOMPLETE', 'you-decide', 'Answer the approval checklist.'),
      hold('STORY_PUBLICATION_PENDING', 'machine', 'A commit is still to publish.')
    ] },
    pending: {
      publication: { commit: null, cause: 'A commit was recorded here but its publication did not land.' },
      routing: { key: 'route-1', decision: 'route', label: 'Ship or rework', after: 'specification', by: ['product'],
        options: [{ id: 'ship', label: 'Ship', to: 'planning' }, { id: 'rework', label: 'Rework', to: 'specification' }] },
      intentAmendments: [{ id: 'AMD-001', status: 'approved', changedClauses: [`${WORK}:AC-001`], acknowledgementRequired: true, acknowledgedAt: null },
        { id: 'AMD-002', status: 'proposed', changedClauses: [`${WORK}:REQ-002`] }],
      forwardAmendments: [{ code: 'FORWARD_AMENDMENT_PENDING', amendment: 'FAM-001', phase: 'specification', message: 'FAM-001 proposes a corrected specification.',
        command: `singularity-flow upstream-issue decide-amendment FAM-001 --work-id ${WORK} --decision approve|reject --reason "<why>" --confirm FAM-001` }],
      appeals: [{ id: 'APL-001', phaseId: 'planning', status: 'needs-human', command: 'singularity-flow appeal show APL-001 --json' }],
      owed: [{ kind: 'witness', clauseId: `${WORK}:AC-001`, slot: 'visual-1', method: 'visual', files: ['shots/home.png'], owners: ['specification'],
        command: `singularity-flow decision witness --work-id ${WORK} --criterion ${WORK}:AC-001 --slot visual-1` }],
      transport: [{ intentId: 'psh_0001', status: 'needs-user', cause: 'Git refused it (auth-failed).' }]
    },
    state: null
  };
}

test('the list holds every pending kind in one order, and the approval last, naming what holds it', () => {
  const workflow = story();
  const packet = decisionPacket(workflow, facts(), { authorities: workflow.resolution.approvalAuthorities,
    actor: { name: 'Architect', email: 'architect@example.test' }, at: AT });
  assert.deepEqual(packet.items.map((item) => item.kind), ['story-publication', 'routing-decision', 'intent-amendment', 'intent-amendment',
    'forward-amendment', 'appeal', 'owed-decision', 'approval-hold', 'test-run-risk', 'transport-intent', 'approval']);
  const byKind = (kind) => packet.items.filter((item) => item.kind === kind);
  const approval = packet.items.at(-1);
  // Holding: the retained commit, the amendment the hold names (not the acknowledged one), and the holds no item carried.
  assert.deepEqual(packet.items.filter((item) => item.holdsApproval).map((item) => item.id), ['d1', 'd4', 'd8', 'd9']);
  assert.deepEqual(approval.details.heldBy, ['d1', 'd4', 'd8', 'd9']);
  assert.deepEqual(approval.details.youDecide, ['Answer the approval checklist.'], 'answered in the approval itself, not a separate item');
  assert.equal(approval.options[0].action.command, `singularity-flow approve planning --work-id ${WORK} --fetch`);
  assert.match(approval.why, /It waits for d1, d4, d8 and d9 first\./u);
  // Machine items show only what failed, with sync as the way through.
  assert.deepEqual(byKind('story-publication')[0].details.commands, [`singularity-flow sync ${WORK}`]);
  assert.deepEqual(byKind('transport-intent')[0].details.commands, ['singularity-flow sync psh_0001']);
  assert.ok(packet.items.filter((item) => item.machine).every((item) => ['story-publication', 'transport-intent'].includes(item.kind)));
  // Another group's item names them and how to ask, never a dead end.
  const routing = byKind('routing-decision')[0];
  assert.equal(routing.decidedBy.allowed, false);
  assert.match(routing.decidedBy.words, /^The Product approvers \(Product Owner\) decide this; ask them\./u);
  assert.equal(routing.decidedBy.share, `/sf-decide ${WORK}`);
  assert.deepEqual(routing.options.map((option) => option.chat.command), [
    `singularity-flow decision choose ${WORK} --fetch --option ship --reason "<REASON>" --expected route-1`,
    `singularity-flow decision choose ${WORK} --fetch --option rework --reason "<REASON>" --expected route-1`]);
  // What to do next is the first open item; every surface counts all of them.
  assert.equal(packet.open, packet.items.length);
  assert.deepEqual(packet.next, { item: 'd1', kind: 'story-publication', title: `Publish ${WORK}'s retained commit`, command: `singularity-flow sync ${WORK}`,
    copilotCommand: `/sf-decide ${WORK}` });
  // Each item says what it holds, from the same holds the approval reads, and the headline counts them [decision map, finding 1].
  assert.match(packet.headline, /^Planning can't be approved yet: 3 decisions needed\. The other 5: 1 holds the next step; 1 holds the steps it reopens; 2 hold the Story's end; 1 holds nothing yet\./u);
  assert.deepEqual(packet.items.filter((item) => !item.machine && item.kind !== 'approval').map((item) => [item.kind, item.holds]), [
    ['routing-decision', 'story'], ['intent-amendment', 'later-step'], ['intent-amendment', 'approval'], ['forward-amendment', 'story-end'],
    ['appeal', 'nothing'], ['owed-decision', 'story-end'], ['approval-hold', 'approval'], ['test-run-risk', 'approval']]);
  assert.ok(packet.items.filter((item) => item.kind !== 'approval').every((item) => item.holdsWords && item.answer?.words), 'every item says what it holds and where it is answered');
  const summary = pendingSummary(packet);
  assert.equal(summary.open, packet.open);
  assert.deepEqual(summary.items.map((item) => item.id), packet.items.map((item) => item.id));
  // Beyond a route and an intent amendment, nothing on the new kinds is recordable from the list: each is the person's own step with its command.
  assert.ok(packet.items.filter((item) => !['conformance-gap', 'upstream-issue', 'test-run-risk', 'visual-profile', 'test-command', 'routing-decision', 'intent-amendment'].includes(item.kind))
    .every((item) => item.options.every((option) => option.recordable === false && option.action?.command)));
  // An intent amendment is decided and acknowledged on the decisions card, each choice with its exact terminal command beside it [owner, 2026-11-13].
  assert.deepEqual(byKind('intent-amendment').map((item) => item.options.map((option) => [option.id, option.recordable !== false, Boolean(option.terminal)])),
    [[['acknowledge', true, true]], [['reject', true, true], ['approve', true, true]]]);
});

test('a step that is not awaiting approval has no approval item and holds nothing', () => {
  const workflow = story();
  workflow.phases.planning.status = 'in_progress';
  const packet = decisionPacket(workflow, facts(), { authorities: workflow.resolution.approvalAuthorities,
    actor: { name: 'Architect', email: 'architect@example.test' }, at: AT });
  assert.ok(!packet.items.some((item) => ['approval', 'approval-hold'].includes(item.kind)));
  assert.ok(packet.items.every((item) => !item.holdsApproval));
  const empty = decisionPacket(workflow, { ...facts(), pending: {}, approvalCheck: null }, { authorities: workflow.resolution.approvalAuthorities,
    actor: { name: 'Architect', email: 'architect@example.test' }, at: AT });
  assert.equal(empty.open, 0);
  assert.equal(empty.next, null);
  assert.equal(empty.status, 'nothing-to-decide');
});

test('VS Code Decide shows the person\'s own steps as theirs and another group\'s as theirs to share', async () => {
  const model = await import('../apps/vscode/src/views/decision-list-model.ts');
  const { decisionListHtml } = await import('../apps/vscode/src/views/decision-list-page.ts');
  const workflow = story();
  const packet = decisionPacket(workflow, facts(), { authorities: workflow.resolution.approvalAuthorities,
    actor: { name: 'Architect', email: 'architect@example.test' }, at: AT });
  const view = model.buildDecisionListView(packet);
  const row = (kind) => view.items.find((item) => item.kind === kind);
  assert.equal(row('approval').allowed, true, 'the approval is this architect\'s own step');
  assert.equal(row('approval').share, null);
  assert.equal(row('routing-decision').allowed, false, 'the product approvers choose the route');
  assert.equal(row('routing-decision').share, `/sf-decide ${WORK}`);
  assert.equal(view.rule, null, 'the verdict rule is shown only beside conformance items');
  const html = decisionListHtml(view);
  const approval = html.slice(html.indexOf(`data-item="${row('approval').id}"`));
  assert.match(approval, /data-allowed="true"/u);
  assert.match(approval, new RegExp(`<code>singularity-flow approve planning --work-id ${WORK} --fetch</code>`, 'u'));
  // Acknowledging an approved amendment is anyone's, recorded from the page [owner, 2026-11-13]; the rest here is not this architect's to record.
  assert.match(html, /data-action="review"/u);
  assert.deepEqual(view.items.filter((item) => item.allowed && item.options.some((option) => option.choosable)).map((item) => item.kind), ['intent-amendment']);
});

/** The VS Code views that show the count, loaded the way the extension bundles them. */
async function editorSurfaces() {
  const vm = (await import('node:vm')).default;
  const ts = (await import('typescript')).default;
  const decisions = await import('../apps/vscode/src/decisions.ts');
  const journey = await import('../apps/vscode/src/views/journey-model.ts');
  const sidebar = await import('../apps/vscode/src/views/sidebar-page.ts');
  const inboxModel = await import('../apps/vscode/src/views/inbox-model.ts');
  const modules = { vscode: {}, './approvals-model.ts': await import('../apps/vscode/src/views/approvals-model.ts'), './inbox-model.ts': inboxModel,
    './webview.ts': await import('../apps/vscode/src/views/webview.ts'), './messages.ts': await import('../apps/vscode/src/views/messages.ts'),
    './navigate.ts': { navigateTo() {} }, '../decisions.ts': decisions,
    './workspace-stories-page.ts': { workspaceStoriesHtml: () => '', storyCreatedDateHtml: () => '', STORY_FILTER_SCRIPT: '', STORY_CATALOG_STYLE: '' },
    './setup-review-repositories.ts': { capabilityProposalCheck: () => null } };
  const exports = {};
  const source = await readFile(new URL('../apps/vscode/src/views/inbox.ts', import.meta.url), 'utf8');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
    vm.createContext({ exports, Date, require(name) {
      if (name in modules) return modules[name];
      throw new Error(`Unexpected dependency: ${name}`);
    } }));
  return {
    // Each surface's own reading of the count, from the snapshot the extension holds.
    counts(snapshot) {
      const listed = decisions.pendingListOf(snapshot);
      const inbox = exports.inboxHtml(inboxModel.buildInbox(snapshot), undefined, listed);
      const badge = sidebar.sidebarBody({ navigation: { workspace: null, subject: null, next: null }, freshness: null, loading: false,
        pending: listed.open, pendingLabel: 'open on the decision list', active: null, favorites: [] });
      return {
        list: listed.open,
        inbox: Number(/data-pending-open="(\d+)"/u.exec(inbox)?.[1] ?? 0),
        badge: Number(/aria-label="(\d+) open on the decision list"/u.exec(badge)?.[1] ?? 0),
        journey: journey.buildJourney(snapshot).pending?.open ?? 0
      };
    }
  };
}

const payload = (result) => {
  const parsed = JSON.parse(result.stdout);
  return parsed.resultType === 'command-result' ? parsed.data : parsed;
};

test('decisions, readiness, nextsteps and every editor surface report the same open count for one Story', async (t) => {
  const { cli, candidate } = await submittedPlanningStory(t, WORK);
  await writeFile(candidate, specification(WORK, 2));
  cli('story', 'intent-amendment', 'propose', '--file', candidate, '--reason', 'Review showed that value 2 is required.');
  const surfaces = await editorSurfaces();
  const read = () => {
    const listed = payload(cli('decisions', WORK, '--json'));
    const readiness = JSON.parse(cli('status', WORK, '--submission-readiness', '--json').stdout);
    const next = payload(cli('nextsteps', WORK, '--json'));
    const envelope = payload(cli('snapshot', '--include', 'lifecycle', '--json'));
    const snapshot = { workItems: [], initiatives: [], selectedWorkId: null, selectedInitiativeId: null, initiative: null, workflow: null,
      ...(envelope.lifecycle ?? envelope) };
    return { listed, readiness, next, snapshot };
  };
  let { listed, readiness, next, snapshot } = read();
  assert.deepEqual(listed.items.map((item) => item.kind), ['intent-amendment', 'approval']);
  assert.equal(listed.next.kind, 'intent-amendment');
  const expected = { list: 2, inbox: 2, badge: 2, journey: 2 };
  assert.deepEqual([listed.open, readiness.pending?.open, next.pending?.open], [2, 2, 2], 'decisions, readiness and nextsteps');
  assert.deepEqual(surfaces.counts(snapshot), expected, 'the editor surfaces');
  assert.equal(snapshot.submissionReadiness.pending.next.title, listed.next.title);

  // Rejecting the amendment leaves the approval as the one open item, everywhere.
  cli('story', 'intent-amendment', 'decide', 'AMD-001', '--decision', 'reject', '--confirm', 'AMD-001', '--reason', 'Value 1 stays as approved.');
  ({ listed, readiness, next, snapshot } = read());
  assert.deepEqual(listed.items.map((item) => item.kind), ['approval']);
  assert.match(listed.headline, /^Planning has nothing left to decide; its approval is next\./u);
  assert.deepEqual([listed.open, readiness.pending?.open, next.pending?.open], [1, 1, 1]);
  assert.deepEqual(surfaces.counts(snapshot), { list: 1, inbox: 1, badge: 1, journey: 1 });
  assert.equal(next.pending.next.command, `singularity-flow approve planning --work-id ${WORK} --fetch`);
  assert.equal(listed.next.copilotCommand, `/sf-approve planning --work-id ${WORK}`, 'the approval\'s own skill, by phase ID');
});

test('Reviews and the Navigator badge read the same count as the inbox', async () => {
  const inbox = await readFile(new URL('../apps/vscode/src/views/inbox.ts', import.meta.url), 'utf8');
  assert.match(inbox, /decisionCards\(inbox, pendingListOf\(state\.snapshot\)\)/u, 'Reviews draws the list card from pendingListOf');
  const extension = await readFile(new URL('../apps/vscode/src/extension.ts', import.meta.url), 'utf8');
  assert.match(extension, /const listed = state\.stale \|\| state\.error \? null : pendingListOf\(state\.snapshot\);/u, 'the badge counts the list');
});

test('a changed path the plan misses is its approvers\' to account for, named as them, not as someone else', () => {
  const route = 'singularity-flow decision plan WORK --add-location <clause>=src/test/setup.js --reason <why>';
  const planned = {
    workItem: { id: WORK, title: 'One list', workType: 'demo', branch: WORK }, currentPhase: 'implementation', phaseOrder: ['planning', 'implementation'], status: 'in_progress',
    resolution: { plannedClaims: { owners: { implementation: 'planning' } }, approvalAuthorities: {
      architecture: { label: 'Architecture reviewers', allowAnyGitIdentity: false, members: [{ name: 'Sole Reviewer', email: 'sole@example.test' }] },
      engineering: { label: 'Engineering reviewers', allowAnyGitIdentity: false, members: [{ name: 'Sole Reviewer', email: 'sole@example.test' }] } } },
    phases: {
      planning: { id: 'planning', label: 'Planning', status: 'approved', generation: 1, approvals: [], approvalPolicy: { authorities: ['architecture'], minimum: 1 } },
      implementation: { id: 'implementation', label: 'Implementation', status: 'awaiting_approval', generation: 1, approvals: [], approvalPolicy: { authorities: ['engineering'], minimum: 1 } }
    }
  };
  const listFor = (email) => {
    const base = facts();
    return decisionPacket(planned, {
      ...base, phaseId: 'implementation', scopePhase: 'planning',
      approvalCheck: { holds: [{ code: 'SPEC_COVERAGE_INCOMPLETE', owner: 'someone-decides', who: 'An approver of the plan decides', summary: 'Phase implementation cannot be approved because specification coverage is incomplete.',
        action: { label: 'An approver of the plan accounts for the exact changed path.', command: route },
        planRows: [{ clauseId: 'WORK:REQ-001', result: 'The button converts the shown value.' }, { clauseId: 'WORK:AC-001' }] }] },
      pending: { ...base.pending, intentAmendments: [], forwardAmendments: [], appeals: [], owed: [], transport: [], publication: null, routing: null }
    }, { authorities: planned.resolution.approvalAuthorities, actor: { name: 'Person', email }, at: AT });
  };
  const mine = listFor('sole@example.test').items.find((item) => item.kind === 'approval-hold');
  assert.equal(mine.options[0].decidedBy.allowed, true);
  assert.deepEqual(mine.options[0].decidedBy.groups, ['architecture']);
  assert.match(mine.why, /You may do this \(Architecture reviewers\)\. Choose the row it belongs to and give your reason, then run it\./u);
  assert.doesNotMatch(JSON.stringify(mine), /Someone else/u);
  assert.match(mine.why, /The plan's rows: WORK:REQ-001 \(The button converts the shown value\.\); WORK:AC-001\./u, 'the command leaves the row blank, so the choices come with it');
  const theirs = listFor('other@example.test').items.find((item) => item.kind === 'approval-hold');
  assert.equal(theirs.options[0].decidedBy.allowed, false);
  assert.match(theirs.why, /The Architecture reviewers \(Sole Reviewer\) decide this; ask them\./u);
  assert.equal(theirs.options[0].action.command, route, 'whoever holds it, the route stays visible');
});
