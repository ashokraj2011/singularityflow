import { pathToFileURL } from 'node:url';
/**
 * The Decisions page in VS Code: the decision list's items as rows, choices as buttons, and the
 * exact answers the engine reads. [decision list, VS Code surface]
 *
 * The packet here has the shape `singularity-flow decisions --json` returns for a conformance step
 * held by a partial verdict (with its upstream issue) and by an issue only another group decides.
 * The answers a page produces are fed to the engine's own parser and planner, so the page and the
 * terminal can never disagree about what a click records.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { decisionRecordPlan, parseDecisionAnswers } from '../src/decision-list.mjs';
import { optionStrings, parseArgs } from '../src/util.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(root, 'apps', 'vscode', 'src', name);
const model = await import(pathToFileURL(source('views/decision-list-model.ts')).href);
const { decisionListHtml, DECISION_LIST_SCRIPT, DECISION_LIST_STYLE } = await import(pathToFileURL(source('views/decision-list-page.ts')).href);
const { STYLE } = await import(pathToFileURL(source('views/webview.ts')).href);
const { THEME_STYLE } = await import(pathToFileURL(source('views/theme.ts')).href);
const { commandClass } = await import(pathToFileURL(source('cli/client.ts')).href);
const { buildTree } = await import(pathToFileURL(source('views/tree-model.ts')).href);
const { buildJourney } = await import(pathToFileURL(source('views/journey-model.ts')).href);

const W = 'DECIDE-1';
const DIGEST = `sha256:${'8'.repeat(64)}`;
const FRESH = `sha256:${'9'.repeat(64)}`;
const reason = (text) => ({ default: text, minimum: 20, maximum: 1000 });
const expires = { default: '2026-11-18', latest: '2027-01-16' };
const yours = { groups: ['engineering-reviewers'], labels: ['Engineering reviewers'], allowed: true, words: 'You may decide this (Engineering reviewers).' };
const quality = { groups: ['quality-reviewers'], labels: ['Quality reviewers'], allowed: false, words: 'The Quality reviewers decide this.', share: `/sf-decide ${W}` };
const decide = (issue, issuePhase, outcome) => ({ kind: 'upstream-issue-decision', issue, issuePhase, outcome });

function packet(digest = DIGEST) {
  return {
    schemaVersion: 1, resultType: 'sflow-decisions', revision: 'decision-list-v1', workId: W, phase: 'conformance', phaseLabel: 'Code checking',
    status: 'decisions-needed', headline: "Code checking can't be approved yet: 2 decisions needed.",
    rule: 'Keep the honest verdict; never edit it to clear a check.',
    items: [{
      id: 'd1', kind: 'conformance-gap', title: 'AC-001 is partial in the Code checking report',
      why: "The Code checking report marks AC-001 partial; Code delivered it. The verdict stays as written; a person decides the gap.",
      options: [
        { id: 'accept-risk', label: 'Accept the gap as a risk until a date', recommended: false, words: 'The verdict stays partial.',
          effects: [decide('UPI-002', 'implementation', 'accept-risk')],
          needs: { expires, reason: reason('Accepted as a risk until the date: AC-001 is partial as the Code checking report says.') }, decidedBy: yours },
        { id: 'reuse', label: "Accept Code's recorded run (1 of 1 passed) for Testing", recommended: true, words: "Code's run stays labelled as Code's.",
          effects: [{ kind: 'evidence-reuse', phase: 'testing', attemptId: 'TA-b1a3f1e83304e5f030ae', recordedBy: 'implementation' }, decide('UPI-002', 'implementation', 'accept-risk')],
          needs: { reason: reason("Code's recorded run (1 of 1 passed) on unchanged code stands for Testing."), expires },
          decidedBy: { ...quality, groups: ['engineering-reviewers', 'quality-reviewers'] } },
        { id: 'dismiss', label: 'Dismiss it: the gap is not real', recommended: false, words: 'Use this only when what was delivered is complete.',
          effects: [decide('UPI-002', 'implementation', 'dismiss')], needs: { reason: reason('Dismissed: AC-001 is delivered completely by Code.') }, decidedBy: yours }
      ],
      decidedBy: { groups: ['engineering-reviewers', 'quality-reviewers'], labels: ['Engineering reviewers', 'Quality reviewers'], allowed: true,
        words: 'You may choose "Accept the gap as a risk until a date" and "Dismiss it: the gap is not real"; the Quality reviewers decide the other options.' }
    }, {
      id: 'd2', kind: 'upstream-issue', title: 'AC-002: a problem reported in Testing',
      why: "Code checking reported a problem in Testing. Testing's approvers decide it; the Story cannot finish until they do.",
      options: [
        { id: 'accept-risk', label: 'Accept it as a risk until a date', recommended: false, words: 'It needs a decision again after the date.',
          effects: [decide('UPI-003', 'testing', 'accept-risk')], needs: { expires, reason: reason('Accepted as a risk until the date: AC-002 in Testing as reported.') }, decidedBy: quality },
        { id: 'dismiss', label: 'Dismiss it: it is not a real problem', recommended: false, words: 'The report stays in the history with your reason.',
          effects: [decide('UPI-003', 'testing', 'dismiss')], needs: { reason: reason('Dismissed: AC-002 in Testing is not a defect.') }, decidedBy: quality }
      ],
      decidedBy: { ...quality }
    }],
    packetSha256: digest,
    record: { form: `singularity-flow decisions record ${W} --choose <ITEM>=<OPTION> --confirm ${digest}`, recommended: null,
      interactive: `singularity-flow decisions record ${W}`, share: `/sf-decide ${W}` }
  };
}

test('each item is a row in plain words: recommended first, its own choices as buttons, who decides it', () => {
  const view = model.buildDecisionListView(model.decisionPacketFrom({ resultType: 'command-result', data: packet() }));
  assert.equal(view.available, true);
  assert.equal(view.headline, "Code checking can't be approved yet: 2 decisions needed.");
  assert.equal(view.digest, DIGEST);
  const [d1, d2] = view.items;
  assert.deepEqual(d1.options.map((option) => [option.id, option.recommended, option.choosable]),
    [['reuse', true, false], ['accept-risk', false, true], ['dismiss', false, true]], 'recommended first; reuse is not this person\'s');
  assert.equal(d1.options[0].notChoosable, 'The Quality reviewers decide this.');
  assert.match(d1.who, /You may choose .* the Quality reviewers decide the other options\./u);
  assert.equal(d1.allowed, true);
  assert.equal(d2.allowed, false, 'an item none of whose options are yours gets no buttons');
  assert.equal(d2.who, 'The Quality reviewers decide this.');
  assert.equal(d2.share, `/sf-decide ${W}`);
  assert.equal(model.decisionPacketFrom({ data: { resultType: 'something-else' } }), null);
  assert.equal(model.decisionPacketFrom({ data: { ...packet(), packetSha256: 'not-a-digest' } }), null);
});

test('the page draws buttons only for options the person may choose, with the needs they fill in and no answer filled in', () => {
  const html = decisionListHtml(model.buildDecisionListView(packet()));
  assert.match(html, /Decisions · DECIDE-1/u);
  assert.match(html, /data-digest="sha256:8{64}"/u);
  const d1 = html.slice(html.indexOf('data-item="d1"'), html.indexOf('data-item="d2"'));
  const d2 = html.slice(html.indexOf('data-item="d2"'));
  assert.match(d1, /<button type="button" class="dl-option" data-option="accept-risk" aria-pressed="false">/u);
  assert.match(d1, /<button type="button" class="dl-option" data-option="dismiss" aria-pressed="false">/u);
  assert.doesNotMatch(d1, /data-option="reuse"/u, 'reuse is shown, never as a pressable choice');
  assert.match(d1, /<button type="button" class="dl-option" disabled aria-disabled="true">\s*<strong>Accept Code&#39;s recorded run[^<]*<\/strong><span class="pill ok">Recommended<\/span><small>The Quality reviewers decide this\.<\/small>/u);
  // A suggestion is placeholder text, and a date is the person's: as on the card, nothing is filled in for them.
  assert.match(d1, /data-needs-for="accept-risk" hidden>[\s\S]*type="date" data-field="expires" value="" max="2027-01-16"[\s\S]*data-field="reason"[^>]*placeholder="Accepted as a risk until the date: AC-001[^>]*><\/textarea>/u);
  assert.match(d1, /data-needs-for="dismiss" hidden>[\s\S]*placeholder="Dismissed: AC-001 is delivered completely by Code\."[^>]*><\/textarea>/u);
  assert.doesNotMatch(d1, /The suggested wording is yours to change/u);
  assert.doesNotMatch(d2, /data-option=/u, 'no buttons for an item that is not the person\'s');
  assert.match(d2, /The Quality reviewers decide this\./u);
  assert.match(d2, /Share this with them:<\/span> <code>\/sf-decide DECIDE-1<\/code>/u);
  assert.match(d2, /data-copy-item="d2"/u);
  assert.match(html, /<button type="submit" data-action="review" disabled>/u, 'review starts disabled until something is chosen');
  assert.doesNotMatch(html, /<script/u);
  assert.doesNotThrow(() => new Function(DECISION_LIST_SCRIPT));
  // Seen in the real VS Code: author CSS that sets display overrides [hidden], and the shared
  // stylesheet already styles .decision-option for workflow decisions. Both broke the first build.
  assert.match(DECISION_LIST_STYLE, /\.dl-needs\[hidden\] \{ display:none; \}/u);
  assert.doesNotMatch(STYLE + THEME_STYLE, /\.dl-[a-z]/u, 'the page\'s classes are its own');
  assert.match(DECISION_LIST_SCRIPT, /type: 'decisions\.review', digest: form\.dataset\.digest, choices: chosen/u);

  const empty = decisionListHtml(model.buildDecisionListView({ ...packet(), items: [], status: 'nothing-to-decide' }));
  assert.match(empty, /Code checking has nothing left waiting for a decision\./u);
  assert.match(empty, /Nothing is waiting for a decision\./u);
  assert.doesNotMatch(empty, /data-action="review"/u);
  assert.match(decisionListHtml(model.buildDecisionListView(null, { error: 'No Story selected.' })), /No Story selected\./u);
});

test('a person\'s own action is shown with its command, never as a recorded choice', () => {
  const visual = packet();
  visual.items = [{ id: 'd1', kind: 'visual-profile', title: 'Tablet has no screenshot', why: 'Coverage is enforced.',
    options: [
      { id: 'capture', label: 'Capture Tablet', recommended: false, words: 'Take it at its exact size.', effects: [], needs: {}, recordable: false,
        action: { command: 'singularity-flow visual record --phase visual --profile-id tablet', alternativeCommands: [] },
        decidedBy: { groups: [], labels: [], allowed: true, words: 'You take the screenshot and record it; nothing is decided here.' } },
      { id: 'not-applicable', label: 'Not applicable for this Story', recommended: false, words: 'Listed as not applicable, never as passed.',
        effects: [{ kind: 'visual-profile', phase: 'visual', profileId: 'tablet' }], needs: { reason: reason('Tablet does not apply to this Story: the change does not ship to it.') }, decidedBy: yours }
    ],
    decidedBy: yours }];
  const view = model.buildDecisionListView(visual);
  assert.deepEqual(view.items[0].options.map((option) => [option.id, option.choosable, Boolean(option.yours)]), [['capture', false, true], ['not-applicable', true, false]]);
  const html = decisionListHtml(view);
  assert.match(html, /data-yours="capture"[\s\S]*<code>singularity-flow visual record --phase visual --profile-id tablet<\/code>[\s\S]*data-copy-option="capture"/u);
  assert.match(html, /data-option="not-applicable"/u);
  assert.equal(model.decisionAnswersFromChoices(visual, [{ item: 'd1', option: 'capture' }]).errors[0], 'Tablet has no screenshot: Yours to do; nothing is recorded here.');
});

test('choices become exactly the answers the engine reads, defaults left out, and the engine plans the same records', () => {
  const list = packet();
  const kept = model.decisionAnswersFromChoices(list, [{ item: 'd1', option: 'accept-risk',
    reason: 'Accepted as a risk until the date: AC-001 is partial as the Code checking report says.', expires: '2026-11-18' }], { today: '2026-10-19' });
  assert.deepEqual(kept.errors, []);
  assert.deepEqual(kept.answers, { choose: { d1: 'accept-risk' }, reason: {}, expires: {}, cause: {} }, 'unchanged defaults are not repeated');
  assert.deepEqual(model.decisionPreviewArgv(W, kept.answers), ['decisions', W, '--choose', 'd1=accept-risk', '--json']);

  const edited = model.decisionAnswersFromChoices(list, [{ item: 'd1', option: 'accept-risk', reason: '  Accepted until the fix lands; "quoted" = fine.  ', expires: '2026-12-01' }],
    { today: '2026-10-19' });
  assert.deepEqual(edited.errors, []);
  assert.deepEqual(edited.answers, { choose: { d1: 'accept-risk' }, reason: { d1: 'Accepted until the fix lands; "quoted" = fine.' }, expires: { d1: '2026-12-01' }, cause: {} });
  const argv = model.decisionPreviewArgv(W, edited.answers, 'conformance');
  assert.deepEqual(argv, ['decisions', W, '--phase', 'conformance', '--choose', 'd1=accept-risk',
    '--reason', 'd1=Accepted until the fix lands; "quoted" = fine.', '--expires', 'd1=2026-12-01', '--json']);
  assert.deepEqual(model.decisionRecordArgv(W, '/private/tmp/x/answers.json', 'conformance'),
    ['decisions', 'record', W, '--phase', 'conformance', '--answers', '/private/tmp/x/answers.json', '--json']);
  const document = model.decisionAnswersDocument(edited.answers, DIGEST);
  assert.deepEqual(document, { choose: { d1: 'accept-risk' }, reason: { d1: 'Accepted until the fix lands; "quoted" = fine.' }, expires: { d1: '2026-12-01' }, cause: {}, confirm: DIGEST });
  assert.throws(() => model.decisionAnswersDocument(edited.answers, 'sha256:short'), /no digest/u);

  // The engine's own parser reads both the preview argv and the answers file to the same plan.
  const options = parseArgs(argv.slice(2)).options;
  const fromArgv = parseDecisionAnswers({ choose: optionStrings(options, 'choose'), reason: optionStrings(options, 'reason'),
    expires: optionStrings(options, 'expires'), cause: optionStrings(options, 'cause') });
  const fromFile = parseDecisionAnswers(JSON.parse(JSON.stringify(document)));
  const at = '2026-10-19T09:00:00.000Z';
  const planned = decisionRecordPlan(list, fromFile, { at });
  assert.deepEqual(decisionRecordPlan(list, fromArgv, { at }), planned);
  assert.deepEqual(planned.steps.map((step) => [step.item, step.option, step.values]),
    [['d1', 'accept-risk', { reason: 'Accepted until the fix lands; "quoted" = fine.', expires: '2026-12-01' }]]);
  assert.deepEqual(decisionRecordPlan(list, parseDecisionAnswers(model.decisionAnswersDocument(kept.answers, DIGEST)), { at }).steps[0].values,
    { reason: 'Accepted as a risk until the date: AC-001 is partial as the Code checking report says.', expires: '2026-11-18' }, 'a left-out value is the default the page showed');
});

test('choices the engine would refuse are named on the page before any command runs', () => {
  const list = packet();
  const errors = (choices) => model.decisionAnswersFromChoices(list, choices, { today: '2026-10-19' }).errors;
  assert.match(errors([{ item: 'd1', option: 'reuse' }])[0], /The Quality reviewers decide this\./u);
  assert.match(errors([{ item: 'd2', option: 'dismiss' }])[0], /The Quality reviewers decide this\./u);
  assert.match(errors([{ item: 'd1', option: 'dismiss', reason: 'too short' }])[0], /the reason must be 20 to 1000 characters/u);
  assert.match(errors([{ item: 'd1', option: 'accept-risk', expires: '2027-02-01' }])[0], /no later than 2027-01-16/u);
  assert.match(errors([{ item: 'd1', option: 'accept-risk', expires: '2026-10-19' }])[0], /after today/u);
  assert.match(errors([{ item: 'd1', option: 'accept-risk', expires: 'tomorrow' }])[0], /after today/u);
  assert.match(errors([{ item: 'd1', option: 'return' }])[0], /has no option 'return'/u);
  assert.match(errors([{ item: 'd1', option: 'dismiss' }, { item: 'd1', option: 'accept-risk' }])[0], /d1 was chosen twice/u);
  assert.match(errors([{ item: '../d1', option: 'dismiss' }])[0], /did not name an item/u);
  assert.deepEqual(errors([]), ['Choose an option for at least one item.']);
  assert.deepEqual(errors('not a list'), ['Choose an option for at least one item.']);
  // A refused choice stays on the page as the person left it.
  const { choices } = model.decisionAnswersFromChoices(list, [{ item: 'd1', option: 'dismiss', reason: 'too short' }]);
  const html = decisionListHtml(model.buildDecisionListView(list, { draft: choices, error: 'the reason must be longer' }));
  assert.match(html, /data-option="dismiss" aria-pressed="true"/u);
  assert.match(html, /data-needs-for="dismiss">[\s\S]*>too short<\/textarea>/u);
  assert.match(html, /role="alert">[\s\S]*the reason must be longer/u);
  // A choice the current list no longer offers is dropped, not carried over.
  const changed = packet(FRESH);
  changed.items[0].options = changed.items[0].options.filter((option) => option.id !== 'dismiss');
  assert.equal(model.buildDecisionListView(changed, { draft: choices }).items[0].chosen, null);
  assert.throws(() => model.decisionListArgv('../W'), /Select the Story/u);
});

test('the review page shows the engine\'s summary, what is not yours, and the exact digest command', () => {
  const preview = {
    steps: [{ item: 'd1', option: 'accept-risk', label: 'Accept the gap as a risk until a date', values: { expires: '2026-12-01' } }],
    refused: [{ item: 'd2', title: 'AC-002: a problem reported in Testing', option: 'dismiss', words: 'The Quality reviewers decide this.', share: `/sf-decide ${W}` }],
    summary: ['d1. AC-001 is partial in the Code checking report: Accept the gap as a risk until a date. Records: accept it as a risk until 2026-12-01 (decision on UPI-002).'],
    record: { command: `singularity-flow decisions record ${W} --choose d1=accept-risk --expires d1=2026-12-01 --confirm ${DIGEST}`, recordInChat: true }
  };
  assert.deepEqual(model.decisionPreviewFrom({ resultType: 'command-result', data: { ...packet(), preview } }), preview);
  const request = model.decisionConfirmationRequest(packet(), preview);
  assert.equal(request.title, 'Record 1 decision for DECIDE-1');
  assert.equal(request.confirmLabel, 'Record this decision');
  assert.equal(request.expected, undefined, 'an acknowledgement, as the terminal asks y/N; the digest is never typed');
  assert.match(request.detail, /^d1\. AC-001 is partial[^\n]*Records: accept it as a risk until 2026-12-01/u);
  assert.match(request.detail, /Not recorded, because it is not yours to decide:\nd2\. AC-002: a problem reported in Testing: The Quality reviewers decide this\. Share this with them: \/sf-decide DECIDE-1/u);
  assert.ok(request.detail.includes(`The exact command, bound to the list you reviewed:\n${preview.record.command}`));
  assert.equal(model.decisionConfirmationRequest(packet(), { ...preview, steps: [], record: null }), null);
  assert.match(model.decisionPreviewEmptyReason(packet(), { ...preview, steps: [], record: null }),
    /^Nothing would be recorded: you may not decide what you chose\. AC-002: a problem reported in Testing: The Quality reviewers decide this\. Share this with them: \/sf-decide DECIDE-1$/u);
});

test('a record shows what was written; a changed list shows the fresh list; a partial record shows what remains', () => {
  const done = model.decisionRecordOutcome({ resultType: 'command-result', data: { recorded: [{ item: 'd1', kind: 'upstream-issue-decision', record: 'UPI-002 accept-risk' }],
    refused: [], remaining: [{ id: 'd1', title: 'AC-002: a problem reported in Testing' }], packetSha256: FRESH } });
  assert.deepEqual(done.outcome, { kind: 'recorded', message: 'Recorded 1 record from your choices.', recorded: ['d1: UPI-002 accept-risk'], remaining: ['d1: AC-002: a problem reported in Testing'], decided: [] });
  assert.equal(done.packet, null);
  assert.deepEqual(model.decisionRecordOutcome({ data: { recorded: [], decided: [{ item: 'd1', words: 'Accept it as a risk until 2027-02-04' }, { item: 'd2' }] } }).outcome.decided, ['Accept it as a risk until 2027-02-04']);

  const stale = model.decisionRecordOutcome(null, { message: 'The decision list changed since it was reviewed', result: { status: 'failed',
    error: { code: 'DECISIONS_PACKET_CHANGED', message: 'The decision list changed since it was reviewed', details: { packet: packet(FRESH), packetSha256: FRESH } } } });
  assert.equal(stale.outcome.kind, 'stale');
  assert.match(stale.outcome.message, /nothing was recorded\. This is the current list; choose again\./u);
  assert.equal(stale.packet.packetSha256, FRESH, 'the refusal\'s fresh list is the one shown');

  const partial = model.decisionRecordOutcome(null, { message: 'Recorded d1: ERU-001; then d1 stopped', result: { error: { code: 'DECISIONS_PARTLY_RECORDED',
    message: 'Recorded d1: ERU-001; then d1 stopped: refused. Not recorded: d1: accept it as a risk until 2026-11-18 (decision on UPI-002).',
    details: { recorded: [{ item: 'd1', kind: 'evidence-reuse', record: 'ERU-001' }],
      remaining: [{ item: 'd1', kind: 'upstream-issue-decision', words: 'accept it as a risk until 2026-11-18 (decision on UPI-002)' }] } } } });
  assert.deepEqual([partial.outcome.kind, partial.outcome.recorded, partial.outcome.remaining],
    ['partial', ['d1: ERU-001'], ['d1: accept it as a risk until 2026-11-18 (decision on UPI-002)']]);
  const html = decisionListHtml(model.buildDecisionListView(packet(FRESH), { outcome: partial.outcome }));
  assert.match(html, /data-outcome="partial"[\s\S]*Recorded:[\s\S]*d1: ERU-001[\s\S]*Not recorded:[\s\S]*decision on UPI-002/u);

  assert.equal(model.decisionRecordOutcome(null, { message: 'Nothing was recorded', result: { error: { code: 'DECISIONS_NOT_YOURS', message: 'Nothing was recorded: you may not decide what you chose.' } } }).outcome.kind, 'not-yours');
  assert.deepEqual(model.decisionRecordOutcome(null, { message: 'spawn failed' }).outcome, { kind: 'failed', message: 'spawn failed', recorded: [], remaining: [] });
});

test('VS Code classifies the list and its preview as reads and only the record as a mutation', () => {
  assert.equal(commandClass(['decisions', W, '--json']), 'read');
  assert.equal(commandClass(['decisions', W, '--choose', 'd1=dismiss', '--json']), 'read');
  assert.equal(commandClass(['decisions', 'record', W, '--answers', 'a.json', '--json']), 'mutation');
});

function heldSnapshot() {
  const phase = (id, label, status) => ({ id, label, status, generation: 1, artifacts: [], approvals: [] });
  return {
    initiative: null, initiatives: [], selectedInitiativeId: null, selectedWorkId: W, workItems: [{ id: W, title: 'Change the value' }],
    identities: { git: { email: 'fixture@example.test' } },
    workflow: {
      workItem: { id: W, title: 'Change the value', branch: W, workType: 'classic-delivery' }, currentPhase: 'conformance',
      phaseOrder: ['implementation', 'conformance'], status: 'in_progress',
      phases: { implementation: phase('implementation', 'Code', 'approved'), conformance: phase('conformance', 'Code checking', 'awaiting_approval') }
    },
    submissionReadiness: {
      phaseId: 'conformance', phaseStatus: 'awaiting_approval', classification: 'decisions-required', lifecycleReady: false,
      currentGeneration: 1, publishedGeneration: 1, draftExists: true, draftModified: false, publicationRecorded: true,
      reasonCode: 'DECISIONS_REQUIRED', reason: "Code checking can't be approved yet: 2 decisions needed.",
      nextCommand: `singularity-flow decisions ${W}`, nextSkill: '/sf-decide',
      decisions: { count: 2, headline: "Code checking can't be approved yet: 2 decisions needed.", copilotCommand: `/sf-decide ${W}` }
    }
  };
}

test('the Navigator and the journey offer the decision list where approval would be refused', () => {
  const flatten = (nodes) => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
  const nodes = flatten(buildTree(heldSnapshot()));
  const decideIndex = nodes.findIndex((node) => node.id === 'story:conformance:decisions');
  const approveIndex = nodes.findIndex((node) => node.id === 'story:conformance:approve');
  assert.ok(decideIndex >= 0, 'the step offers the decision list');
  assert.equal(nodes[decideIndex].runCommand, 'singularityFlow.decisions');
  assert.equal(nodes[decideIndex].label, 'Decide what blocks this step');
  assert.equal(nodes[decideIndex].description, "Code checking can't be approved yet: 2 decisions needed.");
  assert.ok(approveIndex > decideIndex, 'the approval stays reachable, after the list');
  const ready = heldSnapshot();
  ready.submissionReadiness = { ...ready.submissionReadiness, classification: 'awaiting-approval', reasonCode: 'APPROVAL_PENDING', decisions: undefined };
  assert.equal(flatten(buildTree(ready)).some((node) => node.id === 'story:conformance:decisions'), false, 'nothing extra when nothing is held');

  const journey = buildJourney(heldSnapshot());
  assert.equal(journey.nextAction.execution, 'decide-list');
  assert.equal(journey.nextAction.label, 'Decide what blocks this step');
  assert.equal(journey.nextAction.reason, "Code checking can't be approved yet: 2 decisions needed.");
  assert.deepEqual(journey.nextAction.argv, ['decisions', W]);
  assert.equal(journey.nextAction.copilotCommand, `/sf-decide ${W}`);
  assert.equal(buildJourney(ready).nextAction?.execution ?? null, null);
});

test('the extension wires the page: a palette command, the lazy panel, and the approval page\'s way in', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'apps/vscode/package.json'), 'utf8'));
  assert.deepEqual(manifest.contributes.commands.find((entry) => entry.command === 'singularityFlow.decisions'),
    { command: 'singularityFlow.decisions', title: 'Singularity Flow: Decide What Blocks This Step', icon: '$(checklist)' });
  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.match(extension, /'singularityFlow\.decideStory', 'singularityFlow\.decisions',/u, 'registered whatever state the window is in');
  assert.match(extension, /'singularityFlow\.decisions': async \(target\?: unknown\) =>[\s\S]{0,700}lazyPanels\(\)\.DecisionListPanel\.show\(client,/u);
  assert.match(await readFile(source('lazy-panels-runtime.ts'), 'utf8'), /export \{ DecisionListPanel \} from '\.\/views\/decision-list\.ts';/u);
  const panel = await readFile(source('views/decision-list.ts'), 'utf8');
  assert.match(panel, /registerMessageRouter\('singularityFlow\.decisions', \{\s*'decisions\.refresh'[\s\S]*'decisions\.review'[\s\S]*'decisions\.copy'/u);
  assert.match(panel, /mkdtemp\(path\.join\(os\.tmpdir\(\), 'sflow-decisions-'\)\)[\s\S]*mode: 0o600, flag: 'wx'[\s\S]*finally \{\s*await rm\(directory, \{ recursive: true, force: true \}\);/u,
    'the answers file is private and removed after the one command');
  const approval = await readFile(source('views/approval-review.ts'), 'utf8');
  assert.match(approval, /'approval\.decide': \(\) => \{\s*if \(!request\.pendingDecisions\?\.count\) return;\s*finish\(null\);\s*void vscode\.commands\.executeCommand\('singularityFlow\.decisions', \{ workId: request\.workId, phase: request\.phaseId \}\);/u);
  assert.match(approval, /<button type="button" data-decide>Decide what blocks this step<\/button>/u);
  const actions = await readFile(source('actions.ts'), 'utf8');
  assert.match(actions, /\['decisions', request\.workId, '--phase', request\.phaseId, '--json'\]\)\.catch\(\(\) => null\)/u, 'a failed read adds nothing; the gate still decides');
});

// The browser validates every required field of a form, hidden or not: an unchosen option's empty reason
// stopped Review silently on any item with two options that ask for one (accept for now and dismiss).
test('an unchosen option\'s fields are disabled, so only the chosen option is validated when a person reviews', () => {
  assert.match(DECISION_LIST_SCRIPT, /function hide\(block, hidden\) \{\s*block\.hidden = hidden;\s*for \(const field of block\.querySelectorAll\('\[data-field\]'\)\) field\.disabled = hidden;/u);
  assert.match(DECISION_LIST_SCRIPT, /for \(const block of item\.querySelectorAll\('\[data-needs-for\]'\)\) hide\(block, /u);
  assert.match(DECISION_LIST_SCRIPT, /for \(const block of form\.querySelectorAll\('\[data-needs-for\]\[hidden\]'\)\) hide\(block, true\);/u,
    'blocks hidden when the page is drawn, including items the person may not decide, start disabled');
});

test('Update the spec on a difference: a draft is written, not recorded, and its next step opens the engine\'s draft [SCS:REQ-020, REQ-022]', () => {
  const draftPath = '/repo/.git/singularity-flow/intent-amendment-drafts/DECIDE-1.md';
  const done = model.decisionRecordOutcome({ data: { recorded: [], decided: [], drafted: [{ item: 'd1', path: draftPath, clauses: ['DECIDE-1:AC-001'], slots: 1,
    next: { command: `singularity-flow story intent-amendment propose --work-id DECIDE-1 --file "${draftPath}" --reason "<why>"`, words: 'Write the wording, then propose it.' } }],
  remaining: [{ id: 'd1', title: 'AC-001 is deviated' }] } }).outcome;
  assert.equal(done.kind, 'recorded');
  assert.equal(done.message, 'Drafted the amendment; a draft is not a record, and nothing is decided until it is proposed and approved.');
  assert.deepEqual(done.drafted, [`d1: drafted at ${draftPath}. Write the wording, then propose it.`]);
  const shown = decisionListHtml({ ...model.buildDecisionListView(packet()), outcome: done });
  assert.match(shown, /Drafted, not recorded:<\/strong><\/p><ul><li>d1: drafted at \/repo\/\.git\/singularity-flow\/intent-amendment-drafts\/DECIDE-1\.md\./u);
  // Drafted: the person's own step carries the draft, and the page offers to open it.
  const drafted = packet();
  drafted.items = [{ id: 'd1', kind: 'conformance-gap', title: 'AC-001 is deviated in the Conformance report', why: `A draft is at ${draftPath}.`,
    options: [{ id: 'update-spec', label: 'Update the spec: write the draft and propose it', recommended: false, words: 'Write it, then propose it.', effects: [], needs: {}, recordable: false,
      action: { command: `singularity-flow story intent-amendment propose --work-id DECIDE-1 --file "${draftPath}" --reason "<why the specification changes>"`, alternativeCommands: [], file: draftPath },
      decidedBy: { groups: [], labels: [], allowed: true, words: 'Anyone working on this Story may write and propose it.' } }],
    decidedBy: yours }];
  const view = model.buildDecisionListView(drafted);
  assert.equal(view.items[0].options[0].yours.file, draftPath);
  const html = decisionListHtml(view);
  assert.match(html, /data-yours="update-spec"[\s\S]*data-open-item="d1" data-open-option="update-spec">Open the draft<\/button>[\s\S]*<code>singularity-flow story intent-amendment propose/u);
  assert.match(DECISION_LIST_SCRIPT, /type: 'decisions\.open', item: open\.dataset\.openItem, option: open\.dataset\.openOption/u);
});

test('the page opens only the file the engine named, from the list it holds', async () => {
  const panel = await readFile(source('views/decision-list.ts'), 'utf8');
  assert.match(panel, /'decisions\.open': \(message\) => this\.open\(stringField\(message, 'item'\), stringField\(message, 'option'\)\)/u);
  assert.match(panel, /const file = option\?\.action\?\.file;\s*if \(!file \|\| !path\.isAbsolute\(file\)\) return;/u);
});
