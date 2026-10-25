/**
 * A Story whose planning was submitted and awaits approval, in a repository of its own: the
 * spec-driven-standard workflow with source review off, its specification approved and its plan
 * submitted. Used by the approval tests (test/approval-intervening-commits.test.mjs,
 * test/oap-m1-approval-check.test.mjs).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { childTimeout } from './child-timeout.mjs';

export const CLI = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'), 'bin/singularity-flow.mjs');

export function specification(WORK, value) {
  return [
    `# ${WORK} — Specification`, '',
    '## Agent brief', '', `The exported value must be ${value}, with a matching executable test.`, '',
    '## Actors', '', 'A user reads the value.', '',
    '## User scenarios', '', '### S1 — Read the value', '',
    '- **Given** a ready application', '  **When** a user reads the value', `  **Then** ${value} is displayed.`, '',
    '## Failure and empty states', '', 'A missing value is rejected without inventing data.', '',
    '## Permissions', '', 'A user may read the value without special privileges.', '',
    '## Boundary conditions', '', 'Only the approved integer value is exposed.', '',
    '## Requirements', '',
    `- The user sees the value ${value}. [${WORK}:AC-001]`,
    `- The application returns the value ${value}. [${WORK}:REQ-002]`, '',
    '## Scenario coverage', '',
    '| Clause | Scenario | Outcome |', '|---|---|---|',
    `| \`${WORK}:AC-001\` | S1 | success |`, `| \`${WORK}:REQ-002\` | S1 | success |`, '',
    '## Boundary and non-functional requirements', '', 'Do not expose private data; invalid input is rejected deterministically.', '',
    '## Non-functional requirements', '', 'A local read returns deterministically without a network call.', '',
    '## Assumptions', '', 'The value is available in the local application.', '',
    '## Planned implementation evidence', '',
    '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Evidence and assumptions', '', 'The pinned repository is the implementation source.', '',
    '## Out of scope', '', 'No unrelated application changes.'
  ].join('\n');
}

/** A started Story, its specification at generation 0, in a repository of its own. */
export async function startedSpecificationStory(t, WORK, { configure = null } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-approval-history-'));
  const root = path.join(directory, 'repository');
  const remote = path.join(directory, 'origin.git');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (command, args, { allowFailure = false, cwd = root } = {}) => {
    const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: childTimeout(60_000),
      env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester' } });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  run('git', ['init', '-q', '-b', 'main', root], { cwd: directory });
  const git = (...args) => run('git', args).stdout.trim();
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args]);
  git('config', 'user.name', 'History Tester');
  git('config', 'user.email', 'history@example.test');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  cli('init');
  const configurationPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configurationPath, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configuration.workTypes['spec-driven-standard'].sourceReview = { mode: 'off' };
  configure?.(configuration);
  await writeFile(configurationPath, YAML.stringify(configuration));
  git('add', '.');
  git('commit', '-qm', 'Initialize approval history fixture');
  run('git', ['init', '--bare', '-b', 'main', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');

  cli('start', WORK, '--from-branch', 'main', '--work-type', 'spec-driven-standard',
    '--title', 'Validate a value', '--description', 'Return an approved value.');
  const item = path.join(root, 'singularity/work-items', WORK);
  return { directory, root, run, git, cli, item };
}

/**
 * A Story whose specification was submitted and then approved by its submitter, in a repository of
 * its own. Used by test/int-material-events.test.mjs. `configure` may change the configuration
 * before it is committed (test/oap-m4-one-ceremony.test.mjs ends the work type at planning).
 */
export async function approvedSpecificationStory(t, WORK, options = {}) {
  const { directory, root, run, git, cli, item } = await startedSpecificationStory(t, WORK, options);
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(WORK, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  cli('approve', 'specification', '--yes');
  return { directory, root, run, git, cli, item };
}

/** A Story whose planning is published and not yet submitted, in a repository of its own. */
export async function publishedPlanningStory(t, WORK, options = {}) {
  const story = await approvedSpecificationStory(t, WORK, options);
  const { cli, item } = story;
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(WORK));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  return story;
}

export function implementationPlan(WORK) {
  return [
    `# ${WORK} — Implementation plan`, '',
    '## Agent brief', '', 'Return the approved value and prove both clauses with one focused test.', '',
    '## Approach', '', 'Export a constant from the value module and assert it in a unit test.', '',
    '## Affected surfaces', '', '| Surface | Change | Serves |', '|---|---|---|',
    `| \`src/value.mjs\` | exported value | ${WORK}:REQ-002 |`, '',
    '## Test strategy', '', '| Clause | Expected paths | Planned tests |', '|---|---|---|',
    `| \`${WORK}:AC-001\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`,
    `| \`${WORK}:REQ-002\` | \`src/value.mjs\` | \`test/value.test.mjs\` |`, '',
    '## Risks and rollback', '', 'Risk is a wrong constant; rollback restores the previous module.', ''
  ].join('\n');
}

/** A Story whose planning was submitted and awaits approval, in a repository of its own. */
export async function submittedPlanningStory(t, WORK, options = {}) {
  const { directory, git, cli, run, item } = await publishedPlanningStory(t, WORK, options);
  cli('submit', 'planning', '--skip-checks');
  const submitted = git('rev-parse', 'HEAD');
  const candidate = path.join(directory, 'amended-spec.md');
  return { run, git, cli, item, submitted, candidate };
}
