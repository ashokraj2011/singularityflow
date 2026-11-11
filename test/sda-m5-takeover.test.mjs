/**
 * SDA: takeover on another laptop, and several laptops on one remote (§9, §11; SDA-AC-012,
 * SDA-AC-004, SDA-AC-006).
 *
 * Each laptop is its own machine (scripts/test-machine-state.mjs): its own home, registry, Story
 * index and machine ID, and its own clone of one bare remote. Every command runs as the test
 * identity; these tests check the mechanism, not who may approve.
 *
 * A laptop's Git is wrapped on PATH (a native git.exe on Windows, test/helpers/git-test-wrapper.mjs):
 * - it can log every Git command the CLI runs, with its whole argument list, which is how takeover
 *   is shown to read no branch inventory and no history beyond the Story's own records;
 * - with a marker file present, the next push runs and then reports a dropped connection, as a
 *   response lost after the remote accepted the update would (the same fault as
 *   test/sda-lifecycle-conformance.test.mjs). A marker reading `offline` also takes the remote away,
 *   so the publisher cannot read the outcome back either. A server hook cannot delay the answer
 *   here: governed pushes run with hooks disabled, and the local receive-pack inherits that.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { isolatedTestEnvironment } from '../scripts/test-machine-state.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { gitTestWrapperEnvironment, realGitForTest, writeGitTestWrapper } from './helpers/git-test-wrapper.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

/** One bare remote, and laptops that each have their own machine state and clone of it. */
async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-sda-laptops-'));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const remote = path.join(base, 'remote.git');
  const exec = (command, args, cwd, env, { fail = false, input } = {}) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024,
      timeout: childTimeout(180_000) });
    if (!fail && result.status !== 0) assert.fail(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  exec('git', ['init', '--bare', '-q', '-b', 'main', remote], base, process.env);
  const realGit = realGitForTest();

  async function laptop(name, { clone = false } = {}) {
    const state = path.join(base, `${name}-machine`);
    const repo = path.join(base, name, 'app');
    const bin = path.join(base, `${name}-git`);
    const log = path.join(base, `${name}-git.log`);
    const loseNextPush = path.join(base, `${name}-lose-next-push`);
    await mkdir(state, { recursive: true });
    // Logs each command as one line of unit-separated arguments, then runs the real Git. Only a push
    // that succeeded while the marker exists reports a dropped connection (and, for `offline`, takes
    // the remote away first).
    await writeGitTestWrapper(bin, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, args.map((arg) => arg + '\\x1f').join('') + '\\n');
const status = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }).status ?? 1;
const marker = ${JSON.stringify(loseNextPush)};
if (status === 0 && fs.existsSync(marker) && args.includes('push')) {
  if (fs.readFileSync(marker, 'utf8').includes('offline')) fs.renameSync(${JSON.stringify(remote)}, ${JSON.stringify(`${remote}.away`)});
  fs.rmSync(marker, { force: true });
  process.stderr.write('fatal: the remote end hung up unexpectedly\\n');
  process.exit(128);
}
process.exit(status);
`);
    const isolated = isolatedTestEnvironment(state, process.env);
    const env = { ...gitTestWrapperEnvironment(bin, isolated), NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Packager',
      SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }) };
    await mkdir(path.dirname(repo), { recursive: true });
    if (clone) exec('git', ['clone', '-q', '--no-local', remote, repo], base, env);
    else await mkdir(repo, { recursive: true });
    const git = (...args) => exec('git', args, repo, env).stdout.trim();
    if (!clone) { git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', remote); }
    git('config', 'user.name', 'Packager');
    git('config', 'user.email', 'packager@example.com');
    const flow = (args, { cwd = repo, extra = {}, input } = {}) => exec(process.execPath, [CLI, ...args], cwd, { ...env, ...extra }, { input });
    const attempt = (args, { cwd = repo, extra = {}, input } = {}) => exec(process.execPath, [CLI, ...args], cwd, { ...env, ...extra }, { fail: true, input });
    return {
      name, state, repo, env, git, flow, attempt, loseNextPush,
      /** The Git commands logged since the last call, each as its argument list. */
      async gitCalls() {
        const text = existsSync(log) ? await readFile(log, 'utf8') : '';
        await writeFile(log, '');
        return text.split('\n').filter(Boolean).map((line) => line.split('\x1f').slice(0, -1));
      },
      async machineId() { return (await readFile(path.join(state, 'machine-id'), 'utf8')).trim(); }
    };
  }

  /** Laptop A's repository: Singularity Flow initialized on main and pushed. */
  async function seed(a) {
    await writeFile(path.join(a.repo, 'README.md'), '# several laptops\n');
    a.flow(['init']);
    const file = path.join(a.repo, 'singularity/workflow.yml');
    const definition = YAML.parse(await readFile(file, 'utf8'));
    definition.worldModel.grounding = 'off';
    // Not a review test: this fixture's Stories are unreviewed on purpose. Every step's review is walked in
    // review-every-step-cli.test.mjs.
    for (const workType of Object.values(definition.workTypes ?? {})) workType.sourceReview = { mode: 'off' };
    await writeFile(file, YAML.stringify(definition));
    a.git('add', '.');
    a.git('commit', '-qm', 'Initialize Singularity Flow');
    a.git('push', '-q', '-u', 'origin', 'main');
  }

  const remoteGit = (...args) => spawnSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' });
  return {
    base, remote, exec, laptop, seed,
    remoteGit,
    /** The Story's intake status on the remote's Story branch. */
    remoteIntake(id) {
      const shown = remoteGit('show', `${id}:singularity/work-items/${id}/workflow.json`);
      assert.equal(shown.status, 0, shown.stderr);
      return JSON.parse(shown.stdout).phases.intake.status;
    },
    /** Commit subjects on the remote's branch matching a pattern. */
    remoteSubjects(branch, pattern) {
      return remoteGit('log', '--format=%s', branch).stdout.split('\n').filter((line) => pattern.test(line));
    },
    /** Ledger entries on the remote's `state` branch, as their event type and subject. */
    remoteLedger() {
      const names = remoteGit('ls-tree', '-r', '--name-only', 'state').stdout.split('\n')
        .filter((name) => name.startsWith('ledger/entries/'));
      return names.map((name) => JSON.parse(remoteGit('show', `state:${name}`).stdout))
        .map((entry) => ({ type: entry.eventType, subject: entry.payload?.lifecycleEvent?.subject?.id ?? null }));
    }
  };
}

/** A Story whose intake is published and submitted on laptop L, awaiting approval. */
async function submitted(L, id) {
  L.git('switch', '-q', 'main');
  L.flow(['start', id, '--from-branch', 'main']);
  const artifact = path.join(L.repo, `singularity/work-items/${id}/artifacts/intake/intake.md`);
  await writeFile(artifact, (await readFile(artifact, 'utf8')).replace(/TODO:[^\n]*/gu,
    'Record this approval exactly once, even when the remote is unreachable or its answer is lost on the way back.'));
  L.flow(['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);
  L.flow(['submit', 'intake']);
}

/** Every file under `directory`, skipping Git object stores; absent directories have none. */
async function filesUnder(directory) {
  const output = [];
  const walk = async (current) => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'objects') await walk(absolute); }
      else if (entry.isFile()) output.push(absolute);
    }
  };
  await walk(directory);
  return output;
}

/** The Git subcommand of a logged call: the first argument that is not a global option or its value. */
function verb(args) {
  for (let index = 0; index < args.length; index += 1) {
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace'].includes(args[index])) { index += 1; continue; }
    if (!args[index].startsWith('-')) return { name: args[index], rest: args.slice(index + 1) };
  }
  return { name: null, rest: [] };
}

test('takeover on another laptop fetches no application branch but its Story\'s, reads no branch inventory, reuses nothing of the first laptop, and says what stayed there (SDA-AC-012)',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await fixture(t);
    const a = await f.laptop('a');
    await f.seed(a);
    a.flow(['start', 'TKO-1', '--from-branch', 'main']);
    const b = await f.laptop('b', { clone: true });

    // After laptop B cloned, A publishes the Story's intake, then edits it again without publishing.
    const intake = 'singularity/work-items/TKO-1/artifacts/intake/intake.md';
    const published = (await readFile(path.join(a.repo, intake), 'utf8')).replace(/TODO:[^\n]*/gu,
      'Take this Story over on a second laptop from what laptop A published to the shared remote.');
    await writeFile(path.join(a.repo, intake), published);
    a.flow(['phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place']);
    await writeFile(path.join(a.repo, intake), `${published}\nOnly laptop A has this sentence.\n`);
    // Application branches the remote gains after B cloned. Takeover must never fetch them.
    const decoys = ['feature/decoy-one', 'release/decoy-two'];
    for (const decoy of decoys) a.git('push', '-q', 'origin', `main:refs/heads/${decoy}`);
    await b.gitCalls();

    const surface = { SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: b.repo }) };
    const taken = JSON.parse(b.flow(['session', 'takeover', 'TKO-1', '--json'], { extra: surface }).stdout);
    assert.equal(taken.ready, true, JSON.stringify(taken.session));
    assert.equal(taken.workId, 'TKO-1');
    assert.equal(taken.phase, 'intake');
    assert.equal(b.git('branch', '--show-current'), 'main', 'the canonical clone stays where it was');
    const landed = await readFile(path.join(taken.repositoryPath, intake), 'utf8');
    assert.ok(landed.includes('from what laptop A published'), 'the published intake came across');
    assert.ok(!landed.includes('Only laptop A has this sentence.'), 'the unpublished edit stayed on laptop A');

    // The disclosure (M5's localWorkNotCarried): the work only laptop A held did not come along,
    // and the way back is a backup made there. A disclosure, never an exit.
    const disclosed = taken.localWorkNotCarried;
    assert.match(disclosed.message, /configuration drafts/u);
    assert.match(disclosed.message, /not recoverable here unless it was published/u);
    assert.equal(disclosed.restore, 'singularity-flow backup restore <DIRECTORY>');
    assert.doesNotMatch(disclosed.message, /\b(?:stop|wait|hand|relay)\b/iu, 'a disclosure, never an exit');

    // Git: of the application branches, only the Story's is fetched; no branch inventory; history
    // only of the Story's own records.
    const calls = (await b.gitCalls()).map(verb);
    assert.ok(calls.length > 0, 'the wrapper saw the CLI\'s Git');
    // The ledger (`state`) is an authority ref: discovery reads it, and fetches it once it moved.
    const fetches = calls.filter((call) => call.name === 'fetch');
    assert.deepEqual(fetches.flatMap((call) => call.rest.filter((arg) => /^\+?refs\//u.test(arg)))
      .filter((ref) => ref !== 'refs/heads/state'), ['+refs/heads/TKO-1:refs/remotes/origin/TKO-1'], JSON.stringify(fetches));
    for (const call of calls.filter((entry) => entry.name === 'for-each-ref')) {
      const patterns = call.rest.filter((arg) => !arg.startsWith('-'));
      assert.ok(!call.rest.some((arg) => /^--(?:contains|merged|no-merged|points-at)/u.test(arg)), JSON.stringify(call));
      assert.ok(patterns.length > 0 && patterns.every((ref) => /^refs\/(?:heads|remotes\/origin)\/[^/]/u.test(ref)
        && !/^refs\/remotes\/origin\/?$/u.test(ref)), `exact refs only: ${JSON.stringify(call)}`);
    }
    for (const call of calls.filter((entry) => entry.name === 'branch')) {
      assert.ok(!call.rest.some((arg) => /^(?:-r|-a|--remotes|--all|--list|-l)$/u.test(arg)), JSON.stringify(call));
    }
    for (const call of calls.filter((entry) => ['log', 'rev-list'].includes(entry.name))) {
      assert.ok(!call.rest.some((arg) => /^--(?:all|branches|remotes|tags|glob)\b/u.test(arg)), JSON.stringify(call));
      const separator = call.rest.indexOf('--');
      const revisions = (separator === -1 ? call.rest : call.rest.slice(0, separator)).filter((arg) => !arg.startsWith('-'));
      assert.deepEqual(revisions, [], `walks only the Story checkout's own HEAD: ${JSON.stringify(call)}`);
      assert.ok(separator !== -1 && call.rest.slice(separator + 1).length > 0
        && call.rest.slice(separator + 1).every((pathspec) => pathspec.startsWith('singularity/work-items/TKO-1/')),
      `limited to the Story's own records: ${JSON.stringify(call)}`);
    }
    const remoteRefs = b.git('for-each-ref', '--format=%(refname)', 'refs/remotes').split('\n');
    for (const decoy of decoys) assert.ok(!remoteRefs.includes(`refs/remotes/origin/${decoy}`), decoy);

    // Nothing of laptop A is reused: no path, machine ID or record of A in B's machine state, B's
    // private Git state or the result.
    const [machineA, machineB] = [await a.machineId(), await b.machineId()];
    assert.notEqual(machineA, machineB);
    const aPlaces = [path.join(f.base, 'a'), a.state, path.join(f.base, 'a-git')];
    const resultText = JSON.stringify(taken);
    for (const place of aPlaces) assert.ok(!resultText.includes(place), place);
    for (const file of [...await filesUnder(b.state), ...await filesUnder(path.join(b.repo, '.git'))]) {
      const text = await readFile(file, 'latin1');
      for (const marker of [machineA, ...aPlaces]) assert.ok(!text.includes(marker), `${file} holds ${marker}`);
    }

    // In plain words, taking it over again says the same, without the JSON.
    const text = b.flow(['session', 'takeover', 'TKO-1'], { extra: surface }).stdout;
    assert.match(text, /^Took over TKO-1 at phase intake: /u);
    assert.ok(text.includes(disclosed.message), text);
    assert.throws(() => JSON.parse(text));
  });

