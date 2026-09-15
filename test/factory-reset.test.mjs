import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  access, chmod, link, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, rename, rm, stat,
  symlink, writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function command(executable, args, cwd, { ok = true, env = {} } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', ...env }
  });
  if (ok) assert.equal(result.status, 0, `${executable} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

function git(root, ...args) {
  return command('git', args, root).stdout.trim();
}

async function missing(file) {
  try { await access(file); return false; } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

test('reset path classification follows Windows case-insensitive filesystem identity', async () => {
  const { controlRootPath, repositoryPathCovers } = await import('../src/factory-reset.mjs');
  assert.equal(controlRootPath('Singularity/WORK-1.json', 'win32'), true);
  assert.equal(controlRootPath('.SDLC/config.json', 'darwin'), true);
  assert.equal(repositoryPathCovers('.GITHUB/AGENTS/', '.github/agents/qa.agent.md', 'win32'), true);
  assert.equal(repositoryPathCovers('.GITHUB/AGENTS/', '.github/agents/qa.agent.md', 'darwin'), true);
  assert.equal(repositoryPathCovers('.GITHUB/AGENTS/', '.github/agents/qa.agent.md', 'linux'), false,
    'case-distinct Linux paths remain distinct');
});

test('fresh-install root identity accepts portable Windows drive and UNC spellings', async () => {
  const { resetPathIdentity, sameResetPathIdentity } = await import('../src/fresh-install-reset.mjs');
  assert.equal(sameResetPathIdentity('C:/Users/Ashok/Flow', 'c:\\Users\\Ashok\\Flow\\', 'win32'), true);
  assert.equal(sameResetPathIdentity('/c/Users/Ashok/Flow', 'C:\\Users\\Ashok\\Flow', 'win32'), true);
  assert.equal(sameResetPathIdentity('//SERVER/Share/Flow', '\\\\server\\share\\flow\\', 'win32'), true);
  assert.equal(sameResetPathIdentity('\\\\?\\UNC\\SERVER\\Share\\Flow', '//server/share/flow', 'win32'), true);
  assert.equal(sameResetPathIdentity('C:/Users/Ashok/Flow', 'D:/Users/Ashok/Flow', 'win32'), false);
  assert.equal(resetPathIdentity('/', 'linux'), '/');
});

test('fresh-install workspace deletion refuses roots, protected roots, and their ancestors', async () => {
  const { assertNarrowWorkspaceRoot } = await import('../src/fresh-install-reset.mjs');
  const base = path.join(os.tmpdir(), 'sflow-narrow-workspace-contract');
  const home = path.join(base, 'home', 'ashok');
  const project = path.join(base, 'product', 'singularity-flow');
  const options = { homeDirectory: home, projectDirectory: project };
  for (const target of [
    path.parse(base).root,
    home,
    project,
    path.dirname(home),
    path.dirname(project)
  ]) {
    assert.throws(() => assertNarrowWorkspaceRoot(target, options), /Refusing|installer checkout is inside/);
  }
  assert.doesNotThrow(() => assertNarrowWorkspaceRoot(path.join(home, 'workspaces', 'demo'), options),
    'an ordinary workspace below HOME remains a narrow eligible target');
});

test('factory-reset scope is bound to the canonical clone even at the same revision', async (t) => {
  const parentA = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-clone-a-'));
  const parentB = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-clone-b-'));
  const first = path.join(parentA, 'same-name');
  const second = path.join(parentB, 'same-name');
  t.after(() => Promise.all([
    rm(parentA, { recursive: true, force: true }), rm(parentB, { recursive: true, force: true })
  ]));
  await mkdir(first);
  git(first, 'init', '-b', 'main');
  git(first, 'config', 'user.name', 'Factory Reset Tester');
  git(first, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(first, 'app.txt'), 'same source\n');
  git(first, 'add', 'app.txt');
  git(first, 'commit', '-m', 'initial');
  command('git', ['clone', '--no-local', first, second], parentB);

  const { factoryResetPlan } = await import('../src/factory-reset.mjs');
  const firstPlan = await factoryResetPlan(first);
  const secondPlan = await factoryResetPlan(second);
  assert.equal(firstPlan.head, secondPlan.head);
  assert.equal(firstPlan.confirmation, secondPlan.confirmation,
    'the human phrase remains familiar and the reviewed SHA is the clone-bound freshness token');
  assert.notEqual(firstPlan.resetScopeSha256, secondPlan.resetScopeSha256,
    'a reviewed scope token from one clone cannot authorize a second clone');
});

test('factory-reset scope includes repository-local runtime bytes and identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-runtime-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const runtime = path.join(await realpath(git(root, 'rev-parse', '--absolute-git-dir')), 'singularity-flow');
  await mkdir(runtime, { recursive: true });
  const receipt = path.join(runtime, 'session.json');
  await writeFile(receipt, '{"generation":1}\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const first = await factoryResetPlan(root);
  await writeFile(receipt, '{"generation":2}\n');
  const second = await factoryResetPlan(root);
  assert.notEqual(first.resetScopeSha256, second.resetScopeSha256);
  const replacement = path.join(runtime, 'session.replacement.json');
  await writeFile(replacement, '{"generation":2}\n');
  await rename(replacement, receipt);
  const third = await factoryResetPlan(root);
  assert.notEqual(second.resetScopeSha256, third.resetScopeSha256,
    'same bytes in a replacement inode still invalidate the reviewed runtime identity');
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: first.confirmation,
    expectedScopeSha256: first.resetScopeSha256,
    allowDirty: true
  }), /scope changed after preview/);
  assert.equal(await readFile(receipt, 'utf8'), '{"generation":2}\n');
});

test('a repository mutation started during factory reset is refused before it changes the checkout', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-command-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');

  const { withRepositoryResetBarrier } = await import('../src/subject-lock.mjs');
  await withRepositoryResetBarrier(root, async () => {
    const result = command(process.execPath, [cli, 'init'], root, { ok: false });
    assert.match(result.stderr, /reinitialization is in progress/i);
    assert.equal(await missing(path.join(root, 'singularity')), true,
      'the mutating command is stopped before its handler creates configuration');
  });
});

test('factory reset previews, requires exact confirmation, and restores npm defaults without touching source or history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'application source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const beforeHead = git(root, 'rev-parse', 'HEAD');

  command(process.execPath, [cli, 'init'], root);
  const workflow = path.join(root, 'singularity', 'workflow.yml');
  await writeFile(workflow, `${await readFile(workflow, 'utf8')}\n# local customization removed by reset\n`);
  await mkdir(path.join(root, 'singularity', 'work-items', 'WORK-1'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'work-items', 'WORK-1', 'workflow.json'), '{}\n');
  const localRuntime = path.join(root, '.git', 'singularity-flow');
  await mkdir(localRuntime, { recursive: true });
  await writeFile(path.join(localRuntime, 'session.json'), '{"workId":"WORK-1"}\n');
  const qaAgent = path.join(root, '.github', 'agents', 'qa.agent.md');
  await writeFile(qaAgent, 'customized packaged agent\n');
  const customAgent = path.join(root, '.github', 'agents', 'company-specialist.agent.md');
  const customAgentContent = `---
name: company-specialist
description: Preserved repository-specific agent.
tools: [read]
---

# Company specialist

Preserve this custom repository agent during a factory reset.
`;
  await writeFile(customAgent, customAgentContent);

  const preview = command(process.execPath, [cli, 'factory-reset', '--dry-run', '--json'], root);
  const plan = JSON.parse(preview.stdout);
  assert.equal(plan.operation, 'factory-reset');
  // The token binds to this checkout at this commit. A token that is only the directory name is
  // derivable without ever seeing the preview, and matches a different clone of the same repository.
  assert.equal(plan.confirmation, `RESET ${path.basename(root)} ${beforeHead.slice(0, 7)}`);
  assert.notEqual(plan.confirmation, `RESET ${path.basename(root)}`);
  const humanPreview = command(process.execPath, [cli, 'factory-reset', '--dry-run'], root).stdout;
  assert.match(humanPreview, new RegExp(`--expect-scope-sha256 ${plan.resetScopeSha256}`),
    'the copyable apply command is bound to the exact reviewed reset scope');
  assert.equal(plan.localRuntimeRoots.length, 1,
    'filesystem aliases for the same ordinary-checkout Git directory are deduplicated');
  assert.ok(plan.uncommittedDiscardPaths.some((entry) => entry.includes('.github/agents/qa.agent.md')),
    'a customized packaged agent is disclosed as data the reset overwrites');
  assert.ok(!plan.uncommittedDiscardPaths.some((entry) => entry.includes('company-specialist.agent.md')),
    'a non-packaged custom agent is reported but preserved');
  assert.equal(await readFile(workflow, 'utf8').then((text) => text.includes('local customization')), true);

  const unbound = command(process.execPath, [
    cli, 'factory-reset', '--confirm', plan.confirmation, '--allow-dirty'
  ], root, { ok: false });
  assert.match(unbound.stderr, /requires the exact --expect-scope-sha256/);
  const refused = command(process.execPath, [
    cli, 'factory-reset', '--confirm', 'RESET WRONG',
    '--expect-scope-sha256', plan.resetScopeSha256
  ], root, { ok: false });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires exact confirmation/);

  // This repository deliberately has uncommitted reset-scope changes, so the discard is explicit.
  const dirty = command(process.execPath, [
    cli, 'factory-reset', '--confirm', plan.confirmation,
    '--expect-scope-sha256', plan.resetScopeSha256
  ], root, { ok: false });
  assert.match(dirty.stderr, /would discard uncommitted changes/);

  const reset = command(process.execPath, [
    cli, 'factory-reset', '--confirm', plan.confirmation,
    '--expect-scope-sha256', plan.resetScopeSha256, '--allow-dirty', '--json'
  ], root);
  const result = JSON.parse(reset.stdout);
  assert.equal(result.completed, true);
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'application source remains\n');
  assert.equal(await readFile(workflow, 'utf8'), await readFile(path.join(packageRoot, 'templates', 'workflow.yml'), 'utf8'));
  assert.equal(await readFile(qaAgent, 'utf8'), await readFile(path.join(packageRoot, 'templates', 'agents', 'qa.agent.md'), 'utf8'));
  assert.equal(await readFile(customAgent, 'utf8'), customAgentContent);
  assert.equal(await missing(path.join(root, 'singularity', 'work-items')), true);
  assert.equal(await missing(localRuntime), true);

  const check = command(process.execPath, [cli, 'init', '--check', '--json'], root);
  assert.equal(JSON.parse(check.stdout).complete, true);
});

test('factory reset preserves an invalid custom agent outside active discovery and remains operational', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-invalid-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'application source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const invalidPath = path.join(root, '.github', 'agents', 'company-broken.agent.md');
  const invalidBytes = Buffer.from('---\nname: Company Broken\nmetadata: [not valid YAML\n---\nprivate recovery bytes\n');
  await writeFile(invalidPath, invalidBytes);
  const validPath = path.join(root, '.github', 'agents', 'company-valid.agent.md');
  const validBytes = Buffer.from(`---
name: company-valid
description: A valid repository-specific agent.
tools: [read]
---

Keep this valid custom agent active.
`);
  await writeFile(validPath, validBytes);
  git(root, 'add', '.github/agents/company-broken.agent.md',
    '.github/agents/company-valid.agent.md', 'singularity', '.github/agents');
  git(root, 'commit', '-m', 'legacy invalid custom agent');
  const beforeHead = git(root, 'rev-parse', 'HEAD');

  const previewText = command(process.execPath, [cli, 'factory-reset', '--dry-run'], root).stdout;
  assert.match(previewText, /Invalid custom agents preserved outside active discovery:/);
  assert.match(previewText,
    /"\.github\/agents\/company-broken\.agent\.md" -> "\.github\/singularity-flow-recovered-agents\//);
  const plan = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], root).stdout);
  assert.equal(plan.customAgentRecoveries.length, 1);
  const [recovery] = plan.customAgentRecoveries;
  assert.equal(recovery.sourcePath, '.github/agents/company-broken.agent.md');
  assert.match(recovery.recoveryPath,
    /^\.github\/singularity-flow-recovered-agents\/[0-9a-f]{64}\/company-broken\.agent\.md$/);
  assert.equal(recovery.bytes, invalidBytes.length);
  assert.match(recovery.reason, /YAML|front matter|agent/i);

  const result = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--confirm', plan.confirmation,
    '--expect-scope-sha256', plan.resetScopeSha256, '--json'
  ], root).stdout);
  assert.equal(result.completed, true);
  assert.equal(await missing(invalidPath), true, 'invalid Markdown is no longer an active agent');
  assert.deepEqual(await readFile(validPath), validBytes,
    'a valid custom agent remains byte-identical in the active directory');
  assert.deepEqual(await readFile(path.join(root, ...recovery.recoveryPath.split('/'))), invalidBytes,
    'the content-addressed recovery copy retains the exact original bytes');
  assert.ok(result.warnings.some((warning) => warning.includes(recovery.recoveryPath)));
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'application source remains\n');
  const check = command(process.execPath, [cli, 'init', '--check', '--json'], root);
  assert.equal(JSON.parse(check.stdout).complete, true);
});

test('factory-reset rollback restores an invalid custom agent and removes its recovery copy', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-agent-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const relative = '.github/agents/broken.agent.md';
  const invalidBytes = Buffer.from('---\nname: broken\ndescription: [invalid\n---\nbody\n');
  await writeFile(path.join(root, ...relative.split('/')), invalidBytes);
  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  const [recovery] = plan.customAgentRecoveries;
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'after-custom-agent-recovery') throw new Error('injected recovery failure');
    }
  }), /injected recovery failure/);
  assert.deepEqual(await readFile(path.join(root, ...relative.split('/'))), invalidBytes);
  assert.equal(await missing(path.join(root, ...recovery.recoveryPath.split('/'))), true);
});

