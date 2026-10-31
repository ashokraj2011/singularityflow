/**
 * SDA M5 acceptance over the read surfaces.
 *
 * SDA-AC-008: the CLI, the gateway the VS Code extension runs (and Copilot reads through), and the
 * private read worker resolve the same Story, phase, revision, mutation capability and next action
 * from one fixture. Each surface computes them on its own; this asks all three at two lifecycle
 * states. (test/surface-agreement.test.mjs walks the CLI and gateway through every state.)
 *
 * SDA-AC-015: over the Story list and the intake catalog, access denied, an empty inventory, an
 * absent authority, corrupt data, a timeout and a cancellation stay distinguishable, each with its
 * own recovery. (An unknown write outcome is M1's, test/outcome-classes.test.mjs.)
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createSessionListingFixture } from '../scripts/session-listing-benchmark.mjs';
import { runRemoteGitAsync } from '../src/git-execution.mjs';
import { stateRefreshError } from '../src/git-remote-diagnostics.mjs';
import { readProjectionRecord, readRefreshAttempt } from '../src/repository-check-cache.mjs';
import { createHostGateway } from '../src/gateway/host.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { readWorkerValue } from '../src/read-worker-service.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { slowLane } from './helpers/slow-lane.mjs';
import { CLI, specification, startedSpecificationStory } from './helpers/submitted-planning-story.mjs';

const WORK = 'SURF-8';

/** The command registry's answer to "does this next action change anything?" */
function registryMutates(action) {
  // A route without argv spells only its command; these commands carry no quoted arguments.
  const words = action.argv ?? action.command.split(/\s+/u).slice(1);
  const positionals = words.filter((word) => !word.startsWith('--'));
  const options = Object.fromEntries(words.filter((word) => word.startsWith('--')).map((word) => [word.slice(2), true]));
  return resolveOperation({ requestedCommand: positionals[0], positionals, options }).classification === 'mutation';
}

async function gatewayRead(root, label, request) {
  const { kernel } = createHostGateway({ root, hostSessionId: `surfaces-${label}`, planners: gatewayPlanners(),
    routeModelMode: { enabled: true, source: 'default' } });
  const resolved = await kernel.resolve(request);
  assert.equal(resolved.kind, 'read', `${label}: ${request.utterance} resolves to a read`);
  return kernel.read({ resolutionId: resolved.next[0].handle });
}