test('an approval that cannot reach the remote, or whose answer is lost, is never accepted and lands exactly once (SDA-AC-004)',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await fixture(t);
    const a = await f.laptop('a');
    await f.seed(a);
    const approvals = (id) => f.remoteSubjects(id, new RegExp(`^\\[${id}\\]\\[phase:intake\\]\\[approve\\]`, 'u'));
    const ledgerApprovals = (id) => f.remoteLedger().filter((entry) => entry.type === 'phase-approved' && entry.subject === id);

    // Offline: the remote cannot be reached at all.
    await submitted(a, 'OFF-1');
    await rename(f.remote, `${f.remote}.away`);
    const offline = a.attempt(['approve', 'intake', '--yes', '--json']);
    assert.notEqual(offline.status, 0, offline.stdout);
    const refusal = JSON.parse(offline.stdout).error;
    assert.equal(refusal.outcomeClass, 'OUTCOME_UNKNOWN', offline.stdout);
    assert.match(refusal.message, /retained locally but push failed/u);
    const retained = a.git('rev-parse', 'HEAD');
    // The same approval again, still offline, is refused as pending; nothing more is recorded.
    const again = a.attempt(['approve', 'intake', '--yes', '--json']);
    assert.notEqual(again.status, 0, again.stdout);
    const pending = JSON.parse(again.stdout);
    assert.equal(pending.outcome.status, 'refused', again.stdout);
    assert.equal(pending.outcome.slots.gate, 'publicationPending', again.stdout);
    assert.ok(pending.next.some((step) => step.command === 'singularity-flow sync'), again.stdout);
    assert.equal(a.git('rev-parse', 'HEAD'), retained);
    await rename(`${f.remote}.away`, f.remote);
    assert.equal(f.remoteIntake('OFF-1'), 'awaiting_approval', 'nothing was approved remotely');
    assert.deepEqual([approvals('OFF-1').length, ledgerApprovals('OFF-1').length], [0, 0]);
    a.flow(['sync', '--json']);
    assert.equal(f.remoteIntake('OFF-1'), 'approved');
    assert.equal(f.remoteGit('rev-parse', 'refs/heads/OFF-1').stdout.trim(), retained, 'sync published the retained commit');
    assert.deepEqual([approvals('OFF-1').length, ledgerApprovals('OFF-1').length], [1, 1]);

    // Lost answer, then no connection: the remote accepts the approval, the reply never arrives, and
    // the remote cannot be reached to read the outcome back.
    await submitted(a, 'LOST-1');
    await writeFile(a.loseNextPush, 'offline');
    const lost = a.attempt(['approve', 'intake', '--yes', '--json']);
    assert.notEqual(lost.status, 0, lost.stdout);
    assert.equal(JSON.parse(lost.stdout).error.outcomeClass, 'OUTCOME_UNKNOWN', lost.stdout);
    assert.deepEqual([existsSync(a.loseNextPush), existsSync(`${f.remote}.away`)], [false, true], 'the fault was injected once');
    const pendingFile = path.join(a.repo, '.git/singularity-flow/pending-publication/story--LOST-1.json');
    const record = JSON.parse(await readFile(pendingFile, 'utf8'));
    const held = record.record ?? record;
    assert.equal(held.pushOutcome, 'transport-indeterminate');
    assert.equal(spawnSync('git', ['--git-dir', `${f.remote}.away`, 'rev-parse', 'refs/heads/LOST-1'], { encoding: 'utf8' }).stdout.trim(),
      held.commit, 'the remote accepted it');
    const unsettled = a.attempt(['approve', 'intake', '--yes', '--json']);
    assert.notEqual(unsettled.status, 0, unsettled.stdout);
    assert.equal(JSON.parse(unsettled.stdout).outcome.slots.gate, 'publicationPending', unsettled.stdout);
    await rename(`${f.remote}.away`, f.remote);
    // Asked again with the remote back, approval first settles the retained commit, then says it is
    // already approved, which is now true.
    const repeated = a.attempt(['approve', 'intake', '--yes', '--json']);
    assert.notEqual(repeated.status, 0, repeated.stdout);
    assert.equal(JSON.parse(repeated.stdout).outcome.messageId, 'approve.refused', repeated.stdout);
    assert.equal(existsSync(pendingFile), false, 'the retained commit was settled by reading the remote');
    a.flow(['sync', '--json']);
    assert.equal(f.remoteIntake('LOST-1'), 'approved');
    assert.equal(f.remoteGit('rev-parse', 'refs/heads/LOST-1').stdout.trim(), held.commit, 'no second approval commit');
    assert.deepEqual([approvals('LOST-1').length, ledgerApprovals('LOST-1').length], [1, 1]);

    // Lost answer with the remote still there: approval reads the outcome back and reports it once.
    await submitted(a, 'LATE-1');
    await writeFile(a.loseNextPush, '');
    // An approval that lands prints its review before its result.
    const approved = a.flow(['approve', 'intake', '--yes', '--json']).stdout;
    const late = JSON.parse(approved.slice(approved.lastIndexOf('\n{\n') + 1));
    assert.equal(late.outcome.status, 'succeeded');
    assert.equal(late.data.pushed, true);
    assert.equal(existsSync(a.loseNextPush), false, 'the answer was lost');
    assert.equal(f.remoteGit('rev-parse', 'refs/heads/LATE-1').stdout.trim(), late.data.commit);
    assert.deepEqual([approvals('LATE-1').length, ledgerApprovals('LATE-1').length], [1, 1]);
    assert.equal(existsSync(path.join(a.repo, '.git/singularity-flow/pending-publication/story--LATE-1.json')), false);
  });

