import assert from 'node:assert/strict';
import test from 'node:test';
import { testCommandAmendmentPolicy } from '../src/story-test-command-amendment.mjs';

const command = file => ({ id: 'node-tests', kind: 'test',
  argv: ['node', '--test', '--test-reporter=tap', file], workingDirectory: '.', affectedRoots: ['.'],
  modelPolicy: 'never', result: { adapter: 'node-tap', path: '.sflow/results/test.tap', minimumDiscovered: 1, minimumPassed: 1 } });

function fixture() {
  const authorities = { reviewers: { label: 'Reviewers', allowAnyGitIdentity: false,
    members: [{ name: 'Reviewer', email: 'reviewer@example.test', githubLogin: null }] } };
  const approval = { mode: 'required', minimum: 1, authorities: ['reviewers'], requiredAuthorities: [], allowSelfApproval: false };
  const phases = [{ id: 'implementation', kind: 'artifact', sourceBoundary: 'application',
    qualityCommands: [{ id: 'lint', kind: 'quality', argv: ['node', 'lint.mjs'], modelPolicy: 'never' }, command('test/missing.test.mjs')], approval },
  { id: 'review', kind: 'artifact', qualityCommands: [], approval }];
  const workflow = { currentPhase: 'implementation', phaseOrder: phases.map(phase => phase.id),
    resolution: { phases, approvalAuthorities: authorities, pinnedUnrelatedSafety: { enabled: true } } };
  const candidate = structuredClone(workflow.resolution);
  candidate.phases[0].qualityCommands[1] = command('test/generated.test.mjs');
  return { workflow, candidate, authorities };
}

test('test-command scope changes only commands, preserving old pins without mutation', () => {
  const { workflow, candidate, authorities } = fixture();
  workflow.resolution.phases[0].templateSnapshot = { sha256: 'retained-closure', path: 'old-template.md' };
  const before = structuredClone(workflow); const candidateBefore = structuredClone(candidate);
  const result = testCommandAmendmentPolicy(workflow, candidate, authorities);
  assert.deepEqual(workflow, before); assert.deepEqual(candidate, candidateBefore);
  assert.deepEqual(result.proposed.pinnedUnrelatedSafety, { enabled: true });
  assert.deepEqual(result.proposed.phases[0].templateSnapshot, workflow.resolution.phases[0].templateSnapshot);
  assert.deepEqual(result.proposed.phases[0].qualityCommands, candidate.phases[0].qualityCommands);
  assert.equal(result.proposed.testRecovery, undefined, 'a legacy Story is not opted into TRP');
});

for (const retainLint of [false, true]) {
  test(`test-command scope can add the absent explicit runner${retainLint ? ' while retaining structured lint' : ''}`, () => {
    const { workflow, candidate, authorities } = fixture();
    for (const phase of [workflow.resolution.phases[0], candidate.phases[0]]) phase.generation = { task: 'code' };
    workflow.resolution.phases[0].qualityCommands = retainLint ? [workflow.resolution.phases[0].qualityCommands[0]] : [];
    candidate.phases[0].qualityCommands = [...structuredClone(workflow.resolution.phases[0].qualityCommands), command('test/generated.test.mjs')];
    const result = testCommandAmendmentPolicy(workflow, candidate, authorities);
    assert.equal(result.oldCommands.filter(entry => entry.kind === 'test').length, 0);
    assert.deepEqual(result.proposed.phases[0].qualityCommands, candidate.phases[0].qualityCommands);
  });
}

