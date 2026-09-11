import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLI_PAYLOAD, PACKAGING_NPM_CLI_ENV, VSCE_TOOLCHAIN, assertPortablePackageCheckout, assertVscePackageInputs,
  configureLocalDemoWorkflow, resolveVsce, stageCli, vscodePackagingEnvironment,
  vscePackageArguments, vsceToolManifest
} from '../scripts/vscode-dev.mjs';
import {
  PACKAGING_COMMIT, PACKAGING_TREE, STAMPED_BUILD_INFO_SHA256,
  reproducibleBuildEnvironment, resolveSourceDateEpoch, vscodeBuildIdentity
} from '../scripts/reproducible-build.mjs';
import { stampBuildInfo } from '../src/build-info-stamp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function descendantsNamed(directory, wanted) {
  const matches = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const target = path.join(directory, entry.name);
    if (entry.name === wanted) matches.push(target);
    if (entry.isDirectory()) matches.push(...await descendantsNamed(target, wanted));
  }
  return matches;
}

function zipEntryModes(archive) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const end = archive.lastIndexOf(endSignature);
  assert.ok(end >= 0, 'VSIX has no end-of-central-directory record');
  const entries = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  const modes = new Map();
  for (let index = 0; index < entries; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50, 'invalid VSIX central directory');
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    modes.set(name, archive.readUInt32LE(offset + 38) >>> 16);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return modes;
}

