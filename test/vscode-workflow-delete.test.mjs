/**
 * Workflow Studio's Delete… review page and the argv of archive, restore and delete.
 * [docs/SPEC-WORKFLOW-RETIREMENT-v1.md, Surfaces]
 *
 * The plan fixture has the shape `workflow delete <ID> --dry-run --json` returns. Everything here is
 * pure: no `vscode`, no process, no file is read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  byKind, cleanupWords, deletePlanFrom, deleteResultFrom, liveWorkflows, refusalOf, restoreCommand, workflowArchiveArgs,
  workflowDeleteConfirmArgs, workflowDeleteHtml, workflowDeletePreviewArgs, WORKFLOW_DELETE_SCRIPT
} from '../apps/vscode/src/views/workflow-delete-page.ts';

const SHA = `sha256:${'a'.repeat(64)}`;
const plan = (overrides = {}) => ({
  schemaVersion: 1, resultType: 'workflow-delete-plan', workflowId: 'mine', governs: 'story', selector: 'story:mine',
  removed: [
    { kind: 'story.workflow', id: 'mine' }, { kind: 'story.phases', id: 'design-mine' }, { kind: 'story.phases', id: 'build-mine' },
    { kind: 'agent', id: 'architect-mine', path: '.github/agents/architect-mine.agent.md' },
    { kind: 'template-file', path: 'singularity/templates/common/design-mine.md' }
  ],
  kept: [
    { kind: 'story.approvalAuthorities', id: 'design-reviewers', usedBy: ['story:feature', 'story:bugfix', 'initiative:initiative-lite'] },
    { kind: 'agent', id: 'developer', reason: 'built-in-agent' },
    { kind: 'skill', id: 'shared-skill', path: 'singularity/skills/shared-skill/SKILL.md', usedBy: Array.from({ length: 12 }, (_, index) => `story:flow-${index}`) }
  ],
  trimmed: [{ kind: 'agent', id: 'tester', path: '.github/agents/tester.agent.md', steps: ['build-mine'] }],
  cleanups: [{ kind: 'mcp-server-steps', id: 'playwright', steps: ['build-mine'] }, { kind: 'archive-entry', workflow: 'mine' },
    { kind: 'default-workflow', from: 'mine', to: 'bugfix' }],
  unreadableWorkflows: [],
  planSha256: SHA,
  stories: { status: 'checked', pinned: [{ id: 'PIN-1', status: 'in_progress', branch: 'PIN-1' }], unpinned: [], unchecked: [] },
  ...overrides
});
const labels = { 'story:mine': 'Mine', 'story:feature': 'Feature', 'story:bugfix': 'Bugfix', 'initiative:initiative-lite': 'Initiative lite' };
const view = (overrides = {}) => ({ label: 'Mine', selector: 'story:mine', plan: deletePlanFrom(plan()), busy: false, notice: null, error: null,
  needsDefault: false, done: null, labels, ...overrides });

test('archive, restore and delete run the engine\'s exact commands; --propose only where there is an approved destination', () => {
  assert.deepEqual(workflowDeletePreviewArgs('story:mine'), ['workflow', 'delete', 'story:mine', '--dry-run', '--json']);
  assert.deepEqual(workflowDeletePreviewArgs('story:mine', 'bugfix'), ['workflow', 'delete', 'story:mine', '--dry-run', '--new-default', 'bugfix', '--json']);
  assert.deepEqual(workflowDeleteConfirmArgs('story:mine', SHA, null, true), ['workflow', 'delete', 'story:mine', '--confirm', SHA, '--propose', '--json']);
  assert.deepEqual(workflowDeleteConfirmArgs('story:mine', SHA, 'bugfix', false), ['workflow', 'delete', 'story:mine', '--confirm', SHA, '--new-default', 'bugfix', '--json']);
  assert.deepEqual(workflowArchiveArgs('story:mine', { reason: 'Replaced', propose: true }), ['workflow', 'archive', 'story:mine', '--reason', 'Replaced', '--propose', '--json']);
  assert.deepEqual(workflowArchiveArgs('story:feature', { newDefault: 'bugfix' }), ['workflow', 'archive', 'story:feature', '--new-default', 'bugfix', '--json']);
  assert.deepEqual(workflowArchiveArgs('initiative:lite', { restore: true, reason: 'ignored', newDefault: 'ignored', propose: true }),
    ['workflow', 'restore', 'initiative:lite', '--propose', '--json'], 'a restore takes no reason and no new default');
});

test('a refusal is read off the failed run, and only workflow IDs become default choices', () => {
  const error = Object.assign(new Error('refused'), { result: { error: { code: 'WORKFLOW_DEFAULT_REPLACEMENT_REQUIRED', message: 'Pick one.',
    details: { live: ['bugfix', 'chore', '../x', 'bugfix', 7] } } } });
  const refusal = refusalOf(error);
  assert.deepEqual(refusal, { code: 'WORKFLOW_DEFAULT_REPLACEMENT_REQUIRED', message: 'Pick one.', details: { live: ['bugfix', 'chore', '../x', 'bugfix', 7] } });
  assert.deepEqual(liveWorkflows(refusal), ['bugfix', 'chore']);
  assert.equal(refusalOf(new Error('plain')), null);
  assert.equal(refusalOf({ result: { error: { code: 'not a code' } } }), null);
  assert.deepEqual(liveWorkflows(refusalOf({ result: { error: { code: 'X', message: 'm' } } })), []);
});

test('only a delete plan for a named workflow with an exact digest is shown', () => {
  assert.equal(deletePlanFrom(null), null);
  assert.equal(deletePlanFrom({ ...plan(), resultType: 'workflow-copy-plan' }), null);
  assert.equal(deletePlanFrom({ ...plan(), planSha256: 'sha256:short' }), null);
  assert.equal(deletePlanFrom({ ...plan(), selector: '../mine' }), null);
  const read = deletePlanFrom(plan({ destinationAuthority: { kind: 'remote' }, newDefault: 'bugfix', removed: [...plan().removed, { kind: 'agent' }, 'junk'] }));
  assert.equal(read.removed.length, 5, 'rows without an ID or path are dropped');
  assert.equal(read.proposes, true);
  assert.equal(read.newDefault, 'bugfix');
  assert.equal(deletePlanFrom(plan()).proposes, false, 'no approved destination: the change is written locally');
  assert.deepEqual(byKind(read.removed).map((group) => [group.label, group.entries.length]),
    [['Workflow', 1], ['Steps', 2], ['Agents', 1], ['Template files', 1]]);
  assert.equal(cleanupWords(read.cleanups[0], (selector) => labels[selector]), 'MCP server playwright stops listing build-mine');
  assert.equal(cleanupWords(read.cleanups[2], (selector) => labels[selector]), 'New Stories default to Bugfix instead');
});

test('the review page shows what goes, what stays and why, the Stories, the backup and the digest, with one Propose deletion', () => {
  const html = workflowDeleteHtml(view());
  assert.match(html, /<h1>.*Delete Mine<\/h1>/su);
  assert.match(html, /<strong>5<\/strong> removed · <strong>3<\/strong> kept/u);
  assert.match(html, /data-wd-section="removed"[\s\S]*Steps <small class="muted">2<\/small>[\s\S]*<code>design-mine<\/code>/u);
  assert.match(html, /<code>architect-mine<\/code> <small class="muted wd-path">\.github\/agents\/architect-mine\.agent\.md<\/small>/u);
  assert.match(html, /<code>singularity\/templates\/common\/design-mine\.md<\/code>/u, 'a file without an ID is named by its path');
  assert.match(html, /Used by Feature, Bugfix, Initiative lite/u, 'kept objects name the workflows that still use them');
  assert.match(html, /A built-in agent/u);
  assert.match(html, /Used by flow-0, flow-1, flow-2, flow-3, flow-4, flow-5, flow-6, flow-7 and 4 more/u);
  assert.match(html, /<code>tester<\/code> loses build-mine/u);
  assert.match(html, /Its entry in the archived-workflow list is removed/u);
  assert.match(html, /data-wd-pinned[\s\S]*PIN-1/u, 'pinned Stories keep running and are listed');
  assert.match(html, /data-wd-section="backup"[\s\S]*complete export bundle/u);
  assert.match(html, new RegExp(`data-wd-digest>${SHA}<`, 'u'));
  assert.match(html, /written to its files for you to review and commit/u);
  assert.equal((html.match(/data-wd-action="confirm"/gu) ?? []).length, 1);
  assert.match(html, /data-wd-action="confirm" data-wd-sha="sha256:a+">Propose deletion</u, 'enabled');
  const proposing = workflowDeleteHtml(view({ plan: deletePlanFrom(plan({ destinationAuthority: { kind: 'remote' } })) }));
  assert.match(proposing, /Creates a review proposal against the approved configuration/u);
  assert.match(WORKFLOW_DELETE_SCRIPT, /'delete\.' \+ target\.dataset\.wdAction/u);
});

test('unfinished Stories without a pinned copy block Propose deletion, with the engine\'s reason', () => {
  const blocked = workflowDeleteHtml(view({ plan: deletePlanFrom(plan({ stories: { status: 'checked', pinned: [],
    unpinned: [{ id: 'OLD-1', status: 'in_progress' }], unchecked: [{ id: 'GONE-1' }] } })) }));
  assert.match(blocked, /data-wd-blocked[\s\S]*used by 1 unfinished Story that run from the live configuration: OLD-1\. Finish or cancel them, or archive the workflow instead\./u);
  assert.match(blocked, /data-wd-action="confirm" data-wd-sha="sha256:a+" disabled>/u);
  assert.match(blocked, /Could not be checked here[\s\S]*GONE-1/u);
  const unavailable = workflowDeleteHtml(view({ plan: deletePlanFrom(plan({ stories: { status: 'unavailable', reason: "Story discovery requires the 'state' state branch.", pinned: [], unpinned: [], unchecked: [] } })) }));
  assert.match(unavailable, /could not be checked here: Story discovery requires the &#39;state&#39; state branch\. Proposing checks them again/u);
  assert.match(workflowDeleteHtml(view({ busy: true })), /data-wd-action="confirm" data-wd-sha="sha256:a+" disabled>/u, 'busy: one action at a time');
});

test('names are escaped, and an unreadable workflow or a new default is said plainly', () => {
  const html = workflowDeleteHtml(view({ label: '<b>Mine</b>', plan: deletePlanFrom(plan({
    removed: [{ kind: 'story.workflow', id: 'mine' }, { kind: 'skill', id: '<script>alert(1)</script>', path: 'x' }],
    unreadableWorkflows: [{ workflow: 'story:broken', message: 'Cannot parse <yaml>' }], newDefault: 'bugfix' })) }));
  assert.doesNotMatch(html, /<script>|<b>Mine/u);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(html, /Could not read broken, so every dependency is kept: Cannot parse &lt;yaml&gt;/u);
  assert.match(html, /It is the default workflow for new Stories; Bugfix becomes the default\./u);
});

test('without a plan the page offers to preview again, or to choose the new default it needs', () => {
  const failed = workflowDeleteHtml(view({ plan: null, error: 'Workflow configuration is invalid.' }));
  assert.match(failed, /data-wd-error[^>]*>.*Workflow configuration is invalid\./su);
  assert.match(failed, /data-wd-action="preview"/u);
  assert.doesNotMatch(failed, /data-wd-action="confirm"/u);
  assert.match(workflowDeleteHtml(view({ plan: null, needsDefault: true })), /data-wd-action="default">Choose new default…/u);
});

test('after the proposal the page shows its branch, the backup and how to restore it, without file contents', () => {
  const result = deleteResultFrom({ reviewRequired: true, branch: 'sflow/config-change/workflow/delete-workflow-mine-1', pushed: true,
    backup: { path: '/home/someone/.singularity-flow/workflow-backups/abc/story-mine-2026.sflow-workflows.json', bundleSha256: 'x' } });
  const html = workflowDeleteHtml(view({ done: result }));
  assert.match(html, /Deletion proposed as <code>sflow\/config-change\/workflow\/delete-workflow-mine-1<\/code>/u);
  assert.match(html, /data-wd-backup>\/home\/someone\/\.singularity-flow\/workflow-backups\/abc\/story-mine-2026\.sflow-workflows\.json</u);
  assert.match(html, /data-wd-restore>singularity-flow workflow import &quot;\/home\/someone\/[^<]*&quot; --dry-run</u);
  assert.match(html, /data-wd-action="review">Review and activate/u);
  assert.match(html, /data-wd-action="cancel">Close/u);
  assert.doesNotMatch(html, /data-wd-action="confirm"/u, 'a done delete cannot be proposed twice');
  const local = workflowDeleteHtml(view({ done: deleteResultFrom({ changed: true, backup: { path: '/tmp/b.json' } }) }));
  assert.match(local, /Deletion written to this repository/u);
  assert.doesNotMatch(local, /data-wd-action="review"/u);
  assert.equal(restoreCommand('/tmp/a "b" $c.json'), 'singularity-flow workflow import "/tmp/a \\"b\\" \\$c.json" --dry-run');
});
