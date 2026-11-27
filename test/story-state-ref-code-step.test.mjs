// SSB M3 (e, f) [SSB:REQ-004, REQ-005, REQ-009, A2]: a state-ref Story walked on the real CLI, on real clones with a bare
// remote, from its start to its release. The code lands on the Story branch and nowhere else; every record of its steps
// (test runs, delivery evidence, the change-story page, convergence, verification, the release and every approval) lands
// on the state ref, published with the branch in one push. The same walk in today's layout ends the same way.
// docs/plans/SSB-M3-PLAN.md §5, stages (e) and (f).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { startedSpecificationStory, specification, implementationPlan, CLI } from './helpers/submitted-planning-story.mjs';
import { STORY_STATE_REF_PREVIEW } from '../src/work-item-location.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

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

const json = (result) => JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
const readState = async (item) => JSON.parse(await readFile(path.join(item, 'workflow.json'), 'utf8'));
const status = async (item, phase) => (await readState(item)).phases?.[phase]?.status;
const rowOf = (id) => new RegExp(`^\\| \`${id}\` \\|`, 'mu');
const listedAs = (id, decision) => new RegExp(`^- \`${id}\`, ${decision}: `, 'mu');

async function approve(cli, item, phase) {
  if (await status(item, phase) === 'awaiting_approval') cli('approve', phase, '--yes');
  assert.equal(await status(item, phase), 'approved', `${phase} is approved`);
}

/**
 * One Story, specification to release: a requirement the person leaves out of scope ("not shown to guests"), a plan,
 * the code and its test, convergence, verification and the release. `atCode` reads the Story once its code step is
 * published, `atEnd` once it is closed.
 */
async function walkToRelease(t, work, { stateRef, atCode, atEnd }) {
  const story = await startedSpecificationStory(t, work, {
    description: 'Return an approved value. The value must not be shown to guests.',
    configure: (configuration) => {
      if (stateRef) configuration.story = { storage: 'state-ref' };
      configuration.git = { ...(configuration.git ?? {}), publish: 'required' };
    }
  });
  const { root, git, run } = story;
  const item = stateRef ? path.join(root, '.sflow-state') : story.item;
  const remoteGit = (...args) => run('git', ['--git-dir', story.remote, ...args]).stdout.trim();
  const cli = (...args) => cliIn(root, args);
  const base = git('rev-parse', 'HEAD');
  const clauses = [`${work}:AC-001`, `${work}:REQ-002`];

  await writeFile(path.join(item, 'artifacts/specification/spec.md'), specification(work, 1));
  cli('artifact', 'scan', '--phase', 'specification');
  cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'specification', '--skip-checks');
  const scope = JSON.parse(cli('evidence', 'scope', '--json').stdout).data.scope;
  const excluded = (scope?.items ?? []).filter((candidate) => candidate.disposition === 'unresolved');
  assert.ok(excluded.length, 'the walk has a statement to leave out of scope');
  for (const entry of excluded) cli('decision', 'scope', '--item', entry.id, '--as', 'excluded', '--reason', 'Out of scope for this Story.');
  await approve(cli, item, 'specification');
  cli('prepare', 'planning');
  await writeFile(path.join(item, 'artifacts/planning/plan.md'), implementationPlan(work));
  cli('artifact', 'scan', '--phase', 'planning');
  cli('phase', 'publish', 'planning', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'planning', '--skip-checks');
  await approve(cli, item, 'planning');

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
  await atCode?.({ ...story, item, cli, base, remoteGit });
  cli('submit', 'implementation');
  await approve(cli, item, 'implementation');

  // Convergence: SFlow's own check, approved by SFlow when it finds nothing to decide.
  cli('prepare', 'convergence');
  cli('phase', 'publish', 'convergence', '--authored', 'deterministic', '--channel', 'kernel-generator');
  cli('story', 'advance', '--work-id', work, '--confirm', json(cli('story', 'advance', '--work-id', work, '--json')).confirmationDigest);
  await approve(cli, item, 'convergence');

  // Verification: SFlow writes its evidence from the records, and it reuses the code step's run on the same code.
  cli('prepare', 'verification');
  cli('artifact', 'scan', '--phase', 'verification');
  cli('phase', 'publish', 'verification', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'verification');
  await approve(cli, item, 'verification');

  // The release: SFlow writes its conformance report from the records; the person publishes, submits and approves it.
  cli('prepare', 'release');
  cli('artifact', 'scan', '--phase', 'release');
  cli('phase', 'publish', 'release', '--authored', 'human', '--channel', 'manual-in-place');
  cli('submit', 'release');
  await approve(cli, item, 'release');
  assert.equal((await readState(item)).status, 'closed', 'the Story ends');

  // A statement the person left out of scope is no clause: listed under each table with its decision, never a row, and
  // the verification evidence counts the requirements alone.
  const report = await readFile(path.join(item, 'artifacts/release/conformance.md'), 'utf8');
  const trace = report.slice(report.indexOf('## Requirement trace'), report.indexOf('## Constitution conformance'));
  const tested = await readFile(path.join(item, 'artifacts/verification/test-evidence.md'), 'utf8');
  for (const clause of clauses) assert.match(trace, new RegExp(`^\\| \`${clause}\` \\| .* \\| matched \\|$`, 'mu'), `${clause} is a row of the trace`);
  for (const entry of excluded) {
    for (const text of [trace, tested]) {
      assert.match(text, listedAs(entry.id, 'excluded'), `${entry.id} is listed with its decision`);
      assert.doesNotMatch(text, rowOf(entry.id), `${entry.id} is no row`);
    }
  }
  assert.match(tested, /^2 of 2 requirements verified;/mu);
  await atEnd?.({ ...story, item, cli, base, remoteGit });
}

