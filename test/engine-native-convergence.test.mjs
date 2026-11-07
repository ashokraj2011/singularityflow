import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {prepareDeterministicConvergence as native} from '../src/engine-compatibility/native-convergence.mjs';
import {prepareDeterministicConvergence as compatibility} from '../src/commands/story.mjs';

test('the public Story service keeps the exact native convergence function rather than a second implementation',()=>{
  assert.equal(compatibility,native);
});

test('both configured preparation paths reach the native convergence owner without importing the Story command module',async()=>{
  const shared=await readFile(new URL('../src/commands/shared/prepare-configured-phase.mjs',import.meta.url),'utf8');
  assert.match(shared,/\.engine\.run\('phase\.prepare'/u);
  assert.doesNotMatch(shared,/import\('\.\.\/story\.mjs'\)/u);
  const host=await readFile(new URL('../src/commands/prepare.mjs',import.meta.url),'utf8');
  assert.match(host,/\.engine\.run\('phase\.prepare'/u);
  const cli=await readFile(new URL('../src/cli.mjs',import.meta.url),'utf8');
  assert.match(cli,/await prepareConfiguredPhase\(/u);
  const nativePort=await readFile(new URL('../src/engine-compatibility/git-phase-entry.mjs',import.meta.url),'utf8');
  assert.match(nativePort,/import\('\.\/native-convergence\.mjs'\)/u);
  assert.match(nativePort,/await prepareDeterministicConvergence\(/u);
});