test('factory reset removes former .sdlc state only after explicit dirty-data consent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-sdlc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'application source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const beforeHead = git(root, 'rev-parse', 'HEAD');
  const beforeBranch = git(root, 'branch', '--show-current');
  await mkdir(path.join(root, '.sdlc'), { recursive: true });
  await writeFile(path.join(root, '.sdlc', 'config.json'), '{"version":1,"private":"discard me"}\n');

  let preview = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], root).stdout);
  assert.ok(preview.remove.some((entry) => entry.startsWith('.sdlc/')),
    'the former control root is disclosed in the reset boundary');
  assert.ok(preview.uncommittedDiscardPaths.some((entry) => entry.includes('.sdlc/config.json')),
    'uncommitted former-format data is classified as destructive');
  const firstScope = preview.resetScopeSha256;
  await writeFile(path.join(root, '.sdlc', 'config.json'), '{"version":1,"private":"changed again"}\n');
  preview = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], root).stdout);
  assert.notEqual(preview.resetScopeSha256, firstScope,
    'a same-path byte change invalidates the editor freshness comparison');
  const stale = command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', firstScope, '--allow-dirty', '--json'
  ], root, { ok: false });
  assert.match(stale.stderr, /scope changed after preview/);
  assert.equal(await readFile(path.join(root, '.sdlc', 'config.json'), 'utf8'),
    '{"version":1,"private":"changed again"}\n', 'a stale reviewed scope moves nothing');
  git(root, 'checkout', '-b', 'same-head-other-branch');
  const switched = command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--allow-dirty', '--json'
  ], root, { ok: false });
  assert.match(switched.stderr, /scope changed after preview/,
    'a same-commit branch switch invalidates the reviewed operation');
  assert.equal(await missing(path.join(root, '.sdlc')), false);
  git(root, 'checkout', 'main');

  const refused = command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--json'
  ], root, { ok: false });
  assert.match(refused.stderr, /would discard uncommitted changes/);
  assert.equal(await readFile(path.join(root, '.sdlc', 'config.json'), 'utf8'),
    '{"version":1,"private":"changed again"}\n');

  const reset = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--allow-dirty', '--json'
  ], root).stdout);
  assert.equal(reset.completed, true);
  assert.equal(await missing(path.join(root, '.sdlc')), true);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'application source remains\n');
  assert.equal(git(root, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(root, 'branch', '--show-current'), beforeBranch);
  assert.equal(JSON.parse(command(process.execPath, [cli, 'init', '--check', '--json'], root).stdout).complete, true);
});

test('factory reset detects an editor save immediately before its first destructive move', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-final-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const legacyFile = path.join(root, '.sdlc', 'config.json');
  await mkdir(path.dirname(legacyFile), { recursive: true });
  await writeFile(legacyFile, 'reviewed legacy bytes\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const preview = await factoryResetPlan(root);
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: preview.confirmation,
    expectedScopeSha256: preview.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'before-final-scope-validation') {
        await writeFile(legacyFile, 'changed while replacement was prepared\n');
      }
    }
  }), /scope changed during preparation/);
  assert.equal(await readFile(legacyFile, 'utf8'), 'changed while replacement was prepared\n');
  assert.equal(await missing(path.join(root, 'singularity')), true,
    'no replacement or destructive move occurs after the final fingerprint refuses');
});

test('case-insensitive repository path rules cannot hide a legacy control root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-case-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  git(root, 'config', 'core.ignorecase', 'true');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  await mkdir(path.join(root, '.SDLC'), { recursive: true });
  await writeFile(path.join(root, '.SDLC', 'config.json'), 'private legacy bytes\n');

  const preview = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], root).stdout);
  assert.ok(preview.uncommittedDiscardPaths.some((entry) => entry.includes('.SDLC/config.json')));
  const refused = command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--json'
  ], root, { ok: false });
  assert.match(refused.stderr, /would discard uncommitted changes/);
  assert.equal(await readFile(path.join(root, '.SDLC', 'config.json'), 'utf8'), 'private legacy bytes\n');
});

test('assume-unchanged and skip-worktree flags cannot hide reset-scope bytes', async (t) => {
  for (const indexFlag of ['--assume-unchanged', '--skip-worktree']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-index-hidden-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Factory Reset Tester');
    git(root, 'config', 'user.email', 'factory-reset@example.com');
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    const hidden = path.join(root, 'singularity', 'hidden.txt');
    await writeFile(hidden, 'committed bytes\n');
    await writeFile(path.join(root, 'app.txt'), 'source remains\n');
    git(root, 'add', 'app.txt', 'singularity/hidden.txt');
    git(root, 'commit', '-m', 'initial');
    git(root, 'update-index', indexFlag, 'singularity/hidden.txt');
    await writeFile(hidden, `private bytes hidden by ${indexFlag}\n`);

    const preview = JSON.parse(command(process.execPath, [
      cli, 'factory-reset', '--dry-run', '--json'
    ], root).stdout);
    assert.ok(preview.uncommittedDiscardPaths.some((entry) =>
      entry.includes('singularity/hidden.txt') && entry.includes(indexFlag.slice(2))));
    const refused = command(process.execPath, [
      cli, 'factory-reset', '--confirm', preview.confirmation,
      '--expect-scope-sha256', preview.resetScopeSha256, '--json'
    ], root, { ok: false });
    assert.match(refused.stderr, /would discard uncommitted changes/);
    assert.equal(await readFile(hidden, 'utf8'), `private bytes hidden by ${indexFlag}\n`);
  }
});

test('factory-reset preview escapes terminal-control filenames', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-control-name-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  await mkdir(path.join(root, 'singularity'), { recursive: true });
  await writeFile(path.join(root, 'singularity', 'danger-\u001b[31m.txt'), 'private\n');
  await writeFile(path.join(root, 'singularity', 'looks-safe-\u202egnp.txt'), 'private\n');

  const preview = command(process.execPath, [cli, 'factory-reset', '--dry-run'], root);
  assert.doesNotMatch(preview.stdout, /\u001b/);
  assert.doesNotMatch(preview.stdout, /\u202e/);
  assert.match(preview.stdout, /\\u001b\[31m/);
  assert.match(preview.stdout, /\\u202e/);
});

test('factory reset supports detached HEAD and preserves the exact revision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-detached-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const revision = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '--detach', revision);
  await mkdir(path.join(root, '.sdlc'), { recursive: true });
  await writeFile(path.join(root, '.sdlc', 'config.json'), '{}\n');

  const preview = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], root).stdout);
  assert.equal(preview.branch, null);
  assert.equal(preview.head, revision);
  command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--allow-dirty', '--json'
  ], root);
  assert.equal(git(root, 'rev-parse', 'HEAD'), revision);
  assert.equal(git(root, 'branch', '--show-current'), '');
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'source remains\n');
});

test('factory reset supports an unborn repository without changing Git identity', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-unborn-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  await writeFile(path.join(root, 'app.txt'), 'untracked application source remains\n');
  await mkdir(path.join(root, '.sdlc'), { recursive: true });
  await writeFile(path.join(root, '.sdlc', 'config.json'), '{}\n');

  const preview = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], root).stdout);
  assert.equal(preview.branch, 'main');
  assert.equal(preview.head, null);
  assert.equal(preview.confirmation, `RESET ${path.basename(root)} unborn`);
  command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--allow-dirty', '--json'
  ], root);
  assert.equal(command('git', ['rev-parse', '--verify', 'HEAD'], root, { ok: false }).status, 128);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'untracked application source remains\n');
  assert.equal(await missing(path.join(root, '.sdlc')), true);
});

test('completed reset reports staging cleanup residue without becoming a false failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-cleanup-warning-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  await mkdir(path.join(root, '.sdlc'), { recursive: true });
  await writeFile(path.join(root, '.sdlc', 'config.json'), '{}\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const preview = await factoryResetPlan(root);
  const result = await factoryResetRepository(root, {
    confirmation: preview.confirmation,
    expectedScopeSha256: preview.resetScopeSha256,
    allowDirty: true,
    fault: (stage) => {
      if (stage === 'before-staging-cleanup') throw new Error('simulated Windows file lock');
      if (stage === 'barrier:before-release') throw new Error('simulated barrier file lock');
    }
  });
  assert.equal(result.completed, true);
  assert.ok(result.warnings?.some((warning) => /staging cleanup is still pending/.test(warning)));
  assert.ok(result.warnings?.some((warning) => /barrier could not be cleared/.test(warning)));
  assert.equal(await missing(result.cleanupPendingPath), false);
  assert.equal(await missing(result.barrierPendingPath), false);
  assert.equal(await missing(path.join(root, '.sdlc')), true);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'source remains\n');
});

test('factory reset refuses symbolic-link control roots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-link-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-outside-'));
  command('ln', ['-s', outside, path.join(root, 'singularity')], root);

  const result = command(process.execPath, [cli, 'factory-reset', '--dry-run'], root, { ok: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not be a symbolic link/);
});

test('factory reset refuses a symbolic-link former .sdlc root', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-sdlc-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-sdlc-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })
  ]));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  await symlink(outside, path.join(root, '.sdlc'));

  const result = command(process.execPath, [cli, 'factory-reset', '--dry-run'], root, { ok: false });
  assert.match(result.stderr, /Former SDLC control root must not be a symbolic link/);
});

test('factory reset refuses symbolic-link parents for bundled agent targets', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-agent-link-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-agent-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })
  ]));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  await symlink(outside, path.join(root, '.github'));

  const result = command(process.execPath, [cli, 'factory-reset', '--dry-run'], root, { ok: false });
  assert.match(result.stderr, /Bundled agent target must not contain a symbolic-link directory/);
  assert.equal(await missing(path.join(outside, 'agents')), true,
    'the external target was neither followed nor changed');

  await rm(path.join(root, '.github'));
  await mkdir(path.join(root, '.github'));
  await symlink(outside, path.join(root, '.github', 'agents'));
  const nested = command(process.execPath, [cli, 'factory-reset', '--dry-run'], root, { ok: false });
  assert.match(nested.stderr, /Bundled agent target must not contain a symbolic-link directory/);
  assert.equal(await missing(path.join(outside, 'qa.agent.md')), true);
});

test('ignored packaged-agent customizations require explicit discard consent', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-ignored-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  await writeFile(path.join(root, '.gitignore'), '.github/agents/\n');
  git(root, 'add', 'app.txt', '.gitignore');
  git(root, 'commit', '-m', 'initial');
  const target = path.join(root, '.github', 'agents', 'qa.agent.md');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'private ignored customization\n');

  const preview = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], root).stdout);
  assert.ok(preview.uncommittedDiscardPaths.some((entry) => entry.includes('.github/agents/qa.agent.md')),
    'the aggregated ignored directory is expanded to the exact customized packaged target');
  const refused = command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--json'
  ], root, { ok: false });
  assert.match(refused.stderr, /would discard uncommitted changes/);
  assert.equal(await readFile(target, 'utf8'), 'private ignored customization\n');

  command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--allow-dirty', '--json'
  ], root);
  assert.equal(await readFile(target, 'utf8'),
    await readFile(path.join(packageRoot, 'templates', 'agents', 'qa.agent.md'), 'utf8'));
});

test('hard-linked packaged agents outside the reset boundary are not mutated', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-hardlink-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const target = path.join(root, '.github', 'agents', 'qa.agent.md');
  const preserved = path.join(root, 'preserved-agent-copy.txt');
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, 'private linked bytes\n');
  await link(target, preserved);

  const preview = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], root).stdout);
  command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--allow-dirty', '--json'
  ], root);
  assert.equal(await readFile(preserved, 'utf8'), 'private linked bytes\n');
  assert.equal(await readFile(target, 'utf8'),
    await readFile(path.join(packageRoot, 'templates', 'agents', 'qa.agent.md'), 'utf8'));
});

test('a factory reset that fails before it takes a backup leaves the configuration alone', async () => {
  // The rollback flag meant "the control root existed", not "this reset moved it aside". Anything
  // thrown before the rename left it false while the directory was still in the repository, and the
  // unconditional rm in restoreDirectory then deleted a control root that had never been copied
  // anywhere. `loadDefinition` throws on an incomplete install — exactly the state somebody runs a
  // factory reset to repair — so the command people ran to fix things is the one that lost the work.
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-fault-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'application source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);

  const workflow = path.join(root, 'singularity', 'workflow.yml');
  await writeFile(workflow, `${await readFile(workflow, 'utf8')}\n# irreplaceable local customization\n`);
  // Untracked, so Git is not the recovery path for it — which is the whole point.
  const inFlight = path.join(root, 'singularity', 'work-items', 'WORK-9', 'workflow.json');
  await mkdir(path.dirname(inFlight), { recursive: true });
  await writeFile(inFlight, '{"workItem":{"id":"WORK-9"}}\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  await assert.rejects(
    () => factoryResetRepository(root, {
      confirmation: plan.confirmation,
      allowDirty: true,
      fault: (stage) => {
        if (stage === 'after-fresh-install') throw new Error('Template missing for work type');
      }
    }),
    /Template missing for work type/
  );

  assert.equal(await readFile(workflow, 'utf8').then((text) => text.includes('irreplaceable')), true,
    'the control root the reset never backed up is still there');
  assert.equal(await readFile(inFlight, 'utf8'), '{"workItem":{"id":"WORK-9"}}\n',
    'and so is the untracked work Git could not have restored');
});

test('a post-move factory-reset failure restores every former control root byte-for-byte', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-moved-fault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const roots = {
    singularity: 'current-but-damaged\n',
    '.singularity': 'legacy-one\n',
    '.sdlc': 'legacy-two\n'
  };
  for (const [directory, content] of Object.entries(roots)) {
    await mkdir(path.join(root, directory), { recursive: true });
    await writeFile(path.join(root, directory, 'identity.txt'), content);
  }

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    allowDirty: true,
    fault: (stage) => {
      if (stage === 'after-control-roots-move') throw new Error('injected post-move failure');
    }
  }), /injected post-move failure/);

  for (const [directory, content] of Object.entries(roots)) {
    assert.equal(await readFile(path.join(root, directory, 'identity.txt'), 'utf8'), content);
  }
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'source remains\n');
});

test('factory reset collision safety restores the newest .sdlc bytes written through its moved inode', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-open-handle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const legacyFile = path.join(root, '.sdlc', 'config.json');
  await mkdir(path.dirname(legacyFile), { recursive: true });
  await writeFile(legacyFile, 'reviewed legacy bytes\n');
  const legacyHandle = await open(legacyFile, 'r+');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  try {
    await assert.rejects(() => factoryResetRepository(root, {
      confirmation: plan.confirmation,
      expectedScopeSha256: plan.resetScopeSha256,
      allowDirty: true,
      fault: async (stage) => {
        if (stage === 'control-root:.sdlc:after-rename') {
          await legacyHandle.truncate(0);
          await legacyHandle.writeFile('latest editor bytes after validation\n');
          await legacyHandle.sync();
        }
      }
    }), (error) => error?.code === 'FACTORY_RESET_SCOPE_CHANGED');
  } finally {
    await legacyHandle.close();
  }

  assert.equal(await readFile(legacyFile, 'utf8'), 'latest editor bytes after validation\n',
    'rollback restores the moved inode including bytes written after final validation');
  assert.equal(await missing(path.join(root, 'singularity')), true);
});

