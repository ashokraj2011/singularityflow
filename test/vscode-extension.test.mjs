/**
 * The extension's CLI and snapshot layers, exercised directly from TypeScript.
 *
 * `node --experimental-strip-types` runs the sources as-is, so these test the code that actually
 * ships rather than a bundle built by a step that could itself be wrong. That is only possible
 * because apps/vscode/src avoids the TypeScript syntax that needs real transformation — see the note
 * in runner.ts. If someone adds an enum or a parameter property, these tests fail loudly at import,
 * which is the intended alarm.
 *
 * The snapshot fixture uses the compatibility snapshot shape, trimmed to the regions the extension
 * types. Its value is that it was produced by the engine: a hand-written fixture only proves the
 * accessors agree with my reading of editor.mjs, which is the thing most likely to be wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../src/util.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => path.join(packageRoot, 'apps', 'vscode', 'src', name);

const {
  invokeCli, CliError, CliTimeoutError, terminalCommand, validateRepositoryDirectory,
  UninitializedRepositoryError, RepositoryAuthorityUnavailableError
} =
  await import(source('cli/runner.ts'));
const { resolveCli, SingularityFlowClient, commandClass } = await import(source('cli/client.ts'));
const { phasesInOrder, packsWithMembers, storiesByRepository, isApprovalPinned } =
  await import(source('cli/snapshot.ts'));

const snapshot = JSON.parse(await readFile(
  path.join(packageRoot, 'apps', 'vscode', 'test', 'fixtures', 'snapshot-initiative-lite.json'), 'utf8'));

/** A child process that emits exactly what a test wants, without spawning anything. */
function fakeSpawn({ stdout = '', stderr = '', code = 0, delayMs = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {} };
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
      child.emit('close', code);
    };
    const timer = setTimeout(close, delayMs);
    child.kill = () => { child.killed = true; clearTimeout(timer); setTimeout(close, 10); return true; };
    return child;
  };
}

const invoke = (overrides) => invokeCli({
  executable: 'node', cli: '/cli.mjs', repository: '/repo', args: ['x'], ...overrides
});

test('a successful run resolves the parsed JSON', async () => {
  const result = await invoke({ spawnImpl: fakeSpawn({ stdout: '{"ready":true,"errors":[]}' }) });
  assert.deepEqual(result, { ready: true, errors: [] });
});

test('VS Code classifies configuration publication as a mutation', () => {
  assert.equal(commandClass(['configuration', 'snapshot']), 'read');
  assert.equal(commandClass(['configuration', 'validate']), 'read');
  assert.equal(commandClass(['configuration', 'save', 'singularity/workflow.yml']), 'mutation');
  assert.equal(commandClass(['configuration', 'publish', '--json']), 'mutation');
  assert.equal(commandClass(['configuration', 'portfolio-bootstrap']), 'mutation');
  assert.equal(commandClass(['recover', 'WORK-1', '--phase', 'implementation', '--json']), 'read');
  assert.equal(commandClass(['recover', 'WORK-1', '--apply', '--confirm', 'sha256:plan']), 'mutation');
  assert.equal(commandClass(['workspace', 'refresh-configuration', '/work/a', '--dry-run']), 'read');
  assert.equal(commandClass(['workspace', 'refresh-configuration', '/work/a', '--confirm-plan', 'cfgp-1']), 'mutation');
});

test('VS Code command audit classification follows mixed read and mutation subcommands', () => {
  assert.equal(commandClass(['report', 'WORK-1']), 'read');
  assert.equal(commandClass(['report', 'WORK-1', '--out', 'report.html']), 'mutation');
  assert.equal(commandClass(['report', 'WORK-1', '--out=report.html']), 'mutation');
  assert.equal(commandClass(['review', 'intake']), 'read');
  assert.equal(commandClass(['review', 'intake', '--out', 'review.md']), 'mutation');
  assert.equal(commandClass(['telemetry', 'status']), 'read');
  assert.equal(commandClass(['telemetry', 'reconcile', 'design']), 'mutation');
  assert.equal(commandClass(['help-metrics', 'status', '--json']), 'read');
  assert.equal(commandClass(['help-metrics', 'off']), 'mutation');
  assert.equal(commandClass(['help-metrics', 'clear']), 'mutation');
  assert.equal(commandClass(['inputs', 'design']), 'mutation');
  assert.equal(commandClass(['inputs', 'design', '--dry-run']), 'read');
  assert.equal(commandClass(['inputs', 'design', '--dry-run=true']), 'read');
  assert.equal(commandClass(['inputs', 'design', '--dry-run=false']), 'mutation');
  assert.equal(commandClass(['inputs', 'design', '--no-dry-run']), 'mutation');
  assert.equal(commandClass(['spec', 'trace']), 'read');
  assert.equal(commandClass(['spec', 'coverage']), 'read');
  assert.equal(commandClass(['spec', 'claims', 'planned', '--file', 'claims.yml']), 'mutation');
  assert.equal(commandClass(['spec', 'index', '--dry-run']), 'read');
  assert.equal(commandClass(['spec', 'index', '--dry-run=true']), 'read');
  assert.equal(commandClass(['spec', 'acceptance']), 'mutation');
  assert.equal(commandClass(['visual', 'status']), 'read');
  assert.equal(commandClass(['visual', 'compare', '--expected', 'a', '--actual', 'b']), 'mutation');
  assert.equal(commandClass(['session', 'current', '--json']), 'read');
  assert.equal(commandClass(['session', 'doctor', '--json']), 'read');
  assert.equal(commandClass(['session', 'attach', 'CFA-STORY', '--json']), 'mutation');
  assert.equal(commandClass(['session', 'repair-selection', 'CFA-STORY']), 'mutation');
});

test('every VS Code CLI completion reports one privacy-safe timing envelope', async () => {
  const events = [];
  await invoke({
    args: ['status', 'SECRET-WORK-ID', '--json'],
    commandClass: 'read',
    onTiming: (event) => events.push(event),
    spawnImpl: fakeSpawn({ stdout: '{"ready":true}' })
  });
  assert.equal(events.length, 1);
  assert.deepEqual(
    {
      schemaVersion: events[0].schemaVersion,
      event: events[0].event,
      command: events[0].command,
      commandClass: events[0].commandClass,
      outcome: events[0].outcome,
      cancelled: events[0].cancelled,
      fallback: events[0].fallback
    },
    {
      schemaVersion: 2,
      event: 'dx.vscode-command-timing',
      command: 'status',
      commandClass: 'read',
      outcome: 'success',
      cancelled: false,
      fallback: 'none'
    }
  );
  assert.equal(typeof events[0].durationMs, 'number');
  assert.equal(typeof events[0].stages.spawnMs, 'number');
  assert.doesNotMatch(JSON.stringify(events[0]), /SECRET-WORK-ID/);
});

test('VS Code CLI errors and cancellations are distinguishable in timing diagnostics', async () => {
  const failed = [];
  await assert.rejects(invoke({
    onTiming: (event) => failed.push(event),
    spawnImpl: fakeSpawn({ stderr: 'Singularity Flow error: refused', code: 1 })
  }), /refused/);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].outcome, 'error');
  assert.equal(failed[0].cancelled, false);

  const cancelled = [];
  const controller = new AbortController();
  const pending = invoke({
    signal: controller.signal,
    onTiming: (event) => cancelled.push(event),
    spawnImpl: fakeSpawn({ stdout: '{}', delayMs: 5_000 })
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].outcome, 'cancelled');
  assert.equal(cancelled[0].cancelled, true);
});

test('a non-zero exit rejects with the CLI message, stripped of its prefix', async () => {
  // The CLI's own wording is already written for a human; rewording it here would lose the remedy
  // the engine deliberately names.
  await assert.rejects(
    invoke({ spawnImpl: fakeSpawn({ stderr: "Singularity Flow error: Phase 'define' is not ready.", code: 1 }) }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.message, "Phase 'define' is not ready.");
      assert.equal(error.exitCode, 1);
      return true;
    }
  );
});

test('a structured non-zero result remains available without turning JSON into the error message', async () => {
  await assert.rejects(
    invoke({ spawnImpl: fakeSpawn({
      stdout: '{"status":"partial","results":[{"repository":"api","status":"review-required"}]}',
      code: 2
    }) }),
    (error) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.message, 'The Singularity Flow command reported partial.');
      assert.equal(error.result.status, 'partial');
      assert.equal(error.result.results[0].repository, 'api');
      return true;
    }
  );
});

test('output that is not JSON rejects rather than resolving undefined', async () => {
  // Resolving a bad parse would render an empty governance view as though it were the truth.
  await assert.rejects(
    invoke({ spawnImpl: fakeSpawn({ stdout: 'Prepared 3 define documents' }) }),
    /could not read/
  );
});

test('--json can be turned off for commands that print prose', async () => {
  const result = await invoke({ json: false, spawnImpl: fakeSpawn({ stdout: '  Prepared 3 documents\n' }) });
  assert.deepEqual(result, { output: 'Prepared 3 documents' });
});

test('a run that exceeds its timeout is killed and reports the timeout', async () => {
  await assert.rejects(
    invoke({
      repository: "/work/Rule Engine's UI",
      args: ['start', 'WRK-17', '--title', 'Fix $HOME and `checkout`'],
      timeoutMs: 20,
      spawnImpl: fakeSpawn({ stdout: '{}', delayMs: 5_000 })
    }),
    (error) => {
      assert.ok(error instanceof CliTimeoutError);
      assert.match(error.message, /did not finish within 1 seconds/);
      assert.match(error.message, /Run this exact command from a terminal/);
      assert.equal(error.terminalCommand, terminalCommand(
        "/work/Rule Engine's UI",
        ['start', 'WRK-17', '--title', 'Fix $HOME and `checkout`']
      ));
      assert.match(error.terminalCommand, /singularity-flow/);
      assert.match(error.terminalCommand, /WRK-17/);
      return true;
    }
  );
});

test('terminal timeout recovery is safely quoted for POSIX and PowerShell', () => {
  assert.equal(
    terminalCommand("/work/Rule Engine's UI", ['start', 'WRK-17', '--title', 'Fix $HOME'], 'darwin'),
    "cd '/work/Rule Engine'\"'\"'s UI' && 'singularity-flow' 'start' 'WRK-17' '--title' 'Fix $HOME'"
  );
  assert.equal(
    terminalCommand("C:\\Rule Engine's UI", ['start', 'WRK-17', '--title', 'Fix $HOME'], 'win32'),
    "Set-Location -LiteralPath 'C:\\Rule Engine''s UI'; & 'singularity-flow' 'start' 'WRK-17' '--title' 'Fix $HOME'"
  );
});

test('an aborted run is killed and reports cancellation', async () => {
  const controller = new AbortController();
  const pending = invoke({ signal: controller.signal, spawnImpl: fakeSpawn({ stdout: '{}', delayMs: 5_000 }) });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('a signal already aborted never spawns anything', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;
  await assert.rejects(
    invoke({ signal: controller.signal, spawnImpl: () => { spawned = true; return new EventEmitter(); } }),
    /cancelled/
  );
  assert.equal(spawned, false);
});

test('a progress observer that throws does not take the command down', async () => {
  const result = await invoke({
    onOutput: () => { throw new Error('observer exploded'); },
    spawnImpl: fakeSpawn({ stdout: '{"ok":true}' })
  });
  assert.deepEqual(result, { ok: true });
});

test('progress is reported per stream as it arrives', async () => {
  const seen = [];
  await invoke({
    onOutput: (text, stream) => seen.push([stream, text.trim()]),
    spawnImpl: fakeSpawn({ stdout: '{"ok":true}', stderr: 'building world model' })
  });
  assert.deepEqual(seen, [['stdout', '{"ok":true}'], ['stderr', 'building world model']]);
});

test('VS Code preserves UTF-8 split across CLI output chunks', async () => {
  const value = JSON.stringify({ message: 'नमस्ते 🌍' });
  const bytes = Buffer.from(value);
  const splitSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end() {} }; child.kill = () => true;
    setTimeout(() => {
      child.stdout.emit('data', bytes.subarray(0, bytes.indexOf(Buffer.from('नमस्ते')) + 2));
      child.stdout.emit('data', bytes.subarray(bytes.indexOf(Buffer.from('नमस्ते')) + 2));
      child.emit('close', 0);
    }, 0);
    return child;
  };
  assert.deepEqual(await invoke({ spawnImpl: splitSpawn }), { message: 'नमस्ते 🌍' });
});

/** A Git repository that has actually been initialized with Singularity Flow. */
async function initializedRepository() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-'));
  const root = path.join(base, 'app');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'version: 1\n');
  return { base, root };
}

test('an initialized repository root validates and resolves to its canonical path', async () => {
  const { root } = await initializedRepository();
  assert.equal(await validateRepositoryDirectory(root), await realpath(root));
});

test('a Git repository without Singularity Flow is refused, naming the remedy', async () => {
  // The product's own repository hits this too: being a Git repo is not the same as using the tool.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-bare-'));
  const root = path.join(base, 'plain');
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  await assert.rejects(validateRepositoryDirectory(root), (error) => {
    assert.ok(error instanceof UninitializedRepositoryError);
    assert.match(error.message, /singularity\/workflow\.yml/);
    assert.match(error.message, /singularity-flow init/);
    return true;
  });
});

test('an unreadable governed remote is unavailable, never misreported as uninitialized', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-authority-unavailable-'));
  const root = path.join(base, 'plain');
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  run('git', ['remote', 'add', 'origin', 'https://example.invalid/application.git'], { cwd: root });
  const calls = [];
  const remoteRunner = async (args, options) => {
    calls.push({ args, signal: options.signal });
    return { status: null, stdout: '', failure: 'timeout' };
  };
  await assert.rejects(
    validateRepositoryDirectory(root, { remoteRunner }),
    (error) => {
      assert.ok(error instanceof RepositoryAuthorityUnavailableError);
      assert.equal(error.code, 'SINGULARITY_FLOW_AUTHORITY_UNAVAILABLE');
      assert.match(error.message, /network and Git credentials/);
      assert.equal(error.failures[0].operation, 'ls-remote');
      assert.equal(error.failures[0].reason, 'timeout');
      return true;
    }
  );
  assert.equal(calls.length, 1);
});

test('an advertised authority that cannot be fetched remains unavailable', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-authority-fetch-'));
  const root = path.join(base, 'plain');
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  run('git', ['remote', 'add', 'origin', 'https://example.invalid/application.git'], { cwd: root });
  let calls = 0;
  const remoteRunner = async (args) => {
    calls += 1;
    if (args[0] === 'ls-remote') {
      return { status: 0, stdout: `${'a'.repeat(40)}\trefs/heads/sflow/config\n`, failure: null };
    }
    return { status: null, stdout: '', failure: 'output-overflow' };
  };
  await assert.rejects(validateRepositoryDirectory(root, { remoteRunner }), (error) => {
    assert.ok(error instanceof RepositoryAuthorityUnavailableError);
    assert.ok(error.failures.some((entry) => entry.operation === 'fetch' && entry.reason === 'output-overflow'));
    return true;
  });
  assert.equal(calls, 2);
});

test('responsive remotes that advertise no governed authority remain truly uninitialized', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-no-authority-'));
  const root = path.join(base, 'plain');
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  run('git', ['remote', 'add', 'origin', 'https://example.invalid/application.git'], { cwd: root });
  await assert.rejects(
    validateRepositoryDirectory(root, {
      remoteRunner: async () => ({ status: 0, stdout: '', failure: null })
    }),
    (error) => error instanceof UninitializedRepositoryError
  );
});

