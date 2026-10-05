import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE, 'bin/singularity-flow.mjs');
const WORK = 'LOOP-CLI-1';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Loop Tester' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

for (const workType of ['spec-code-test-loop', 'custom-no-convergence', 'spec-driven-standard']) {
test(`${workType}: an amendment needs no convergence finding and authority decides the new generation`, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-loop-cli-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const git = (...args) => run('git', args, root).stdout.trim();
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Loop Tester');
  git('config', 'user.email', 'loop@example.test');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    type: 'module', private: true, scripts: { test: 'node --test' }
  }));
  cli('init');
  const configurationPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configurationPath, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  if (workType === 'custom-no-convergence') {
    configuration.workTypes[workType] = structuredClone(configuration.workTypes['spec-code-test-loop']);
    delete configuration.workTypes[workType].reworkLoops;
  }
  // This fixture tests amendment authority rather than the independent source-review service.
  if (workType === 'spec-driven-standard') configuration.workTypes[workType].sourceReview = { mode: 'off' };
  await writeFile(configurationPath, YAML.stringify(configuration));
  git('add', '.');
  git('commit', '-qm', 'Initialize governed loop fixture');
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');

  cli('start', WORK, '--from-branch', 'main', '--work-type', workType,
    '--title', 'Validate a value', '--description', 'Return an approved value with browser-visible proof.');
  const item = path.join(root, 'singularity/work-items', WORK);
  const specPath = path.join(item, 'artifacts/specification/spec.md');
  const spec = (value) => [
    `# ${WORK} — Specification`, '',
    '## Agent brief', '', `The exported value must be ${value}, with a matching executable test.`, '',
    '## Actors', '', 'A user reads the value.', '',
    '## User scenarios', '', `Given a ready application, when a user reads the value, then ${value} is displayed.`, '',
    '## Failure and empty states', '', 'A missing value is rejected without inventing data.', '',
    '## Permissions', '', 'A user may read the value without special privileges.', '',
    '## Boundary conditions', '', 'Only the approved integer value is exposed.', '',
    '## Requirements', '',
    `- The application returns the value ${value}. [${WORK}:REQ-001]`,
    `- The user sees the value ${value}. [${WORK}:AC-001]`, '',
    '## Boundary and non-functional requirements', '',
    'Do not expose private data; invalid input is rejected deterministically.', '',
    '## Non-functional requirements', '', 'A local read returns deterministically without a network call.', '',
    '## Assumptions', '', 'The value is available in the local application.', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Evidence and assumptions', '', 'The pinned repository is the implementation source.', '',
    '## Out of scope', '', 'No unrelated application changes.'
  ].join('\n');
  await writeFile(specPath, spec(1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  cli('approve', 'specification', '--yes');
  const sourcePhase = workType === 'spec-driven-standard' ? 'planning' : 'implementation';

  const candidateDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-loop-candidate-'));
  t.after(() => rm(candidateDirectory, { recursive: true, force: true }));
  const amendedPath = path.join(candidateDirectory, 'amended-spec.md');
  await writeFile(amendedPath, spec(2));
  const before = await readFile(specPath, 'utf8');

  // An amended specification that no longer plans a clause is refused when it is proposed, not when
  // an authority approves it, and nothing is recorded.
  const unplannedPath = path.join(candidateDirectory, 'unplanned-spec.md');
  const plannedRow = `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |\n`;
  assert.ok(spec(2).includes(plannedRow));
  await writeFile(unplannedPath, spec(2).replace(plannedRow, ''));
  if (workType !== 'spec-driven-standard') {
    const refused = run(process.execPath, [CLI, '--no-model', 'story', 'intent-amendment', 'propose',
      '--file', unplannedPath, '--reason', 'Review showed that value 2 is required.',
      '--source-phase', sourcePhase, '--clause', `${WORK}:REQ-001`, '--clause', `${WORK}:AC-001`, '--json'], root, { allowFailure: true });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /SPEC_PLANNED_TEST_BINDING_REQUIRED/);
    assert.match(refused.stdout + refused.stderr, /amended specification cannot be proposed/);
  }
  assert.equal(JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8')).intentAmendments, undefined,
    'a refused proposal records nothing');
  const proposed = JSON.parse(cli('story', 'intent-amendment', 'propose',
    '--file', amendedPath, '--reason', 'Review showed that value 2 is required.',
    '--json').stdout);
  assert.equal(proposed.proposal.source.phaseId, sourcePhase);
  assert.deepEqual(proposed.proposal.requiredClauses, [`${WORK}:AC-001`, `${WORK}:REQ-001`]);
  assert.equal(proposed.proposal.convergence, undefined, 'no convergence findings were invented');
  assert.equal(proposed.proposal.source.artifactPresent, false);
  assert.equal(await readFile(specPath, 'utf8'), before,
    'proposal silently replaced the approved specification');
  const workflowPath = path.join(item, 'workflow.json');
  const approvedScope = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(approvedScope.phases.specification.generation, 1);
  assert.deepEqual(approvedScope.scopeRevisions.map((entry) => [entry.revision, entry.origin.kind, entry.changes]), [[1, 'approval', null]],
    'approving the specification records the first scope revision');
  const proposedBytes = await readFile(path.join(root, proposed.proposal.specification.proposedPath));
  assert.equal(proposedBytes.toString('utf8'), spec(2), 'proposal file content changed after publication');
  assert.equal(createHash('sha256').update(proposedBytes).digest('hex'),
    proposed.proposal.specification.proposedSha256, 'proposal file changed after publication');

  const decision = JSON.parse(cli('story', 'intent-amendment', 'decide', 'AMD-001',
    '--decision', 'approve', '--confirm', 'AMD-001', '--json').stdout);
  assert.equal(decision.transition.applied, true);
  const amended = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(amended.phases.specification.generation, 2);
  assert.equal(amended.currentPhase, sourcePhase);
  assert.ok(amended.phases[sourcePhase].intentAmendmentRevalidation);
  assert.match(await readFile(specPath, 'utf8'), /value 2/);

  // The amendment is a new scope revision [E2G-008], chained to the first, and it names exactly the
  // clauses whose evidence is now stale.
  const [first, second] = amended.scopeRevisions;
  assert.equal(second.revision, 2);
  assert.deepEqual(second.origin, { kind: 'intent-amendment', id: 'AMD-001', phase: 'specification', generation: 2 });
  assert.deepEqual(second.changes, { added: [], revised: [`${WORK}:AC-001`, `${WORK}:REQ-001`], removed: [] });
  assert.equal(second.previousRevisionSha256, first.revisionSha256);
  const summary = amended.intentAmendments.at(-1);
  assert.deepEqual([summary.scopeRevision.revision, summary.staleClauses, summary.standingClauses],
    [2, [`${WORK}:AC-001`, `${WORK}:REQ-001`], []]);
  // The amended generation plans its clauses as a published one does, so the code step can start.
  if (workType !== 'spec-driven-standard') assert.equal(amended.phases.specification.claimMaps.planned.generation, 2);
  cli('story', 'intent-amendment', 'acknowledge', 'AMD-001');
  assert.match(cli('prepare', sourcePhase).stdout, new RegExp(`${sourcePhase} is ready to author`));
  const matrix = cli('evidence', 'matrix').stdout;
  assert.match(matrix, /Scope revision: scope revision 2: 0 added, 2 revised, 0 removed; 0 row\(s\) stale, 2 unaffected/,
    'nothing was built on the first scope yet, so nothing is stale');

  // A moved source must not leave an un-rejectable proposal blocking all future amendments.
  await writeFile(amendedPath, spec(3));
  const pending = JSON.parse(cli('story', 'intent-amendment', 'propose', '--file', amendedPath,
    '--reason', 'The human requested value 3.', '--json').stdout).proposal;
  const duplicate = run(process.execPath, [CLI, '--no-model', 'story', 'intent-amendment', 'propose',
    '--file', amendedPath, '--reason', 'Do not overwrite a pending review.', '--json'], root, { allowFailure: true });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stdout + duplicate.stderr, /INTENT_AMENDMENT_ALREADY_PENDING/);
  assert.match(duplicate.stdout + duplicate.stderr, /intent-amendment decide AMD-002/);
  await writeFile(path.join(root, 'source-moved.mjs'), 'export const moved = true;\n');
  git('add', 'source-moved.mjs');
  git('commit', '-qm', 'Source changes after proposal');
  const refusedDecision = run(process.execPath, [CLI, '--no-model', 'story', 'intent-amendment', 'decide',
    pending.id, '--decision', 'approve', '--confirm', pending.id, '--json'], root, { allowFailure: true });
  assert.notEqual(refusedDecision.status, 0);
  assert.match(refusedDecision.stdout + refusedDecision.stderr, /INTENT_AMENDMENT_SOURCE_STALE/);
  assert.match(refusedDecision.stdout + refusedDecision.stderr, /--decision reject/);
  const scopeBeforeReject = await readFile(specPath, 'utf8');
  const rejected = JSON.parse(cli('story', 'intent-amendment', 'decide', pending.id,
    '--decision', 'reject', '--confirm', pending.id, '--json').stdout);
  assert.equal(rejected.transition.applied, false);
  assert.equal(rejected.transition.proposal.status, 'rejected');
  assert.equal(await readFile(specPath, 'utf8'), scopeBeforeReject);
  assert.equal(JSON.parse(await readFile(workflowPath, 'utf8')).phases.specification.generation, 2);
  const retry = JSON.parse(cli('story', 'intent-amendment', 'propose', '--file', amendedPath,
    '--reason', 'Review value 3 against the current source.', '--json').stdout);
  assert.equal(retry.proposal.id, 'AMD-003');
});
}
