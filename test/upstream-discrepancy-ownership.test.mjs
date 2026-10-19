import assert from 'node:assert/strict';
import test from 'node:test';

import { phaseUpstreamDiscrepancies, upstreamDiscrepanciesFromMarkdown } from '../src/phase-upstream-discrepancies.mjs';
import {
  decideUpstreamIssue, discrepancyIssueFields, discrepancyIssueRequests, discrepancyItemSha256, raiseUpstreamIssue,
  upstreamIssueDecideCommand, upstreamIssueStates, upstreamIssueTerminalBlockers, UPSTREAM_ISSUE_PROBLEM_MAXIMUM
} from '../src/upstream-issues.mjs';

const STEPS = ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release'];
const AT = '2026-10-19T00:00:00.000Z';
const section = (...items) => ['# Release report', '', '## Upstream discrepancies', '', ...items, '', '## Next steps', '- none'].join('\n');
const read = (markdown, { steps = STEPS, current = 'release' } = {}) => upstreamDiscrepanciesFromMarkdown(markdown, steps,
  { earlier: steps.map((step) => step.id ?? step).slice(0, steps.map((step) => step.id ?? step).indexOf(current)) });

// The release report item that was filed against specification because a quoted section title
// named it, with its problem cut at 300 characters and its fields dropped.
const INCIDENT = '**Verification generation 1; “Acceptance and specification results” / “Negative, regression, security, and non-functional checks”:** '
  + 'the approved Verification brief states the focused evaluator suite passed 15 tests, but the retained run log lists 13 passing and 2 skipped '
  + 'tests, and no negative-path, regression, security or non-functional check is recorded for the release candidate. '
  + '**Assumption:** the two skipped tests did not run, so their criteria have no passing witness. '
  + '**Impact:** REQ-001, REQ-002, and AC-001 remain partial in this release report. '
  + '**Proposed owner action:** verification producer/approvers rerun the suite or record why the two tests are skipped.';

function story({ labels = {}, current = 'release' } = {}) {
  const position = STEPS.indexOf(current);
  return {
    workItem: { id: 'OWN-1' }, status: 'in_progress', currentPhase: current, phaseOrder: [...STEPS],
    phases: Object.fromEntries(STEPS.map((id, index) => [id, {
      id, label: labels[id] ?? null, status: index < position ? 'approved' : index === position ? 'in_progress' : 'not_started',
      generation: index <= position ? 1 : 0, approvalPolicy: { authorities: [`${id}-approvers`] }, artifacts: []
    }]))
  };
}

const raise = (workflow, overrides = {}) => raiseUpstreamIssue(workflow, { phase: 'specification', about: 'REQ-001',
  problem: 'The specification never states the empty-input rule.', raisedBy: 'dev@example.invalid', at: AT, ...overrides });

test('the incident item belongs to the step its label names, not the first step its text mentions', () => {
  const [item] = read(section(`- ${INCIDENT}`));
  assert.equal(item.phase, 'verification');
  assert.deepEqual(item.owner, { status: 'named', named: ['verification'] });
  assert.equal(item.text, INCIDENT, 'the whole item is kept');
  assert.equal(item.assumption, 'the two skipped tests did not run, so their criteria have no passing witness.');
  assert.equal(item.impact, 'REQ-001, REQ-002, and AC-001 remain partial in this release report.');
  assert.equal(item.proposed, 'verification producer/approvers rerun the suite or record why the two tests are skipped.');
  assert.deepEqual(item.sections, ['Acceptance and specification results', 'Negative, regression, security, and non-functional checks']);

  const fields = discrepancyIssueFields(item);
  assert.ok(INCIDENT.indexOf('REQ-001') > 300, 'the clause IDs sit beyond the old 300-character cut');
  assert.equal(fields.about, 'REQ-001, REQ-002, AC-001');
  assert.equal(fields.problem, INCIDENT);
  assert.ok(!fields.problem.includes('…'));
  assert.equal(fields.assumption, item.assumption);
  assert.equal(fields.impact, item.impact);
  assert.equal(fields.proposed, 'unknown', 'an action that is not a proposal kind stays unknown; its words stay in the problem');

  const workflow = story();
  const issue = raiseUpstreamIssue(workflow, { ...fields, phase: item.phase, raisedBy: 'dev@example.invalid', at: AT,
    source: { path: 'release.md', itemSha256: discrepancyItemSha256(item.phase, item.text) } });
  assert.equal(issue.phase, 'verification');
  assert.equal(issue.problem, INCIDENT);
  assert.equal(Object.hasOwn(issue, 'supersedes'), false, 'the optional link is written only when set');
});

