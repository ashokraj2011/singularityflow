#!/usr/bin/env node
import { qualifyNativeEfficiency, qualificationSamples } from '../src/native-efficiency-qualification.mjs';

try {
  const args = process.argv.slice(2);
  let samples = 30, hooks = true;
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error('Duplicate qualification option.');
    seen.add(argument);
    if (argument === '--skip-hooks') { hooks = false; continue; }
    if (argument !== '--samples' || !/^\d+$/u.test(args[index + 1] ?? '')) throw new Error('Use [--samples 1..300] [--skip-hooks].');
    samples = qualificationSamples(Number(args[++index]));
  }
  console.log(JSON.stringify(await qualifyNativeEfficiency({ samples, hooks }), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
