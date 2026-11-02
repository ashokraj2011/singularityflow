/**
 * A capability's repositories can use different branch names (main in one, develop in another).
 * Story intake then takes a base per repository, the way the CLI's `--from-branch <repository>=<branch>`
 * does: one row per repository, its default preselected, overrides marked, and the same refusal
 * before anything starts when a repository has nothing to use.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_INTAKE_FORM, baseBranchArguments, baseNeedsPerRepository, basePerRepositoryMode, baseSelected,
  intakeCommand, intakeHtml, intakePlanInputKey, intakeProblems, launchBaseBranch, repositoryBases,
  repositoryBasesSummary, storyPreflightCommand
} from '../apps/vscode/src/views/intake-form.ts';

const REPOSITORIES = [
  { id: 'payments-api', defaultBranch: 'main', branches: ['main'] },
  { id: 'payments-web', defaultBranch: 'develop', branches: ['develop'] },
  { id: 'ledger-core', defaultBranch: 'main', branches: ['develop', 'main'] }
];
const form = (overrides = {}) => ({
  ...EMPTY_INTAKE_FORM, shape: 'story', tracker: 'none', id: 'PAY-1', title: 'Card limits',
  description: 'Limit card spend per day.',
  storyWorkflows: [{ id: 'feature', label: 'Feature', description: '', phases: ['intake'] }],
  workType: 'feature', baseRemote: 'origin', catalogStatus: 'fresh',
  baseRepositories: REPOSITORIES, baseLaunchRepository: 'payments-api', ...overrides
});
const bases = (args) => args.flatMap((value, index) => args[index - 1] === '--from-branch' ? [value] : []);

test('with no branch in every repository, each repository is cut from its own default', () => {
  const split = form();
  assert.equal(baseNeedsPerRepository(split), true);
  assert.equal(basePerRepositoryMode(split), true, 'opened directly, without asking');
  assert.deepEqual(repositoryBases(split).map(({ id, branch, source }) => [id, branch, source]), [
    ['payments-api', 'main', 'default'], ['payments-web', 'develop', 'default'], ['ledger-core', 'main', 'default']
  ]);
  assert.equal(baseSelected(split), true);
  // Every repository named, because there is no branch for all of them.
  assert.deepEqual(bases(intakeCommand(split)), ['payments-api=main', 'payments-web=develop', 'ledger-core=main']);
  assert.deepEqual(bases(storyPreflightCommand(split)), bases(intakeCommand(split)),
    'readiness checks exactly the bases Start will use');
  assert.ok(storyPreflightCommand(split).includes('--selected-base-only'));
  assert.equal(launchBaseBranch(split), 'main');

  const html = intakeHtml(split);
  assert.match(html, /data-base-per-repository-required/);
  assert.match(html, /No branch is published in all\s+3 repositories/);
  assert.equal((html.match(/data-base-repository="/g) ?? []).length, 3, 'one row per repository');
  assert.match(html, /<select[^>]*data-base-repository="payments-web"[^>]*>[\s\S]*?<option value="develop" selected>develop \(default\)<\/option>/);
  assert.doesNotMatch(html, /data-base-per-repository(?!-required)[^>]*>/, 'nothing to opt into: it is the only way');
});

test('a branch chosen for one repository becomes its override', () => {
  const chosen = form({ baseBranchOverrides: { 'ledger-core': 'develop' } });
  assert.deepEqual(bases(intakeCommand(chosen)), ['payments-api=main', 'payments-web=develop', 'ledger-core=develop']);
  assert.equal(repositoryBases(chosen)[2].source, 'override');
  assert.match(repositoryBasesSummary(chosen), /ledger-core: develop \(override\)/);
  assert.notEqual(intakePlanInputKey(chosen), intakePlanInputKey(form()), 'a changed base is a changed request');
  // A branch the repository does not offer is never used, whatever the page sent.
  assert.equal(repositoryBases(form({ baseBranchOverrides: { 'payments-api': 'develop' } }))[0].branch, 'main');
});

test('with a shared branch, one --from-branch for all and repository=branch for each that differs', () => {
  const shared = form({
    baseRepositories: [
      { id: 'payments-api', defaultBranch: 'main', branches: ['main', 'release/24.3'] },
      { id: 'payments-web', defaultBranch: 'main', branches: ['develop', 'main', 'release/24.3'] }
    ],
    baseBranchChoices: [
      { branch: 'main', present: 2, total: 2, everywhere: true, missingFrom: [] },
      { branch: 'release/24.3', present: 2, total: 2, everywhere: true, missingFrom: [] }
    ],
    baseBranch: 'release/24.3'
  });
  assert.equal(basePerRepositoryMode(shared), false, 'one shared choice stays the default');
  assert.deepEqual(bases(intakeCommand(shared)), ['release/24.3']);
  assert.match(intakeHtml(shared), /data-base-per-repository[^-]/, 'per-repository bases are offered');

  const mixed = { ...shared, basePerRepository: true, baseBranchOverrides: { 'payments-web': 'develop' } };
  assert.deepEqual(bases(intakeCommand(mixed)), ['release/24.3', 'payments-web=develop']);
  assert.deepEqual(bases(storyPreflightCommand(mixed)), ['release/24.3', 'payments-web=develop']);
  const html = intakeHtml(mixed);
  assert.match(html, /payments-web <span class="sf-tag">override<\/span>/);
  assert.match(html, /Chosen for this repository instead of release\/24\.3\./);
  // Choosing the shared branch for a repository is no override at all.
  const same = { ...mixed, baseBranchOverrides: { 'payments-web': 'release/24.3' } };
  assert.deepEqual(bases(intakeCommand(same)), ['release/24.3']);
});

test('a repository with no shared or default branch to use is refused before anything starts', () => {
  const stuck = form({ baseRepositories: [
    { id: 'payments-api', defaultBranch: 'main', branches: ['main'] },
    { id: 'payments-web', defaultBranch: 'trunk', branches: ['develop', 'release/2'] }
  ] });
  assert.equal(baseSelected(stuck), false);
  assert.match(intakeProblems(stuck).join('\n'), /Choose a base branch for payments-web: it has no shared or default branch to use\./);
  assert.equal(storyPreflightCommand(stuck), null, 'no readiness check for an incomplete selection');
  assert.deepEqual(bases(intakeCommand(stuck)), [], 'Start never sends a partial selection');
  assert.match(intakeHtml(stuck), /<option value="" selected>Choose a branch…<\/option>/);
  const fixed = { ...stuck, baseBranchOverrides: { 'payments-web': 'develop' } };
  assert.equal(baseSelected(fixed), true);
  assert.deepEqual(bases(intakeCommand(fixed)), ['payments-api=main', 'payments-web=develop']);
});

test('the review before Start lists every repository\'s base', () => {
  const html = intakeHtml(form({ baseBranchOverrides: { 'ledger-core': 'develop' } }));
  const review = html.slice(html.indexOf('Review your Story'));
  assert.match(review, /<dt>Base branches<\/dt><dd data-intake-review-bases>/);
  assert.match(review, /<code>payments-api<\/code>: main/);
  assert.match(review, /<code>payments-web<\/code>: develop/);
  assert.match(review, /<code>ledger-core<\/code>: develop <span class="sf-tag">override<\/span>/);
});

test('a single repository keeps today\'s single choice', () => {
  const single = form({
    baseRepositories: [{ id: 'payments-api', defaultBranch: 'main', branches: ['main'] }],
    baseBranchChoices: [{ branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }],
    baseBranch: 'main'
  });
  assert.equal(basePerRepositoryMode(single), false);
  assert.deepEqual(bases(intakeCommand(single)), ['main']);
  assert.doesNotMatch(intakeHtml(single), /data-base-repository="|data-base-per-repository/);
  // An older CLI lists no repositories: nothing changes either.
  const older = form({ baseRepositories: [], baseBranchChoices: single.baseBranchChoices, baseBranch: 'main' });
  assert.deepEqual(bases(intakeCommand(older)), ['main']);
});
