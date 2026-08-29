/**
 * The npm package is an authority boundary, not just a file-delivery mechanism.
 *
 * SGOS deliberately omits storage writers, raw adapter injection, and test seams from its public
 * barrel. Without a package exports map, an external integration can ignore that decision and
 * deep-import src/sgos/store.mjs or src/sgos/runtime.mjs from the installed package. This test uses
 * a separate consumer with the package linked through node_modules, which exercises Node's real
 * package resolver instead of importing this checkout by relative path.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('an external consumer can use only the supported package entry points', async () => {
  const consumer = await mkdtemp(path.join(os.tmpdir(), 'sflow-package-consumer-'));
  try {
    const modules = path.join(consumer, 'node_modules');
    await mkdir(modules);
    await symlink(packageRoot, path.join(modules, 'singularity-flow'), 'dir');
    await writeFile(path.join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
    await writeFile(path.join(consumer, 'consumer.mjs'), `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { createSflow } from 'singularity-flow/src/api.mjs';
      import * as sgos from 'singularity-flow/sgos';

      assert.equal(typeof createSflow, 'function');
      assert.equal(typeof sgos.startSgosProcess, 'function');
      assert.equal(typeof sgos.readSgosProcess, 'function');
      assert.equal('mutateSgosProcess' in sgos, false);
      assert.equal('runNextSgosTask' in sgos, false);
      assert.equal('putSgosCandidateSnapshot' in sgos, false);

      for (const invoke of [
        () => sgos.startSgosProcess('.', { clock: '2000-01-01T00:00:00.000Z' }),
        () => sgos.stepSgosProcess('.', 'PROC-TEST', { clock: '2000-01-01T00:00:00.000Z' }),
        () => sgos.respondToSgosHumanRequest('.', 'PROC-TEST', {
          clock: '2000-01-01T00:00:00.000Z'
        }),
        () => sgos.recoverInterruptedSgosExecution('.', 'PROC-TEST', {
          clock: '2000-01-01T00:00:00.000Z'
        }),
        () => sgos.pauseSgosProcess('.', 'PROC-TEST', { clock: '2000-01-01T00:00:00.000Z' }),
        () => sgos.resumeSgosProcess('.', 'PROC-TEST', { clock: '2000-01-01T00:00:00.000Z' })
      ]) {
        await assert.rejects(invoke, (error) => {
          assert.equal(error?.code, 'SGOS_PUBLIC_OPTIONS_INVALID');
          assert.match(error.message, /operational runtime time/);
          return true;
        });
      }
      await assert.rejects(
        () => sgos.stepSgosProcess('.', 'PROC-TEST', { handlers: {} }),
        (error) => error?.code === 'SGOS_PUBLIC_OPTIONS_INVALID'
      );

      const require = createRequire(import.meta.url);
      const metadata = require('singularity-flow/package.json');
      assert.equal(metadata.name, 'singularity-flow');

      for (const specifier of [
        'singularity-flow/src/sgos/runtime.mjs',
        'singularity-flow/src/sgos/store.mjs',
        'singularity-flow/src/sgos/index.mjs'
      ]) {
        await assert.rejects(import(specifier), (error) => {
          assert.equal(error?.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED');
          return true;
        });
      }
    `);

    const result = spawnSync(process.execPath, ['consumer.mjs'], {
      cwd: consumer,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test' }
    });
    assert.equal(result.status, 0,
      `external package consumer failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
});
