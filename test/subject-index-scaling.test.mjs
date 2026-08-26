/**
 * The subject index must cost what the refs cost, not what the refs times the Stories cost.
 *
 * `buildRepositorySubjectIndexFromRefs` ran `git show` once per record and `refHead` once per record
 * — and `refHead` is a property of the ref, not of the file, so it was asked once for every subject
 * found on the ref it does not vary across. The cost was branches × Stories, and both factors are
 * large on a real portfolio.
 *
 * Measured by the growth tier before the fix: 966 subprocesses for one `snapshot --json` on twelve
 * branches and forty Stories, of which 960 were this loop. The benchmark can see that, but it takes
 * a minute and a ten-thousand-file fixture to say it. This asserts the same property directly, in
 * seconds, on the one thing that must not change: adding Stories must not add subprocesses.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function repository(stories, branches = 3) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-subject-scale-'));
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Subject Index']);
  git(['config', 'user.email', 'subject@example.invalid']);
  await mkdir(path.join(directory, 'singularity'), { recursive: true });
  await writeFile(path.join(directory, 'singularity/workflow.yml'),
    'version: 2\nworkItemRoot: singularity/work-items\n', 'utf8');
  for (let index = 0; index < stories; index += 1) {
    const id = `SUBJ-${String(index + 1).padStart(3, '0')}`;
    await mkdir(path.join(directory, `singularity/work-items/${id}`), { recursive: true });
    await writeFile(path.join(directory, `singularity/work-items/${id}/workflow.json`),
      `${JSON.stringify({
        schemaVersion: 2,
        workItem: { id, title: `Story ${index + 1}`, branch: id, workType: 'chore' },
        status: 'active', currentPhase: 'intake', phaseOrder: ['intake'],
        phases: { intake: { id: 'intake', status: 'in_progress', generation: 0 } },
        lineage: { canonicalBranch: id, childBranches: [], requiredChecks: [] },
        history: []
      }, null, 2)}\n`, 'utf8');
  }
  git(['add', '.']);
  git(['commit', '-q', '-m', 'subjects']);
  for (let index = 1; index < branches; index += 1) git(['branch', `work-${index}`]);
  return directory;
}

/** Build the index in a child process, and report what the probe counted. */
function measure(repositoryRoot, refs) {
  const script = `
    const { buildRepositorySubjectIndexFromRefs } = await import(${JSON.stringify(path.join(root, 'src/repository-subject-index.mjs'))});
    const index = await buildRepositorySubjectIndexFromRefs(${JSON.stringify(repositoryRoot)}, {
      definition: { workItemRoot: 'singularity/work-items' },
      refs: ${JSON.stringify(refs)}
    });
    process.stdout.write(String(index.list().length));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, SINGULARITY_FLOW_SUBPROCESS_PROBE: '1', SINGULARITY_FLOW_NO_NETWORK: '1' }
  });
  assert.equal(run.status, 0, run.stderr);
  const summary = /^subprocesses:\s+(\d+)\s+calls/m.exec(run.stderr);
  assert.ok(summary, `the probe reported nothing: ${run.stderr}`);
  return { subprocesses: Number(summary[1]), subjects: Number(run.stdout) };
}

test('adding Stories does not add subprocesses', { timeout: 120_000 }, async () => {
  const refs = ['main', 'work-1', 'work-2'];

  const few = measure(await repository(2), refs);
  const many = measure(await repository(16), refs);

  // The index still finds everything: a cheaper read that reads less is not the same fix.
  assert.equal(few.subjects, 2, 'the small repository lost subjects');
  assert.equal(many.subjects, 16, 'the large repository lost subjects');

  assert.equal(many.subprocesses, few.subprocesses,
    `eight times the Stories cost ${many.subprocesses} subprocesses against ${few.subprocesses}.`
    + ' The read is per-Story again.');
});

test('adding refs adds a bounded, constant number of subprocesses', { timeout: 120_000 }, async () => {
  /**
   * Refs are the factor that legitimately costs something — twelve branches genuinely hold twelve
   * trees to read. The property is that each one costs a fixed handful and not a handful per
   * subject, so this pins the per-ref constant rather than requiring it to be zero.
   */
  const stories = 8;
  const two = measure(await repository(stories, 3), ['main', 'work-1']);
  const four = measure(await repository(stories, 5), ['main', 'work-1', 'work-2', 'work-3']);

  const perRef = (four.subprocesses - two.subprocesses) / 2;
  assert.ok(Number.isInteger(perRef) && perRef > 0, `implausible per-ref cost: ${perRef}`);
  assert.ok(perRef <= 6,
    `each additional ref costs ${perRef} subprocesses; with ${stories} Stories on it that is`
    + ' close enough to per-Story work to be worth reading again.');
});
