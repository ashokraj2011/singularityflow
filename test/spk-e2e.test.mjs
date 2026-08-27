/**
 * The end-to-end fixture. `[SPK:AC-008]`
 *
 * One Story, from a fresh clone, through specification, planning, implementation, deterministic
 * convergence, a human-selected rework, a second convergence iteration, verification, conformance
 * and release. Every command is the real binary against a real git repository.
 *
 * The reason a fixture this long earns its runtime is that nothing else in the suite can catch a
 * *sequencing* defect. Each unit test builds exactly the state its subject needs; only a full run
 * discovers that one phase leaves state the next cannot use, or that a gate someone added at
 * publication makes a later phase unreachable. Both of those have happened in this pack, and both
 * were found by driving rather than by testing.
 *
 * The Story is deliberately small — two requirements and a handful of files. Length here buys
 * nothing; the value is in the transitions between phases, not the size of the artifacts.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const WORK = 'E2E-1';

function shell(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_LOG_CONSOLE: 'error' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\nexit ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return { ...result, output: `${result.stdout}${result.stderr}` };
}

const git = (cwd, ...args) => shell('git', args, cwd).stdout.trim();
const sflow = (cwd, args, options) => shell(process.execPath, [CLI, ...args], cwd, options);

async function write(root, relative, contents) {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
}

const workflowOf = async (root) =>
  JSON.parse(await readFile(path.join(root, `singularity/work-items/${WORK}/workflow.json`), 'utf8'));

/**
 * Commit and push anything the publication transaction left behind.
 *
 * Under `git.publish: required` the transaction commits and pushes for itself, so there is usually
 * nothing here — but source files written outside a governed generation are the caller's, and a
 * commit that finds nothing is a normal outcome rather than a failure.
 */
function settle(root, message) {
  if (!git(root, 'status', '--porcelain')) return;
  // Structured test reports are workspace-local execution output. Leaving them untracked keeps
  // this helper from turning them into application source merely because it settles with Git.
  git(root, 'add', '-A', '--', '.', ':(exclude).sflow/results/**');
  if (!git(root, 'diff', '--cached', '--name-only')) return;
  git(root, 'commit', '-m', message);
  shell('git', ['push', '-q', 'origin', WORK], root, { allowFailure: true });
}

/** Publish, commit, submit and approve one phase the way a person would. */
async function completePhase(root, phase, { articles = [] } = {}) {
  sflow(root, ['artifact', 'scan', '--phase', phase]);
  sflow(root, ['phase', 'publish', phase, '--authored', 'human', '--channel', 'manual-in-place']);
  settle(root, `[${WORK}][phase:${phase}] settle`);
  sflow(root, phase === 'implementation' ? ['submit', phase] : ['submit', phase, '--skip-checks']);
  const approval = ['approve', phase, '--yes', ...articles.flatMap((article) => ['--article', article])];
  const result = sflow(root, approval, { allowFailure: true });
  if (result.status !== 0 && !/already approved|not awaiting/.test(result.output)) {
    throw new Error(`approve ${phase}\n${result.output}`);
  }
  return result;
}

const SATISFIED = [
  'completeness=satisfied', 'ambiguity=satisfied', 'consistency=satisfied',
  'verifiability=satisfied', 'boundary-conditions=satisfied', 'non-functional=satisfied'
];