test('a configuration-free application branch validates through a hash-bound state mirror', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-state-'));
  const root = path.join(base, 'app');
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main', root], { cwd: base });
  run('git', ['config', 'user.name', 'State Mirror Tester'], { cwd: root });
  run('git', ['config', 'user.email', 'state@example.test'], { cwd: root });
  await writeFile(path.join(root, 'README.md'), '# Application\n');
  run('git', ['add', 'README.md'], { cwd: root });
  run('git', ['commit', '-qm', 'Application'], { cwd: root });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root }).stdout.trim();
  run('git', ['switch', '-q', '--orphan', 'state'], { cwd: root });
  const workflow = 'version: 2\n';
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await mkdir(path.join(root, 'configuration'), { recursive: true });
  await writeFile(path.join(root, 'singularity/workflow.yml'), workflow);
  await writeFile(path.join(root, 'configuration/manifest.json'), `${JSON.stringify({
    format: 'singularity-flow-configuration-mirror/v2',
    layout: 'canonical-paths',
    source: { branch: 'sflow/config', commit: sourceCommit },
    files: {
      'singularity/workflow.yml': createHash('sha256').update(workflow).digest('hex')
    }
  }, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: root });
  run('git', ['commit', '-qm', 'Verified state configuration mirror'], { cwd: root });
  run('git', ['switch', '-q', 'main'], { cwd: root });

  assert.equal(await validateRepositoryDirectory(root), await realpath(root));
});

test('repository validation refreshes a verified state authority for a narrow clone', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-narrow-state-'));
  const source = path.join(base, 'source');
  const remote = path.join(base, 'application.git');
  const publisher = path.join(base, 'publisher');
  const clone = path.join(base, 'clone');
  await mkdir(source);
  run('git', ['init', '-q', '-b', 'main'], { cwd: source });
  run('git', ['config', 'user.name', 'Narrow Clone Tester'], { cwd: source });
  run('git', ['config', 'user.email', 'narrow@example.test'], { cwd: source });
  await writeFile(path.join(source, 'README.md'), '# Application\n');
  run('git', ['add', 'README.md'], { cwd: source });
  run('git', ['commit', '-qm', 'Application'], { cwd: source });
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: source }).stdout.trim();
  run('git', ['clone', '-q', '--bare', source, remote], { cwd: base });

  await mkdir(publisher);
  run('git', ['init', '-q', '-b', 'state'], { cwd: publisher });
  run('git', ['config', 'user.name', 'State Publisher'], { cwd: publisher });
  run('git', ['config', 'user.email', 'state@example.test'], { cwd: publisher });
  const workflow = 'version: 2\n';
  await mkdir(path.join(publisher, 'singularity'), { recursive: true });
  await mkdir(path.join(publisher, 'configuration'), { recursive: true });
  await writeFile(path.join(publisher, 'singularity/workflow.yml'), workflow);
  await writeFile(path.join(publisher, 'configuration/manifest.json'), `${JSON.stringify({
    format: 'singularity-flow-configuration-mirror/v2',
    layout: 'canonical-paths',
    source: { branch: 'sflow/config', commit: sourceCommit },
    files: {
      'singularity/workflow.yml': createHash('sha256').update(workflow).digest('hex')
    }
  }, null, 2)}\n`);
  run('git', ['add', '-A'], { cwd: publisher });
  run('git', ['commit', '-qm', 'Verified state configuration mirror'], { cwd: publisher });
  run('git', ['remote', 'add', 'origin', remote], { cwd: publisher });
  run('git', ['push', '-q', 'origin', 'state'], { cwd: publisher });

  run('git', ['clone', '-q', '--single-branch', '--branch', 'main', remote, clone], { cwd: base });
  assert.notEqual(run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/state'], {
    cwd: clone, allowFailure: true
  }).status, 0);
  assert.equal(await validateRepositoryDirectory(clone), await realpath(clone));
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/remotes/origin/state'], {
    cwd: clone, allowFailure: true
  }).status, 0, 'validation fetched only the governed recovery authority');
  assert.equal(run('git', ['branch', '--show-current'], { cwd: clone }).stdout.trim(), 'main');
  assert.equal(run('git', ['status', '--porcelain=v1'], { cwd: clone }).stdout, '');
});

test('a nested directory is refused, and the message names the folder that was tried', async () => {
  // Caught by the .git probe rather than the top-level comparison, since a nested directory has no
  // .git of its own. The top-level guard behind it is what catches a worktree or submodule, where
  // .git exists but points somewhere else.
  const { root } = await initializedRepository();
  const nested = path.join(root, 'src');
  await mkdir(nested, { recursive: true });
  await assert.rejects(validateRepositoryDirectory(nested), (error) => {
    assert.match(error.message, /not a Git repository/);
    assert.match(error.message, /src$/, 'the folder that was actually tried is named');
    return true;
  });
});

test('a symbolic-linked control directory is refused', async () => {
  // The extension resolves artifact paths relative to this root, so a symlinked control directory is
  // how a path that looks inside the workspace comes to point outside it.
  const { base, root } = await initializedRepository();
  const elsewhere = path.join(base, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  await rm(path.join(root, 'singularity'), { recursive: true });
  await symlink(elsewhere, path.join(root, 'singularity'));
  await assert.rejects(validateRepositoryDirectory(root), /cannot be a symbolic link/);
});

test('a folder that is not a Git repository at all is refused', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-nogit-'));
  await assert.rejects(validateRepositoryDirectory(base), /not a Git repository/);
});

test('CLI resolution prefers the setting, then the bundled CLI, and says which it used', () => {
  const exists = (candidate) => candidate.endsWith('bin/singularity-flow.mjs');

  const configured = resolveCli({ configuredCli: '/custom/bin/singularity-flow.mjs', exists });
  assert.equal(configured.source, 'setting');
  assert.equal(configured.cli, '/custom/bin/singularity-flow.mjs');

  const bundled = resolveCli({ extensionPath: '/ext', exists });
  assert.equal(bundled.source, 'bundled');
  assert.equal(bundled.cli, '/ext/cli/bin/singularity-flow.mjs');
});

test('a configured CLI that does not exist fails at resolution, not at first use', () => {
  // Failing later would surface as "the snapshot command failed", which points at the wrong thing.
  assert.throws(
    () => resolveCli({ configuredCli: '/missing/cli.mjs', exists: () => false }),
    /cliPath points at a file that does not exist/
  );
});

test('no CLI anywhere fails with both places named', () => {
  const previous = process.env.SINGULARITY_FLOW_CLI;
  delete process.env.SINGULARITY_FLOW_CLI;
  try {
    assert.throws(() => resolveCli({ exists: () => false }), /singularityFlow.cliPath[\s\S]*SINGULARITY_FLOW_CLI/);
  } finally {
    if (previous !== undefined) process.env.SINGULARITY_FLOW_CLI = previous;
  }
});

test('large remote operations and lifecycle submissions get operation-appropriate long timeouts', async () => {
  const timeouts = [];
  const client = new SingularityFlowClient({
    location: { executable: 'node', cli: '/cli.mjs', source: 'setting' },
    repository: '/repo'
  });
  // Observe the timeout by racing it: a 15-minute budget must not fire where a 2-minute one would.
  // Asserted through the public surface rather than by reaching into the module's constants.
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => { timeouts.push(ms); return original(fn, 1, ...rest); };
  try {
    await client.run(['wm', 'build']).catch(() => {});
    await client.run(['capability', 'map', 'payments']).catch(() => {});
    await client.run(['capability', 'activate', 'proposal']).catch(() => {});
    await client.run(['workspace', 'refresh-configuration', '--dry-run']).catch(() => {});
    await client.run(['start', 'WRK-17', '--isolated-worktree']).catch(() => {});
    await client.run(['story', 'start', 'WRK-18']).catch(() => {});
    await client.run(['workspace', 'branches', '--preflight-story', 'WRK-19']).catch(() => {});
    await client.run(['submit', '--phase', 'poc-validation']).catch(() => {});
    await client.run(['initiative', 'status']).catch(() => {});
  } finally {
    globalThis.setTimeout = original;
  }
  assert.equal(timeouts[0], 15 * 60_000);
  assert.equal(timeouts[1], 15 * 60_000);
  assert.equal(timeouts[2], 15 * 60_000);
  assert.equal(timeouts[3], 15 * 60_000);
  assert.equal(timeouts[4], 15 * 60_000);
  assert.equal(timeouts[5], 15 * 60_000);
  assert.equal(timeouts[6], 15 * 60_000);
  assert.equal(timeouts[7], 30 * 60_000);
  assert.equal(timeouts[8], 120_000);
});

test('phases are read in declared order with the state each is in', () => {
  const phases = phasesInOrder(snapshot.initiative);
  assert.deepEqual(phases.map((phase) => phase.id), ['define', 'plan', 'build', 'release']);
  assert.equal(phases[0].label, 'Define');
  assert.equal(phases.filter((phase) => phase.current).length, 1, 'exactly one phase is current');
  assert.equal(phases.find((phase) => phase.current).id, snapshot.initiative.state.currentPhase);
  assert.ok(phases[0].outputs.length > 0, 'the define phase declares outputs');
});

test('a profile that declares no packs yields none rather than throwing', () => {
  // initiative-lite has no packs; only enterprise-delivery does. An absent construct is normal.
  assert.deepEqual(packsWithMembers(snapshot.initiative), []);
});

test('packs join their members to the artifacts, and report unauthored ones as absent', () => {
  const withPacks = {
    ...snapshot.initiative,
    state: {
      ...snapshot.initiative.state,
      resolution: {
        ...snapshot.initiative.state.resolution,
        packs: [{ id: 'opportunity', label: 'Opportunity & Investment Brief', members: ['define/business-case', 'define/missing-one'] }]
      }
    }
  };
  const [pack] = packsWithMembers(withPacks);
  assert.equal(pack.label, 'Opportunity & Investment Brief');
  assert.deepEqual(pack.members.map((member) => member.phase), ['define', 'define']);
  assert.equal(pack.members[0].output, 'business-case');
  assert.equal(pack.members[0].artifact?.id, 'business-case');
  assert.equal(pack.members[0].authored, false, 'declared but not yet generated');
  assert.equal(pack.members[1].artifact, null, 'a member naming no real output is absent, not a crash');
});

test('Stories group by the repository they land in', () => {
  const grouped = storiesByRepository(snapshot.initiative);
  assert.deepEqual(grouped.map((entry) => entry.repository), ['api', 'mobile']);
  assert.equal(grouped.find((entry) => entry.repository === 'mobile').stories.length, 2);
});

test('an initiative with no breakdown groups nothing rather than throwing', () => {
  assert.deepEqual(storiesByRepository({ ...snapshot.initiative, breakdown: null }), []);
});

test('only approval-pinned artifacts are treated as read-only', () => {
  assert.equal(isApprovalPinned({ status: 'approved', sha256: 'abc' }), true);
  assert.equal(isApprovalPinned({ status: 'generated', sha256: 'abc' }), false,
    'a generated artifact is exactly what a human should still be able to correct');
  assert.equal(isApprovalPinned({ status: 'not_generated', sha256: null }), false);
});

const { buildTree, buildConfigurationTree } = await import(source('views/tree-model.ts'));
// Capability tests start well before the workspace-navigation section below. Keep this import beside
// the other tree builders so Node versions that begin registered tests during later top-level awaits
// never observe buildCapabilityTree in its temporal dead zone.
const { buildCapabilityTree } = await import(source('views/navigation-trees.ts'));

/** Every node in the tree, depth-first, so a test can assert about the whole shape. */
function flatten(nodes) {
  return nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
}
const find = (nodes, id) => flatten(nodes).find((node) => node.id === id);

function storySnapshot({ status = 'in_progress', generation = 0 } = {}) {
  const artifact = {
    id: 'PHASE-DESIGN', label: 'Design', kind: 'markdown', phase: 'design',
    path: 'singularity/work-items/STORY-42/artifacts/design/design.md',
    status: generation ? 'published' : 'draft', generation,
    sha256: generation ? 'd'.repeat(64) : null
  };
  return {
    initiative: null, initiatives: [], selectedInitiativeId: null,
    selectedWorkId: 'STORY-42', workItems: [{ id: 'STORY-42', title: 'Make checkout safer' }],
    identities: { git: { email: 'reviewer@example.com' } },
    definition: {
      approvalAuthorities: {
        'architecture-reviewers': { members: [{ email: 'reviewer@example.com' }] }
      }
    },
    workflow: {
      workItem: { id: 'STORY-42', title: 'Make checkout safer', branch: 'STORY-42', workType: 'feature' },
      currentPhase: 'design', phaseOrder: ['intake', 'design'], status: 'in_progress',
      resolution: {
        approvalAuthorities: {
          'architecture-reviewers': { members: [{ email: 'reviewer@example.com' }] }
        }
      },
      phases: {
        intake: {
          id: 'intake', label: 'Intake', status: 'approved', generation: 1,
          artifacts: [], approvals: []
        },
        design: {
          id: 'design', label: 'Design', status, generation,
          generatedBy: { email: 'author@example.com' }, requiredArtifact: { path: artifact.path },
          artifacts: [artifact], approvals: [],
          approvalPolicy: { authorities: ['architecture-reviewers'], minimum: 1, rejectTo: ['intake', 'design'] }
        }
      }
    },
    documents: [artifact]
  };
}

test('an unreadable repository shows the CLI error rather than an empty tree', () => {
  // An empty tree in a governance tool reads as "nothing to do", which is the most expensive thing
  // it could wrongly say.
  const [node] = buildTree(null, new Error("Phase 'define' is not ready."));
  assert.equal(node.kind, 'message');
  assert.equal(node.label, "Phase 'define' is not ready.");
  assert.equal(node.icon, 'error');
});

test('a repository that will not load offers the file to fix and the full report', () => {
  // The state a person is most stuck in used to be the least helpful thing on screen: one row, the
  // engine's sentence, and no way forward. The sentence names the file it refused; opening it is a
  // step the tree can simply take rather than leaving somebody to hunt through the explorer.
  const refused = new Error(
    "Checklist 'inception/ux-concept-approved' references unknown applicability policy 'ux-required'.");
  for (const tree of [buildTree(null, refused), buildConfigurationTree(null, refused)]) {
    assert.match(tree[0].label, /unknown applicability policy/);
    assert.equal(tree[0].icon, 'error');
    assert.equal(tree[1].label, 'Open singularity/portfolio.yml', 'a checklist lives in the portfolio');
    assert.equal(tree[1].path, 'singularity/portfolio.yml');
    assert.equal(tree.at(-1).runCommand, 'singularityFlow.doctor');
  }

  // Named outright when the message names it.
  assert.equal(buildTree(null, new Error('singularity/workflow.yml is not valid YAML.'))[1].label,
    'Open singularity/workflow.yml');

  // And a message naming no file offers only the report, rather than guessing at one.
  const vague = buildTree(null, new Error('The Singularity Flow CLI did not finish within 45 seconds.'));
  assert.equal(vague.length, 2);
  assert.equal(vague[1].runCommand, 'singularityFlow.doctor');
});


test('a repository with nothing checked out on this branch says so, and how many exist', () => {
  const [node, start] = buildTree({ initiative: null, initiatives: [{ id: 'A' }, { id: 'B' }], workItems: [] });
  assert.match(node.label, /Nothing is checked out/);
  assert.equal(node.description, '2 available');
  assert.equal(node.contextValue, 'sflow.lifecycle.empty');
  assert.equal(start.runCommand, 'singularityFlow.startWork');
});

test('a repository with nothing started at all offers the command that starts something', () => {
  const [node, start] = buildTree({ initiative: null, initiatives: [], workItems: [] });
  assert.match(node.label, /No work has been started/);
  assert.equal(start.contextValue, 'sflow.start');
  assert.equal(start.label, 'Start intake');
});

test('a checked-out Story gets a phase rail with named prepare publish and submit actions', () => {
  const tree = buildTree(storySnapshot({ generation: 1 }));
  assert.deepEqual(tree.map((node) => node.id), ['active-story:STORY-42', 'workspace:impact']);
  assert.equal(find(tree, 'story:continue-safely').runCommand, 'singularityFlow.continueSafely');
  assert.equal(find(tree, 'story:progress-rail').runCommand, 'singularityFlow.openJourney');
  assert.match(find(tree, 'story:progress-rail').description, /phases · approvals · files/);
  assert.equal(find(tree, 'story:analytics').runCommand, 'singularityFlow.openDashboard');
  assert.match(find(tree, 'story:analytics').description, /time · tokens · cost/);
  assert.equal(find(tree, 'story:flow-impact').runCommand, 'singularityFlow.openFlowImpact');
  assert.match(find(tree, 'story:flow-impact').description, /classification · evidence · receipt/);
  assert.equal(find(tree, 'story:phase-rail').description, '1/2 approved');
  assert.equal(find(tree, 'story-phase:design').description, 'in progress · current · 1 artifact');
  assert.equal(find(tree, 'story-phase:design').icon, 'statusCurrent');
  assert.equal(find(tree, 'story-phase:design').contextValue, 'sflow.story.phase.current');
  assert.equal(find(tree, 'story-phase:design').children[0].id, 'story-document:design:PHASE-DESIGN',
    'expanding a phase leads with the artifacts generated by that phase');
  assert.equal(find(tree, 'story:design:prepare').runCommand, 'singularityFlow.prepareStoryPhase');
  assert.equal(find(tree, 'story:design:publish').runCommand, 'singularityFlow.publishStoryPhase');
  assert.equal(find(tree, 'story:design:submit').runCommand, 'singularityFlow.submitStoryPhase');
  assert.equal(find(tree, 'story-document:design:PHASE-DESIGN').path,
    'singularity/work-items/STORY-42/artifacts/design/design.md');
  const generated = find(tree, 'story:STORY-42:generated-artifacts');
  assert.equal(generated.label, 'Generated artifacts');
  assert.equal(generated.description, '1');
  assert.equal(find(generated.children, 'story:STORY-42:artifacts:design').label, 'Design');
  assert.equal(find(generated.children, 'story-document:design:PHASE-DESIGN').path,
    'singularity/work-items/STORY-42/artifacts/design/design.md');
});

test('an open stakeholder change request is visible beside the reopened Story', () => {
  const reopened = storySnapshot({ generation: 2 });
  reopened.workflow.changeRequests = [{
    id: 'CR-003', status: 'open', sourcePhase: 'design', targetPhase: 'intake',
    comment: 'Clarify failure behavior before design continues.',
    requestedAt: '2026-08-05T00:00:00.000Z', requestedBy: { email: 'reviewer@example.com' },
    forwardCheckpoint: {
      id: 'RFW-CR-003', sourceCommit: 'a'.repeat(40), sourcePhase: 'design', targetPhase: 'intake',
      integrity: { sha256: `sha256:${'b'.repeat(64)}` }
    }
  }];
  const tree = buildTree(reopened);
  assert.equal(find(tree, 'story:change-requests').description, '1 open');
  const request = find(tree, 'story:change-request:CR-003');
  assert.equal(request.label, 'CR-003 · intake');
  assert.match(request.description, /Clarify failure behavior/);
  const rollForward = find(tree, 'story:change-request:CR-003:roll-forward');
  assert.equal(rollForward.runCommand, 'singularityFlow.rollForwardRework');
  assert.match(rollForward.label, /return to design/);
  assert.deepEqual(rollForward.command.slice(0, 3), ['story', 'rework', 'roll-forward']);
});

test('a completed Story leaves the active rail and opens from Completed with every artifact', () => {
  const done = storySnapshot({ status: 'approved', generation: 1 });
  done.workflow.status = 'complete';
  done.workflow.currentPhase = null;
  done.workflow.phases.design.status = 'approved';
  done.documents[0].status = 'approved';
  const tree = buildTree(done);

  assert.deepEqual(tree.map((node) => node.id), ['completed', 'workspace:impact']);
  assert.equal(tree[0].label, 'Completed');
  assert.equal(tree[0].description, '1 artifact');
  const story = find(tree, 'completed-story:STORY-42');
  assert.equal(story.contextValue, 'sflow.story.completed');
  assert.match(story.description, /1 artifact/);
  assert.equal(find(tree, 'story:continue-safely'), undefined, 'terminal work has no mutation action');
  assert.equal(find(tree, 'completed-story:open').runCommand, 'singularityFlow.openInbox');
  assert.equal(find(tree, 'completed-story:reopen').runCommand, 'singularityFlow.reopenCompleted');
  assert.equal(find(tree, 'completed-story-artifact:design:PHASE-DESIGN').path,
    'singularity/work-items/STORY-42/artifacts/design/design.md');
  assert.equal(find(tree, 'completed-story-artifact:design:PHASE-DESIGN').readOnly, true);
});

test('a cancelled Story leaves the active rail and opens from Archived with its reason and artifacts', () => {
  const cancelled = storySnapshot({ status: 'cancelled', generation: 1 });
  cancelled.workflow.status = 'cancelled';
  cancelled.workflow.currentPhase = null;
  cancelled.workflow.cancellation = {
    phase: 'design', reason: 'The customer withdrew the request.',
    cancelledAt: '2026-08-05T09:00:00.000Z',
    cancelledBy: { name: 'Product Owner', email: 'po@example.com' },
    agent: 'product-owner', channel: 'vscode'
  };
  const tree = buildTree(cancelled);

  assert.deepEqual(tree.map((node) => node.id), ['archived', 'workspace:impact']);
  assert.equal(tree[0].label, 'Archived');
  const story = find(tree, 'archived-story:STORY-42');
  assert.equal(story.contextValue, 'sflow.story.archived');
  assert.match(story.tooltip, /customer withdrew/);
  assert.equal(find(tree, 'story:continue-safely'), undefined);
  assert.equal(find(tree, 'archived-story-artifact:design:PHASE-DESIGN').path,
    'singularity/work-items/STORY-42/artifacts/design/design.md');
  assert.equal(find(tree, 'archived-story-artifact:design:PHASE-DESIGN').readOnly, true);
});

test('completed sibling Stories remain visible while another Story is active', () => {
  const active = storySnapshot({ generation: 1 });
  active.workItems.push({
    id: 'WRK-456', title: 'Change the color', status: 'complete', branch: 'WRK-456'
  });
  const tree = buildTree(active);

  assert.deepEqual(tree.map((node) => node.id), ['active-story:STORY-42', 'completed', 'workspace:impact']);
  assert.equal(find(tree, 'completed').description, '1 item');
  const completed = find(tree, 'completed-story-summary:WRK-456');
  assert.equal(completed.label, 'WRK-456');
  assert.equal(completed.description, 'Change the color');
  assert.deepEqual(completed.command, ['session', 'attach', 'WRK-456']);
  assert.equal(completed.runCommand, 'singularityFlow.runAction');
});

test('active sibling Stories remain visible and attach to their isolated checkout', () => {
  const active = storySnapshot({ generation: 1 });
  active.workItems[0].status = 'in_progress';
  active.workItems[0].currentPhase = 'design';
  active.workItems.push({
    id: 'CFA-STORY', title: 'Calculate compound interest', status: 'in_progress',
    currentPhase: 'intake', branch: 'CFA-STORY'
  });
  const tree = buildTree(active);

  assert.deepEqual(tree.map((node) => node.id), ['active-story:STORY-42', 'active-stories', 'workspace:impact']);
  assert.equal(find(tree, 'active-stories').description, '1 Story');
  const sibling = find(tree, 'active-story-summary:CFA-STORY');
  assert.equal(sibling.label, 'CFA-STORY');
  assert.equal(sibling.description, 'intake · in progress');
  assert.deepEqual(sibling.command, ['session', 'attach', 'CFA-STORY']);
  assert.equal(sibling.runCommand, 'singularityFlow.runAction');
});

test('a completed Initiative is archived with its generated outputs, not active actions', () => {
  const done = structuredClone(snapshot);
  done.initiative.state.status = 'complete';
  done.initiative.state.currentPhase = null;
  const output = done.initiative.state.phases.define.outputs['business-case'];
  output.status = 'approved';
  output.sha256 = 'c'.repeat(64);
  done.initiative.documents = [{
    ...output, phase: 'define', repositoryPath:
      'singularity/initiatives/INIT-MULTI/artifacts/define/business-case.md'
  }];
  const tree = buildTree(done);

  assert.deepEqual(tree.map((node) => node.id), ['completed', 'workspace:impact']);
  assert.equal(tree[0].description, '1 artifact');
  assert.ok(find(tree, 'completed-initiative:INIT-MULTI'));
  assert.equal(find(tree, 'initiative:continue-safely'), undefined);
  assert.equal(find(tree, 'completed-initiative:open').runCommand, 'singularityFlow.openInbox');
  assert.equal(find(tree, 'completed-initiative-artifact:define/business-case').path,
    'singularity/initiatives/INIT-MULTI/artifacts/define/business-case.md');
});

test('the tree is built from the real snapshot: lifecycle, phases, artifacts, Stories', () => {
  const tree = buildTree(snapshot);
  // Once intake has selected a workflow, Lifecycle shows only that work and its phases.
  assert.deepEqual(tree.map((node) => node.id), ['initiative:INIT-MULTI', 'workspace:impact']);
  const root = tree[0];
  assert.equal(root.kind, 'initiative');
  assert.equal(root.label, 'INIT-MULTI');

  const phases = find(tree, 'phases');
  assert.deepEqual(phases.children.map((phase) => phase.id),
    ['phase:define', 'phase:plan', 'phase:build', 'phase:release']);
  assert.equal(phases.description, '0/4 approved');

  const define = find(tree, 'phase:define');
  assert.equal(define.description, 'in progress · current', 'the phase someone is standing in is marked');
  assert.ok(define.children.length > 0);
  const artifact = define.children[0];
  assert.equal(artifact.kind, 'artifact');
  assert.ok(artifact.path, 'an artifact carries the path the editor opens');
  assert.equal(artifact.readOnly, false, 'nothing is approved yet, so nothing is pinned');
});

test('the next governed action is surfaced first, with the engine own wording', () => {
  const tree = buildTree(snapshot);
  assert.equal(find(tree, 'initiative:continue-safely').runCommand, 'singularityFlow.continueSafely');
  assert.equal(find(tree, 'initiative:progress-rail').runCommand, 'singularityFlow.openJourney');
  const action = find(tree, 'next-action');
  assert.equal(action.kind, 'action');
  assert.equal(action.label, snapshot.initiative.nextActions[0].reason);
  // Split into argv so it can be run, with the binary name removed.
  assert.deepEqual(action.command, ['initiative', 'phase', 'define']);
});

test('Stories are grouped by the repository they land in', () => {
  const tree = buildTree(snapshot);
  const stories = find(tree, 'stories');
  assert.equal(stories.description, '3 across 2 repositories');
  assert.deepEqual(stories.children.map((entry) => entry.label), ['api', 'mobile']);
  const mobile = find(tree, 'repository:mobile');
  assert.equal(mobile.children.length, 2);
  const dependent = mobile.children.find((story) => story.label === 'MOB-1');
  assert.match(dependent.tooltip, /Depends on API-1/);
});

test('a non-blocking Story is marked as such rather than looking identical', () => {
  const tree = buildTree(snapshot);
  const optional = flatten(tree).find((node) => node.kind === 'story' && node.label === 'MOB-2');
  assert.match(optional.description, /non-blocking/);
});

test('an approved artifact is pinned read-only and reports its hash', () => {
  const approved = structuredClone(snapshot);
  const output = Object.values(approved.initiative.state.phases.define.outputs)[0];
  output.status = 'approved';
  output.sha256 = 'a'.repeat(64);
  const artifact = find(buildTree(approved), `artifact:define/${output.id}`);
  assert.equal(artifact.readOnly, true);
  assert.equal(artifact.contextValue, 'sflow.artifact.pinned');
  assert.match(artifact.tooltip, /sha256 a{64}/);
});

test('a blocked phase gate is shown with each reason, not just a count', () => {
  const blocked = structuredClone(snapshot);
  blocked.initiative.phaseGate = {
    ready: false, passes: [], warnings: [],
    errors: ['business-case has 0/1 approvals', 'scope-agreed has no evidence']
  };
  const tree = buildTree(blocked);
  const gate = find(tree, 'gate');
  assert.equal(gate.label, 'This phase is not ready (2)');
  assert.deepEqual(gate.children.map((child) => child.label), blocked.initiative.phaseGate.errors);
});

test('a ready gate adds no noise to the tree', () => {
  const ready = structuredClone(snapshot);
  ready.initiative.phaseGate = { ready: true, errors: [], warnings: [], passes: [] };
  assert.equal(find(buildTree(ready), 'gate'), undefined);
});

test('packs appear beside phases, since a pack deliberately spans them', () => {
  const withPacks = structuredClone(snapshot);
  withPacks.initiative.state.resolution.packs = [{
    id: 'validation-release',
    label: 'Validation & Release Readiness',
    members: ['define/business-case', 'plan/delivery-plan']
  }];
  const tree = buildTree(withPacks);
  const packs = find(tree, 'packs');
  assert.ok(packs, 'packs are a sibling of the lifecycle, not nested inside one phase');
  const pack = find(tree, 'pack:validation-release');
  assert.equal(pack.label, 'Validation & Release Readiness');
  assert.equal(pack.description, '0/2');
  // A member the profile does not declare is reported rather than silently dropped.
  assert.equal(pack.children.length, 2);
});

test('a profile with no packs shows no pack group at all', () => {
  assert.equal(find(buildTree(snapshot), 'packs'), undefined);
});

test('every node has a unique id, or the tree view collapses the duplicates', () => {
  const withPacks = structuredClone(snapshot);
  withPacks.initiative.state.resolution.packs = [
    { id: 'p1', label: 'One', members: ['define/business-case'] }
  ];
  const ids = flatten(buildTree(withPacks)).map((node) => node.id);
  // Pack members reuse the artifact id by design; assert uniqueness per parent instead of globally.
  const phaseArtifacts = find(buildTree(withPacks), 'phases')
    .children.flatMap((phase) => (phase.children ?? []).map((child) => child.id));
  assert.equal(new Set(phaseArtifacts).size, phaseArtifacts.length);
  assert.ok(ids.length > 10);
});

const { buildJourney } = await import(source('views/journey-model.ts'));

test('a published artifact offers approval, carrying the confirmation the CLI will demand', () => {
  // The confirmation travels with the node so the editor can ask a human to type it. The extension
  // must never fill it in itself — that would turn a deliberate act into a click.
  const published = structuredClone(snapshot);
  published.initiative.state.phases.define.outputs['business-case'].status = 'published';
  published.initiative.state.phases.define.outputs['business-case'].sha256 = 'b'.repeat(64);
  const artifact = find(buildTree(published), 'artifact:define/business-case');
  assert.equal(artifact.approve.subject, 'business-case');
  assert.equal(artifact.approve.initiativeId, 'INIT-MULTI');
  assert.equal(artifact.approve.expected, 'define:business-case');
  assert.equal(artifact.contextValue, 'sflow.artifact.approvable');
});

test('an unwritten or already-approved artifact offers no approval', () => {
  // Offering it would produce a refusal the reviewer could have been spared.
  const unwritten = find(buildTree(snapshot), 'artifact:define/business-case');
  assert.equal(unwritten.approve, undefined, 'nothing is generated yet');

  const done = structuredClone(snapshot);
  done.initiative.state.phases.define.outputs['business-case'].status = 'approved';
  done.initiative.state.phases.define.outputs['business-case'].sha256 = 'c'.repeat(64);
  assert.equal(find(buildTree(done), 'artifact:define/business-case').approve, undefined);
});

test('a cross-phase pack is approved at its terminal phase, not its first', () => {
  // Validation & Release Readiness spans construction and delivery. Attributing it to the earlier
  // phase would ask a phase too early and produce a confirmation string the CLI would reject.
  const withPacks = structuredClone(snapshot);
  for (const phase of Object.values(withPacks.initiative.state.phases)) {
    for (const output of Object.values(phase.outputs)) {
      output.sha256 = 'd'.repeat(64);
      output.status = 'published';
    }
  }
  withPacks.initiative.state.resolution.packs = [{
    id: 'spanning',
    label: 'Spanning pack',
    // Deliberately listed out of phase order: the terminal phase comes from the declared order.
    members: ['build/implementation-index', 'define/business-case']
  }];
  const pack = find(buildTree(withPacks), 'pack:spanning');
  assert.ok(pack.approve, 'every member exists, so the pack is approvable');
  assert.equal(pack.approve.subject, 'pack:spanning');
  assert.equal(pack.approve.expected, 'build:pack:spanning',
    'attributed to the latest phase any member sits in');
  assert.equal(pack.contextValue, 'sflow.pack.approvable');
});

test('an incomplete pack is not approvable', () => {
  const withPacks = structuredClone(snapshot);
  withPacks.initiative.state.resolution.packs = [{
    id: 'partial', label: 'Partial', members: ['define/business-case', 'define/scope-and-outcomes']
  }];
  const pack = find(buildTree(withPacks), 'pack:partial');
  assert.equal(pack.approve, undefined);
  assert.equal(pack.contextValue, 'sflow.pack');
});

test('the journey reports where the Epic stands and what it is waiting on', () => {
  const journey = buildJourney(snapshot);
  assert.equal(journey.empty, null);
  assert.equal(journey.id, 'INIT-MULTI');
  assert.deepEqual(journey.stages.map((stage) => stage.id), ['define', 'plan', 'build', 'release']);
  assert.equal(journey.currentStage.id, 'define');
  assert.equal(journey.artifacts.length, 3, 'the current phase contributes its artifacts');
  assert.equal(journey.repositories.length, 2);
  assert.match(journey.nextAction.command, /initiative phase define/);
});

test('the journey rail selects any Story phase and exposes its artifacts and approvers', () => {
  const story = {
    initiative: null, initiatives: [], workItems: [{ id: 'WRK-42' }],
    workflow: {
      workItem: { id: 'WRK-42', title: 'Readable lifecycle rail', branch: 'WRK-42', workType: 'feature' },
      currentPhase: 'implementation', phaseOrder: ['specification', 'implementation', 'verification'],
      status: 'in_progress', phases: {
        specification: {
          id: 'specification', label: 'Specification', status: 'approved', generation: 1,
          requiredArtifact: { path: 'artifacts/specification/spec.md' }, artifacts: [],
          approvals: [{ decision: 'approved', at: '2026-08-20T08:00:00.000Z',
            authorityGroup: 'product', actor: { name: 'Alex Reviewer', email: 'alex@example.test' } }]
        },
        implementation: {
          id: 'implementation', label: 'Implementation', status: 'in_progress', generation: 1,
          requiredArtifact: { path: 'artifacts/implementation/implementation-summary.md' },
          artifacts: [], approvals: []
        },
        verification: {
          id: 'verification', label: 'Verification', status: 'not_started', generation: 0,
          requiredArtifact: { path: 'artifacts/verification/verification.md' }, artifacts: [], approvals: []
        }
      }
    },
    documents: [{ id: 'PHASE-SPECIFICATION', phase: 'specification', label: 'Specification',
      path: 'singularity/work-items/WRK-42/artifacts/specification/spec.md', status: 'approved',
      sha256: 'a'.repeat(64) }]
  };

  const current = buildJourney(story);
  assert.equal(current.kind, 'story');
  assert.equal(current.currentStage.id, 'implementation');
  assert.equal(current.selectedStage.id, 'implementation', 'the active phase is selected by default');

  const selected = buildJourney(story, 'specification');
  assert.equal(selected.selectedStage.id, 'specification');
  assert.equal(selected.artifacts.length, 1);
  assert.equal(selected.artifacts[0].path,
    'singularity/work-items/WRK-42/artifacts/specification/spec.md');
  assert.deepEqual(selected.artifacts[0].approvals.map((approval) => approval.actor), ['Alex Reviewer'],
    'Story phase approval applies to every artifact in its submitted generation');
  assert.deepEqual(selected.approvals.map((approval) => approval.actor), ['Alex Reviewer']);
  assert.equal(selected.stages[0].approved, true);
  assert.equal(selected.stages[1].current, true,
    'inspecting a completed phase never changes which phase is active');
});

test('Epic artifact rows attribute only the approval bound to that artifact', () => {
  const approved = structuredClone(snapshot);
  const phase = approved.initiative.state.phases.define;
  phase.outputs['business-case'].sha256 = 'b'.repeat(64);
  phase.outputs['business-case'].status = 'approved';
  phase.outputs['scope-and-outcomes'].sha256 = 'c'.repeat(64);
  phase.outputs['scope-and-outcomes'].status = 'approved';
  approved.initiative.report = { approvals: { byPhase: { define: [
    { phase: 'define', subjectType: 'output', subjectId: 'business-case', decision: 'approved',
      actorEmail: 'product@example.test', at: '2026-08-20T08:00:00.000Z' },
    { phase: 'define', subjectType: 'output', subjectId: 'scope-and-outcomes', decision: 'approved',
      actorEmail: 'architecture@example.test', at: '2026-08-20T08:05:00.000Z' }
  ] } } };

  const journey = buildJourney(approved, 'define');
  const businessCase = journey.artifacts.find((artifact) => artifact.subjectId === 'business-case');
  const scope = journey.artifacts.find((artifact) => artifact.subjectId === 'scope-and-outcomes');
  assert.deepEqual(businessCase.approvals.map((approval) => approval.actor), ['product@example.test']);
  assert.deepEqual(scope.approvals.map((approval) => approval.actor), ['architecture@example.test']);
});

test('the shared phase rail styles completed work green and the active phase as a reduced-motion-safe pulse', async () => {
  const css = await readFile(path.join(packageRoot, 'apps', 'vscode', 'src', 'views', 'webview.ts'), 'utf8');
  assert.match(css, /\.phase-node\.done \.phase-marker[^}]*background: var\(--sf-accent\)/);
  assert.match(css, /\.phase-node\.current \.phase-marker[^}]*background: var\(--sf-wait\)[^}]*animation: sf-phase-pulse/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.phase-node\.clickable \.phase-select:focus-visible/);
});

test('the journey reads each pack chain position from the gate rather than re-deriving it', () => {
  // Re-deriving would be a second implementation of approvalChainProgress that could disagree with
  // the one actually blocking the phase.
  const blocked = structuredClone(snapshot);
  blocked.initiative.state.resolution.packs = [
    { id: 'opportunity', label: 'Opportunity', members: ['define/business-case'] }
  ];
  blocked.initiative.phaseGate = {
    ready: false, warnings: [], passes: [],
    errors: ['artifact pack opportunity has waiting on Executive Decisioning (0/1) for exact pack abc123']
  };
  const journey = buildJourney(blocked);
  assert.equal(journey.packs[0].waitingOn, 'waiting on Executive Decisioning (0/1)');
  assert.equal(journey.packs[0].approved, false);
  assert.deepEqual(journey.blockers, blocked.initiative.phaseGate.errors);
});

test('a gate the engine says is ready contributes no blockers', () => {
  const ready = structuredClone(snapshot);
  ready.initiative.phaseGate = { ready: true, errors: ['stale'], warnings: [], passes: [] };
  assert.deepEqual(buildJourney(ready).blockers, [], 'a ready gate has nothing outstanding');
});

test('the journey says why it is empty rather than rendering a blank page', () => {
  assert.match(buildJourney(null).empty, /Reading the repository/);
  assert.match(buildJourney({ initiative: null, initiatives: [], workItems: [] }).empty, /No work has been started/);
  assert.match(buildJourney({ initiative: null, initiatives: [{ id: 'A' }], workItems: [] }).empty, /Nothing governed is checked out/);
});

const { buildReconciliation } = await import(source('views/reconciliation-model.ts'));
const levelOf = (reconciliation, id) => reconciliation.levels.find((level) => level.id === id);

test('an unmaterialized Epic reports nothing to compare, never that it agrees', () => {
  // The rule the whole model turns on. An Epic with no branches has nothing to reconcile, and saying
  // its branches agree would be the most dangerous sentence this view could produce.
  const reconciliation = buildReconciliation(snapshot, null);
  assert.deepEqual(reconciliation.levels.map((level) => level.id),
    ['branches', 'stories', 'repositories', 'conformance']);
  for (const level of reconciliation.levels) {
    assert.notEqual(level.verdict, 'aligned', `${level.id} must not claim alignment with no data`);
    assert.equal(level.verdict, 'not-applicable');
    assert.ok(level.reason, `${level.id} says why it cannot be judged`);
  }
  assert.match(levelOf(reconciliation, 'branches').reason, /materialized/);
  assert.equal(levelOf(reconciliation, 'branches').remedy, 'singularity-flow initiative materialize');
});

test('a stale or never-observed Story branch is drift; moving on from the seed is not', () => {
  // A branch that has moved past its seed is doing the work. Drift is the Epic's record being stale.
  const materialized = structuredClone(snapshot);
  materialized.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', status: 'in-progress', currentPhase: 'build',
      seedCommit: 'aaaa1111', observedCommit: 'bbbb2222', stale: false },
    'MOB-1': { workId: 'MOB-1', repository: 'mobile', status: 'seeded', currentPhase: null,
      seedCommit: 'cccc3333', observedCommit: 'cccc3333', stale: false },
    'MOB-2': { workId: 'MOB-2', repository: 'mobile', status: 'in-progress', currentPhase: 'build',
      seedCommit: 'dddd4444', observedCommit: 'eeee5555', stale: true }
  };
  const level = levelOf(buildReconciliation(materialized, null), 'branches');
  assert.equal(level.verdict, 'drifted');
  assert.equal(level.rows.find((row) => row.id === 'API-1').drifted, false, 'moved on, but observed');
  assert.equal(level.rows.find((row) => row.id === 'MOB-1').drifted, false, 'still at seed');
  assert.equal(level.rows.find((row) => row.id === 'MOB-2').drifted, true, 'the record is stale');
  assert.match(level.rows.find((row) => row.id === 'MOB-2').detail, /sync/);
  assert.equal(level.remedy, 'singularity-flow initiative sync');
});

test('a branch that was never observed is drift, not silence', () => {
  const materialized = structuredClone(snapshot);
  materialized.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', status: 'seeded', seedCommit: 'aaaa', observedCommit: null }
  };
  const [row] = levelOf(buildReconciliation(materialized, null), 'branches').rows;
  assert.equal(row.drifted, true);
  assert.match(row.cells.at(-1), /never observed/);
});

test('only a blocking Story that is not ready holds the Epic back', () => {
  const withDelivery = structuredClone(snapshot);
  withDelivery.initiative.delivery = {
    materialized: true,
    blockers: ['API-1 has not completed implementation'],
    stories: [
      { id: 'API-1', workId: 'API-1', repository: 'api', blocking: true, ready: false, reason: 'implementation incomplete' },
      { id: 'MOB-1', workId: 'MOB-1', repository: 'mobile', blocking: true, ready: true },
      { id: 'MOB-2', workId: 'MOB-2', repository: 'mobile', blocking: false, ready: false }
    ]
  };
  const level = levelOf(buildReconciliation(withDelivery, null), 'stories');
  assert.equal(level.verdict, 'drifted');
  assert.equal(level.rows.find((row) => row.id === 'API-1').drifted, true);
  assert.equal(level.rows.find((row) => row.id === 'MOB-1').drifted, false);
  assert.equal(level.rows.find((row) => row.id === 'MOB-2').drifted, false, 'non-blocking never gates');
  assert.match(level.remedy, /implementation/);
});

test('the merge plan drives the cross-repository level, and names what is next', () => {
  const plan = {
    initiativeId: 'INIT-MULTI', epicBranch: 'INIT-MULTI',
    stories: [
      { order: 1, id: 'API-1', workId: 'API-1', repository: 'api', blocking: true, status: 'ready', blockedBy: [] },
      { order: 2, id: 'MOB-1', workId: 'MOB-1', repository: 'mobile', blocking: true, status: 'blocked', blockedBy: ['API-1'] }
    ],
    nextToMerge: { workId: 'API-1' }, epicReady: false, outstanding: ['API-1', 'MOB-1']
  };
  const level = levelOf(buildReconciliation(snapshot, plan), 'repositories');
  assert.equal(level.verdict, 'drifted', 'blocking Stories have not merged');
  assert.match(level.rows[1].cells.at(-1), /blocked by API-1/);
  assert.match(level.remedy, /Next to merge: API-1/);
});

test('an Epic whose blocking Stories have all merged reports the repositories aligned', () => {
  const plan = {
    epicBranch: 'INIT-MULTI',
    stories: [{ order: 1, id: 'API-1', workId: 'API-1', repository: 'api', blocking: true, status: 'merged', blockedBy: [] }],
    nextToMerge: null, epicReady: true, outstanding: []
  };
  const level = levelOf(buildReconciliation(snapshot, plan), 'repositories');
  assert.equal(level.verdict, 'aligned');
  assert.equal(level.remedy, null);
});

test('a consumer built against an older contract version is spec-versus-code drift', () => {
  const withContracts = structuredClone(snapshot);
  withContracts.initiative.contracts = [
    {
      key: 'orders', id: 'orders', version: '2', sha256: 'f'.repeat(64), integrity: 'verified',
      consumers: [
        { storyId: 'MOB-1', repository: 'mobile', stale: false, observedContractSha256: 'f'.repeat(64) },
        { storyId: 'MOB-2', repository: 'mobile', stale: false, observedContractSha256: 'a'.repeat(64) }
      ]
    }
  ];
  const level = levelOf(buildReconciliation(withContracts, null), 'conformance');
  assert.equal(level.verdict, 'drifted');
  assert.equal(level.rows.find((row) => row.id === 'orders/MOB-1').drifted, false);
  const behind = level.rows.find((row) => row.id === 'orders/MOB-2');
  assert.equal(behind.drifted, true);
  assert.match(behind.cells.at(-1), /older version/);
});

test('a contract file that changed since it was pinned is drift for every consumer', () => {
  const withContracts = structuredClone(snapshot);
  withContracts.initiative.contracts = [{
    key: 'orders', version: '2', sha256: 'f'.repeat(64), integrity: 'stale',
    consumers: [{ storyId: 'MOB-1', repository: 'mobile', stale: false, observedContractSha256: 'f'.repeat(64) }]
  }];
  const level = levelOf(buildReconciliation(withContracts, null), 'conformance');
  assert.equal(level.verdict, 'drifted');
  assert.match(level.rows[0].cells.at(-1), /contract file changed/);
});

test('reconciliation says why it is empty rather than rendering nothing', () => {
  assert.match(buildReconciliation(null, null).empty, /Reading the repository/);
  assert.match(buildReconciliation({ initiative: null, initiatives: [], workItems: [] }, null).empty,
    /No work has been started/);
});

test('a Story that reached conformance contributes its tree hash to the spec-versus-code level', () => {
  // The conformance tree is the most direct spec-versus-code evidence the system holds; it belongs
  // beside the contracts rather than only inside the Story's own workflow.
  const withConformance = structuredClone(snapshot);
  withConformance.initiative.contracts = [];
  withConformance.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', conformance: { status: 'approved', treeSha256: 'ab'.repeat(32) } },
    'MOB-1': { workId: 'MOB-1', repository: 'mobile', conformance: { status: 'in_progress', treeSha256: null } },
    'MOB-2': { workId: 'MOB-2', repository: 'mobile' }
  };
  const level = levelOf(buildReconciliation(withConformance, null), 'conformance');
  assert.equal(level.verdict, 'drifted');
  assert.equal(level.rows.length, 2, 'a Story with no conformance phase contributes no row');
  const passed = level.rows.find((row) => row.id === 'story:API-1');
  assert.equal(passed.drifted, false);
  assert.match(passed.cells.at(-1), /conforms @ abababab/);
  const pending = level.rows.find((row) => row.id === 'story:MOB-1');
  assert.equal(pending.drifted, true);
  assert.match(pending.cells.at(-1), /no conformance tree recorded/);
});

test('contracts and Story conformance appear in one level, not two verdicts', () => {
  const both = structuredClone(snapshot);
  both.initiative.contracts = [{
    key: 'orders', version: '2', sha256: 'f'.repeat(64), integrity: 'verified',
    consumers: [{ storyId: 'MOB-1', repository: 'mobile', stale: false, observedContractSha256: 'f'.repeat(64) }]
  }];
  both.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', conformance: { status: 'approved', treeSha256: 'cd'.repeat(32) } }
  };
  const level = levelOf(buildReconciliation(both, null), 'conformance');
  assert.equal(level.verdict, 'aligned');
  assert.equal(level.rows.length, 2, 'one contract consumer and one conforming Story');
});

const { commandArgv, commandPlaceholders, fillPlaceholders, placeholderPrompt } =
  await import(source('commands.ts'));

test('a suggested command with a placeholder is not runnable as written', () => {
  // The sources step suggests `--file <PATH>`, where <PATH> is an instruction to a person. Running
  // it literally passes the string "<PATH>" to the CLI, which fails on a file of that name — a
  // failure that says nothing about what was actually wanted.
  const argv = commandArgv('singularity-flow epic sources add --epic SF-E-001 --file <PATH>');
  assert.deepEqual(argv, ['epic', 'sources', 'add', '--epic', 'SF-E-001', '--file', '<PATH>']);

  const [placeholder] = commandPlaceholders(argv);
  assert.equal(placeholder.index, 6);
  assert.equal(placeholder.name, 'PATH');
  assert.equal(placeholder.flag, '--file');
  assert.equal(placeholder.kind, 'file', 'a path deserves a file picker, not a text box');
  assert.match(placeholderPrompt(placeholder), /--file/);
});

test('an ordinary command has no placeholders and runs as written', () => {
  assert.deepEqual(commandPlaceholders(commandArgv('singularity-flow initiative phase define')), []);
});

test('optional-argument brackets are not placeholders', () => {
  // `[PHASE]` means the argument may be omitted, and the command runs correctly without it.
  // Treating it as a placeholder would prompt for something nobody has to supply.
  assert.deepEqual(commandPlaceholders(commandArgv('singularity-flow initiative phase [PHASE]')), []);
});

test('a placeholder with no flag is asked for as text', () => {
  const [placeholder] = commandPlaceholders(commandArgv('singularity-flow initiative approve <SUBJECT>'));
  assert.equal(placeholder.flag, null);
  assert.equal(placeholder.kind, 'text');
});

test('suggested commands preserve quoted values and multi-word placeholders without a shell', () => {
  assert.deepEqual(
    commandArgv('singularity-flow initiative evidence add check-1 --observed-state "Reviewed by product owner" --reason \'ready for delivery\''),
    ['initiative', 'evidence', 'add', 'check-1', '--observed-state', 'Reviewed by product owner', '--reason', 'ready for delivery']
  );
  const argv = commandArgv('singularity-flow initiative evidence add check-1 --observed-state "<WHAT WAS REVIEWED>"');
  assert.equal(argv.at(-1), '<WHAT WAS REVIEWED>');
  assert.equal(commandPlaceholders(argv)[0]?.name, 'WHAT WAS REVIEWED');
  assert.throws(() => commandArgv('singularity-flow reject intake --reason "unfinished'), /unterminated/);
});

test('suggested commands preserve Windows path separators', () => {
  assert.deepEqual(
    commandArgv('singularity-flow documents upload --file "C:\\Users\\Ashok\\brief.md"'),
    ['documents', 'upload', '--file', 'C:\\Users\\Ashok\\brief.md']
  );
  assert.deepEqual(
    commandArgv('singularity-flow documents upload --file C:\\Users\\Ashok\\brief.md'),
    ['documents', 'upload', '--file', 'C:\\Users\\Ashok\\brief.md']
  );
  assert.deepEqual(
    commandArgv('singularity-flow documents upload --file C:\\Program\\ Files\\brief.md'),
    ['documents', 'upload', '--file', 'C:\\Program Files\\brief.md']
  );
});

test('answers are substituted positionally, leaving everything else alone', () => {
  const argv = commandArgv('singularity-flow epic sources add --epic SF-E-001 --file <PATH>');
  const filled = fillPlaceholders(argv, new Map([[6, '/tmp/brief.md']]));
  assert.deepEqual(filled, ['epic', 'sources', 'add', '--epic', 'SF-E-001', '--file', '/tmp/brief.md']);
});

test('pinned sources appear in the tree, and an empty list reads as a finding', () => {
  // Everything a requirement may cite has to be pinned, so nothing pinned is a state worth naming
  // rather than an empty branch.
  const empty = find(buildTree(snapshot), 'sources');
  assert.equal(empty.description, 'none pinned');
  assert.match(empty.tooltip, /no cited source to rest on/);
  assert.equal(empty.children[0].label, 'Nothing is pinned yet');
  assert.equal(empty.contextValue, 'sflow.sources', 'and the node offers to fix it');

  const pinned = structuredClone(snapshot);
  pinned.initiative.sources = {
    version: 1,
    initiativeId: 'INIT-MULTI',
    sources: [{ sourceId: 'SRC-ABC123', name: 'brief.md', provider: 'local', sha256: 'a'.repeat(64) }]
  };
  const group = find(buildTree(pinned), 'sources');
  assert.equal(group.description, '1');
  assert.equal(group.children[0].label, 'brief.md');
  assert.equal(group.children[0].description, 'local');
  assert.match(group.children[0].tooltip, /SRC-ABC123/);
});

test('an empty repository offers to start an Epic rather than describing the command', () => {
  const [, start] = buildTree({ initiative: null, initiatives: [], workItems: [] });
  assert.equal(start.contextValue, 'sflow.start');
  assert.equal(start.runCommand, 'singularityFlow.startWork');
  assert.doesNotMatch(start.tooltip, /singularity-flow/, 'a command to retype is not an affordance');
});






const {
  EMPTY_WORKSPACE_FORM, capabilityChoices, coveredCapabilities, derivedRepositories, effectiveLead,
  formProblems, formCommand, formPrepareCommand, hasCapabilityMap, shippingCapabilities, uncloneable,
  workspaceFormHtml
} = await import(source('views/workspace-form.ts'));
const { startWizardProgress } = await import(source('views/start-wizard.ts'));

/** The organisation's map, as `capability organisation --json` returns it. */
const REMOTE_TREE = [{
  id: 'commerce', name: 'Commerce', repository: null, children: [
    {
      id: 'payments', name: 'Payments', repository: null, children: [
        { id: 'payments-api', name: 'Payments API', repository: 'api', children: [] }
      ]
    },
    { id: 'storefront', name: 'Storefront', repository: null, children: [
      { id: 'storefront-web', name: 'Storefront Web', repository: 'web', children: [] }
    ] }
  ]
}];
const REMOTE_REPOSITORIES = {
  platform: { url: 'https://example.com/platform.git', defaultBranch: 'main' },
  api: { url: 'https://example.com/api.git', defaultBranch: 'main' },
  web: { url: 'https://example.com/web.git', defaultBranch: 'trunk' }
};

const withMap = (selected = [], extra = {}) => ({
  ...EMPTY_WORKSPACE_FORM,
  base: '/work', id: 'checkout-platform', name: 'Checkout platform',
  profileName: 'Casey Contributor', profileRole: 'developer',
  organisations: ['https://example.com/platform.git'],
  organisation: 'https://example.com/platform.git',
  capabilities: capabilityChoices(REMOTE_TREE, REMOTE_REPOSITORIES),
  selected,
  ...extra
});

test('an empty workspace form reports every outstanding requirement at once', () => {
  // Revealing them one at a time is how a five-field form takes five attempts.
  const problems = formProblems(EMPTY_WORKSPACE_FORM);
  assert.match(problems.join(' '), /where the workspace directory/);
  assert.match(problems.join(' '), /identifier/);
  assert.match(problems.join(' '), /display name/);
  assert.match(problems.join(' '), /menu persona/);
  assert.match(problems.join(' '), /organisation/);
});

test('guided start keeps one accessible three-step rail across the governed forms', () => {
  const capability = startWizardProgress({ step: 'capability' });
  assert.match(capability, /Step 1 of 3/);
  assert.match(capability, /class="start-wizard-step current" aria-current="step"/);
  assert.match(capability, /Map capability/);

  const workspace = workspaceFormHtml(withMap(['payments']), {
    step: 'workspace', capabilityId: 'payments'
  });
  assert.match(workspace, /Step 2 of 3/);
  assert.match(workspace, /Capability: payments/);
  assert.equal((workspace.match(/class="start-wizard-step done"/g) ?? []).length, 1);
});

test('workspace creation asks for the person once and keeps menu personas separate from identity', () => {
  const html = workspaceFormHtml(withMap(['payments']));
  assert.match(html, /Your local profile/);
  assert.match(html, /data-field="profile-name"/);
  assert.match(html, /data-field="profile-role"/);
  assert.match(html, /Product owner/);
  assert.match(html, /Admin/);
  assert.match(html, /approval records always use the Git identity/);

  const missing = withMap(['payments'], { profileName: '', profileRole: '' });
  assert.match(formProblems(missing).join(' '), /display name/);
  assert.match(formProblems(missing).join(' '), /menu persona/);
});

test('the organisation map is flattened with each capability\'s depth, ancestors and clone URL', () => {
  const choices = capabilityChoices(REMOTE_TREE, REMOTE_REPOSITORIES);
  assert.deepEqual(choices.map((choice) => choice.id),
    ['commerce', 'payments', 'payments-api', 'storefront', 'storefront-web']);

  const api = choices.find((choice) => choice.id === 'payments-api');
  assert.equal(api.depth, 2);
  assert.deepEqual(api.ancestors, ['commerce', 'payments']);
  assert.equal(api.repository, 'api');
  // The clone URL comes from the portfolio, keyed by the repository the capability names.
  assert.equal(api.url, 'https://example.com/api.git');
  assert.equal(choices.find((choice) => choice.id === 'storefront-web').defaultBranch, 'trunk');
  // A grouping ships from nothing, and says so rather than inventing a repository.
  assert.equal(choices.find((choice) => choice.id === 'commerce').repository, null);
});

test('choosing a capability includes everything beneath it, the way a directory does', () => {
  const form = withMap(['payments']);
  assert.deepEqual(coveredCapabilities(form).map((entry) => entry.id),
    ['payments', 'payments-api']);
  // Choosing the root covers the lot.
  assert.equal(coveredCapabilities(withMap(['commerce'])).length, 5);
});

test('the repositories are what the chosen capabilities ship from — never named by hand', () => {
  // The form has no way to add a repository. Two places to say which repositories are involved is
  // one place for them to disagree.
  const form = withMap(['payments']);
  assert.deepEqual(derivedRepositories(form).map((entry) => entry.id), ['api']);

  // A grouping brings in what is beneath it, so choosing one is choosing its deliveries.
  assert.deepEqual(derivedRepositories(withMap(['storefront'])).map((entry) => entry.id), ['web']);
  assert.deepEqual(derivedRepositories(withMap(['commerce'])).map((entry) => entry.id),
    ['api', 'web']);

  // A grouping with nothing beneath it that ships is a workspace with nothing to work in, and the
  // form refuses rather than creating an empty directory.
  const barren = withMap(['commerce'], {
    capabilities: capabilityChoices([{ id: 'commerce', name: 'Commerce', repository: null, children: [] }], {})
  });
  assert.match(formProblems(barren).join(' '), /None of the chosen capabilities ships/);
});

test('one of the chosen capabilities leads, and its repository carries the state branch', () => {
  const form = withMap(['commerce'], { leadCapability: 'storefront-web' });
  assert.equal(effectiveLead(form).id, 'storefront-web');
  assert.match(formCommand(form).join(' '), /--lead-capability storefront-web/);

  // Only a capability that ships can lead: leading means carrying the branch.
  assert.deepEqual(shippingCapabilities(form).map((entry) => entry.id), ['payments-api', 'storefront-web']);

  // Defaulted rather than demanded — with one shipping capability there is nothing to decide.
  assert.equal(effectiveLead(withMap(['payments'])).id, 'payments-api');
  // A lead left over from a selection that no longer covers it falls back rather than sticking.
  assert.equal(effectiveLead(withMap(['payments'], { leadCapability: 'storefront-web' })).id, 'payments-api');
});

test('a workspace records the capabilities it is for, and the organisation they came from', () => {
  const command = formCommand(withMap(['payments', 'storefront']));
  assert.deepEqual(command.slice(0, 4), ['workspace', 'create', '--local', '--json']);
  assert.match(command.join(' '), /--organisation https:\/\/example\.com\/platform\.git/);
  assert.match(command.join(' '), /--capability payments --capability storefront/);
  // The selection is recorded, not its expansion: a capability added under payments later is picked
  // up by this workspace without editing it.
  assert.equal(command.filter((entry) => entry === '--capability').length, 2);
  assert.match(command.join(' '), /--confirm checkout-platform/);
});

test('the VS Code workspace form prepares and preflights before it materializes', () => {
  const command = formPrepareCommand(withMap(['payments', 'storefront']));
  assert.deepEqual(command.slice(0, 3), [
    'workspace', 'prepare', 'https://example.com/platform.git'
  ]);
  assert.match(command.join(' '), /--id checkout-platform --base \/work/);
  assert.match(command.join(' '), /--capability payments --capability storefront/);
  assert.match(command.join(' '), /--initialize --state-branch state/);
  assert.doesNotMatch(command.join(' '), /--confirm/,
    'preflight must persist before the editor asks for materialization confirmation');
});

test('an organisation read but nothing chosen from cannot be created', () => {
  const form = withMap([]);
  assert.equal(hasCapabilityMap(form), true);
  assert.match(formProblems(form).join(' '), /Choose the capabilities/);
  assert.match(workspaceFormHtml(form), /Nothing chosen yet/);
});

test('a capability shipping from a repository the portfolio does not declare is named, not dropped', () => {
  const form = withMap(['payments'], {
    capabilities: capabilityChoices(REMOTE_TREE, { web: REMOTE_REPOSITORIES.web })
  });
  assert.deepEqual(uncloneable(form).map((entry) => entry.id), ['payments-api']);
  // Silently cloning one fewer repository than was asked for is the failure mode this prevents.
  assert.deepEqual(derivedRepositories(form), []);
  assert.match(formProblems(form).join(' '), /nowhere to clone it from/);
  assert.match(workspaceFormHtml(form), /no clone URL/);
});

test('with no organisation mapped the form says so and offers the screen that fixes it', () => {
  // The chicken-and-egg case: a workspace over capabilities nobody has mapped is a step out of
  // order, not a form to fill in.
  const html = workspaceFormHtml(EMPTY_WORKSPACE_FORM);
  assert.match(html, /No organisation has been mapped yet/);
  assert.match(html, /data-open="capabilities"/);
  // And there is no way to type a repository URL past it.
  assert.doesNotMatch(html, /data-draft="url"/);
  assert.doesNotMatch(html, /Add a repository/);
});

test('a mapped organisation with no capabilities can create its first one in place', () => {
  const form = {
    ...EMPTY_WORKSPACE_FORM,
    base: '/work',
    id: 'rule-ux',
    name: 'Rule UX',
    organisations: ['https://example.com/rules.git'],
    organisation: 'https://example.com/rules.git',
    capabilities: [],
    capabilitiesReason: 'This organisation does not describe what it builds yet.'
  };
  const html = workspaceFormHtml(form);
  assert.match(html, /Create first capability/);
  assert.match(html, /data-open="capabilities"/);
  assert.match(formProblems(form).join(' '), /Create the first capability/);
  assert.doesNotMatch(html, /Map one from the Capabilities screen first/);
});

test('capabilities are picked from a dropdown, and each pick shows what it drags in', () => {
  // A real map runs to dozens; a checkbox table asks a reader to scan all of them to find two.
  const html = workspaceFormHtml(withMap(['payments']));
  assert.match(html, /<select data-capability-pick>/);
  // Already covered, so not offered again.
  assert.doesNotMatch(html, /<option value="payments-api">/);
  assert.match(html, /<option value="storefront">/);
  // What the pick brought with it is shown rather than left to be inferred.
  assert.match(html, /1 beneath it/);
  assert.match(html, /<code>api<\/code>/);
});

test('the state branch is stated as a consequence, not asked for as a field', () => {
  const html = workspaceFormHtml(withMap(['payments']));
  assert.doesNotMatch(html, /data-draft="state-branch"/);
  assert.match(html, /orphan\s+<code>state<\/code> branch is created\s+in <code>api<\/code> and pushed/);
});

test('the workspace form asks for a directory, an organisation and capabilities — no repositories', () => {
  const html = workspaceFormHtml(EMPTY_WORKSPACE_FORM);
  const order = [
    'Working directory', 'Workspace details', 'Your local profile',
    'Organisation', 'Capabilities', 'Repositories'
  ];
  let at = -1;
  for (const heading of order) {
    const next = html.indexOf(heading);
    assert.ok(next > at, `${heading} out of order`);
    at = next;
  }
  // Repositories appear, but as a consequence to confirm rather than a list to curate.
  assert.doesNotMatch(html, /data-remove=/);
  assert.doesNotMatch(html, /data-add=/);
});

test('a single mapped organisation is stated rather than asked about', () => {
  // Asking which of one to use is a question with no information in it.
  assert.match(workspaceFormHtml(withMap(['payments'])), /<code>https:\/\/example\.com\/platform\.git<\/code>/);
  assert.doesNotMatch(workspaceFormHtml(withMap(['payments'])), /data-field="organisation"/);

  const several = withMap(['payments'], {
    organisations: ['https://example.com/platform.git', 'https://example.com/other.git']
  });
  assert.match(workspaceFormHtml(several), /<select data-field="organisation">/);
});

test('a form still missing something disables the button and lists why', () => {
  const html = workspaceFormHtml(withMap([]));
  assert.match(html, /Before this can be created/);
  assert.match(html, /<button data-submit="create" disabled>/);

  const ready = workspaceFormHtml(withMap(['payments']));
  assert.match(ready, /1 repository will be cloned into <code>\/work\/checkout-platform<\/code>/);
  assert.match(ready, /led by <code>Payments API<\/code>/);
  assert.match(ready, /<button data-submit="create" >/);
});

test('while the map is being read the form says so and refuses to be submitted', () => {
  const form = { ...withMap([]), capabilities: null, reading: true };
  assert.match(workspaceFormHtml(form), /Reading the capability map…/);
  assert.match(formProblems(form).join(' '), /Wait for the capability map/);
});

test('a validated stale capability map remains usable and is clearly marked', () => {
  const form = withMap(['payments'], {
    capabilitiesNotice: 'Showing a validated cached capability map (12 minute(s) old); the remote is unreachable.'
  });
  const html = workspaceFormHtml(form);
  assert.match(html, /validated cached capability map/);
  assert.match(html, /remote is unreachable/);
  assert.match(html, /<button data-submit="create" >/,
    'staleness is disclosed without discarding validated offline choices');
});

test('a URL that cannot be read is reported on the form, beside the field it was typed into', () => {
  const form = {
    ...withMap([]),
    error: "Cannot reach 'https://example.com/gone.git': repository not found."
  };
  assert.match(workspaceFormHtml(form), /Cannot reach/);
});


const { isGovernedConfiguration } = await import(source('governed.ts'));


test('governed configuration is recognised, and nothing else is', () => {
  const repository = '/repo';
  for (const governed of [
    'singularity/workflow.yml', 'singularity/portfolio.yml',
    'singularity/agents/architect.md', 'singularity/templates/initiatives/business-case.md',
    'singularity/prompts/copilot-planning.md', '.github/skills/sflow-next/SKILL.md',
    'singularity/agent-mappings.yml'
  ]) {
    assert.equal(isGovernedConfiguration(repository, `${repository}/${governed}`), true, governed);
  }

  for (const other of [
    'README.md', 'src/index.ts',
    // Generated and governed state are not configuration and must not be validated as though they
    // were — editing them is a different problem with a different answer.
    'singularity/world-model/manifest.json',
    'singularity/initiatives/SF-E-001/state.json'
  ]) {
    assert.equal(isGovernedConfiguration(repository, `${repository}/${other}`), false, other);
  }

  assert.equal(isGovernedConfiguration(repository, '/elsewhere/singularity/workflow.yml'), false,
    'a path outside the repository is never governed configuration');
});

const { buildApprovals } = await import(source('views/approvals-model.ts'));
const { buildInbox, buildInboxTree } = await import(source('views/inbox-model.ts'));

test('a submitted Story phase appears in the same approval inbox with its exact artifact', () => {
  const shot = storySnapshot({ status: 'awaiting_approval', generation: 1 });
  shot.workflow.lineage = { submissions: [{
    packetSha256: 'b'.repeat(64), phase: 'design', generation: 1,
    projection: { sourceCommit: 'c'.repeat(40) }
  }] };
  const approvals = buildApprovals(shot);
  assert.equal(approvals.initiativeId, 'STORY-42');
  assert.equal(approvals.pending.length, 1);
  assert.deepEqual({
    source: approvals.pending[0].source,
    phase: approvals.pending[0].phase,
    expected: approvals.pending[0].expected,
    standing: approvals.pending[0].standing
  }, { source: 'story', phase: 'design', expected: 'design', standing: 'yours' });
  assert.equal(approvals.pending[0].artifactPath,
    'singularity/work-items/STORY-42/artifacts/design/design.md');
  assert.equal(approvals.pending[0].reviewPacketSha256, 'b'.repeat(64));
  assert.equal(approvals.pending[0].submittedSourceCommit, 'c'.repeat(40));
  assert.deepEqual(approvals.pending[0].rejectTo, ['intake', 'design']);
  assert.match(approvals.pending[0].detail, /packet b{12}/);

  const inbox = buildInbox(shot);
  assert.equal(inbox.subjectId, 'STORY-42');
  assert.equal(inbox.approvals.pending[0].source, 'story');
  assert.deepEqual(inbox.groups.map((group) => group.phase), ['design']);
});

/** A snapshot with one artifact awaiting a decision under a named authority. */
function awaiting({ authorities = ['product-approvers'], members = ['me@example.com'], actor = 'me@example.com', generatedBy = null, chain = null, gateErrors = [] } = {}) {
  const shot = structuredClone(snapshot);
  shot.identities = { git: { email: actor } };
  shot.portfolio = { approvalAuthorities: { 'product-approvers': { members: members.map((email) => ({ email })) } } };
  shot.initiative.state.phases.define.outputs['business-case'].sha256 = 'a'.repeat(64);
  shot.initiative.state.phases.define.outputs['business-case'].status = 'published';
  shot.initiative.state.phases.define.outputs['business-case'].generatedBy = generatedBy;
  const declared = shot.initiative.state.resolution.phases.find((phase) => phase.id === 'define');
  declared.outputs.find((output) => output.id === 'business-case').approval =
    { mode: 'individual', authorities, minimum: 1, allowSelfApproval: true, chain };
  shot.initiative.phaseGate = { ready: false, errors: gateErrors, warnings: [], passes: [] };
  shot.initiative.report = { approvals: { byPhase: {} } };
  return shot;
}

test('an approval you may sign is yours; one you may not names who is being waited on', () => {
  // The question a reviewer opens this to ask is "is anything waiting for me". Everything else is
  // context for that.
  const mine = buildApprovals(awaiting());
  assert.equal(mine.pending.length, 1);
  assert.equal(mine.pending[0].standing, 'yours');
  assert.equal(mine.pending[0].expected, 'define:business-case');
  assert.equal(mine.pending[0].reason, null);

  const theirs = buildApprovals(awaiting({ members: ['someone.else@example.com'] }));
  assert.equal(theirs.pending[0].standing, 'others');
  assert.match(theirs.pending[0].reason, /Waiting on product-approvers/);
});

test('an approval with no configured authority cannot proceed, and says so', () => {
  // A configuration gap, not a decision anybody can take — presenting it as actionable would send
  // a reviewer to a refusal.
  const orphan = buildApprovals(awaiting({ authorities: [] }));
  assert.equal(orphan.pending[0].standing, 'blocked');
  assert.match(orphan.pending[0].reason, /No approval authority is configured/);
});

test('approving your own work is flagged before you decide, not after', () => {
  const own = buildApprovals(awaiting({ generatedBy: 'me@example.com' }));
  assert.equal(own.pending[0].selfApproval, true);
  assert.equal(own.pending[0].standing, 'yours', 'still yours to sign — just not independent');

  const someoneElses = buildApprovals(awaiting({ generatedBy: 'other@example.com' }));
  assert.equal(someoneElses.pending[0].selfApproval, false);
});

test('the open chain step is read from the gate rather than recomputed', () => {
  // The report drops the chainStep each decision recorded, so recomputing would mean guessing which
  // body signed. The gate already composes the answer and is what actually blocks the phase.
  const chain = [
    { authority: 'product-approvers', label: 'Product Governance', minimum: 1 },
    { authority: 'executive-approvers', label: 'Executive Decisioning', minimum: 1 }
  ];
  const shot = awaiting({
    chain,
    gateErrors: ['output define/business-case has waiting on Executive Decisioning (0/1) for exact output abc123']
  });
  const [approval] = buildApprovals(shot).pending;
  assert.deepEqual(approval.chain.map((step) => [step.label, step.satisfied, step.open]), [
    ['Product Governance', true, false],
    ['Executive Decisioning', false, true]
  ]);
  // Alice sits on product-approvers only, and the open step is the executive one.
  assert.equal(approval.standing, 'others');
  assert.match(approval.reason, /Executive Decisioning \(0\/1\)/);
});

test('yours is listed before anything you cannot act on', () => {
  const shot = awaiting({ members: ['me@example.com'] });
  // A second artifact nobody can sign.
  shot.initiative.state.phases.define.outputs['scope-and-outcomes'].sha256 = 'b'.repeat(64);
  shot.initiative.state.phases.define.outputs['scope-and-outcomes'].status = 'published';
  const declared = shot.initiative.state.resolution.phases.find((phase) => phase.id === 'define');
  declared.outputs.find((output) => output.id === 'scope-and-outcomes').approval =
    { mode: 'individual', authorities: [], minimum: 1, allowSelfApproval: true, chain: null };

  const standings = buildApprovals(shot).pending.map((approval) => approval.standing);
  assert.deepEqual(standings, ['yours', 'blocked']);
});

test('gate problems that are not approvals are listed separately', () => {
  const shot = awaiting({
    gateErrors: ['checklist define/scope-agreed is missing', 'output define/x has 0/1 approvals']
  });
  const approvals = buildApprovals(shot);
  // An approval count is an approval; a missing checklist is something else to go and do.
  assert.deepEqual(approvals.obstacles, ['checklist define/scope-agreed is missing']);
});

test('a phase whose gate is ready becomes the decision that is waiting', () => {
  // A ready gate means every requirement is met and the phase itself is what is now outstanding.
  // Reporting "nothing is waiting" at that moment would hide the one decision left.
  const ready = structuredClone(snapshot);
  ready.identities = { git: { email: 'me@example.com' } };
  ready.portfolio = { approvalAuthorities: { 'product-approvers': { members: [{ email: 'me@example.com' }] } } };
  ready.initiative.phaseGate = { ready: true, errors: [], warnings: [], passes: [], bundleSha256: 'c'.repeat(64) };
  ready.initiative.report = { approvals: { byPhase: {} } };
  const declared = ready.initiative.state.resolution.phases.find((phase) => phase.id === 'define');
  declared.bundleApproval = { mode: 'bundle', authorities: ['product-approvers'], minimum: 1, allowSelfApproval: true, chain: null };

  const [approval] = buildApprovals(ready).pending;
  assert.equal(approval.kind, 'phase');
  assert.equal(approval.expected, 'define:phase');
  assert.equal(approval.standing, 'yours');
  assert.match(approval.detail, /closes it and opens the next/);
});

test('an Epic with nothing outstanding says so rather than showing an empty page', () => {
  const quiet = structuredClone(snapshot);
  // Approved phase, ready gate: there is genuinely nothing to decide.
  quiet.initiative.state.phases.define.status = 'approved';
  quiet.initiative.phaseGate = { ready: true, errors: [], warnings: [], passes: [] };
  quiet.initiative.report = { approvals: { byPhase: {} } };
  assert.match(buildApprovals(quiet).empty ?? '', /Nothing is waiting/);
  assert.match(buildApprovals(null).empty, /Reading the repository/);
});

test('the business inbox joins decisions to every generated artifact without listing empty templates', () => {
  const shot = awaiting();
  const generated = shot.initiative.documents.find((document) => document.id === 'business-case');
  Object.assign(generated, {
    status: 'published', generation: 2, sha256: 'a'.repeat(64),
    generatedBy: 'analyst@example.com', content: '# Business case\n'
  });
  shot.documents = [{
    id: 'PHASE-IMPLEMENTATION', type: 'artifact', label: 'Implementation', kind: 'markdown',
    path: 'singularity/work-items/WORK-123/artifacts/implementation/implementation.md',
    phase: 'implementation', status: 'approved', generation: 1, sha256: 'b'.repeat(64)
  }];

  const inbox = buildInbox(shot);
  assert.equal(inbox.approvals.pending.filter((approval) => approval.standing === 'yours').length, 1);
  assert.deepEqual(inbox.artifacts.map((artifact) => artifact.label), ['Business case', 'Implementation']);
  assert.equal(inbox.artifacts.find((artifact) => artifact.label === 'Business case').generation, 2);
  assert.equal(inbox.artifacts.some((artifact) => artifact.label === 'Scope and outcomes'), false,
    'declared but unwritten templates are not presented as generated output');
  assert.deepEqual(inbox.groups.map((group) => group.phase), ['define', 'implementation']);
  assert.deepEqual(inbox.workItems.map((item) => item.workId), ['INIT-MULTI', 'WORK-123']);
  assert.deepEqual(inbox.workItems.find((item) => item.workId === 'WORK-123').groups
    .map((group) => group.phase), ['implementation']);
});

test('the sidebar inbox exposes the combined page and opens exact generated paths', () => {
  const shot = structuredClone(snapshot);
  const output = shot.initiative.documents.find((document) => document.id === 'business-case');
  Object.assign(output, { status: 'approved', generation: 1, sha256: 'c'.repeat(64) });
  const tree = buildInboxTree(shot);
  assert.equal(tree[0].runCommand, 'singularityFlow.openInbox');
  assert.match(tree[0].description, /1 generated/);
  const work = tree[1].children[0];
  assert.equal(work.label, 'INIT-MULTI');
  const artifact = work.children[0].children[0];
  assert.equal(artifact.path, output.repositoryPath);
  assert.equal(artifact.readOnly, true);
});

test('the sidebar and full inbox list active Stories without mixing their artifacts', async () => {
  const shot = storySnapshot({ generation: 1 });
  shot.workItems[0].status = 'in_progress';
  shot.workItems[0].currentPhase = 'design';
  shot.workItems.push({
    id: 'CFA-STORY', title: 'Calculate compound interest', status: 'in_progress',
    currentPhase: 'intake', branch: 'CFA-STORY'
  });

  const tree = buildInboxTree(shot);
  const active = find(tree, 'inbox:active-stories');
  assert.equal(active.description, '2');
  assert.match(find(tree, 'inbox:active-story:STORY-42').description, /current/);
  assert.deepEqual(find(tree, 'inbox:active-story:CFA-STORY').command,
    ['session', 'attach', 'CFA-STORY']);
  assert.equal(find(tree, 'inbox:generated').description, '1',
    'only the selected Story artifact snapshot is rendered');
  assert.equal(find(tree, 'inbox:work:CFA-STORY'), undefined,
    'an unselected Story is a navigation row, not a fabricated artifact catalog');

  const inbox = buildInbox(shot);
  assert.deepEqual(inbox.activeStories.map((story) => [story.workId, story.current]), [
    ['STORY-42', true], ['CFA-STORY', false]
  ]);
  const surface = await readFile(source('views/inbox.ts'), 'utf8');
  assert.match(surface, /Active Stories/);
  assert.match(surface, /data-story=/);
  assert.match(surface, /aria-current="page"/);
  assert.match(surface, /Open checkout/);
  assert.match(surface, /'attach-story'/);
});

const { buildStories } = await import(source('views/stories-model.ts'));

test('Stories group by the repository they land in, and keep both ends of each dependency', () => {
  // The plan records what a Story waits for; who waits on it is just as useful and has to be
  // derived, because nothing stores the reverse edge.
  const stories = buildStories(snapshot);
  assert.deepEqual(stories.groups.map((group) => group.repository), ['api', 'mobile']);

  const api = stories.groups[0].stories[0];
  assert.equal(api.planId, 'API-1');
  assert.deepEqual(api.dependsOn, []);
  assert.deepEqual(api.blocks, ['MOB-1'], 'the reverse edge is derived');

  const mobile = stories.groups[1].stories.find((story) => story.planId === 'MOB-1');
  assert.deepEqual(mobile.dependsOn, ['API-1']);
  assert.deepEqual(mobile.blocks, []);
});

test('a planned Story is not shown as though it had a branch', () => {
  // Before materialization a Story is an intention: an identifier, a repository, an allocation.
  // Showing an intention as though it had a branch is the more expensive of the two mistakes.
  const planned = buildStories(snapshot);
  assert.equal(planned.materialized, false);
  for (const story of planned.groups.flatMap((group) => group.stories)) {
    assert.equal(story.state, 'planned');
    assert.equal(story.branch, null);
    assert.equal(story.head, null);
  }
});

test('a materialized Story carries its branch, head and phase', () => {
  const materialized = structuredClone(snapshot);
  materialized.initiative.state.childStories = {
    'API-1': {
      workId: 'API-1', repository: 'api', branch: 'API-1', status: 'in-progress',
      currentPhase: 'implementation-spec', seedCommit: 'aaaa1111', observedCommit: 'bbbb2222',
      stale: false, conformance: { status: 'approved', treeSha256: 'cc'.repeat(32) }
    },
    'MOB-1': {
      workId: 'MOB-1', repository: 'mobile', branch: 'MOB-1', status: 'seeded',
      seedCommit: 'dddd3333', observedCommit: 'dddd3333', stale: false
    }
  };
  const stories = buildStories(materialized);
  assert.equal(stories.materialized, true);

  const api = stories.groups[0].stories.find((story) => story.planId === 'API-1');
  assert.equal(api.state, 'in-progress');
  assert.equal(api.head, 'bbbb2222');
  assert.equal(api.atSeed, false, 'it has moved on from its seed, which is the work');
  assert.equal(api.phase, 'implementation-spec');
  assert.equal(api.conformance.status, 'approved');

  const mobile = stories.groups[1].stories.find((story) => story.planId === 'MOB-1');
  assert.equal(mobile.state, 'seeded');
  assert.equal(mobile.atSeed, true);
  assert.equal(mobile.conformance, null, 'no conformance phase reached yet');
});

test('a blocked child Story is reported as blocked whatever its phase says', () => {
  const blocked = structuredClone(snapshot);
  blocked.initiative.state.childStories = {
    'API-1': { workId: 'API-1', repository: 'api', status: 'in-progress', currentPhase: 'build', blocked: true }
  };
  const story = buildStories(blocked).groups[0].stories.find((entry) => entry.planId === 'API-1');
  assert.equal(story.state, 'blocked');
});

test('the merge order respects dependencies and is stable', () => {
  const order = buildStories(snapshot).order;
  assert.ok(order.indexOf('API-1') < order.indexOf('MOB-1'), 'a Story lands after what it waits for');
  assert.deepEqual(buildStories(snapshot).order, order, 'the same plan reads the same way twice');
});

test('an Epic with no Story plan says what planning would produce', () => {
  const unplanned = structuredClone(snapshot);
  unplanned.initiative.breakdown = null;
  const stories = buildStories(unplanned);
  assert.match(stories.empty, /decomposes it into Stories, one per repository/);
  assert.equal(stories.initiativeId, 'INIT-MULTI', 'and still says which Epic it is talking about');
});




test('a locally pinned source can be opened; a remote one has no path to open', () => {
  const pinned = structuredClone(snapshot);
  pinned.initiative.sources = {
    version: 1, initiativeId: 'INIT-MULTI',
    sources: [
      { sourceId: 'SRC-LOCAL', name: 'brief.md', provider: 'local', sha256: 'a'.repeat(64), cachePath: 'singularity/initiatives/INIT-MULTI/sources/blobs/aa/brief.md' },
      { sourceId: 'SRC-REMOTE', name: 'spec.pdf', provider: 'sharepoint', sha256: 'b'.repeat(64) }
    ]
  };
  const sources = find(buildTree(pinned), 'sources');
  assert.equal(sources.children[0].path, 'singularity/initiatives/INIT-MULTI/sources/blobs/aa/brief.md');
  assert.equal(sources.children[1].path, undefined, 'its bytes live in corporate storage');
});

/**
 * The capability map is rendered by the Capabilities view, and only there.
 *
 * It used to appear inside the Lifecycle tree as well, identical and duplicated. A capability is
 * what the organisation builds; it is not a stage of anything, so it has no business in a view
 * about stages — and two renderings of one thing is two places for them to disagree.
 */
test('the capability map is shown as the tree it is, to any depth', () => {
  const withMap = structuredClone(snapshot);
  withMap.capabilityMap = {
    repositories: ['api', 'web'],
    capabilities: [{
      id: 'commerce', name: 'Commerce', kind: 'collection', children: [{
        id: 'storefront', name: 'Storefront', kind: 'collection', children: [
          { id: 'checkout', name: 'Checkout', kind: 'delivery', repository: 'web', children: [] }
        ]
      }, { id: 'payments-api', name: 'Payments', kind: 'delivery', repository: 'api', children: [] }]
    }]
  };
  const tree = buildCapabilityTree(withMap);
  assert.deepEqual(tree.map((node) => node.label), ['Commerce']);

  // Three levels deep, and the leaf names the repository it ships from.
  const checkout = find(tree, 'capability:checkout');
  assert.equal(checkout.description, 'web');
  assert.equal(checkout.contextValue, 'sflow.capability');
  assert.match(checkout.tooltip, /Ships from web/);

  const storefront = find(tree, 'capability:storefront');
  assert.equal(storefront.description, undefined, 'a grouping ships nothing of its own');
  assert.equal(storefront.contextValue, 'sflow.capability');

  // And it is not in the Lifecycle tree at all any more.
  assert.equal(buildTree(withMap).some((node) => node.id === 'capabilities'), false);
});

test('a repository that has not described what it builds says so', () => {
  const [undescribed] = buildCapabilityTree(snapshot);
  assert.equal(undescribed.id, 'capabilities:empty');
  assert.match(undescribed.label, /Nothing describes what this organisation builds/);
});

test('a capability map that does not validate reports the engine reason', () => {
  const broken = structuredClone(snapshot);
  broken.capabilityMap = { error: "Delivery capability 'ghost' names repository 'nope', which the portfolio does not declare." };
  const [node] = buildCapabilityTree(broken);
  assert.equal(node.id, 'capabilities:error');
  assert.match(node.label, /which the portfolio does not declare/);
});

/**
 * Lifecycle holds work and the shapes work can take. Nothing else.
 *
 * It used to hold the capability map and the world model too — one is what the organisation builds,
 * the other is grounding for prompts, and neither is a stage. Both moved to the views they belong
 * in. Workflows stayed: the question a workflow answers — what kind of work is this? — is asked at
 * the moment of starting, in this view, and a list of what you can start is not a settings file.
 */


const { capabilityDetail, capabilityArgv, capabilityProposalArgv, parentChoices, flattenCapabilities } =
  await import(source('views/capability-model.ts'));
const { bodyHtml: capabilitiesHtml, readEdits, SCRIPT: CAPABILITY_SCRIPT } =
  await import(source('views/capability-page.ts'));
const { buildCapabilityDashboard } = await import(source('views/capability-dashboard-model.ts'));
const { EMPTY_MAP_FORM, MAP_CAPABILITY_SCRIPT, capabilityIdentifierProblem, mapCapabilityHtml, mapCommand, mapProblems } =
  await import(source('views/map-capability-form.ts'));

/** The tree the engine emits, with both policies on every node, as capabilityTree() produces it. */
const capabilityFixture = [{
  id: 'commerce', name: 'Commerce', kind: 'collection', delivery: false, repository: null,
  metadata: {}, jira: null, teams: ['Commerce leadership'], owns: [],
  policy: { gateSeverity: 'block', approvalMinimum: 2, protectedPaths: ['singularity/workflow.yml'] },
  effectivePolicy: { gateSeverity: 'block', approvalMinimum: 2, protectedPaths: ['singularity/workflow.yml'] },
  children: [{
    id: 'payments', name: 'Payments', kind: 'collection', delivery: false, repository: null,
    metadata: { applicationId: 'APP-1001', costCenter: 'CC-42' },
    jira: { projectKey: 'PAY', board: 'Payments board' }, teams: ['Payments squad'], owns: [],
    policy: { approvalMinimum: 1, protectedPaths: ['src/payments/**'] },
    effectivePolicy: {
      gateSeverity: 'block', approvalMinimum: 2,
      protectedPaths: ['singularity/workflow.yml', 'src/payments/**']
    },
    children: [{
      id: 'payments-api', name: 'Payments API', kind: 'delivery', delivery: true, repository: 'api',
      metadata: {}, jira: null, teams: [], owns: [],
      policy: {},
      effectivePolicy: {
        gateSeverity: 'block', approvalMinimum: 2,
        protectedPaths: ['singularity/workflow.yml', 'src/payments/**']
      },
      children: []
    }]
  }]
}];

test('mapping a capability defaults Kind to Delivery', () => {
  assert.equal(EMPTY_MAP_FORM.kind, 'delivery');
  assert.equal(EMPTY_MAP_FORM.cloneMode, 'full');
  assert.equal(EMPTY_MAP_FORM.cloneFallback, 'refuse');
  assert.match(mapCapabilityHtml(EMPTY_MAP_FORM),
    /<option value="delivery" selected>Delivery<\/option>/);
});

test('guided capability mapping is visibly the first step', () => {
  const html = mapCapabilityHtml(EMPTY_MAP_FORM, { step: 'capability' });
  assert.match(html, /Capability → workspace → first work item/);
  assert.match(html, /Step 1 of 3/);
});

test('mapping a monorepo capability carries source scope and clone policy into one reviewed proposal', () => {
  const form = {
    ...EMPTY_MAP_FORM,
    lead: 'https://git.example/platform.git', loaded: true,
    capabilityId: 'payments', repositoryUrl: 'https://git.example/platform.git',
    sourceRoots: 'apps/payments', sharedRoots: 'packages/contracts',
    cloneMode: 'blobless-sparse', sparseCone: 'apps/payments, packages/contracts',
    cloneFallback: 'refuse'
  };
  assert.deepEqual(mapProblems(form), []);
  const command = mapCommand(form);
  assert.deepEqual(command.slice(command.indexOf('--source-roots'), command.indexOf('--source-roots') + 4), [
    '--source-roots', 'apps/payments', '--shared-roots', 'packages/contracts'
  ]);
  assert.ok(command.includes('--clone-mode'));
  assert.ok(command.includes('blobless-sparse'));
  assert.ok(command.includes('--sparse-cone'));
  assert.match(mapCapabilityHtml(form), /World-model application roots/);
  assert.match(mapCapabilityHtml(form), /Blobless \+ sparse checkout/);
});

test('mapping a capability selects the only map repository without a separate read step', () => {
  const lead = 'https://git.example/platform.git';
  const html = mapCapabilityHtml({
    ...EMPTY_MAP_FORM, leads: [lead], lead, loaded: true, capabilityId: 'commerce'
  });

  assert.doesNotMatch(html, /Where the map lives/);
  assert.doesNotMatch(html, /Read the map/);
  assert.match(html, /Selected automatically because it is the only available capability map/);
  assert.match(html, /Only available capability-map repository/);
});

test('capability metadata is included in remote map proposals and incomplete pairs are blocked', () => {
  const form = {
    ...EMPTY_MAP_FORM,
    lead: 'https://git.example/platform.git', loaded: true,
    capabilityId: 'commerce', kind: 'collection', metadata: [
      { key: 'applicationId', value: 'APP-1001' },
      { key: 'costCenter', value: 'CC-42' }
    ]
  };
  assert.deepEqual(mapCommand(form).slice(-4),
    ['--metadata', 'applicationId=APP-1001', '--metadata', 'costCenter=CC-42']);
  const html = mapCapabilityHtml(form);
  assert.match(html, /Additional metadata/);
  assert.match(html, /APP-1001/);
  assert.match(html, /singularity\/capabilities\.yml/);
  assert.match(html, /sflow\/config/);
  assert.ok(mapProblems({ ...form, metadata: [{ key: 'applicationId', value: '' }] })
    .includes('Metadata row 1 requires both a key and a value.'));
});

test('the capability designer routes every mutation through the reviewed organisation proposal', () => {
  const lead = 'https://git.example/platform.git';
  assert.deepEqual(
    capabilityProposalArgv('set', 'payments', lead, { name: ' Payments ' }),
    ['capability', 'edit', 'payments', '--lead', lead, '--mode', 'set', '--name', 'Payments', '--json']);
  assert.deepEqual(
    capabilityProposalArgv('add', 'ledger', lead, { parent: 'payments', kind: 'collection' }),
    ['capability', 'edit', 'ledger', '--lead', lead, '--mode', 'add',
      '--kind', 'collection', '--parent', 'payments', '--json']);
  assert.deepEqual(
    capabilityProposalArgv('remove', 'ledger', lead),
    ['capability', 'edit', 'ledger', '--lead', lead, '--mode', 'remove', '--json']);
  assert.deepEqual(
    capabilityProposalArgv('remove', 'payments', lead, {}, { reparentChildrenTo: 'commerce' }),
    ['capability', 'edit', 'payments', '--lead', lead, '--mode', 'remove',
      '--reparent-children-to', 'commerce', '--json']);
  assert.deepEqual(
    capabilityProposalArgv('remove', 'commerce', lead, {}, { reparentChildrenTo: null }),
    ['capability', 'edit', 'commerce', '--lead', lead, '--mode', 'remove',
      '--reparent-children-to', '', '--json']);
});

test('mapping a capability asks which map to use only when multiple maps exist', () => {
  const html = mapCapabilityHtml({
    ...EMPTY_MAP_FORM,
    leads: ['https://git.example/platform.git', 'https://git.example/retail.git'],
    kind: 'delivery', repositoryUrl: 'https://git.example/payments.git'
  });

  assert.match(html, /<select data-map="lead">/);
  assert.match(html, /More than one capability map is available/);
  assert.match(html, /Choose one of the available capability-map repositories/);
  assert.ok(mapProblems({
    ...EMPTY_MAP_FORM,
    leads: ['https://git.example/platform.git', 'https://git.example/retail.git'],
    kind: 'delivery', repositoryUrl: 'https://git.example/payments.git'
  }).includes('Choose which repository stores the capability map.'));
});

test('the shipping repository can become the first capability-map repository in place', () => {
  const repository = 'https://git.example/payments.git';
  const html = mapCapabilityHtml({
    ...EMPTY_MAP_FORM,
    kind: 'delivery', repositoryUrl: repository, lead: repository, loaded: true,
    capabilityId: 'payments-api'
  });

  assert.match(html, /Repository it ships from/);
  assert.match(html, /data-use-shipping-repository checked/);
  assert.match(html, /Use this repository for the capability map/);
  assert.doesNotMatch(html, /Choose which repository stores the capability map/);
});

test('remote capability mapping may create another top-level capability', () => {
  const form = {
    ...EMPTY_MAP_FORM,
    lead: 'https://git.example/platform.git',
    loaded: true,
    capabilityId: 'rule-engine',
    kind: 'collection',
    parents: [{ id: 'calculator', name: 'Calculator', depth: 0 }],
    parent: ''
  };

  assert.deepEqual(mapProblems(form), []);
  assert.doesNotMatch(mapCommand(form).join(' '), /--parent/);
  const html = mapCapabilityHtml(form);
  assert.match(html, /<option value="" selected>Top level \(no parent\)<\/option>/);
  assert.match(html, /<option value="calculator">Calculator<\/option>/);
});

test('capability identifier validation updates in place without reloading the webview', () => {
  const repository = 'https://git.example/rule-ui.git';
  const base = {
    ...EMPTY_MAP_FORM,
    kind: 'delivery', repositoryUrl: repository, lead: repository, loaded: true
  };

  assert.equal(capabilityIdentifierProblem({ ...base, capabilityId: 'RuleUX' }),
    'The identifier must be lower-case kebab-case, like payments-api.');
  assert.equal(capabilityIdentifierProblem({ ...base, capabilityId: 'rule-ux' }), null);

  const blocked = mapCapabilityHtml(base);
  assert.match(blocked, /<li data-map-identifier-problem>Give the capability an identifier\.<\/li>/);
  assert.match(blocked, /data-map-submit="1"[^>]* disabled/);

  const ready = mapCapabilityHtml({ ...base, capabilityId: 'rule-ux' });
  assert.match(ready, /<li data-map-identifier-problem hidden><\/li>/);
  assert.doesNotMatch(ready, /data-map-submit="1"[^>]* disabled/);
  assert.match(MAP_CAPABILITY_SCRIPT, /syncIdentifierValidation/);
  assert.match(MAP_CAPABILITY_SCRIPT, /submit\.disabled = hasProblems/);
});

test('a declared policy value an ancestor overrides is shown as overridden, not as what was written', () => {
  // The whole reason this screen exists. `payments` asks for one approval beneath a parent demanding
  // two, and will be held to two — the file says nothing about that.
  const detail = capabilityDetail(capabilityFixture, 'payments');
  const minimum = detail.policy.find((field) => field.key === 'approvalMinimum');
  assert.equal(minimum.declared, 1);
  assert.equal(minimum.effective, 2);
  assert.equal(minimum.overridden, true);
  assert.match(minimum.rule, /largest demanded by any ancestor/);

  // Inherited-but-not-declared is not an override: nothing here was contradicted.
  const severity = detail.policy.find((field) => field.key === 'gateSeverity');
  assert.equal(severity.declared, null);
  assert.equal(severity.effective, 'block');
  assert.equal(severity.overridden, false);

  // A union that grew is still the child's declaration honoured, plus the ancestor's — but it is not
  // what was written, so the reader is told.
  const paths = detail.policy.find((field) => field.key === 'protectedPaths');
  assert.deepEqual(paths.effective, ['singularity/workflow.yml', 'src/payments/**']);
  assert.equal(paths.overridden, true);

  // Fields nobody set anywhere are omitted. Twenty empty rules would teach nothing.
  assert.equal(detail.policy.some((field) => field.key === 'tokenBudget'), false);
});

test('a capability reports what it ships, at any depth beneath it', () => {
  assert.deepEqual(capabilityDetail(capabilityFixture, 'commerce').ships,
    [{ id: 'payments-api', repository: 'api' }]);
  assert.deepEqual(capabilityDetail(capabilityFixture, 'payments-api').ships,
    [{ id: 'payments-api', repository: 'api' }], 'a leaf ships itself');
  assert.deepEqual(capabilityDetail(capabilityFixture, 'commerce').ancestors, []);
  assert.deepEqual(capabilityDetail(capabilityFixture, 'payments-api').ancestors, ['commerce', 'payments']);
  assert.deepEqual(capabilityDetail(capabilityFixture, 'payments').parent,
    { id: 'commerce', name: 'Commerce' });
  assert.deepEqual(capabilityDetail(capabilityFixture, 'payments').children,
    [{ id: 'payments-api', name: 'Payments API', kind: 'delivery', repository: 'api' }]);
  assert.equal(capabilityDetail(capabilityFixture, 'gone'), null);
});

test('Jira and teams are read from the capability, which is where they belong', () => {
  const detail = capabilityDetail(capabilityFixture, 'payments');
  assert.deepEqual(detail.metadata, { applicationId: 'APP-1001', costCenter: 'CC-42' });
  assert.deepEqual(detail.jira, { projectKey: 'PAY', board: 'Payments board' });
  assert.deepEqual(detail.teams, ['Payments squad']);
  assert.equal(detail.delivery, false);
  assert.equal(capabilityDetail(capabilityFixture, 'payments-api').delivery, true);
});

test('the parent chooser offers every capability except moves that would create a cycle', () => {
  // Moving a capability beneath itself or its own descendant is a cycle. Shipping from a repository
  // does not make a capability a leaf, so it remains a valid relationship target.
  const offered = parentChoices(capabilityFixture, 'payments').map((choice) => choice.id);
  assert.deepEqual(offered, ['commerce']);

  const forNew = parentChoices(capabilityFixture, null).map((choice) => choice.id);
  assert.deepEqual(forNew, ['commerce', 'payments', 'payments-api']);
});

test('the capability editor uses controlled kinds and makes its relationship editable', () => {
  const edit = capabilitiesHtml(capabilityFixture, 'payments-api', null);
  assert.match(edit, /<select data-field="kind"/);
  assert.match(edit, /<option value="delivery" selected>Delivery<\/option>/);
  assert.doesNotMatch(edit, /<input[^>]+data-field="kind"/);
  assert.match(edit, /Linked under/);
  assert.match(edit, /Top level \(no parent\)/);
  assert.match(edit, /Relink this capability at any time/);
  assert.match(edit, /<option value="commerce">Commerce<\/option>/);
  assert.match(edit, /<option value="payments" selected>/);
  const metadata = capabilitiesHtml(capabilityFixture, 'payments', null);
  assert.match(metadata, /Additional metadata/);
  assert.match(metadata, /applicationId/);
  assert.match(metadata, /APP-1001/);
  assert.match(metadata, /lead repository's <code>sflow\/config<\/code> branch/);
});

test('an empty field is sent as a clearance, and an untouched one is not sent at all', () => {
  // Turning a Delivery into a Collection clears its repository in the same validated edit.
  assert.deepEqual(
    capabilityArgv('set', 'payments-api', { kind: 'collection', repository: '', teams: 'Payments squad, Platform' }),
    ['capability', 'set', 'payments-api', '--kind', 'collection', '--repository', '', '--teams', 'Payments squad, Platform']);
  assert.deepEqual(capabilityArgv('set', 'payments', { name: ' Payments ' }),
    ['capability', 'set', 'payments', '--name', 'Payments']);
  assert.deepEqual(capabilityArgv('set', 'payments', { parent: '' }),
    ['capability', 'set', 'payments', '--parent', ''],
    'clearing the parent moves an existing capability to the top level');
  assert.deepEqual(capabilityArgv('remove', 'payments'), ['capability', 'remove', 'payments']);
  assert.deepEqual(
    capabilityArgv('remove', 'payments', {}, { reparentChildrenTo: 'commerce' }),
    ['capability', 'remove', 'payments', '--reparent-children-to', 'commerce']);
  assert.deepEqual(capabilityArgv('add', 'ledger', { parent: 'payments', kind: 'collection' }),
    ['capability', 'add', 'ledger', '--kind', 'collection', '--parent', 'payments']);
  assert.deepEqual(capabilityArgv('set', 'payments', {
    metadata: JSON.stringify([['costCenter', ''], ['ownerCode', 'PZN']])
  }), ['capability', 'set', 'payments', '--metadata', 'costCenter=', '--metadata', 'ownerCode=PZN']);
  assert.throws(() => capabilityArgv('set', 'payments', { metadata: '{bad' }),
    /metadata must be a JSON array/);
});

test('the page cannot widen what an edit writes', () => {
  // Messages from a webview are claims, not instructions. Only the named fields survive.
  assert.deepEqual(
    readEdits({ name: 'Payments', metadata: '[["applicationId","APP-1001"]]',
      policy: 'gateSeverity: off', __proto__: 'x', teams: 42 }),
    { name: 'Payments', metadata: '[["applicationId","APP-1001"]]' });
  assert.deepEqual(readEdits(null), {});
});

test('the capability screen shows declared beside effective, and names the override', () => {
  const html = capabilitiesHtml(capabilityFixture, 'payments', null);
  assert.match(html, /Approvals required/);
  assert.match(html, /the largest demanded by any ancestor/);
  assert.match(html, /overridden by an ancestor and will not apply as written/);
  // Both values are on the page: the one written and the one that applies.
  assert.match(html, /<td class="muted">1<\/td>\s*<td><strong>2<\/strong><\/td>/);
  assert.match(html, /Payments board/);
  assert.match(html, /Payments squad/);

  // Policy is not editable here, and the screen says where it is edited rather than staying silent.
  assert.equal(/data-field="policy/.test(html), false);
  assert.match(html, /singularity\/capabilities\.yml/);
});

test('the capability screen navigates both relationship directions and removes through reviewed history', () => {
  const html = capabilitiesHtml(capabilityFixture, 'payments', null);
  assert.match(html, /Relationships/);
  assert.match(html, /data-select="commerce"[^>]*>Commerce/);
  assert.match(html, /data-select="payments-api"[^>]*>Payments API/);
  assert.match(html, /The child stores one parent link/);
  assert.match(html, /data-remove-target/);
  assert.match(html, /Move its child to/);
  assert.match(html, /data-review-proposals/);
  assert.match(html, /Older approved map revisions remain auditable in Git/);
  assert.match(html, /Remove from current map/);
  assert.match(CAPABILITY_SCRIPT, /reparentChildrenTo/);
  assert.match(CAPABILITY_SCRIPT, /review-proposals/);
});

test('the capability screen opens with a portfolio dashboard above the editable map', () => {
  const dashboard = buildCapabilityDashboard({
    capabilityMap: { capabilities: capabilityFixture },
    workItems: [{ id: 'PAY-1', status: 'in_progress' }],
    initiatives: [{ id: 'PAY-EPIC', status: 'complete' }],
    approvalInbox: { count: 2, fetched: true },
    diagnostics: { healthy: true },
    worldModel: { root: 'singularity/world-model', generatedAt: '2026-08-04T00:00:00.000Z', rebuildReason: null, views: [] }
  });
  assert.deepEqual({
    capabilities: dashboard.capabilities,
    delivery: dashboard.deliveryCapabilities,
    repositories: dashboard.repositories,
    jiraRoutes: dashboard.jiraRoutes,
    openWork: dashboard.openWork,
    approvals: dashboard.approvals
  }, { capabilities: 3, delivery: 1, repositories: 1, jiraRoutes: 1, openWork: 1, approvals: 2 });

  const html = capabilitiesHtml(capabilityFixture, null, null, dashboard);
  assert.match(html, /Capability portfolio/);
  assert.match(html, /Organisation at a glance/);
  assert.match(html, /open governed work/);
  assert.match(html, /awaiting approvals/);
  assert.match(html, /data-select="commerce"/);
  assert.ok(html.indexOf('Capability portfolio') < html.indexOf('<th>Capability</th>'),
    'the dashboard appears above the editable tree');
});

test('a repository with no capability map offers to describe the first capability', () => {
  const html = capabilitiesHtml([], null, null);
  assert.match(html, /Describe the first capability/);
  assert.match(html, /data-add=""/);

  // A refusal is shown on the screen that caused it, in the engine's own words.
  const refused = capabilitiesHtml(capabilityFixture, 'payments',
    "Capability 'payments' delivers from repository 'nope', which the portfolio does not declare.");
  assert.match(refused, /which the portfolio does not declare/);
});

test('a delivery capability is rendered as shipping from its declared repository', () => {
  const withMap = structuredClone(snapshot);
  withMap.capabilityMap = {
    repositories: ['api'],
    capabilities: [{
      id: 'commerce', name: 'Commerce', kind: 'collection', children: [
        { id: 'payments-api', name: 'Payments API', kind: 'delivery', repository: 'api', children: [] }
      ]
    }]
  };
  const node = find(buildCapabilityTree(withMap), 'capability:payments-api');
  assert.equal(node.description, 'api');
  assert.equal(node.contextValue, 'sflow.capability');
  assert.match(node.tooltip, /Ships from api/);
  assert.equal(flattenCapabilities(withMap.capabilityMap.capabilities).length, 2);
});


const { icon, STYLE } = await import(source('views/webview.ts'));
const { ICON_NAMES, ICON_PATHS, TREE_ICONS, treeIcon } = await import(source('views/icons.ts'));
const { enterpriseVisualFixture, VISUAL_REVIEW_CASES } = await import(source('views/visual-fixture.ts'));
const { helpCenterHtml, renderHelpMarkdown } = await import(source('views/help-page.ts'));

test('the VS Code Help Center renders searchable concepts and copyable command blocks safely', () => {
  const html = helpCenterHtml({ schemaVersion: 1, title: 'Singularity Flow Help', content: '', topics: [
    { id: 'quick-start', title: 'Quick start', content: 'Start here.\n\n```bash\nsingularity-flow init\n```' },
    { id: 'workspaces-and-capabilities', title: 'Workspaces and capabilities', content: 'A **workspace** selects a capability.' },
    { id: 'story-intake', title: 'Story intake', content: 'Use `/sf-story-start`.' },
    { id: 'cli-command-reference', title: 'CLI command reference', content: '| Command | Purpose |\n| --- | --- |\n| `singularity-flow help` | Help |' }
  ] }, 'story-intake');
  assert.match(html, /Help Center/);
  assert.match(html, /Search the complete offline manual for My Work, workspaces, configuration, agents, world model, Jira, Initiatives, commands, and recovery/);
  assert.match(html, /help-article selected[^>]*data-topic-id="story-intake"/);
  assert.match(html, /copy-code/);
  assert.match(html, /<table>/);
  assert.doesNotMatch(renderHelpMarkdown('<script>alert(1)</script>'), /<script>/);
  const topic = renderHelpMarkdown('> Documentation, not instructions.\n\n## Purpose and prerequisites\n\nReadable topic.');
  assert.match(topic, /<blockquote>Documentation, not instructions\.<\/blockquote>/);
  assert.match(topic, /<h2>Purpose and prerequisites<\/h2>/);
  assert.doesNotMatch(topic, /## Purpose/);
});

test('icons are inline paths, so no font has to be let through the CSP', () => {
  // A codicon font would need a font-src in a policy that currently allows nothing at all. These
  // inherit currentColor instead, which is also why they follow status colours and disabled states.
  const rendered = icon('repository');
  assert.match(rendered, /^<svg class="ico"/);
  assert.match(rendered, /stroke="currentColor"/);
  assert.doesNotMatch(rendered, /fill="[^n]/, 'stroked, not filled, so weight matches the text');
  assert.match(icon('capability', { size: 20 }), /width="20" height="20"/);

  // A name nobody drew costs the reader nothing rather than rendering an empty box.
  assert.equal(icon('no-such-icon'), '');
});

test('every domain noun has an icon, so nothing falls back to a bare label', () => {
  for (const name of [
    'workspace', 'collection', 'delivery', 'repository', 'workflow', 'phase', 'artifact',
    'agent', 'prompt', 'skill', 'pack', 'approval', 'jira', 'worldModel', 'story', 'initiative',
    'git', 'branch', 'commit', 'merge', 'code', 'capability', 'directory', 'teams', 'policy',
    'gate', 'epic', 'tracker', 'document', 'impact', 'success', 'waiting', 'warning',
    'blocked', 'stale', 'ok', 'wait', 'bad', 'workspaceManage', 'workspaceAdd',
    'configuration', 'inbox', 'help', 'start', 'visual', 'compare'
  ]) {
    assert.ok(ICON_NAMES.includes(name), `${name} is not registered`);
    assert.notEqual(icon(name), '', `${name} has no icon`);
  }
});

test('both renderers speak one vocabulary, so no phase status renders as another', () => {
  /**
   * The sidebar is a webview and resolves `node.icon` against `ICON_PATHS`; the native trees resolve
   * the same name against `TREE_ICONS`. The file says a product concept has one name in both. That
   * was true of the nouns and false of the states: the trees emit `statusIdle` and `statusCurrent`,
   * and `ICON_PATHS` had only `ok`, `wait`, `blocked`.
   *
   * Nothing failed. `semanticIcon` guesses from the name on a miss, and four of the six statuses
   * happened to contain a word one of its regexes matched. The two that did not fell through to the
   * node's kind — for a phase, a circle-with-a-tick — so in_progress and not_started rendered as the
   * same glyph as approved. A phase nobody had started looked finished, in the one view most likely
   * to be read at a glance.
   *
   * Asserted over the real tree rather than over the table, because the defect was in neither: it
   * was in the resolution between them.
   */
  const statuses = ['approved', 'awaiting_approval', 'in_progress', 'rejected', 'stale', 'not_started'];
  const snapshot = storySnapshot();
  snapshot.workflow.phaseOrder = statuses;
  snapshot.workflow.currentPhase = 'in_progress';
  snapshot.workflow.phases = Object.fromEntries(statuses.map((status) => [
    status, { id: status, label: status, status, generation: 0, artifacts: [], approvals: [] }
  ]));

  const phases = flatten(buildTree(snapshot)).filter((node) => node.kind === 'phase' && statuses.includes(node.id.split(':').pop()));
  assert.equal(phases.length, statuses.length, 'the fixture did not render one node per status');

  const glyphs = new Map();
  for (const node of phases) {
    assert.ok(ICON_NAMES.includes(node.icon), `a phase renders '${node.icon}', which the webview cannot draw`);
    const drawn = ICON_PATHS[node.icon];
    assert.ok(!glyphs.has(drawn), `${node.id} draws the same glyph as ${glyphs.get(drawn)}`);
    glyphs.set(drawn, node.id);
  }

  // The specific confusion that shipped, named so a regression reads as itself.
  const iconOf = (status) => phases.find((node) => node.id.endsWith(status)).icon;
  assert.notEqual(ICON_PATHS[iconOf('not_started')], ICON_PATHS[iconOf('approved')]);
  assert.equal(ICON_PATHS[iconOf('not_started')], '<circle cx="12" cy="12" r="9"/>', 'an unstarted phase is an empty ring');
});

test('a status name added to one renderer is added to both', () => {
  // The drift is what let the above happen, and it is silent in both directions: an unknown webview
  // name is guessed at, and an unknown Codicon is passed straight through to VS Code, which draws
  // its placeholder. Neither throws, so only this comparison notices.
  const states = ICON_NAMES.filter((name) => name.startsWith('status'));
  assert.ok(states.length >= 7, 'the webview lost its state vocabulary');
  for (const state of states) {
    assert.ok(TREE_ICONS[state], `${state} draws in the sidebar but has no native-tree mapping`);
  }
  for (const state of Object.keys(TREE_ICONS).filter((name) => name.startsWith('status'))) {
    assert.ok(ICON_NAMES.includes(state), `${state} draws in a native tree but the sidebar cannot draw it`);
  }
});

test('every core semantic icon resolves for native trees and theme-aware states name their color', () => {
  for (const name of [
    'workspace', 'collection', 'delivery', 'workflow', 'phase', 'artifact', 'agent', 'prompt',
    'skill', 'pack', 'approval', 'jira', 'worldModel', 'story', 'initiative', 'workspaceManage',
    'workspaceAdd', 'configuration', 'inbox', 'help', 'start', 'visual', 'compare'
  ]) {
    assert.ok(TREE_ICONS[name], `${name} has no native-tree mapping`);
    assert.match(treeIcon(name).id, /\S+/, `${name} resolved to an empty Codicon`);
  }
  for (const state of ['statusSuccess', 'statusWaiting', 'statusWarning', 'statusBlocked', 'statusStale']) {
    assert.match(treeIcon(state).color, /\S+/, `${state} must use a VS Code theme color`);
  }
  for (const entry of ['workspace', 'capability', 'workflow']) {
    assert.equal(treeIcon(entry).color, 'charts.green', `${entry} is a branded navigation entry`);
  }
});

test('the compact sidebar uses distinct modern icons for navigation and task actions', async () => {
  const content = await readFile(source('views/sidebar.ts'), 'utf8');
  assert.match(content, /label: 'Favorites', icon: 'favorite'/);
  assert.match(content, /label: 'Workspaces', icon: 'workspace'/);
  assert.match(content, /label: 'Lifecycle', icon: 'workflow'/);
  assert.match(content, /label: 'Inbox', icon: 'inbox'/);
  assert.match(content, /label: 'Configuration', icon: 'configuration'/);
  assert.match(content, /label: 'Help', icon: 'help'/);
  assert.match(content, /label: 'Start intake', icon: 'start'/);
  assert.match(content, /label: 'Create workspace', icon: 'workspaceAdd'/);
  assert.match(content, /label: 'Manage workspaces', icon: 'workspaceManage'/);
  assert.doesNotMatch(content, /label: 'Inbox', icon: 'approval'/,
    'an inbox must not be represented as a governance approval');
  assert.doesNotMatch(content, /label: 'Configuration', icon: 'workflow'/,
    'configuration and lifecycle need distinct visual identities');
  assert.match(content, /current-phase-row/,
    'the active Story phase has a dedicated visual state');
  assert.match(content, /sf-current-phase-pulse/,
    'the active Story phase uses the restrained green pulse requested by the lifecycle UI');
  assert.match(content, /prefers-reduced-motion:\s*reduce/,
    'the active-phase pulse respects reduced-motion accessibility');
});

test('icon-only actions are labelled and raw Unicode action glyphs cannot return', async () => {
  const files = ['designer-page.ts', 'instruction-designer-page.ts', 'approvals.ts', 'inbox.ts'];
  for (const file of files) {
    const content = await readFile(source(`views/${file}`), 'utf8');
    assert.doesNotMatch(content, /<button[^>]*>[↑↓×+]/u, `${file} contains a raw action glyph`);
    assert.doesNotMatch(content, /drag-handle[^>]*>⋮⋮/u, `${file} contains a raw drag glyph`);
    for (const control of content.matchAll(/<button class="[^"]*icon-button[^"]*"[\s\S]*?<\/button>/g)) {
      assert.match(control[0], /aria-label=/, `${file} contains an unlabelled icon button`);
      assert.match(control[0], /title=/, `${file} contains an icon button without a tooltip`);
    }
  }
});

test('exactly one filled button per page, so the consequential action is findable', () => {
  // Three competing primaries is what the last visual pass was about. A filled button means "this
  // commits something"; everything else is outlined or plain.
  const pages = [
    workspaceFormHtml(withMap(['payments'])),
    workspaceFormHtml(EMPTY_WORKSPACE_FORM),
    capabilitiesHtml(capabilityFixture, 'payments', null)
  ];
  for (const html of pages) {
    const filled = [...html.matchAll(/<button(?![^>]*class=)[^>]*>/g)];
    assert.ok(filled.length <= 1, `${filled.length} filled buttons: ${filled.map((m) => m[0]).join(' ')}`);
  }
});

test('the enterprise tokens support light, dark, high contrast, reduced motion, and compact controls', () => {
  // The editor's tokens carry background and foreground so the panel stays right in light, dark and
  // high-contrast; only the accent is ours. A literal surface colour here would break one of them.
  assert.match(STYLE, /--sf-accent:/);
  assert.match(STYLE, /@media \(prefers-color-scheme: dark\)[\s\S]*--sf-accent:/);
  assert.match(STYLE, /background: var\(--vscode-input-background\)/);
  assert.match(STYLE, /background: var\(--vscode-editor-background\)/);
  assert.match(STYLE, /color: var\(--vscode-foreground\)/);
  assert.doesNotMatch(STYLE, /background:\s*#(fff|ffffff|000|000000)\b/i);
  assert.match(STYLE, /--sf-radius:\s*6px/);
  assert.match(STYLE, /@media \(forced-colors: active\)/);
  assert.match(STYLE, /@media \(prefers-reduced-motion: reduce\)/);
  const buttonRule = STYLE.match(/\n  button \{([\s\S]*?)\n  \}/)?.[1] ?? '';
  assert.match(buttonRule, /min-height:\s*2rem/);
  assert.match(buttonRule, /border-radius:\s*var\(--sf-radius\)/);
  assert.doesNotMatch(buttonRule, /999px/, 'primary actions are compact controls, not pills');
});

test('shared pages remain usable in a narrow editor column', () => {
  assert.match(STYLE, /minmax\(min\(9rem, 100%\), 1fr\)/,
    'summary cards must be allowed to shrink below their preferred width');
  assert.match(STYLE, /\.help-question-form \{ grid-template-columns: 1fr; \}/);
  assert.match(STYLE, /\.field\.compact, \.inline-form \.field, \.add-row select \{ width: 100%; min-width: 0; \}/);
  assert.match(STYLE, /@media \(max-width: 420px\)[\s\S]*\.summary-grid[\s\S]*grid-template-columns: 1fr/);
  const html = enterpriseVisualFixture({ theme: 'dark', width: 320 });
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
});

test('visual-review fixtures are deterministic across three themes and narrow and wide widths', () => {
  assert.deepEqual([...new Set(VISUAL_REVIEW_CASES.map((entry) => entry.theme))],
    ['light', 'dark', 'high-contrast']);
  assert.deepEqual([...new Set(VISUAL_REVIEW_CASES.map((entry) => entry.width))], [320, 640, 1024, 1200, 1440]);
  for (const review of VISUAL_REVIEW_CASES) {
    const first = enterpriseVisualFixture(review);
    assert.equal(first, enterpriseVisualFixture(review), `${review.theme}/${review.width} changed between renders`);
    assert.match(first, /default-src 'none'/);
    assert.doesNotMatch(first, /https?:\/\/|font-src|unsafe-inline|unsafe-eval/);
    assert.match(first, /Approval inbox/);
    assert.match(first, /Workflow progress/);
    assert.match(first, /Governed agent/);
    assert.match(first, /Configuration navigation/);
    assert.match(first, /Artifact inventory/);
    assert.match(first, /Active Stories/);
    assert.match(first, /Check and open created Story/);
    for (const task of first.matchAll(/<section class="fixture-task[^>]*">([\s\S]*?)<\/section>/g)) {
      assert.ok([...task[1].matchAll(/<button(?![^>]*class=)[^>]*>/g)].length <= 1,
        `${review.theme}/${review.width} has competing primary actions in one task area`);
    }
  }
});

const { humanError } = await import(source('cli/runner.ts'));

test('a failure shows the sentence, not the log line that carries it', () => {
  // The engine logs a structured line — timestamp, level, the whole error as JSON with a stack
  // trace — and then prints the sentence. Taking stderr whole put the JSON on screen wherever a
  // failure was reported, with the explanation buried in the middle of it.
  const stderr = [
    '2026-08-02T08:44:02.932Z ERROR command.failed — Jira access requires JIRA_BASE_URL. '
      + '{"command":"jira","stack":"SingularityFlowError: Jira access requires JIRA_BASE_URL\\n at x"}',
    '',
    'Singularity Flow error: Jira access requires JIRA_BASE_URL plus JIRA_PAT.'
  ].join('\n');
  assert.equal(humanError(stderr), 'Jira access requires JIRA_BASE_URL plus JIRA_PAT.');

  // With no stated sentence, the structured lines are dropped rather than shown.
  assert.equal(humanError('2026-08-02T08:44:02.932Z ERROR command.failed — x {"a":1}\nSomething broke.'),
    'Something broke.');
  // And an unrecognised message is passed through, because it beats saying nothing.
  assert.equal(humanError('  fatal: not a git repository  '), 'fatal: not a git repository');
});

const {
  EMPTY_INTAKE_FORM, SHAPES, intakeCommand, intakeHtml, intakeIdentifier, intakeProblems,
  mintsIdentifier, needsProfile
} = await import(source('views/intake-form.ts'));

const INTAKE_CHOICES = {
  profiles: [
    { id: 'epic-planning', label: 'Epic planning', description: '4 governed phases',
      phases: ['epic-intake', 'epic-requirements', 'epic-impact', 'epic-planning'] },
    { id: 'enterprise-delivery', label: 'Enterprise delivery', description: '7 governed phases',
      phases: ['discover-define', 'design-iterate', 'pre-inception', 'inception', 'elaboration', 'construction', 'delivery'] }
  ],
  storyWorkflows: [
    { id: 'feature', label: 'Feature', description: 'Build a new capability',
      phases: ['intake', 'requirements', 'design', 'implementation', 'verification'] },
    { id: 'bugfix', label: 'Bug fix', description: 'Diagnose and correct a defect',
      phases: ['intake', 'reproduction', 'fix-design', 'implementation', 'verification'] }
  ],
  workType: 'feature',
  workflowReason: null,
  baseBranch: 'main',
  baseRemote: 'origin',
  basePreflightPassed: true,
  baseBranchChoices: [
    { branch: 'main', present: 1, total: 1, everywhere: true, missingFrom: [] }
  ]
};
const intake = (over = {}) => ({ ...EMPTY_INTAKE_FORM, ...INTAKE_CHOICES, ...over });

test('guided work intake retains the capability and workspace context', () => {
  const html = intakeHtml(intake(), {
    step: 'work', capabilityId: 'payments', workspaceName: 'Payments delivery'
  });
  assert.match(html, /Step 3 of 3/);
  assert.match(html, /Capability: payments · Workspace: Payments delivery/);
  assert.equal((html.match(/class="start-wizard-step done"/g) ?? []).length, 2);
});

test('the three shapes are offered with what each one leads to', () => {
  // The difference between an Initiative, an Epic and a Story is what happens afterwards, which a
  // row of three radio labels cannot express — and choosing wrong is expensive.
  const html = intakeHtml(intake());
  assert.deepEqual(SHAPES.map((shape) => shape.id), ['initiative', 'epic', 'story']);
  for (const shape of SHAPES) {
    assert.match(html, new RegExp(`data-shape="${shape.id}"`));
    assert.match(html, new RegExp(escapeForRegExp(shape.leads.slice(0, 40))));
  }
});

test('intake names the exact workspace, repository, and branch it will mutate', () => {
  const html = intakeHtml(intake({
    targetWorkspace: 'Rule-engine',
    targetRepository: '/workspaces/rule-engine/repos/ruleengine',
    targetBranch: 'WRK-2028'
  }));
  assert.match(html, /workspace <strong>Rule-engine<\/strong>/);
  assert.match(html, /repository\s+<strong>\/workspaces\/rule-engine\/repos\/ruleengine<\/strong>/);
  assert.match(html, /branch <code>WRK-2028<\/code>/);
});

/** Sentences in the fixtures contain regex metacharacters; matching one literally has to say so. */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('no tracker is a first-class answer, not a degraded one', () => {
  // Teams without Jira were reading a key field and concluding the product was not for them.
  const html = intakeHtml(intake());
  assert.match(html, /data-tracker="none"/);
  assert.match(html, /Described here and governed in Git/);
  // Unconfigured Jira is still shown, with the reason — hiding it makes a missing integration look
  // like a missing feature.
  assert.match(intakeHtml(intake({ jiraReason: 'Set JIRA_BASE_URL and JIRA_PAT.' })),
    /Set JIRA_BASE_URL and JIRA_PAT/);
  assert.match(intakeProblems(intake({
    tracker: 'jira', jiraConfigured: false, jiraReason: 'Set JIRA_BASE_URL and JIRA_PAT.'
  })).join(' '), /Set JIRA_BASE_URL/);
});

test('an Initiative without a tracker is described here and started from that', () => {
  const form = intake({
    shape: 'initiative', tracker: 'none', id: 'faster-checkout',
    title: 'Faster checkout', description: 'Cut the steps to pay', profile: 'enterprise-delivery'
  });
  assert.deepEqual(intakeProblems(form), []);
  assert.deepEqual(intakeCommand(form), [
    'initiative', 'start', 'faster-checkout', '--json',
    '--title', 'Faster checkout', '--description', 'Cut the steps to pay',
    '--profile', 'enterprise-delivery'
  ]);
});

test('intake shapes do not ask for a role because each phase owns its agent', () => {
  for (const shape of ['initiative', 'epic']) {
    const form = intake({
      shape, tracker: 'none', id: 'x', title: 'A', description: 'B', goal: 'C',
      profile: 'epic-planning'
    });
    assert.deepEqual(intakeProblems(form), [], shape);
    assert.doesNotMatch(intakeCommand(form).join(' '), /--agent/, shape);
    assert.doesNotMatch(intakeHtml(form), /data-field="lens"/, shape);
  }
  // A Story follows the same phase-agent contract.
  const story = intake({ shape: 'story', tracker: 'none', id: 'x', title: 'A', description: 'B' });
  assert.doesNotMatch(intakeHtml(story), /data-field="lens"/);
  assert.doesNotMatch(intakeCommand(story).join(' '), /--agent/);
});

test('an Initiative with a tracker is fetched by key, and nothing else is asked', () => {
  const form = intake({
    shape: 'initiative', tracker: 'jira', jiraConfigured: true, key: 'PAY-17',
    profile: 'enterprise-delivery'
  });
  assert.deepEqual(intakeProblems(form), []);
  assert.deepEqual(intakeCommand(form), [
    'initiative', 'start', 'PAY-17', '--json', '--jira', '--profile', 'enterprise-delivery'
  ]);
  // The title and description are the tracker's to change, so the form does not offer to duplicate
  // them here.
  const html = intakeHtml(form);
  assert.doesNotMatch(html, /data-field="title"/);
  assert.match(html, /read from the issue/);
});

test('an untracked Epic has no identifier to give: the branch reservation mints it', () => {
  // Asking for one would be asking for a value the engine is about to replace — and passing --id to
  // a command with no such flag is how a form quietly stops working.
  const form = intake({
    shape: 'epic', tracker: 'none', title: 'One-tap checkout',
    description: 'Fewer steps to pay', goal: 'Cut abandonment',
    profile: 'enterprise-delivery'
  });
  assert.equal(mintsIdentifier(form), true);
  assert.equal(intakeIdentifier(form), '');
  assert.deepEqual(intakeProblems(form), []);
  assert.deepEqual(intakeCommand(form), [
    'epic', 'start', '--local', '--json',
    '--title', 'One-tap checkout',
    '--description', 'Fewer steps to pay',
    '--goal', 'Cut abandonment',
    '--profile', 'enterprise-delivery'
  ]);
  const html = intakeHtml(form);
  assert.doesNotMatch(html, /data-field="id"/);
  assert.match(html, /minted when the Epic reserves its branch/);
});

test('an Epic asks what success looks like; the other two do not', () => {
  assert.match(intakeProblems(intake({ shape: 'epic', id: 'x', title: 'A', description: 'B' })).join(' '),
    /what outcome would make this a success/i);
  assert.deepEqual(
    intakeProblems(intake({ shape: 'story', id: 'x', title: 'A', description: 'B' })), []);
  assert.match(intakeHtml(intake({ shape: 'epic' })), /data-field="goal"/);
  assert.doesNotMatch(intakeHtml(intake({ shape: 'story' })), /data-field="goal"/);
});

test('a Story is the one shape that asks how it will be judged done', () => {
  const form = intake({
    shape: 'story', tracker: 'none', id: 'checkout-retry', title: 'Retry a failed charge',
    description: 'One retry with backoff', acceptanceCriteria: 'Retries once\nGives up after that'
  });
  assert.deepEqual(intakeProblems(form), []);
  assert.deepEqual(intakeCommand(form), [
    'start', 'checkout-retry', '--json', '--fetch',
    '--title', 'Retry a failed charge',
    '--description', 'One retry with backoff',
    '--work-type', 'feature',
    '--isolated-worktree',
    '--from-branch', 'main',
    '--acceptance-criteria', 'Retries once\nGives up after that'
  ]);
  assert.match(intakeHtml(form), /data-field="acceptanceCriteria"/);
  // A Story takes its phases from its workflow, so there is no Initiative profile to choose.
  assert.equal(needsProfile('story'), false);
  assert.doesNotMatch(intakeHtml(form), /Delivery profile/);
  assert.match(intakeHtml(form), /Story workflow/);
  assert.match(intakeHtml(form), /data-work-type="feature"/);
  assert.match(intakeHtml(form), /reproduction/);
});

test('a Story requires an explicit base even when only one remote branch is available', () => {
  const form = intake({
    shape: 'story', tracker: 'none', id: 'checkout-retry', title: 'Retry a failed charge',
    description: 'One retry with backoff', baseBranch: null, basePreflightPassed: false
  });
  assert.match(intakeProblems(form).join(' '), /Choose the remote base branch/);
  const html = intakeHtml(form);
  assert.match(html, /data-base-branch="main"/);
  assert.doesNotMatch(html, /data-base-branch="main"[^>]*checked/);
  assert.match(html, /<button type="button" data-submit="start" disabled>/);
});

test('Story workflow phases render as a horizontal rail beneath the workflow name', () => {
  const html = intakeHtml(intake({
    shape: 'story', tracker: 'none', id: 'checkout-retry', title: 'Retry a failed charge',
    description: 'One retry with backoff'
  }));
  assert.match(html, /class="choice workflow-choice chosen"/);
  assert.match(html, /class="workflow-copy"[\s\S]*Feature[\s\S]*class="workflow-phases"/);
  assert.match(html, /class="workflow-step"[\s\S]*<code>intake<\/code>/);
  assert.match(html, /class="workflow-connector"[\s\S]*<code>requirements<\/code>/);
  assert.match(STYLE, /\.choice\.workflow-choice > \.workflow-phases \{[\s\S]*display: flex; flex-wrap: wrap;/);
  assert.match(STYLE, /\.choice\.workflow-choice \.workflow-step \{[\s\S]*display: inline-flex;/);
});

test('POC Story intake explains the browser preflight and bounded validation before start', () => {
  const html = intakeHtml(intake({
    shape: 'story', tracker: 'none', id: 'poc-checkout', title: 'Checkout POC',
    description: 'Generate and validate checkout regression coverage',
    targetUrl: 'https://staging.example.test/checkout',
    workType: 'poc-workflow',
    storyWorkflows: [...INTAKE_CHOICES.storyWorkflows, {
      id: 'poc-workflow', label: 'POC workflow', description: 'Governed browser test generation',
      phases: ['poc-intake', 'poc-ui-exploration', 'poc-validation']
    }]
  }));
  assert.match(html, /POC browser readiness/);
  assert.match(html, /mcp smoke playwright --url/);
  assert.match(html, /data-field="targetUrl"/);
  assert.deepEqual(intakeProblems(intake({
    shape: 'story', tracker: 'none', id: 'poc-checkout', title: 'Checkout POC',
    description: 'Generate coverage', workType: 'poc-workflow', targetUrl: ''
  })).some((problem) => /authorized HTTPS target URL/.test(problem)), true);
  assert.ok(intakeCommand(intake({
    shape: 'story', tracker: 'none', id: 'poc-checkout', title: 'Checkout POC',
    description: 'Generate coverage', workType: 'poc-workflow', targetUrl: 'https://staging.example.test'
  })).includes('--target-url'));
  assert.match(html, /at most two/);
});

test('a tracked Story is fetched by key', () => {
  const form = intake({ shape: 'story', tracker: 'jira', jiraConfigured: true, key: 'ENG-142' });
  assert.deepEqual(intakeProblems(form), []);
  assert.deepEqual(intakeCommand(form), [
    'story', 'start', 'ENG-142', '--json', '--fetch', '--work-type', 'feature',
    '--isolated-worktree',
    '--from-branch', 'main'
  ]);
});

test('Story intake refuses to fall through to an interactive workflow prompt', () => {
  const missing = intake({
    shape: 'story', tracker: 'none', id: 'checkout-retry', title: 'Retry checkout',
    description: 'Retry once', storyWorkflows: [], workType: null,
    workflowReason: 'Could not load Story workflows from this repository.'
  });
  assert.match(intakeProblems(missing).join(' '), /Could not load Story workflows/);
  assert.match(intakeHtml(missing), /Could not load Story workflows/);

  const selected = { ...missing, storyWorkflows: INTAKE_CHOICES.storyWorkflows,
    workType: 'bugfix', workflowReason: null };
  assert.deepEqual(intakeProblems(selected), []);
  assert.match(intakeCommand(selected).join(' '), /--work-type bugfix/);
});

test('the profiles are shown with the phases that distinguish them', () => {
  // A picker showing "Epic planning" and "Enterprise delivery" gives no basis for choosing. The
  // difference is which phases each runs, and the choice is pinned for the whole life of the work.
  const html = intakeHtml(intake({ shape: 'epic' }));
  assert.match(html, /discover-define/);
  assert.match(html, /elaboration/);
  assert.match(html, /epic-intake/);
  assert.match(html, /Pinned when it starts/);
});

test('what is already under way is shown, and starting it again is refused', () => {
  // Starting the same thing twice is only preventable by the screen that starts things.
  const inFlight = [{ shape: 'epic', id: 'PAY-17', title: 'Faster checkout', status: 'active · planning' }];
  const html = intakeHtml(intake({ inFlight }));
  assert.match(html, /Already under way/);
  assert.match(html, /PAY-17/);
  assert.match(html, /active · planning/);

  const clash = intake({
    shape: 'story', tracker: 'none', id: 'PAY-17', title: 'A', description: 'B', inFlight
  });
  assert.match(intakeProblems(clash).join(' '), /has already been started/);
});

test('completed work is shown as completed rather than already under way', () => {
  const completed = [{
    shape: 'story', id: 'WRK-456', title: 'Change the color', status: 'complete', completed: true
  }];
  const html = intakeHtml(intake({ inFlight: completed }));
  assert.match(html, /Completed/);
  assert.match(html, /WRK-456/);
  assert.match(html, /complete/);
  assert.doesNotMatch(html, /Already under way/);

  const clash = intake({
    shape: 'story', tracker: 'none', id: 'WRK-456', title: 'A', description: 'B', inFlight: completed
  });
  assert.match(intakeProblems(clash).join(' '), /has already been started/);
});

test('an intake form still missing something disables the button and lists why', () => {
  const html = intakeHtml(intake());
  assert.match(html, /Before this can start/);
  assert.match(html, /<button type="button" data-submit="start" disabled>/);

  const ready = intakeHtml(intake({
    shape: 'story', tracker: 'none', id: 'checkout-retry', title: 'A', description: 'B'
  }));
  assert.match(ready, /Starts story <code>checkout-retry<\/code>/);
  assert.match(ready, /<button type="button" data-submit="start" >/);

  const waitingForRemote = intakeHtml(intake({
    shape: 'story', tracker: 'none', id: 'checkout-retry', title: 'A', description: 'B',
    basePreflightPassed: false, basePreflightChecking: true
  }));
  assert.match(waitingForRemote, /Checking remote branch freshness/);
  assert.match(waitingForRemote, /<button type="button" data-submit="start" disabled>/);
});

test('a refused start is reported on the form that caused it', () => {
  const refused = intakeHtml(intake({ error: 'Working tree is not clean.' }));
  assert.match(refused, /Working tree is not clean/);
  assert.match(refused, /role="alert"/);
  const timeout = intakeHtml(intake({
    shape: 'story',
    error: 'The CLI timed out.',
    recoveryCommand: "cd '/work/api' && 'singularity-flow' 'start' 'WRK-17'"
  }));
  assert.match(timeout, /Continue from a terminal/);
  assert.match(timeout, /singularity-flow/);
  assert.match(timeout, /WRK-17/);
  assert.match(timeout, /data-submit="recover-start"/);
  assert.match(timeout, /Check and open created Story/);
  assert.match(timeout, /role="status" aria-live="polite"/);
  assert.match(intakeHtml(intake({ busy: true })), /aria-busy="true"/);
});

const {
  archiveCommand, configurationRefreshCommand, duplicateCommand, duplicateDirectory, duplicateProblems,
  renameCommand, restoreCommand, updateCommand, workspaceRows
} =
  await import(source('views/workspaces-model.ts'));
const { workspacesHtml, EMPTY_DRAFT: EMPTY_COPY } = await import(source('views/workspaces-page.ts'));

const REGISTRY = [
  { id: 'local--commerce', path: '/work/commerce', name: 'commerce', anchorKey: 'commerce',
    leadRepositoryPath: '/work/commerce/repos/platform', active: 'yes' },
  { id: 'local--payments', path: '/work/payments', name: 'payments', anchorKey: 'payments',
    leadRepositoryPath: '/work/payments/repos/api' }
];

test('a workspace list shows the working directory, which is what it is really about', () => {
  const rows = workspaceRows(REGISTRY);
  assert.deepEqual(rows.map((row) => row.directory), ['/work/commerce', '/work/payments']);
  assert.deepEqual(rows.map((row) => row.lead), ['platform', 'api']);
  assert.equal(rows[0].collides, false);

  const html = workspacesHtml(rows, null, EMPTY_COPY, null);
  assert.match(html, /\/work\/commerce/);
  assert.match(html, /platform/);
  assert.match(html, /no two may share a directory/);
});

test('two workspaces on one directory are marked, because the engine forbids it', () => {
  // It cannot normally happen — creation refuses it — but a registry is a file on disk that
  // survives moves, restores and hand edits. Showing it costs less than two workspaces quietly
  // writing into one tree.
  const rows = workspaceRows([
    ...REGISTRY,
    { id: 'local--commerce-2', path: '/work/commerce', name: 'commerce copy', anchorKey: 'commerce-2' }
  ]);
  assert.deepEqual(rows.filter((row) => row.collides).map((row) => row.name),
    ['commerce', 'commerce copy']);
  const html = workspacesHtml(rows, null, EMPTY_COPY, null);
  assert.match(html, /shared directory/);
  assert.match(html, /2 workspaces share a working directory/);
});

test('a copy is refused before it runs when its directory is taken', () => {
  const rows = workspaceRows(REGISTRY);
  const [commerce] = rows;

  // Copying alongside itself under a name already in use is the mistake worth catching.
  assert.deepEqual(duplicateDirectory(commerce, 'payments', null), '/work/payments');
  assert.match(duplicateProblems(commerce, 'payments', null, rows).join(' '),
    /already workspace 'payments'.*No two workspaces may share a working directory/);
  assert.match(duplicateProblems(commerce, 'commerce', null, rows).join(' '), /already workspace 'commerce'/);

  // A free directory, and the same identifier somewhere else, are both fine.
  assert.deepEqual(duplicateProblems(commerce, 'commerce-spike', null, rows), []);
  assert.deepEqual(duplicateProblems(commerce, 'commerce', '/elsewhere', rows), []);
  assert.deepEqual(duplicateProblems(commerce, '', null, rows), ['Give the copy an identifier.']);
  assert.match(duplicateProblems(commerce, 'has spaces', null, rows).join(' '), /letters, numbers/);
});

test('the copy and rename commands are what the engine expects', () => {
  const [commerce] = workspaceRows(REGISTRY);
  assert.deepEqual(duplicateCommand(commerce, ' commerce-spike ', '', ''),
    ['workspace', 'duplicate', '/work/commerce', '--id', 'commerce-spike', '--json']);
  assert.deepEqual(duplicateCommand(commerce, 'commerce-spike', '/elsewhere', 'Spike'),
    ['workspace', 'duplicate', '/work/commerce', '--id', 'commerce-spike', '--json',
      '--base', '/elsewhere', '--name', 'Spike']);
  // Renaming carries the exact confirmation the engine demands for an edit.
  assert.deepEqual(renameCommand(commerce, ' Commerce platform '),
    ['workspace', 'rename', '/work/commerce', '--name', 'Commerce platform',
      '--confirm', 'commerce', '--json']);
  assert.deepEqual(archiveCommand(commerce),
    ['workspace', 'archive', '/work/commerce', '--confirm', 'commerce', '--fetch', '--json']);
  assert.deepEqual(restoreCommand(commerce),
    ['workspace', 'restore', '/work/commerce', '--json']);
  assert.deepEqual(updateCommand(commerce, ' Commerce platform ', ['payments', 'checkout', 'payments']),
    ['workspace', 'update', '/work/commerce', '--name', 'Commerce platform',
      '--capability', 'checkout', '--capability', 'payments',
      '--confirm', 'commerce', '--json']);
});

test('configuration refresh commands bind apply to the preview and carry only reviewed choices', () => {
  const [commerce] = workspaceRows(REGISTRY);
  assert.deepEqual(configurationRefreshCommand(commerce, {
    dryRun: true, resolutions: { 'workflow.ledger.enabled': 'local' }
  }), [
    'workspace', 'refresh-configuration', '/work/commerce', '--dry-run',
    '--resolve', 'workflow.ledger.enabled=local', '--json'
  ]);
  assert.deepEqual(configurationRefreshCommand(null, {
    dryRun: false,
    planId: 'cfgp-123',
    resolutions: {
      'workflow.ledger.enabled': 'local',
      '.github/agents/developer.agent.md': 'bundled'
    }
  }), [
    'workspace', 'refresh-configuration', '--confirm-plan', 'cfgp-123',
    '--resolve', '.github/agents/developer.agent.md=bundled',
    '--resolve', 'workflow.ledger.enabled=local', '--json'
  ]);
});

test('workspace configuration refresh renders per-path dropdowns and a plan-bound apply', () => {
  const rows = workspaceRows(REGISTRY);
  const html = workspacesHtml(
    rows, '/work/commerce', EMPTY_COPY, null, null, false, null, undefined,
    {
      scope: 'selected', loading: false, applying: false, error: null,
      resolutions: { '.github/agents/developer.agent.md': 'bundled' },
      result: {
        status: 'preview', dryRun: true, planId: 'cfgp-123', total: 1, updated: 0,
        results: [{
          status: 'would-update', repository: 'platform', remote: '/git/platform.git',
          configurationChanged: true, stateChanged: true, stateStatus: 'would-follow-configuration',
          files: ['singularity/workflow.yml'],
          conflicts: [
            { path: 'workflow.ledger.enabled', resolution: 'preserved-local', local: true, bundled: false },
            {
              path: '.github/agents/developer.agent.md', resolution: 'accepted-bundled',
              localSha256: 'a', bundledSha256: 'b'
            }
          ]
        }]
      }
    }
  );
  assert.match(html, /Upgrade capabilities & workspaces/);
  assert.match(html, /world models and other runtime state are preserved/);
  assert.match(html, /data-config-preview="selected"/);
  assert.match(html, /data-config-preview="all"/);
  assert.match(html, /data-configuration-resolution="workflow\.ledger\.enabled"/);
  assert.match(html, /data-configuration-resolution="\.github\/agents\/developer\.agent\.md"/);
  assert.match(html, /<option value="bundled" selected>Use packaged<\/option>/);
  assert.match(html, /data-config-bundled="assets"/);
  assert.match(html, /data-config-apply="selected"/);
  assert.doesNotMatch(html, /data-config-apply="selected"\s+disabled/);
  assert.match(html, /cfgp-123/);
});

test('a blocked workspace upgrade offers a reviewed packaged-agent repair in the UI', () => {
  const rows = workspaceRows(REGISTRY);
  const html = workspacesHtml(
    rows, '/work/commerce', EMPTY_COPY, null, null, false, null, undefined,
    {
      scope: 'all', loading: false, applying: false, error: null, resolutions: {},
      result: {
        status: 'blocked', dryRun: true, total: 1, updated: 0,
        results: [{
          status: 'blocked', repository: 'platform', remote: '/git/platform.git',
          configurationChanged: false, stateChanged: false,
          error: "Phase 'testing' requires exactly one default governed agent; found 0.",
          conflicts: [{
            path: '.github/agents/qa.agent.md', resolution: 'preserved-local',
            localSha256: 'a', bundledSha256: 'b'
          }],
          repair: {
            kind: 'packaged-agents', label: 'Restore packaged agents',
            paths: ['.github/agents/qa.agent.md']
          }
        }]
      }
    }
  );
  assert.match(html, /Upgrade capabilities & workspaces/);
  assert.match(html, /Governed agents from an older build are blocking this upgrade/);
  assert.match(html, /data-config-agents="packaged"/);
  assert.match(html, /Repair missing or outdated agents/);
  assert.doesNotMatch(html, /data-config-apply="all"\s*>/,
    'a blocked preview has no plan that can be applied');
});

test('the selected workspace offers edit, copy and forget, and says what each costs', () => {
  const rows = workspaceRows(REGISTRY);
  const html = workspacesHtml(rows, '/work/commerce', { ...EMPTY_COPY, id: 'commerce-spike' }, null);
  assert.match(html, /data-edit="\/work\/commerce"/);
  assert.match(html, /data-duplicate="\/work\/commerce"/);
  assert.match(html, /data-forget="\/work\/commerce"/);
  assert.match(html, /data-archive="\/work\/commerce" disabled/,
    'archive stays unavailable until repository Story state has been inspected');
  assert.match(html, /data-switch="\/work\/commerce"/, 'switching is available directly on the row');
  assert.doesNotMatch(html, /data-open="\/work\/commerce"/, 'there is no separate, ambiguous Open action');
  assert.match(html, /The copy would be created at \/work\/commerce-spike/);
  assert.match(html, /leaves the directory alone/, 'forgetting is not deleting, and says so');
  assert.match(html, /Repository origins and the directory itself stay fixed/, 'editing does not move anything');
});

test('an archived workspace offers restore instead of selection', () => {
  const rows = workspaceRows([{ ...REGISTRY[0], active: undefined, archivedAt: '2026-08-05T00:00:00.000Z' }]);
  const html = workspacesHtml(rows, '/work/commerce', EMPTY_COPY, null);
  assert.match(html, /Archived workspace/);
  assert.match(html, /data-restore="\/work\/commerce"/);
  assert.doesNotMatch(html, /data-switch="\/work\/commerce"/);
  assert.match(html, /checkout, branches and generated artifacts were not deleted/);
});

test('workspace details show its directory, capabilities, repositories and Jira context', () => {
  const rows = workspaceRows(REGISTRY);
  const status = {
    healthy: true,
    leadRepositoryPath: '/work/commerce/repos/platform',
    workspace: {
      id: 'local--commerce', name: 'commerce', path: '/work/commerce',
      leadRepository: 'platform', capabilities: ['checkout', 'payments'],
      anchor: { provider: 'jira', key: 'KAN-8', title: 'Checkout modernization', issueTypeName: 'Epic' }
    },
    repositories: [{
      id: 'platform', role: 'lead', absolutePath: '/work/commerce/repos/platform',
      state: 'ready', branch: 'KAN-8', dirty: false,
      metadata: { appId: 'APP-1001', name: 'Commerce Platform' },
      jira: { projectKey: 'KAN' }, worldModel: { state: 'available' }
    }],
    counts: { repositories: 1, ready: 1, dirty: 0, worldModels: 1 },
    warnings: [],
    archiveReadiness: {
      eligible: false, checkedAt: '2026-08-05T00:00:00.000Z', fetched: false,
      activeStories: [{
        repository: 'platform', id: 'PAY-123', title: 'Finish checkout', status: 'in_progress',
        phase: 'implementation', branch: 'PAY-123'
      }],
      blockers: []
    }
  };
  const html = workspacesHtml(rows, '/work/commerce', EMPTY_COPY, null, status, false, null);
  assert.match(html, /Workspace details/);
  assert.match(html, /\/work\/commerce\/repos\/platform/);
  assert.match(html, /checkout/);
  assert.match(html, /payments/);
  assert.match(html, /KAN-8/);
  assert.match(html, /APP-1001/);
  assert.match(html, /projectKey/);
  assert.match(html, /available/);
  assert.match(html, /Active work is protected/);
  assert.match(html, /PAY-123/);
  assert.match(html, /data-archive="\/work\/commerce" disabled/);

  const editStatus = {
    ...status,
    availableCapabilities: [
      { id: 'checkout', name: 'Checkout', depth: 0, ancestors: [], repository: null },
      { id: 'payments', name: 'Payments', depth: 1, ancestors: ['checkout'], repository: 'platform' },
      { id: 'settlement', name: 'Settlement', depth: 0, ancestors: [], repository: 'platform' },
      { id: 'risk', name: 'Risk', depth: 0, ancestors: [], repository: 'risk' }
    ]
  };
  const editing = workspacesHtml(rows, '/work/commerce', EMPTY_COPY, null, editStatus, false, null, {
    open: true, name: 'Commerce delivery', capabilities: ['checkout'], busy: false
  });
  assert.match(editing, /Edit workspace/);
  assert.match(editing, /data-field="edit-name"/);
  assert.match(editing, /data-edit-remove="checkout"/);
  assert.doesNotMatch(editing, /<option value="payments"/,
    'a child already covered by a selected capability is not redundantly offered');
  assert.match(editing, /<option value="settlement"/);
  assert.doesNotMatch(editing, /<option value="risk"/,
    'capabilities needing an unmaterialized repository are not offered as an unsafe in-place edit');
  assert.match(editing, /needs repositories this workspace has not materialized/);
  assert.match(editing, /data-edit-save="\/work\/commerce"/);
});

test('the page carries the directories it needs to answer without a round trip', () => {
  // Re-rendering to answer "is that directory taken" would replace the field being typed into, so
  // the page is given the list. The panel re-checks it, and the engine refuses regardless.
  const html = workspacesHtml(workspaceRows(REGISTRY), '/work/commerce', EMPTY_COPY, null);
  assert.match(html, /data-context="/);
  assert.match(html, /work\/payments/);
  // Not a script element: the CSP allows only this render's nonce, and a data block under a strict
  // policy is not worth depending on.
  assert.doesNotMatch(html, /<script/);
});

const { buildWorkspaceTree, capabilityIdOf, workspacePathOf } =
  await import(source('views/navigation-trees.ts'));

test('inactive workspace rows select their scope while the active row opens its details', () => {
  // A person clicking another workspace is choosing where to work. Making that click open details
  // left Lifecycle, Inbox, and Configuration bound to the old selection with no visible feedback.
  const [commerce, payments] = buildWorkspaceTree(REGISTRY);
  assert.equal(commerce.label, 'commerce');
  assert.equal(commerce.kind, 'action');
  assert.equal(commerce.description, 'working here');
  assert.equal(commerce.runCommand, 'singularityFlow.openWorkspaces', 'clicking opens workspace details');
  // The directory leads the tooltip, then what choosing this workspace means.
  assert.match(commerce.tooltip, /^\/work\/commerce\n/);
  assert.match(commerce.tooltip, /scoped to this workspace/);
  assert.equal(commerce.contextValue, 'sflow.workspace.active',
    'the one being worked in is distinguishable to a menu, not just to a reader');
  assert.equal(commerce.path, '/work/commerce');
  // Opening the lead checkout remains a secondary explicit action and uses this path.
  assert.equal(commerce.openPath, '/work/commerce/repos/platform');
  assert.equal(commerce.children, undefined, 'there is no disclosure chevron competing with selection');
  assert.match(commerce.tooltip, /Lead repository: platform/);
  assert.equal(payments.description, undefined, 'only one workspace is being worked in');
  assert.equal(payments.runCommand, 'singularityFlow.switchWorkspace',
    'clicking an inactive workspace changes the active governed scope');
  assert.match(payments.tooltip, /select this workspace/i);
  // The one being worked in is distinguishable to a menu, not just to a reader.
  assert.equal(commerce.contextValue, 'sflow.workspace.active');
  assert.equal(payments.contextValue, 'sflow.workspace');
});

test('archived workspaces move under one folder and can be inspected for restore', () => {
  const nodes = buildWorkspaceTree([
    REGISTRY[0],
    { ...REGISTRY[1], archivedAt: '2026-08-05T00:00:00.000Z' }
  ]);
  assert.equal(nodes.length, 2);
  const archived = nodes[1];
  assert.equal(archived.label, 'Archived');
  assert.equal(archived.icon, 'archive');
  assert.equal(archived.children.length, 1);
  assert.equal(archived.children[0].label, 'payments');
  assert.equal(archived.children[0].description, 'preserved locally');
  assert.equal(archived.children[0].contextValue, 'sflow.workspace.archived');
  assert.match(archived.children[0].tooltip, /inspect or restore/);
});

test('a workspace sharing a directory with another is marked in the tree', () => {
  const rows = buildWorkspaceTree([
    ...REGISTRY,
    { id: 'local--commerce-2', path: '/work/commerce', name: 'commerce copy', anchorKey: 'commerce-2' }
  ]);
  const shared = rows.filter((row) => row.description === 'shares a directory');
  assert.equal(shared.length, 2);
  assert.equal(shared[0].icon, 'statusWarning');
  assert.match(shared[0].tooltip, /Another workspace occupies this directory/);
});

test('the selected workspace warns when its lead repository is unavailable', () => {
  const [selected] = buildWorkspaceTree([{
    ...REGISTRY[0], active: 'yes', repositoryState: 'missing'
  }]);
  assert.equal(selected.description, 'selected · repository missing');
  assert.equal(selected.icon, 'statusWarning');
  assert.equal(selected.contextValue, 'sflow.workspace.active.unavailable');
  assert.match(selected.tooltip, /Repair the workspace/);
});

test('an empty registry offers the one thing to do about it', () => {
  const [empty] = buildWorkspaceTree([]);
  assert.equal(empty.contextValue, 'sflow.workspaces.empty');
  assert.equal(empty.label, 'Guided start');
  assert.equal(empty.runCommand, 'singularityFlow.startWizard');
  assert.equal(empty.icon, 'start');
});

/** What a capability shows about itself, and what it contains — the same split the commands make. */
const beneath = (node) => node.children.filter((child) => capabilityIdOf(child) === null);
const capabilitiesUnder = (node) => node.children.filter((child) => capabilityIdOf(child) !== null);

test('capabilities are the tree they already are, and say what ships', () => {
  const snapshot = { capabilityMap: { capabilities: capabilityFixture }, capabilityMapPath: 'singularity/capabilities.yml' };
  const [commerce] = buildCapabilityTree(snapshot);
  assert.equal(commerce.label, 'Commerce');
  assert.equal(commerce.icon, 'collection');
  assert.equal(commerce.contextValue, 'sflow.capability', 'a grouping can contain more');

  const payments = capabilitiesUnder(commerce)[0];
  const api = capabilitiesUnder(payments)[0];
  assert.equal(api.label, 'Payments API');
  assert.equal(api.description, 'api', 'the repository it ships from');
  assert.equal(api.icon, 'delivery');
  // Shipping and containing stopped being exclusive, so there is one context value: the menu that
  // gated "add one inside" on the plain value had been hiding it from every capability that ships.
  assert.equal(api.contextValue, 'sflow.capability');
  assert.match(api.tooltip, /Ships from api/);
  assert.match(payments.tooltip, /Jira PAY/);
  assert.match(payments.tooltip, /Teams: Payments squad/);
});

test('a capability shows the repositories it ships from and where its world model is', () => {
  // Both were in the map and in the engine's readiness answer, and neither reached this tree: a
  // capability rendered as a name with a repository in grey and nothing about whether it could
  // actually be worked in.
  const capabilities = [{
    id: 'commerce', name: 'Commerce', kind: 'delivery', type: 'tech',
    repository: 'commerce-api', repositories: ['commerce-api', 'commerce-web'],
    leadRepository: 'commerce-api',
    documentation: { Charter: 'https://confluence/charter' },
    resources: { 'AWS account': '399181' },
    children: []
  }];
  const readiness = {
    'commerce-api': {
      url: 'git@github:acme/commerce-api.git',
      stateBranch: 'state', hasStateBranch: true, worldModel: 'state-branch'
    },
    'commerce-web': { url: 'git@github:acme/commerce-web.git', hasStateBranch: false, worldModel: null }
  };
  const [commerce] = buildCapabilityTree({ capabilityMap: { capabilities } }, null, readiness);

  // The lead is named on the row itself; the rest are counted, because a row listing four URLs is a
  // row nobody reads.
  assert.equal(commerce.description, 'tech · commerce-api · +1');

  // What it contains comes first; what it is follows.
  const [api, web] = beneath(commerce);
  assert.equal(api.label, 'commerce-api');
  assert.equal(api.description, 'lead · state branch');
  assert.equal(api.tooltip.split('\n')[0], 'git@github:acme/commerce-api.git');
  assert.equal(web.description, 'no state branch');
  assert.equal(web.icon, 'statusWarning', 'a repository with nowhere to record governance is a problem');

  const model = beneath(commerce).find((row) => row.label === 'World model');
  assert.equal(model.description, 'on state-branch');
  assert.match(model.tooltip, /state branch first/);

  // Whatever describes the capability, and whatever it runs on, as the map records them.
  const links = beneath(commerce).filter((row) => row.contextValue === 'sflow.capability.link');
  assert.deepEqual(links.map((row) => [row.label, row.description]),
    [['Charter', 'https://confluence/charter'], ['AWS account', '399181']]);
});

test('unasked is not the same as absent in the capability tree', () => {
  // Readiness costs an ls-remote per repository, so the tree renders before it arrives. Saying "no
  // state branch" when nobody looked would be a claim about the remote with nothing behind it.
  const capabilities = [{
    id: 'commerce', name: 'Commerce', kind: 'delivery',
    repositories: ['commerce-api'], leadRepository: 'commerce-api', children: []
  }];
  const [commerce] = buildCapabilityTree({ capabilityMap: { capabilities } });
  assert.equal(beneath(commerce)[0].description, 'lead · not checked');
  assert.equal(beneath(commerce)[0].icon, 'delivery', 'not a warning: nothing is known to be wrong');
  assert.equal(beneath(commerce).find((row) => row.label === 'World model').description, 'not checked');
});

test('a grouping capability composes its world model from what is beneath it', () => {
  // A grouping has no repository to hold a model, so what it has is the union of its children's —
  // composed on read and stored nowhere. Saying "not built" would be false; saying nothing would
  // hide that half its capabilities cannot ground anything.
  const capabilities = [{
    id: 'commerce', name: 'Commerce', kind: 'collection', repositories: [], children: [
      { id: 'checkout', name: 'Checkout', kind: 'delivery', repositories: ['checkout'], leadRepository: 'checkout', children: [] },
      { id: 'catalog', name: 'Catalog', kind: 'delivery', repositories: ['catalog'], leadRepository: 'catalog', children: [] }
    ]
  }];
  const readiness = {
    checkout: { hasStateBranch: true, stateBranch: 'state', worldModel: 'state-branch' },
    catalog: { hasStateBranch: true, stateBranch: 'state', worldModel: null }
  };
  const [commerce] = buildCapabilityTree({ capabilityMap: { capabilities } }, null, readiness);
  const model = beneath(commerce).find((row) => row.label === 'World model');
  assert.equal(model.description, '1/2 of its capabilities');
  assert.match(model.tooltip, /stored nowhere/);
  // The hierarchy is still the hierarchy: the composed row does not replace what is beneath.
  assert.deepEqual(capabilitiesUnder(commerce).map((row) => row.label), ['Checkout', 'Catalog']);
});

test('the capability tree says why it is empty rather than being empty', () => {
  // A view with nothing in it and no explanation is the same defect as a view with no provider.
  const [unavailable] = buildCapabilityTree(null, 'Open the repository that contains singularity/workflow.yml.');
  assert.match(unavailable.label, /Open the repository/);
  assert.match(unavailable.tooltip, /lead repository/);

  const [none] = buildCapabilityTree({ capabilityMap: null, capabilityMapPath: 'singularity/capabilities.yml' });
  assert.equal(none.contextValue, 'sflow.capabilities.empty');
  assert.match(none.label, /Nothing describes what this organisation builds/);
  assert.match(none.tooltip, /singularity\/capabilities\.yml/);

  const [broken] = buildCapabilityTree({ capabilityMap: { error: "Capability 'x' references unknown parent 'y'." } });
  assert.match(broken.label, /references unknown parent/);
  assert.equal(broken.icon, 'error');
});

test('a tree node resolves back to the thing it stands for', () => {
  // The commands act on what was clicked, so the mapping back has to be exact rather than a guess
  // from the label.
  const [commerce] = buildCapabilityTree({ capabilityMap: { capabilities: capabilityFixture } });
  assert.equal(capabilityIdOf(commerce), 'commerce');
  assert.equal(capabilityIdOf(capabilitiesUnder(capabilitiesUnder(commerce)[0])[0]), 'payments-api');
  assert.equal(capabilityIdOf({ id: 'workspace:/work/commerce' }), null);
  assert.equal(capabilityIdOf(undefined), null);
  // A capability's own rows sit under its id with a further segment. They are not capabilities, and
  // handing one to an edit command opens a screen on something that does not exist.
  assert.equal(capabilityIdOf({ id: 'capability:commerce:repository:commerce-api' }), null);
  assert.equal(capabilityIdOf({ id: 'capability:commerce:world-model' }), null);
  assert.equal(capabilityIdOf({ id: 'capability:' }), null);

  const [workspace] = buildWorkspaceTree(REGISTRY);
  assert.equal(workspacePathOf(workspace), '/work/commerce');
  assert.equal(workspacePathOf({ id: 'workspace:/work/payments:lead' }), '/work/payments');
  assert.equal(workspacePathOf({ id: 'capability:commerce' }), null);
});

const { buildDashboard, buildLifecycleAnalytics, dashboardHealth, humanizeDuration } =
  await import(source('views/dashboard-model.ts'));

const DIAGNOSTICS = {
  repository: '/work/platform', branch: 'SF-1',
  checks: [
    { id: 'node', status: 'pass', message: 'Node.js 22.14.0', fix: null },
    { id: 'git', status: 'pass', message: 'git 2.43', fix: null },
    { id: 'world-model', status: 'warn', message: 'No world model has been built.', fix: 'singularity-flow wm build' },
    { id: 'approvers', status: 'fail', message: 'No approval authority has a member.', fix: 'Edit singularity/portfolio.yml' },
    { id: 'jira', status: 'skip', message: 'Jira is not configured.', fix: null }
  ]
};

test('the dashboard leads with what would stop work, worst first', () => {
  // A dashboard that opens with a row of counts teaches people to skim past the one line that
  // mattered. Failures come first, and passing checks are a number rather than a list.
  const dashboard = buildDashboard({ ...snapshot, diagnostics: DIAGNOSTICS });
  assert.deepEqual(dashboard.failing.map((check) => check.id), ['approvers', 'world-model', 'jira']);
  assert.equal(dashboard.passing, 2);
  assert.equal(dashboard.repository, '/work/platform');
  assert.equal(dashboardHealth(dashboard), 'fail');
  assert.equal(dashboard.quiet, false);
});

test('a healthy repository with nothing waiting says exactly that', () => {
  const dashboard = buildDashboard({
    ...snapshot,
    initiative: null,
    diagnostics: { repository: '/work/platform', branch: 'main', checks: [{ id: 'node', status: 'pass', message: 'ok' }] },
    approvalInbox: { count: 0, fetched: true },
    agentStatus: [],
    ledger: { enabled: true, config: { branch: 'state' } }
  });
  assert.deepEqual(dashboard.failing, []);
  assert.equal(dashboard.quiet, true);
  assert.equal(dashboardHealth(dashboard), 'skip', 'no Epic is a state, not a fault');
});

test('anything waiting on a person is surfaced, because it will not resolve itself', () => {
  const dashboard = buildDashboard({ ...snapshot, approvalInbox: { count: 3, fetched: true } });
  const approvals = dashboard.sections.find((section) => section.id === 'approvals');
  assert.equal(approvals.status, 'warn');
  assert.match(approvals.headline, /3 approvals are waiting on you/);
  assert.equal(dashboard.quiet, false, 'something waiting is not quiet');

  const unread = buildDashboard({ ...snapshot, approvalInbox: { count: 0, fetched: false } });
  assert.match(unread.sections.find((section) => section.id === 'approvals').detail.join(' '),
    /counts only what is already local/);
});

test('an agent that drifted from what it was locked to is reported', () => {
  const dashboard = buildDashboard({
    ...snapshot,
    agentStatus: [
      { id: 'sflow-workflow', scope: 'plugin', status: 'locked', locked: true, sourceChanged: true },
      { id: 'reviewer', scope: 'repository', status: 'local-only', locked: false }
    ]
  });
  const agents = dashboard.sections.find((section) => section.id === 'agents');
  assert.equal(agents.status, 'warn');
  assert.match(agents.headline, /2 agents, 1 changed since being locked/);
  assert.match(agents.detail.join(' '), /sflow-workflow has changed/);
  assert.match(agents.detail.join(' '), /1 not yet locked/);
});

test('a repository with no state branch says what that costs', () => {
  // Not an error — a repository can be governed without one. The difference decides whether
  // workflow progress is recoverable from Git, which is worth stating rather than implying.
  const dashboard = buildDashboard({ ...snapshot, ledger: { enabled: false } });
  const governance = dashboard.sections.find((section) => section.id === 'governance');
  assert.equal(governance.status, 'skip');
  assert.match(governance.headline, /not recorded in Git/);

  const enabled = buildDashboard({ ...snapshot, ledger: { enabled: true, config: { branch: 'state' } } });
  assert.match(enabled.sections.find((section) => section.id === 'governance').headline, /recorded on state/);
});

test('the Epic section reports where it has got to, and what is holding it', () => {
  const dashboard = buildDashboard(snapshot);
  const epic = dashboard.sections.find((section) => section.id === 'epic');
  assert.match(epic.headline, /is in |phases approved/);
  assert.match(epic.detail.join(' '), /phases approved/);

  const none = buildDashboard({ ...snapshot, initiative: null });
  assert.match(none.sections.find((section) => section.id === 'epic').headline, /Nothing governed is checked out/);
});

const LIFECYCLE_REPORT = {
  schemaVersion: 1,
  generatedAt: '2026-08-04T12:00:00.000Z',
  workItem: { id: 'STORY-42', title: 'Trace governed analytics', workType: 'feature', branch: 'STORY-42', status: 'in_progress' },
  startedAt: '2026-08-04T08:00:00.000Z', completedAt: null,
  elapsedMs: 14_400_000, activeMs: 9_000_000, waitingMs: 5_400_000,
  reworkCycles: 1,
  rejections: [{ phase: 'requirements' }],
  selfApprovals: 1,
  sequenceOverrides: [{ gate: 'freshGeneration' }],
  tokens: {
    total: 18_000, exactRecords: 2, unavailableRecords: 1, byAgent: {}, byPhase: {},
    byModel: [{
      provider: 'github-copilot', model: 'model-alpha', records: 3, exactRecords: 2,
      unavailableRecords: 1, totalTokens: 18_000, cost: 0.42, costStatus: 'partial'
    }]
  },
  cost: 0.42, costStatus: 'partial',
  costCoverage: {
    usageRecords: 3, exactUsageRecords: 2, pendingRecords: 0, pricedRecords: 2,
    fullyPricedRecords: 2, providerCostRecords: 2, configuredPriceRecords: 0,
    missingModels: ['github-copilot/model-alpha']
  },
  bottleneck: { phase: 'requirements', waitingMs: 5_400_000, share: 38 },
  phases: [
    {
      id: 'intake', label: 'Intake', status: 'approved', generations: 1,
      elapsedMs: 3_600_000, activeMs: 3_000_000, waitingMs: 600_000, openSubmission: null,
      approvals: 1, selfApprovals: 0, rejections: [], usageRecords: 1, pendingTelemetry: 0,
      tokens: 8_000, tokenStatus: 'exact', models: ['model-alpha'],
      modelUsage: [], agents: ['product-owner'], cost: 0.2, costStatus: 'exact'
    },
    {
      id: 'requirements', label: 'Requirements', status: 'approved', generations: 2,
      elapsedMs: 7_200_000, activeMs: 2_400_000, waitingMs: 4_800_000, openSubmission: null,
      approvals: 1, selfApprovals: 1, rejections: [{}], usageRecords: 2, pendingTelemetry: 0,
      tokens: 10_000, tokenStatus: 'partial', models: ['model-alpha'],
      modelUsage: [], agents: ['product-owner'], cost: 0.22, costStatus: 'partial'
    },
    {
      id: 'design', label: 'Design', status: 'in_progress', generations: 1,
      elapsedMs: 3_600_000, activeMs: 3_600_000, waitingMs: 0, openSubmission: null,
      approvals: 0, selfApprovals: 0, rejections: [], usageRecords: 0, pendingTelemetry: 0,
      tokens: 0, tokenStatus: 'none', models: [], modelUsage: [], agents: [], cost: null, costStatus: 'unavailable'
    }
  ]
};

test('lifecycle analytics presents phase completion, time, usage, cost, and governance from one report', () => {
  const analytics = buildLifecycleAnalytics(LIFECYCLE_REPORT);
  assert.equal(analytics.id, 'STORY-42');
  assert.equal(analytics.completionPercent, 67);
  assert.equal(analytics.currentPhase, 'design');
  assert.equal(analytics.usageStatus, 'partial');
  assert.equal(analytics.totalTokens, 18_000);
  assert.equal(analytics.cost, 0.42);
  assert.equal(analytics.reworkCycles, 1);
  assert.equal(analytics.rejections, 1);
  assert.equal(analytics.selfApprovals, 1);
  assert.equal(analytics.phases.find((phase) => phase.id === 'requirements').waitingShare, 67);
  assert.equal(humanizeDuration(analytics.elapsedMs), '4.0h');
});

test('missing provider telemetry is unavailable rather than a misleading zero', () => {
  const report = structuredClone(LIFECYCLE_REPORT);
  report.tokens.total = 0;
  report.tokens.byModel = [];
  report.cost = null;
  report.costStatus = 'unavailable';
  report.costCoverage = { ...report.costCoverage, usageRecords: 1, exactUsageRecords: 0, pricedRecords: 0 };
  const analytics = buildLifecycleAnalytics(report);
  assert.equal(analytics.usageStatus, 'unavailable');
  assert.equal(analytics.cost, null);
  assert.equal(humanizeDuration(null), 'Unavailable');
});

test('the status dashboard carries lifecycle analytics without inventing them when no Story is selected', () => {
  const withStory = buildDashboard({ ...snapshot, report: LIFECYCLE_REPORT });
  assert.equal(withStory.analytics.id, 'STORY-42');
  const withoutStory = buildDashboard({ ...snapshot, report: null });
  assert.equal(withoutStory.analytics, null);
});

const { buildProfiles, buildTemplateUsage, consequence, standingOn } =
  await import(source('views/designer-model.ts'));
const { designerHtml } = await import(source('views/designer-page.ts'));
const { newArtifactDraft, renderArtifactTemplate, sectionFor, validateArtifactDraft } =
  await import(source('views/artifact-designer-model.ts'));
const {
  instructionCatalog, parseAgent, parseSkill, renderAgent, renderAgentMappings, renderSkill,
  validateAgent, validateAgentMappingsDraft, validateSkill
} = await import(source('views/instruction-designer-model.ts'));
const { instructionDesignerHtml, INSTRUCTION_DESIGNER_SCRIPT } =
  await import(source('views/instruction-designer-page.ts'));

test('the instruction designer browser script is valid JavaScript', () => {
  assert.doesNotThrow(() => new Function(INSTRUCTION_DESIGNER_SCRIPT));
});

const DESIGN_SNAPSHOT = {
  portfolioPath: 'singularity/portfolio.yml',
  definitionPath: 'singularity/workflow.yml',
  portfolio: {
    initiativeProfiles: {
      'enterprise-delivery': { label: 'Enterprise delivery', phases: ['discover-define', 'delivery'] }
    },
    initiativePhases: {
      'discover-define': {
        label: 'Discover & Define',
        outputs: [
          { id: 'business-case', label: 'Business case', required: true,
            template: 'initiatives/business-case.md',
            approval: { mode: 'individual', authorities: ['product-approvers'], minimum: 1 } },
          { id: 'source-catalog', label: 'Source catalog', required: false, template: null, generator: 'source-catalog' }
        ],
        checklist: [{ id: 'business-case-exists', label: 'Business case exists' }],
        bundleApproval: { mode: 'bundle', chain: [{ authority: 'product-approvers', label: 'Product Governance' }] }
      },
      delivery: { label: 'Delivery', outputs: [], checklist: [] }
    }
  },
  templates: [
    { path: 'singularity/templates/initiatives/business-case.md', name: 'business-case.md', bytes: 2185 },
    { path: 'singularity/templates/initiatives/unused-draft.md', name: 'unused-draft.md', bytes: 400 }
  ],
  initiatives: [
    { id: 'SF-1', title: 'One-tap checkout', status: 'in_progress', currentPhase: 'discover-define',
      pinnedTemplates: [{ path: 'singularity/templates/initiatives/business-case.md', sha256: 'abc' }] },
    { id: 'SF-0', title: 'Closed thing', status: 'complete',
      pinnedTemplates: [{ path: 'singularity/templates/initiatives/business-case.md', sha256: 'abc' }] }
  ]
};

test('the designer reads a profile as the ordered phases it actually runs', () => {
  const [profile] = buildProfiles(DESIGN_SNAPSHOT);
  assert.equal(profile.label, 'Enterprise delivery');
  assert.deepEqual(profile.phases.map((phase) => phase.id), ['discover-define', 'delivery']);
  assert.deepEqual(profile.phases.map((phase) => phase.order), [0, 1]);

  const [discover] = profile.phases;
  assert.equal(discover.outputs.length, 2);
  assert.equal(discover.outputs[0].template, 'initiatives/business-case.md');
  assert.equal(discover.outputs[1].generator, 'source-catalog', 'generated outputs have no template');
  assert.equal(discover.bundleApproval.chain[0].label, 'Product Governance');
});

test('a template knows what points at it and who is standing on it', () => {
  // The files cannot tell you either. That is the whole reason this is a screen.
  const usage = buildTemplateUsage(DESIGN_SNAPSHOT);
  const businessCase = usage.find((entry) => entry.name === 'business-case.md');
  assert.deepEqual(businessCase.usedBy, [
    { profile: 'enterprise-delivery', phase: 'discover-define', output: 'business-case' }
  ]);
  // Only Epics still running: a closed one has nothing left to stop.
  assert.deepEqual(businessCase.standing.map((entry) => entry.id), ['SF-1']);

  const unused = usage.find((entry) => entry.name === 'unused-draft.md');
  assert.deepEqual(unused.usedBy, [], 'listed rather than hidden — it may be about to be wired up');
  assert.deepEqual(unused.standing, []);
});

test('editing the portfolio stops every running Epic, and the screen says so first', () => {
  // An Epic pins the portfolio hash at start and validates against those exact bytes for the rest
  // of its life. Editing it does not change the Epic — it stops it, at whatever moment somebody
  // next runs a phase.
  const standing = standingOn(DESIGN_SNAPSHOT, 'singularity/portfolio.yml');
  assert.deepEqual(standing.map((entry) => entry.id), ['SF-1']);
  assert.match(consequence(standing, 'singularity/portfolio.yml'),
    /1 running Epic pinned .*it stops it at the next phase/);

  const template = standingOn(DESIGN_SNAPSHOT, 'singularity/templates/initiatives/business-case.md');
  assert.deepEqual(template.map((entry) => entry.id), ['SF-1']);

  // A template nobody pinned is a free edit, and saying so is as useful as the warning.
  const free = standingOn(DESIGN_SNAPSHOT, 'singularity/templates/initiatives/unused-draft.md');
  assert.deepEqual(free, []);
  assert.match(consequence(free, 'unused-draft.md'), /changes what the next Epic starts from and nothing else/);
});

test('the phases tab shows each artifact, whether it is required, and what approves it', () => {
  const html = designerHtml('phases', buildProfiles(DESIGN_SNAPSHOT), [], null, 'all',
    standingOn(DESIGN_SNAPSHOT, 'singularity/portfolio.yml'), 'singularity/portfolio.yml', null);
  assert.match(html, /Discover &amp; Define/);
  assert.match(html, /Business case/);
  assert.match(html, /required/);
  assert.match(html, /Product Governance/);
  assert.match(html, /Generated by source-catalog/);
  // The warning leads, because it is the thing the file cannot tell you.
  assert.match(html, /1 running Epic pinned/);
});

test('the templates tab can be filtered to what is risky and what is dead', () => {
  const templates = buildTemplateUsage(DESIGN_SNAPSHOT);
  const pinned = designerHtml('templates', [], templates, null, 'pinned', [], 'singularity/portfolio.yml', null);
  assert.match(pinned, /business-case\.md/);
  assert.doesNotMatch(pinned, /unused-draft\.md/);

  const unused = designerHtml('templates', [], templates, null, 'unused', [], 'singularity/portfolio.yml', null);
  assert.match(unused, /unused-draft\.md/);
  assert.doesNotMatch(unused, /business-case\.md/);

  const all = designerHtml('templates', [], templates, null, 'all', [], 'singularity/portfolio.yml', null);
  assert.match(all, /SF-1/, 'the Epic standing on it is named on the row');
  assert.match(all, /Artifact template designer/);
  assert.match(all, /data-section-canvas/);
});

test('the artifact designer emits traceable Markdown and validates unsafe paths', () => {
  const draft = newArtifactDraft();
  Object.assign(draft, {
    governs: 'initiative', phaseId: 'elaboration', outputId: 'solution-architecture',
    outputLabel: 'Solution architecture', outputPath: 'solution-architecture.md',
    fileName: 'initiatives/solution-architecture.md', title: 'Solution Architecture',
    purpose: 'Define the approved system boundaries.',
    sections: [sectionFor('requirements'), sectionFor('acceptance-criteria'), sectionFor('evidence')]
  });
  assert.deepEqual(validateArtifactDraft(draft), []);
  const markdown = renderArtifactTemplate(draft);
  assert.match(markdown, /REQ-001/);
  assert.match(markdown, /AC-001/);
  assert.match(markdown, /\{\{inputs\}\}/);
  draft.fileName = '../outside.md';
  assert.match(validateArtifactDraft(draft).join(' '), /safe \.md path/);
});

test('the instruction designer separates agents, prompts, repository skills and packaged prompt packs', () => {
  const instructionSnapshot = {
    definition: {
      phases: { design: { label: 'Design', agents: ['architect'], worldModel: { views: ['architecture'] } } },
      planning: { promptSource: 'singularity/prompts/planning.md' },
      worldModel: { views: ['architecture', 'security'], promptSource: 'singularity/prompts/worldmodel-builder.md' }
    },
    portfolio: { initiativePhases: {} },
    worldModel: { views: [{ id: 'development', references: [] }] },
    agents: [{ id: 'architect', scope: 'repository', path: '.github/agents/architect.agent.md', editable: true,
      content: `---\nname: architect\ndescription: Designs systems.\ntools: [read, search]\nmetadata:\n  sflow-label: "Architect"\n  sflow-phases: "design"\n  sflow-default-for: "design"\n  sflow-world-model-views: "architecture,security"\n---\n\n# Architect\n\nUse evidence.\n\n## Remote skills\n\n| ID | URL | Phases | Optional | Max bytes |\n|---|---|---|---|---|\n| security-guide | https://docs.example.test/security.md | design | false | 4096 |\n\n## Remote artifact templates\n\n| ID | URL | Phases | Optional | Max bytes |\n|---|---|---|---|---|\n| design-template | https://docs.example.test/design.md | design | false | - |\n\n## Remote generated artifacts\n\n| ID | URL template | Phase | Target | Optional | Max bytes |\n|---|---|---|---|---|---|\n| external-review | https://docs.example.test/{workId}/review.md | design | artifacts/design/external-review.md | true | - |` }],
    agentMappings: { path: 'singularity/agent-mappings.yml', exists: true, rows: [
      { copilotAgent: 'architecture', agentId: 'architect', source: 'configured' },
      { copilotAgent: 'architect', agentId: 'architect', source: 'same-name fallback' }
    ] },
    agentStatus: [{ id: 'architect', scope: 'repository', source: '.github/agents/architect.agent.md',
      sourceSha256: 'abc', locked: false, sourceChanged: false, status: 'unlocked',
      dependencies: [{ id: 'security-guide', type: 'skill', optional: false, locked: false, sha256: null, status: 'unlocked' }] }],
    prompts: [{ path: 'singularity/prompts/planning.md', name: 'planning.md', content: '# Planning' }],
    repositorySkills: [{ path: '.github/skills/sf-review/SKILL.md', name: 'SKILL.md', content: `---\nname: sf-review\ndescription: Review work.\nargument-hint: "[ID]"\ndisable-model-invocation: false\n---\n\n# Review` }],
    flowSkills: [{ id: 'sf-help', path: 'plugin/skills/sf-help/SKILL.md', repositoryPath: '.github/skills/sf-help/SKILL.md', description: 'Explain Flow.', content: '# Help' }]
  };
  const catalog = instructionCatalog(instructionSnapshot);
  assert.equal(catalog.agents.length, 1);
  assert.equal(catalog.prompts.length, 1);
  assert.equal(catalog.skills.length, 1);
  assert.equal(catalog.packs.length, 1);
  assert.deepEqual(catalog.worldModelViews, ['architecture', 'development', 'security']);
  assert.deepEqual(catalog.promptUsage['singularity/prompts/planning.md'], ['Copilot planning']);

  const parsed = parseAgent(catalog.agents[0].content, 'architect');
  assert.deepEqual(parsed.phases, ['design']);
  assert.deepEqual(parsed.worldModelViews, ['architecture', 'security']);
  assert.equal(parsed.remoteSkills[0].id, 'security-guide');
  assert.equal(parsed.remoteTemplates[0].id, 'design-template');
  assert.equal(parsed.remoteOutputs[0].target, 'artifacts/design/external-review.md');
  assert.deepEqual(validateAgent(parsed), []);
  assert.match(renderAgent(parsed), /## Remote generated artifacts/);
  assert.match(renderAgent(parsed), /\| ID \| URL \| Phases \| Optional \| Max bytes \|/);
  assert.doesNotMatch(renderAgent(parsed), /\| Personas \|/);
  assert.deepEqual(validateAgentMappingsDraft([{ copilotAgent: 'architecture', agentId: 'architect' }], ['architect']), []);
  assert.match(renderAgentMappings([{ copilotAgent: 'architecture', agentId: 'architect' }]), /"architecture": "architect"/);
  assert.deepEqual(validateAgentMappingsDraft([
    { copilotAgent: 'Playwright Test Engineer', agentId: 'architect' }
  ], ['architect']), []);
  assert.match(renderAgentMappings([
    { copilotAgent: 'Playwright Test Engineer', agentId: 'architect' }
  ]), /"Playwright Test Engineer": "architect"/);
  assert.match(validateAgentMappingsDraft([
    { copilotAgent: 'bad\/agent', agentId: 'architect' }
  ], ['architect']).join(' '), /invalid/);

  const skill = parseSkill(instructionSnapshot.repositorySkills[0].content, 'sf-review');
  assert.deepEqual(validateSkill(skill), []);
  assert.match(renderSkill(skill), /disable-model-invocation: false/);

  const html = instructionDesignerHtml(catalog, {
    tab: 'agents', selected: catalog.agents[0], agent: parsed, prompt: null, skill: null, errors: [], notice: null
  });
  assert.match(html, /Agents, prompts &amp; skills/);
  assert.match(html, /Prompt composition/);
  assert.match(html, /Phase contract/);
  assert.match(html, /Repository world-model views/);

  const delivery = instructionDesignerHtml(catalog, {
    tab: 'delivery', selected: null, agent: null, prompt: null, skill: null, errors: [], notice: null
  });
  assert.match(delivery, /Copilot → Flow agent mappings/);
  assert.match(delivery, /architecture/);
  assert.match(delivery, /Remote resource trust/);
  assert.match(delivery, /Review (?:&|&amp;) trust/);
});


