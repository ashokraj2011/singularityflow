import { performance } from 'node:perf_hooks';

function rounded(value) {
  return Math.round(value * 100) / 100;
}

/** Small, dependency-free timing collector for CLI and snapshot diagnostics. */
export class TimingCollector {
  constructor({ enabled = false, clock = () => performance.now() } = {}) {
    this.enabled = enabled;
    this.clock = clock;
    this.startedAt = clock();
    this.stages = {};
  }

  async measure(name, operation) {
    if (!this.enabled) return operation();
    const started = this.clock();
    try {
      return await operation();
    } finally {
      this.stages[name] = rounded(this.clock() - started);
    }
  }

  finish() {
    if (!this.enabled) return undefined;
    return {
      unit: 'milliseconds',
      total: rounded(this.clock() - this.startedAt),
      stages: { ...this.stages }
    };
  }
}

export function writeHumanTimings(timings, stream = process.stderr) {
  if (!timings) return;
  const stages = Object.entries(timings.stages).map(([name, value]) => `${name}=${value}ms`).join(' ');
  stream.write(`Timing: total=${timings.total}ms${stages ? ` ${stages}` : ''}\n`);
}
