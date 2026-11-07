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
  assert.match(shared,/import\('\.\.\/\.\.\/engine-compatibility\/native-convergence\.mjs'\)/u);
  assert.doesNotMatch(shared,/import\('\.\.\/story\.mjs'\)/u);
  for(const file of ['../src/commands/prepare.mjs','../src/cli.mjs']) {
    const source=await readFile(new URL(file,import.meta.url),'utf8');
    assert.match(source,/await prepareConfiguredPhase\(/u,file);
  }
});
