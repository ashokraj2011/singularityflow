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

test('Code feedback proposes an immutable spec correction and authority decides the new generation', async (t) => {
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
  for (const authority of Object.values(configuration.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configurationPath, YAML.stringify(configuration));
  git('add', '.');
  git('commit', '-qm', 'Initialize governed loop fixture');
  run('git', ['init', '--bare', '-b', 'main', remote], root);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', '-u', 'origin', 'main');

  cli('start', WORK, '--from-branch', 'main', '--work-type', 'spec-code-test-loop',
    '--title', 'Validate a value', '--description', 'Return an approved value with browser-visible proof.');
  const item = path.join(root, 'singularity/work-items', WORK);
  const specPath = path.join(item, 'artifacts/specification/spec.md');
  const spec = (value) => [
    `# ${WORK} — Specification`, '',
    '## Agent brief', '', `The exported value must be ${value}, with a matching executable test.`, '',
    '## Actors', '', 'A user reads the value.', '',
    '## User scenarios', '', `Given a ready application, when a user reads the value, then ${value} is displayed.`, '',
    '## Requirements', '',
    `- The application returns the value ${value}. [${WORK}:REQ-001]`,
    `- The user sees the value ${value}. [${WORK}:AC-001]`, '',
    '## Boundary and non-functional requirements', '',
    'Do not expose private data; invalid input is rejected deterministically.', '',
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
  cli('approve', 'specification', '--yes',
    '--article', 'completeness=satisfied', '--article', 'ambiguity=satisfied',
    '--article', 'consistency=satisfied', '--article', 'verifiability=satisfied',
    '--article', 'boundary-conditions=satisfied', '--article', 'non-functional=satisfied');

  const candidateDirectory = await mkdtemp(path.join(os.tmpdir(), 'sflow-loop-candidate-'));
  t.after(() => rm(candidateDirectory, { recursive: true, force: true }));
  const amendedPath = path.join(candidateDirectory, 'amended-spec.md');
  await writeFile(amendedPath, spec(2));
  const before = await readFile(specPath, 'utf8');
  const proposed = JSON.parse(cli('story', 'intent-amendment', 'propose',
    '--file', amendedPath, '--reason', 'Review showed that value 2 is required.',
    '--source-phase', 'implementation', '--clause', `${WORK}:REQ-001`,
    '--clause', `${WORK}:AC-001`, '--json').stdout);
  assert.equal(proposed.proposal.source.phaseId, 'implementation');
  assert.equal(proposed.proposal.source.artifactPresent, false);
  assert.equal(await readFile(specPath, 'utf8'), before,
    'proposal silently replaced the approved specification');
  const workflowPath = path.join(item, 'workflow.json');
  assert.equal(JSON.parse(await readFile(workflowPath, 'utf8')).phases.specification.generation, 1);
  const proposedBytes = await readFile(path.join(root, proposed.proposal.specification.proposedPath));
  assert.equal(proposedBytes.toString('utf8'), spec(2), 'proposal file content changed after publication');
  assert.equal(createHash('sha256').update(proposedBytes).digest('hex'),
    proposed.proposal.specification.proposedSha256, 'proposal file changed after publication');

  const decision = JSON.parse(cli('story', 'intent-amendment', 'decide', 'AMD-001',
    '--decision', 'approve', '--confirm', 'AMD-001', '--json').stdout);
  assert.equal(decision.transition.applied, true);
  const amended = JSON.parse(await readFile(workflowPath, 'utf8'));
  assert.equal(amended.phases.specification.generation, 2);
  assert.equal(amended.currentPhase, 'implementation');
  assert.ok(amended.phases.implementation.intentAmendmentRevalidation);
  assert.match(await readFile(specPath, 'utf8'), /value 2/);
});
