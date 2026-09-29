#!/usr/bin/env node
import { versionLine } from '../src/build-info.mjs';
import { runConfigurationReviewWorker } from '../src/configuration-review-pass.mjs';

try {
  const result = await runConfigurationReviewWorker({ runningBuild: versionLine() });
  process.exitCode = result.outcome === 'failed' ? 1 : 0;
} catch {
  process.exitCode = 1;
}
