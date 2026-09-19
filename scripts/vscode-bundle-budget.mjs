#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildVsCodeBundleBudgetReport } from '../src/vscode-bundle-budget.mjs';

const runFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'apps', 'vscode');
const dist = path.join(extension, 'dist');
const json = process.argv.includes('--json');
const noBuild = process.argv.includes('--no-build');
const output = process.argv.find((value) => value.startsWith('--out='))?.slice('--out='.length);

let temporaryBuildRoot = null;
let measuredDist = dist;
try {
  if (!noBuild) {
    temporaryBuildRoot = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-bundle-budget-'));
    measuredDist = path.join(temporaryBuildRoot, 'dist');
    await runFile(process.execPath, ['esbuild.mjs'], {
      cwd: extension,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SINGULARITY_FLOW_VSCODE_TEST_OUTDIR: measuredDist
      }
    });
  }

  const policy = JSON.parse(await readFile(
    path.join(root, 'benchmarks', 'dx', 'vscode-bundle-budgets.json'), 'utf8'
  ));
  const names = (await readdir(measuredDist)).filter((name) => name.endsWith('.cjs')).sort();
  const measured = {};
  for (const name of names) {
    const [bundleStat, sourceMap] = await Promise.all([
      stat(path.join(measuredDist, name)),
      readFile(path.join(measuredDist, `${name}.map`), 'utf8').then(JSON.parse)
    ]);
    measured[name] = {
      bytes: bundleStat.size,
      modules: new Set(sourceMap.sources).size
    };
  }
  const report = buildVsCodeBundleBudgetReport(measured, policy);
  const serialized = `${JSON.stringify(report, null, json ? 0 : 2)}\n`;
  if (output) await writeFile(path.resolve(output), serialized, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(serialized);
  if (report.status !== 'passed') process.exitCode = 1;
} finally {
  if (temporaryBuildRoot) {
    await rm(temporaryBuildRoot, { recursive: true, force: true });
  }
}