test('the installed VS Code CLI carries the canonical Help manual', async () => {
  assert.ok(CLI_PAYLOAD.includes('HELP.md'), 'HELP.md is part of the declared installed payload');
  assert.ok(CLI_PAYLOAD.includes('LICENSE'), 'the bundled polyglot pack license is part of the installed payload');

  const extension = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-package-'));
  const staged = await stageCli({ rootDir: root, extensionDir: extension });
  const result = spawnSync(process.execPath, [
    path.join(staged, 'bin', 'singularity-flow.mjs'), 'help', '--json'
  ], { cwd: extension, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manual = JSON.parse(result.stdout);
  assert.equal(manual.title, 'Singularity Flow Help');
  assert.ok(manual.topics.some((topic) => topic.id === 'story-intake'));
  assert.ok(manual.topics.some((topic) => topic.id === 'workspaces-and-capabilities'));
  const providerImport = spawnSync(process.execPath, [
    '--input-type=module', '-e', 'await import("./src/model-providers/copilot-cli.mjs")'
  ], { cwd: staged, encoding: 'utf8' });
  assert.equal(providerImport.status, 0,
    `the staged CLI cannot load its locked ACP production dependency closure: ${providerImport.stderr}`);
  const sourceDigestImport = spawnSync(process.execPath, [
    '--input-type=module', '-e', [
      'const value = await import("./src/world-model/source-digest.mjs");',
      'process.stdout.write(value.WMB_V4_KERNEL_SOURCE_SHA256);'
    ].join('')
  ], { cwd: staged, encoding: 'utf8' });
  assert.equal(sourceDigestImport.status, 0,
    `the staged CLI cannot hash its installed WMB implementation bytes: ${sourceDigestImport.stderr}`);
  assert.match(sourceDigestImport.stdout, /^sha256:[a-f0-9]{64}$/);
  assert.equal(existsSync(path.join(staged, 'node_modules', 'singularity-flow-vscode')), false,
    'the staged production closure must exclude npm workspace links');
  assert.equal(existsSync(path.join(staged, 'node_modules', '@types', 'node')), false,
    'a lockfile-only optional peer must not become a staged runtime dependency');
  assert.deepEqual(await descendantsNamed(path.join(staged, 'node_modules'), '.bin'), [],
    'platform-specific npm command shims must not enter the staged closure');
  assert.deepEqual(await descendantsNamed(path.join(staged, 'node_modules'), '.package-lock.json'), [],
    'npm-version-specific hidden locks must not enter the staged closure');
});

test('failed CLI staging removes its partial package tree', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-stage-failure-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const extension = path.join(fixture, 'extension');
  await assert.rejects(
    stageCli({ rootDir: path.join(fixture, 'missing-root'), extensionDir: extension })
  );
  assert.equal(existsSync(path.join(extension, 'cli')), false);
});

test('CLI staging admits only tracked payload blobs and a deterministic locked closure', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-stage-tracked-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const privateNpm = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-private-npm-'));
  t.after(() => rm(privateNpm, { recursive: true, force: true }));
  const runGit = (args) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit(['init', '-q', '-b', 'main']);
  runGit(['config', 'user.name', 'CLI staging']);
  runGit(['config', 'user.email', 'cli-staging@example.invalid']);
  await Promise.all([
    mkdir(path.join(repository, 'bin'), { recursive: true }),
    mkdir(path.join(repository, 'src'), { recursive: true }),
    mkdir(path.join(repository, 'toolchains', 'npm-pack'), { recursive: true }),
    mkdir(path.join(privateNpm, 'node_modules', 'npm', 'bin'), { recursive: true })
  ]);
  const buildInfoSource = [
    'export const BUILD_INFO = {',
    '  commit: null,',
    '  sourceSha256: null,',
    '  branch: null,',
    '  dirty: null,',
    '  builtAt: null',
    '};',
    ''
  ].join('\n');
  await Promise.all([
    writeFile(path.join(repository, '.gitignore'), 'node_modules/\nextension/\n*.tgz\n'),
    writeFile(path.join(repository, 'bin', 'tool.mjs'), '#!/usr/bin/env node\n'),
    writeFile(path.join(repository, 'src', 'build-info.mjs'), buildInfoSource),
    writeFile(path.join(repository, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n'),
    writeFile(path.join(repository, 'toolchains', 'npm-pack', 'package.json'), `${JSON.stringify({
      name: 'fixture-npm-pack-toolchain',
      private: true,
      dependencies: { npm: '11.8.0' }
    }, null, 2)}\n`),
    writeFile(path.join(privateNpm, 'node_modules', 'npm', 'package.json'), `${JSON.stringify({
      name: 'npm', version: '11.8.0'
    })}\n`),
    writeFile(path.join(privateNpm, 'node_modules', 'npm', 'bin', 'npm-cli.js'), [
      "const fs = require('node:fs');",
      "if (process.argv[2] !== 'ci') process.exit(9);",
      "fs.writeFileSync(process.env.SFLOW_PINNED_NPM_MARKER, JSON.stringify(process.argv.slice(2)));",
      ''
    ].join('\n')),
    writeFile(path.join(repository, 'package-lock.json'), `${JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'fixture', version: '1.0.0' }
      }
    }, null, 2)}\n`)
  ]);
  runGit(['add', '.gitignore', 'bin/tool.mjs', 'src/build-info.mjs', 'package.json',
    'package-lock.json', 'toolchains/npm-pack/package.json']);
  runGit(['commit', '-q', '-m', 'Fixture']);

  await Promise.all([
    writeFile(path.join(repository, 'src', 'ignored-payload.tgz'), 'must not ship\n'),
    mkdir(path.join(repository, 'node_modules', 'runtime', 'node_modules', '.bin'), { recursive: true }),
    mkdir(path.join(repository, 'node_modules', '@types', 'node'), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(repository, 'node_modules', 'runtime', 'index.js'), 'module.exports = 1;\n'),
    writeFile(path.join(repository, 'node_modules', 'runtime', 'node_modules', '.bin', 'tool.cmd'), 'shim\n'),
    writeFile(path.join(repository, 'node_modules', '@types', 'node', 'index.d.ts'), 'declare const peer: true;\n')
  ]);

  const staged = await stageCli({
    rootDir: repository,
    extensionDir: path.join(repository, 'extension')
  });
  assert.equal(existsSync(path.join(staged, 'src', 'ignored-payload.tgz')), false);
  assert.equal(existsSync(path.join(staged, 'node_modules', 'runtime')), false,
    'ambient dependency files outside the lock must not enter the stage');
  assert.equal(existsSync(path.join(staged, 'node_modules', '@types', 'node')), false);

  const npmCli = path.join(privateNpm, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await assert.rejects(
    stageCli({
      rootDir: repository,
      extensionDir: path.join(repository, 'extension'),
      environment: { [PACKAGING_NPM_CLI_ENV]: npmCli }
    }),
    /requires complete verified packaging provenance/
  );

  const capturedCommit = runGit(['rev-parse', '--verify', 'HEAD']);
  const stampedBytes = stampBuildInfo(buildInfoSource, {
    commit: capturedCommit,
    sourceSha256: null,
    branch: null,
    dirty: false,
    builtAt: '2000-01-01T00:00:00.000Z'
  });
  await writeFile(path.join(repository, 'src', 'build-info.mjs'), stampedBytes);
  const capturedEnvironment = {
    SOURCE_DATE_EPOCH: '946684800',
    [PACKAGING_COMMIT]: capturedCommit,
    [PACKAGING_TREE]: runGit(['rev-parse', 'HEAD^{tree}']),
    [STAMPED_BUILD_INFO_SHA256]: `sha256:${createHash('sha256').update(stampedBytes).digest('hex')}`,
    [PACKAGING_NPM_CLI_ENV]: npmCli,
    SFLOW_PINNED_NPM_MARKER: path.join(privateNpm, 'used.json')
  };
  const checkoutNpm = path.join(
    repository, 'toolchains', 'npm-pack', 'node_modules', 'npm');
  await mkdir(path.join(checkoutNpm, 'bin'), { recursive: true });
  await Promise.all([
    writeFile(path.join(checkoutNpm, 'package.json'), '{"name":"npm","version":"11.8.0"}\n'),
    copyFile(npmCli, path.join(checkoutNpm, 'bin', 'npm-cli.js'))
  ]);
  await assert.rejects(
    stageCli({
      rootDir: repository,
      extensionDir: path.join(repository, 'extension'),
      environment: {
        ...capturedEnvironment,
        [PACKAGING_NPM_CLI_ENV]: path.join(checkoutNpm, 'bin', 'npm-cli.js')
      }
    }),
    /must point outside the packaging checkout/
  );
  const captured = await stageCli({
    rootDir: repository,
    extensionDir: path.join(repository, 'extension'),
    environment: capturedEnvironment
  });
  assert.equal(await readFile(path.join(captured, 'src', 'build-info.mjs'), 'utf8'), stampedBytes);
  assert.deepEqual(JSON.parse(await readFile(capturedEnvironment.SFLOW_PINNED_NPM_MARKER, 'utf8')), [
    'ci', '--workspaces=false', '--ignore-scripts', '--no-audit', '--no-fund',
    '--omit=dev', '--omit=peer', '--include=optional', '--prefer-offline'
  ]);
  await writeFile(path.join(privateNpm, 'node_modules', 'npm', 'package.json'),
    '{"name":"npm","version":"0.0.0"}\n');
  await assert.rejects(
    stageCli({
      rootDir: repository,
      extensionDir: path.join(repository, 'extension'),
      environment: capturedEnvironment
    }),
    /Pinned packaging npm expected npm@11\.8\.0, found npm@0\.0\.0/
  );
  await assert.rejects(
    stageCli({
      rootDir: repository,
      extensionDir: path.join(repository, 'extension'),
      environment: {
        ...capturedEnvironment,
        [STAMPED_BUILD_INFO_SHA256]: `sha256:${'0'.repeat(64)}`
      }
    }),
    /Stamped build provenance bytes/
  );
  assert.equal(existsSync(path.join(repository, 'extension', 'cli')), false);
});

test('the CommonJS extension build uses a host-safe package root without import.meta warnings', () => {
  const extension = path.join(root, 'apps', 'vscode');
  const result = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: extension, encoding: 'utf8' });
  const output = `${result.stdout}${result.stderr}`;

  assert.equal(result.status, 0, output);
  assert.doesNotMatch(output, /empty-import-meta|import\.meta.*not available/i, output);
});

test('the VS Code build stamp uses reproducible source time and preserves local identity', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-build-identity-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const runGit = (args, environment = process.env) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8', env: environment });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  runGit(['init', '-q', '-b', 'main']);
  runGit(['config', 'user.name', 'Build Identity']);
  runGit(['config', 'user.email', 'build-identity@example.invalid']);
  await mkdir(path.join(repository, 'src'));
  await writeFile(path.join(repository, 'README.md'), '# reproducible build fixture\n');
  const buildInfoSource = [
    'export const BUILD_INFO = {',
    '  commit: null,',
    '  sourceSha256: null,',
    '  branch: null,',
    '  dirty: null,',
    '  builtAt: null',
    '};',
    ''
  ].join('\n');
  await writeFile(path.join(repository, 'src', 'build-info.mjs'), buildInfoSource);
  runGit(['add', 'README.md', 'src/build-info.mjs']);
  const commitEnvironment = {
    ...process.env,
    GIT_AUTHOR_DATE: '2001-02-03T04:05:06Z',
    GIT_COMMITTER_DATE: '2001-02-03T04:05:06Z'
  };
  runGit(['commit', '-q', '-m', 'Fixture'], commitEnvironment);
  const commit = runGit(['rev-parse', '--short=7', 'HEAD']);
  const fullCommit = runGit(['rev-parse', '--verify', 'HEAD']);
  const tree = runGit(['rev-parse', 'HEAD^{tree}']);

  const fromCommit = vscodeBuildIdentity(repository, {});
  assert.equal(fromCommit.stamp, `${commit} 2001-02-03T04:05Z`);
  assert.equal(fromCommit.sourceDateEpoch, runGit(['show', '-s', '--format=%ct', 'HEAD']));

  const explicit = vscodeBuildIdentity(repository, { SOURCE_DATE_EPOCH: '946684800' });
  assert.equal(explicit.stamp, `${commit} 2000-01-01T00:00Z`);
  assert.equal(resolveSourceDateEpoch(repository, { SOURCE_DATE_EPOCH: '946684800' }), '946684800');
  assert.equal(
    reproducibleBuildEnvironment(repository, { RELEASE_CELL: 'darwin-node22' }).SOURCE_DATE_EPOCH,
    fromCommit.sourceDateEpoch
  );
  assert.deepEqual(
    vscodePackagingEnvironment({
      rootDir: repository,
      environment: {
        RELEASE_CELL: 'darwin-node22', SOURCE_DATE_EPOCH: '946684800', TZ: 'Asia/Kolkata'
      }
    }),
    { RELEASE_CELL: 'darwin-node22', SOURCE_DATE_EPOCH: '946684800', TZ: 'Etc/UTC', CI: '1' }
  );

  const stampedBuildInfo = stampBuildInfo(buildInfoSource, {
    commit: fullCommit,
    sourceSha256: null,
    branch: null,
    dirty: false,
    builtAt: '2000-01-01T00:00:00.000Z'
  });
  await writeFile(path.join(repository, 'src', 'build-info.mjs'), stampedBuildInfo);
  const stampDigest = `sha256:${createHash('sha256')
    .update(await readFile(path.join(repository, 'src', 'build-info.mjs'))).digest('hex')}`;
  const capturedEnvironment = {
    SOURCE_DATE_EPOCH: '946684800',
    [PACKAGING_COMMIT]: fullCommit,
    [PACKAGING_TREE]: tree,
    [STAMPED_BUILD_INFO_SHA256]: stampDigest
  };
  assert.equal(
    vscodeBuildIdentity(repository, capturedEnvironment).stamp,
    `${commit} 2000-01-01T00:00Z`,
    'a byte-verified installer provenance stamp retains the captured clean identity'
  );
  assert.equal(
    vscodeBuildIdentity(repository, {
      SOURCE_DATE_EPOCH: '946684800', SINGULARITY_FLOW_STAMPED_BUILD_INFO: '1'
    }).local,
    true,
    'the obsolete boolean cannot bypass provenance verification'
  );
  const callerChosenStamp = stampBuildInfo(buildInfoSource, {
    commit: fullCommit,
    sourceSha256: null,
    branch: 'invented-branch',
    dirty: false,
    builtAt: '2000-01-01T00:00:00.000Z'
  });
  await writeFile(path.join(repository, 'src', 'build-info.mjs'), callerChosenStamp);
  assert.throws(
    () => vscodeBuildIdentity(repository, {
      ...capturedEnvironment,
      [STAMPED_BUILD_INFO_SHA256]: `sha256:${createHash('sha256').update(callerChosenStamp).digest('hex')}`
    }),
    /Stamped build provenance bytes/,
    'a self-consistent caller digest cannot authorize non-deterministic stamp content'
  );
  await writeFile(path.join(repository, 'src', 'build-info.mjs'), stampedBuildInfo);
  assert.throws(
    () => vscodeBuildIdentity(repository, {
      SOURCE_DATE_EPOCH: '946684800', [PACKAGING_COMMIT]: fullCommit
    }),
    /Incomplete packaging provenance capture/
  );
  assert.throws(
    () => vscodeBuildIdentity(repository, {
      ...capturedEnvironment, [STAMPED_BUILD_INFO_SHA256]: `sha256:${'0'.repeat(64)}`
    }),
    /Stamped build provenance bytes/
  );
  await writeFile(path.join(repository, 'README.md'), '# changed after capture\n');
  assert.throws(
    () => vscodeBuildIdentity(repository, capturedEnvironment),
    /checkout changed after provenance was captured/
  );
  runGit(['restore', 'README.md']);
  await writeFile(path.join(repository, 'README.md'), '# staged after capture\n');
  runGit(['add', 'README.md']);
  assert.throws(
    () => vscodeBuildIdentity(repository, capturedEnvironment),
    /packaging tree no longer matches/
  );
  runGit(['restore', '--staged', 'README.md']);
  runGit(['restore', 'README.md']);
  runGit(['restore', 'src/build-info.mjs']);

  const nestedGitless = path.join(repository, 'nested-export');
  await mkdir(nestedGitless);
  assert.equal(
    vscodeBuildIdentity(nestedGitless, {}, { now: () => Date.parse('2002-03-04T05:06:07Z') }).commit,
    'unknown',
    'a Git-less directory nested below a checkout must not inherit the parent repository HEAD'
  );
  await rm(nestedGitless, { recursive: true, force: true });

  await writeFile(path.join(repository, 'README.md'), '# locally changed\n');
  assert.equal(
    vscodeBuildIdentity(repository, { SOURCE_DATE_EPOCH: '946684800' }).stamp,
    `${commit}+local 2000-01-01T00:00Z`
  );
  const localTime = Date.parse('2002-03-04T05:06:07Z');
  assert.equal(
    vscodeBuildIdentity(repository, {}, { now: () => localTime }).stamp,
    `${commit}+local 2002-03-04T05:06Z`
  );
  assert.equal(
    reproducibleBuildEnvironment(repository, {}, { now: () => localTime }).SOURCE_DATE_EPOCH,
    String(localTime / 1_000)
  );

  runGit(['restore', 'README.md']);
  runGit(['config', 'status.showUntrackedFiles', 'no']);
  await writeFile(path.join(repository, 'untracked.txt'), 'must still make the build local\n');
  assert.equal(
    vscodeBuildIdentity(repository, {}, { now: () => localTime }).stamp,
    `${commit}+local 2002-03-04T05:06Z`,
    'build identity must not inherit a Git config that hides untracked package inputs'
  );

  const gitless = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-build-gitless-'));
  t.after(() => rm(gitless, { recursive: true, force: true }));
  assert.deepEqual(vscodeBuildIdentity(gitless, {}, { now: () => localTime }), {
    commit: 'unknown',
    local: true,
    sourceDateEpoch: String(localTime / 1_000),
    stamp: 'unknown+local 2002-03-04T05:06Z'
  });
  for (const invalid of ['', '-1', '1.5', 'not-an-epoch', '8640000000001']) {
    assert.throws(
      () => resolveSourceDateEpoch(repository, { SOURCE_DATE_EPOCH: invalid }),
      /SOURCE_DATE_EPOCH/
    );
  }
});

