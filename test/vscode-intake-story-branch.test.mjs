import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_INTAKE_FORM, intakeCommand, intakeHtml, intakePlanInputKey, intakeProblems, storyBranchName, storyPreflightCommand
} from '../apps/vscode/src/views/intake-form.ts';

const form = (overrides = {}) => ({
  ...EMPTY_INTAKE_FORM, shape: 'story', tracker: 'none', id: 'ABC-1', title: 'Fix the login page',
  description: 'Login fails for SSO users.',
  storyWorkflows: [{ id: 'feature', label: 'Feature', description: '', phases: ['intake'] }],
  workType: 'feature', baseRemote: 'origin', baseBranch: 'main',
  baseBranchChoices: [{ branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }], ...overrides
});
const after = (args, flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;

test('a typed Story branch is passed to both the readiness check and Start', () => {
  const typed = form({ storyBranch: '  bugfix/userprofile/bugfix1 ' });
  assert.equal(after(storyPreflightCommand(typed), '--ref'), 'bugfix/userprofile/bugfix1');
  assert.equal(after(intakeCommand(typed), '--ref'), 'bugfix/userprofile/bugfix1');
  assert.equal(storyBranchName(typed), 'bugfix/userprofile/bugfix1');
  // The typed name is the whole branch: no title is sent for a pattern to use.
  assert.equal(after(storyPreflightCommand(typed), '--title'), null);
  assert.notEqual(intakePlanInputKey(typed), intakePlanInputKey(form()), 'a changed branch is a changed request');
});

test('with no typed branch the engine names it, and the check sees the title Start will send', () => {
  const plain = form();
  assert.equal(after(storyPreflightCommand(plain), '--ref'), null);
  assert.equal(after(intakeCommand(plain), '--ref'), null);
  assert.equal(after(storyPreflightCommand(plain), '--title'), 'Fix the login page');
  assert.equal(after(intakeCommand(plain), '--title'), 'Fix the login page');
  assert.equal(storyBranchName(plain), 'ABC-1', 'before the check answers, the ID');
  assert.equal(storyBranchName(form({ suggestedStoryBranch: 'feature/ABC-1-fix-the-login-page' })),
    'feature/ABC-1-fix-the-login-page');
  // A tracked Story's title comes from the issue on Start; the check sends none.
  assert.equal(after(storyPreflightCommand(form({ tracker: 'jira', key: 'ABC-1' })), '--title'), null);
});

test('the form offers the field, shows where the branch goes, and refuses spaces locally', () => {
  const suggested = form({ suggestedStoryBranch: 'feature/ABC-1-fix-the-login-page', basePreflightPassed: true });
  const html = intakeHtml(suggested);
  assert.match(html, /data-field="storyBranch"/);
  assert.match(html, /placeholder="feature\/ABC-1-fix-the-login-page"/);
  assert.match(html, /Leave it empty to use <code>feature\/ABC-1-fix-the-login-page<\/code>/);
  assert.match(html, /origin\/refs\/heads\/feature\/ABC-1-fix-the-login-page/);
  assert.match(html, /<dt>Story branch<\/dt><dd>feature\/ABC-1-fix-the-login-page<\/dd>/);
  assert.doesNotMatch(intakeHtml(form({ shape: 'epic' })), /data-field="storyBranch"/, 'only Stories have a Story branch');
  assert.ok(intakeProblems(form({ storyBranch: 'feature/my branch' })).includes('A Story branch name cannot contain spaces.'));
  assert.ok(!intakeProblems(form({ storyBranch: 'feature/my-branch' })).some((problem) => /Story branch/u.test(problem)));
});