test('Stories from two laptops both land, and two configuration proposals for one approval group never overwrite each other (SDA-AC-006)',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await fixture(t);
    const a = await f.laptop('a');
    await f.seed(a);
    // The approved configuration authority, as `configuration approve` updates it.
    a.git('push', '-q', 'origin', 'main:refs/heads/sflow/config');
    const b = await f.laptop('b', { clone: true });

    // Independent Stories: B cloned before A started its Story, so B's ledger is behind when it starts its own.
    a.flow(['start', 'LAP-A', '--from-branch', 'main']);
    b.flow(['start', 'LAP-B', '--from-branch', 'main']);
    for (const id of ['LAP-A', 'LAP-B']) {
      assert.equal(f.remoteGit('show-ref', '--verify', '--quiet', `refs/heads/${id}`).status, 0, id);
      assert.equal(f.remoteLedger().filter((entry) => entry.type === 'binding' && entry.subject === id).length, 1, id);
    }

    // Configuration proposals from one base: A renames the product approval group, B edits a
    // separate asset and also renames the same group differently.
    const authority = (L, relative) => spawnSync('git', ['show', `origin/sflow/config:${relative}`], { cwd: L.repo, encoding: 'utf8' }).stdout;
    const group = async (L, label) => {
      const definition = YAML.parse(authority(L, 'singularity/workflow.yml'));
      definition.approvalAuthorities['product-approvers'].label = label;
      return JSON.parse(L.flow(['configuration', 'save', 'singularity/workflow.yml', '--propose', '--json'],
        { input: YAML.stringify(definition) }).stdout);
    };
    for (const L of [a, b]) L.git('fetch', '-q', 'origin', 'sflow/config');
    const fromA = await group(a, 'Product approvers (laptop A)');
    const separate = JSON.parse(b.flow(['configuration', 'save', 'singularity/prompts/copilot-planning.md', '--propose', '--json'],
      { input: `${authority(b, 'singularity/prompts/copilot-planning.md')}\nPlanned on laptop B.\n` }).stdout);
    const fromB = await group(b, 'Product approvers (laptop B)');
    for (const proposal of [fromA, separate, fromB]) assert.ok(proposal.branch, JSON.stringify(proposal));

    const approve = (L, proposal) => L.attempt(['configuration', 'approve', proposal.branch, '--yes', '--json']);
    const first = approve(a, fromA);
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const unrelated = approve(b, separate);
    assert.equal(unrelated.status, 0, unrelated.stdout + unrelated.stderr);
    const competing = approve(b, fromB);
    assert.notEqual(competing.status, 0, competing.stdout);
    assert.equal(JSON.parse(competing.stdout).error.code, 'CONFIGURATION_ENTITY_CONFLICT', competing.stdout);

    const approved = (relative) => f.remoteGit('show', `sflow/config:${relative}`).stdout;
    assert.equal(YAML.parse(approved('singularity/workflow.yml')).approvalAuthorities['product-approvers'].label,
      'Product approvers (laptop A)', 'the first approval stands');
    assert.match(approved('singularity/prompts/copilot-planning.md'), /Planned on laptop B\.\n$/u, 'the separate asset landed');
  });

