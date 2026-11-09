import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { childLifecycle } from '../src/auto/auto-executor.mjs';
import {
  autoAttemptId, freezeAutoCandidate, readAutoCandidateVerification, verifyAutoCandidate
} from '../src/auto/auto-candidate.mjs';
import { stageModelPrompt } from '../src/model-prompt-transport.mjs';
import { invokeCopilotCli } from '../src/model-providers/copilot-cli.mjs';
import { freezeSgosCandidate, verifySgosCandidate } from '../src/sgos/candidate-lifecycle.mjs';
import { sha256 } from '../src/sgos/contracts.mjs';
import {
  createAgentTaskContract, createExecutionUnitManifest, createGenericProcessExecutionUnit
} from '../src/sgos/execution-units.mjs';
import { publishSgosCandidateVerifierPolicy } from './helpers/sgos-candidate-authority.mjs';

/*
 * A runner that stops a detached child (a deadline, a cancel) reaches the child's process group
 * even when the child itself has already exited. A descendant still holding the child's output
 * keeps `close` from arriving, so a stop skipped because the leader exited left the run waiting
 * until that descendant ended by itself [TCE:REQ-034].
 *
 * The leader starts a grandchild on its own stdout and stderr, waits until the grandchild traps
 * SIGTERM, records when it leaves, and exits 0. The grandchild runs on for 30 s. The run must
 * settle within its deadline and grace, with the grandchild gone by then. Windows has no group to
 * reach once the leader exited (an exited ID may name another process), so these are POSIX only.
 */
const posixOnly = { skip: process.platform === 'win32' };
const DESCENDANT_LIFETIME_MS = 30_000;
const SLACK_MS = 5_000;
const q = JSON.stringify;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function leaderLeavingADescendant(root) {
  const files = {
    leader: path.join(root, 'leader.cjs'), ready: path.join(root, 'descendant.pid'), left: path.join(root, 'leader-left.json')
  };
  const grandchild = `process.on('SIGTERM', () => {});
    const fs = require('node:fs');
    fs.writeFileSync(${q(`${files.ready}.tmp`)}, String(process.pid));
    fs.renameSync(${q(`${files.ready}.tmp`)}, ${q(files.ready)});
    setTimeout(() => {}, ${DESCENDANT_LIFETIME_MS});`;
  // Also loaded with --require ahead of the CLI (auto-executor), so it waits synchronously and
  // exits before anything else runs; the grandchild does not inherit that preload.
  const leader = `const fs = require('node:fs');
    const born = Date.now() - Math.round(process.uptime() * 1000);
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    require('node:child_process').spawn(process.execPath, ['-e', ${q(grandchild)}],
      { env, stdio: ['ignore', 'inherit', 'inherit'] }).unref();
    const nap = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(${q(files.ready)})) Atomics.wait(nap, 0, 0, 10);
    fs.writeFileSync(${q(`${files.left}.tmp`)}, JSON.stringify({ pid: process.pid, born, at: Date.now() }));
    fs.renameSync(${q(`${files.left}.tmp`)}, ${q(files.left)});
    process.exit(0);`;
  writeFileSync(files.leader, leader);
  return files;
}

const read = (file, parse) => { try { return parse(readFileSync(file, 'utf8')); } catch { return null; } };
const descendantPid = (files) => read(files.ready, Number);
const leaderLeft = (files) => read(files.left, JSON.parse);

function endDescendant(files) {
  const pid = descendantPid(files);
  if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
}

/**
 * Wait for the run, but no longer than its deadline (from the leader's start), or its stop, plus
 * grace and slack. A run that waits past that is ended by ending the descendant, and reported hung.
 */
async function settle(files, running, { deadlineMs = null, stoppedAt = null, graceMs }) {
  let outcome = null;
  const observe = (result) => {
    const pid = descendantPid(files);
    outcome = { ...result, descendantRunning: pid != null && alive(pid) };
  };
  running.then((value) => observe({ value }), (error) => observe({ error }));
  const capAt = Date.now() + 60_000;
  for (;;) {
    if (outcome) return outcome;
    const left = leaderLeft(files);
    const limit = stoppedAt != null ? stoppedAt + graceMs + SLACK_MS
      : left ? left.born + deadlineMs + graceMs + SLACK_MS : capAt;
    if (Date.now() > limit) break;
    await pause(25);
  }
  endDescendant(files);
  await running.catch(() => {});
  return { hung: true };
}

