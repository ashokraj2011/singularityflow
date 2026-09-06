function percentile(sorted, value) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)];
}

export function summarizeHostMetric(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  return Object.freeze({
    samples: finite.length,
    minimum: finite[0] ?? null,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    maximum: finite.at(-1) ?? null
  });
}

function metricValues(pairs) {
  const all = pairs.flatMap(({ cold, warm }) => [cold, warm]);
  const steadyEventLoop = (sample) => Math.max(...[
    sample.unchangedRefresh?.eventLoop?.maxDelayMs,
    sample.changedRefresh?.eventLoop?.maxDelayMs,
    sample.watcherStorm?.eventLoop?.maxDelayMs,
    sample.webviewOpening?.eventLoop?.maxDelayMs,
    sample.cachePersistence?.eventLoop?.maxDelayMs
  ].filter(Number.isFinite));
  const childPeaks = all.flatMap((sample) => [
    sample.activation.childMemory?.peakRssBytes,
    sample.unchangedRefresh.childMemory?.peakRssBytes,
    sample.changedRefresh.childMemory?.peakRssBytes,
    sample.watcherStorm.childMemory?.peakRssBytes,
    sample.webviewOpening.childMemory?.peakRssBytes,
    sample.cachePersistence?.childMemory?.peakRssBytes
  ]).filter(Number.isFinite);
  return {
    coldActivationCompleteMs: pairs.map(({ cold }) => cold.activation.marksMs.activationComplete),
    activationCompleteMs: all.map((sample) => sample.activation.marksMs.activationComplete),
    cachedFirstPaintMs: pairs.map(({ warm }) => warm.activation.marksMs.cachedFirstPaint),
    confirmedFirstPaintMs: all.map((sample) => sample.activation.marksMs.confirmedFirstPaint),
    unchangedRefreshMs: all.map((sample) => sample.unchangedRefresh.durationMs),
    changedRefreshMs: all.map((sample) => sample.changedRefresh.durationMs),
    webviewOpeningMs: all.map((sample) => sample.webviewOpening.durationMs),
    cachePersistenceMs: all.map((sample) => sample.cachePersistence?.durationMs),
    eventLoopMaxDelayMs: all.map((sample) => sample.eventLoop.maxDelayMs),
    activationEventLoopMaxDelayMs: all.map((sample) => sample.activation.eventLoop?.maxDelayMs),
    steadyStateEventLoopMaxDelayMs: all.map(steadyEventLoop),
    extensionHostRssBytes: all.map((sample) => sample.final.extensionHostRssBytes),
    peakChildRssBytes: childPeaks,
    watcherStormCliProcesses: all.map((sample) => sample.watcherStorm.counters.cliProcessesStarted),
    watcherStormSidebarRenders: all.map((sample) => sample.watcherStorm.counters.sidebarRenders)
  };
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value));
  return match ? match.slice(1).map(Number) : null;
}

function compatibleVersion(profile, value) {
  const parsed = parseVersion(value);
  if (!parsed) return false;
  if (profile === 'minimum') return parsed[0] === 1 && parsed[1] === 90;
  return parsed[0] > 1 || (parsed[0] === 1 && parsed[1] >= 90);
}

/** Build one content-free report from cold/warm real extension-host samples. */
export function buildHostPerformanceReport({ profile, pairs, budgets, enforce = false }) {
  if (!['minimum', 'current'].includes(profile)) throw new TypeError('Profile must be minimum or current.');
  if (!Array.isArray(pairs) || !pairs.length) throw new TypeError('At least one cold/warm sample pair is required.');
  const versions = [...new Set(pairs.flatMap(({ cold, warm }) => [cold.vscode.version, warm.vscode.version]))];
  const failures = [];
  if (versions.length !== 1 || !compatibleVersion(profile, versions[0])) {
    failures.push(`vscode-version:${versions.join(',') || 'missing'}`);
  }
  for (const [index, pair] of pairs.entries()) {
    for (const [scenario, sample] of Object.entries(pair)) {
      if (sample.scenario !== scenario) failures.push(`pair-${index + 1}:${scenario}-scenario-mismatch`);
      if (sample.extension.activeBeforeRequest) failures.push(`pair-${index + 1}:${scenario}-activated-before-view-request`);
      if (sample.final.cliProcessesConcurrent !== 0) failures.push(`pair-${index + 1}:${scenario}-child-not-quiescent`);
      if (sample.final.backgroundTasksConcurrent !== 0) failures.push(`pair-${index + 1}:${scenario}-background-not-quiescent`);
      for (const [surface, measurement] of Object.entries({
        activation: sample.activation,
        unchangedRefresh: sample.unchangedRefresh,
        changedRefresh: sample.changedRefresh,
        watcherStorm: sample.watcherStorm,
        webviewOpening: sample.webviewOpening,
        cachePersistence: sample.cachePersistence
      })) {
        if (!Number.isSafeInteger(measurement?.counters?.cliProcessesFailed)) {
          failures.push(`pair-${index + 1}:${scenario}-${surface}-cli-outcome-missing`);
        } else if (measurement.counters.cliProcessesFailed !== 0) {
          failures.push(`pair-${index + 1}:${scenario}-${surface}-cli-failed`);
        }
      }
      if (sample.cachePersisted !== true) failures.push(`pair-${index + 1}:${scenario}-cache-not-persisted`);
      if (!Number.isFinite(sample.activation.marksMs.confirmedFirstPaint)) {
        failures.push(`pair-${index + 1}:${scenario}-confirmed-paint-missing`);
      }
    }
    if (!Number.isFinite(pair.warm.activation.marksMs.cachedFirstPaint)) {
      failures.push(`pair-${index + 1}:warm-cache-paint-missing`);
    }
  }
  const values = metricValues(pairs);
  const metrics = Object.fromEntries(Object.entries(values).map(([id, samples]) => [id, summarizeHostMetric(samples)]));
  const configured = budgets?.[profile];
  if (!configured) failures.push(`budget-profile:${profile}-missing`);
  if (enforce && pairs.length < (configured?.samples ?? 30)) {
    failures.push(`samples:${pairs.length}<${configured?.samples ?? 30}`);
  }
  if (enforce && configured?.budgets) {
    for (const [id, limit] of Object.entries(configured.budgets)) {
      const measured = metrics[id];
      if (!measured || measured.samples === 0) {
        failures.push(`${id}:unavailable`);
        continue;
      }
      if (limit.p95 !== undefined && measured.p95 > limit.p95) failures.push(`${id}:p95>${limit.p95}`);
      if (limit.maximum !== undefined && measured.maximum > limit.maximum) failures.push(`${id}:maximum>${limit.maximum}`);
    }
  }
  const status = failures.length ? (enforce ? 'failed' : 'incomplete') : enforce ? 'passed' : 'measured';
  return Object.freeze({
    schemaVersion: 1,
    kind: 'sflow-vscode-extension-host-performance-report',
    status,
    profile,
    vscodeVersion: versions.length === 1 ? versions[0] : null,
    samplePairs: pairs.length,
    protocol: Object.freeze({
      host: 'real-vscode-extension-host',
      activation: 'onView',
      network: 'disabled',
      modelCalls: 'disabled',
      questionsOrContentCaptured: false,
      coldAndWarmProcessPerPair: true
    }),
    metrics: Object.freeze(metrics),
    budgets: configured?.budgets ?? null,
    failures: Object.freeze([...new Set(failures)])
  });
}