async function agree(story, label) {
  const { root, run, git } = story;
  const json = (args) => JSON.parse(run(process.execPath, [CLI, ...args]).stdout);
  const worker = async (args) => {
    const answer = await readWorkerValue(root, args);
    assert.equal(answer.kind, 'value', `${label}: the worker serves ${args.join(' ')}`);
    return answer.value;
  };
  const head = git('rev-parse', 'HEAD');

  // The CLI, as a terminal or Copilot runs it.
  const cli = {
    status: json(['status', WORK, '--json']), next: json(['nextsteps', WORK, '--json']),
    snapshot: json(['snapshot', '--include', 'repository', '--json'])
  };
  // The read worker VS Code keeps warm, answering the same three reads in this process.
  const warm = {
    status: await worker(['status', WORK, '--json']), next: await worker(['nextsteps', WORK, '--json']),
    snapshot: await worker(['snapshot', '--include', 'repository', '--json'])
  };
  // The gateway, as the extension and its language-model tools reach it.
  const listed = await gatewayRead(root, `${label}-list`, { utterance: 'my work' });
  const item = listed.data.items.find((entry) => entry.id === WORK);
  assert.ok(item, `${label}: the work list shows the Story`);
  const continued = await gatewayRead(root, `${label}-continue`, { utterance: 'pick up where I left off', arguments: { workId: WORK } });
  const recommended = await gatewayRead(root, `${label}-next`, { utterance: 'what should I do next' });
  const guidance = recommended.data.guidance;

  // The Story.
  for (const [surface, id] of [['nextsteps', cli.next.workId], ['worker status', warm.status.workItem.id],
    ['worker nextsteps', warm.next.workId], ['gateway list', item.id], ['gateway continue', continued.subject.id],
    ['gateway next', guidance.workId]]) assert.equal(id, cli.status.workItem.id, `${label}: ${surface} names the same Story`);

  // The phase.
  for (const [surface, phase] of [['nextsteps', cli.next.currentPhase], ['worker status', warm.status.currentPhase],
    ['worker nextsteps', warm.next.currentPhase], ['gateway list', item.phase], ['gateway continue', continued.data.work.phase],
    ['gateway next', guidance.currentPhase]]) assert.equal(phase, cli.status.currentPhase, `${label}: ${surface} is at the same phase`);

  // The revision: the lifecycle generation of that phase and the source commit the answers were read at.
  const generation = cli.status.phases[cli.status.currentPhase].generation;
  assert.equal(warm.status.phases[warm.status.currentPhase].generation, generation, `${label}: worker generation`);
  assert.equal(item.generation, generation, `${label}: gateway generation`);
  for (const [surface, commit] of [['CLI snapshot', cli.snapshot.repository.head], ['worker snapshot', warm.snapshot.repository.head],
    ['gateway continue', continued.subject.revision.sourceCommit], ['gateway list', listed.subject.revision.sourceCommit]]) {
    assert.equal(commit, head, `${label}: ${surface} read the checkout at HEAD`);
  }

  // The next action, in the model mode each serves by default (the worker takes no --no-model).
  const now = (snapshot) => snapshot.actions.find((action) => action.timing === 'now');
  assert.ok(now(cli.next), `${label}: nextsteps has a step to take now`);
  assert.equal(now(warm.next).command, now(cli.next).command, `${label}: the worker's next step`);
  assert.equal(guidance.recommendation.command, now(cli.next).command, `${label}: the gateway's recommended step`);
  assert.equal(recommended.next.find((action) => action.id === 'developer:recommended').fallback.command, now(cli.next).command,
    `${label}: the gateway's recommended action runs that command`);

  // The mutation capability: whether taking it changes governed state, as the registry the CLI
  // dispatches through classifies it and as the gateway previews it before anyone confirms it.
  const mutates = registryMutates(now(cli.next));
  assert.equal(guidance.recommendation.effect.mutatesState, mutates, `${label}: same answer to "does this change anything?"`);
  assert.equal(guidance.recommendation.confirmation.required, mutates, `${label}: confirmation follows the mutation`);
  assert.equal(registryMutates(now(warm.next)), mutates, `${label}: the worker's step is the same kind`);
  // No read surface itself changed anything to answer.
  for (const read of [listed, continued, recommended]) assert.ok(Object.values(read.effects).every((value) => value === false));
  assert.equal(git('rev-parse', 'HEAD'), head, `${label}: answering moved nothing`);
}