function assertStopReachedTheDescendant(outcome, runner) {
  assert.equal(outcome.hung, undefined, `${runner} never settled: its stop was skipped because the leader had exited, `
    + 'while a descendant still held the leader\'s output');
  assert.equal(outcome.descendantRunning, false, `a descendant of the stopped ${runner} was still running when it settled`);
}

/** A deadline that comes once the leader left; a deadline that found it still starting is tried longer. */
async function deadlineAfterTheLeaderLeft(runner, graceMs, run, check) {
  for (const deadlineMs of [1_500, 4_000, 10_000]) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-exited-leader-'));
    const files = leaderLeavingADescendant(root);
    try {
      const outcome = await settle(files, run(files, deadlineMs, root), { deadlineMs, graceMs });
      const left = leaderLeft(files);
      if (!left || left.at > left.born + deadlineMs - 200) continue;
      assertStopReachedTheDescendant(outcome, runner);
      await check(outcome, root);
      return;
    } finally {
      endDescendant(files);
      await rm(root, { recursive: true, force: true });
    }
  }
  assert.fail(`the leader never left before the ${runner}'s deadline`);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository(root) {
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Exited Leader Test');
  git(root, 'config', 'user.email', 'exited-leader@example.invalid');
  await writeFile(path.join(root, '.gitattributes'), '* text=auto eol=lf\n');
  await writeFile(path.join(root, 'tracked.txt'), 'before\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  return root;
}

test('an SGOS candidate verifier reaches a descendant holding its output after it exited', posixOnly, async () => {
  const actor = { kind: 'human', id: 'exited-leader@example.invalid' };
  await deadlineAfterTheLeaderLeft('SGOS candidate verifier', 2_000, async (files, deadlineMs, root) => {
    const repo = await repository(path.join(root, 'repository'));
    await publishSgosCandidateVerifierPolicy(repo, { commands: [[process.execPath, files.leader]], timeoutMs: deadlineMs });
    await writeFile(path.join(repo, 'tracked.txt'), 'candidate\n');
    const retained = await freezeSgosCandidate(repo, {
      subjectId: 'exited-leader', createdBy: actor, createdAt: '2026-11-09T00:00:00.000Z'
    });
    return verifySgosCandidate(repo, retained.candidate.candidateId, { verifiedAt: '2026-11-09T00:01:00.000Z' });
  }, ({ value: receipt }) => {
    assert.equal(receipt.status, 'failed');
    assert.equal(receipt.results[0].timedOut, true);
  });
});

test('an Auto Candidate verification command reaches a descendant holding its output after it exited', posixOnly, async () => {
  const flightId = `AFL-${'E'.repeat(26)}`;
  await deadlineAfterTheLeaderLeft('Auto Candidate verification command', 0, async (files, deadlineMs, root) => {
    const repo = await repository(path.join(root, 'repository'));
    const baselineCommit = git(repo, 'rev-parse', 'HEAD');
    await writeFile(path.join(repo, 'tracked.txt'), 'candidate\n');
    const candidate = await freezeAutoCandidate(repo, {
      flightId, attemptId: autoAttemptId({ flightId, phase: 'implementation', attemptNumber: 1 }),
      baselineCommit, executionUnitId: 'copilot-cli'
    });
    return verifyAutoCandidate(repo, candidate, {
      verifiedAt: '2026-11-09T00:01:00.000Z',
      commands: [{ id: 'linger', modelPolicy: 'never', workingDirectory: '.', timeoutMs: deadlineMs, argv: [process.execPath, files.leader] }]
    }).then(() => candidate, (error) => { error.candidate = candidate; throw error; });
  }, async ({ error }, root) => {
    assert.equal(error?.code, 'AUTO_CANDIDATE_VERIFICATION_FAILED');
    const receipt = await readAutoCandidateVerification(path.join(root, 'repository'), {
      flightId, candidateId: error.candidate.candidateId
    });
    assert.equal(receipt.commands[0].timedOut, true);
  });
});

test('an Auto lifecycle step reaches a descendant holding its output after it exited', posixOnly, async () => {
  await deadlineAfterTheLeaderLeft('Auto lifecycle step', 2_000, (files, deadlineMs, root) => childLifecycle(root, ['--version'], {
    timeoutMs: deadlineMs, env: { NODE_OPTIONS: `--require ${q(files.leader)}` }
  }), ({ value }) => {
    // The step itself exited 0 before its deadline; only its descendant had to be stopped.
    assert.equal(value.status, 0);
  });
});

test('a Copilot attachment invocation reaches a descendant holding its output after it exited', posixOnly, async () => {
  await deadlineAfterTheLeaderLeft('Copilot attachment invocation', 250, async (files, deadlineMs, root) => {
    const staged = await stageModelPrompt({ text: 'prompt' }, { tempRoot: root });
    try {
      return await invokeCopilotCli({
        provider: 'copilot-cli', providerConfig: { executable: process.execPath, arguments: [files.leader, '--'] },
        cwd: root,
        prompt: { file: staged.file, sha256: staged.sha256, bytes: staged.bytes, encoding: staged.encoding, staged: true },
        promptTransport: 'attachment', tools: { mode: 'none', names: [] },
        limits: { timeoutMs: deadlineMs, outputBytes: 1024 }
      });
    } finally { await staged.cleanup(); }
  }, ({ error }) => {
    assert.equal(error?.code, 'MODEL_TIMEOUT');
  });
});

test('a generic process Execution Unit stopped after its process exited reaches a descendant holding its output', posixOnly, async () => {
  // Its deadline is whole minutes, so the stop here is a stop request, sent once the leader is gone.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-exited-leader-'));
  const files = leaderLeavingADescendant(root);
  try {
    const manifest = createExecutionUnitManifest({
      id: 'exited-leader-fixture', version: '1.0.0', publisher: 'fixture', provider: 'local', models: [],
      capabilities: { shell: false },
      sandbox: { kind: 'process', enforcement: 'external-attested', attestationSha256: sha256('exited-leader-sandbox') },
      network: { mode: 'deny' }, toolPolicy: { mode: 'none' }, risk: { class: 'low' },
      tests: { conformanceReceiptSha256: sha256('exited-leader-conformance') },
      command: {
        executable: process.execPath, executableSha256: `sha256:${createHash('sha256').update(readFileSync(process.execPath)).digest('hex')}`,
        arguments: [files.leader], environmentAllowlist: []
      }
    });
    const unit = createGenericProcessExecutionUnit(manifest, { root, authorizeManifest: (candidate) => candidate.manifestSha256 });
    const handle = await unit.start(createAgentTaskContract({
      taskId: 'task-1', processId: 'PROC-123456', instructionId: 'instruction-1',
      objective: 'Leave a descendant behind.', acceptanceClauses: ['AC-1'],
      policySnapshotSha256: sha256('policy'), programSha256: sha256('program'),
      inputs: [], readScope: [], writeScope: [], forbiddenScope: ['.git'], allowedDevices: [],
      environmentManifestSha256: sha256('environment'), candidatePolicy: 'immutable-snapshot',
      outputSchema: { type: 'object' }, requiredEvidence: ['candidate-snapshot'],
      budgets: { activeMinutes: 1, modelInvocations: 1, touchedResources: 2 },
      stopConditions: ['scope-expansion'], humanRequestPolicy: {}, subagentPolicy: {},
      rawEvidencePolicy: {}, executionUnitManifestSha256: manifest.manifestSha256
    }));
    const startedAt = Date.now();
    while (!leaderLeft(files) || alive(leaderLeft(files).pid)) {
      assert.ok(Date.now() - startedAt < 30_000, 'the leader never left');
      await pause(20);
    }
    const stoppedAt = Date.now();
    await unit.requestStop(handle, { reason: 'Stop after the process exited.' });
    assertStopReachedTheDescendant(await settle(files, unit.quiesce(handle), { stoppedAt, graceMs: 2_000 }),
      'generic process Execution Unit');
  } finally {
    endDescendant(files);
    await rm(root, { recursive: true, force: true });
  }
});