for (const [label, mutate, code] of [
  ['topology', value => value.candidate.phases.reverse(), 'TCA_AMENDMENT_UNSUPPORTED'],
  ['source boundary', value => { value.candidate.phases[0].sourceBoundary = 'test-automation'; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['unaffected phase', value => { value.candidate.phases[1].kind = 'skill'; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['non-test gate', value => { value.candidate.phases[0].qualityCommands[0].argv = ['node', 'other-lint.mjs']; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['global code-delivery policy', value => { value.workflow.resolution.codeDelivery = { policy: 'required' }; value.candidate.codeDelivery = { policy: 'optional' }; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['global test-recovery risk policy', value => { value.workflow.resolution.testRecovery = { enabled: true, riskAuthorities: ['reviewers'] }; value.candidate.testRecovery = { enabled: true, riskAuthorities: ['new-reviewers'] }; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['test-recovery removal', value => { value.workflow.resolution.testRecovery = { enabled: true }; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['test-recovery opt-in', value => { value.candidate.testRecovery = { enabled: true }; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['original authority', value => { value.candidate.phases[0].approval.authorities = ['new-reviewers']; }, 'TCA_AMENDMENT_AUTHORITY_CHANGED'],
  ['candidate self grant', value => { value.authorities = { reviewers: { allowAnyGitIdentity: true } }; }, 'TCA_AMENDMENT_AUTHORITY_CHANGED'],
  ['larger quorum', value => { value.workflow.resolution.phases[0].approval.minimum = 2; value.candidate.phases[0].approval.minimum = 2; }, 'TCA_AMENDMENT_AUTHORITY_UNSUPPORTED'],
  ['no change', value => { value.candidate.phases[0].qualityCommands = structuredClone(value.workflow.resolution.phases[0].qualityCommands); }, 'TCA_AMENDMENT_NO_CHANGE'],
  ['duplicate test identity', value => { value.candidate.phases[0].qualityCommands.push(command('test/another.test.mjs')); }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['removing a test command', value => { value.workflow.resolution.phases[0].qualityCommands.push({ ...command('test/extra.test.mjs'), id: 'extra-tests' }); }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['renaming a test command', value => { value.candidate.phases[0].qualityCommands[1].id = 'replacement-tests'; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['adding unrelated test coverage command', value => { value.candidate.phases[0].qualityCommands.push({ ...command('test/extra.test.mjs'), id: 'extra-tests' }); }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['lowered discovery minimum', value => { value.workflow.resolution.phases[0].qualityCommands[1].result.minimumDiscovered = 2; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['lowered passing minimum', value => { value.workflow.resolution.phases[0].qualityCommands[1].result.minimumPassed = 2; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['shrinking affected roots', value => { value.candidate.phases[0].qualityCommands[1].affectedRoots = ['src/one']; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['changing test source extensions', value => { value.candidate.phases[0].qualityCommands[1].result.sourceExtensions = ['.mts']; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['advisory test requirement', value => { value.candidate.phases[0].qualityCommands[1].requirement = 'advisory'; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['legacy string runner', value => { value.candidate.phases[0].qualityCommands[1] = 'npm test'; }, 'CODE_TEST_RESULT_REQUIRED'],
  ['unstructured original runner', value => { value.workflow.resolution.phases[0].qualityCommands[1] = 'npm test'; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['undeclared code phase addition', value => { value.workflow.resolution.phases[0].qualityCommands = []; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['ambiguous non-test string addition', value => { value.workflow.resolution.phases[0].generation = { task: 'code' }; value.candidate.phases[0].generation = { task: 'code' }; value.workflow.resolution.phases[0].qualityCommands = ['custom-runner']; value.candidate.phases[0].qualityCommands = ['custom-runner', command('test/generated.test.mjs')]; }, 'TCA_AMENDMENT_UNSUPPORTED'],
  ['zero-test suppression', value => { value.candidate.phases[0].qualityCommands[1].argv.push('--passWithNoTests'); }, 'CODE_TEST_SUPPRESSED']
]) {
  test(`test-command scope refuses ${label}`, () => {
    const value = fixture(); mutate(value);
    const before = structuredClone(value.workflow);
    assert.throws(() => testCommandAmendmentPolicy(value.workflow, value.candidate, value.authorities), { code });
    assert.deepEqual(value.workflow, before);
  });
}