test('VS Code exposes workspace prompt auditing and records the governed Copilot handoff', async () => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'apps', 'vscode', 'package.json'), 'utf8'));
  assert.ok(packageJson.contributes.commands.some((entry) => entry.command === 'singularityFlow.openPromptAudit'));
  // Reachable from the Configuration Center, which is the only Configuration surface now.
  const center = await readFile(source('views/configuration-center-page.ts'), 'utf8');
  assert.match(center, /action: 'open-prompt-audit'/);

  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.match(extension, /\['wm', 'show-prompt', '--record-audit'\]/,
    'the exact governed prompt rendered for native Copilot is captured only at handoff');
  const storyHandoff = extension.slice(
    extension.indexOf('const openGovernedCopilot'), extension.indexOf('const openWorkspaceCopilot')
  );
  assert.match(storyHandoff, /query: prompt/);
  assert.doesNotMatch(storyHandoff, /query: handoff/);
  const panel = await readFile(source('views/prompt-audit.ts'), 'utf8');
  assert.match(panel, /\['prompt-log', 'list', '--include-prompt'/);
  assert.match(panel, /\['prompt-log', this\.snapshot\?\.enabled \? 'off' : 'on'/);
  for (const section of ['Model and execution', 'Tools', 'Tokens and cost', 'Request and output', 'Prompt']) {
    assert.match(panel, new RegExp(section));
  }
  assert.match(panel, /Observed calls<\/dt><dd>Unavailable/);
  assert.match(panel, /not provider billing usage/);
});

