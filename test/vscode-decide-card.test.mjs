/**
 * Everything a step waits on, on one page. The page never preselects an answer or fills in a reason,
 * re-rendering keeps what was typed, one answer reaches only rows that offer it, and each keeps its reason.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DECIDE_SCRIPT, decideChoicesFrom, decideDraftFrom, decideHtml, decideRows, decideSummary, GUARD_WORDS, guardRoute, openRows, sharedAnswers } from '../apps/vscode/src/views/decide-card-page.ts';
import { decisionAnswersFromChoices } from '../apps/vscode/src/views/decision-list-model.ts';

const allowed = { allowed: true, words: 'You may decide this (Plan approvers).', groups: ['planners'] };
const row = (id, file, options) => ({ id, kind: 'plan-accounting', title: `Say where ${file} belongs`, why: `${file} changed and no row names it.`, decidedBy: allowed, details: { path: file }, options });
const choice = (id, label, needs = { reason: { default: '', minimum: 20, maximum: 1000 } }) => ({ id, label, recommended: false, words: '', effects: [{ kind: 'plan-amendment' }], needs, decidedBy: allowed });
const packet = (fields = {}) => ({
  resultType: 'sflow-decisions', workId: 'PAY-1', phase: 'implementation', phaseLabel: 'Code', repositoryPath: '/repo', status: 'decisions-needed', headline: 'Code can\'t be approved yet.', packetSha256: `sha256:${'a'.repeat(64)}`,
  items: [row('d1', 'a.js', [choice('row-req-1', 'Add to REQ-001'), choice('row-req-2', 'Add to REQ-002')]),
    row('d2', 'package.json', [choice('row-req-1', 'Add to REQ-001'), choice('supporting', 'List it as a supporting change')]),
    { id: 'd3', kind: 'test-run-risk', title: 'The tests could not run', why: 'The browser is missing.', decidedBy: allowed, options: [choice('accept-test-risk', 'Accept until a date', {
      reason: { default: 'A suggested reason.', minimum: 20, maximum: 1000 }, cause: { default: 'A suggested cause.', minimum: 10, maximum: 300 }, expires: { default: '2026-12-01', latest: '2027-01-01' } })] },
    { id: 'd4', kind: 'evidence-obligation', title: 'Check the screenshot', why: 'A person looks.', decidedBy: allowed, options: [{ id: 'witness-1', label: 'I checked shot.png', recommended: false, recordable: false, effects: [], needs: {}, decidedBy: allowed,
      action: { command: 'singularity-flow decision witness', humanReview: { kind: 'witness', clauseId: 'PAY-1:AC-001', slot: 'visual', method: 'visual', files: ['shot.png'], owners: [], contextBinding: 'sha256:b' } } }] },
    { id: 'd5', kind: 'approval-hold', title: 'A dirty checkout', why: 'Files changed.', decidedBy: allowed, options: [{ id: 'route', label: 'Clear it', recommended: false, recordable: false, effects: [], needs: {}, decidedBy: allowed, action: { command: 'singularity-flow recover PAY-1 --json' } }] },
    { id: 'd6', kind: 'test-command', title: 'Theirs', why: 'Another group.', decidedBy: { allowed: false, words: 'The Leads decide this; ask them.', share: '/sf-decide PAY-1' }, options: [{ ...choice('accept-test-command', 'Accept it'), decidedBy: { allowed: false, words: 'The Leads decide this; ask them.' } }] },
    { id: 'd7', kind: 'approval', title: 'Approve Code', why: 'Waits.', decidedBy: allowed, options: [{ id: 'approve', label: 'Approve', recommended: false, recordable: false, effects: [], needs: {}, decidedBy: allowed, action: { command: 'singularity-flow approve implementation' } }] }],
  ...fields
});
const answer = (item, title, option, reason = '', extra = {}) => ({ item, title, option, reason, cause: '', expires: '', ...extra });

test('the page preselects nothing, suggests no answer, and the approval is not a row', () => {
  const html = decideHtml(packet());
  assert.doesNotMatch(html, /<option[^>]* selected/u, 'an answer was chosen for the person');
  assert.doesNotMatch(html, /value="(?:A suggested|2026-12-01)/u, 'a suggestion was filled in for the person');
  assert.match(html, /placeholder="A suggested reason\."/u);
  assert.doesNotMatch(html, /Approve Code/u, 'the approval has its own page');
  assert.equal(decideRows(packet()).some((item) => item.kind === 'approval'), false);
});

test('each kind of row offers what it really is: a choice, the sign-off, a step that stays in a terminal, or who decides', () => {
  const html = decideHtml(packet());
  assert.match(html, /data-open="a\.js"/u);
  assert.match(html, /data-needs="reason cause expires"/u);
  assert.match(html, /data-witness="witness-1"/u);
  assert.match(html, /This one stays in your terminal\.[\s\S]*singularity-flow recover PAY-1 --json[\s\S]*data-terminal="route"/u);
  assert.doesNotMatch(html.slice(html.indexOf('data-other="d6"')), /data-choice/u, 'no control on what is not theirs');
  assert.match(html, /The Leads decide this; ask them\.[\s\S]*\/sf-decide PAY-1/u);
  assert.equal(decideHtml(packet({ items: [packet().items[5]] })).includes('data-review disabled'), true, 'nothing to record, nothing to press');
});

test('one answer is offered only where two rows share it, and never one that needs a date', () => {
  assert.deepEqual(sharedAnswers(packet()).map((entry) => [entry.id, entry.rows]), [['row-req-1', 2]]);
  assert.match(decideHtml(packet()), /Add to REQ-001 \(2 rows\)/u);
  assert.doesNotMatch(decideHtml(packet({ items: [packet().items[0]] })), /dc-all-choice/u);
});

test('a re-render keeps every answer typed, by what it is, not by its number', () => {
  const message = { type: 'decide.review', rows: [answer('d1', 'Say where a.js belongs', 'row-req-2', 'Typed & kept <here>.'), answer('d3', 'The tests could not run', 'accept-test-risk', 'Mine', { cause: 'No browser', expires: '2026-12-02' })] };
  const draft = decideDraftFrom(message);
  const html = decideHtml(packet(), { error: 'Refused.', draft });
  assert.match(html, /<option value="row-req-2"[^>]* selected/u);
  assert.match(html, /value="Typed &amp; kept &lt;here&gt;\."/u);
  assert.match(html, /value="No browser"/u);
  assert.match(html, /value="2026-12-02"/u);
  assert.match(html, /Refused\./u);
  // The list changed and numbers moved: the same row keeps its answer under its new number.
  const moved = packet({ items: [{ ...packet().items[0], id: 'd9' }] });
  assert.match(decideHtml(moved, { draft }), /<tr data-item="d9"[\s\S]*<option value="row-req-2"[^>]* selected/u);
});

test('only rows with a decision are answers, each with its own reason, and a blank reason is refused', () => {
  const list = packet();
  assert.match(decideChoicesFrom(list, { type: 'x', rows: [answer('d1', 't', '')] }).problem, /at least one row/u);
  assert.match(decideChoicesFrom(list, { type: 'x', rows: [answer('d1', 't', '', 'A reason with no decision')] }).problem, /Choose a decision for/u);
  assert.match(decideChoicesFrom(list, { type: 'x', rows: [answer('d99', 't', 'row-req-1')] }).problem, /not on this list/u);
  const { choices } = decideChoicesFrom(list, { type: 'x', rows: [answer('d1', 't', 'row-req-1', 'The first file\'s own reason.'), answer('d2', 't', 'supporting', 'The second file\'s own reason.')] });
  const { answers, errors } = decisionAnswersFromChoices(list, choices, { today: '2026-11-06' });
  assert.deepEqual(errors, []);
  assert.deepEqual(answers.choose, { d1: 'row-req-1', d2: 'supporting' });
  assert.deepEqual(answers.reason, { d1: 'The first file\'s own reason.', d2: 'The second file\'s own reason.' });
  const blank = decisionAnswersFromChoices(list, decideChoicesFrom(list, { type: 'x', rows: [answer('d1', 't', 'row-req-1', '  ')] }).choices, { today: '2026-11-06' });
  assert.match(blank.errors[0], /the reason must be 20 to 1000/u);
  const noDate = decisionAnswersFromChoices(list, decideChoicesFrom(list, { type: 'x', rows: [answer('d3', 't', 'accept-test-risk', 'A reason of a good length here.', { cause: 'No browser here' })] }).choices, { today: '2026-11-06' });
  assert.match(noDate.errors[0], /choose a date/u, 'a date is never chosen for the person');
});

test('the person confirms every answer with its reason, and what stays undecided', () => {
  const list = packet();
  const summary = decideSummary(list, [{ item: 'd1', option: 'row-req-1', reason: 'Its own reason.' }, { item: 'd3', option: 'accept-test-risk', reason: 'Another.', cause: 'No browser', expires: '2026-12-02' }]);
  assert.match(summary, /Say where a\.js belongs: Add to REQ-001\. Reason: Its own reason\./u);
  assert.match(summary, /Until 2026-12-02\. What stops the tests: No browser\. Reason: Another\./u);
  assert.match(summary, /Still undecided: Say where package\.json belongs; Check the screenshot; A dirty checkout/u);
});

test('a Story signed with SF Guard hands over one command with nothing to fill in, and keeps the answers on the page', () => {
  const html = decideHtml(packet(), { error: GUARD_WORDS, route: guardRoute('PAY-1'), draft: decideDraftFrom({ type: 'x', rows: [answer('d1', 'Say where a.js belongs', 'row-req-2', 'Kept here.')] }) });
  assert.match(html, /Touch ID is taken in your own terminal, so nothing was written here/u);
  assert.match(html, /<code>singularity-flow decisions record PAY-1<\/code><button type="button" data-route>/u);
  assert.doesNotMatch(guardRoute('PAY-1'), /</u, 'nothing to fill in');
  assert.match(html, /value="Kept here\."/u);
  assert.doesNotMatch(decideHtml(packet()), /data-route/u);
});

test('the page script uses the one VS Code handle page() already took', () => {
  assert.match(DECIDE_SCRIPT, /window\.__sfVscode/u);
  assert.doesNotMatch(DECIDE_SCRIPT, /acquireVsCodeApi/u, 'a second call kills every button');
});

const scopeRow = (id, statement) => ({ id, kind: 'owed-decision', title: `Decide scope item ${id}`, why: `"${statement}" needs a link.`, decidedBy: allowed, details: { scopeItem: id }, options: [
  choice('scope-included', 'Included: named clauses carry it', { clause: { known: ['PAY-1:REQ-001', 'PAY-1:REQ-002'] }, reason: { default: '', minimum: 20, maximum: 1000 } }),
  choice('scope-excluded', 'Exclude it from this Story')] });
const checklist = { articles: [{ id: 'completeness', title: 'Completeness', question: 'Is every scenario covered?' }, { id: 'ambiguity', title: 'Ambiguity', question: 'Is it free of ambiguity?' }], decisions: ['satisfied', 'exception', 'not-applicable'] };
const review = { id: 'd9', kind: 'scope-completeness', title: 'Review the scope for completeness', why: 'Nothing waits on this review.', decidedBy: allowed, details: {}, options: [
  choice('reviewed', 'I reviewed it: record my answers', { article: checklist, reason: { default: '', minimum: 20, maximum: 1000 } })] };

test('a scope statement asks for clauses only where they carry it, and one answer never covers them', () => {
  const list = packet({ items: [scopeRow('d1', 'It must export.'), scopeRow('d2', 'It must log.')] });
  const html = decideHtml(list);
  assert.match(html, /data-needs="clause reason"/u);
  assert.match(html, /data-field="clause"[^>]*placeholder="Clauses: PAY-1:REQ-001, PAY-1:REQ-002"/u);
  assert.deepEqual(sharedAnswers(list).map((entry) => entry.id), ['scope-excluded'], 'naming clauses is each row\'s own');
  const noClause = decisionAnswersFromChoices(list, decideChoicesFrom(list, { type: 'x', rows: [answer('d1', 't', 'scope-included', 'The first requirement carries it.')] }).choices, { today: '2026-11-06' });
  assert.match(noClause.errors[0], /name the clauses/u);
  const { choices } = decideChoicesFrom(list, { type: 'x', rows: [answer('d1', 't', 'scope-included', 'The first requirement carries it.', { clause: 'REQ-001' }), answer('d2', 't', 'scope-excluded', 'Logging is not part of this Story.', { clause: 'ignored' })] });
  const { answers, errors } = decisionAnswersFromChoices(list, choices, { today: '2026-11-06' });
  assert.deepEqual(errors, []);
  assert.deepEqual(answers.clause, { d1: 'REQ-001' }, 'a disposition with no clauses never carries any');
  assert.match(decideSummary(list, choices), /Carried by REQ-001\./u);
  const kept = decideHtml(list, { draft: decideDraftFrom({ type: 'x', rows: [answer('Decide scope item d1', 'Decide scope item d1', 'scope-included', 'x', { clause: 'REQ-002' })] }) });
  assert.match(kept, /value="REQ-002"/u, 'a re-render keeps the clauses typed');
});

test('a review nothing waits on is offered, answered article by article, and never counted as open', () => {
  const list = packet({ items: [scopeRow('d1', 'It must export.')], offered: [review] });
  assert.deepEqual(openRows(list).map((item) => item.id), ['d1']);
  assert.deepEqual(decideRows(list).map((item) => item.id), ['d1', 'd9']);
  const html = decideHtml(list);
  assert.match(html, /<select data-article="completeness"/u);
  assert.doesNotMatch(html, /<option value="satisfied"[^>]* selected/u, 'no article is answered for the person');
  const row = (article, reason = 'I looked at all of it, carefully.') => ({ type: 'x', rows: [answer('d9', 't', 'reviewed', reason, { article })] });
  const partial = decisionAnswersFromChoices(list, decideChoicesFrom(list, row([{ article: 'completeness', decision: 'satisfied' }])).choices, { today: '2026-11-06' });
  assert.match(partial.errors[0], /answer every article/u);
  const noWhy = decisionAnswersFromChoices(list, decideChoicesFrom(list, row([{ article: 'completeness', decision: 'satisfied' }, { article: 'ambiguity', decision: 'exception', reason: ' ' }])).choices, { today: '2026-11-06' });
  assert.match(noWhy.errors[0], /needs its own reason/u);
  const { choices } = decideChoicesFrom(list, row([{ article: 'completeness', decision: 'satisfied', reason: 'dropped' }, { article: 'ambiguity', decision: 'exception', reason: 'Two words read two ways.' }]));
  const { answers, errors } = decisionAnswersFromChoices(list, choices, { today: '2026-11-06' });
  assert.deepEqual(errors, []);
  assert.deepEqual(answers.article.d9, [{ article: 'completeness', decision: 'satisfied' }, { article: 'ambiguity', decision: 'exception', reason: 'Two words read two ways.' }]);
  assert.match(decideSummary(list, choices), /ambiguity: exception \(Two words read two ways\.\)/u);
  assert.doesNotMatch(decideSummary(list, choices), /Still undecided: .*Review the scope/u);
});
