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
// Distinct user actions never arrive in one microtask chain. One 10 ms editor turn also lets the
// 5/10 ms event-loop observers publish their preceding deadline before the next phase is labelled.
const nextHostTurn = () => delay(10);

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

/** Sample this extension-host process without retaining heap profiles, paths, or object contents. */
function hostMemoryTracker(resolutionMs = 5) {
  const beforeBytes = process.memoryUsage().rss;
  let peakBytes = beforeBytes;
  const sample = () => { peakBytes = Math.max(peakBytes, process.memoryUsage().rss); };
  const timer = setInterval(sample, resolutionMs);
  timer.unref?.();
  return {
    finish() {
      sample();
      clearInterval(timer);
      const afterBytes = process.memoryUsage().rss;
      return {
        status: 'measured-process-rss',
        beforeBytes,
        afterBytes,
        peakBytes: Math.max(peakBytes, afterBytes),
        maximumIncreaseBytes: Math.max(0, Math.max(peakBytes, afterBytes) - beforeBytes)
      };
    }
  };
}

async function quiescent() {
  return until(async () => {
    const current = await probe();
    return current?.counters?.cliProcessesConcurrent === 0
      && current?.counters?.backgroundTasksConcurrent === 0 ? current : null;
  }, 'Singularity Flow CLI processes and background reads to quiesce');
}

async function measuredCommand(command, {
  prepare = null, args = [], transitions = null, nextTransition = null
} = {}) {
  const hostMemory = hostMemoryTracker();
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
  transitions?.enterStage();
  await quiescent();
  await probe('reset-interval');
  if (prepare) await prepare();
  const cpuBefore = process.cpuUsage();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  await vscode.commands.executeCommand(command, ...args);
  const settled = await quiescent();
  const cpu = process.cpuUsage(cpuBefore);
  if (nextTransition) transitions?.leaveStage(nextTransition);
  loop.disable();
  return {
    durationMs: performance.now() - started,
    cpuUserMs: cpu.user / 1_000,
    cpuSystemMs: cpu.system / 1_000,
    rssBeforeBytes: rssBefore,
    rssAfterBytes: process.memoryUsage().rss,
    hostMemory: hostMemory.finish(),
    runtimeLoadsMs: settled.runtimeLoadsMs,
    counters: settled.counters,
    childMemory: settled.childMemory,
    eventLoop: eventLoopStats(loop)
  };
}

function transitionTracker() {
  const recorded = {};
  let active = null;
  let name = null;
  return {
    start(nextName) {
      name = nextName;
      active = monitorEventLoopDelay({ resolution: 10 });
      active.enable();
    },
    enterStage() {
      if (!active || !name) return;
      active.disable();
      recorded[name] = eventLoopStats(active);
      active = null;
      name = null;
    },
    leaveStage(nextName) {
      this.start(nextName);
    },
    finish() {
      this.enterStage();
      return recorded;
    }
  };
}