test('the extension bundle is byte-stable across timezones under a source date epoch', async () => {
  const extension = path.join(root, 'apps', 'vscode');
  const sourceEnvironment = { ...process.env, SOURCE_DATE_EPOCH: '946684800' };
  const expected = vscodeBuildIdentity(root, sourceEnvironment).stamp;
  const build = (timezone) => spawnSync(process.execPath, ['esbuild.mjs'], {
    cwd: extension, encoding: 'utf8', env: { ...sourceEnvironment, TZ: timezone }
  });
  const firstBuild = build('Asia/Kolkata');
  assert.equal(firstBuild.status, 0, `${firstBuild.stdout}${firstBuild.stderr}`);
  const first = await readFile(path.join(extension, 'dist', 'extension.cjs'));
  assert.ok(first.includes(expected), `extension bundle omitted reproducible stamp ${expected}`);
  const secondBuild = build('America/New_York');
  assert.equal(secondBuild.status, 0, `${secondBuild.stdout}${secondBuild.stderr}`);
  const second = await readFile(path.join(extension, 'dist', 'extension.cjs'));
  assert.deepEqual(second, first);
});

test('the packaging environment gives ZIP writers UTC local-time fields', () => {
  const sourceDateEpoch = '946684800';
  const zipLocalFields = (timezone) => {
    const environment = vscodePackagingEnvironment({
      rootDir: root,
      environment: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch, TZ: timezone }
    });
    const child = spawnSync(process.execPath, ['-e', [
      'const date = new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000);',
      'process.stdout.write([date.getFullYear(), date.getMonth() + 1, date.getDate(),',
      '  date.getHours(), date.getMinutes(), date.getSeconds()].join(","));'
    ].join('\n')], { encoding: 'utf8', env: environment });
    assert.equal(child.status, 0, child.stderr);
    return child.stdout;
  };
  assert.equal(zipLocalFields('Asia/Kolkata'), '2000,1,1,0,0,0');
  assert.equal(zipLocalFields('America/New_York'), '2000,1,1,0,0,0');
  for (const outsideDosRange of ['315532799', '4354819200']) {
    assert.throws(
      () => vscodePackagingEnvironment({
        rootDir: root,
        environment: { ...process.env, SOURCE_DATE_EPOCH: outsideDosRange }
      }),
      /1980 through 2107/
    );
  }
});

