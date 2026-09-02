import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  clearWindowsExecutableCache, resolvePlatformProcess, resolveWindowsBatchProcess,
  resolveWindowsPathExecutable, tryWindowsTaskkill
} from '../src/platform-process.mjs';
import { commandExists, run } from '../src/util.mjs';

const windowsEnvironment = Object.freeze({
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  SystemRoot: 'C:\\Windows'
});
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function trustedPackageManagerLookup(command, args, options) {
  assert.equal(command, 'C:\\Windows\\System32\\where.exe');
  assert.equal(options.shell, false);
  const manager = String(args[0]).match(/\$PATH:(npm|npx)\.cmd/i)?.[1]?.toLowerCase();
  assert.ok(manager, `unexpected PATH-only lookup: ${args.join(' ')}`);
  return {
    status: 0,
    // A relative current-directory result is deliberately ignored. Only the PATH-bound absolute
    // package-manager shim is eligible for the physical launch.
    stdout: `.\\${manager}.cmd\r\nC:\\Program Files\\nodejs\\${manager}.cmd\r\n`,
    stderr: ''
  };
}

test('platform process resolution preserves logical argv on ordinary direct launches', () => {
  const args = ['--test', 'value with spaces'];
  const launch = resolvePlatformProcess('node', args, { platform: 'linux' });
  assert.equal(launch.logicalCommand, 'node');
  assert.deepEqual(launch.logicalArguments, args);
  assert.equal(launch.physicalExecutable, 'node');
  assert.equal(launch.executable, 'node');
  assert.deepEqual(launch.arguments, args);
  assert.deepEqual(launch.spawnOptions, { shell: false });
  assert.deepEqual(args, ['--test', 'value with spaces'], 'the caller-owned argv must not be rewritten');
});

