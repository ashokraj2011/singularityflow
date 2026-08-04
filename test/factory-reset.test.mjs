import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

function command(executable, args, cwd, { ok = true } = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' }
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
  assert.equal(await readFile(workflow, 'utf8').then((text) => text.includes('local customization')), true);

  const refused = command(process.execPath, [cli, 'factory-reset', '--confirm', 'RESET WRONG'], root, { ok: false });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /requires exact confirmation/);

  // This repository deliberately has uncommitted reset-scope changes, so the discard is explicit.
  const dirty = command(process.execPath, [cli, 'factory-reset', '--confirm', plan.confirmation], root, { ok: false });
  assert.match(dirty.stderr, /would discard uncommitted changes/);

  const reset = command(process.execPath, [
    cli, 'factory-reset', '--confirm', plan.confirmation, '--allow-dirty', '--json'
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
  command(process.execPath, [cli, 'factory-reset', '--confirm', plan.confirmation, '--json'], root);

  await writeFile(path.join(root, 'singularity', 'workflow.yml'),
    `${await readFile(path.join(root, 'singularity', 'workflow.yml'), 'utf8')}\n# unsaved\n`);
  const refused = command(process.execPath, [cli, 'factory-reset', '--confirm', plan.confirmation], root, { ok: false });
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
  assert.deepEqual(preview.installerGeneratedPaths, [
    path.join(checkout, '.github', 'agents'),
    path.join(checkout, 'singularity')
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