test('a Story runs specification through release from a fresh clone', async (t) => {
  t.diagnostic('AC-008 drives the real binary through every phase; it is slow on purpose.');

  // ---- a fresh clone, with a remote, exactly as a team would have -------------------------------
  const origin = await mkdtemp(path.join(os.tmpdir(), 'sflow-e2e-origin-'));
  // -b main: a bare repository's HEAD otherwise points at this git's default branch name, and a
  // clone of it checks out a branch that does not exist — an empty tree that fails much later.
  shell('git', ['init', '-q', '--bare', '-b', 'main', '.'], origin);
  const seed = await mkdtemp(path.join(os.tmpdir(), 'sflow-e2e-seed-'));
  git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.name', 'End To End');
  git(seed, 'config', 'user.email', 'e2e@example.invalid');
  await write(seed, 'README.md', '# Payments\n');
  await write(seed, 'src/payments/attempts.ts', 'export const attempts = [];\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'initial');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  // `init` writes the governed definition on a Work-ID branch and leaves it uncommitted, so the
  // base branch is never touched by accident. Seeding `main` means committing it there deliberately.
  sflow(seed, ['init', '--work-id', 'SEED', '--base', 'main']);
  const workflowPath = path.join(seed, 'singularity/workflow.yml');
  const workflow = YAML.parse(await readFile(workflowPath, 'utf8'));
  workflow.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(workflow.approvalAuthorities ?? {})) authority.allowAnyGitIdentity = true;
  for (const phase of Object.values(workflow.phases ?? {})) {
    if (phase.approval && phase.approval !== 'none') phase.approval.allowSelfApproval = true;
  }
  await writeFile(workflowPath, YAML.stringify(workflow));
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'governance');
  git(seed, 'checkout', '-q', 'main');
  git(seed, 'checkout', '-q', 'SEED', '--', 'singularity', '.github');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-m', 'governance');
  git(seed, 'push', '-q', 'origin', 'main');

  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-e2e-clone-'));
  shell('git', ['clone', '-q', '-b', 'main', origin, '.'], root);
  git(root, 'config', 'user.name', 'End To End');
  git(root, 'config', 'user.email', 'e2e@example.invalid');

  sflow(root, ['start', WORK, '--from-branch', 'main', '--work-type', 'spec-driven-standard',
    '--title', 'Retry a failed payment', '--description', 'Let an operator retry a payment that failed at the provider.']);
  assert.equal((await workflowOf(root)).currentPhase, 'specification');

  /**
   * `[SPK:REQ-019]`: a fast-path action is resumable and idempotent at the same binding.
   *
   * The Story is at the first checkpoint, which is where a person actually repeats a verb — they
   * run `specify`, read that an agent has to author the artifact, and run it again to see where
   * they are. Twice must be exactly once: same answer, no commit, no state, no dirty tree. A verb
   * that half-advanced here would do it before anyone had authored anything to advance.
   */
  const head = git(root, 'rev-parse', 'HEAD');
  const firstSpecify = sflow(root, ['specify']).output;
  const secondSpecify = sflow(root, ['specify']).output;
  assert.equal(secondSpecify, firstSpecify, 'a repeated fast-path verb answered differently');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head, 'a fast-path checkpoint created a commit');
  assert.equal(git(root, 'status', '--porcelain'), '', 'a fast-path checkpoint left the tree dirty');
  assert.match(firstSpecify, /No governed state, files, publications or external systems were changed/);
  assert.deepEqual((await workflowOf(root)).phases.specification.artifacts, [],
    'a fast-path checkpoint registered an artifact nobody authored');

  // ---- specification ---------------------------------------------------------------------------
  await write(root, `singularity/work-items/${WORK}/artifacts/specification/spec.md`, [
    '# Specification — Retry a failed payment', '',
    '## Actors', '', 'An operator holding the payments role.', '',
    '## User scenarios', '',
    '- **Given** a payment that failed at the provider',
    '  **When** an operator retries it',
    '  **Then** a new attempt is created and the original is preserved.', '',
    '## Requirements', '',
    '- The system creates a new attempt when an operator retries a failed payment. [E2E:REQ-001]',
    '- The system preserves the original failed attempt and its provider response. [E2E:REQ-002]', ''
  ].join('\n'));
  await completePhase(root, 'specification', { articles: SATISFIED });
  assert.equal((await workflowOf(root)).phases.specification.status, 'approved');

  // The specification's artifact set was catalogued and the approval bound the whole bundle.
  const afterSpecification = await workflowOf(root);
  assert.equal(afterSpecification.phases.specification.artifactSet.setId, 'spec-driven-specification');
  assert.match(afterSpecification.phases.specification.approvals.at(-1).bundleSha256, /^[0-9a-f]{64}$/);
  assert.equal(afterSpecification.phases.specification.approvals.at(-1).checklist.length, 6);

  // ---- planning, with the advisory task map derived from the approved specification -------------
  sflow(root, ['spec', 'tasks']);
  const tasks = await readFile(path.join(root, `singularity/work-items/${WORK}/artifacts/planning/tasks.md`), 'utf8');
  assert.match(tasks, /E2E:REQ-001/);
  assert.match(tasks, /not evidence/, 'the derived task map does not declare itself advisory');

  await write(root, `singularity/work-items/${WORK}/artifacts/planning/plan.md`, [
    '# Implementation plan — Retry a failed payment', '',
    '## Approach', '', 'Append a new attempt row rather than mutating the failed one.', '',
    '## Affected surfaces', '',
    '| Surface | Change | Serves |', '|---|---|---|',
    '| `src/payments/retry.ts` | new retry handler | E2E:REQ-001 |',
    '| `src/payments/attempts.ts` | append-only attempts | E2E:REQ-002 |', '',
    '## Verification', '',
    '| Clause | Proof |', '|---|---|', '| E2E:REQ-001 | retry creates an attempt |', ''
  ].join('\n'));
  await completePhase(root, 'planning');
  assert.equal((await workflowOf(root)).phases.planning.status, 'approved');

  // ---- implementation: source and artifact, one requirement deliberately unclaimed --------------
  sflow(root, ['prepare', 'implementation']);
  await write(root, 'src/payments/retry.ts', 'export function retry() { return { attempt: 1 }; }\n');
  await write(root, 'tests/payments-retry.test.mjs', [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    '',
    '/** @ac:E2E:AC-001 */',
    "test('retry example remains deterministic', () => assert.deepEqual({ attempt: 1 }, { attempt: 1 }));",
    ''
  ].join('\n'));
  await write(root, `singularity/work-items/${WORK}/artifacts/implementation/implementation-summary.md`, [
    '# Implementation summary', '',
    'Added the retry handler. The append-only change to attempts is not done yet, so this generation',
    'deliberately claims only one of the two requirements — the convergence iteration below is what',
    'that omission is for.', '',
    '## Changes', '', '- `src/payments/retry.ts`: new retry handler serving E2E:REQ-001.', ''
  ].join('\n'));
  await write(root, `singularity/work-items/${WORK}/artifacts/implementation/operator-notes.md`, [
    '# Operator notes', '',
    'The provider sandbox and local retry harness remain available for later verification.', ''
  ].join('\n'));
  await completePhase(root, 'implementation');
  assert.equal((await workflowOf(root)).phases.implementation.status, 'approved');

  // ---- convergence, iteration one ---------------------------------------------------------------
  const first = sflow(root, ['story', 'converge', '--json']);
  const iteration = JSON.parse(first.stdout);
  assert.equal(iteration.iteration, 1);
  assert.ok(iteration.facts.length > 0, 'convergence found nothing on a Story with an unclaimed requirement');
  assert.deepEqual(iteration.allowedNext, ['adjudicate'], 'undisposed facts allowed something other than adjudication');
  assert.deepEqual(iteration.findings, [], 'a fact became a finding without a human');

  // Every fact describes the record, never the implementation `[SPK:CON-033]`.
  for (const fact of iteration.facts) {
    for (const match of fact.detail.matchAll(/\b(unimplemented|unplanned)\b/g)) {
      assert.match(fact.detail.slice(0, match.index), /\bnot\b[^.]*$/, `a fact overstates: ${fact.detail}`);
    }
  }

  // A human disposes of each one; the REQ-002 absence becomes rework.
  const absent = iteration.facts.find((fact) => fact.kind === 'absent-observed-claim' && fact.clauseIds.includes('E2E:REQ-002'))
    ?? iteration.facts.find((fact) => fact.kind === 'absent-observed-claim');
  assert.ok(absent, 'no absent-claim fact to adjudicate');
  sflow(root, ['story', 'adjudicate', absent.id, '--disposition', 'rework', '--clause', 'E2E:REQ-002']);
  for (const fact of iteration.facts.filter((entry) => entry.id !== absent.id)) {
    sflow(root, ['story', 'adjudicate', fact.id, '--disposition', 'dismissed', '--reason', 'Refactor noise; no requirement claims it.']);
  }

  const blocked = JSON.parse(sflow(root, ['story', 'converge', '--json']).stdout);
  assert.ok(blocked.unresolvedBlockers.length, 'rework produced no blocker');
  assert.deepEqual(blocked.allowedNext, ['create-rework']);
  // `[SPK:REQ-183]`: advancement fails while a blocker remains.
  const refused = sflow(root, ['story', 'advance', '--confirm'], { allowFailure: true });
  assert.notEqual(refused.status, 0, 'advancement succeeded with an unresolved blocker');
  assert.match(refused.output, /cannot advance to verification/i);

  // ---- human-selected rework, through the existing governed change request `[SPK:AC-003]` -------
  // `story rework`, the one caller allowed to return an unsubmitted convergence phase, and only
  // because the projection it names carries a blocking rework finding.
  const preview = sflow(root, ['story', 'rework']);
  assert.match(preview.output, /would return E2E-1 to implementation/i);
  sflow(root, ['story', 'rework', '--confirm',
    '--reason', 'REQ-002 has no observed claim; append-only attempts are still missing.']);
  const reopened = await workflowOf(root);
  assert.equal(reopened.currentPhase, 'implementation');
  assert.equal(reopened.changeRequests.at(-1).targetPhase, 'implementation');
  assert.deepEqual(reopened.changeRequests.at(-1).clauseIds, ['E2E:REQ-002']);
  // `[SPK:REQ-082]`: the prior convergence record survives the rework.
  await readFile(path.join(root, `singularity/work-items/${WORK}/context/convergence/iteration-1.json`), 'utf8');

  // ---- implementation, generation two ------------------------------------------------------------
  sflow(root, ['prepare', 'implementation']);
  await write(root, 'src/payments/attempts.ts', 'export const attempts = [];\nexport function append(attempt) { return [...attempts, attempt]; }\n');
  await write(root, `singularity/work-items/${WORK}/artifacts/implementation/implementation-summary.md`, [
    '# Implementation summary', '',
    'Second generation. Attempts are now append-only, so the original failed attempt and its provider',
    'response are preserved alongside the new one.', '',
    '## Changes', '',
    '- `src/payments/retry.ts`: retry handler serving E2E:REQ-001.',
    '- `src/payments/attempts.ts`: append-only attempts serving E2E:REQ-002.', ''
  ].join('\n'));
  await completePhase(root, 'implementation');

  // ---- convergence, iteration two `[SPK:REQ-083]` ------------------------------------------------
  const second = JSON.parse(sflow(root, ['story', 'converge', '--json']).stdout);
  assert.equal(second.iteration, 2, 'the new implementation generation did not open a new iteration');
  assert.notEqual(second.bindings.reconciliation.sha256, iteration.bindings.reconciliation.sha256,
    'the second iteration bound the first iteration\'s reconciliation');

  assert.ok(second.facts.length, 'the second implementation generation produced no convergence facts');
  const intentFinding = second.facts[0];
  sflow(root, ['story', 'adjudicate', intentFinding.id, '--disposition', 'update-intent',
    '--clause', 'E2E:REQ-001', '--reason', 'The approved intent must limit retries to a payments operator.']);
  for (const fact of second.facts.filter((entry) => entry.id !== intentFinding.id)) {
    sflow(root, ['story', 'adjudicate', fact.id, '--disposition', 'accepted-deviation',
      '--reason', 'Trace evidence is recorded in the implementation summary and reviewed.']);
  }
  const intentBlocked = JSON.parse(sflow(root, ['story', 'converge', '--json']).stdout);
  assert.deepEqual(intentBlocked.allowedNext, ['propose-intent-amendment']);

  // ---- corrected intent: proposal, authority decision, acknowledgement and selective replay -----
  const amendmentFile = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-e2e-amendment-')), 'spec.md');
  await writeFile(amendmentFile, [
    '# Specification — Retry a failed payment', '',
    '## Actors', '', 'An operator holding the payments role.', '',
    '## User scenarios', '',
    '- **Given** a payment that failed at the provider',
    '  **When** an operator retries it',
    '  **Then** a new attempt is created and the original is preserved.', '',
    '## Requirements', '',
    '- Only an operator holding the payments role may create a new attempt for a failed payment. [E2E:REQ-001]',
    '- Every retry preserves the original failed attempt and its provider response without mutation. [E2E:REQ-002]', ''
  ].join('\n'));
  const proposed = JSON.parse(sflow(root, ['story', 'intent-amendment', 'propose',
    '--file', amendmentFile, '--reason', 'Make retry authority explicit.', '--json']).stdout);
  assert.equal(proposed.proposal.id, 'AMD-001');
  assert.deepEqual(proposed.proposal.diff.revised, ['E2E:REQ-001', 'E2E:REQ-002']);
  assert.equal((await workflowOf(root)).phases.specification.generation, 1,
    'a proposal changed approved intent before authority approval');

  const decided = JSON.parse(sflow(root, ['story', 'intent-amendment', 'decide', 'AMD-001',
    '--decision', 'approve', '--confirm', 'AMD-001', '--json']).stdout);
  assert.equal(decided.transition.applied, true);
  const amended = await workflowOf(root);
  assert.equal(amended.phases.specification.generation, 2);
  const amendedBriefs = amended.phases.specification.agentBriefs
    .filter((entry) => entry.generation === 2);
  assert.equal(amendedBriefs.length, 4, 'the amended approved generation did not recreate downstream briefs');
  assert.ok(amendedBriefs.every((entry) => entry.status === 'fallback-whole'),
    'a summary-free amended specification did not retain the configured whole-artifact fallback');
  const amendmentApproval = amended.phases.specification.approvals
    .find((entry) => entry.intentAmendmentId === 'AMD-001' && !entry.invalidatedAt);
  assert.equal(amendmentApproval.agentBriefs.length, 4,
    'the amendment authority decision did not bind its deterministic projections');
  assert.ok(amendmentApproval.agentBriefs.every((entry) =>
    amendedBriefs.some((brief) => brief.integritySha256 === entry.integritySha256)));
  assert.ok(amendmentApproval.agentBriefSource?.sha256,
    'the amendment authority decision did not bind the managed source used by its projections');
  assert.equal(amended.currentPhase, 'planning');
  assert.equal(amended.intentAmendments[0].status, 'approved');
  assert.ok(amended.intentAmendments[0].preservedEvidence.some((entry) => entry.endsWith('/operator-notes.md')),
    'unaffected operator evidence was discarded instead of preserved');
  assert.equal(amended.phases.implementation.artifacts
    .find((entry) => entry.path.endsWith('/operator-notes.md')).intentAmendment.state, 'preserved-unaffected');
  assert.ok(amended.phases.implementation.approvals.every((entry) => entry.invalidatedAt),
    'downstream approvals survived an approved intent change');

  const unacknowledged = sflow(root, ['submit', 'planning', '--skip-checks'], { allowFailure: true });
  assert.notEqual(unacknowledged.status, 0, 'downstream submission ignored the acknowledgement beat');
  assert.match(unacknowledged.output, /INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED|Acknowledge it before revalidation/);
  sflow(root, ['story', 'intent-amendment', 'acknowledge', 'AMD-001']);
  assert.ok((await workflowOf(root)).intentAmendments[0].acknowledgedAt);

  // Re-publish existing evidence through ordinary generation and approval gates. Unaffected bytes
  // stay in place; their preservation label is evidence, not an automatic re-approval.
  sflow(root, ['spec', 'tasks']);
  await completePhase(root, 'planning');
  sflow(root, ['prepare', 'implementation']);
  await completePhase(root, 'implementation');

  const third = JSON.parse(sflow(root, ['story', 'converge', '--json']).stdout);
  assert.equal(third.iteration, 3, 'intent revalidation did not create a fresh convergence iteration');
  for (const fact of third.facts) {
    sflow(root, ['story', 'adjudicate', fact.id, '--disposition', 'accepted-deviation',
      '--reason', 'The amended intent and retained implementation evidence were revalidated.']);
  }
  const resolved = JSON.parse(sflow(root, ['story', 'converge', '--json']).stdout);
  assert.deepEqual(resolved.unresolvedBlockers, []);
  assert.deepEqual(resolved.allowedNext, ['advance-to-verification']);

  // ---- advancement, verification and release -----------------------------------------------------
  await write(root, `singularity/work-items/${WORK}/artifacts/convergence/convergence.md`, [
    '# Convergence — iteration 2', '',
    'Every deterministic fact carries a recorded human disposition. Two iterations were needed: the',
    'first returned the Story to implementation because E2E:REQ-002 had no observed claim, and the',
    'second found the append-only attempts change recorded against it.', '',
    '## Dispositions', '',
    'All remaining facts were accepted as deviations, each with a reason on the record. No blocking',
    'finding remains, so advancement to verification is a decision a human can now take.', ''
  ].join('\n'));
  sflow(root, ['artifact', 'scan', '--phase', 'convergence']);
  // Convergence pins `producer: deterministic` — the artifact is derived from the projection, not
  // authored — so publishing it as human authorship is correctly refused.
  sflow(root, ['phase', 'publish', 'convergence', '--authored', 'deterministic', '--channel', 'kernel-generator']);
  settle(root, `[${WORK}][phase:convergence] settle`);
  sflow(root, ['story', 'advance', '--confirm']);
  assert.equal((await workflowOf(root)).phases.convergence.status, 'awaiting_approval');
  sflow(root, ['approve', 'convergence', '--yes']);
  assert.equal((await workflowOf(root)).currentPhase, 'verification');

  await write(root, `singularity/work-items/${WORK}/artifacts/verification/test-evidence.md`, [
    '# Test evidence', '',
    'Both requirements are covered by executed checks against the second implementation generation.', '',
    '## Results', '',
    '- E2E:REQ-001 — retry creates a new attempt: passed.',
    '- E2E:REQ-002 — the original failed attempt is preserved: passed.', '',
    '## Environment', '', 'Local Node test runner against the Story branch head.', ''
  ].join('\n'));
  await completePhase(root, 'verification');
  assert.equal((await workflowOf(root)).currentPhase, 'release');

  // Release carries the conformance report `[SPK:AC-008]`.
  await write(root, `singularity/work-items/${WORK}/artifacts/release/conformance.md`, [
    '# Conformance — Retry a failed payment', '',
    'Approved intent traces to executed evidence for both requirements, through two convergence',
    'iterations and one governed rework.', '',
    '## Clause coverage', '',
    '- [E2E:REQ-001] — implemented in `src/payments/retry.ts`, verified.',
    '- [E2E:REQ-002] — implemented in `src/payments/attempts.ts`, verified.', '',
    '## Deviations', '', 'None outstanding.', ''
  ].join('\n'));
  await completePhase(root, 'release');

  const complete = await workflowOf(root);
  assert.equal(complete.status, 'complete', `the Story did not complete: ${complete.status} at ${complete.currentPhase}`);
  assert.equal(complete.currentPhase, null);
  for (const phase of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release']) {
    assert.equal(complete.phases[phase].status, 'approved', `${phase} is ${complete.phases[phase].status}`);
  }
  // Three implementation generations: one governed rework and one corrected-intent revalidation.
  assert.equal(complete.phases.implementation.generation, 3);
  assert.equal(complete.changeRequests.length, 1);
  assert.equal(complete.changeRequests[0].status, 'resolved', 'the change request was never resolved by the rework');
  assert.equal(complete.intentAmendments[0].status, 'revalidated');
  assert.deepEqual(complete.intentAmendments[0].revalidatedPhases,
    ['planning', 'implementation', 'convergence', 'verification', 'release']);
});