test('factory reset collision safety retains an old .sdlc backup when the path is recreated', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-recreated-sdlc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const former = path.join(root, '.sdlc');
  await mkdir(former, { recursive: true });
  await writeFile(path.join(former, 'config.json'), 'old legacy bytes\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'after-control-roots-move') {
        await mkdir(former, { recursive: true });
        await writeFile(path.join(former, 'concurrent.json'), 'new concurrent bytes\n');
        throw new Error('injected failure after concurrent .sdlc recreation');
      }
    }
  }), (error) => {
    failure = error;
    return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
  });

  assert.equal(await readFile(path.join(former, 'concurrent.json'), 'utf8'), 'new concurrent bytes\n');
  assert.equal(await readFile(path.join(failure.details.staging, 'backup', '.sdlc', 'config.json'), 'utf8'),
    'old legacy bytes\n', 'the old version remains recoverable instead of replacing concurrent data');
});

test('factory reset collision safety preserves an edited installed control tree and its old backup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-edited-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const workflow = path.join(root, 'singularity', 'workflow.yml');
  const oldWorkflow = `${await readFile(workflow, 'utf8')}\n# old configuration marker\n`;
  await writeFile(workflow, oldWorkflow);

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'after-control-install') {
        await writeFile(workflow, 'concurrent edit to installed workflow\n');
        throw new Error('injected failure after installed control-tree edit');
      }
    }
  }), (error) => {
    failure = error;
    return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
  });

  assert.equal(await readFile(workflow, 'utf8'), 'concurrent edit to installed workflow\n');
  assert.equal(await readFile(
    path.join(failure.details.staging, 'backup', 'singularity', 'workflow.yml'), 'utf8'
  ), oldWorkflow, 'rollback retains the old control tree when it cannot own the edited replacement');
});

test('factory reset collision safety preserves an edited installed packaged agent and its old backup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-edited-agent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const qaAgent = path.join(root, '.github', 'agents', 'qa.agent.md');
  const oldAgent = 'old private packaged-agent customization\n';
  await writeFile(qaAgent, oldAgent);

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'after-packaged-agents-install') {
        await writeFile(qaAgent, 'concurrent edit to installed packaged agent\n');
        throw new Error('injected failure after installed packaged-agent edit');
      }
    }
  }), (error) => {
    failure = error;
    return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
  });

  assert.equal(await readFile(qaAgent, 'utf8'), 'concurrent edit to installed packaged agent\n');
  assert.equal(await readFile(
    path.join(failure.details.staging, 'backup', 'agents', 'qa.agent.md'), 'utf8'
  ), oldAgent, 'the customized packaged-agent backup remains recoverable');
});

test('factory reset collision safety preserves a packaged-agent inode during ordinary rollback when links work', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-agent-inode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const qaAgent = path.join(root, '.github', 'agents', 'qa.agent.md');
  const oldAgent = 'old packaged-agent inode bytes\n';
  await writeFile(qaAgent, oldAgent);
  const before = await stat(qaAgent);
  const linkProbe = path.join(root, '.github', 'agents', '.hardlink-probe');
  let hardLinksSupported = true;
  try {
    await link(qaAgent, linkProbe);
    await rm(linkProbe);
  } catch (error) {
    hardLinksSupported = false;
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EINVAL']
      .includes(error?.code)) throw error;
  }

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: (stage) => {
      if (stage === 'after-packaged-agents-install') throw new Error('injected ordinary rollback');
    }
  }), /injected ordinary rollback/);

  assert.equal(await readFile(qaAgent, 'utf8'), oldAgent);
  if (hardLinksSupported && before.ino !== 0) {
    const after = await stat(qaAgent);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino,
      'no-replace hard-link restoration retains the exact original packaged-agent inode');
  }
});

test('factory reset collision safety preserves both runtime versions when runtime is recreated', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-recreated-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const absoluteGitDirectory = await realpath(git(root, 'rev-parse', '--absolute-git-dir'));
  const runtime = path.join(absoluteGitDirectory, 'singularity-flow');
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, 'old.json'), '{"old":true}\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'after-local-runtime-move:1') {
        await mkdir(runtime, { recursive: true });
        await writeFile(path.join(runtime, 'concurrent.json'), '{"concurrent":true}\n');
        throw new Error('injected failure after runtime recreation');
      }
    }
  }), (error) => {
    failure = error;
    return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
  });

  assert.equal(await readFile(path.join(runtime, 'concurrent.json'), 'utf8'), '{"concurrent":true}\n');
  const retained = (await readdir(absoluteGitDirectory))
    .filter((entry) => entry.startsWith('.singularity-flow-factory-reset-0-'));
  assert.equal(retained.length, 1, failure.message);
  assert.equal(await readFile(path.join(absoluteGitDirectory, retained[0], 'old.json'), 'utf8'),
    '{"old":true}\n', 'the moved pre-reset runtime remains available beside the concurrent runtime');
});

test('packaged-agent installation never blesses bytes raced in before validation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-agent-install-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const agent = path.join(root, '.github', 'agents', 'architect.agent.md');
  await writeFile(agent, 'old private architect bytes\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'packaged-agent:architect.agent.md:after-install-before-validation') {
        await writeFile(agent, 'raced editor bytes\n');
      }
    }
  }), (error) => {
    failure = error;
    return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
  });
  assert.equal(await readFile(agent, 'utf8'), 'raced editor bytes\n');
  assert.equal(await readFile(
    path.join(failure.details.staging, 'backup', 'agents', 'architect.agent.md'), 'utf8'
  ), 'old private architect bytes\n');
});

test('invalid-custom recovery never blesses a target raced in before validation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-recovery-install-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const invalid = path.join(root, '.github', 'agents', 'broken.agent.md');
  const invalidBytes = Buffer.from('---\nname: Broken Agent\ndescription: [invalid\n---\nsecret\n');
  await writeFile(invalid, invalidBytes);

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  const [recovery] = plan.customAgentRecoveries;
  const target = path.join(root, ...recovery.recoveryPath.split('/'));
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === `custom-agent-recovery:${recovery.sha256.slice(7, 19)}:after-install-before-validation`) {
        await writeFile(target, 'raced recovery-target bytes\n');
      }
    }
  }), (error) => error?.code === 'FACTORY_RESET_SCOPE_CHANGED');
  assert.deepEqual(await readFile(invalid), invalidBytes,
    'the active source is restored from staging');
  assert.equal(await readFile(target, 'utf8'), 'raced recovery-target bytes\n',
    'rollback does not delete the target it never proved it owned');
});

test('a packaged-agent parent symlink swap is refused before any outside write', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-parent-swap-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-parent-swap-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })
  ]));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const github = path.join(root, '.github');
  const displaced = path.join(root, '.github-displaced');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'packaged-agent:architect.agent.md:before-rename') {
        await rename(github, displaced);
        await symlink(outside, github);
      }
    }
  }), /changed while factory reset was operating|could not be fully undone/);
  assert.equal(await missing(path.join(outside, 'agents', 'architect.agent.md')), true);
});

test('a recovered-agent parent symlink swap is refused before any outside write', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-recovery-parent-swap-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-recovery-parent-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })
  ]));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  await writeFile(path.join(root, '.github', 'agents', 'broken.agent.md'),
    '---\nname: Broken Agent\ndescription: [invalid\n---\nprivate\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  const [recovery] = plan.customAgentRecoveries;
  const github = path.join(root, '.github');
  const displaced = path.join(root, '.github-displaced');
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === `custom-agent-recovery:${recovery.sha256.slice(7, 19)}:before-install`) {
        await rename(github, displaced);
        await symlink(outside, github);
      }
    }
  }), /changed while factory reset was operating|could not be fully undone/);
  assert.equal(await missing(path.join(outside, 'singularity-flow-recovered-agents')), true);
});

test('failed rollback never prunes recovery directories through a swapped parent symlink', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-recovery-cleanup-swap-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-recovery-cleanup-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })
  ]));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  await writeFile(path.join(root, '.github', 'agents', 'broken.agent.md'),
    '---\nname: Broken Agent\ndescription: [invalid\n---\nprivate\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  const [recovery] = plan.customAgentRecoveries;
  const github = path.join(root, '.github');
  const displaced = path.join(root, '.github-displaced');
  const outsideRecoveryDirectory = path.join(
    outside, ...recovery.recoveryPath.split('/').slice(1, -1)
  );
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage !== 'after-custom-agent-recovery') return;
      await rename(github, displaced);
      await symlink(outside, github);
      await mkdir(outsideRecoveryDirectory, { recursive: true });
      throw new Error('start rollback after parent swap');
    }
  }), (error) => error?.code === 'FACTORY_RESET_ROLLBACK_FAILED');
  assert.equal(await missing(outsideRecoveryDirectory), false,
    'rollback leaves an unrelated empty directory outside the repository untouched');
});

test('rollback refuses a recreated destination without replacing its bytes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-rollback-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const former = path.join(root, '.sdlc');
  await mkdir(former);
  await writeFile(path.join(former, 'old.json'), 'old bytes\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'after-control-roots-move') throw new Error('start rollback');
      if (stage === 'rollback:.sdlc:before-restore') {
        await mkdir(former);
        await writeFile(path.join(former, 'concurrent.json'), 'concurrent bytes\n');
      }
    }
  }), (error) => {
    failure = error;
    return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
  });
  assert.equal(await readFile(path.join(former, 'concurrent.json'), 'utf8'), 'concurrent bytes\n');
  assert.equal(await readFile(
    path.join(failure.details.staging, 'backup', '.sdlc', 'old.json'), 'utf8'
  ), 'old bytes\n');
});

test('directory rollback cannot replace an empty destination raced in at publication', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-directory-publish-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const former = path.join(root, '.sdlc');
  await mkdir(former);
  await writeFile(path.join(former, 'old.json'), 'old bytes\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  let concurrentInode = null;
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'after-control-roots-move') throw new Error('start rollback');
      if (stage === 'rollback:.sdlc:before-publication') {
        await mkdir(former);
        concurrentInode = (await stat(former)).ino;
      }
    }
  }), (error) => {
    failure = error;
    return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
  });
  assert.equal((await stat(former)).ino, concurrentInode,
    'the concurrently created empty directory keeps its filesystem identity');
  assert.deepEqual(await readdir(former), []);
  assert.equal(await readFile(
    path.join(failure.details.staging, 'backup', '.sdlc', 'old.json'), 'utf8'
  ), 'old bytes\n');
});

test('packaged-agent rollback refuses a file recreated after replacement withdrawal', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-file-rollback-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const agent = path.join(root, '.github', 'agents', 'qa.agent.md');
  await writeFile(agent, 'old qa bytes\n');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  await assert.rejects(() => factoryResetRepository(root, {
    confirmation: plan.confirmation,
    expectedScopeSha256: plan.resetScopeSha256,
    allowDirty: true,
    fault: async (stage) => {
      if (stage === 'after-packaged-agents-install') throw new Error('start file rollback');
      if (stage === 'rollback:.github/agents/qa.agent.md:before-restore') {
        await writeFile(agent, 'concurrent qa bytes\n', { flag: 'wx' });
      }
    }
  }), (error) => {
    failure = error;
    return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
  });
  assert.equal(await readFile(agent, 'utf8'), 'concurrent qa bytes\n');
  assert.equal(await readFile(
    path.join(failure.details.staging, 'backup', 'agents', 'qa.agent.md'), 'utf8'
  ), 'old qa bytes\n');
});

