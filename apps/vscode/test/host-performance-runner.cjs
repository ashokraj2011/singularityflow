/*
 * Runs inside a real VS Code extension host through --extensionTestsPath.
 *
 * The parent process owns fixture creation and report retention. This runner emits only bounded,
 * content-free measurements; it never includes the workspace path, command output, file names,
 * identities, or governed state in the report.
 */
const vscode = require('vscode');
const { appendFile, mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');

const EXTENSION_ID = 'singularityflow.singularity-flow-vscode';
const CONTROL_COMMAND = 'singularityFlow.__hostPerformance';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(read, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

const probe = (action = 'snapshot') => vscode.commands.executeCommand(CONTROL_COMMAND, action);

function eventLoopStats(loop) {
  return {
    maxDelayMs: Number(loop.max) / 1e6,
    meanDelayMs: Number.isFinite(Number(loop.mean)) ? Number(loop.mean) / 1e6 : null,
    p95DelayMs: Number(loop.percentile(95)) / 1e6
  };
}

async function quiescent() {
  return until(async () => {
    const current = await probe();
    return current?.counters?.cliProcessesConcurrent === 0
      && current?.counters?.backgroundTasksConcurrent === 0 ? current : null;
  }, 'Singularity Flow CLI processes and background reads to quiesce');
}

async function measuredCommand(command, ...args) {
  await quiescent();
  await probe('reset-interval');
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  await vscode.commands.executeCommand(command, ...args);
  const settled = await quiescent();
  const cpu = process.cpuUsage(cpuBefore);
  loop.disable();
  return {
    durationMs: performance.now() - started,
    cpuUserMs: cpu.user / 1_000,
    cpuSystemMs: cpu.system / 1_000,
    rssBeforeBytes: rssBefore,
    rssAfterBytes: process.memoryUsage().rss,
    counters: settled.counters,
    childMemory: settled.childMemory,
    eventLoop: eventLoopStats(loop)
  };
}

async function run() {
  const reportPath = process.env.SINGULARITY_FLOW_VSCODE_HOST_REPORT;
  const scenario = process.env.SINGULARITY_FLOW_VSCODE_HOST_SCENARIO;
  if (!reportPath || !['cold', 'warm'].includes(scenario)) {
    throw new Error('The SFlow extension-host benchmark requires a bounded report path and cold/warm scenario.');
  }
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) throw new Error(`Development extension '${EXTENSION_ID}' is unavailable.`);

  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  const activeBeforeRequest = extension.isActive;
  const openStarted = performance.now();
  await vscode.commands.executeCommand('workbench.view.extension.singularityFlowNavigator');
  await until(() => extension.isActive, 'the Singularity Flow extension to activate');
  const viewOpenAndActivationMs = performance.now() - openStarted;
  await until(async () => {
    const value = await probe();
    return value?.marksMs?.activationComplete !== undefined ? value : null;
  }, 'the activation performance checkpoint');
  const confirmedActivation = await until(async () => {
    const value = await probe();
    const confirmed = value?.marksMs?.confirmedSnapshotPublished !== undefined
      && value?.marksMs?.confirmedFirstPaint !== undefined;
    return confirmed ? value : null;
  }, 'confirmed first paint');
  if (!confirmedActivation.enabled) throw new Error('The extension-host performance probe was not enabled.');
  const settledActivation = await quiescent();
  const activation = {
    ...confirmedActivation,
    counters: settledActivation.counters,
    childMemory: settledActivation.childMemory
  };
  const activationEventLoop = eventLoopStats(loop);

  const unchangedRefresh = await measuredCommand('singularityFlow.refresh');

  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!root) throw new Error('The extension-host benchmark fixture is not open.');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'host-benchmark-change.txt'), 'changed\n', 'utf8');
  const changedRefresh = await measuredCommand('singularityFlow.refresh');

  await quiescent();
  await probe('reset-interval');
  const stormDirectory = path.join(root, 'singularity', 'host-benchmark');
  const stormPath = path.join(stormDirectory, 'events.txt');
  await mkdir(stormDirectory, { recursive: true });
  const stormLoop = monitorEventLoopDelay({ resolution: 10 });
  stormLoop.enable();
  const stormStarted = performance.now();
  for (let index = 0; index < 100; index += 1) await appendFile(stormPath, `${index}\n`, 'utf8');
  await until(async () => {
    const value = await probe();
    return value?.counters?.cliProcessesStarted > 0
      && value.counters.cliProcessesConcurrent === 0 ? value : null;
  }, 'the governed-file event storm to publish its trailing refresh');
  const storm = await probe();
  stormLoop.disable();
  const watcherStorm = {
    durationMs: performance.now() - stormStarted,
    eventsWritten: 100,
    counters: storm.counters,
    childMemory: storm.childMemory,
    eventLoop: eventLoopStats(stormLoop)
  };

  const webviewOpening = await measuredCommand('singularityFlow.openHelp');
  await quiescent();
  await probe('reset-interval');
  const cacheLoop = monitorEventLoopDelay({ resolution: 10 });
  cacheLoop.enable();
  const cacheStarted = performance.now();
  const cachePersisted = await probe('persist-cache');
  const cacheSettled = await quiescent();
  cacheLoop.disable();
  const cachePersistence = {
    durationMs: performance.now() - cacheStarted,
    counters: cacheSettled.counters,
    childMemory: cacheSettled.childMemory,
    eventLoop: eventLoopStats(cacheLoop)
  };
  loop.disable();
  const finalProbe = await probe();
  const report = {
    schemaVersion: 1,
    kind: 'sflow-vscode-extension-host-sample',
    scenario,
    vscode: { version: vscode.version, appHost: vscode.env.appHost || null },
    extension: { version: extension.packageJSON.version, activeBeforeRequest },
    cachePersisted,
    activation: {
      viewOpenAndActivationMs,
      marksMs: activation.marksMs,
      counters: activation.counters,
      childMemory: activation.childMemory,
      eventLoop: activationEventLoop
    },
    unchangedRefresh,
    changedRefresh,
    watcherStorm,
    webviewOpening,
    cachePersistence,
    eventLoop: {
      maxDelayMs: Number(loop.max) / 1e6,
      meanDelayMs: Number(loop.mean) / 1e6,
      p95DelayMs: Number(loop.percentile(95)) / 1e6
    },
    final: {
      extensionHostRssBytes: finalProbe.runtime.extensionHostRssBytes,
      cliProcessesConcurrent: finalProbe.counters.cliProcessesConcurrent,
      backgroundTasksConcurrent: finalProbe.counters.backgroundTasksConcurrent
    }
  };
  await writeFile(reportPath, `${JSON.stringify(report)}\n`, { encoding: 'utf8', mode: 0o600 });
}

module.exports = { run };
