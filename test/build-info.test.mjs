/**
 * The installed CLI can say which build it is, and every surface that says it agrees.
 *
 * `VERSION` is a hand-maintained string. Two installations whose `cli.mjs` differed by 369 lines
 * both reported `0.9.0`, so "am I running what I am editing?" had no answer at the command line —
 * which is how an afternoon goes into fixing something the installed build already fixed.
 *
 * Where it goes took two wrong turns, both recorded here because the tests are shaped by them.
 * First the fix went into `cli.mjs`, which the binary never reaches for `--version` — so it must be
 * asserted by running the CLI, not by importing a formatter. Then it went into `--version` itself,
 * which `reinstall.mjs` compares with `!==`; that would have failed every `--clean-reinstall`. Hence
 * the split the tests now pin: `--version` is a bare semver contract, `--build` and `doctor` carry
 * the provenance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUILD_INFO, buildDescription, versionLine } from '../src/build-info.mjs';
import { buildInfoFacts, stamp } from '../scripts/stamp-build-info.mjs';
import { buildReinstallBundle, reinstallSourceDigest } from '../src/reinstall.mjs';
import { VERSION } from '../src/version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function provenancePackageFixture(prefix) {
  const temp = await mkdtemp(path.join(os.tmpdir(), prefix));
  const checkout = path.join(temp, 'checkout');
  await mkdir(path.join(checkout, 'src'), { recursive: true });
  await writeFile(path.join(checkout, 'package.json'), JSON.stringify({
    name: 'singularity-flow-build-provenance-fixture',
    version: '1.0.0',
    type: 'module',
    files: ['src/']
  }));
  await writeFile(path.join(checkout, 'src', 'version.mjs'), "export const VERSION = '1.0.0';\n");
  await writeFile(
    path.join(checkout, 'src', 'build-info.mjs'),
    await readFile(path.join(root, 'src', 'build-info.mjs'), 'utf8')
  );
  return { temp, checkout };
}

test('an unstamped checkout says so rather than inventing a commit', () => {
  // The committed file must always be the placeholder: `install.sh` stamps it for the tarball and
  // restores it immediately, so a real commit here means a stamp escaped into version control.
  assert.equal(BUILD_INFO.commit, null, 'src/build-info.mjs is committed with a stamp; it must hold the placeholder');
  assert.equal(BUILD_INFO.sourceSha256, null);
  assert.match(buildDescription(), /development checkout/);
  assert.equal(versionLine(), `${VERSION} (development checkout, not a stamped package)`);
});

test('a stamped module still parses, and carries the commit it was built from', async () => {
  const source = await readFile(path.join(root, 'src', 'build-info.mjs'), 'utf8');
  const facts = {
    commit: '0123456789abcdef0123456789abcdef01234567',
    sourceSha256: null,
    branch: 'main',
    dirty: false,
    builtAt: '2026-08-17T09:00:00.000Z'
  };
  const stamped = stamp(source, facts);

  // Imported as a real module rather than regex-checked: the failure this guards against is a stamp
  // that writes syntactically invalid JavaScript, which only an actual parse can catch.
  const loaded = await import(`data:text/javascript,${encodeURIComponent(
    stamped.replace("import { VERSION } from './version.mjs';", `const VERSION = '${VERSION}';`))}`);
  assert.deepEqual({ ...loaded.BUILD_INFO }, facts);
  assert.match(loaded.versionLine(), /0123456789abcdef0123456789abcdef01234567|01234567/);
});

test('stamping safely preserves backslashes, quotes, newlines, and replacement tokens', async () => {
  const source = await readFile(path.join(root, 'src', 'build-info.mjs'), 'utf8');
  const branch = "feature/C:\\Users\\Ashok\\flow-$&-'quote'\nnext\u2028line";
  const facts = {
    commit: '0123456789abcdef0123456789abcdef01234567',
    sourceSha256: null,
    branch,
    dirty: false,
    builtAt: '2026-08-17T09:00:00.000Z'
  };
  const stamped = stamp(source, facts);
  const loaded = await import(`data:text/javascript,${encodeURIComponent(
    stamped.replace("import { VERSION } from './version.mjs';", `const VERSION = '${VERSION}';`))}`);
  assert.deepEqual({ ...loaded.BUILD_INFO }, facts);
});

test('a dirty packing tree is disclosed, because that build is not reproducible', async () => {
  const source = await readFile(path.join(root, 'src', 'build-info.mjs'), 'utf8');
  const stamped = stamp(source, { ...buildInfoFacts(), dirty: true });
  assert.match(stamped, /dirty: true/);
  assert.match(buildDescription({ commit: 'abcdef1234', dirty: true }), /dirty tree/);
});

test('the no-Git reinstall packager stamps the validated source digest into the real tarball', async () => {
  const { temp, checkout } = await provenancePackageFixture('sflow-build-info-package-');
  const sourceSha256 = await reinstallSourceDigest(checkout);
  const execute = (command, args, options = {}) => {
    if (command === 'npm' && args[0] === 'pack') {
      return spawnSync(command, args, {
        ...options,
        encoding: 'utf8',
        env: { ...process.env, ...options.env, NODE_ENV: 'test' }
      });
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const bundle = await buildReinstallBundle({
    checkout,
    registry: 'https://registry.npmjs.org/',
    cliOnly: true,
    sourceSha256,
    execute,
    tempRoot: temp,
    log: () => {}
  });
  const unpacked = path.join(temp, 'unpacked');
  await mkdir(unpacked);
  const extracted = spawnSync('tar', ['-xzf', bundle.tarball, '-C', unpacked], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  const packagedBuildInfo = path.join(unpacked, 'package', 'src', 'build-info.mjs');
  const packagedSource = await readFile(packagedBuildInfo, 'utf8');
  const packaged = await import(`${pathToFileURL(packagedBuildInfo).href}?test=${Date.now()}`);
  assert.equal(packaged.BUILD_INFO.commit, null);
  assert.equal(packaged.BUILD_INFO.sourceSha256, sourceSha256);
  assert.equal(packaged.BUILD_INFO.dirty, null);
  assert.match(packaged.versionLine(), new RegExp(`source ${sourceSha256.slice(0, 12)}`));
  assert.doesNotMatch(packaged.versionLine(), /development checkout/);
  assert.doesNotMatch(packagedSource, new RegExp(checkout.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the package must not embed the builder checkout path');
});

test('the reinstall packager refuses a source digest that does not match its isolated copy', async () => {
  const { temp, checkout } = await provenancePackageFixture('sflow-build-info-stale-');
  let commands = 0;
  await assert.rejects(buildReinstallBundle({
    checkout,
    registry: 'https://registry.npmjs.org/',
    cliOnly: true,
    sourceSha256: '00'.repeat(32),
    execute: () => { commands += 1; return { status: 0, stdout: '', stderr: '' }; },
    tempRoot: temp,
    log: () => {}
  }), /changed while its isolated package source was being copied/);
  assert.equal(commands, 0, 'a mismatched source must be refused before npm runs');
});

/**
 * `--version` stays a bare semver, and `--build` is where provenance goes.
 *
 * This test originally asserted the opposite — that no surface prints the bare constant — which was
 * exactly backwards. `reinstall.mjs` compares `singularity-flow --version` to the planned version
 * with `!==`, so appending anything makes every `--clean-reinstall` throw. `test/cli.test.mjs`'s
 * "print only the package version" was guarding a real machine contract, not being fussy.
 *
 * Asserted from the outside, by running the built CLI, because the failure being prevented is about
 * bytes on stdout: an import-level assertion cannot see a second surface that formats its own line.
 */
