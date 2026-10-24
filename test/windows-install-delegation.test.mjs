import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { childTimeout } from './helpers/child-timeout.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Windows wrapper delegates the update choice without pulling ahead of recovery admission', async t => {
  const wrapper = await readFile(path.join(root, 'install-windows-git-bash.sh'), 'utf8');
  const installer = await readFile(path.join(root, 'install.sh'), 'utf8');
  assert.doesNotMatch(wrapper, /git -C|git pull|git status/);
  assert.ok(installer.indexOf('\nacquire_activation_lease create\n') < installer.indexOf('\n  git pull --ff-only\n'));
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-windows-install-delegate-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, 'src'));
  await copyFile(path.join(root, 'install-windows-git-bash.sh'), path.join(fixture, 'install-windows-git-bash.sh'));
  await writeFile(path.join(fixture, 'package.json'), '{}\n');
  await writeFile(path.join(fixture, 'src/agents.mjs'), '// Git for Windows commonly checks Markdown out with CRLF\n');
  await writeFile(path.join(fixture, 'install.sh'), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n');
  for (const noUpdate of [false, true]) {
    const result = spawnSync('bash', [path.join(fixture, 'install-windows-git-bash.sh'),
      '--cli-only', '--skip-tests', ...(noUpdate ? ['--no-update'] : [])], {
      cwd: fixture, env: process.env, encoding: 'utf8', timeout: childTimeout(30_000)
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.includes('--no-update'), noUpdate);
    assert.ok(lines.includes('--cli-only'));
    assert.ok(lines.includes('--skip-tests'));
  }
});
