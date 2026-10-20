#!/usr/bin/env node
/**
 * Offline install-to-Home smoke.
 *
 * It verifies the actual VSIX payload, installs it into an isolated VS Code profile, proves that the
 * installed extension/version is discoverable, then drives the built extension through the real
 * fixture-Home host test. It never contacts Marketplace or a public Git host.
 *
 *   node scripts/golden-journey-smoke.mjs --vsix /absolute/path/to/file.vsix [--code code]
 */
import { spawnSync as nativeSpawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlatformProcess } from '../src/platform-process.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? null : args[index + 1] ?? null;
};
const vsix = value('--vsix');
const code = value('--code') ?? process.env.SINGULARITY_FLOW_CODE ?? 'code';
export function runGoldenCommand(command, commandArgs, {
  cwd = root, environment = process.env, platform = process.platform,
  spawnSync = nativeSpawnSync, resolveProcess = resolvePlatformProcess
} = {}) {
  const launch = resolveProcess(command, commandArgs, { platform, environment });
  const result = spawnSync(launch.executable, launch.arguments, {
    cwd, env: environment, encoding: 'utf8', windowsHide: true,
    timeout: 300_000, maxBuffer: 20 * 1024 * 1024, ...launch.spawnOptions
  });
  if (result.error || result.status !== 0 || result.signal) {
    const detail = result.stderr || result.stdout
      || [result.error?.code, result.error?.message, result.signal].filter(Boolean).join(': ') || 'unknown failure';
    throw Object.assign(new Error(`${command} failed (${result.status ?? 'no exit status'}):\n${detail}`, { cause: result.error }), {
      quiescenceUnconfirmed: result.error?.code === 'ETIMEDOUT' || Boolean(result.signal)
    });
  }
  return result.stdout ?? '';
}

export async function runGoldenJourneySmoke({ vsix, code = 'code', execute = runGoldenCommand } = {}) {
  if (!vsix) throw new Error('Pass --vsix /absolute/path/to/singularity-flow-vscode-<version>.vsix.');
  const must = execute;
  const profile = await mkdtemp(path.join(os.tmpdir(), 'sflow-golden-vscode-'));
  let expected;
  let cleanupSafe = true;
  try {
    const manifestText = must('unzip', ['-p', path.resolve(vsix), 'extension/package.json']);
    const manifest = JSON.parse(manifestText);
    const commands = new Set((manifest.contributes?.commands ?? []).map((entry) => entry.command));
    for (const required of ['singularityFlow.myWork', 'singularityFlow.startWork', 'singularityFlow.returnToWork']) {
      if (!commands.has(required)) throw new Error(`Packaged extension does not contribute ${required}.`);
    }
    if (manifest.main !== './dist/extension.cjs') throw new Error('VSIX does not point at the built extension bundle.');
    const cliEntry = must('unzip', ['-Z1', path.resolve(vsix)]);
    if (!cliEntry.split(/\r?\n/).includes('extension/cli/bin/singularity-flow.mjs')) {
      throw new Error('VSIX does not contain the bundled CLI.');
    }

    const userData = path.join(profile, 'user-data');
    const extensions = path.join(profile, 'extensions');
    must(code, ['--user-data-dir', userData, '--extensions-dir', extensions,
      '--install-extension', path.resolve(vsix), '--force']);
    const installed = must(code, ['--user-data-dir', userData, '--extensions-dir', extensions,
      '--list-extensions', '--show-versions']);
    expected = `${manifest.publisher}.${manifest.name}@${manifest.version}`.toLowerCase();
    if (!installed.toLowerCase().split(/\r?\n/).includes(expected)) {
      throw new Error(`Isolated profile did not report ${expected}.`);
    }

    // The host fixture opens a fresh repository and asserts My Work renders through the built CJS
    // bundle. Keeping this in the same command makes a green smoke mean both packaging and Home.
    must(process.execPath, ['--test', '--test-name-pattern',
      'the built extension activates against a real repository and populates the tree',
      'test/vscode-host.test.mjs']);
  } catch (error) {
    if (!error.quiescenceUnconfirmed) throw error;
    cleanupSafe = false;
    throw Object.assign(new Error(`${error.message}\nIsolated profile retained; child cleanup is unconfirmed: ${profile}`, { cause: error }), {
      code: 'GOLDEN_PROCESS_UNCONFIRMED', recoveryDirectory: profile
    });
  } finally {
    if (cleanupSafe) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const expected = await runGoldenJourneySmoke({ vsix, code });
  console.log(`Golden Journey smoke passed for ${expected}.`);
}
