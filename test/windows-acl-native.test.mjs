import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { secureWindowsAuthAcl } from '../src/mcp-auth-profile.mjs';
import { readPrivateSidecar, writeImmutablePrivateSidecar } from '../src/private-sidecar.mjs';
import { run } from '../src/util.mjs';

test('native Windows can publish and verify an ACL-qualified immutable sidecar',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-sidecar-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    run('git', ['init', '--quiet', '--template=', root]);
    const target = path.join(root, '.git', 'singularity-flow', 'private', 'fixture-key');
    const bytes = Buffer.alloc(32, 7), options = { maximumBytes: 32, enforceWindowsAcl: true };
    await writeImmutablePrivateSidecar(root, target, bytes, options);
    assert.deepEqual(await readPrivateSidecar(root, target, options), bytes);
  });

test('native Windows ACL arguments retain spaces, quotes, metacharacters and Unicode as data',
  { skip: process.platform !== 'win32' }, async t => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-acl-'));
    t.after(() => rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const directory = path.join(temporary, "cache ' Å ; $literal");
    await mkdir(directory);
    const prepared = await secureWindowsAuthAcl(directory, { directory: true, recursive: true });
    assert.equal(prepared.protected, true);
    assert.equal(prepared.entries, 1);
    const file = path.join(directory, "state ' Ω ; $literal.json");
    await writeFile(file, '{"preserved":true}\n');
    assert.equal((await secureWindowsAuthAcl(file)).protected, true);
    const checked = await secureWindowsAuthAcl(directory, { directory: true, recursive: true, apply: false });
    assert.equal(checked.protected, true);
    assert.equal(checked.entries, 2);
    assert.equal(await readFile(file, 'utf8'), '{"preserved":true}\n');
  });

test('native Windows ACLs ignore inherited PowerShell Core and caller module paths',
  { skip: process.platform !== 'win32' }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-native-core-modules-'));
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    const before = process.env.PSModulePath;
    const environment = { ...process.env, PSModulePath: path.join(root, 'not-a-system-module-path') };
    assert.equal((await secureWindowsAuthAcl(root, { directory: true, environment })).protected, true);
    assert.equal((await secureWindowsAuthAcl(root, { directory: true, apply: false, environment })).protected, true);
    assert.equal(process.env.PSModulePath, before, 'only the child shell module path changes');
  });
