/**
 * `reject --member` names members of the phase that is reopened. `[SPK:REQ-111]`
 *
 * The promise is recorded on the rejection target, and the target's next publication is what keeps
 * it. Validating the members against the *source* phase's set accepted `plan.md` for a planning
 * rejection back to specification (a member the specification does not own, so the promise could
 * never be kept) and refused `spec.md` (the one member that phase does own).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE, 'bin/singularity-flow.mjs');
const WORK = 'MEMBER-1';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Member Tester' }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

test('reject --member is validated against, and recorded on, the target phase set', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reject-member-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const git = (...args) => run('git', args, root).stdout.trim();
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const tryCli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Member Tester');
  git('config', 'user.email', 'member@example.test');
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
  configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'off' };
  await writeFile(configurationPath, YAML.stringify(configuration));
  git('add', '.');
  git('commit', '-qm', 'Initialize member fixture');
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');

  cli('start', WORK, '--from-branch', 'main', '--work-type', 'spec-driven-standard',
    '--title', 'Validate a value', '--description', 'Return an approved value.');
  const item = path.join(root, 'singularity/work-items', WORK);
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), [
    `# ${WORK} — Specification`, '',
    '## Agent brief', '', 'The exported value must be 1, with a matching executable test.', '',
    '## Actors', '', 'A user reads the value.', '',
    '## User scenarios', '',
    '### S1 — Read the value', '',
    '- **Given** a ready application',
    '  **When** a user reads the value',
    '  **Then** 1 is displayed.', '',
    '## Failure and empty states', '', 'A missing value is rejected without inventing data.', '',
    '## Permissions', '', 'A user may read the value without special privileges.', '',
    '## Boundary conditions', '', 'Only the approved integer value is exposed.', '',
    '## Requirements', '',
    `- The application returns the value 1. [${WORK}:REQ-001]`,
    `- The user sees the value 1. [${WORK}:AC-001]`, '',
    '## Scenario coverage', '',
    '| Clause | Scenario | Outcome |', '|---|---|---|',
    `| \`${WORK}:REQ-001\` | S1 | success |`, `| \`${WORK}:AC-001\` | S1 | success |`, '',
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
  ].join('\n'));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  cli('approve', 'specification', '--yes');

  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), [
    `# ${WORK} — Implementation plan`, '',
    '## Agent brief', '', 'Return the approved value and prove both governed clauses with one focused test.', '',
    '## Approach', '', 'Export a constant from the value module and assert it in a unit test.', '',
    '## Affected surfaces', '',
    '| Surface | Change | Serves |', '|---|---|---|',
    `| \`src/value.mjs\` | exported value | ${WORK}:REQ-001 |`, '',
    '## Test strategy', '',
    '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:REQ-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Risks and rollback', '', 'Risk is a wrong constant; rollback restores the previous module.', ''
  ].join('\n'));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks');
  const workflow = async () => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  const head = git('rev-parse', 'HEAD');

  // A member of the source (planning) set that the reopened specification does not own.
  const refused = tryCli('reject', 'planning', '--to', 'specification', '--member', 'plan.md',
    '--reason', 'The specification wording is ambiguous.', '--json');
  assert.notEqual(refused.status, 0, 'a member the target phase does not own was accepted');
  assert.match(refused.stdout + refused.stderr, /REJECT_MEMBER_UNKNOWN/);
  assert.match(refused.stdout + refused.stderr, /spec-driven-specification/);
  assert.equal(git('rev-parse', 'HEAD'), head, 'the refusal committed state');
  assert.equal((await workflow()).phases.planning.status, 'awaiting_approval');

  // The member the reopened phase owns, by member name and by repository path.
  cli('reject', 'planning', '--to', 'specification', '--member', 'spec.md',
    '--member', `singularity/work-items/${WORK}/artifacts/specification/checklists/requirements.md`,
    '--reason', 'The specification wording is ambiguous.');
  const returned = await workflow();
  assert.equal(returned.currentPhase, 'specification');
  assert.deepEqual(returned.phases.specification.surgicalReopen.members, [
    'spec.md', `singularity/work-items/${WORK}/artifacts/specification/checklists/requirements.md`
  ]);
  assert.deepEqual(returned.changeRequests.at(-1).members, returned.phases.specification.surgicalReopen.members);
});