// Sweep B1: laptop A's approval lands but its answer is lost and the remote then goes away; laptop B
// takes the Story over and publishes on top of that approval. A's sync called the approval "sent
// outside SFlow (a hand push, say)", rewrote its lost answer to rejected, recover offered sync for
// ever and approve named sync. The remote building on it is proof it landed: sync settles it.
test('a lost approval another laptop has since built on is settled by sync as published, never as a hand push (sweep B1)',
  slowLane({ timeout: 900_000 }), async (t) => {
    const f = await fixture(t);
    const a = await f.laptop('a');
    await f.seed(a);
    const id = 'BUILT-1';
    await submitted(a, id);
    await writeFile(a.loseNextPush, 'offline');
    const lost = a.attempt(['approve', 'intake', '--yes', '--json']);
    assert.equal(JSON.parse(lost.stdout).error.outcomeClass, 'OUTCOME_UNKNOWN', lost.stdout);
    const pendingFile = path.join(a.repo, `.git/singularity-flow/pending-publication/story--${id}.json`);
    const held = (JSON.parse(await readFile(pendingFile, 'utf8'))).record ?? JSON.parse(await readFile(pendingFile, 'utf8'));
    assert.equal(held.pushOutcome, 'transport-indeterminate');
    await rename(`${f.remote}.away`, f.remote);

    // Laptop B takes the Story over and publishes a document on top of A's approval.
    const b = await f.laptop('b', { clone: true });
    const surface = { SINGULARITY_FLOW_SURFACE_CONTEXT: JSON.stringify({ schemaVersion: 1, repositoryPath: b.repo }) };
    const taken = JSON.parse(b.flow(['session', 'takeover', id, '--json'], { extra: surface }).stdout);
    assert.equal(taken.ready, true, JSON.stringify(taken));
    const evidence = path.join(f.base, 'evidence.md');
    await writeFile(evidence, '# Evidence\n\nWritten on laptop B after taking the Story over.\n');
    b.flow(['documents', 'upload', evidence, '--name', 'Evidence'], { cwd: taken.repositoryPath });
    const tip = f.remoteGit('rev-parse', `refs/heads/${id}`).stdout.trim();
    assert.notEqual(tip, held.commit);
    assert.equal(f.remoteGit('merge-base', '--is-ancestor', held.commit, tip).status, 0, 'B built on A\'s approval');

    // A's sync settles the lost answer: nothing is pushed, nothing is called a hand push.
    const synced = a.attempt(['sync', id]);
    assert.equal(synced.status, 0, synced.stdout + synced.stderr);
    assert.match(synced.stdout, /had already reached origin\/BUILT-1/u);
    assert.match(synced.stdout, /another clone has since published on top of it/u);
    assert.doesNotMatch(synced.stdout + synced.stderr, /hand push|sent outside SFlow|--set-aside/u);
    assert.equal(existsSync(pendingFile), false, 'the lost answer is settled');
    assert.equal(f.remoteGit('rev-parse', `refs/heads/${id}`).stdout.trim(), tip, 'the remote stays as B left it');
    assert.equal(f.remoteSubjects(id, new RegExp(`^\\[${id}\\]\\[phase:intake\\]\\[approve\\]`, 'u')).length, 1);
    assert.equal(f.remoteLedger().filter((entry) => entry.type === 'phase-approved' && entry.subject === id).length, 1,
      'one approval in the ledger');

    // recover no longer offers sync, and approval is no longer held back by a publication.
    const plan = JSON.parse(a.flow(['recover', id, '--json']).stdout);
    assert.equal(plan.pendingPublication, false, JSON.stringify(plan));
    assert.ok(!plan.actions.some((entry) => entry.id === 'publish' || /\bsync\b/u.test(entry.command ?? '')), JSON.stringify(plan.actions));
    const again = a.attempt(['approve', 'intake', '--yes', '--json']);
    assert.notEqual(JSON.parse(again.stdout).outcome?.slots?.gate, 'publicationPending', again.stdout);
  });