test('only a leading label, a producer column or an Owner field names the owner, and never two steps', () => {
  const items = read(section(
    '- The release report quotes the “Planning rows” section for REQ-004, but no step is named as its owner.',
    '- Specification and planning: both disagree about AC-002.',
    '- **Planning:** the plan has no row for AC-003. Owner: specification.',
    '- The plan has no row for AC-005; the clause is approved. Owner: planning.',
    '- **Owning step:** the data team — the export never runs.',
    '- release: this step names itself, which is not upstream.',
    '- verification (gen 1): the retained log has no AC-006 run.',
    '- `planning`: the code lives in `src/b.js`, not `specification.md`.',
    // A sentence before a colon is not a label, and a colon inside a clause ID ends nothing.
    '- The implementation and the planned evidence disagree about the value: it is 2.',
    '- OWN-1:AC-009 is untested by planning.',
    // Words after the step qualify it; only steps listed beside it ("X / Y", "X, Y") are owners too.
    '- Verification release candidate 1: the log has no AC-007 run.',
    '- Verification / release: the candidate hash differs.',
    '- Specification, planning: REQ-010 is read two ways.',
    '- Producer phase: planning. The plan row for AC-008 is missing.',
    '- Next step: rerun the suite for AC-011.'
  ));
  assert.deepEqual(items.map((item) => [item.phase, item.owner.status]), [
    [null, 'unnamed'], [null, 'conflicting'], [null, 'conflicting'], ['planning', 'named'],
    [null, 'unknown-step'], [null, 'not-earlier'], ['verification', 'named'], ['planning', 'named'], [null, 'unnamed'], [null, 'unnamed'],
    ['verification', 'named'], [null, 'conflicting'], [null, 'conflicting'], ['planning', 'named'], [null, 'unnamed']
  ]);
  assert.deepEqual(items[1].owner.named, ['specification', 'planning']);
  assert.equal(items[4].owner.value, 'the data team — the export never runs.');
});

test('renamed steps are named by their labels, the longest label first', () => {
  const steps = [{ id: 'specification', label: 'Scope' }, { id: 'design', label: 'Design' }, { id: 'design-review', label: 'Design review' },
    { id: 'verification', label: 'Quality assurance' }, { id: 'release', label: 'Release' }];
  const items = read(section(
    '- **Quality assurance generation 2; “Scope and design checks”:** the suite never ran AC-001.',
    '- Design review: the review accepted AC-002 without its screenshot.',
    '- DESIGN: the component map omits REQ-003.',
    '- design review generation 1: the checklist is empty.'
  ), { steps, current: 'release' });
  assert.deepEqual(items.map((item) => item.phase), ['verification', 'design-review', 'design', 'design-review']);
});

test('tables read the owner from their producer column and the fields from their own columns', () => {
  const items = read(section(
    '| Producer phase | Section | Problem | Assumption | Impact | Owner action |', '|---|---|---|---|---|---|',
    '| planning | REQ-002 | The specification table and the plan disagree | Empty input is an error | AC-003 untestable | Amend REQ-002 |',
    '| - | REQ-007 | Verification and planning both cite it | none | none | Accept the risk |'
  ));
  assert.deepEqual(items.map((item) => [item.phase, item.owner.status]), [['planning', 'named'], [null, 'unnamed']]);
  assert.deepEqual(discrepancyIssueFields(items[0]), { about: 'REQ-002, AC-003',
    problem: 'planning — REQ-002 — The specification table and the plan disagree — Empty input is an error — AC-003 untestable — Amend REQ-002',
    assumption: 'Empty input is an error', impact: 'AC-003 untestable', proposed: 'amend' });
  // The display reader keeps the same owners for a phase review, without the filing key.
  const review = phaseUpstreamDiscrepancies([{ path: 'r.md', content: section('- planning: x is wrong in the plan.') }],
    { phaseOrder: STEPS }, 'release');
  assert.deepEqual(review.map((entry) => [entry.phase, entry.path, Object.hasOwn(entry, 'legacyText')]), [['planning', 'r.md', false]]);
});