test('hard-link and copy-fallback rollback cannot replace a file raced in at publication', async (t) => {
  for (const forceCopyRestore of [false, true]) {
    const root = await mkdtemp(path.join(os.tmpdir(),
      `sflow-factory-reset-file-publish-${forceCopyRestore ? 'copy' : 'link'}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'Factory Reset Tester');
    git(root, 'config', 'user.email', 'factory-reset@example.com');
    await writeFile(path.join(root, 'app.txt'), 'source\n');
    git(root, 'add', 'app.txt');
    git(root, 'commit', '-m', 'initial');
    command(process.execPath, [cli, 'init'], root);
    const agent = path.join(root, '.github', 'agents', 'qa.agent.md');
    await writeFile(agent, 'old qa bytes\n');

    const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
    const plan = await factoryResetPlan(root);
    let failure;
    await assert.rejects(() => factoryResetRepository(root, {
      confirmation: plan.confirmation,
      expectedScopeSha256: plan.resetScopeSha256,
      allowDirty: true,
      forceCopyRestore,
      fault: async (stage) => {
        if (stage === 'after-packaged-agents-install') throw new Error('start file rollback');
        if (stage === 'rollback:.github/agents/qa.agent.md:before-publication') {
          await writeFile(agent, `concurrent ${forceCopyRestore ? 'copy' : 'link'} bytes\n`, {
            flag: 'wx'
          });
        }
      }
    }), (error) => {
      failure = error;
      return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
    });
    assert.equal(await readFile(agent, 'utf8'),
      `concurrent ${forceCopyRestore ? 'copy' : 'link'} bytes\n`);
    assert.equal(await readFile(
      path.join(failure.details.staging, 'backup', 'agents', 'qa.agent.md'), 'utf8'
    ), 'old qa bytes\n');
  }
});

test('late writes through a staged control inode stop cleanup and retain staging', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-late-staging-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const legacyFile = path.join(root, '.sdlc', 'old.json');
  await mkdir(path.dirname(legacyFile));
  await writeFile(legacyFile, 'old bytes\n');
  const handle = await open(legacyFile, 'r+');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  try {
    await assert.rejects(() => factoryResetRepository(root, {
      confirmation: plan.confirmation,
      expectedScopeSha256: plan.resetScopeSha256,
      allowDirty: true,
      fault: async (stage) => {
        if (stage === 'before-staging-cleanup') {
          await handle.truncate(0);
          await handle.writeFile('late bytes after final verification\n');
          await handle.sync();
        }
      }
    }), (error) => {
      failure = error;
      return error?.code === 'FACTORY_RESET_SCOPE_CHANGED';
    });
  } finally {
    await handle.close();
  }
  assert.equal(await readFile(
    path.join(failure.details.staging, 'backup', '.sdlc', 'old.json'), 'utf8'
  ), 'late bytes after final verification\n');
});

test('late writes through a staged runtime inode stop cleanup and retain its backup', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-late-runtime-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const gitDirectory = await realpath(git(root, 'rev-parse', '--absolute-git-dir'));
  const runtimeFile = path.join(gitDirectory, 'singularity-flow', 'session.json');
  await mkdir(path.dirname(runtimeFile), { recursive: true });
  await writeFile(runtimeFile, 'old runtime bytes\n');
  const handle = await open(runtimeFile, 'r+');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  try {
    await assert.rejects(() => factoryResetRepository(root, {
      confirmation: plan.confirmation,
      expectedScopeSha256: plan.resetScopeSha256,
      allowDirty: true,
      fault: async (stage) => {
        if (stage === 'before-runtime-backup-cleanup:1') {
          await handle.truncate(0);
          await handle.writeFile('late runtime bytes\n');
          await handle.sync();
        }
      }
    }), (error) => {
      failure = error;
      return error?.code === 'FACTORY_RESET_SCOPE_CHANGED';
    });
  } finally {
    await handle.close();
  }
  assert.equal(await readFile(path.join(failure.details.backup, 'session.json'), 'utf8'),
    'late runtime bytes\n');
  assert.equal(await missing(failure.details.staging), false,
    'the worktree staging directory is retained with the collision receipt');
});

test('copy-fallback rollback retains a backup changed through an open handle', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-copy-rollback-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  const agent = path.join(root, '.github', 'agents', 'qa.agent.md');
  await writeFile(agent, 'old qa bytes\n');
  const handle = await open(agent, 'r+');

  const { factoryResetPlan, factoryResetRepository } = await import('../src/factory-reset.mjs');
  const plan = await factoryResetPlan(root);
  let failure;
  try {
    await assert.rejects(() => factoryResetRepository(root, {
      confirmation: plan.confirmation,
      expectedScopeSha256: plan.resetScopeSha256,
      allowDirty: true,
      forceCopyRestore: true,
      fault: async (stage) => {
        if (stage === 'after-packaged-agents-install') throw new Error('start copy rollback');
        if (stage === 'rollback:.github/agents/qa.agent.md:before-backup-cleanup') {
          await handle.truncate(0);
          await handle.writeFile('late qa bytes\n');
          await handle.sync();
        }
      }
    }), (error) => {
      failure = error;
      return error?.code === 'FACTORY_RESET_ROLLBACK_FAILED';
    });
  } finally {
    await handle.close();
  }
  assert.equal(await readFile(agent, 'utf8'), 'old qa bytes\n',
    'the exclusive copy is not overwritten by late staged bytes');
  assert.match(failure.message, /retained the staged copy|changed before cleanup/);
  assert.equal(await readFile(
    path.join(failure.details.staging, 'backup', 'agents', 'qa.agent.md'), 'utf8'
  ), 'late qa bytes\n');
});

test('factory reset discloses and clears both private and shared runtime in a linked worktree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-common-runtime-'));
  const linked = path.join(path.dirname(root), `${path.basename(root)}-linked`);
  t.after(() => Promise.all([
    rm(linked, { recursive: true, force: true }), rm(root, { recursive: true, force: true })
  ]));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  git(root, 'worktree', 'add', '-b', 'legacy-fix', linked);
  await mkdir(path.join(linked, '.sdlc'), { recursive: true });
  await writeFile(path.join(linked, '.sdlc', 'config.json'), '{"version":1}\n');

  const privateRuntime = path.join(await realpath(git(linked, 'rev-parse', '--absolute-git-dir')), 'singularity-flow');
  const commonGitDirectory = await realpath(path.resolve(
    linked, git(linked, 'rev-parse', '--git-common-dir')
  ));
  const commonRuntime = path.join(commonGitDirectory, 'singularity-flow');
  assert.notEqual(privateRuntime, commonRuntime);
  for (const runtime of [privateRuntime, commonRuntime]) {
    await mkdir(runtime, { recursive: true });
    await writeFile(path.join(runtime, 'local.json'), '{}\n');
  }

  let preview = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], linked).stdout);
  assert.deepEqual(new Set(preview.localRuntimeRoots), new Set([privateRuntime, commonRuntime]));
  assert.ok(preview.remove.some((entry) => entry.includes('repository-shared runtime for all linked worktrees')));
  const { factoryResetRepository } = await import('../src/factory-reset.mjs');
  const {
    acquireSubjectLock, releaseSubjectLock, withRepositoryResetBarrier
  } = await import('../src/subject-lock.mjs');
  const subject = { kind: 'story', id: 'LIVE-WRITER' };
  const owner = await acquireSubjectLock(root, subject);
  await assert.rejects(() => factoryResetRepository(linked, {
    confirmation: preview.confirmation,
    allowDirty: true
  }), /requires a quiescent repository/);
  assert.equal(await readFile(path.join(linked, '.sdlc', 'config.json'), 'utf8'), '{"version":1}\n');
  assert.equal(await releaseSubjectLock(root, subject, owner), true);
  await withRepositoryResetBarrier(root, async () => {
    await assert.rejects(() => acquireSubjectLock(linked, { kind: 'story', id: 'NEW-WRITER' }),
      (error) => error?.code === 'FACTORY_RESET_IN_PROGRESS');
  });
  await assert.rejects(() => factoryResetRepository(linked, {
    confirmation: preview.confirmation,
    allowDirty: true,
    fault: (stage) => {
      if (stage === 'after-local-runtime-move:1') throw new Error('injected runtime cleanup failure');
    }
  }), /injected runtime cleanup failure/);
  for (const runtime of [privateRuntime, commonRuntime]) {
    assert.equal(await readFile(path.join(runtime, 'local.json'), 'utf8'), '{}\n',
      'a failure after the first move restores every runtime root');
  }
  preview = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], linked).stdout);
  command(process.execPath, [
    cli, 'factory-reset', '--confirm', preview.confirmation,
    '--expect-scope-sha256', preview.resetScopeSha256, '--allow-dirty', '--json'
  ], linked);
  assert.equal(await missing(privateRuntime), true);
  assert.equal(await missing(commonRuntime), true);
  assert.equal(await readFile(path.join(linked, 'app.txt'), 'utf8'), 'source remains\n');
});

test('a factory reset refuses to discard uncommitted reset-scope changes by default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-factory-reset-dirty-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  git(root, 'add', 'singularity');
  git(root, 'commit', '-m', 'govern');

  const plan = JSON.parse(command(process.execPath, [cli, 'factory-reset', '--dry-run', '--json'], root).stdout);
  // A freshly initialised repository has .github/agents untracked, holding exactly the packaged
  // content the reset is about to write. Reported, but not a reason to refuse.
  assert.deepEqual(plan.uncommittedResetPaths.filter((entry) => entry.includes('singularity')), []);
  command(process.execPath, [
    cli, 'factory-reset', '--confirm', plan.confirmation,
    '--expect-scope-sha256', plan.resetScopeSha256, '--json'
  ], root);

  await writeFile(path.join(root, 'singularity', 'workflow.yml'),
    `${await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8')}\n# unsaved\n`);
  const dirtyPlan = JSON.parse(command(process.execPath, [
    cli, 'factory-reset', '--dry-run', '--json'
  ], root).stdout);
  const refused = command(process.execPath, [
    cli, 'factory-reset', '--confirm', dirtyPlan.confirmation,
    '--expect-scope-sha256', dirtyPlan.resetScopeSha256
  ], root, { ok: false });
  assert.match(refused.stderr, /would discard uncommitted changes that Git cannot recover/);
  assert.match(refused.stderr, /singularity\/workflow\.yml/);
  // And it really did refuse rather than warning after the fact.
  assert.equal(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8').then((t) => t.includes('# unsaved')), true);
});

test('reset all replaces repository controls and clears machine registrations without deleting clones', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-repository-'));
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-machine-'));
  const clone = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-clone-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'application source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  await writeFile(path.join(root, 'singularity', 'workflow.yml'), 'version: 1\n');
  await writeFile(path.join(machine, 'workspaces.json'), `${JSON.stringify({ workspaces: [{ path: clone }] })}\n`);
  await writeFile(path.join(clone, 'source.txt'), 'workspace source remains\n');

  const { factoryResetAll, factoryResetAllPlan } = await import('../src/factory-reset.mjs');
  const preview = await factoryResetAllPlan(root, { localStateRoot: machine });
  assert.equal(preview.operation, 'factory-reset-all');
  assert.equal(preview.confirmation, 'RESET ALL');
  await assert.rejects(() => factoryResetAll(root, {
    confirmation: 'WRONG', localStateRoot: machine
  }), /requires --yes/);

  const result = await factoryResetAll(root, {
    confirmation: 'RESET ALL', localStateRoot: machine
  });
  assert.equal(result.completed, true);
  assert.equal(await missing(machine), true, 'machine registry and active selection root are cleared');
  assert.equal(await readFile(path.join(clone, 'source.txt'), 'utf8'), 'workspace source remains\n');
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'application source remains\n');
  assert.equal(await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8'),
    await readFile(path.join(packageRoot, 'templates', 'workflow.yml'), 'utf8'));
});

test('reset all restores machine registrations when repository replacement fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-fault-repository-'));
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-fault-machine-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  command(process.execPath, [cli, 'init'], root);
  await writeFile(path.join(machine, 'active-workspace.json'), '{"workspaceId":"important"}\n');

  const { factoryResetAll } = await import('../src/factory-reset.mjs');
  await assert.rejects(() => factoryResetAll(root, {
    confirmation: 'RESET ALL',
    localStateRoot: machine,
    fault: (stage) => {
      if (stage === 'repository:after-fresh-install') throw new Error('injected replacement failure');
    }
  }), /injected replacement failure/);
  assert.equal(await readFile(path.join(machine, 'active-workspace.json'), 'utf8'),
    '{"workspaceId":"important"}\n');
});

test('reset all restores an already-staged journal when machine-state staging fails partway', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-partial-machine-stage-'));
  const root = path.join(base, 'repository');
  const machine = path.join(base, 'machine');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  await mkdir(machine);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const journal = path.join(machine, 'local-journal.jsonl');
  await writeFile(journal, '{"important":"receipt"}\n');
  await writeFile(path.join(machine, 'z-other.json'), '{"other":true}\n');

  const { factoryResetAll } = await import('../src/factory-reset.mjs');
  await assert.rejects(() => factoryResetAll(root, {
    confirmation: 'RESET ALL',
    localStateRoot: machine,
    fault: (stage) => {
      if (stage === 'machine-state:local-journal.jsonl:after-rename') {
        throw new Error('injected machine-state staging failure');
      }
    }
  }), /injected machine-state staging failure/);
  assert.equal(await readFile(journal, 'utf8'), '{"important":"receipt"}\n',
    'the caller knows about a move even when staging throws after rename');
  assert.equal(await readFile(path.join(machine, 'z-other.json'), 'utf8'), '{"other":true}\n');
  const residue = (await readdir(base)).filter((entry) => entry.startsWith('.sflow-reset-all-'));
  assert.deepEqual(residue, [], 'successful rollback removes only the now-redundant staging area');
});

test('reset-all rollback preserves a machine-state file raced in at publication', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-machine-rollback-race-'));
  const root = path.join(base, 'repository');
  const machine = path.join(base, 'machine');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  await mkdir(machine);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const journal = path.join(machine, 'local-journal.jsonl');
  await writeFile(journal, 'old journal bytes\n');

  const { factoryResetAll } = await import('../src/factory-reset.mjs');
  let failure;
  await assert.rejects(() => factoryResetAll(root, {
    confirmation: 'RESET ALL',
    localStateRoot: machine,
    fault: async (stage) => {
      if (stage === 'repository:after-fresh-install') throw new Error('start repository rollback');
      if (stage === 'rollback:machine-state:local-journal.jsonl:before-publication') {
        await writeFile(journal, 'concurrent journal bytes\n', { flag: 'wx' });
      }
    }
  }), (error) => {
    failure = error;
    return error?.code === 'RESET_ALL_MACHINE_RESTORE_FAILED';
  });
  assert.equal(await readFile(journal, 'utf8'), 'concurrent journal bytes\n');
  assert.equal(await readFile(path.join(failure.details.machineBackup, 'local-journal.jsonl'), 'utf8'),
    'old journal bytes\n');
});

test('reset-all rollback restores machine directories and symbolic links without following them', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-machine-kinds-'));
  const root = path.join(base, 'repository');
  const machine = path.join(base, 'machine');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  await mkdir(path.join(machine, 'cache'), { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  await writeFile(path.join(machine, 'cache', 'entry.json'), '{"cached":true}\n');
  await writeFile(path.join(base, 'outside.txt'), 'outside remains\n');
  try {
    await symlink('../outside.txt', path.join(machine, 'external-link'));
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('symbolic-link creation is not permitted on this host');
      return;
    }
    throw error;
  }

  const { factoryResetAll } = await import('../src/factory-reset.mjs');
  await assert.rejects(() => factoryResetAll(root, {
    confirmation: 'RESET ALL',
    localStateRoot: machine,
    fault: (stage) => {
      if (stage === 'repository:after-fresh-install') throw new Error('restore machine kinds');
    }
  }), /restore machine kinds/);
  assert.equal(await readFile(path.join(machine, 'cache', 'entry.json'), 'utf8'), '{"cached":true}\n');
  assert.equal(await readlink(path.join(machine, 'external-link')), '../outside.txt');
  assert.equal(await readFile(path.join(base, 'outside.txt'), 'utf8'), 'outside remains\n');
});

test('reset all retains machine staging when an open handle writes after final verification', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-machine-late-write-'));
  const root = path.join(base, 'repository');
  const machine = path.join(base, 'machine');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  await mkdir(machine);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  const journal = path.join(machine, 'local-journal.jsonl');
  await writeFile(journal, 'old journal bytes\n');
  const handle = await open(journal, 'r+');

  const { factoryResetAll } = await import('../src/factory-reset.mjs');
  let failure;
  try {
    await assert.rejects(() => factoryResetAll(root, {
      confirmation: 'RESET ALL',
      localStateRoot: machine,
      fault: async (stage) => {
        if (stage !== 'before-machine-state-staging-cleanup') return;
        await handle.truncate(0);
        await handle.writeFile('late machine-state bytes\n');
        await handle.sync();
      }
    }), (error) => {
      failure = error;
      return error?.code === 'RESET_ALL_MACHINE_CLEANUP_COLLISION';
    });
  } finally {
    await handle.close();
  }
  assert.equal(await readFile(path.join(failure.details.machineBackup, 'local-journal.jsonl'), 'utf8'),
    'late machine-state bytes\n');
  assert.equal(await missing(failure.details.staging), false);
  assert.equal(await missing(path.join(root, 'singularity', 'workflow.yml')), false,
    'the already-completed repository reinitialization remains installed');
});