test('a state-ref Story from its start to its release: the code on the branch, every record on its state ref',
  slowLane({ timeout: 1_800_000 }), async (t) => {
    preview(t);
    const work = 'SSB-C1';
    let published;
    await walkToRelease(t, work, {
      stateRef: true,
      atCode: async ({ root, item, git, cli, base, remoteGit }) => {
        published = git('rev-parse', 'HEAD');
        assert.notEqual(published, base, 'the code is a commit on the Story branch');
        assert.deepEqual(git('diff', '--name-only', base, published).split('\n').sort(), ['src/value.mjs', 'test/value.test.mjs'],
          'the branch carries the code and its test, no SFlow record');
        assert.equal(remoteGit('rev-parse', `refs/heads/${work}`), published, 'the branch was published');
        assert.equal(remoteGit('rev-parse', REF(work)), git('rev-parse', REF(work)), 'and the state ref with it');
        assert.match(git('log', '-1', '--format=%B', REF(work)), new RegExp(`Story-Code-Commit: ${published}`, 'u'));
        // What this change does [CSP:REQ-005]: written in the code step's publication, a record on the state ref.
        assert.ok(existsSync(path.join(item, 'CHANGE-STORY.md')), 'the page is in the state checkout');
        assert.ok(git('ls-tree', '--name-only', REF(work)).split('\n').includes('CHANGE-STORY.md'), 'committed on the state ref');
        assert.ok(!existsSync(path.join(root, 'singularity/work-items', work)), 'and nowhere in the code checkout');
        const page = json(cli('explain', '--subject', 'change', '--page', '--json')).data.page;
        assert.equal(page.status, 'written', 'the read finds the page SFlow wrote');
        assert.equal(page.path, '.sflow-state/CHANGE-STORY.md');
        assert.match(page.markdown, new RegExp(`^# What this change does: ${work}`, 'u'));
        assert.equal(json(cli('work', 'status', work, '--json')).changeStory?.summary, page.summary, 'work status names it');
      },
      atEnd: async ({ root, item, git, remoteGit }) => {
        assert.equal(git('rev-parse', 'HEAD'), published, 'nothing after the code step put a commit on the branch');
        assert.equal(remoteGit('rev-parse', `refs/heads/${work}`), published);
        assert.equal(remoteGit('rev-parse', REF(work)), git('rev-parse', REF(work)), 'the state ref is published to its end');
        assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
        assert.equal(git('-C', item, 'status', '--porcelain', '--untracked-files=all'), '');
        const records = git('ls-tree', '-r', '--name-only', REF(work)).split('\n');
        for (const expected of ['context/code-delivery/implementation-gen1.json', 'context/code-delivery/implementation-gen1-changes.json',
          'context/convergence/iteration-1.json', 'artifacts/verification/test-evidence.md', 'artifacts/release/conformance.md', 'CHANGE-STORY.md']) {
          assert.ok(records.includes(expected), `${expected} is on the state ref`);
        }
        assert.ok(records.some((file) => file.startsWith('context/code-delivery/tests/attempts/implementation/')), 'and the test runs');
        assert.ok(records.some((file) => file.startsWith('context/code-delivery/tests/raw/')), 'with their reports');
        const transitions = git('log', '--format=%s', REF(work)).split('\n');
        for (const phase of ['convergence', 'verification', 'release']) {
          assert.ok(transitions.some((subject) => subject.startsWith(`[${work}][phase:${phase}][approve]`)), `${phase}'s approval is a state commit`);
        }
        assert.ok(!git('ls-tree', '-r', '--name-only', published).split('\n').some((file) => file.startsWith('singularity/work-items/')));
        assert.ok(!existsSync(path.join(root, 'singularity/work-items', work)));
      }
    });
  });

test('today\'s layout, the same walk: a statement left out of scope is listed under the release trace and the Story ends',
  slowLane({ timeout: 1_800_000 }), async (t) => {
    await walkToRelease(t, 'SSB-B1', {
      stateRef: false,
      atEnd: async ({ root, git }) => {
        assert.equal(git('status', '--porcelain', '--untracked-files=all'), '');
        assert.ok(existsSync(path.join(root, 'singularity/work-items/SSB-B1/CHANGE-STORY.md')), 'the page is in the Story folder');
      }
    });
  });