test('Windows npm and npx use narrow cmd-shim launches without changing logical identity', () => {
  const environment = windowsEnvironment;
  for (const command of ['npm', 'npx']) {
    const logicalArguments = ['run', 'test suite', 'x&y|z'];
    const launch = resolvePlatformProcess(command, logicalArguments, {
      platform: 'win32', environment, spawnSyncCommand: trustedPackageManagerLookup
    });
    assert.equal(launch.logicalCommand, command);
    assert.deepEqual(launch.logicalArguments, logicalArguments);
    assert.equal(launch.physicalExecutable, `C:\\Program Files\\nodejs\\${command}.cmd`);
    assert.equal(launch.executable, environment.ComSpec);
    assert.deepEqual(launch.arguments.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
    assert.match(launch.arguments[4], new RegExp(`${command}\\.cmd`));
    assert.match(launch.arguments[4], /\^\^\^&/, 'metacharacters are escaped through both cmd parsing passes');
    assert.deepEqual(launch.spawnOptions, { shell: false, windowsVerbatimArguments: true });
    assert.deepEqual(logicalArguments, ['run', 'test suite', 'x&y|z']);
  }
});

test('Windows npm and npx fail closed for cmd environment-expansion bytes', () => {
  for (const unsafe of ['%PATH%', '!DELAYED!']) {
    assert.throws(
      () => resolvePlatformProcess('npx', ['--package', unsafe], {
        platform: 'win32', environment: windowsEnvironment,
        spawnSyncCommand: trustedPackageManagerLookup
      }),
      /cannot contain % or !/
    );
  }
  assert.throws(
    () => resolveWindowsBatchProcess('C:\\unsafe%name\\npx.cmd', [], {
      environment: windowsEnvironment
    }),
    /cannot contain % or !/
  );
  for (const target of [
    'npm.cmd', '\\npm.cmd', 'C:npm.cmd',
    '\\\\?\\C:\\npm.cmd', '\\\\?/C:/npm.cmd', '\\\\.\\pipe\\npm.cmd', '\\\\./pipe/npm.cmd'
  ]) {
    assert.throws(
      () => resolveWindowsBatchProcess(target, [], { environment: windowsEnvironment }),
      /fully qualified path/
    );
  }
});

test('Windows resolver binds arbitrary executables to PATH-only absolute identities and wraps explicit npm paths', () => {
  const direct = resolvePlatformProcess('python', ['-m', 'pytest'], {
    platform: 'win32', environment: windowsEnvironment,
    spawnSyncCommand(command, args, options) {
      assert.equal(command, 'C:\\Windows\\System32\\where.exe');
      assert.equal(options.cwd, 'C:\\Windows\\System32');
      if (args[0] === '$PATH:python.*') {
        return { status: 0, stdout: '.\\python.exe\r\nC:\\Python312\\python.exe\r\n' };
      }
      return { status: 1, stdout: '' };
    }
  });
  assert.equal(direct.executable, 'C:\\Python312\\python.exe');
  assert.equal(direct.physicalExecutable, direct.executable);
  assert.deepEqual(direct.arguments, ['-m', 'pytest']);
  assert.deepEqual(direct.spawnOptions, { shell: false });

  const npmPath = 'C:\\Program Files\\Node & Tools\\npm.cmd';
  const wrapped = resolvePlatformProcess(npmPath, ['view', '@scope/pkg@1.0.0'], {
    platform: 'win32', environment: windowsEnvironment
  });
  assert.equal(wrapped.logicalCommand, npmPath);
  assert.equal(wrapped.physicalExecutable, npmPath);
  assert.equal(wrapped.executable, windowsEnvironment.ComSpec);
  assert.match(wrapped.arguments[4], /Program\^ Files/);
  assert.match(wrapped.arguments[4], /\^&/);
  assert.throws(
    () => resolvePlatformProcess('npm', ['unsafe\nargument'], {
      platform: 'win32', environment: windowsEnvironment,
      spawnSyncCommand: trustedPackageManagerLookup
    }),
    /control characters/
  );
});

test('Windows command availability uses trusted PATH-only lookup and ignores the repository cwd', () => {
  const calls = [];
  assert.equal(commandExists('copilot', {
    platform: 'win32', environment: windowsEnvironment,
    spawnSyncCommand(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === '$PATH:copilot.*') {
        return { status: 0, stdout: '.\\copilot.cmd\r\nC:\\Tools\\copilot.cmd\r\n' };
      }
      return { status: 1, stdout: '' };
    }
  }), true);
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((call) => call.command === 'C:\\Windows\\System32\\where.exe'));
  assert.ok(calls.every((call) => call.options.cwd === 'C:\\Windows\\System32'));
  assert.ok(calls.every((call) => call.options.shell === false));

  assert.equal(commandExists('.\\tools\\copilot.cmd', {
    platform: 'win32', environment: windowsEnvironment,
    spawnSyncCommand: () => { throw new Error('must not execute'); }
  }), false);

  for (const unsafe of [
    '\\copilot.exe', 'C:copilot.exe', 'C:',
    '\\\\?\\C:\\copilot.exe', '\\\\?/C:/copilot.exe',
    '\\\\.\\pipe\\copilot.exe', '\\\\./pipe/copilot.exe'
  ]) {
    assert.equal(commandExists(unsafe, {
      platform: 'win32', environment: windowsEnvironment,
      existsFile: () => { throw new Error('unsafe identity must not be probed'); },
      spawnSyncCommand: () => { throw new Error('unsafe identity must not enter PATH lookup'); }
    }), false);
  }
});

