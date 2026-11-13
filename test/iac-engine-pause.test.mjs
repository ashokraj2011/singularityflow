/**
 * The engine side of the pause [owner, 2026-11-13]: while an intent amendment proposed from a step waits,
 * begin, prepare, publish and submit of that step are refused on every host, with the decisions card and the
 * reject route; deciding it (reject or approve) is never refused, and the step goes on afterwards.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { slowLane } from './helpers/slow-lane.mjs';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PACKAGE, 'bin/singularity-flow.mjs');
const WORK = 'IAC-PAUSE-1';

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Pause Tester' } });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

const spec = (value) => [
  `# ${WORK} — Specification`, '',
  '## Agent brief', '', `The exported value must be ${value}, with a matching executable test.`, '',
  '## Actors', '', 'A user reads the value.', '',
  '## User scenarios', '', '### S1 — Read the value', '',
  `Given a ready application, when a user reads the value, then ${value} is displayed.`, '',
  '## Failure and empty states', '', 'A missing value is rejected without inventing data.', '',
  '## Permissions', '', 'A user may read the value without special privileges.', '',
  '## Boundary conditions', '', 'Only the approved integer value is exposed.', '',
  '## Requirements', '',
  `- The application returns the value ${value}. [${WORK}:REQ-001]`,
  `- The user sees the value ${value}. [${WORK}:AC-001]`, '',
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
].join('\n');

test('a step whose amendment waits refuses prepare, publish and submit until it is decided, and its decision is never refused', slowLane({ timeout: 600_000 }), async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-iac-pause-'));
  const remote = `${root}.git`;
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(remote, { recursive: true, force: true }); });
  const git = (...args) => run('git', args, root).stdout.trim();
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const refused = (...args) => {
    const result = run(process.execPath, [CLI, '--no-model', ...args], root, { allowFailure: true });
    assert.notEqual(result.status, 0, args.join(' '));
    return `${result.stdout}\n${result.stderr}`;
  };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Pause Tester'); git('config', 'user.email', 'pause@example.test');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  cli('init');
  const configurationPath = path.join(root, 'singularity/workflow.yml');
  const configuration = YAML.parse(await readFile(configurationPath, 'utf8'));
  configuration.worldModel.grounding = 'off';
  configuration.approvalSecurity = { profile: 'poc' };
  configuration.repositoryReadiness = { ...(configuration.repositoryReadiness ?? {}), requiredBeforeStory: false };
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  configuration.workTypes['spec-code-test-loop'].sourceReview = { mode: 'off' };
  await writeFile(configurationPath, YAML.stringify(configuration));
  git('add', '.'); git('commit', '-qm', 'Initialize the pause fixture');
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  git('remote', 'add', 'origin', remote); git('push', '-q', '-u', 'origin', 'main');

  cli('start', WORK, '--from-branch', 'main', '--work-type', 'spec-code-test-loop', '--target-url', 'https://staging.example.test',
    '--title', 'Validate a value', '--description', 'Return an approved value with browser-visible proof.');
  const item = path.join(root, 'singularity/work-items', WORK);
  await writeFile(path.join(item, 'artifacts/specification/spec.md'), spec(1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  cli('approve', 'specification', '--yes');

  const candidates = await mkdtemp(path.join(os.tmpdir(), 'sflow-iac-candidate-'));
  t.after(() => rm(candidates, { recursive: true, force: true }));
  const propose = async (value) => {
    const file = path.join(candidates, `amended-${value}.md`);
    await writeFile(file, spec(value));
    return JSON.parse(cli('story', 'intent-amendment', 'propose', '--file', file, '--reason', `The value is ${value} now.`,
      '--authored', 'governed-agent', '--channel', 'copilot-host', '--json').stdout).proposal;
  };
  const paused = (id) => {
    // (`phase begin` of the generation the Story already opened only reads it back; opening one is refused like prepare.)
    for (const args of [['submit', 'implementation'], ['prepare', 'implementation'],
      ['phase', 'publish', 'implementation', '--authored', 'governed-agent', '--channel', 'copilot-host']]) {
      assert.match(refused(...args, '--json'), /"code": "INTENT_AMENDMENT_PENDING_PAUSE"/u, args.join(' '));
      const output = refused(...args);
      assert.match(output, new RegExp(`${id} waits for the requirements approvers; this step pauses until it is decided`, 'u'), args.join(' '));
      assert.match(output, new RegExp(`singularity-flow decisions ${WORK}|/sf-decide ${WORK}`, 'u'), args.join(' '));
    }
    // Reading it stays open.
    assert.match(cli('story', 'intent-amendment', 'status', '--work-id', WORK, '--json').stdout, new RegExp(id, 'u'));
  };

  // Rejected: the step goes on as it was.
  const first = await propose(2);
  assert.equal(first.source.phaseId, 'implementation');
  paused(first.id);
  const rejected = JSON.parse(cli('story', 'intent-amendment', 'decide', first.id, '--decision', 'reject', '--confirm', first.id, '--json').stdout);
  assert.equal(rejected.transition.proposal.status, 'rejected');
  assert.match(cli('prepare', 'implementation').stdout, /implementation is ready to author/u);

  // Approved: deciding it is never paused; the step reopens and waits for a person's acknowledgement, then goes on.
  const second = await propose(3);
  paused(second.id);
  const approved = JSON.parse(cli('story', 'intent-amendment', 'decide', second.id, '--decision', 'approve', '--confirm', second.id, '--json').stdout);
  assert.equal(approved.transition.applied, true);
  const workflow = JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
  assert.deepEqual([workflow.phases.implementation.intentAmendmentRevalidation.id, workflow.phases.implementation.intentAmendmentRevalidation.revised],
    [second.id, [`${WORK}:AC-001`, `${WORK}:REQ-001`]]);
  assert.match(refused('prepare', 'implementation', '--json'), /"code": "INTENT_AMENDMENT_ACKNOWLEDGEMENT_REQUIRED"/u);
  const unacknowledged = refused('prepare', 'implementation');
  assert.match(unacknowledged, /A person acknowledges it before downstream revalidation, on the decisions card \(\/sf-decide IAC-PAUSE-1\)/u);
  assert.doesNotMatch(unacknowledged, /sf-recover|singularity-flow recover /u, 'nothing is repaired or recovered');
  cli('story', 'intent-amendment', 'acknowledge', second.id);
  assert.match(cli('prepare', 'implementation').stdout, /implementation is ready to author/u);
});