test('reset all preserves repository cleanup and barrier recovery diagnostics', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-repository-warning-'));
  const root = path.join(base, 'repository');
  const machine = path.join(base, 'machine');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  await mkdir(machine);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  await writeFile(path.join(machine, 'workspaces.json'), '{"workspaces":[]}\n');

  const { factoryResetAll } = await import('../src/factory-reset.mjs');
  const result = await factoryResetAll(root, {
    confirmation: 'RESET ALL',
    localStateRoot: machine,
    fault: (stage) => {
      if (stage === 'repository:before-staging-cleanup') {
        throw new Error('simulated repository staging lock');
      }
      if (stage === 'repository:barrier:before-release') {
        throw new Error('simulated repository barrier lock');
      }
    }
  });

  assert.equal(result.completed, true);
  assert.ok(result.cleanupPendingPath);
  assert.ok(result.barrierPendingPath);
  assert.equal(await missing(result.cleanupPendingPath), false);
  assert.equal(await missing(result.barrierPendingPath), false);
  assert.ok(result.warnings?.some((warning) => /staging cleanup is still pending/.test(warning)));
  assert.ok(result.warnings?.some((warning) => /barrier could not be cleared/.test(warning)));
});

test('reset all reports post-commit machine cleanup residue without rolling either state back', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-machine-warning-'));
  const root = path.join(base, 'repository');
  const machine = path.join(base, 'machine');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  await mkdir(machine);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source remains\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  await writeFile(path.join(machine, 'active-workspace.json'), '{"workspaceId":"old"}\n');

  const { factoryResetAll } = await import('../src/factory-reset.mjs');
  const result = await factoryResetAll(root, {
    confirmation: 'RESET ALL',
    localStateRoot: machine,
    fault: (stage) => {
      if (stage === 'before-machine-state-staging-cleanup') {
        throw new Error('simulated machine backup lock');
      }
    }
  });

  assert.equal(result.completed, true);
  assert.ok(result.machineStateCleanupPendingPath);
  assert.equal(await missing(result.machineStateCleanupPendingPath), false);
  assert.ok(result.warnings?.some((warning) => /machine-state cleanup is still pending/.test(warning)));
  assert.equal(await missing(path.join(root, 'singularity', 'workflow.yml')), false,
    'the successful repository replacement remains installed');
  assert.equal(await missing(machine), true,
    'the old machine registry is not restored merely because backup cleanup failed');
});

test('reset all holds registry writers through a failed repository reset and restores before release', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-all-registry-barrier-'));
  const root = path.join(base, 'repository');
  const machine = path.join(base, 'machine');
  const registry = path.join(machine, 'workspaces.json');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(root);
  await mkdir(machine);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Factory Reset Tester');
  git(root, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(root, 'app.txt'), 'source\n');
  git(root, 'add', 'app.txt');
  git(root, 'commit', '-m', 'initial');
  await writeFile(registry, 'old registry bytes\n');

  const { factoryResetAll } = await import('../src/factory-reset.mjs');
  const { withRegistryFileLease } = await import('../src/workspace.mjs');
  let competingMutation = null;
  let competingEntered = false;
  let bytesSeenAfterBarrier = null;
  await assert.rejects(() => factoryResetAll(root, {
    confirmation: 'RESET ALL',
    localStateRoot: machine,
    fault: async (stage) => {
      if (stage === 'after-machine-state-move') {
        competingMutation = withRegistryFileLease(registry, async () => {
          competingEntered = true;
          bytesSeenAfterBarrier = await readFile(registry, 'utf8');
          await writeFile(registry, 'new registry bytes\n');
        }, { timeoutMs: 5_000 });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(competingEntered, false, 'the registry writer remains behind reset-all');
      }
      if (stage === 'repository:after-fresh-install') {
        throw new Error('injected repository failure');
      }
    }
  }), /injected repository failure/);

  await competingMutation;
  assert.equal(bytesSeenAfterBarrier, 'old registry bytes\n',
    'rollback restores the old registry before releasing the writer');
  assert.equal(await readFile(registry, 'utf8'), 'new registry bytes\n',
    'the concurrent post-rollback update is not deleted as rollback collateral');
});

test('local reset keeps registry lock pathnames live and restores bytes before releasing a writer', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-reset-registry-barrier-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  const machine = path.join(home, '.singularity-flow');
  const registry = path.join(machine, 'workspaces.json');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(machine, { recursive: true });
  await mkdir(project);
  await writeFile(registry, '{"schemaVersion":1,"workspaces":[]}\n');

  const { localReset } = await import('../src/fresh-install-reset.mjs');
  const { withRegistryFileLease } = await import('../src/workspace.mjs');
  let competingMutation = null;
  let competingEntered = false;
  let bytesSeenAfterBarrier = null;
  await assert.rejects(() => localReset({
    homeDirectory: home,
    projectDirectory: project,
    environment: {},
    forgetOnly: true,
    confirmation: 'FORGET LOCAL',
    fault: async (stage) => {
      if (stage !== 'after-move:Singularity Flow machine state') return;
      assert.equal(await missing(`${registry}.lock`), false,
        'the ordinary registry lease stays at its live pathname while state is staged');
      competingMutation = withRegistryFileLease(registry, async () => {
        competingEntered = true;
        bytesSeenAfterBarrier = await readFile(registry, 'utf8');
        await writeFile(registry, '{"schemaVersion":1,"workspaces":[{"id":"new"}]}\n');
      }, { timeoutMs: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(competingEntered, false, 'the registry writer remains behind local reset');
      throw new Error('injected local reset failure');
    }
  }), /injected local reset failure/);

  await competingMutation;
  assert.equal(bytesSeenAfterBarrier, '{"schemaVersion":1,"workspaces":[]}\n',
    'rollback restores the old bytes before releasing the registry writer');
  assert.match(await readFile(registry, 'utf8'), /"id":"new"/,
    'the post-rollback writer update survives');
});

test('fresh-install and reset-all share one destructive machine-state barrier', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-shared-machine-reset-barrier-'));
  const home = path.join(base, 'home');
  const checkout = path.join(base, 'checkout');
  const repository = path.join(base, 'repository');
  const machine = path.join(home, '.singularity-flow');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(machine, { recursive: true });
  await mkdir(checkout);
  await mkdir(repository);
  await writeFile(path.join(machine, 'workspaces.json'), '{"schemaVersion":1,"workspaces":[]}\n');
  git(repository, 'init', '-b', 'main');
  git(repository, 'config', 'user.name', 'Factory Reset Tester');
  git(repository, 'config', 'user.email', 'factory-reset@example.com');
  await writeFile(path.join(repository, 'app.txt'), 'source remains\n');
  git(repository, 'add', 'app.txt');
  git(repository, 'commit', '-m', 'initial');

  const { freshInstallReset } = await import('../src/fresh-install-reset.mjs');
  const { factoryResetAll } = await import('../src/factory-reset.mjs');
  let releaseFresh;
  const freshMayFinish = new Promise((resolve) => { releaseFresh = resolve; });
  let freshStaged;
  const freshIsStaged = new Promise((resolve) => { freshStaged = resolve; });
  let resetAllEntered = false;
  const first = freshInstallReset({
    homeDirectory: home,
    projectDirectory: checkout,
    environment: {},
    confirmation: 'RESET EVERYTHING',
    fault: async (stage) => {
      if (stage !== 'after-move:Singularity Flow machine state') return;
      freshStaged();
      await freshMayFinish;
    }
  });
  await freshIsStaged;
  const second = factoryResetAll(repository, {
    confirmation: 'RESET ALL',
    localStateRoot: machine,
    fault: (stage) => {
      if (stage === 'after-machine-state-move') resetAllEntered = true;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(resetAllEntered, false,
    'reset-all cannot enter its destructive section while fresh-install owns the shared barrier');

  releaseFresh();
  await first;
  await second;
  assert.equal(resetAllEntered, true);
  assert.equal(await readFile(path.join(repository, 'app.txt'), 'utf8'), 'source remains\n');
  assert.equal(await missing(machine), true, 'the final reset leaves no stale machine-state directory');
});

test('fresh install reset deletes every proven registered workspace and only managed Copilot state', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-home-'));
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-checkout-'));
  const baseDirectory = path.join(home, 'workspaces');
  const { createWorkspaceConfiguration } = await import('../src/workspace.mjs');
  const created = await createWorkspaceConfiguration({
    baseDirectory,
    id: 'fresh-reset-demo',
    name: 'Fresh reset demo',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: 'https://example.invalid/platform.git',
        defaultBranch: 'main',
        required: true,
        metadata: { appId: 'APP-RESET', name: 'Reset platform' }
      }
    }
  }, { confirmation: 'fresh-reset-demo', clone: false });
  await writeFile(path.join(created.workspace.path, 'documents', 'proof.txt'), 'delete me\n');
  const machine = path.join(home, '.singularity-flow');
  await mkdir(machine, { recursive: true });
  await writeFile(path.join(machine, 'workspaces.json'), `${JSON.stringify({
    schemaVersion: 1,
    workspaces: [{
      id: created.workspace.id, path: created.workspace.path, name: created.workspace.name,
      openedAt: new Date().toISOString()
    }]
  })}\n`);
  await writeFile(path.join(machine, 'active-workspace.json'), '{}\n');
  const sessionRoot = path.join(home, '.copilot', 'session-state');
  await mkdir(path.join(sessionRoot, 'singularity-demo'), { recursive: true });
  await mkdir(path.join(sessionRoot, 'unrelated-session'), { recursive: true });
  const skills = path.join(home, '.copilot', 'skills');
  await mkdir(path.join(skills, 'sf-managed'), { recursive: true });
  await writeFile(path.join(skills, 'sf-managed', 'SKILL.md'), '<!-- managed-by: singularity-flow direct-skill-alias -->\n');
  await mkdir(path.join(skills, 'sf-personal'), { recursive: true });
  await writeFile(path.join(skills, 'sf-personal', 'SKILL.md'), 'personal\n');

  const { freshInstallReset, freshInstallResetPlan } = await import('../src/fresh-install-reset.mjs');
  const preview = await freshInstallResetPlan({ homeDirectory: home, projectDirectory: checkout, environment: {} });
  assert.equal(preview.operation, 'fresh-install-reset');
  assert.deepEqual(preview.workspaces.map((item) => item.path), [created.workspace.path]);
  await assert.rejects(() => freshInstallReset({
    homeDirectory: home, projectDirectory: checkout, environment: {}, confirmation: 'WRONG'
  }), /RESET EVERYTHING/);
  const result = await freshInstallReset({
    homeDirectory: home, projectDirectory: checkout, environment: {}, confirmation: 'RESET EVERYTHING'
  });
  assert.equal(result.completed, true);
  assert.equal(await missing(created.workspace.path), true);
  assert.equal(await missing(path.join(machine, 'workspaces.json')), true);
  assert.equal(await missing(path.join(machine, 'active-workspace.json')), true);
  assert.equal(await missing(path.join(machine, 'vscode-fresh-reset-pending.json')), false);
  assert.equal(await missing(path.join(sessionRoot, 'singularity-demo')), true);
  assert.equal(await missing(path.join(sessionRoot, 'unrelated-session')), false);
  assert.equal(await missing(path.join(skills, 'sf-managed')), true);
  assert.equal(await readFile(path.join(skills, 'sf-personal', 'SKILL.md'), 'utf8'), 'personal\n');
});

test('local reset deletes validated workspaces and local state but preserves the installed skills and checkout', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-reset-home-'));
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-reset-checkout-'));
  const unregistered = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-reset-unregistered-'));
  await writeFile(path.join(checkout, 'product.txt'), 'installed product remains\n');
  await writeFile(path.join(unregistered, 'source.txt'), 'unregistered source remains\n');
  const { createWorkspaceConfiguration } = await import('../src/workspace.mjs');
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(home, 'workspaces'),
    id: 'local-reset-demo',
    name: 'Local reset demo',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: 'https://example.invalid/platform.git',
        defaultBranch: 'main',
        required: true,
        metadata: { appId: 'APP-LOCAL-RESET', name: 'Local reset platform' }
      }
    }
  }, { confirmation: 'local-reset-demo', clone: false });
  await writeFile(path.join(created.workspace.path, 'documents', 'proof.txt'), 'delete workspace bytes\n');

  const machine = path.join(home, '.singularity-flow');
  await mkdir(machine, { recursive: true });
  await writeFile(path.join(machine, 'workspaces.json'), `${JSON.stringify({
    schemaVersion: 1,
    workspaces: [{
      id: created.workspace.id,
      path: created.workspace.path,
      name: created.workspace.name,
      openedAt: new Date().toISOString()
    }]
  })}\n`);
  await writeFile(path.join(machine, 'active-workspace.json'), '{}\n');
  const sessionRoot = path.join(home, '.copilot', 'session-state');
  await mkdir(path.join(sessionRoot, 'singularity-local-reset'), { recursive: true });
  await mkdir(path.join(sessionRoot, 'unrelated-session'), { recursive: true });
  const skillsRoot = path.join(home, '.copilot', 'skills');
  await mkdir(path.join(skillsRoot, 'sf-managed'), { recursive: true });
  await writeFile(path.join(skillsRoot, 'sf-managed', 'SKILL.md'), '<!-- managed-by: singularity-flow direct-skill-alias -->\n');

  const { localReset, localResetPlan } = await import('../src/fresh-install-reset.mjs');
  const preview = await localResetPlan({ homeDirectory: home, projectDirectory: checkout, environment: {} });
  assert.equal(preview.schemaVersion, 2);
  assert.equal(preview.operation, 'local-reset');
  assert.equal(preview.mode, 'delete-workspaces');
  assert.equal(preview.confirmation, 'RESET LOCAL');
  assert.deepEqual(preview.workspaces.map((item) => item.path), [created.workspace.path]);
  assert.deepEqual(preview.workspaces.map((item) => item.disposition), ['deleted']);
  assert.deepEqual(preview.installerGeneratedPaths, []);
  assert.equal(preview.removeDirectSkills, false);
  assert.match(preview.preserve.join('\n'), /installed CLI, VS Code extension, Copilot plugin/);

  await assert.rejects(() => localReset({
    homeDirectory: home, projectDirectory: checkout, environment: {}, confirmation: 'WRONG'
  }), /Local reset requires exact confirmation 'RESET LOCAL'/);
  const result = await localReset({
    homeDirectory: home, projectDirectory: checkout, environment: {}, confirmation: 'RESET LOCAL'
  });
  assert.equal(result.completed, true);
  assert.equal(await missing(created.workspace.path), true);
  assert.equal(await missing(path.join(sessionRoot, 'singularity-local-reset')), true);
  assert.equal(await missing(path.join(sessionRoot, 'unrelated-session')), false);
  assert.equal(await readFile(path.join(skillsRoot, 'sf-managed', 'SKILL.md'), 'utf8'),
    '<!-- managed-by: singularity-flow direct-skill-alias -->\n');
  assert.equal(await readFile(path.join(checkout, 'product.txt'), 'utf8'), 'installed product remains\n');
  assert.equal(await readFile(path.join(unregistered, 'source.txt'), 'utf8'), 'unregistered source remains\n');
  assert.equal(await missing(path.join(machine, 'vscode-fresh-reset-pending.json')), false);
});

