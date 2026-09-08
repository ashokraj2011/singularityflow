#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFosEvidenceInventory, executeFosEvidenceInventory
} from '../src/fos-release-evidence.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = process.argv.includes('--execute');
const outputArgument = process.argv.find((argument) => argument.startsWith('--out='));
const outputPath = outputArgument ? path.resolve(outputArgument.slice('--out='.length)) : null;
if (outputPath && (outputPath === packageRoot || outputPath.startsWith(`${packageRoot}${path.sep}`))) {
  throw new Error('FOS release evidence output must stay outside the repository it describes.');
}
const report = execute
  ? await executeFosEvidenceInventory(packageRoot)
  : await buildFosEvidenceInventory(packageRoot);
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serialized, { mode: 0o600 });
}
process.stdout.write(serialized);
if (execute && report.status !== 'local-evidence-complete') process.exitCode = 1;