test('an item that wraps or nests keeps every line, and its fields are read from them', () => {
  const [item, next] = read(section(
    '- **Planning generation 2:** the plan assigns AC-001 to `src/a.js`,',
    '  but the code lives in `src/b.js`.',
    '  - Assumption: the row means `src/b.js`.',
    '  - Impact: AC-001 shows as unplanned.',
    '  - Proposed: plan correction for the AC-001 row.',
    '',
    '- specification: REQ-009 has no error case.'
  ));
  assert.equal(item.text, ['**Planning generation 2:** the plan assigns AC-001 to `src/a.js`,', 'but the code lives in `src/b.js`.',
    '- Assumption: the row means `src/b.js`.', '- Impact: AC-001 shows as unplanned.', '- Proposed: plan correction for the AC-001 row.'].join('\n'));
  assert.equal(item.phase, 'planning');
  assert.equal(item.assumption, 'the row means `src/b.js`.');
  assert.equal(item.impact, 'AC-001 shows as unplanned.');
  assert.equal(discrepancyIssueFields(item).proposed, 'plan-correction');
  assert.equal(next.phase, 'specification');
  // A field word inside a sentence is not a field.
  const [prose] = read(section('- planning: the impact: nothing more than a typo, says the plan.'));
  assert.equal(prose.impact, null);
});

test('a proposal is read only when the action opens with one of the proposal kinds', () => {
  const proposal = (action) => discrepancyIssueFields({ text: 'planning: a long enough problem statement.', proposed: action }).proposed;
  assert.equal(proposal('Amend REQ-002 to name the error case'), 'amend');
  assert.equal(proposal('return to planning'), 'return');
  assert.equal(proposal('accept-risk until the next release'), 'accept-risk');
  assert.equal(proposal('Accept risk for one sprint'), 'accept-risk');
  assert.equal(proposal('plan-correction: add the row'), 'plan-correction');
  assert.equal(proposal('Amendment of REQ-002'), 'unknown');
  assert.equal(proposal('the producer amends REQ-002'), 'unknown');
  assert.equal(proposal(null), 'unknown');
  // About lists clause IDs, never record IDs, and names how many did not fit.
  const many = Array.from({ length: 40 }, (_, index) => `REQ-${String(index + 1).padStart(3, '0')}`).join(' ');
  const about = discrepancyIssueFields({ text: `planning: UPI-001 and CR-002 are records; ${many}` }).about;
  assert.match(about, /^REQ-001, REQ-002, .* and \d+ more$/u);
  assert.ok(about.length <= 200);
  assert.equal(discrepancyIssueFields({ text: 'planning: the plan says nothing about logging.' }).about, 'recorded discrepancy');
});

test('filing skips items already filed, holds unowned and over-long ones, and replaces a wrongly owned one', () => {
  const workflow = story();
  const [item] = read(section(`- ${INCIDENT}`));
  // The old reader filed the item against specification under its first 300 characters.
  const filedWrong = raise(workflow, { about: 'recorded discrepancy', problem: item.legacyText,
    source: { path: 'release.md', itemSha256: discrepancyItemSha256('specification', item.legacyText) } });
  assert.ok(item.legacyText.endsWith('…') && item.legacyText.length === 300);
  const long = `- planning: ${'the plan row is wrong. '.repeat(50)}`;
  const items = read(section(`- ${INCIDENT}`, '- the plan never names the owning step of REQ-003.', long));
  const sorted = discrepancyIssueRequests(workflow, items.map((entry) => ({ path: 'release.md', item: entry })));
  assert.deepEqual(sorted.requests.map((request) => [request.phase, request.supersedes, request.about]),
    [['verification', filedWrong.id, 'REQ-001, REQ-002, AC-001']]);
  assert.equal(sorted.requests[0].problem, INCIDENT);
  assert.deepEqual(sorted.unowned.map((entry) => [entry.owner.status, entry.about]), [['unnamed', 'REQ-003']]);
  assert.deepEqual(sorted.tooLong.map((entry) => [entry.path, entry.length > UPSTREAM_ISSUE_PROBLEM_MAXIMUM]), [['release.md', true]]);

  // Filed whole, the item is not filed again; filed before under its cut text and right owner, neither.
  const replacement = raise(workflow, { ...sorted.requests[0] });
  assert.equal(replacement.supersedes, filedWrong.id);
  assert.deepEqual(discrepancyIssueRequests(workflow, [{ path: 'release.md', item }]).requests, []);
  const older = story();
  raise(older, { phase: 'verification', problem: item.legacyText, source: { path: 'release.md', itemSha256: discrepancyItemSha256('verification', item.legacyText) } });
  assert.deepEqual(discrepancyIssueRequests(older, [{ path: 'release.md', item }]).requests, []);
  // A wrongly owned issue that its approvers already decided is not superseded; the right owner still decides.
  const decided = story();
  raise(decided, { problem: item.legacyText, source: { path: 'release.md', itemSha256: discrepancyItemSha256('specification', item.legacyText) } });
  decideUpstreamIssue(decided, { issue: 'UPI-001', outcome: 'dismiss', reason: 'Specification does not own the verification log.',
    actor: 'lead@example.invalid', authorityGroup: 'specification-approvers', at: AT });
  assert.deepEqual(discrepancyIssueRequests(decided, [{ path: 'release.md', item }]).requests.map((request) => [request.phase, request.supersedes]),
    [['verification', null]]);
  // A named owner that never ran (a skipped step) is held too, so it cannot refuse the whole filing.
  const skipped = story();
  skipped.phases.convergence = { ...skipped.phases.convergence, status: 'skipped', generation: 0 };
  const held = discrepancyIssueRequests(skipped, read(section('- convergence: the merge note omits AC-004.', `- ${INCIDENT}`))
    .map((entry) => ({ path: 'release.md', item: entry })));
  assert.deepEqual(held.unowned.map((entry) => [entry.owner.status, entry.owner.named]), [['not-run', ['convergence']]]);
  assert.deepEqual(held.requests.map((request) => request.phase), ['verification']);
});