test('packaged source paths are checked out with LF on every platform', async () => {
  assert.equal(await readFile(path.join(root, '.gitattributes'), 'utf8'), '* text=auto eol=lf\n');
  const attributes = spawnSync('git', [
    'check-attr', 'text', 'eol', '--',
    'src/build-info.mjs', 'apps/vscode/package.json', 'bin/singularity-flow.mjs'
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(attributes.status, 0, attributes.stderr);
  for (const file of [
    'src/build-info.mjs', 'apps/vscode/package.json', 'bin/singularity-flow.mjs'
  ]) {
    assert.match(attributes.stdout, new RegExp(`${file.replaceAll('.', '\\.')}.*text: auto`));
    assert.match(attributes.stdout, new RegExp(`${file.replaceAll('.', '\\.')}.*eol: lf`));
  }
});

test('packaging rejects a clean checkout whose tracked inputs still contain CRLF', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-crlf-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const runGit = (args) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit(['init', '-q', '-b', 'main']);
  runGit(['config', 'user.name', 'CRLF fixture']);
  runGit(['config', 'user.email', 'crlf@example.invalid']);
  await mkdir(path.join(repository, 'apps', 'vscode'), { recursive: true });
  await writeFile(path.join(repository, 'apps', 'vscode', 'extension.js'), 'first\r\nsecond\r\n');
  runGit(['add', 'apps/vscode/extension.js']);
  runGit(['commit', '-q', '-m', 'CRLF fixture']);
  assert.throws(
    () => assertPortablePackageCheckout(repository),
    /CRLF or mixed Git\/worktree bytes/
  );
});

test('VSCE input validation rejects ignored files that its own ignore rules would include', async (t) => {
  const repository = await mkdtemp(path.join(os.tmpdir(), 'sflow-vscode-inputs-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const extension = path.join(repository, 'apps', 'vscode');
  await mkdir(path.join(repository, 'scripts'), { recursive: true });
  await mkdir(extension, { recursive: true });
  await copyFile(
    path.join(root, 'scripts', 'vsce-reproducible-preload.cjs'),
    path.join(repository, 'scripts', 'vsce-reproducible-preload.cjs')
  );
  const manifest = {
    name: 'sflow-input-fixture',
    displayName: 'SFlow input fixture',
    version: '1.0.0',
    publisher: 'singularityflow',
    description: 'Validates the VSCE input boundary.',
    engines: { vscode: '^1.90.0' }
  };
  await Promise.all([
    writeFile(path.join(repository, '.gitignore'), '*.secret\n'),
    writeFile(path.join(extension, '.vscodeignore'), 'not-the-secret.txt\n'),
    writeFile(path.join(extension, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(extension, 'README.md'), '# Input fixture\n'),
    writeFile(path.join(extension, 'LICENSE'), 'MIT\n')
  ]);
  const runGit = (args) => {
    const result = spawnSync('git', args, { cwd: repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  runGit(['init', '-q', '-b', 'main']);
  runGit(['config', 'user.name', 'VSCE inputs']);
  runGit(['config', 'user.email', 'vsce-inputs@example.invalid']);
  runGit(['add', '.gitignore', 'apps/vscode']);
  runGit(['commit', '-q', '-m', 'Fixture']);
  await writeFile(path.join(extension, 'leak.secret'), 'ignored by Git, visible to VSCE\n');

  const vsce = await resolveVsce();
  await assert.rejects(
    assertVscePackageInputs({ entry: vsce.entry, rootDir: repository, extensionDir: extension }),
    /ignored or untracked package input: leak\.secret/
  );
});

test('pinned VSCE output is stable across locale, timezone, and host file modes', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'sflow-vsce-reproducible-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const manifest = {
    name: 'sflow-reproducibility-fixture',
    displayName: 'SFlow reproducibility fixture',
    version: '1.0.0',
    publisher: 'singularityflow',
    description: 'Exercises deterministic VSCE packaging.',
    engines: { vscode: '^1.90.0' }
  };
  const regular = path.join(fixture, 'I-one.txt');
  const executable = path.join(fixture, 'tool.js');
  await Promise.all([
    writeFile(path.join(fixture, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(path.join(fixture, 'README.md'), '# Reproducibility fixture\n'),
    writeFile(path.join(fixture, 'LICENSE'), 'MIT\n'),
    writeFile(regular, 'same bytes\n'),
    writeFile(path.join(fixture, 'i-two.txt'), 'same bytes\n'),
    writeFile(path.join(fixture, 'İ-three.txt'), 'same bytes\n'),
    writeFile(path.join(fixture, 'ı-four.txt'), 'same bytes\n'),
    writeFile(executable, '#!/usr/bin/env node\n')
  ]);
  const vsce = await resolveVsce();
  const archive = path.join(fixture, `${manifest.name}-${manifest.version}.vsix`);
  const packageOnce = async ({ locale, timezone, mode }) => {
    await rm(archive, { force: true });
    await Promise.all([chmod(regular, mode), chmod(executable, mode)]);
    const environment = vscodePackagingEnvironment({
      rootDir: root,
      environment: {
        ...process.env,
        SOURCE_DATE_EPOCH: '946684800',
        LANG: locale,
        LC_ALL: locale,
        TZ: timezone
      }
    });
    const result = spawnSync(process.execPath, vscePackageArguments(vsce.entry), {
      cwd: fixture, encoding: 'utf8', env: environment
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    return readFile(archive);
  };

  const english = await packageOnce({
    locale: 'en_US.UTF-8', timezone: 'America/New_York', mode: 0o600
  });
  const turkish = await packageOnce({
    locale: 'tr_TR.UTF-8', timezone: 'Asia/Kolkata', mode: 0o777
  });
  assert.deepEqual(turkish, english);
  const modes = zipEntryModes(english);
  const names = [...modes.keys()];
  const archiveFiles = names.filter((name) => name.startsWith('extension/'));
  assert.deepEqual(
    archiveFiles,
    [...archiveFiles].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    'VSCE content entries must be sorted by locale-independent code points'
  );
  assert.equal(modes.get('extension/I-one.txt'), 0o100644);
  assert.equal(modes.get('extension/tool.js'), 0o100755);

  const preload = path.join(root, 'scripts', 'vsce-reproducible-preload.cjs');
  const expression = 'process.stdout.write(String("I".localeCompare("ı")))';
  const native = spawnSync(process.execPath, ['-e', expression], {
    encoding: 'utf8', env: { ...process.env, LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }
  });
  const preloaded = spawnSync(process.execPath, ['--require', preload, '-e', expression], {
    encoding: 'utf8', env: { ...process.env, LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' }
  });
  assert.equal(native.status, 0, native.stderr);
  assert.equal(preloaded.status, 0, preloaded.stderr);
  assert.equal(preloaded.stdout, native.stdout, 'non-archive locale comparisons retain native behavior');
});

test('the extension package contains every explicit lazy runtime used by the activation bundle', async () => {
  const extension = path.join(root, 'apps', 'vscode');
  const built = spawnSync(process.execPath, ['esbuild.mjs'], { cwd: extension, encoding: 'utf8' });
  assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
  const manifest = JSON.parse(await readFile(path.join(extension, 'package.json'), 'utf8'));
  const [bundle, gatewayContext, gateway, help, panels, worker, support, worldModel] = await Promise.all([
    readFile(path.join(extension, 'dist', 'extension.cjs'), 'utf8'),
    readFile(path.join(extension, 'dist', 'gateway-context-runtime.cjs'), 'utf8'),
    readFile(path.join(extension, 'dist', 'gateway-runtime.cjs'), 'utf8'),
    readFile(path.join(extension, 'dist', 'help-runtime.cjs'), 'utf8'),
    readFile(path.join(extension, 'dist', 'lazy-panels-runtime.cjs'), 'utf8'),
    readFile(path.join(extension, 'dist', 'gateway-status-worker.cjs'), 'utf8'),
    readFile(path.join(extension, 'dist', 'support-runtime.cjs'), 'utf8'),
    readFile(path.join(extension, 'dist', 'world-model-build.cjs'), 'utf8')
  ]);
  assert.equal(manifest.activationEvents.includes('workspaceContains:workspace.json'), false);
  assert.match(bundle, /gateway-context-runtime\.cjs/);
  assert.match(bundle, /help-runtime\.cjs/);
  assert.match(bundle, /lazy-panels-runtime\.cjs/);
  assert.match(bundle, /gateway-status-worker\.cjs/);
  assert.match(bundle, /support-runtime\.cjs/);
  assert.match(bundle, /world-model-build\.cjs/);
  assert.match(gatewayContext, /gateway-runtime\.cjs/);
  assert.match(gatewayContext, /function activeRepositoryContext\(/,
    'the shared lightweight entry owns repository routing for every lazy bundle');
  assert.match(gateway, /investigate-problem/,
    'the lazy gateway runtime omitted the conversation router');
  assert.match(gateway, /function primaryAction\(/,
    'the lazy gateway runtime omitted the result selector');
  assert.match(help, /var HelpPanel = class/);
  assert.doesNotMatch(panels, /var HelpPanel = class/,
    'the frequent Help surface must not parse the complete panel graph');
  assert.match(worker, /process\.on\(["']message["']/);
  assert.match(support, /recordHelpMetric/);
  assert.match(worldModel, /showGovernedWorldModelBuild/);
});

test('VS Code packaging pins one Artifactory-compatible MSAL dependency graph', () => {
  const manifest = vsceToolManifest();
  assert.deepEqual(manifest.dependencies, { '@vscode/vsce': '3.9.2' });
  assert.deepEqual(manifest.overrides, {
    '@azure/abort-controller': '2.1.2',
    '@azure/core-auth': '1.10.1',
    '@azure/core-client': '1.10.1',
    '@azure/core-rest-pipeline': '1.24.0',
    '@azure/core-tracing': '1.3.0',
    '@azure/core-util': '1.13.1',
    '@azure/logger': '1.3.0',
    '@azure/identity': '4.13.1',
    '@azure/msal-node': '5.1.0',
    '@azure/msal-browser': '5.5.0',
    '@azure/msal-common': '16.3.0',
    '@typespec/ts-http-runtime': '0.3.1'
  });
  assert.equal(VSCE_TOOLCHAIN.msalCommon, '16.3.0');
});

test('the local VS Code demo does not require a remote it deliberately omits', () => {
  const configured = configureLocalDemoWorkflow([
    'git:',
    '  remote: origin',
    '  publish: required',
    'worldModel:',
    '  grounding: warn'
  ].join('\n'));
  assert.match(configured, /publish: off/);
  assert.match(configured, /grounding: off/);
  assert.doesNotMatch(configured, /publish: required/);
});