test('--version prints a bare semver that reinstall can compare, and --build carries provenance', () => {
  const cli = path.join(root, 'bin', 'singularity-flow.mjs');
  for (const argument of ['--version', '-v', 'version']) {
    const result = spawnSync(process.execPath, [cli, argument], { encoding: 'utf8', cwd: root });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/,
      `'${argument}' must print only a semver: reinstall.mjs compares it with !==`);
    assert.equal(result.stdout.trim(), VERSION);
  }

  const build = spawnSync(process.execPath, [cli, '--build'], { encoding: 'utf8', cwd: root });
  assert.equal(build.status, 0, build.stderr);
  assert.match(build.stdout.trim(), new RegExp(`^${VERSION.replace(/\./g, '\\.')} \\(`),
    '--build should lead with the version, then the provenance in parentheses');
  assert.match(build.stdout, /development checkout|built /);
});

test('the diagnostics page reports which build is running', async () => {
  // doctor is where somebody asks "am I running what I am editing?", so the line has to be there and
  // not only behind a flag they would have to already know about.
  const { doctorSnapshot } = await import('../src/doctor.mjs');
  const snapshot = await doctorSnapshot(root);
  const build = snapshot.checks.find((entry) => entry.id === 'build');
  assert.ok(build, 'doctor has no build check');
  assert.equal(build.message, versionLine());
});

test('diagnostics remain available from a detached verification checkout', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-doctor-detached-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: checkout, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Detached Doctor');
  git('config', 'user.email', 'detached@example.invalid');
  await writeFile(path.join(checkout, 'README.md'), '# Detached diagnostics\n');
  git('add', 'README.md');
  git('commit', '-m', 'fixture');
  git('checkout', '--detach', 'HEAD');

  const { doctorSnapshot } = await import('../src/doctor.mjs');
  const snapshot = await doctorSnapshot(checkout, { offline: true, probeModelProvider: false });
  assert.equal(snapshot.branch, '(detached)');
  assert.match(snapshot.head, /^[0-9a-f]{40,64}$/);
});
