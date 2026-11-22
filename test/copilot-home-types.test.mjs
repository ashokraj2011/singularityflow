import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

test('a Git-free source copy exposes the Copilot home contract to strict TypeScript consumers', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow copilot home types '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'src');
  await mkdir(source);
  for (const file of ['copilot-home.mjs', 'copilot-home.d.mts']) {
    await copyFile(new URL(`../src/${file}`, import.meta.url), path.join(source, file));
  }
  const consumer = path.join(directory, 'consumer.ts');
  await writeFile(consumer, `
import { copilotHome, COPILOT_HOME_ENVIRONMENT } from './src/copilot-home.mjs';
const defaultHome: string = copilotHome();
const explicitHome: string = copilotHome({
  env: { COPILOT_HOME: '/copilot', UNSET: undefined }, homeDirectory: '/home'
});
const defaultOptions: string = copilotHome({});
const names: readonly ['COPILOT_HOME'] = COPILOT_HOME_ENVIRONMENT;
// @ts-expect-error Environment values must be strings or undefined.
copilotHome({ env: { COPILOT_HOME: 42 } });
// @ts-expect-error The home directory is a path string.
copilotHome({ homeDirectory: 42 });
// @ts-expect-error The exported environment names are immutable.
COPILOT_HOME_ENVIRONMENT.push('OTHER');
`);
  const program = ts.createProgram([consumer], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    types: []
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => directory,
    getNewLine: () => '\n'
  }));
});