test('forget-only clears machine state from inside a workspace while preserving every repository byte', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-forget-home-'));
  const { createWorkspaceConfiguration } = await import('../src/workspace.mjs');
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(home, 'workspaces'),
    id: 'forget-demo',
    name: 'Forget demo',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: 'https://example.invalid/platform.git', defaultBranch: 'main', required: true,
        metadata: { appId: 'APP-FORGET', name: 'Forget platform' }
      }
    }
  }, { confirmation: 'forget-demo', clone: false });
  const repository = path.join(created.workspace.path, 'repos', 'platform');
  await mkdir(repository, { recursive: true });
  git(repository, 'init', '-b', 'feature/local-work');
  git(repository, 'config', 'user.name', 'Forget Tester');
  git(repository, 'config', 'user.email', 'forget@example.com');
  await writeFile(path.join(repository, 'tracked.txt'), 'tracked repository bytes\n');
  git(repository, 'add', 'tracked.txt');
  git(repository, 'commit', '-m', 'baseline');
  await writeFile(path.join(repository, 'tracked.txt'), 'dirty repository bytes\n');
  await writeFile(path.join(repository, 'untracked.txt'), 'untracked repository bytes\n');
  await mkdir(path.join(repository, '.git', 'singularity-flow'), { recursive: true });
  await writeFile(path.join(repository, '.git', 'singularity-flow', 'pending-publication.json'), '{"pending":true}\n');
  const beforeHead = git(repository, 'rev-parse', 'HEAD');
  const beforeStatus = git(repository, 'status', '--porcelain=v1');

  const machine = path.join(home, '.singularity-flow');
  await mkdir(path.join(machine, 'organisation-cache'), { recursive: true });
  await writeFile(path.join(machine, 'workspaces.json'), `${JSON.stringify({
    schemaVersion: 1,
    workspaces: [{ id: created.workspace.id, path: created.workspace.path, name: created.workspace.name }]
  })}\n`);
  await writeFile(path.join(machine, 'active-workspace.json'), '{"workspaceId":"forget-demo"}\n');
  await writeFile(path.join(machine, 'leads.json'), '{"leads":[{"url":"https://example.invalid/lead.git"}]}\n');
  await writeFile(path.join(machine, 'organisation-cache', 'cached.json'), '{}\n');
  await writeFile(path.join(machine, 'installation.json'), '{}\n');
  await writeFile(path.join(machine, 'telemetry.json'), '{}\n');
  const sessions = path.join(home, '.copilot', 'session-state');
  await mkdir(path.join(sessions, 'singularity-forget-demo'), { recursive: true });
  await mkdir(path.join(sessions, 'personal-session'), { recursive: true });

  const { localReset, localResetPlan } = await import('../src/fresh-install-reset.mjs');
  const resetOptions = {
    homeDirectory: home,
    projectDirectory: repository,
    environment: {},
    forgetOnly: true
  };
  const preview = await localResetPlan(resetOptions);
  assert.equal(preview.schemaVersion, 2);
  assert.equal(preview.mode, 'forget-only');
  assert.equal(preview.confirmation, 'FORGET LOCAL');
  assert.deepEqual(preview.workspaces.map(({ path: workspacePath, disposition }) => ({ workspacePath, disposition })), [{
    workspacePath: created.workspace.path,
    disposition: 'preserved'
  }]);
  const canonicalMachine = await realpath(machine);
  assert.equal(preview.capabilityState.registryFile, path.join(canonicalMachine, 'leads.json'));
  assert.equal(preview.capabilityState.cacheRoot, path.join(canonicalMachine, 'organisation-cache'));
  assert.match(preview.preserve.join('\n'), /repository-local recovery record/);

  await assert.rejects(() => localReset({ ...resetOptions, confirmation: 'RESET LOCAL' }),
    /requires exact confirmation 'FORGET LOCAL'/);
  assert.equal(await readFile(path.join(repository, 'tracked.txt'), 'utf8'), 'dirty repository bytes\n');

  await assert.rejects(() => localReset({
    ...resetOptions,
    confirmation: 'FORGET LOCAL',
    fault: (stage) => {
      if (stage.startsWith('after-move:')) throw new Error('injected forget-only failure');
    }
  }), /injected forget-only failure/);
  assert.equal(await readFile(path.join(machine, 'active-workspace.json'), 'utf8'), '{"workspaceId":"forget-demo"}\n');

  const result = await localReset({ ...resetOptions, confirmation: 'FORGET LOCAL' });
  assert.equal(result.completed, true);
  assert.equal(result.mode, 'forget-only');
  assert.equal(await missing(created.workspace.path), false);
  assert.equal(await readFile(path.join(repository, 'tracked.txt'), 'utf8'), 'dirty repository bytes\n');
  assert.equal(await readFile(path.join(repository, 'untracked.txt'), 'utf8'), 'untracked repository bytes\n');
  assert.equal(await readFile(path.join(repository, '.git', 'singularity-flow', 'pending-publication.json'), 'utf8'),
    '{"pending":true}\n');
  assert.equal(git(repository, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(git(repository, 'status', '--porcelain=v1'), beforeStatus);
  assert.equal(await missing(path.join(machine, 'workspaces.json')), true);
  assert.equal(await missing(path.join(machine, 'leads.json')), true);
  assert.equal(await missing(path.join(machine, 'organisation-cache')), true);
  assert.equal(await missing(path.join(sessions, 'singularity-forget-demo')), true);
  assert.equal(await missing(path.join(sessions, 'personal-session')), false);
  const marker = JSON.parse(await readFile(result.vscodeResetMarker, 'utf8'));
  assert.equal(marker.schemaVersion, 2);
  assert.equal(marker.mode, 'forget-only');
  assert.ok(marker.reset.includes('favorites'));
  assert.ok(marker.reset.includes('global-extension-settings'));
});

test('forget-only removes supported custom state paths, tolerates a corrupt registry, and rejects broad or linked targets', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-forget-custom-home-'));
  const project = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-forget-custom-project-'));
  const custom = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-forget-custom-state-'));
  const environment = {
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(custom, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(custom, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(custom, 'leads.json'),
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(custom, 'capability-cache'),
    SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(custom, 'local-journal'),
    SINGULARITY_FLOW_VSCODE_RESET_MARKER: path.join(custom, 'vscode-reset.json')
  };
  await writeFile(environment.SINGULARITY_FLOW_WORKSPACE_REGISTRY, '{not json\n');
  await writeFile(environment.SINGULARITY_FLOW_ACTIVE_WORKSPACE, '{}\n');
  await writeFile(environment.SINGULARITY_FLOW_LEAD_REGISTRY, '{}\n');
  await mkdir(environment.SINGULARITY_FLOW_ORGANISATION_CACHE);
  await writeFile(path.join(environment.SINGULARITY_FLOW_ORGANISATION_CACHE, 'cached.json'), '{}\n');
  await mkdir(environment.SINGULARITY_FLOW_LOCAL_JOURNAL);
  await writeFile(path.join(environment.SINGULARITY_FLOW_LOCAL_JOURNAL, 'preferences.json'), '{}\n');

  const { localReset, localResetPlan } = await import('../src/fresh-install-reset.mjs');
  const options = { homeDirectory: home, projectDirectory: project, environment, forgetOnly: true };
  const preview = await localResetPlan(options);
  assert.match(preview.registryWarning, /Unreadable workspace registry will be forgotten/);
  assert.equal(preview.vscodeReset.marker,
    path.join(await realpath(custom), path.basename(environment.SINGULARITY_FLOW_VSCODE_RESET_MARKER)));
  await localReset({ ...options, confirmation: 'FORGET LOCAL' });
  assert.equal(await missing(environment.SINGULARITY_FLOW_WORKSPACE_REGISTRY), true);
  assert.equal(await missing(environment.SINGULARITY_FLOW_ACTIVE_WORKSPACE), true);
  assert.equal(await missing(environment.SINGULARITY_FLOW_LEAD_REGISTRY), true);
  assert.equal(await missing(environment.SINGULARITY_FLOW_ORGANISATION_CACHE), true);
  assert.equal(await missing(environment.SINGULARITY_FLOW_LOCAL_JOURNAL), true);
  assert.equal(await missing(environment.SINGULARITY_FLOW_VSCODE_RESET_MARKER), false);

  await assert.rejects(() => localResetPlan({
    homeDirectory: home,
    projectDirectory: project,
    environment: { SINGULARITY_FLOW_ORGANISATION_CACHE: home },
    forgetOnly: true
  }), /Refusing broad or protected custom capability cache/);

  const linkedTarget = path.join(custom, 'linked-cache');
  await symlink(path.join(custom, 'real-cache'), linkedTarget);
  await assert.rejects(() => localResetPlan({
    homeDirectory: home,
    projectDirectory: project,
    environment: { SINGULARITY_FLOW_ORGANISATION_CACHE: linkedTarget },
    forgetOnly: true
  }), /must not be a symbolic link/);
});

test('reset canonicalizes custom state paths and refuses symlink-ancestor escapes into protected roots', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-reset-canonical-targets-'));
  const home = path.join(base, 'home-root');
  const project = path.join(base, 'product-root');
  const aliases = path.join(base, 'aliases');
  await mkdir(home);
  await mkdir(project);
  await mkdir(aliases);
  t.after(() => rm(base, { recursive: true, force: true }));

  // The configured leaf is not itself a symlink. Its parent is, which used to bypass lexical
  // containment checks and let moveToStaging follow the alias during destructive application.
  const homeParentAlias = path.join(aliases, 'home-parent');
  const projectParentAlias = path.join(aliases, 'project-parent');
  await symlink(path.dirname(home), homeParentAlias);
  await symlink(path.dirname(project), projectParentAlias);
  const homeThroughAncestor = path.join(homeParentAlias, path.basename(home));
  const projectThroughAncestor = path.join(projectParentAlias, path.basename(project));

  const protectedRegistry = path.join(project, 'protected-workspaces.json');
  const protectedJournal = path.join(project, 'protected-journal');
  await writeFile(protectedRegistry, '[]\n');
  await mkdir(protectedJournal);
  await writeFile(path.join(protectedJournal, 'receipt.json'), '{"preserve":true}\n');

  const { localResetPlan } = await import('../src/fresh-install-reset.mjs');
  await assert.rejects(() => localResetPlan({
    homeDirectory: home,
    projectDirectory: project,
    environment: { SINGULARITY_FLOW_ORGANISATION_CACHE: homeThroughAncestor },
    forgetOnly: true
  }), /Refusing broad or protected custom capability cache/);
  await assert.rejects(() => localResetPlan({
    homeDirectory: home,
    projectDirectory: project,
    environment: {
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(
        projectThroughAncestor, path.basename(protectedRegistry)
      )
    },
    forgetOnly: true
  }), /Refusing broad or protected custom workspace registry/);
  await assert.rejects(() => localResetPlan({
    homeDirectory: home,
    projectDirectory: project,
    environment: {
      SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(
        projectThroughAncestor, path.basename(protectedJournal)
      )
    },
    forgetOnly: true
  }), /Refusing broad or protected custom local work journal/);

  assert.equal(await readFile(protectedRegistry, 'utf8'), '[]\n');
  assert.equal(await readFile(path.join(protectedJournal, 'receipt.json'), 'utf8'),
    '{"preserve":true}\n');
});

test('local-reset CLI keeps non-interactive preview and confirmation mode-bound', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-forget-cli-home-'));
  const invoke = (...args) => spawnSync(process.execPath, [cli, 'local-reset', ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NODE_ENV: 'test' }
  });
  const previewed = invoke('--forget-only', '--dry-run', '--json');
  assert.equal(previewed.status, 0, previewed.stderr);
  const preview = JSON.parse(previewed.stdout);
  assert.equal(preview.data.schemaVersion, 2);
  assert.equal(preview.data.mode, 'forget-only');
  assert.equal(preview.data.confirmation, 'FORGET LOCAL');

  const unconfirmed = invoke('--forget-only', '--json');
  assert.notEqual(unconfirmed.status, 0);
  assert.match(unconfirmed.stderr, /Non-interactive local-reset requires an explicit preview/);

  const crossed = invoke('--forget-only', '--confirm', 'RESET LOCAL', '--json');
  assert.notEqual(crossed.status, 0);
  assert.match(crossed.stderr, /requires exact confirmation 'FORGET LOCAL'/);

  const completed = invoke('--forget-only', '--confirm', 'FORGET LOCAL', '--json');
  assert.equal(completed.status, 0, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.data.completed, true);
  assert.equal(result.data.mode, 'forget-only');
});

test('local reset from inside a managed workspace refuses before deleting anything', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-reset-inside-home-'));
  const { createWorkspaceConfiguration } = await import('../src/workspace.mjs');
  const created = await createWorkspaceConfiguration({
    baseDirectory: path.join(home, 'workspaces'),
    id: 'inside-demo',
    name: 'Inside demo',
    leadRepository: 'platform',
    repositories: {
      platform: {
        url: 'https://example.invalid/platform.git', defaultBranch: 'main', required: true,
        metadata: { appId: 'APP-INSIDE', name: 'Inside platform' }
      }
    }
  }, { confirmation: 'inside-demo', clone: false });
  const machine = path.join(home, '.singularity-flow');
  await mkdir(machine, { recursive: true });
  await writeFile(path.join(machine, 'workspaces.json'), `${JSON.stringify({
    schemaVersion: 1,
    workspaces: [{ id: created.workspace.id, path: created.workspace.path, name: created.workspace.name }]
  })}\n`);
  const { localResetPlan } = await import('../src/fresh-install-reset.mjs');
  await assert.rejects(() => localResetPlan({
    homeDirectory: home,
    projectDirectory: path.join(created.workspace.path, 'repos'),
    environment: {}
  }), /current working directory is inside registered workspace.*Run local-reset from a directory outside/s);
  assert.equal(await missing(created.workspace.path), false);
});

test('fresh install reset refuses existing registered paths without a matching workspace manifest', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-refuse-home-'));
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-refuse-checkout-'));
  const application = path.join(home, 'important-application');
  await mkdir(application);
  await writeFile(path.join(application, 'source.txt'), 'must remain\n');
  const machine = path.join(home, '.singularity-flow');
  await mkdir(machine);
  await writeFile(path.join(machine, 'workspaces.json'), `${JSON.stringify({
    schemaVersion: 1,
    workspaces: [{ id: 'not-a-workspace', path: application, name: 'Important', openedAt: new Date().toISOString() }]
  })}\n`);
  const { freshInstallResetPlan } = await import('../src/fresh-install-reset.mjs');
  await assert.rejects(
    () => freshInstallResetPlan({ homeDirectory: home, projectDirectory: checkout, environment: {} }),
    /Refusing to delete unproven registered workspace/
  );
  assert.equal(await readFile(path.join(application, 'source.txt'), 'utf8'), 'must remain\n');
});

