#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlatformProcess } from '../src/platform-process.mjs';
import { signalProcessTree } from '../src/util.mjs';

const moduleFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(moduleFile), '..');
const npm = 'npm';

export const POC_RELEASE_TERMINATION_GRACE_MS = 5_000;

function nodeTestFlags(rootDir = root, version = process.versions.node) {
  const [nodeMajor, nodeMinor] = String(version).split('.').map(Number);
  if (nodeMajor < 20) {
    throw new Error(`POC release gate requires Node.js 20 or newer; found v${version}.`);
  }
  return nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)
    ? ['--experimental-strip-types', '--no-warnings=ExperimentalWarning']
    : ['--experimental-loader', path.join(rootDir, 'scripts', 'typescript-test-loader.mjs')];
}

/**
 * The complete, bounded POC release contract.
 *
 * Every direct `node --test` stage carries the same strict reporter. Keeping this as data makes it
 * possible for the gate's own tests to inspect the contract without recursively running the gate.
 */
export function pocReleaseStages({ rootDir = root, nodeVersion = process.versions.node } = {}) {
  const typescriptTestFlags = nodeTestFlags(rootDir, nodeVersion);
  const releaseReporterFlags = [
    '--test-reporter', path.join(rootDir, 'scripts', 'release-test-reporter.mjs')
  ];
  return Object.freeze([
    Object.freeze({
      label: 'Developer-experience latency budgets',
      command: npm,
      args: ['run', 'benchmark:dx:enforce'],
      timeoutMs: 5 * 60_000
    }),
    Object.freeze({
      label: 'VS Code type contract',
      command: npm,
      args: ['run', 'vscode:typecheck'],
      timeoutMs: 5 * 60_000
    }),
    Object.freeze({
      label: 'Packaged VS Code extension',
      command: npm,
      args: ['run', 'vscode:package'],
      timeoutMs: 15 * 60_000
    }),
    Object.freeze({
      label: 'POC workflows, installers, Windows launch policy, MCP readiness, guided SGOS, CMP, and WEL',
      command: process.execPath,
      args: Object.freeze([
        ...typescriptTestFlags, ...releaseReporterFlags, '--test',
        'test/poc-workflow.test.mjs', 'test/poc-lite-workflow.test.mjs',
        'test/poc-hardening.test.mjs', 'test/mcp.test.mjs', 'test/mcp-auth-profile.test.mjs',
        'test/platform-process.test.mjs', 'test/quality-command-runner.test.mjs',
        'test/install-staged-artifacts.test.mjs', 'test/local-install-script.test.mjs',
        'test/vscode-sgos-workflow-create.test.mjs', 'test/comprehension-contracts.test.mjs',
        'test/comprehension-command.test.mjs', 'test/wel-junit5.test.mjs',
        // These files inspect the reporter and this stage manifest. Importing the gate is inert,
        // so including them proves the release authorities without recursively invoking this gate.
        'test/release-test-reporter.test.mjs', 'test/poc-release-gate.test.mjs'
      ]),
      timeoutMs: 30 * 60_000
    }),
    Object.freeze({
      label: 'Built extension bundle POC journey (isolated stub host)',
      command: process.execPath,
      args: Object.freeze([
        ...releaseReporterFlags,
        '--test',
        '--test-name-pattern=the packaged POC release candidate journey',
        'test/vscode-host.test.mjs'
      ]),
      timeoutMs: 15 * 60_000
    }),
    Object.freeze({
      label: 'Exact VSIX-contained CLI engine (isolated process; no VS Code host activation)',
      command: process.execPath,
      args: ['scripts/packaged-vsix-engine-smoke.mjs'],
      timeoutMs: 5 * 60_000
    }),
    Object.freeze({
      label: 'Isolated packaged CLI installation',
      command: process.execPath,
      args: ['scripts/packaged-cli-smoke.mjs'],
      timeoutMs: 15 * 60_000
    }),
    Object.freeze({
      label: 'WEL content-free observe-only benchmark',
      command: npm,
      args: ['run', 'benchmark:wel'],
      timeoutMs: 5 * 60_000
    }),
    Object.freeze({
      label: 'npm package inventory',
      command: npm,
      args: ['pack', '--dry-run'],
      timeoutMs: 5 * 60_000
    })
  ]);
}

