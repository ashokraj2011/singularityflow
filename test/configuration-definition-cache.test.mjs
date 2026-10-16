import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { compiledConfiguration, configurationEngineIdentity, copyCompiledDefinition } from '../src/configuration-definition-cache.mjs';
import { run } from '../src/util.mjs';

async function fixture(t) {
  // These tests require a usable engine identity; expose that failure instead of only seeing
  // the optional cache's intentional fallback to compilation.
  await configurationEngineIdentity();
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-compiled-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  run('git', ['init', '--quiet', '--template=', root]);
  const assets = ['singularity/workflow.yml', '.github/agents/custom.agent.md', 'singularity/skills/custom/SKILL.md',
    'singularity/instructions/condition.md', 'singularity/templates/custom.md', 'singularity/constitution.md']
    .map(relative => ({ relative, gitMode: '100644', sha256: createHash('sha256').update(relative).digest('hex') }));
  const cache = path.join(root, '.git/singularity-flow/compiled-configuration-v1');
  let compilations = 0;
  const compile = async () => {
    compilations++;
    const agent = { id: 'custom', scope: 'repository', file: path.join(root, '.github/agents/custom.agent.md'), source: '.github/agents/custom.agent.md' };
    const result = { phases: { custom: {} }, agents: { custom: agent }, agentCatalog: [agent] };
    Object.defineProperties(result, { initiativeRoot: { value: 'custom/initiatives', enumerable: false },
      governedRoots: { value: ['custom/templates'], enumerable: false } });
    return result;
  };
  return { root, assets, cache, compile, count: () => compilations };
}

test('compiled closure is reused, roots rebound and every caller owns independent values', async t => {
  const f = await fixture(t);
  await compiledConfiguration(f.root, f.root, f.assets, f.compile);
  const other = path.join(f.root, 'overlay');
  const value = await compiledConfiguration(f.root, other, f.assets, f.compile);
  assert.equal(f.count(), 1);
  assert.equal(value.agents.custom.file, path.join(other, '.github/agents/custom.agent.md'));
  assert.equal(value.initiativeRoot, 'custom/initiatives');
  assert.deepEqual(value.governedRoots, ['custom/templates']);
  assert.equal(Object.keys(value).includes('governedRoots'), false);
  value.phases.custom.changed = true;
  assert.equal((await compiledConfiguration(f.root, f.root, f.assets, f.compile)).phases.custom.changed, undefined);
  const copy = copyCompiledDefinition(value, other, f.root);
  assert.equal(copy.initiativeRoot, value.initiativeRoot);
});

test('each dependency changes the closure key; dependency deletion and A-B-A cannot reuse B', async t => {
  const f = await fixture(t);
  await compiledConfiguration(f.root, f.root, f.assets, f.compile);
  for (let index = 0; index < f.assets.length; index++) {
    const changed = f.assets.map((asset, position) => position === index ? { ...asset, sha256: 'a'.repeat(64) } : asset);
    await compiledConfiguration(f.root, f.root, changed, f.compile);
  }
  await compiledConfiguration(f.root, f.root, f.assets.slice(1), f.compile);
  await compiledConfiguration(f.root, f.root, f.assets, f.compile);
  assert.equal(f.count(), f.assets.length + 3);
});

test('tampering, an oversized receipt, and disabled caching compile without trusting cached policy', async t => {
  const f = await fixture(t);
  await compiledConfiguration(f.root, f.root, f.assets, f.compile);
  const file = path.join(f.cache, 'definition.v8');
  const bytes = await readFile(file); bytes[bytes.length - 1] ^= 1;
  await writeFile(file, bytes);
  await compiledConfiguration(f.root, f.root, f.assets, f.compile);
  assert.equal(f.count(), 2);
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
  await compiledConfiguration(f.root, f.root, f.assets, f.compile);
  await compiledConfiguration(f.root, f.root, f.assets, f.compile, { env: { SINGULARITY_FLOW_COMPILED_CONFIGURATION_CACHE: 'off' } });
  assert.equal(f.count(), 4);
});

test('unsafe cache ancestors decline caching without following the link', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.root, '.git/singularity-flow'), 'dir');
  await compiledConfiguration(f.root, f.root, f.assets, f.compile);
  assert.equal(f.count(), 1);
  assert.deepEqual(await import('node:fs/promises').then(fs => fs.readdir(outside)), []);
});
