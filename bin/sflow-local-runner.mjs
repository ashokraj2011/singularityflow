#!/usr/bin/env node
/** Private worker entry point for the developer-local signed runner. */
import { stdin, stdout } from 'node:process';

import { loadDefinition } from '../src/config.mjs';
import {
  executeLocalRunnerWorker, validateLocalRunnerPlan
} from '../src/delivery-modes/local-signed-runner.mjs';
import { canonicalJson } from '../src/records.mjs';
import { repoRoot } from '../src/git.mjs';

const chunks = [];
for await (const chunk of stdin) {
  chunks.push(Buffer.from(chunk));
  if (chunks.reduce((total, entry) => total + entry.length, 0) > 1024 * 1024) {
    throw new Error('Local runner request exceeds its byte ceiling.');
  }
}
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'plan,root') {
  throw new Error('Local runner request is invalid.');
}
const root = repoRoot(input.root);
const definition = await loadDefinition(root);
const attestation = await executeLocalRunnerWorker(
  root, definition, validateLocalRunnerPlan(input.plan)
);
stdout.write(canonicalJson(attestation));
