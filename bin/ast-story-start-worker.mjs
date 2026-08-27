#!/usr/bin/env node
import { repoRoot } from '../src/git.mjs';
import { runStoryStartAstWarmWorker } from '../src/ast-story-start-warm.mjs';

const workId = String(process.argv[2] ?? '').trim();
if (!workId) process.exitCode = 2;
else try {
  const result = await runStoryStartAstWarmWorker(repoRoot(), workId);
  process.exitCode = result.status === 'failed' ? 1 : 0;
} catch {
  process.exitCode = 1;
}
