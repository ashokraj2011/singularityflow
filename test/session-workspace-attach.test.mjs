import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bootstrapRepository } from '../src/bootstrap.mjs';

/**
 * Attaching a Story in a workspace: a repository that is not there yet is cloned; one that is there
 * is brought up to date by fetch and fast-forward only, never merged, rebased or discarded; one whose
 * Git files are undownloaded cloud placeholders is left exactly as it is, with the way to fix it.
 * Placeholders are simulated as in session-remote-listing.test.mjs: packs become same-size sparse
 * files, loose objects named pipes.
 */
const bin = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const posix = process.platform !== 'win32';

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env, timeout: 180_000 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function evict(gitDirectory, saved) {
  const objects = path.join(gitDirectory, 'objects');
  for (const directory of readdirSync(objects)) {
    const loose = /^[0-9a-f]{2}$/.test(directory);
    if (!loose && directory !== 'pack') continue;
    for (const name of readdirSync(path.join(objects, directory))) {
      if (!loose && !name.endsWith('.pack')) continue;
      const file = path.join(objects, directory, name);
      const copy = path.join(saved, directory, name);
      execFileSync('mkdir', ['-p', path.dirname(copy)]);
      renameSync(file, copy);
      if (loose) execFileSync('mkfifo', [file]);
      else { writeFileSync(file, ''); truncateSync(file, statSync(copy).size); }
    }
  }
}

/** Names, kinds and sizes of every entry under a directory, read with lstat only (never contents). */
function shape(directory) {
  const entries = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(current, entry.name);
      const stat = lstatSync(file);
      entries.push(`${path.relative(directory, file)} ${stat.isFIFO() ? 'fifo' : stat.isDirectory() ? 'dir' : stat.size}`);
      if (stat.isDirectory()) walk(file);
    }
  };
  walk(directory);
  return entries.join('\n');
}

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

