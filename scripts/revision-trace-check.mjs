#!/usr/bin/env node
/** The release preflight checks actual REV capabilities against the checked-in trace claim. */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRevisionPilotOptIn } from '../src/revision/runtime.mjs';
import { validateRevisionTraceManifest } from '../src/revision/trace-manifest.mjs';
import { runPocReleaseStage } from './poc-release-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTIVE_WITNESS_TIMEOUT_MS = 30 * 60_000;
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'revision-trace-manifest.json'), 'utf8'));
  const optIn = await readRevisionPilotOptIn(root);
  if (optIn && manifest.activationProfile !== optIn.activationProfile) {
    throw new Error('repository REV pilot opt-in disagrees with the checked-in release profile');
  }
  if (!optIn && manifest.activationProfile !== 'disabled') {
    throw new Error('active REV release profile requires explicit repository REV_POC_SINGLE_REPO opt-in');
  }
  let witnessContext = null;
  if (optIn) {
    const sourceCommit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root, encoding: 'utf8'
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root, encoding: 'utf8'
    });
    if (dirty.trim()) {
      throw new Error('active REV witness source must be a clean, exact source commit');
    }
    witnessContext = {
      sourceCommit,
      platformProfile: `${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`
    };
  }
  const report = await validateRevisionTraceManifest(manifest, {
    repositoryRoot: root, witnessContext
  });
  if (optIn) {
    const files = [...new Set(Object.values(manifest.enabledCriteria).map((row) => row.test))].sort();
    const result = await runPocReleaseStage({
      label: 'active REV exact witness suite',
      command: process.execPath,
      args: [
        '--test-reporter', path.join(root, 'scripts', 'release-test-reporter.mjs'),
        '--test', ...files
      ],
      timeoutMs: ACTIVE_WITNESS_TIMEOUT_MS
    }, { cwd: root });
    if (result.timedOut) {
      throw new Error(`active REV witness execution exceeded ${ACTIVE_WITNESS_TIMEOUT_MS / 60_000} minutes`);
    }
    if (result.error || result.status !== 0) {
      throw new Error(`active REV witness execution failed${result.error ? `: ${result.error.message}` : ''}`);
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`REV release trace failed: ${error.message}\n`);
  process.exitCode = 1;
}
