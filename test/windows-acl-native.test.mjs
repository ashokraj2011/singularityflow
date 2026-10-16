import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { secureWindowsAuthAcl } from '../src/mcp-auth-profile.mjs';

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
