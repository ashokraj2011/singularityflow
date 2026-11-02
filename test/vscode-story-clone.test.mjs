import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInbox } from '../apps/vscode/src/views/inbox-model.ts';
import { workspaceStoriesHtml } from '../apps/vscode/src/views/workspace-stories-page.ts';
import { EMPTY_INTAKE_FORM, intakeCommand, intakeHtml, storyPreflightCommand } from '../apps/vscode/src/views/intake-form.ts';

test('Stories offers a repository-bound Clone Story action without attaching first', () => {
  const inbox = buildInbox(null, [{ id: 'OLD-1', title: 'Original', repositoryId: 'api', repositoryPath: '/workspace/api',
    branch: 'feature/old', status: 'closed' }], '/workspace/api');
  const html = workspaceStoriesHtml(inbox, '');
  assert.match(html, /data-clone-story="OLD-1" data-repository-id="api">Clone Story/);
});

test('cloned intake keeps edits, a new identifier, and the exact original request binding', () => {
  const form = { ...EMPTY_INTAKE_FORM, shape: 'story', tracker: 'none', id: 'NEW-2', title: 'New name',
    description: 'Changed scope', acceptanceCriteria: '', cloneFrom: 'OLD-1', cloneSourceCommit: 'a'.repeat(40),
    cloneDocuments: ['Requirements <script>'], workType: 'feature', baseBranch: 'main',
    storyWorkflows: [{ id: 'feature', label: 'Feature', description: '', phases: ['intake'] }],
    baseBranchChoices: [{ branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }] };
  const args = intakeCommand(form);
  assert.deepEqual(args.slice(0, 2), ['start', 'NEW-2']);
  for (const [flag, value] of [['--title', 'New name'], ['--description', 'Changed scope'],
    ['--clone-from', 'OLD-1'], ['--clone-source-commit', 'a'.repeat(40)], ['--acceptance-criteria', '']]) {
    assert.equal(args[args.indexOf(flag) + 1], value);
  }
  assert.ok(storyPreflightCommand(form).includes('NEW-2'));
  const html = intakeHtml(form);
  assert.match(html, /Clone of OLD-1/);
  assert.match(html, /Attach these documents again/);
  assert.doesNotMatch(html, /Requirements <script>/);
  assert.match(html, /Requirements &lt;script&gt;/);
});