test('the CLI, the gateway and the read worker resolve one Story the same way (SDA-AC-008)', slowLane({ timeout: 600_000 }), async (t) => {
  const story = await startedSpecificationStory(t, WORK);
  // The in-process surfaces act as the same person the CLI runs as.
  const saved = { identity: process.env.SINGULARITY_FLOW_TEST_IDENTITY, mode: process.env.NODE_ENV };
  process.env.SINGULARITY_FLOW_TEST_IDENTITY = 'History Tester';
  process.env.NODE_ENV = 'test';
  t.after(() => {
    for (const [name, value] of [['SINGULARITY_FLOW_TEST_IDENTITY', saved.identity], ['NODE_ENV', saved.mode]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  await agree(story, 'specification in progress');

  await writeFile(path.join(story.item, 'artifacts/specification/spec.md'), specification(WORK, 1));
  story.cli('artifact', 'scan', '--phase', 'specification');
  story.cli('phase', 'publish', 'specification', '--authored', 'human', '--channel', 'manual-in-place');
  story.cli('submit', 'specification', '--skip-checks');
  await agree(story, 'specification submitted');
});

/**
 * A Git that answers remote operations as a provider does on a bad day: refusing access (HTTP 403),
 * or never answering. Every other command, and every call while it is set to
 * pass, is the real Git. Its mode is outside the read index's record key, so one record spans modes.
 */
async function providerGit(directory) {
  const shims = path.join(directory, 'provider-git');
  await mkdir(shims);
  const real = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  await writeFile(path.join(shims, 'git'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const remote = ['ls-remote', 'fetch', 'clone'].some((verb) => args.includes(verb));
const mode = process.env.SFLOW_TEST_PROVIDER;
if (remote && mode === 'deny') {
  process.stderr.write("remote: Permission to app.git denied to packager.\\nfatal: unable to access 'https://git.example.test/app.git/': The requested URL returned error: 403\\n");
  process.exit(128);
}
if (remote && mode === 'hang') setTimeout(() => process.exit(0), 60000);
else process.exit(spawnSync(${JSON.stringify(real)}, args, { stdio: 'inherit' }).status ?? 1);
`);
  await chmod(path.join(shims, 'git'), 0o755);
  return shims;
}

test('the Story list and catalog keep every failure distinguishable, with its own recovery (SDA-AC-015)', slowLane({ timeout: 600_000 }), async (t) => {
  const f = await createSessionListingFixture(); t.after(f.cleanup);
  const shims = await providerGit(f.directory);
  const provider = (mode, extra = {}) => ({ PATH: `${shims}${path.delimiter}${f.env.PATH}`, SFLOW_TEST_PROVIDER: mode, ...extra });
  const list = async (mode, options = [], extra = {}) => (await f.invoke({ extra: provider(mode, extra), options }));
  const catalog = async (mode, options = [], extra = {}) => (await f.invoke({ extra: provider(mode, extra), options,
    command: ['workspace', 'branches', '--intake'], selectors: false }));
  const refusal = (run) => { assert.notEqual(run.child.status, 0, run.child.stdout); return run.packet.error; };
  const remoteHead = (branch) => f.git(f.remote, 'rev-parse', `refs/heads/${branch}`);

  // Never synchronized and denied: a refusal naming the denial, never an empty list.
  const neverDenied = refusal(await list('deny'));
  assert.equal(neverDenied.code, 'SESSION_STATE_REFRESH_UNAVAILABLE');
  assert.equal(neverDenied.remoteFailure.failure.code, 'REMOTE_AUTHORIZATION_DENIED');
  assert.match(neverDenied.remoteFailure.failure.advice, /read access/u);
  const catalogDenied = refusal(await catalog('deny'));
  assert.equal(catalogDenied.code, 'REMOTE_AUTHORIZATION_DENIED');
  assert.match(catalogDenied.message, /read access/u);

  // A timeout: its own code and evidence, with advice that does not invent a network diagnosis.
  const deadline = { SINGULARITY_FLOW_GIT_CONFIGURATION_TIMEOUT_MS: '1500', SINGULARITY_FLOW_GIT_PREFLIGHT_TIMEOUT_MS: '1500' };
  const timedOut = refusal(await list('hang', [], deadline));
  assert.equal(timedOut.remoteFailure.failure.code, 'REMOTE_OPERATION_TIMEOUT');
  assert.equal(timedOut.remoteFailure.evidence.timedOut, true);
  assert.match(timedOut.remoteFailure.failure.advice, /does not establish a DNS failure/u);
  assert.equal(refusal(await catalog('hang', [], deadline)).code, 'REMOTE_OPERATION_TIMEOUT');

  // An empty inventory: verified, complete and empty, at the ledger's commit. (The first read moves
  // the tracking refs it depends on, so the second is the one the index keeps.)
  await list('pass'); await catalog('pass');
  const empty = await list('pass');
  assert.equal(empty.child.status, 0, empty.child.stderr);
  assert.deepEqual([empty.packet.count, empty.packet.unavailableCount, empty.packet.source], [0, 0, 'state-ledger']);
  assert.equal(empty.packet.listingSnapshot.freshness, 'fresh');
  assert.equal(empty.packet.listingSnapshot.completeness, 'complete');
  assert.deepEqual(empty.packet.listingSnapshot.acceptedRevision, { ledgerCommit: remoteHead(f.definition.ledger.branch), authorityCommit: null });
  const choices = await catalog('pass');
  assert.equal(choices.child.status, 0, choices.child.stderr);
  assert.equal(choices.packet.choicesComplete, true);
  assert.deepEqual(choices.packet.unreachable, []);
  assert.deepEqual(choices.packet.readinessSnapshot.acceptedRevision, { ledgerCommit: null, authorityCommit: remoteHead('sflow/config') });

  // Denied with a verified record: the last-known answer, marked refresh-failed with the real error.
  const kept = await list('deny', ['--refresh']);
  assert.equal(kept.child.status, 0, kept.child.stderr);
  assert.equal(kept.packet.count, 0);
  assert.equal(kept.packet.listingSnapshot.freshness, 'refresh-failed');
  assert.equal(kept.packet.listingSnapshot.refreshError.remoteFailure.classification, 'authorization-denied');
  assert.match(kept.packet.listingSnapshot.refreshError.message, /read access/u);

  // Cancelled: the read stops with no answer at all, and the verified record is left as it was.
  const cancelled = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'session', 'candidates', '--workspace', path.join(f.directory, 'workspace'),
      '--repository', 'app', '--refresh', '--diagnostics', '--json'], { cwd: f.original, env: { ...f.env, ...provider('hang') } });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    setTimeout(() => child.kill('SIGINT'), 2500);
    child.once('close', (status, signal) => resolve({ status, signal, stdout }));
  });
  assert.equal(cancelled.signal, 'SIGINT');
  assert.equal(cancelled.stdout, '', 'a cancelled read claims nothing: no list, no refusal');
  const listings = path.join(path.dirname(f.env.SINGULARITY_FLOW_REPOSITORY_CHECK_PREFERENCES), 'cache', 'session-listings');
  const [record] = (await readdir(listings)).filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry)).map((entry) => path.join(listings, entry));
  assert.ok(readProjectionRecord(record, null), 'the verified record survives the cancellation');
  assert.equal(readRefreshAttempt(record).error.remoteFailure.classification, 'authorization-denied',
    'the cancellation did not record itself as a failed refresh: the denial before it is still the latest error');
  const after = await list('pass');
  assert.equal(after.child.status, 0, after.child.stderr);
  assert.equal(after.packet.count, 0);
  // A host that cancels through its signal gets the cancellation class, never a timeout or a denial.
  const controller = new AbortController(); controller.abort();
  const aborted = await runRemoteGitAsync(['ls-remote', '--heads', f.remote], { cwd: f.original, signal: controller.signal });
  assert.equal(aborted.failure.code, 'REMOTE_OPERATION_ABORTED');
  assert.equal(aborted.failure.classification, 'cancelled');
  assert.match(aborted.failure.advice, /cancelled/u);
  assert.equal(stateRefreshError({ branch: 'state' }, 'fetch', aborted).details.remoteFailure.failure.classification, 'cancelled');

  // Corrupt data: a record that fails its check is never served. It counts as missing, so with the
  // remote denied the read answers from the verified local clone, as a first read does (sweep A1);
  // reachable and asked to refresh, it recomputes.
  for (const name of (await readdir(listings)).filter((entry) => /^[a-f0-9]{64}\.json$/u.test(entry))) {
    await writeFile(path.join(listings, name), '{"format":1,"broken":', { mode: 0o600 });
  }
  const local = await list('deny');
  assert.equal(local.child.status, 0, local.child.stderr);
  assert.equal(local.packet.listingSnapshot.source, 'local');
  const recomputed = await list('pass', ['--refresh']);
  assert.equal(recomputed.child.status, 0, recomputed.child.stderr);
  assert.equal(recomputed.packet.listingSnapshot.source, 'fresh');

  // An absent authority is an answer, not an outage: no last-known list stands in for it, and it
  // names the state branch and the ledger repair rather than a transport fix.
  f.git(f.remote, 'branch', '-D', f.definition.ledger.branch);
  const absent = refusal(await list('pass', ['--refresh']));
  assert.equal(absent.code, 'SESSION_STATE_INDEX_UNAVAILABLE');
  assert.match(absent.message, new RegExp(`did not advertise the Story state-index branch '${f.definition.ledger.branch}'.*ledger initialization or repair`, 'u'));
  assert.equal(absent.remoteFailure, undefined, 'not a transport failure');
  // With no approved configuration, the catalog says its workflows come from the base and names no authority.
  f.git(f.remote, 'branch', '-D', 'sflow/config');
  const legacy = await catalog('pass', ['--refresh-readiness']);
  assert.equal(legacy.child.status, 0, legacy.child.stderr);
  assert.equal(legacy.packet.intake.workflowCatalogScope, 'selected-base');
  assert.equal(legacy.packet.intake.authorityCommit, null);
});
