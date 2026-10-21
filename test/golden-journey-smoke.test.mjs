import assert from 'node:assert/strict';
import test from 'node:test';
import { access, rm } from 'node:fs/promises';
import path from 'node:path';
import { runGoldenCommand, runGoldenJourneySmoke } from '../scripts/golden-journey-smoke.mjs';
import { resolvePlatformProcess } from '../src/platform-process.mjs';

test('the isolated VS Code install smoke launches Windows command shims without shell mode', () => {
  let observed;
  let launch;
  const output = runGoldenCommand('code', ['--user-data-dir', 'C:\\QA\\profile with spaces', '--list-extensions'], {
    platform: 'win32', environment: { SystemRoot: 'C:\\Windows', PATH: 'C:\\VSCode\\bin' },
    resolveProcess: (command, args, options) => launch = resolvePlatformProcess(command, args, { ...options,
      spawnSyncCommand: () => ({ status: 0, stdout: 'C:\\VSCode\\bin\\code.cmd\r\n', stderr: '' }),
      lstatSyncCommand: () => ({ isFile: () => true })
    }),
    spawnSync: (executable, args, options) => {
      observed = { executable, args, options };
      return { status: 0, stdout: 'fixture-extension@0.9.0\n', stderr: '' };
    }
  });
  assert.equal(output, 'fixture-extension@0.9.0\n');
  assert.equal(observed.executable, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(launch.logicalArguments, ['--user-data-dir', 'C:\\QA\\profile with spaces', '--list-extensions']);
  assert.match(observed.args.at(-1), /profile\^\^\^ with\^\^\^ spaces/);
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsVerbatimArguments, true);
  assert.equal(observed.options.timeout, 300_000);
});

test('installation smoke retains missing executable, timeout, signal and failure details', () => {
  for (const result of [
    { status: null, error: Object.assign(new Error('missing binary'), { code: 'ENOENT' }) },
    { status: null, error: Object.assign(new Error('deadline exceeded'), { code: 'ETIMEDOUT' }) },
    { status: null, signal: 'SIGTERM' },
    { status: 1, stderr: 'installation refused' }
  ]) {
    assert.throws(() => runGoldenCommand('fixture-code', [], {
      resolveProcess: (command, args) => ({ executable: command, arguments: args, spawnOptions: { shell: false } }),
      spawnSync: () => result
    }), error => {
      assert.equal(error.cause, result.error);
      assert.ok(error.message.includes(result.error?.code ?? result.signal ?? result.stderr));
      assert.equal(error.message.includes('undefined'), false);
      assert.equal(error.quiescenceUnconfirmed, result.error?.code === 'ETIMEDOUT' || Boolean(result.signal));
      return true;
    });
  }
});

test('a timed-out VS Code installation retains its owned profile instead of deleting under an unknown child', async (t) => {
  let retained;
  const failure = Object.assign(new Error('native deadline'), { quiescenceUnconfirmed: true });
  t.after(() => retained && rm(retained, { recursive: true, force: true }));
  await assert.rejects(runGoldenJourneySmoke({ vsix: path.resolve('fixture.vsix'),
    execute() { throw failure; }
  }), error => {
    retained = error.recoveryDirectory;
    assert.equal(error.code, 'GOLDEN_PROCESS_UNCONFIRMED');
    assert.equal(error.cause, failure);
    assert.ok(error.message.includes(retained));
    return true;
  });
  await access(retained);
});

test('the VS Code smoke always owns a private profile and cleans it after success or failure', async () => {
  for (const failInstall of [false, true]) {
    const commands = [];
    const manifest = { publisher: 'fixture', name: 'extension', version: '0.9.0', main: './dist/extension.cjs',
      contributes: { commands: ['myWork', 'startWork', 'returnToWork'].map(name => ({ command: `singularityFlow.${name}` })) } };
    const failure = new Error('fixture install failed');
    const run = () => runGoldenJourneySmoke({ vsix: path.resolve('fixture.vsix'), code: 'fixture-code',
      execute: (command, args) => {
        commands.push({ command, args });
        if (command === 'unzip') return args[0] === '-p' ? JSON.stringify(manifest)
          : 'extension/cli/bin/singularity-flow.mjs\r\n';
        if (command === 'fixture-code') {
          if (failInstall) throw failure;
          return args.includes('--list-extensions') ? 'fixture.extension@0.9.0\r\n' : '';
        }
        assert.equal(command, process.execPath, 'only the known fixture host may run after installation');
        return '';
      }
    });
    if (failInstall) await assert.rejects(run, error => error === failure);
    else assert.equal(await run(), 'fixture.extension@0.9.0');
    const codeCalls = commands.filter(call => call.command === 'fixture-code');
    assert.equal(codeCalls.length, failInstall ? 1 : 2);
    const profile = path.dirname(codeCalls[0].args[codeCalls[0].args.indexOf('--user-data-dir') + 1]);
    for (const call of codeCalls) {
      assert.equal(call.args[call.args.indexOf('--user-data-dir') + 1], path.join(profile, 'user-data'));
      assert.equal(call.args[call.args.indexOf('--extensions-dir') + 1], path.join(profile, 'extensions'));
    }
    await assert.rejects(access(profile), { code: 'ENOENT' });
  }
});
