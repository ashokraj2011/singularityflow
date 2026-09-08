#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerFosBenchmarkEvidence } from '../src/fos-benchmark-evidence.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv.find((argument) => argument.startsWith('--in='))?.slice('--in='.length);
if (!input) throw new Error('Usage: npm run benchmark:fos:accept -- --in=/absolute/private/fos-controlled.json');
const result = await registerFosBenchmarkEvidence(root, input);
process.stdout.write(`${JSON.stringify({
  status: result.status,
  path: result.path,
  reportSha256: result.report.reportSha256,
  implementationCommit: result.report.binding.implementationCommit,
  evaluation: result.report.evaluation
}, null, 2)}\n`);