test('fresh install reset removes only untracked generated state from its installer checkout', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-generated-home-'));
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-generated-checkout-'));
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Reset Tester');
  git(checkout, 'config', 'user.email', 'fresh-reset@example.com');
  await writeFile(path.join(checkout, 'product.txt'), 'tracked product source\n');
  git(checkout, 'add', 'product.txt');
  git(checkout, 'commit', '-m', 'product baseline');
  await mkdir(path.join(checkout, 'singularity'), { recursive: true });
  await writeFile(path.join(checkout, 'singularity', 'workflow.yml'), 'version: 2\n');
  await mkdir(path.join(checkout, '.github', 'agents'), { recursive: true });
  await writeFile(path.join(checkout, '.github', 'agents', 'developer.agent.md'), 'generated\n');

  const { freshInstallReset, freshInstallResetPlan } = await import('../src/fresh-install-reset.mjs');
  const preview = await freshInstallResetPlan({ homeDirectory: home, projectDirectory: checkout, environment: {} });
  const canonicalCheckout = await realpath(checkout);
  assert.deepEqual(preview.installerGeneratedPaths, [
    path.join(canonicalCheckout, '.github', 'agents'),
    path.join(canonicalCheckout, 'singularity')
  ]);
  await freshInstallReset({
    homeDirectory: home,
    projectDirectory: checkout,
    environment: {},
    confirmation: 'RESET EVERYTHING'
  });
  assert.equal(await missing(path.join(checkout, 'singularity')), true);
  assert.equal(await missing(path.join(checkout, '.github', 'agents')), true);
  assert.equal(await readFile(path.join(checkout, 'product.txt'), 'utf8'), 'tracked product source\n');
  assert.equal(git(checkout, 'status', '--porcelain'), '');
});

test('fresh install reset refuses generated roots that contain ignored private files', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-ignored-home-'));
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-ignored-checkout-'));
  t.after(() => Promise.all([
    rm(home, { recursive: true, force: true }), rm(checkout, { recursive: true, force: true })
  ]));
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Reset Ignored Tester');
  git(checkout, 'config', 'user.email', 'fresh-reset-ignored@example.com');
  await writeFile(path.join(checkout, '.gitignore'), 'singularity/private.txt\n');
  await writeFile(path.join(checkout, 'product.txt'), 'tracked product source\n');
  git(checkout, 'add', '.gitignore', 'product.txt');
  git(checkout, 'commit', '-m', 'product baseline');
  await mkdir(path.join(checkout, 'singularity'));
  await writeFile(path.join(checkout, 'singularity', 'workflow.yml'), 'version: 2\n');
  await writeFile(path.join(checkout, 'singularity', 'private.txt'), 'must remain private\n');

  const { freshInstallResetPlan } = await import('../src/fresh-install-reset.mjs');
  await assert.rejects(
    () => freshInstallResetPlan({ homeDirectory: home, projectDirectory: checkout, environment: {} }),
    /contains ignored or private files:[\s\S]*singularity\/private\.txt/
  );
  assert.equal(await readFile(path.join(checkout, 'singularity', 'workflow.yml'), 'utf8'), 'version: 2\n');
  assert.equal(await readFile(path.join(checkout, 'singularity', 'private.txt'), 'utf8'), 'must remain private\n');
});

test('fresh install Git safety probes are bounded and fail closed', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-probe-home-'));
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-probe-checkout-'));
  const bin = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-probe-bin-'));
  t.after(() => Promise.all([
    rm(home, { recursive: true, force: true }),
    rm(checkout, { recursive: true, force: true }),
    rm(bin, { recursive: true, force: true })
  ]));
  const fakeGit = path.join(bin, 'git');
  await writeFile(fakeGit, '#!/usr/bin/env bash\nexec sleep 5\n');
  await chmod(fakeGit, 0o755);

  const { freshInstallResetPlan } = await import('../src/fresh-install-reset.mjs');
  const started = Date.now();
  await assert.rejects(
    () => freshInstallResetPlan({
      homeDirectory: home,
      projectDirectory: checkout,
      environment: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        SINGULARITY_FLOW_GIT_LOCAL_TIMEOUT_MS: '25'
      }
    }),
    /checkout-state-unavailable/
  );
  assert.ok(Date.now() - started < 2_000, 'a stuck Git safety probe must not hang reset planning');
});

test('fresh install reset still refuses unrelated installer checkout changes', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-dirty-home-'));
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-dirty-checkout-'));
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Reset Tester');
  git(checkout, 'config', 'user.email', 'fresh-reset@example.com');
  await writeFile(path.join(checkout, 'product.txt'), 'tracked product source\n');
  git(checkout, 'add', 'product.txt');
  git(checkout, 'commit', '-m', 'product baseline');
  await writeFile(path.join(checkout, 'product.txt'), 'uncommitted source edit\n');

  const { freshInstallResetPlan } = await import('../src/fresh-install-reset.mjs');
  await assert.rejects(
    () => freshInstallResetPlan({ homeDirectory: home, projectDirectory: checkout, environment: {} }),
    /changes outside generated reset state[\s\S]*product\.txt/
  );
  assert.equal(await readFile(path.join(checkout, 'product.txt'), 'utf8'), 'uncommitted source edit\n');
});

test('fresh-install prerequisite and registry admission cannot mutate machine state', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-preflight-'));
  const home = path.join(base, 'home');
  const checkout = path.join(base, 'checkout');
  const machine = path.join(home, '.singularity-flow');
  const sentinel = path.join(machine, 'must-remain.txt');
  // The aggregate test runner deliberately pins every process to its own machine-state files.
  // HOME alone therefore does not isolate a nested CLI: inherited explicit paths take precedence
  // and would make this test inspect (or, on a regression, mutate) the runner's shared registry.
  // Bind every reset-aware override to this fixture so admission is exercised against the exact
  // corrupt registry below and no failed assertion can escape the fixture boundary.
  const environment = {
    HOME: home,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json'),
    SINGULARITY_FLOW_ORGANISATION_CACHE: path.join(machine, 'organisation-cache'),
    SINGULARITY_FLOW_LOCAL_JOURNAL: path.join(machine, 'local-work-journal'),
    SINGULARITY_FLOW_VSCODE_RESET_MARKER: path.join(machine, 'vscode-fresh-reset-pending.json')
  };
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(machine, { recursive: true });
  await mkdir(checkout);
  await writeFile(sentinel, 'preflight must not move me\n');
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Install Preflight Tester');
  git(checkout, 'config', 'user.email', 'fresh-install-preflight@example.com');
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow"}\n');
  await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n');
  await chmod(path.join(checkout, 'install.sh'), 0o755);
  git(checkout, 'add', 'package.json', 'install.sh');
  git(checkout, 'commit', '-m', 'reviewed source');

  const { preflightFreshInstallRuntime } = await import('../src/cli.mjs');
  assert.throws(() => preflightFreshInstallRuntime({
    cliOnly: true,
    registry: 'https://npm.example.com/',
    existsCommand: (name) => name !== 'bash',
    execute: () => { throw new Error('registry lookup must not run with an explicit registry'); }
  }), /requires these commands before any state can be reset: bash/);
  assert.equal(await readFile(sentinel, 'utf8'), 'preflight must not move me\n');

  const invalid = command(process.execPath, [
    cli, 'fresh-install', '--checkout', checkout, '--yes', '--cli-only', '--registry', 'file:///private/npm'
  ], packageRoot, { ok: false, env: environment });
  assert.ifError(invalid.error);
  assert.notEqual(invalid.status, null, `fresh-install did not exit normally (signal: ${invalid.signal ?? 'none'})`);
  assert.notEqual(invalid.status, 0, 'an invalid npm registry must be refused');
  assert.match(invalid.stderr, /npm registry must use http:\/\/ or https:\/\//);
  assert.equal(await readFile(sentinel, 'utf8'), 'preflight must not move me\n');

  await writeFile(path.join(machine, 'workspaces.json'), '{not valid json\n');
  const invalidWorkspaceRegistry = command(process.execPath, [
    cli, 'fresh-install', '--checkout', checkout, '--yes', '--cli-only',
    '--registry', 'https://npm.example.com/'
  ], packageRoot, { ok: false, env: environment });
  assert.ifError(invalidWorkspaceRegistry.error);
  assert.notEqual(invalidWorkspaceRegistry.status, null,
    `fresh-install did not exit normally (signal: ${invalidWorkspaceRegistry.signal ?? 'none'})`);
  assert.notEqual(invalidWorkspaceRegistry.status, 0, 'an unreadable workspace registry must be refused');
  assert.match(invalidWorkspaceRegistry.stderr, /Refusing a full reset with an unreadable workspace registry/);
  assert.equal(await readFile(sentinel, 'utf8'), 'preflight must not move me\n');
  assert.equal(await readFile(path.join(machine, 'workspaces.json'), 'utf8'), '{not valid json\n');
});

test('fresh-install immutable staging survives a clean source branch commit swap', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-commit-swap-'));
  let staging = null;
  t.after(async () => {
    if (staging) {
      const { disposeFreshInstallSource } = await import('../src/cli.mjs');
      await disposeFreshInstallSource(staging).catch(() => false);
    }
    await rm(checkout, { recursive: true, force: true });
  });
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Install Swap Tester');
  git(checkout, 'config', 'user.email', 'fresh-install-swap@example.com');
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow","generation":1}\n');
  await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nprintf "generation-one\\n"\n');
  await writeFile(path.join(checkout, 'product.txt'), 'generation one\n');
  await chmod(path.join(checkout, 'install.sh'), 0o755);
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'reviewed generation one');

  const {
    disposeFreshInstallSource, stageTrustedFreshInstallSource, trustedFreshInstallSource
  } = await import('../src/cli.mjs');
  const source = await trustedFreshInstallSource(checkout);
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow","generation":2}\n');
  await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nprintf "generation-two\\n"\n');
  await writeFile(path.join(checkout, 'product.txt'), 'generation two\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'clean generation two swap');
  assert.notEqual(git(checkout, 'rev-parse', 'HEAD'), source.commit);

  staging = await stageTrustedFreshInstallSource(checkout, source);
  assert.equal(git(staging.checkout, 'rev-parse', 'HEAD^{commit}'), source.commit);
  assert.equal(git(staging.checkout, 'rev-parse', 'HEAD^{tree}'), source.tree);
  assert.equal(await readFile(path.join(staging.checkout, 'product.txt'), 'utf8'), 'generation one\n');
  assert.equal(await readFile(path.join(staging.checkout, 'install.sh'), 'utf8'),
    '#!/usr/bin/env bash\nprintf "generation-one\\n"\n');
  await disposeFreshInstallSource(staging);
  staging = null;
});

test('fresh-install source admission rejects tracked symlinks and gitlinks', async (t) => {
  async function fixture(label) {
    const checkout = await mkdtemp(path.join(os.tmpdir(), `sflow-fresh-tree-mode-${label}-`));
    t.after(() => rm(checkout, { recursive: true, force: true }));
    git(checkout, 'init', '-b', 'main');
    git(checkout, 'config', 'user.name', 'Fresh Install Tree Tester');
    git(checkout, 'config', 'user.email', 'fresh-install-tree@example.com');
    await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow"}\n');
    await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n');
    await chmod(path.join(checkout, 'install.sh'), 0o755);
    return checkout;
  }
  const { trustedFreshInstallSource } = await import('../src/cli.mjs');

  await t.test('symlink', async () => {
    const checkout = await fixture('symlink');
    await symlink('/tmp/outside-fresh-install', path.join(checkout, 'outside-link'));
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-m', 'tracked symlink');
    await assert.rejects(() => trustedFreshInstallSource(checkout),
      /outside-link has unsupported tracked mode 120000/);
  });

  await t.test('gitlink', async () => {
    const checkout = await fixture('gitlink');
    git(checkout, 'add', 'package.json', 'install.sh');
    git(checkout, 'commit', '-m', 'regular baseline');
    const object = git(checkout, 'rev-parse', 'HEAD');
    git(checkout, 'update-index', '--add', '--cacheinfo', `160000,${object},nested-product`);
    git(checkout, 'commit', '-m', 'tracked gitlink');
    await assert.rejects(() => trustedFreshInstallSource(checkout),
      /nested-product has unsupported tracked mode 160000/);
  });
});

test('fresh-install preview never executes configured clean or process filters', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-filter-proof-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-filter-home-'));
  const marker = path.join(home, 'filter-executed');
  const filter = path.join(home, 'evil-filter.sh');
  t.after(() => Promise.all([
    rm(checkout, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true })
  ]));
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Install Filter Tester');
  git(checkout, 'config', 'user.email', 'fresh-install-filter@example.com');
  await writeFile(filter, `#!/usr/bin/env bash\nprintf executed > ${JSON.stringify(marker)}\ncat\n`);
  await chmod(filter, 0o755);
  await writeFile(path.join(checkout, '.gitattributes'), '*.txt filter=evil\n');
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow"}\n');
  await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n');
  await writeFile(path.join(checkout, 'product.txt'), 'reviewed bytes\n');
  await chmod(path.join(checkout, 'install.sh'), 0o755);
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'reviewed filtered source');
  git(checkout, 'config', 'filter.evil.clean', filter);
  git(checkout, 'config', 'filter.evil.process', filter);
  // Make Git's stat cache racy enough that a `git status` implementation would ask the configured
  // clean/process filter to compare these otherwise identical bytes.
  await writeFile(path.join(checkout, 'product.txt'), 'reviewed bytes\n');
  await rm(marker, { force: true });

  const preview = command(process.execPath, [
    cli, 'fresh-install', '--checkout', checkout, '--cli-only', '--registry', 'https://npm.example.com/'
  ], packageRoot, { env: { HOME: home } });
  assert.match(preview.stdout, /fresh-install reset — preview/);
  assert.equal(await missing(marker), true,
    'admission enumerates Git identities and hashes raw files in Node; it never invokes filters');
});

