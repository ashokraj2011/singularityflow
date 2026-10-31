import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  // A Node the wrapper accepts on Windows (22.17), whatever Node runs this test; anything else it asks goes to the real one.
  const bin = path.join(fixture, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'node'), `#!/usr/bin/env bash\ncase "$*" in *'[0]'*) echo 22;; *'[1]'*) echo 17;; --version) echo v22.17.0;; *) exec ${JSON.stringify(process.execPath)} "$@";; esac\n`);
  await chmod(path.join(bin, 'node'), 0o755);
  for (const noUpdate of [false, true]) {
    const result = spawnSync('bash', [path.join(fixture, 'install-windows-git-bash.sh'),
      '--cli-only', '--skip-tests', ...(noUpdate ? ['--no-update'] : [])], {
      cwd: fixture, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: childTimeout(30_000)
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const lines = result.stdout.trim().split(/\r?\n/);
    assert.equal(lines.includes('--no-update'), noUpdate);
    assert.ok(lines.includes('--cli-only'));
    assert.ok(lines.includes('--skip-tests'));
  }
  // Node 22.12 to 22.16 report device 0 for a path stat on Windows 11 24H2: the wrapper refuses them.
  await writeFile(path.join(bin, 'node'), `#!/usr/bin/env bash\ncase "$*" in *'[0]'*) echo 22;; *'[1]'*) echo 14;; --version) echo v22.14.0;; *) exec ${JSON.stringify(process.execPath)} "$@";; esac\n`);
  const refused = spawnSync('bash', [path.join(fixture, 'install-windows-git-bash.sh'), '--cli-only', '--skip-tests'], {
    cwd: fixture, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: childTimeout(30_000)
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Node\.js 22\.17 or newer \(not 23\) is required; found v22\.14\.0/u);
});
