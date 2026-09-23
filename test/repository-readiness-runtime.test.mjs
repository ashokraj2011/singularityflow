import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildRepositoryReadinessPlan,
  executeRepositoryReadinessPlan,
  hydrateRepositoryDependencies,
  inspectRepositoryReadinessReceipt,
  loadRepositoryReadinessReceipt,
  resolveRepositoryReadinessCommandLaunch
} from '../src/initialization/runtime-readiness.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';
import { run } from '../src/util.mjs';

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-'));
  const manifest = {
    name: 'readiness-fixture',
    version: '1.0.0',
    private: true,
    packageManager: 'npm@10.8.0',
    scripts: {
      build: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      test: 'node --test',
      start: 'node server.mjs'
    }
  };
  await writeFile(path.join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(root, 'package-lock.json'), `${JSON.stringify({
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: manifest.name, version: manifest.version } }
  }, null, 2)}\n`);
  await writeFile(path.join(root, 'server.mjs'), 'setInterval(() => {}, 1000);\n');
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['config', 'user.name', 'Readiness Test'], { cwd: root });
  run('git', ['config', 'user.email', 'readiness@example.test'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

async function withRepository(callback) {
  const root = await repository();
  try { return await callback(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function repositoryWithoutDependencies() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-readiness-empty-'));
  await writeFile(path.join(root, 'Dockerfile'), 'FROM scratch\n');
  run('git', ['init', '-q'], { cwd: root });
  run('git', ['config', 'user.name', 'Readiness Test'], { cwd: root });
  run('git', ['config', 'user.email', 'readiness@example.test'], { cwd: root });
  run('git', ['add', '.'], { cwd: root });
  run('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

function passingResult(overrides = {}) {
  return {
    status: 'pass', exitCode: 0, signal: null, reason: null, durationMs: 2,
    stdoutBytes: 0, stderrBytes: 0, stdoutSha256: null, stderrSha256: null,
    ...overrides
  };
}

test('repository readiness builds one deterministic, purpose-ordered shell-free plan', async () => {
  await withRepository(async (root) => {
    const first = await buildRepositoryReadinessPlan(root, { startSurvivalMs: 25 });
    const second = await buildRepositoryReadinessPlan(root, { startSurvivalMs: 25 });
    assert.equal(first.planId, second.planId);
    assert.equal(first.scope, 'full');
    assert.match(first.planId, /^sha256:[0-9a-f]{64}$/u);
    assert.deepEqual(first.commands.map((command) => command.purpose), [
      'dependency', 'build', 'quality', 'test', 'start'
    ]);
    assert.deepEqual(first.commands[0].argv, ['npm', 'ci']);
    assert.equal(first.commands.at(-1).mode, 'launch-survival');
    assert.equal(first.commands.at(-1).survivalMs, 25);
    assert.equal(first.structuredTestContract.status, 'available');
    assert.equal(first.structuredTestContract.commands[0].adapter, 'node-tap');
    for (const command of first.commands) {
      assert.ok(Array.isArray(command.argv));
      assert.equal(command.argv.some((argument) => /(?:&&|\|\||;)/u.test(argument)), false);
    }
  });
});

test('readiness resolves Windows npm through its PATH-bound cmd shim', async () => {
  await withRepository(async (root) => {
    const environment = {
      PATH: 'C:\\Program Files\\nodejs', PATHEXT: '.EXE;.CMD',
      SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      CI: '1', GIT_TERMINAL_PROMPT: '0'
    };
    const lookups = [];
    const command = {
      id: 'dependency-node-root', purpose: 'dependency',
      argv: ['npm', 'ci'], workingDirectory: '.', mode: 'completion'
    };
    const launch = resolveRepositoryReadinessCommandLaunch(command, {
      cwd: path.resolve(root), platform: 'win32', environment,
      resolveProcess(logicalCommand, logicalArguments, options) {
        return resolvePlatformProcess(logicalCommand, logicalArguments, {
          ...options,
          spawnSyncCommand(executable, args, spawnOptions) {
            lookups.push({ executable, args, options: spawnOptions });
            return {
              status: 0,
              stdout: '.\\npm.cmd\r\nC:\\Program Files\\nodejs\\npm.cmd\r\n'
            };
          }
        });
      }
    });

    assert.deepEqual(command.argv, ['npm', 'ci'], 'the receipt-facing logical argv stays unchanged');
    assert.equal(lookups.length, 1);
    assert.equal(lookups[0].executable, 'C:\\Windows\\System32\\where.exe');
    assert.deepEqual(lookups[0].args, ['$PATH:npm.cmd']);
    assert.equal(lookups[0].options.cwd, 'C:\\Windows\\System32');
    assert.equal(launch.executable, environment.ComSpec);
    assert.deepEqual(launch.arguments.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
    assert.match(launch.arguments[4], /Program.*npm\.cmd/u);
    assert.deepEqual(launch.spawnOptions, { shell: false, windowsVerbatimArguments: true });
  });
});

test('readiness resolves repository wrappers with the exact cwd and fails closed', async () => {
  await withRepository(async (root) => {
    const command = {
      id: 'dependency-maven-root', purpose: 'dependency',
      argv: ['.\\mvnw.cmd', '--batch-mode', 'dependency:go-offline'],
      workingDirectory: '.', mode: 'completion'
    };
    const expectedArguments = ['/d', '/s', '/v:off', '/c', 'fixture-wrapper-command'];
    let resolved = null;
    const launch = resolveRepositoryReadinessCommandLaunch(command, {
      cwd: path.resolve(root), platform: 'win32', environment: { SystemRoot: 'C:\\Windows' },
      resolveProcess(logicalCommand, logicalArguments, options) {
        resolved = { logicalCommand, logicalArguments, options };
        return {
          executable: 'C:\\Windows\\System32\\cmd.exe',
          arguments: expectedArguments,
          spawnOptions: { shell: false, windowsVerbatimArguments: true }
        };
      }
    });
    assert.equal(resolved.logicalCommand, '.\\mvnw.cmd');
    assert.deepEqual(resolved.logicalArguments, command.argv.slice(1));
    assert.equal(resolved.options.cwd, path.resolve(root));
    assert.equal(resolved.options.platform, 'win32');
    assert.equal(launch.executable, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(launch.arguments, expectedArguments);
    assert.equal(launch.spawnOptions.windowsVerbatimArguments, true);

    assert.throws(
      () => resolveRepositoryReadinessCommandLaunch(command, {
        cwd: path.resolve(root), platform: 'win32', environment: { SystemRoot: 'C:\\Windows' },
        resolveProcess() { throw new TypeError('fixture wrapper escaped its verified cwd'); }
      }),
      /escaped its verified cwd/u
    );
  });
});

test('dependency-test readiness includes only dependency and structured test commands', async () => {
  await withRepository(async (root) => {
    const detectorOutput = {
      commands: {
        dependency: [{ id: 'detector-dependency', launcher: 'npm', args: ['ci'], workingDirectory: '.' }],
        build: [{ id: 'detector-build', launcher: 'npm', args: ['run', 'build'], workingDirectory: '.' }],
        quality: [{ id: 'detector-quality', launcher: 'npm', args: ['run', 'lint'], workingDirectory: '.' }],
        verification: [{ id: 'detector-verification', launcher: 'npm', args: ['test'], workingDirectory: '.' }],
        start: [{ id: 'detector-start', launcher: 'npm', args: ['start'], workingDirectory: '.' }]
      },
      stacks: ['node'],
      ambiguities: [
        { id: 'dependency-choice', purpose: 'verify' },
        { id: 'build-choice', purpose: 'build' },
        { id: 'quality-choice', purpose: 'quality' },
        { id: 'start-choice', purpose: 'start' }
      ]
    };
    const inferTestCommands = async () => [{
      id: 'structured-unit', argv: ['node', '--test'], workingDirectory: '.',
      affectedRoots: ['.'], result: { adapter: 'node-tap' }
    }];
    const scoped = await buildRepositoryReadinessPlan(root, {
      scope: 'dependency-test', detectorOutput, inferTestCommands
    });
    const full = await buildRepositoryReadinessPlan(root, { detectorOutput, inferTestCommands });

    assert.equal(scoped.scope, 'dependency-test');
    assert.notEqual(scoped.planId, full.planId);
    assert.deepEqual(scoped.commands.map((command) => [command.id, command.purpose, command.source]), [
      ['detector-dependency', 'dependency', 'smart-init-detector'],
      ['structured-unit', 'test', 'structured-test-inference']
    ]);
    assert.deepEqual(scoped.ambiguities.map((ambiguity) => ambiguity.id), ['dependency-choice']);
    assert.deepEqual(scoped.blockers.map((blocker) => blocker.subject), ['dependency-choice']);
  });
});

test('dependency-test readiness selects a dedicated unit script instead of a composite browser suite', async () => {
  await withRepository(async (root) => {
    const manifestFile = path.join(root, 'package.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.scripts.test = 'node --test && playwright test';
    manifest.scripts['test:unit'] = 'node --test';
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    run('git', ['add', 'package.json'], { cwd: root });
    run('git', ['commit', '-qm', 'add explicit unit suite'], { cwd: root });

    const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    const tests = plan.commands.filter((command) => command.purpose === 'test');
    assert.equal(plan.status, 'ready');
    assert.deepEqual(tests.map((command) => command.argv), [['npm', 'run', 'test:unit']]);
    assert.equal(tests.some((command) => command.argv.some((argument) => /playwright/iu.test(argument))), false);
  });
});

test('dependency-test readiness refuses a composite browser suite when no unit-only command exists', async () => {
  await withRepository(async (root) => {
    const manifestFile = path.join(root, 'package.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    manifest.scripts.test = 'node --test && playwright test';
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    run('git', ['add', 'package.json'], { cwd: root });
    run('git', ['commit', '-qm', 'use composite test suite'], { cwd: root });

    const plan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    assert.equal(plan.commands.some((command) => command.purpose === 'test'), false);
    assert.equal(plan.structuredTestContract.status, 'missing');
    assert.ok(plan.blockers.some((blocker) =>
      blocker.code === 'REPOSITORY_READINESS_STRUCTURED_TEST_REQUIRED'));
  });
});

test('repository readiness consumes detector-provided dependency and start commands', async () => {
  await withRepository(async (root) => {
    const detectorOutput = {
      commands: {
        dependency: [{ id: 'detector-dependency', launcher: 'node', args: ['--version'], workingDirectory: '.' }],
        build: [], quality: [], verification: [],
        start: [{ id: 'detector-start', launcher: 'node', args: ['server.mjs'], workingDirectory: '.' }]
      },
      stacks: [], ambiguities: []
    };
    const plan = await buildRepositoryReadinessPlan(root, {
      detectorOutput,
      inferTestCommands: async () => [],
      startSurvivalMs: 25
    });
    assert.equal(plan.commands.some((command) => command.id === 'detector-dependency'), true);
    assert.equal(plan.commands.some((command) => command.id === 'detector-start'
      && command.mode === 'launch-survival'), true);
  });
});

test('repository readiness preserves detector ambiguity and refuses execution', async () => {
  await withRepository(async (root) => {
    const detectorOutput = {
      commands: { dependency: [], build: [], quality: [], verification: [], start: [] },
      stacks: [],
      ambiguities: [{ id: 'package-manager:root', candidates: ['npm', 'yarn'], reason: 'two locks' }]
    };
    const options = { detectorOutput, inferTestCommands: async () => [] };
    const plan = await buildRepositoryReadinessPlan(root, options);
    assert.equal(plan.status, 'blocked');
    assert.deepEqual(plan.ambiguities, detectorOutput.ambiguities);
    await assert.rejects(
      () => executeRepositoryReadinessPlan(root, {
        confirmation: plan.planId,
        runCommand: async () => assert.fail('blocked plan must not run a command'),
        ...options
      }),
      (error) => error.code === 'REPOSITORY_READINESS_PLAN_BLOCKED'
        && error.details.blockers[0].code === 'REPOSITORY_READINESS_DETECTION_AMBIGUOUS'
    );
  });
});

test('a code repository cannot pass on an exit-code-only fallback when structured tests are absent', async () => {
  await withRepository(async (root) => {
    const options = { inferTestCommands: async () => [] };
    const plan = await buildRepositoryReadinessPlan(root, options);
    assert.equal(plan.structuredTestContract.status, 'missing');
    assert.equal(plan.structuredTestContract.requiredForCode, true);
    assert.equal(plan.structuredTestContract.satisfied, false);
    assert.equal(plan.commands.some((command) => command.purpose === 'test'), true);
    await assert.rejects(
      () => executeRepositoryReadinessPlan(root, {
        confirmation: plan.planId,
        runCommand: async () => assert.fail('unstructured fallback must not run'),
        ...options
      }),
      (error) => error.code === 'REPOSITORY_READINESS_PLAN_BLOCKED'
        && error.details.blockers.some((blocker) =>
          blocker.code === 'REPOSITORY_READINESS_STRUCTURED_TEST_REQUIRED')
    );
  });
});

test('repository readiness requires the exact current plan digest', async () => {
  await withRepository(async (root) => {
    await assert.rejects(
      () => executeRepositoryReadinessPlan(root, {
        confirmation: 'sha256:'.padEnd(71, '0'),
        runCommand: async () => passingResult()
      }),
      (error) => error.code === 'REPOSITORY_READINESS_CONFIRMATION_MISMATCH'
        && /^sha256:[0-9a-f]{64}$/u.test(error.details.required)
    );
  });
});

test('successful readiness writes and validates a Git-private receipt bound to HEAD and the plan', async () => {
  await withRepository(async (root) => {
    const plan = await buildRepositoryReadinessPlan(root, { startSurvivalMs: 25 });
    const observed = [];
    const outcome = await executeRepositoryReadinessPlan(root, {
      confirmation: plan.planId,
      startSurvivalMs: 25,
      now: () => 1_700_000_000_000,
      runCommand: async (command) => {
        observed.push({ id: command.id, purpose: command.purpose, mode: command.mode });
        return passingResult();
      }
    });
    assert.deepEqual(observed.map((entry) => entry.purpose), [
      'dependency', 'build', 'quality', 'test', 'start'
    ]);
    assert.equal(observed.at(-1).mode, 'launch-survival');
    assert.equal(outcome.receipt.status, 'pass');
    assert.equal(outcome.receipt.scope, 'full');
    assert.equal(outcome.receipt.planId, plan.planId);
    assert.equal(outcome.receipt.sourceCommit, plan.sourceCommit);
    assert.equal(outcome.receipt.sourceManifestSha256, plan.sourceManifestSha256);
    assert.match(outcome.receipt.receiptSha256, /^sha256:[0-9a-f]{64}$/u);
    assert.match(outcome.file, new RegExp(`${plan.sourceCommit}-.+\\.json$`, 'u'));
    assert.equal(outcome.file.startsWith(path.join(root, '.git')), true);
    const loaded = await loadRepositoryReadinessReceipt(root, { commit: plan.sourceCommit });
    assert.equal(loaded.receipt.receiptSha256, outcome.receipt.receiptSha256);
    assert.deepEqual(await inspectRepositoryReadinessReceipt(root, { commit: plan.sourceCommit }), {
      status: 'pass', receipt: outcome.receipt, file: outcome.file, reasons: []
    });
    const bytes = await readFile(outcome.file, 'utf8');
    assert.doesNotMatch(bytes, /node --test|node server|npm ci/u);
  });
});

test('dependency-test readiness writes a separate scoped receipt without replacing full evidence', async () => {
  await withRepository(async (root) => {
    const runCommand = async () => passingResult();
    const fullPlan = await buildRepositoryReadinessPlan(root);
    const full = await executeRepositoryReadinessPlan(root, {
      confirmation: fullPlan.planId, runCommand
    });
    const fullBytes = await readFile(full.file, 'utf8');
    const scopedPlan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    const scoped = await executeRepositoryReadinessPlan(root, {
      scope: 'dependency-test', confirmation: scopedPlan.planId, runCommand
    });

    assert.equal(scoped.receipt.scope, 'dependency-test');
    assert.notEqual(scoped.file, full.file);
    assert.match(scoped.file, /-dependency-test\.json$/u);
    assert.equal(await readFile(full.file, 'utf8'), fullBytes);
    assert.equal((await loadRepositoryReadinessReceipt(root)).receipt.receiptSha256,
      full.receipt.receiptSha256);
    assert.equal((await loadRepositoryReadinessReceipt(root, { scope: 'dependency-test' }))
      .receipt.receiptSha256, scoped.receipt.receiptSha256);
    assert.equal((await inspectRepositoryReadinessReceipt(root, { scope: 'dependency-test' })).status,
      'pass');
  });
});

test('dependency-test consumers may safely fall back to full receipts, never the reverse', async () => {
  await withRepository(async (root) => {
    const fullPlan = await buildRepositoryReadinessPlan(root);
    const full = await executeRepositoryReadinessPlan(root, {
      confirmation: fullPlan.planId, runCommand: async () => passingResult()
    });
    const fallback = await loadRepositoryReadinessReceipt(root, { scope: 'dependency-test' });
    assert.equal(fallback.file, full.file);
    assert.equal(fallback.receipt.scope, 'full');
    assert.equal((await inspectRepositoryReadinessReceipt(root, { scope: 'dependency-test' })).status,
      'pass');
    assert.equal((await hydrateRepositoryDependencies(root, {
      scope: 'dependency-test', runCommand: async () => passingResult()
    })).status, 'pass');
  });

  await withRepository(async (root) => {
    const scopedPlan = await buildRepositoryReadinessPlan(root, { scope: 'dependency-test' });
    await executeRepositoryReadinessPlan(root, {
      scope: 'dependency-test', confirmation: scopedPlan.planId,
      runCommand: async () => passingResult()
    });
    assert.equal(await loadRepositoryReadinessReceipt(root), null);
    assert.equal((await inspectRepositoryReadinessReceipt(root)).status, 'missing');
  });
});

test('readiness refuses command-created source drift and never writes a passing receipt', async () => {
  await withRepository(async (root) => {
    const plan = await buildRepositoryReadinessPlan(root);
    await assert.rejects(
      () => executeRepositoryReadinessPlan(root, {
        confirmation: plan.planId,
        runCommand: async () => {
          await writeFile(path.join(root, 'unexpected.txt'), 'drift\n');
          return passingResult();
        }
      }),
      (error) => error.code === 'REPOSITORY_READINESS_SOURCE_DRIFT'
        && error.details.untrackedChanged === true
    );
    assert.equal(await loadRepositoryReadinessReceipt(root, { commit: plan.sourceCommit }), null);
  });
});

test('readiness refuses a dirty tracked tree before planning or execution', async () => {
  await withRepository(async (root) => {
    await writeFile(path.join(root, 'server.mjs'), 'throw new Error("dirty");\n');
    await assert.rejects(
      () => buildRepositoryReadinessPlan(root),
      (error) => error.code === 'REPOSITORY_READINESS_TRACKED_DIRTY'
        && error.details.changedPaths.includes('server.mjs')
    );
  });
});

test('a source-manifest mismatch makes an otherwise intact receipt stale', async () => {
  await withRepository(async (root) => {
    const plan = await buildRepositoryReadinessPlan(root);
    await executeRepositoryReadinessPlan(root, {
      confirmation: plan.planId,
      runCommand: async () => passingResult()
    });
    const inspection = await inspectRepositoryReadinessReceipt(root, {
      commit: plan.sourceCommit,
      sourceManifestSha256: 'sha256:'.padEnd(71, 'f'),
      recompute: false
    });
    assert.equal(inspection.status, 'stale');
    assert.deepEqual(inspection.reasons, ['source-manifest-mismatch']);
  });
});

test('the built-in runner proves launch survival and then quiesces the start process tree', async () => {
  await withRepository(async (root) => {
    const options = {
      startSurvivalMs: 100,
      timeouts: { dependency: 10_000, build: 10_000, quality: 10_000, test: 10_000, start: 5_000 }
    };
    const plan = await buildRepositoryReadinessPlan(root, options);
    const outcome = await executeRepositoryReadinessPlan(root, {
      confirmation: plan.planId,
      ...options
    });
    const start = outcome.receipt.commandResults.find((result) => result.purpose === 'start');
    assert.equal(start.status, 'pass');
    assert.equal(start.reason, 'launch-survived');
    assert.equal((await inspectRepositoryReadinessReceipt(root)).status, 'pass');
  });
});

test('worktree hydration replays only exact receipt-bound dependency commands without rewriting the receipt', async () => {
  await withRepository(async (root) => {
    const plan = await buildRepositoryReadinessPlan(root);
    const readiness = await executeRepositoryReadinessPlan(root, {
      confirmation: plan.planId,
      runCommand: async () => passingResult()
    });
    const receiptBefore = await readFile(readiness.file, 'utf8');
    const observed = [];
    const hydration = await hydrateRepositoryDependencies(root, {
      required: true,
      runCommand: async (command) => {
        observed.push(command);
        return passingResult({ stdoutBytes: 19, stdoutSha256: `sha256:${'a'.repeat(64)}` });
      }
    });
    assert.equal(hydration.status, 'pass');
    assert.equal(hydration.planId, plan.planId);
    assert.deepEqual(observed.map((command) => command.purpose), ['dependency']);
    assert.equal(Object.hasOwn(hydration.commandResults[0], 'argv'), false);
    assert.equal(hydration.commandResults[0].stdoutBytes, 19);
    assert.equal(await readFile(readiness.file, 'utf8'), receiptBefore);
  });
});

test('optional hydration skips a missing receipt while required hydration refuses it', async () => {
  await withRepository(async (root) => {
    assert.deepEqual(await hydrateRepositoryDependencies(root), {
      status: 'skipped', reason: 'receipt-missing',
      sourceCommit: run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim(),
      planId: null, commandResults: []
    });
    await assert.rejects(
      () => hydrateRepositoryDependencies(root, { required: true }),
      (error) => error.code === 'REPOSITORY_READINESS_RECEIPT_REQUIRED'
    );
  });
});

test('required hydration refuses an exact passing plan with no dependency command', async () => {
  const root = await repositoryWithoutDependencies();
  try {
    const plan = await buildRepositoryReadinessPlan(root);
    assert.deepEqual(plan.commands, []);
    await executeRepositoryReadinessPlan(root, {
      confirmation: plan.planId,
      runCommand: async () => assert.fail('empty plan must not execute commands')
    });
    assert.deepEqual(await hydrateRepositoryDependencies(root), {
      status: 'skipped', reason: 'no-dependency-commands',
      sourceCommit: plan.sourceCommit, planId: plan.planId, commandResults: []
    });
    await assert.rejects(
      () => hydrateRepositoryDependencies(root, { required: true }),
      (error) => error.code === 'REPOSITORY_READINESS_DEPENDENCY_REQUIRED'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydration refuses a plan whose source manifest changed after the readiness receipt', async () => {
  await withRepository(async (root) => {
    const plan = await buildRepositoryReadinessPlan(root);
    await executeRepositoryReadinessPlan(root, {
      confirmation: plan.planId,
      runCommand: async () => passingResult()
    });
    await writeFile(path.join(root, 'yarn.lock'), '# later, non-ignored detector input\n');
    await assert.rejects(
      () => hydrateRepositoryDependencies(root, {
        runCommand: async () => assert.fail('stale plan must not run dependency commands')
      }),
      (error) => error.code === 'REPOSITORY_READINESS_HYDRATION_STALE'
        && error.details.sourceManifestMatches === false
    );
  });
});

test('hydration refuses source drift caused by a dependency command', async () => {
  await withRepository(async (root) => {
    const plan = await buildRepositoryReadinessPlan(root);
    await executeRepositoryReadinessPlan(root, {
      confirmation: plan.planId,
      runCommand: async () => passingResult()
    });
    await assert.rejects(
      () => hydrateRepositoryDependencies(root, {
        runCommand: async () => {
          await writeFile(path.join(root, 'dependency-drift.txt'), 'not ignored\n');
          return passingResult();
        }
      }),
      (error) => error.code === 'REPOSITORY_READINESS_SOURCE_DRIFT'
        && error.details.untrackedChanged === true
    );
  });
});