test('fresh-install refusal escapes crafted untracked filenames in diagnostics', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-untracked-name-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-untracked-home-'));
  t.after(() => Promise.all([
    rm(checkout, { recursive: true, force: true }), rm(home, { recursive: true, force: true })
  ]));
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Install Filename Tester');
  git(checkout, 'config', 'user.email', 'fresh-install-filename@example.com');
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow"}\n');
  await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n');
  await chmod(path.join(checkout, 'install.sh'), 0o755);
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'reviewed product source');
  await writeFile(path.join(checkout, 'crafted\nFAKE SUCCESS'), 'untracked\n');

  const preview = command(process.execPath, [
    cli, 'fresh-install', '--checkout', checkout, '--cli-only', '--registry', 'https://npm.example.com/'
  ], packageRoot, { ok: false, env: { HOME: home } });
  assert.match(preview.stderr, /crafted\\nFAKE SUCCESS/,
    'the diagnostic contains one JSON-escaped filename, not attacker-controlled terminal lines');
  assert.doesNotMatch(preview.stderr, /crafted\nFAKE SUCCESS/);
});

test('fresh-install CLI delegates preview and confirmed reinstall to a validated product checkout', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-cli-checkout-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-cli-home-'));
  t.after(() => Promise.all([
    rm(checkout, { recursive: true, force: true }), rm(home, { recursive: true, force: true })
  ]));
  const invocationLog = path.join(home, 'invocation.log');
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Install CLI Tester');
  git(checkout, 'config', 'user.email', 'fresh-install-cli@example.com');
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow"}\n');
  await writeFile(path.join(checkout, 'install.sh'), [
    '#!/usr/bin/env bash',
    'printf "args=%s source=%s origin=%s commit=%s tree=%s cwd=%s\\n" "$*" "${BASH_SOURCE[0]}" "${SINGULARITY_FLOW_FRESH_INSTALL_ORIGIN:-}" "${SINGULARITY_FLOW_FRESH_INSTALL_COMMIT:-}" "${SINGULARITY_FLOW_FRESH_INSTALL_TREE:-}" "$PWD" >> "$SFLOW_TEST_INVOCATION_LOG"',
    ''
  ].join('\n'));
  await chmod(path.join(checkout, 'install.sh'), 0o755);
  git(checkout, 'add', 'package.json', 'install.sh');
  git(checkout, 'commit', '-m', 'product checkout');
  await mkdir(path.join(checkout, 'singularity'), { recursive: true });
  await writeFile(path.join(checkout, 'singularity', 'generated-before-reset.txt'), 'remove me\n');
  const canonicalCheckout = await realpath(checkout);
  const sourceCommit = git(checkout, 'rev-parse', 'HEAD^{commit}');
  const sourceTree = git(checkout, 'rev-parse', 'HEAD^{tree}');

  const preview = command(process.execPath, [cli, 'fresh-install', '--checkout', checkout], packageRoot, {
    env: {
      HOME: home,
      GIT_DIR: path.join(home, 'ambient-wrong.git'),
      GIT_INDEX_FILE: path.join(home, 'ambient-wrong.index')
    }
  });
  assert.match(preview.stdout, /fresh-install reset — preview/);
  assert.match(preview.stdout, /Generated state in this installer checkout/);
  assert.match(preview.stdout, /singularity/);
  assert.match(preview.stdout, /Preview only: nothing was deleted/);
  assert.equal(await missing(path.join(checkout, 'invocation.log')), true,
    'preview is resolved by the trusted running CLI and must not execute checkout code');
  command(process.execPath, [
    cli, 'fresh-install', '--checkout', checkout, '--yes', '--registry', 'https://npm.example.com/',
    '--cli-only', '--no-copilot-telemetry'
  ], packageRoot, {
    env: {
      HOME: home,
      SFLOW_TEST_INVOCATION_LOG: invocationLog,
      GIT_DIR: path.join(home, 'ambient-wrong.git'),
      GIT_INDEX_FILE: path.join(home, 'ambient-wrong.index')
    }
  });
  const invoked = await readFile(invocationLog, 'utf8');
  assert.match(invoked, new RegExp(
    `^args=--no-update --registry https://npm\\.example\\.com/ --cli-only --no-copilot-telemetry source= origin=${canonicalCheckout.replaceAll('\\', '\\\\')} commit=${sourceCommit} tree=${sourceTree} cwd=`
  ));
  assert.ok(!invoked.endsWith(`cwd=${canonicalCheckout}\n`),
    'the installer runs in an immutable private clone, not the mutable source checkout');
  assert.equal(await missing(path.join(checkout, 'singularity')), true,
    'the exact planner-proven generated root is reachable and removed before installation');
  assert.equal((await readdir(path.dirname(checkout))).some((entry) =>
    entry.startsWith('.sflow-fresh-install-source-')), false,
    'a successful activation removes its private source without making the receipt depend on it');
});

test('the reviewed installer resolves PROJECT_DIR from canonical cwd when executed as verified stdin', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-cli-stdin-root-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const installer = await readFile(path.join(packageRoot, 'install.sh'), 'utf8');
  const boundary = installer.indexOf('ORIGINAL_ARGUMENTS=("$@")');
  assert.ok(boundary > 0, 'the project-root initialization must precede installer argument handling');
  const rootProbe = `${installer.slice(0, boundary)}printf '%s\\n' "$PROJECT_DIR"\n`;
  const result = spawnSync('bash', ['-s'], {
    cwd: checkout,
    input: rootProbe,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), await realpath(checkout));
});

test('fresh-install reset never loads ignored checkout modules before locked dependency installation', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-cli-ignored-dependency-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-cli-ignored-home-'));
  t.after(() => Promise.all([
    rm(checkout, { recursive: true, force: true }), rm(home, { recursive: true, force: true })
  ]));
  const invocationLog = path.join(home, 'invocation.log');
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Install Dependency Tester');
  git(checkout, 'config', 'user.email', 'fresh-install-dependency@example.com');
  await writeFile(path.join(checkout, '.gitignore'), 'node_modules/\nscripts/fresh-install-reset.mjs\n');
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow"}\n');
  await writeFile(path.join(checkout, 'install.sh'), [
    '#!/usr/bin/env bash',
    'test "$1" = "--no-update"',
    'printf "installer-ran\\n" > "$SFLOW_TEST_INVOCATION_LOG"',
    ''
  ].join('\n'));
  await chmod(path.join(checkout, 'install.sh'), 0o755);
  git(checkout, 'add', '.gitignore', 'package.json', 'install.sh');
  git(checkout, 'commit', '-m', 'reviewed fresh-install source');

  await mkdir(path.join(checkout, 'scripts'), { recursive: true });
  await writeFile(path.join(checkout, 'scripts', 'fresh-install-reset.mjs'),
    'await import("node:fs/promises").then(({writeFile}) => writeFile("ignored-code-ran", "yes"));\n');
  await mkdir(path.join(checkout, 'node_modules', 'yaml'), { recursive: true });
  await writeFile(path.join(checkout, 'node_modules', 'yaml', 'package.json'),
    '{"name":"yaml","type":"module","main":"index.js"}\n');
  await writeFile(path.join(checkout, 'node_modules', 'yaml', 'index.js'),
    'await import("node:fs/promises").then(({writeFile}) => writeFile("ignored-dependency-ran", "yes"));\n');

  const preview = command(process.execPath, [
    cli, 'fresh-install', '--checkout', checkout, '--cli-only', '--registry', 'https://npm.example.com/'
  ], packageRoot, {
    env: { HOME: home }
  });
  assert.match(preview.stdout, /fresh-install reset — preview/);
  assert.equal(await missing(path.join(checkout, 'invocation.log')), true);
  assert.equal(await missing(path.join(checkout, 'ignored-code-ran')), true);
  assert.equal(await missing(path.join(checkout, 'ignored-dependency-ran')), true);

  command(process.execPath, [
    cli, 'fresh-install', '--checkout', checkout, '--yes', '--cli-only', '--registry', 'https://npm.example.com/'
  ], packageRoot, {
    env: { HOME: home, SFLOW_TEST_INVOCATION_LOG: invocationLog }
  });
  assert.equal(await readFile(invocationLog, 'utf8'), 'installer-ran\n');
  assert.equal(await missing(path.join(checkout, 'ignored-code-ran')), true);
  assert.equal(await missing(path.join(checkout, 'ignored-dependency-ran')), true);
});

test('fresh-install CLI refuses an arbitrary checkout with untracked trust anchors', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-cli-refuse-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  git(checkout, 'init', '-b', 'main');
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow"}\n');
  await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nexit 0\n');
  const result = command(process.execPath, [cli, 'fresh-install', '--checkout', checkout], packageRoot, { ok: false });
  assert.match(result.stderr, /package\.json is not a regular file tracked at HEAD/);
  assert.match(result.stderr, /install\.sh is not a regular stage-0 file in the Git index/);
  assert.match(result.stderr, /Commit the reviewed versions, or stash\/restore changes/);
});

test('fresh-install CLI never runs modified, staged, or symbolic-link trust anchors', async (t) => {
  async function fixture(label) {
    const checkout = await mkdtemp(path.join(os.tmpdir(), `sflow-fresh-cli-trust-${label}-`));
    t.after(() => rm(checkout, { recursive: true, force: true }));
    git(checkout, 'init', '-b', 'main');
    git(checkout, 'config', 'user.name', 'Fresh Install Trust Tester');
    git(checkout, 'config', 'user.email', 'fresh-install-trust@example.com');
    const packageBytes = '{"name":"singularity-flow"}\n';
    const installerBytes = '#!/usr/bin/env bash\nprintf "invoked\\n" > invoked.log\n';
    await writeFile(path.join(checkout, 'package.json'), packageBytes);
    await writeFile(path.join(checkout, 'install.sh'), installerBytes);
    await chmod(path.join(checkout, 'install.sh'), 0o755);
    git(checkout, 'add', 'package.json', 'install.sh');
    git(checkout, 'commit', '-m', 'reviewed fresh-install source');
    return { checkout, installerBytes };
  }

  async function refused(checkout, pattern) {
    const result = command(process.execPath, [cli, 'fresh-install', '--checkout', checkout], packageRoot, { ok: false });
    assert.match(result.stderr, /before running install\.sh, including reset preview/);
    assert.match(result.stderr, pattern);
    assert.equal(await missing(path.join(checkout, 'invoked.log')), true, 'untrusted installer bytes must never run');
  }

  await t.test('unstaged installer bytes', async () => {
    const { checkout } = await fixture('unstaged-installer');
    await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nprintf "invoked\\n" > invoked.log\n# unreviewed\n');
    await refused(checkout, /install\.sh working-tree bytes do not match HEAD/);
  });

  await t.test('staged installer bytes', async () => {
    const { checkout } = await fixture('staged-installer');
    await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nprintf "invoked\\n" > invoked.log\n# staged but uncommitted\n');
    git(checkout, 'add', 'install.sh');
    await refused(checkout, /install\.sh has staged content or mode changes that do not match HEAD/);
  });

  await t.test('staged installer differs even when the working file was restored', async () => {
    const { checkout, installerBytes } = await fixture('staged-index-only');
    await writeFile(path.join(checkout, 'install.sh'), `${installerBytes}# staged only\n`);
    git(checkout, 'add', 'install.sh');
    await writeFile(path.join(checkout, 'install.sh'), installerBytes);
    await refused(checkout, /install\.sh working-tree bytes do not match the Git index/);
  });

  await t.test('modified product manifest', async () => {
    const { checkout } = await fixture('modified-package');
    await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow","unreviewed":true}\n');
    await refused(checkout, /package\.json working-tree bytes do not match HEAD/);
  });

  await t.test('staged product manifest', async () => {
    const { checkout } = await fixture('staged-package');
    await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow","staged":true}\n');
    git(checkout, 'add', 'package.json');
    await refused(checkout, /package\.json has staged content or mode changes that do not match HEAD/);
  });

  await t.test('symbolic-link installer', async () => {
    const { checkout } = await fixture('symlink-installer');
    await writeFile(path.join(checkout, 'replacement.sh'), '#!/usr/bin/env bash\nprintf "invoked\\n" > invoked.log\n');
    await rm(path.join(checkout, 'install.sh'));
    await symlink('replacement.sh', path.join(checkout, 'install.sh'));
    await refused(checkout, /install\.sh is missing, is not a regular file, or is a symbolic link/);
  });
});

test('fresh-install CLI refuses dirty tracked reset source before invoking the reviewed installer', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-cli-dirty-source-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Install Source Tester');
  git(checkout, 'config', 'user.email', 'fresh-install-source@example.com');
  await mkdir(path.join(checkout, 'scripts'));
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow"}\n');
  await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nprintf "invoked\\n" > invoked.log\n');
  await writeFile(path.join(checkout, 'scripts', 'fresh-install-reset.mjs'), 'export const reviewed = true;\n');
  await chmod(path.join(checkout, 'install.sh'), 0o755);
  git(checkout, 'add', 'package.json', 'install.sh', 'scripts/fresh-install-reset.mjs');
  git(checkout, 'commit', '-m', 'reviewed fresh-install source');
  await writeFile(path.join(checkout, 'scripts', 'fresh-install-reset.mjs'), 'throw new Error("unreviewed source ran");\n');

  const result = command(process.execPath, [cli, 'fresh-install', '--checkout', checkout], packageRoot, { ok: false });
  assert.match(result.stderr, /checkout has staged, modified, or unreviewed untracked files/);
  assert.match(result.stderr, /scripts\/fresh-install-reset\.mjs/);
  assert.match(result.stderr, /Commit, stash, or remove the reviewed source changes/);
  assert.equal(await missing(path.join(checkout, 'invoked.log')), true);
});

test('fresh-install CLI refuses untracked checkout input before the verified installer can run', async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), 'sflow-fresh-cli-untracked-source-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Fresh Install Source Tester');
  git(checkout, 'config', 'user.email', 'fresh-install-source@example.com');
  await mkdir(path.join(checkout, 'scripts'));
  await writeFile(path.join(checkout, 'package.json'), '{"name":"singularity-flow"}\n');
  await writeFile(path.join(checkout, 'install.sh'), '#!/usr/bin/env bash\nprintf "invoked\\n" > invoked.log\n');
  await chmod(path.join(checkout, 'install.sh'), 0o755);
  git(checkout, 'add', 'package.json', 'install.sh');
  git(checkout, 'commit', '-m', 'reviewed fresh-install source');
  await writeFile(path.join(checkout, 'scripts', 'fresh-install-reset.mjs'), 'throw new Error("unreviewed source ran");\n');

  const result = command(process.execPath, [cli, 'fresh-install', '--checkout', checkout], packageRoot, { ok: false });
  assert.match(result.stderr, /checkout has staged, modified, or unreviewed untracked files/);
  assert.match(result.stderr, /\?\? scripts\/fresh-install-reset\.mjs/);
  assert.equal(await missing(path.join(checkout, 'invoked.log')), true);
});