function boundedDeadline(value, label, { minimum = 1, maximum = 60 * 60_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum} milliseconds.`);
  }
  return parsed;
}

/** Run one release stage with a hard operation deadline and bounded process-tree cleanup. */
export function runPocReleaseStage(stage, {
  cwd = root,
  environment = process.env,
  platform = process.platform,
  spawnCommand = spawn,
  terminateTree = signalProcessTree,
  treeSpawnCommand = spawn,
  killProcess = process.kill,
  resolveProcess = resolvePlatformProcess,
  terminationGraceMs = POC_RELEASE_TERMINATION_GRACE_MS
} = {}) {
  const timeoutMs = boundedDeadline(stage?.timeoutMs, 'POC release stage deadline');
  const graceMs = boundedDeadline(
    terminationGraceMs, 'POC release termination grace', { maximum: 5_000 }
  );
  return new Promise((resolve) => {
    let child;
    try {
      const launch = resolveProcess(stage.command, stage.args, { platform, environment });
      child = spawnCommand(launch.executable, launch.arguments, {
        cwd,
        env: environment,
        stdio: 'inherit',
        detached: platform !== 'win32',
        windowsHide: true,
        ...launch.spawnOptions
      });
    } catch (error) {
      resolve({ status: 1, signal: null, error, timedOut: false });
      return;
    }

    let settled = false;
    let timedOut = false;
    let spawnError = null;
    let terminationReason = null;
    let deadlineTimer = null;
    let forceTimer = null;
    let settlementTimer = null;
    const cleanupAttempts = new Set();

    const cleanup = () => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settlementTimer) clearTimeout(settlementTimer);
      child.removeListener?.('error', onError);
      child.removeListener?.('close', onClose);
    };
    const settle = (status, signal = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        status: timedOut ? 1 : (status ?? 1),
        signal,
        error: spawnError,
        timedOut
      });
    };
    const signalTree = (terminationSignal) => {
      let finish;
      const attempt = new Promise((done) => { finish = done; });
      cleanupAttempts.add(attempt);
      attempt.finally(() => cleanupAttempts.delete(attempt));
      try {
        Promise.resolve(terminateTree(child, terminationSignal, {
          platform,
          spawnCommand: treeSpawnCommand,
          killProcess,
          timeoutMs: Math.max(1, Math.ceil(graceMs / 2))
        })).then(finish, () => finish(false));
      } catch {
        finish(false);
      }
      return attempt;
    };
    const settleAfterCleanup = (status, signal) => {
      Promise.allSettled([...cleanupAttempts]).then(() => settle(status, signal));
    };
    const terminate = (reason) => {
      if (settled || terminationReason) return;
      terminationReason = reason;
      timedOut = reason === 'timeout';
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineTimer = null;
      signalTree('SIGTERM');
      forceTimer = setTimeout(() => {
        signalTree('SIGKILL');
      }, Math.max(1, Math.floor(graceMs / 2)));
      // This outer deadline does not depend on a child `close` event or an injected cleanup
      // implementation. A damaged process wrapper therefore cannot retain the release gate.
      settlementTimer = setTimeout(() => settle(1, 'SIGKILL'), graceMs);
    };
    const onError = (error) => {
      spawnError = error;
      if (!child.pid) settle(1, null);
      else terminate('spawn-error');
    };
    const onClose = (status, signal) => {
      if (!terminationReason) {
        settle(status, signal);
        return;
      }
      // A wrapper can exit while a descendant still owns inherited resources. Complete the forced
      // tree cleanup before reporting quiescence after a deadline.
      signalTree('SIGKILL');
      settleAfterCleanup(1, signal ?? 'SIGKILL');
    };

    child.on?.('error', onError);
    child.on?.('close', onClose);
    deadlineTimer = setTimeout(() => terminate('timeout'), timeoutMs);
  });
}

function isolatedEnvironment(machineState, source = process.env) {
  const environment = {
    ...source,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machineState, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machineState, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machineState, 'leads.json'),
    SINGULARITY_FLOW_RELEASE_FAIL_ON_SKIPPED_TEST_FILES: '1'
  };
  delete environment.FORCE_COLOR;
  delete environment.SINGULARITY_FLOW_COLOR;
  return environment;
}

export async function runPocReleaseGate({ rootDir = root, runStage = runPocReleaseStage } = {}) {
  const machineState = mkdtempSync(path.join(os.tmpdir(), 'sflow-poc-release-gate-'));
  const environment = isolatedEnvironment(machineState);
  const stages = pocReleaseStages({ rootDir });
  try {
    for (const [index, stage] of stages.entries()) {
      process.stdout.write(`\n[POC ${index + 1}/${stages.length}] ${stage.label}\n`);
      const started = Date.now();
      const result = await runStage(stage, { cwd: rootDir, environment });
      if (result.error || result.status !== 0) {
        const detail = result.timedOut
          ? `exceeded its ${stage.timeoutMs}ms deadline`
          : (result.error?.message ?? `exit ${result.status ?? 'unknown'}`);
        throw Object.assign(new Error(`POC release gate failed at "${stage.label}" (${detail}).`), {
          exitCode: result.status || 1
        });
      }
      process.stdout.write(`[POC] passed in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    }
  } finally {
    rmSync(machineState, { recursive: true, force: true });
  }
  console.log([
    '',
    'POC release gate passed. The built extension bundle completed the governed POC lifecycle',
    'under an isolated stub host. The exact CLI engine extracted from the generated VSIX also ran',
    'from an isolated directory without source-tree module access. This does not prove real VS Code',
    'host activation. Real-host and supported-platform receipts remain separate release evidence.'
  ].join(' '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === moduleFile) {
  runPocReleaseGate().catch((error) => {
    console.error(`\n${error.message}`);
    process.exitCode = error.exitCode || 1;
  });
}