test('cancelled dirty Story intake offers a recoverable release before reopening the form', async () => {
  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.match(extension, /Preserve changes & return to base/);
  assert.match(extension, /'cancel', cancelled\.workItem\.id, '--release', '--apply'/);
  assert.match(extension, /return startWork\(defaults\)/);
  assert.doesNotMatch(extension, /git stash/,
    'the extension delegates preservation to the engine instead of mutating Git itself');
});

test('Flow Impact has a dedicated configuration and reporting entry point', async () => {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'apps', 'vscode', 'package.json'), 'utf8'));
  assert.ok(packageJson.contributes.commands.some((entry) => entry.command === 'singularityFlow.openFlowImpact'));
  const center = await readFile(source('views/configuration-center-page.ts'), 'utf8');
  assert.match(center, /action: 'open-flow-impact'/, 'the Center renders Flow Impact in grouped navigation');
  assert.ok(center.includes("'open-flow-impact'") && center.includes('data-action="open-impact-file"'));
  const extensionSource = await readFile(source('extension.ts'), 'utf8');
  assert.match(extensionSource, /'open-flow-impact'\) await vscode\.commands\.executeCommand\('singularityFlow\.openFlowImpact'\)/);
  assert.match(extensionSource, /'open-impact-file'\)[\s\S]{0,200}singularity\/impact\.yml/);
  const panel = await readFile(source('views/flow-impact.ts'), 'utf8');
  assert.match(panel, /Governed delivery measurement/);
  assert.match(panel, /Story measurement/);
  assert.match(panel, /Cohort comparison/);
  assert.match(panel, /minimumCohortSize/);
  assert.match(panel, /impact', 'doctor'/);
  assert.match(panel, /impact', 'export'/);
});