test('Windows tree termination contains system-tool resolution failures and reports only proof', () => {
  let calls = 0;
  assert.equal(tryWindowsTaskkill(42, {
    environment: {},
    spawnSyncCommand: () => { calls += 1; return { status: 0 }; }
  }), false);
  assert.equal(calls, 0, 'missing SystemRoot is refused before process creation');

  const invocations = [];
  assert.equal(tryWindowsTaskkill(42, {
    force: true,
    environment: windowsEnvironment,
    spawnSyncCommand(command, args, options) {
      invocations.push({ command, args, options });
      return { status: 0, error: null };
    }
  }), true);
  assert.deepEqual(invocations[0].command, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(invocations[0].args, ['/PID', '42', '/T', '/F']);
  assert.equal(invocations[0].options.shell, false);
  assert.equal(tryWindowsTaskkill(42, {
    environment: windowsEnvironment,
    spawnSyncCommand: () => { throw new Error('fixture spawn failure'); }
  }), false);
});

test('Windows PATH resolution uses one lookup and a bounded reusable positive cache', () => {
  clearWindowsExecutableCache();
  let lookups = 0;
  const environment = { ...windowsEnvironment, PATH: 'C:\\Git\\cmd', PATHEXT: '.EXE;.CMD' };
  const lookup = (command, args) => {
    lookups += 1;
    assert.equal(command, 'C:\\Windows\\System32\\where.exe');
    assert.deepEqual(args, ['$PATH:git.*']);
    return { status: 0, stdout: '.\\git.exe\r\nC:\\Git\\cmd\\git.exe\r\n' };
  };
  assert.equal(resolveWindowsPathExecutable('git', {
    environment, spawnSyncCommand: lookup, cache: true,
    lstatSyncCommand: () => ({ isFile: () => true, isSymbolicLink: () => false })
  }), 'C:\\Git\\cmd\\git.exe');
  assert.equal(resolveWindowsPathExecutable('git', {
    environment, spawnSyncCommand: lookup, cache: true,
    lstatSyncCommand: () => ({ isFile: () => true, isSymbolicLink: () => false })
  }), 'C:\\Git\\cmd\\git.exe');
  assert.equal(lookups, 1);
  clearWindowsExecutableCache();
});

test('Windows resolver safely wraps absolute and explicitly cwd-bound command shims', () => {
  const shim = resolvePlatformProcess('C:\\isolated\\node_modules\\.bin\\singularity-flow.cmd', ['--version'], {
    platform: 'win32', environment: windowsEnvironment
  });
  assert.equal(shim.logicalCommand, 'C:\\isolated\\node_modules\\.bin\\singularity-flow.cmd');
  assert.equal(shim.physicalExecutable, 'C:\\isolated\\node_modules\\.bin\\singularity-flow.cmd');
  assert.equal(shim.executable, windowsEnvironment.ComSpec);
  assert.deepEqual(shim.arguments.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.match(shim.arguments[4], /singularity-flow\.cmd.*--version/);
  assert.deepEqual(shim.spawnOptions, { shell: false, windowsVerbatimArguments: true });

  const local = resolvePlatformProcess('.\\singularity-flow.cmd', ['--version'], {
    platform: 'win32', environment: windowsEnvironment, cwd: 'C:\\workspace',
    lstatSyncCommand(candidate) {
      assert.equal(candidate, 'C:\\workspace\\singularity-flow.cmd');
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    realpathSyncCommand: (candidate) => candidate
  });
  assert.equal(local.physicalExecutable, 'C:\\workspace\\singularity-flow.cmd');
  assert.equal(local.executable, windowsEnvironment.ComSpec);
  assert.match(local.arguments[4], /singularity-flow\.cmd.*--version/);

  assert.throws(() => resolvePlatformProcess('.\\singularity-flow.cmd', ['--version'], {
    platform: 'win32', environment: windowsEnvironment
  }), /require an absolute cwd/);
  assert.throws(() => resolvePlatformProcess('..\\outside.cmd', [], {
    platform: 'win32', environment: windowsEnvironment, cwd: 'C:\\workspace',
    lstatSyncCommand: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    realpathSyncCommand: (candidate) => candidate
  }), /escapes its verified cwd/);
  for (const command of ['D:tool.cmd', 'D:', '.\\', 'sub\\..']) {
    assert.throws(() => resolvePlatformProcess(command, [], {
      platform: 'win32', environment: windowsEnvironment, cwd: 'C:\\workspace',
      lstatSyncCommand: () => ({ isFile: () => true, isSymbolicLink: () => false }),
      realpathSyncCommand: (candidate) => candidate
    }), /Drive-relative|must identify a file/);
  }
  assert.throws(() => resolvePlatformProcess('.\\linked.cmd', [], {
    platform: 'win32', environment: windowsEnvironment, cwd: 'C:\\workspace',
    lstatSyncCommand: () => ({ isFile: () => true, isSymbolicLink: () => true }),
    realpathSyncCommand: (candidate) => candidate
  }), /cannot traverse a symlink or junction/);

  assert.throws(() => resolvePlatformProcess('.\\tools\\mvnw.cmd', [], {
    platform: 'win32', environment: windowsEnvironment, cwd: 'C:\\workspace',
    lstatSyncCommand(candidate) {
      return candidate.endsWith('\\tools')
        ? { isFile: () => false, isSymbolicLink: () => true }
        : { isFile: () => true, isSymbolicLink: () => false };
    },
    realpathSyncCommand: (candidate) => candidate
  }), /cannot traverse a symlink or junction/);
  assert.throws(() => resolvePlatformProcess('.\\tools\\mvnw.cmd', [], {
    platform: 'win32', environment: windowsEnvironment, cwd: 'C:\\workspace',
    lstatSyncCommand: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    realpathSyncCommand(candidate) {
      return candidate.endsWith('mvnw.cmd') ? 'D:\\outside\\mvnw.cmd' : candidate;
    }
  }), /escapes its canonical cwd/);
});

test('Windows system tools require SystemRoot and reject an unrelated ComSpec', () => {
  assert.throws(() => resolveWindowsBatchProcess('C:\\Tools\\tool.cmd', [], {
    environment: { ComSpec: 'C:\\repo\\cmd.exe' }
  }), /SystemRoot or WINDIR/);
  assert.throws(() => resolveWindowsBatchProcess('C:\\Tools\\tool.cmd', [], {
    environment: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\repo\\cmd.exe' }
  }), /ComSpec must identify/);
  assert.throws(() => resolveWindowsBatchProcess('C:\\Tools\\tool.cmd', [], {
    environment: { SystemRoot: '\\Windows' }
  }), /SystemRoot or WINDIR/);
  assert.throws(() => resolvePlatformProcess('\\tool.exe', [], {
    platform: 'win32', environment: windowsEnvironment
  }), /Root-relative/);
});

test('the shared synchronous runner resolves Windows npm without changing logical diagnostics', () => {
  const environment = windowsEnvironment;
  const calls = [];
  const result = run('npm', ['run', 'test suite', 'x&y'], {
    platform: 'win32', env: environment,
    platformLookupCommand: trustedPackageManagerLookup,
    spawnSyncCommand(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: 'passed\n', stderr: '', signal: null };
    }
  });
  assert.equal(result.stdout, 'passed\n');
  assert.equal(calls[0].command, environment.ComSpec);
  assert.deepEqual(calls[0].args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
  assert.match(calls[0].args[4], /npm\.cmd/);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);

  assert.throws(() => run('npm', ['run', 'broken'], {
    platform: 'win32', env: environment,
    platformLookupCommand: trustedPackageManagerLookup,
    spawnSyncCommand: () => ({
      status: 2, stdout: '', stderr: 'fixture refusal', signal: null
    })
  }), /npm run broken failed: fixture refusal/);
});

test('the shared synchronous runner preserves explicit shell execution', () => {
  const calls = [];
  run('npm', ['run', 'fixture'], {
    shell: true,
    platform: 'win32',
    spawnSyncCommand(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: '', stderr: '', signal: null };
    }
  });
  assert.equal(calls[0].command, 'npm');
  assert.deepEqual(calls[0].args, ['run', 'fixture']);
  assert.equal(calls[0].options.shell, true);
  assert.equal(calls[0].options.windowsVerbatimArguments, undefined);
});

if (process.platform === 'win32') {
  test('the real Windows npm and npx shims execute shell-free against an installed local fixture', () => {
    const npm = run('npm', ['--version'], { cwd: repositoryRoot });
    assert.equal(npm.status, 0);
    assert.match(npm.stdout.trim(), /^\d+\.\d+/);

    const npx = run('npx', ['--no-install', 'tsc', '--version'], {
      cwd: repositoryRoot,
      env: { ...process.env, npm_config_offline: 'true' }
    });
    assert.equal(npx.status, 0);
    assert.match(npx.stdout, /Version \d+\.\d+/);
  });
}