test('attach clones an absent workspace repository, fast-forwards a present one, and leaves an offloaded one untouched',
  { skip: !posix, timeout: 300_000 }, async (t) => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-attach-'));
    t.after(() => rm(base, { recursive: true, force: true }));
    const remote = path.join(base, 'remote.git');
    const seed = path.join(base, 'seed');
    run('git', ['init', '--bare', remote], base);
    run('git', ['init', '-b', 'main', seed], base);
    run('git', ['config', 'user.name', 'Attach Seed'], seed);
    run('git', ['config', 'user.email', 'attach.seed@example.invalid'], seed);
    await writeFile(path.join(seed, 'README.md'), '# Workspace attach\n');
    run('git', ['add', '.'], seed);
    run('git', ['commit', '-m', 'initial'], seed);
    run('git', ['push', remote, 'main:main'], seed);
    run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
    run('git', ['config', 'uploadpack.allowFilter', 'true'], remote);

    const env = {
      ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_BUNDLE: 'off', SINGULARITY_FLOW_NO_MODEL: '1',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Attach Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent: 'product-owner' }),
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Attach Tester',
      GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'attach.tester@example.invalid'
    };
    const boot = await bootstrapRepository(remote, { capabilityId: 'attach', capabilityName: 'Attach', base: path.join(base, 'work') });
    run(process.execPath, [bin, 'start', 'ATT-101', '--from-branch', 'main', '--title', 'Workspace attach', '--work-type', 'feature'], boot.root, env);
    const storyBranch = run('git', ['branch', '--show-current'], boot.root).stdout.trim();
    const remoteHead = () => run('git', ['rev-parse', `refs/heads/${storyBranch}`], remote).stdout.trim();

    const created = JSON.parse(run(process.execPath, [bin, 'workspace', 'create', '--local', '--id', 'attachws', '--lead', 'application',
      '--repository', `application=${pathToFileURL(remote).href}`, '--base', path.join(base, 'workspaces'), '--confirm', 'attachws', '--json'], base, env).stdout);
    const workspacePath = created.workspace.path;
    const repository = path.join(workspacePath, 'repos', 'application');
    const selector = ['--workspace', workspacePath, '--repository', 'application'];
    const attach = (extra = env) => spawnSync(process.execPath, [bin, 'session', 'attach', 'ATT-101', ...selector, '--json'],
      { cwd: base, env: extra, encoding: 'utf8', timeout: 180_000 });

    await t.test('absent: the Story branch is cloned into the workspace, fetching it once', async () => {
      assert.equal(spawnSync('git', ['-C', repository, 'rev-parse'], { encoding: 'utf8' }).status, 128, 'not cloned yet');
      // Count the Git fetches that name the Story branch, without retaining any other argument.
      const fetches = path.join(base, 'story-fetches.log');
      const hook = path.join(base, 'story-fetch-hook.mjs');
      await writeFile(hook, `import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
for (const name of ['spawn', 'spawnSync']) {
  const original = cp[name];
  cp[name] = function(command, args, ...rest) {
    if (/(^|[\\\\/])git(\\.exe)?$/.test(String(command)) && Array.isArray(args) && args.includes('fetch')
        && args.some((arg) => String(arg).includes('refs/heads/${storyBranch}:'))) appendFileSync(${JSON.stringify(fetches)}, 'fetch\\n');
    return Reflect.apply(original, this, [command, args, ...rest]);
  };
}
syncBuiltinESMExports();
`);
      await writeFile(fetches, '');
      const attached = attach({ ...env, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}` });
      assert.equal(readFileSync(fetches, 'utf8').split('\n').filter(Boolean).length, 1, 'the Story branch is fetched once');
      assert.equal(attached.status, 0, `${attached.stdout}\n${attached.stderr}`);
      const result = JSON.parse(attached.stdout);
      assert.equal(realpathSync(result.repositoryPath), realpathSync(repository));
      assert.equal(run('git', ['branch', '--show-current'], repository).stdout.trim(), storyBranch);
      assert.equal(result.commit, remoteHead());
    });

    await t.test('present: fetched and fast-forwarded; local commits and uncommitted changes stop it untouched', async () => {
      run('git', ['switch', '-q', storyBranch], boot.root);
      await writeFile(path.join(boot.root, 'remote-note.txt'), 'from the remote\n');
      run('git', ['add', 'remote-note.txt'], boot.root, env);
      run('git', ['commit', '-q', '-m', 'Remote progress'], boot.root, env);
      run('git', ['push', '-q', 'origin', storyBranch], boot.root, env);
      const advanced = attach();
      assert.equal(advanced.status, 0, `${advanced.stdout}\n${advanced.stderr}`);
      assert.equal(JSON.parse(advanced.stdout).commit, remoteHead());
      assert.equal(readFileSync(path.join(repository, 'remote-note.txt'), 'utf8'), 'from the remote\n');

      // A local commit the remote does not have: nothing is merged, rebased or reset.
      await writeFile(path.join(repository, 'local-note.txt'), 'only here\n');
      run('git', ['add', 'local-note.txt'], repository, env);
      run('git', ['commit', '-q', '-m', 'Local only'], repository, env);
      const localHead = run('git', ['rev-parse', 'HEAD'], repository).stdout.trim();
      const diverged = attach();
      assert.notEqual(diverged.status, 0);
      assert.match(diverged.stdout, /contains commits that are not on origin\//);
      assert.equal(run('git', ['rev-parse', 'HEAD'], repository).stdout.trim(), localHead);
      run('git', ['reset', '-q', '--hard', `origin/${storyBranch}`], repository);

      // Uncommitted changes while the remote moved on: they are kept and the attach stops.
      await writeFile(path.join(boot.root, 'remote-note.txt'), 'remote moved again\n');
      run('git', ['commit', '-q', '-am', 'Remote progress again'], boot.root, env);
      run('git', ['push', '-q', 'origin', storyBranch], boot.root, env);
      await writeFile(path.join(repository, 'README.md'), '# edited locally\n');
      const dirty = attach();
      assert.notEqual(dirty.status, 0);
      assert.match(dirty.stdout, /uncommitted changes/);
      assert.equal(readFileSync(path.join(repository, 'README.md'), 'utf8'), '# edited locally\n');
      run('git', ['checkout', '-q', '--', 'README.md'], repository);
      const caughtUp = attach();
      assert.equal(caughtUp.status, 0, caughtUp.stdout);
      assert.equal(JSON.parse(caughtUp.stdout).commit, remoteHead());
    });

    await t.test('offloaded: nothing changes, and the refusal says how to download it or clone it elsewhere', () => {
      evict(path.join(repository, '.git'), path.join(base, 'saved-objects'));
      const before = shape(repository);
      const manifest = sha(path.join(workspacePath, 'workspace.json'));
      const offloaded = { ...env, SINGULARITY_FLOW_GIT_STORAGE_CHECK: 'always', SINGULARITY_FLOW_GIT_STORAGE_DOWNLOAD_TIMEOUT_MS: '500' };
      const started = performance.now();
      const refused = attach(offloaded);
      assert.ok(performance.now() - started < 60_000);
      assert.notEqual(refused.status, 0);
      const packet = JSON.parse(refused.stdout);
      assert.equal(packet.error.code, 'GIT_STORAGE_UNAVAILABLE');
      assert.match(packet.error.message, /Repository 'application' at .* is offloaded/);
      assert.match(packet.error.message, /cannot be attached there\. Nothing was changed, moved or deleted\./);
      assert.match(packet.error.message, /Download Now\) and run \/sf-session ATT-101 again/);
      assert.match(packet.error.message, /only if you confirm, clone the workspace again outside .* workspace duplicate .* --id attachws-local .* --clone/);
      const step = packet.remediationPlan.steps.find((entry) => entry.id === 'clone-workspace-outside-synced-folder');
      assert.match(step.label, /^Only if the person confirms: clone the workspace again at /);
      const relocation = packet.error.details.relocation;
      assert.equal(packet.error.details.offloaded, true);
      assert.equal(relocation.requiresConfirmation, true);
      assert.deepEqual(step.argv, relocation.argv);

      const opened = spawnSync(process.execPath, [bin, 'session', 'open', 'ATT-101', ...selector, '--for-agent', '--json'],
        { cwd: base, env: offloaded, encoding: 'utf8', timeout: 180_000 });
      assert.notEqual(opened.status, 0);
      const openRefusal = JSON.parse(opened.stdout);
      assert.equal(openRefusal.error.code, 'GIT_STORAGE_UNAVAILABLE');
      assert.match(openRefusal.error.message, /cannot be opened there\. Nothing was changed/);

      assert.equal(shape(repository), before, 'the offloaded repository was not touched');
      assert.equal(sha(path.join(workspacePath, 'workspace.json')), manifest, 'the workspace still points where it did');

      // The confirmed remedy: a fresh clone elsewhere, then attach there.
      const fresh = path.join(base, 'fresh');
      const argv = [...relocation.argv];
      argv[argv.indexOf('--base') + 1] = fresh;
      run(process.execPath, [bin, ...argv, '--json'], base, env);
      run(process.execPath, [bin, ...relocation.useArgv], base, env);
      const moved = spawnSync(process.execPath, [bin, 'session', 'attach', 'ATT-101', '--json'],
        { cwd: base, env: offloaded, encoding: 'utf8', timeout: 180_000 });
      assert.equal(moved.status, 0, `${moved.stdout}\n${moved.stderr}`);
      assert.equal(realpathSync(JSON.parse(moved.stdout).repositoryPath), realpathSync(path.join(fresh, 'attachws-local', 'repos', 'application')));
      assert.equal(JSON.parse(moved.stdout).commit, remoteHead());
      rmSync(path.join(base, 'saved-objects'), { recursive: true, force: true });
    });
  });