test('capability proposals have an exact review and activation UI', async () => {
  const packageJson = JSON.parse(await readFile(
    path.join(packageRoot, 'apps', 'vscode', 'package.json'), 'utf8'));
  assert.ok(packageJson.contributes.commands.some(
    (entry) => entry.command === 'singularityFlow.reviewCapabilityProposals'));

  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.match(extension, /CapabilityProposalsPanel\.show/,
    'the command opens a first-class proposal dashboard rather than a sequence of quick picks');
  assert.match(extension, /CapabilityProposalPanel\.show/);
  const dashboard = await readFile(source('views/capability-proposals.ts'), 'utf8');
  assert.match(dashboard, /capability', 'leads'/,
    'the dashboard discovers every registered organisation lead');
  assert.match(dashboard, /capability', 'proposals'/,
    'the dashboard lists pending proposals for each lead');
  assert.match(dashboard, /No proposals waiting/);
  assert.match(dashboard, /ready for exact review/);
  assert.match(dashboard, /blocked by validation/);
  assert.match(dashboard, /Show merged history/);
  assert.match(dashboard, /'--all'/,
    'the same UI can inspect retained merged proposal branches without making them actionable');
  assert.match(dashboard, /data-review/,
    'each proposal opens the exact review screen');
  const panel = await readFile(source('views/capability-proposal.ts'), 'utf8');
  assert.match(panel, /capability', 'proposal'/);
  assert.match(panel, /capability', 'activate'/);
  assert.match(panel, /--confirm', proposal\.proposalCommit/,
    'activation is bound to the complete reviewed proposal commit');
  assert.match(panel, /--acknowledge-unprotected/,
    'VS Code passes the explicit acknowledgement obtained in its modal confirmation');
  assert.match(panel, /Activation audit:/,
    'the activation receipt is visible rather than discarded');
  assert.match(panel, /application default branch is not part of this operation/i);
  assert.match(panel, /normal non-force Git push/i);
  assert.match(panel, /proposal\.merged \? 'Record merged activation'/,
    'an externally merged exact proposal remains actionable for audit and projection recovery');
  assert.match(panel, /Retry exact activation/,
    'a preserved review-required proposal can be retried without starting another proposal');
  assert.match(panel, /Available recovery paths|After correcting the blocker/,
    'the review surface shows the exact recovery rather than only a failure sentence');
  const workspacePanel = await readFile(source('views/workspace-panel.ts'), 'utf8');
  assert.match(workspacePanel, /refresh \? \['--refresh'\] : \[\]/,
    'the workspace refresh action bypasses the durable organisation cache');
  assert.match(workspacePanel, /validated cached capability map/,
    'offline cache use is visibly disclosed');
  const center = await readFile(source('views/configuration-center-page.ts'), 'utf8');
  assert.match(center, /Review proposals/,
    'the Configuration Center exposes the dashboard directly');
});

test('configuration recovery stays inside VS Code for conflicting MCP host entries', async () => {
  const extension = await readFile(source('extension.ts'), 'utf8');
  assert.match(extension, /detail\.includes\('--replace-server'\)/,
    'the host-entry conflict is distinguished from unrelated failures');
  assert.match(extension, /Replace the existing Playwright MCP host entry\?/,
    'the contributor reviews the replacement in a modal UI');
  assert.match(extension, /\['mcp', 'scaffold', 'playwright', '--replace-server'\]/,
    'the accepted recovery invokes the engine escape hatch itself');
  assert.match(extension, /Other MCP servers and inputs are preserved/,
    'the confirmation explains the bounded write scope');
});