/** A single timer keeps its deadline across phase changes, so a stall cannot disappear on reset. */
function eventLoopAttributionTracker(resolutionMs = 5) {
  const phases = {};
  let phase = 'activation-to-unchanged';
  let previous = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const delayMs = Math.max(0, now - previous - resolutionMs);
    const current = phases[phase] ?? { samples: 0, maximumDelayMs: 0 };
    current.samples += 1;
    current.maximumDelayMs = Math.max(current.maximumDelayMs, delayMs);
    phases[phase] = current;
    previous = now;
  }, resolutionMs);
  timer.unref?.();
  return {
    phase(next) { phase = next; },
    async finish() {
      await nextHostTurn();
      clearInterval(timer);
      return phases;
    }
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
  const activationMemory = hostMemoryTracker();
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
    childMemory: settledActivation.childMemory,
    hostMemory: activationMemory.finish()
  };
  const activationEventLoop = eventLoopStats(loop);
  // One continuous steady-state monitor covers command preflights and the small transitions
  // between the narrower per-surface probes. Without it an event-loop spike could appear in the
  // host-wide total while every attributed surface misleadingly remained green.
  const steadyLoop = monitorEventLoopDelay({ resolution: 10 });
  steadyLoop.enable();
  const transitions = transitionTracker();
  transitions.start('activation-to-unchanged');
  const eventLoopAttribution = eventLoopAttributionTracker();

  eventLoopAttribution.phase('unchanged-refresh');
  const unchangedRefresh = await measuredCommand('singularityFlow.refresh', {
    transitions, nextTransition: 'unchanged-to-changed'
  });
  eventLoopAttribution.phase('unchanged-to-changed');
  await nextHostTurn();

  const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!root) throw new Error('The extension-host benchmark fixture is not open.');
  eventLoopAttribution.phase('changed-refresh');
  const changedRefresh = await measuredCommand('singularityFlow.refresh', {
    transitions, nextTransition: 'changed-to-storm', prepare: async () => {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'host-benchmark-change.txt'), 'changed\n', 'utf8');
  } });
  eventLoopAttribution.phase('changed-to-storm');
  await nextHostTurn();

  eventLoopAttribution.phase('watcher-storm');
  const stormMemory = hostMemoryTracker();
  const stormLoop = monitorEventLoopDelay({ resolution: 10 });
  stormLoop.enable();
  transitions.enterStage();
  await quiescent();
  await probe('reset-interval');
  const stormDirectory = path.join(root, 'singularity', 'host-benchmark');
  const stormPath = path.join(stormDirectory, 'events.txt');
  await mkdir(stormDirectory, { recursive: true });
  const stormStarted = performance.now();
  for (let index = 0; index < 100; index += 1) await appendFile(stormPath, `${index}\n`, 'utf8');
  await until(async () => {
    const value = await probe();
    return value?.counters?.cliProcessesStarted > 0
      && value.counters.cliProcessesConcurrent === 0 ? value : null;
  }, 'the governed-file event storm to publish its trailing refresh');
  const storm = await probe();
  transitions.leaveStage('storm-to-help');
  stormLoop.disable();
  const watcherStorm = {
    durationMs: performance.now() - stormStarted,
    eventsWritten: 100,
    counters: storm.counters,
    childMemory: storm.childMemory,
    hostMemory: stormMemory.finish(),
    eventLoop: eventLoopStats(stormLoop)
  };
  eventLoopAttribution.phase('storm-to-help');
  await nextHostTurn();

  eventLoopAttribution.phase('help-opening');
  const webviewOpening = await measuredCommand('singularityFlow.openHelp', {
    transitions, nextTransition: 'help-to-cache'
  });
  eventLoopAttribution.phase('help-to-cache');
  await nextHostTurn();
  eventLoopAttribution.phase('cache-persistence');
  const cacheMemory = hostMemoryTracker();
  const cacheLoop = monitorEventLoopDelay({ resolution: 10 });
  cacheLoop.enable();
  transitions.enterStage();
  await quiescent();
  await probe('reset-interval');
  const cacheStarted = performance.now();
  const cachePersisted = await probe('persist-cache');
  const cacheSettled = await quiescent();
  transitions.leaveStage('cache-to-finish');
  cacheLoop.disable();
  const cachePersistence = {
    durationMs: performance.now() - cacheStarted,
    counters: cacheSettled.counters,
    childMemory: cacheSettled.childMemory,
    hostMemory: cacheMemory.finish(),
    eventLoop: eventLoopStats(cacheLoop)
  };
  eventLoopAttribution.phase('cache-to-finish');
  await nextHostTurn();
  const transitionEventLoop = transitions.finish();
  const attributedEventLoop = await eventLoopAttribution.finish();
  steadyLoop.disable();
  loop.disable();
  const finalProbe = await probe();
  const report = {
    schemaVersion: 2,
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
      hostMemory: activation.hostMemory,
      eventLoop: activationEventLoop
    },
    unchangedRefresh,
    changedRefresh,
    watcherStorm,
    webviewOpening,
    cachePersistence,
    steadyStateEventLoop: eventLoopStats(steadyLoop),
    transitionEventLoop,
    attributedEventLoop,
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
