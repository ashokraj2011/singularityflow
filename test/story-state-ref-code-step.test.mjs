// SSB M3 (e) [SSB:REQ-004, REQ-005, REQ-009, A2]: a state-ref Story's code step, walked on the real CLI on real clones
// with a bare remote. The code lands on the Story branch and nowhere else; every record of its test runs, its delivery
// evidence, its submission and its approval lands on the state ref, published with the branch in one push.
// docs/plans/SSB-M3-PLAN.md §5, stage (e).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { startedSpecificationStory, specification, implementationPlan, CLI } from './helpers/submitted-planning-story.mjs';
import { STORY_STATE_REF_PREVIEW } from '../src/work-item-location.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';

const REF = (work) => `refs/singularity/state/${work}`;

function preview(t) {
  const was = process.env[STORY_STATE_REF_PREVIEW];
  process.env[STORY_STATE_REF_PREVIEW] = '1';
  t.after(() => { if (was === undefined) delete process.env[STORY_STATE_REF_PREVIEW]; else process.env[STORY_STATE_REF_PREVIEW] = was; });
}

/** The CLI with the full stack on a failure, so a site that still refuses names itself. */
function cliIn(root, args, { allowFailure = false } = {}) {
  const result = spawnSync(process.execPath, [CLI, '--no-model', ...args], { cwd: root, encoding: 'utf8', timeout: childTimeout(240_000),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'History Tester', SINGULARITY_FLOW_DEBUG: '1' } });
  if (!allowFailure) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

const readState = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
const status = async (item, phase) => (await readState(item)).phases?.[phase]?.status;

async function approve(cli, item, phase) {
  if (await status(item, phase) === 'awaiting_approval') cli('approve', phase, '--yes');
  assert.equal(await status(item, phase), 'approved', `${phase} is approved`);
}

test('a state-ref Story\'s code step: its code on the branch, its test runs, evidence and approval on the state ref', async (t) => {
  preview(t);
  const work = 'SSB-C1';
  const story = await startedSpecificationStory(t, work, {
    description: 'Return an approved value. The value must not be shown to guests.',
    configure: (configuration) => {
      configuration.story = { storage: 'state-ref' };
      configuration.git = { ...(configuration.git ?? {}), publish: 'required' };
    }
  });
  const { root, git, run } = story;
  const item = path.join(root, '.sflow-state');
  const remoteGit = (...args) => run('git', ['--git-dir', story.remote, ...args]).stdout.trim();
  const cli = (...args) => cliIn(root, args);
  const base = git('rev-parse', 'HEAD');

  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(work, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  const scope = JSON.parse(cli('evidence', 'scope', '--json').stdout).data.scope;
  for (const entry of (scope?.items ?? []).filter((candidate) => candidate.disposition === 'unresolved')) {
    cli('decision', 'scope', '--item', entry.id, '--as', 'excluded', '--reason', 'Out of scope for this Story.');
  }
  await approve(cli, item, 'specification');
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(work));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks');
  await approve(cli, item, 'planning');
  assert.equal(git('rev-parse', 'HEAD'), base, 'the document steps put nothing on the branch');

  // The code step: code and its test in the code checkout, the summary in the step's documents.
  cli('prepare', 'implementation');
  const write = async (relative, text) => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), text);
  };
  await write('src/value.mjs', `// @clause:${work}:AC-001 returns the approved value to its callers\n// @clause:${work}:REQ-002 the application returns that same approved value\nexport const value = 1;\n`);
  await write('test/value.test.mjs', ["import test from 'node:test';", "import assert from 'node:assert/strict';", "import { value } from '../src/value.mjs';",
    `// @ac:${work}:AC-001`, `// @ac:${work}:REQ-002`, "test('reads the value', () => assert.equal(value, 1));", ''].join('\n'));
  await writeFile(path.join(item, 'artifacts/implementation/implementation-summary.md'), ['# Implementation summary', '', '## Agent brief', '',
    'Added the value module; both clauses are bound to it in source.', '',
    '## Approach', '', 'Export a constant from the value module and assert it in a unit test.', '',
    '## Changed components and decisions', '', '- `src/value.mjs` exports the approved value; nothing else needed changing.', '',
    '## Tests and operational notes', '', '`test/value.test.mjs` asserts the value; nothing changes for an operator.', ''].join('\n'));
  cli('artifact', 'scan', '--phase', 'implementation');
  cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
  const published = git('rev-parse', 'HEAD');
  assert.notEqual(published, base, 'the code is a commit on the Story branch');
  assert.deepEqual(git('diff', '--name-only', base, published).split('\n').sort(), ['src/value.mjs', 'test/value.test.mjs'],
    'the branch carries the code and its test, no SFlow record');
  assert.equal(remoteGit('rev-parse', `refs/heads/${work}`), published, 'the branch was published');
  assert.equal(remoteGit('rev-parse', REF(work)), git('rev-parse', REF(work)), 'and the state ref with it');
  assert.match(git('log', '-1', '--format=%B', REF(work)), new RegExp(`Story-Code-Commit: ${published}`, 'u'));

  cli('submit', 'implementation');
  await approve(cli, item, 'implementation');
  assert.equal(git('rev-parse', 'HEAD'), published, 'submission and approval put nothing on the branch');
  assert.equal(remoteGit('rev-parse', `refs/heads/${work}`), published);
  assert.equal(remoteGit('rev-parse', REF(work)), git('rev-parse', REF(work)));
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(git('-C', item, 'status', '--porcelain', '--untracked-files=all'), '');
  const records = git('ls-tree', '-r', '--name-only', REF(work)).split('\n');
  for (const expected of ['context/code-delivery/implementation-gen1.json', 'context/code-delivery/implementation-gen1-changes.json']) {
    assert.ok(records.includes(expected), `${expected} is a record on the state ref`);
  }
  assert.ok(records.some((file) => file.startsWith('context/code-delivery/tests/attempts/implementation/')), 'and the test runs');
  assert.ok(records.some((file) => file.startsWith('context/code-delivery/tests/raw/')), 'with their reports');
  assert.ok(!git('ls-tree', '-r', '--name-only', published).split('\n').some((file) => file.startsWith('singularity/work-items/')));

  // The Story goes on to its spec-versus-code check: a code step and its approval leave nothing on the branch but the code.
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
  assert.equal((await readState(item)).currentPhase, 'convergence');
});