test('a superseding issue leaves the old one intact, superseded: it owes nothing and blocks nothing', () => {
  const workflow = story();
  const old = raise(workflow);
  const before = JSON.stringify(old);
  const replacement = raise(workflow, { phase: 'verification', about: 'AC-001', supersedes: old.id,
    problem: 'The verification log never ran AC-001 against the candidate.' });
  assert.equal(replacement.supersedes, 'UPI-001');
  assert.equal(JSON.stringify(workflow.upstreamIssues[0]), before, 'the replaced issue is never edited');
  const [first, second] = upstreamIssueStates(workflow, AT);
  assert.deepEqual([first.status, first.supersededBy, second.status, second.supersededBy], ['superseded', 'UPI-002', 'open', null]);
  // Its approvers may still close it explicitly; the dismissal names the replacement.
  assert.equal(upstreamIssueDecideCommand('OWN-1', first.issue, first.supersededBy),
    'singularity-flow upstream-issue decide UPI-001 --work-id OWN-1 --outcome dismiss --reason "Superseded by UPI-002."');
  // The replacement carries the obligation; the superseded issue is never an open blocker.
  const blockers = upstreamIssueTerminalBlockers(workflow, AT);
  assert.deepEqual(blockers.map((entry) => entry.message.split(' ')[0]), ['UPI-002']);
  assert.doesNotMatch(JSON.stringify(blockers), /UPI-001/u);

  assert.throws(() => raise(workflow, { supersedes: 'UPI-001' }), { code: 'UPSTREAM_ISSUE_SUPERSEDE_INVALID', message: /already superseded by UPI-002/u });
  assert.throws(() => raise(workflow, { supersedes: 'UPI-009' }), { code: 'UPSTREAM_ISSUE_SUPERSEDE_INVALID' });
  assert.throws(() => raise(workflow, { supersedes: 'not-an-id' }), { code: 'UPSTREAM_ISSUE_SUPERSEDE_INVALID' });
  // Only the old issue's own approvers decide it, and they still may; the dismissal names the replacement.
  decideUpstreamIssue(workflow, { issue: 'UPI-001', outcome: 'dismiss', reason: 'Superseded by UPI-002.', actor: 'lead@example.invalid',
    authorityGroup: 'specification-approvers', at: AT });
  assert.equal(raise(workflow, { supersedes: 'UPI-002', phase: 'planning' }).supersedes, 'UPI-002', 'an open issue not yet replaced can be');
  assert.equal(workflow.upstreamIssues.length, 3);
  assert.throws(() => raise(workflow, { supersedes: 'UPI-001' }), { code: 'UPSTREAM_ISSUE_SUPERSEDE_INVALID', message: /already decided \(dismiss\)/u });
});
