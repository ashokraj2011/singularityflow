import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { bootstrapRepository } from '../src/bootstrap.mjs';
import { createWorkspaceConfiguration, rememberWorkspace } from '../src/workspace.mjs';
import { isStoryDiscoveryBranch } from '../src/session-remote-url-discovery.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

test('Story discovery ignores framework authority refs but keeps ordinary Story branches', () => {
  assert.equal(isStoryDiscoveryBranch('migration'), true);
  assert.equal(isStoryDiscoveryBranch('story/MIGRATION-1'), true);
  assert.equal(isStoryDiscoveryBranch('sflow/config'), false);
  assert.equal(isStoryDiscoveryBranch('sflow/config-change/capability/map-app'), false);
  assert.equal(isStoryDiscoveryBranch('sflow/config-history/abc123'), false);
  assert.equal(isStoryDiscoveryBranch('state'), false);
});

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}

function flow(cwd, args, agent = 'product-owner') {
  return run(process.execPath, [bin, ...args], cwd, { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Handoff Tester', SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'feature', agent }) });
}

function identity(root, name) {
  run('git', ['config', 'user.name', name], root);
  run('git', ['config', 'user.email', `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`], root);
}

test('another clone discovers a remote work ID, attaches safely, and fast-forwards each new Copilot session', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-handoff-'));
  const remote = path.join(base, 'remote.git');
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');

  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', first], base);
  identity(first, 'First Contributor');
  await writeFile(path.join(first, 'README.md'), '# Handoff test\n');
  run('git', ['add', 'README.md'], first);
  run('git', ['commit', '-m', 'initial'], first);
  run('git', ['remote', 'add', 'origin', remote], first);
  flow(first, ['init']);
  const configPath = path.join(first, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities ?? {})) authority.allowAnyGitIdentity = true;
  for (const phase of Object.values(config.phases ?? {})) if (phase.approval && phase.approval !== 'none') phase.approval.allowSelfApproval = true;
  await writeFile(configPath, YAML.stringify(config));
  run('git', ['add', 'singularity', '.github/agents'], first);
  run('git', ['commit', '-m', 'configure workflow'], first);
  run('git', ['push', '-u', 'origin', 'main'], first);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  flow(first, ['start', 'HAND-101', '--from-branch', 'main', '--ref', 'story/HAND-101-delivery', '--title', 'Handoff test']);
  const intakePath = path.join(first, 'singularity', 'work-items', 'HAND-101', 'artifacts', 'intake', 'intake.md');
  const intake = (await readFile(intakePath, 'utf8')).replace(/TODO:[^\n]*/g, 'Complete handoff evidence and measurable outcomes for another terminal.');
  await writeFile(intakePath, intake);
  flow(first, ['phase', 'publish', 'intake']);
  flow(first, ['submit']);
  const pending = JSON.parse(flow(first, ['inbox', '--json']).stdout);
  assert.equal(pending.remote, 'origin');
  assert.equal(pending.count, 1);
  assert.equal(pending.items[0].id, 'HAND-101');
  assert.equal(pending.items[0].phase, 'intake');
  assert.equal(pending.items[0].approvalsReceived, 0);
  assert.equal(pending.items[0].approvalsRequired, 1);
  assert.match(pending.items[0].artifact, /HAND-101\/artifacts\/intake\/intake\.md$/);
  assert.match(pending.items[0].commands.attach, /session attach HAND-101/);
  assert.match(flow(first, ['inbox']).stdout, /Pending approval inbox[\s\S]*HAND-101[\s\S]*intake/);
  flow(first, ['approve', '--yes']);
  assert.equal(JSON.parse(flow(first, ['inbox', '--json']).stdout).count, 0);

  // An unreadable published branch must be reported without hiding the valid Story.
  run('git', ['switch', '-c', 'invalid-story'], first);
  const invalidPath = path.join(first, 'singularity', 'work-items', 'BROKEN', 'workflow.json');
  await mkdir(path.dirname(invalidPath), { recursive: true });
  await writeFile(invalidPath, '{broken json\n');
  run('git', ['add', 'singularity/work-items/BROKEN/workflow.json'], first);
  run('git', ['commit', '-m', 'add unreadable Story state'], first);
  run('git', ['push', '-u', 'origin', 'invalid-story'], first);
  run('git', ['switch', 'story/HAND-101-delivery'], first);

  run('git', ['clone', '--no-hardlinks', remote, second], base);
  identity(second, 'Second Contributor');
  // A single-branch fetch setting and dirty checkout must not conceal remote Story refs.
  run('git', ['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main'], second);
  const localNote = path.join(second, 'local-note.txt');
  await writeFile(localNote, 'keep local work\n');
  const started = spawnSync(process.execPath, [bin, 'hook', 'session-start'], {
    cwd: second, encoding: 'utf8', input: JSON.stringify({ cwd: second, sessionId: 'copilot-second-1', source: 'startup' }),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Second Contributor' }
  });
  assert.equal(started.status, 0);
  assert.match(JSON.parse(started.stdout).additionalContext, /work-item selection is required/);
  const candidates = JSON.parse(flow(second, ['session', 'candidates', '--json']).stdout);
  assert.ok(candidates.some((item) => item.id === 'HAND-101' && item.phase === 'requirements'));
  const discovered = JSON.parse(flow(second, ['session', 'candidates', '--json', '--diagnostics']).stdout);
  assert.ok(discovered.items.some((item) => item.id === 'HAND-101'));
  assert.ok(discovered.unavailable.some((entry) => entry.claimedId === 'BROKEN'));
  assert.equal(discovered.fetched, true);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'main');
  assert.equal(run('git', ['config', '--get', 'remote.origin.fetch'], second).stdout.trim(),
    '+refs/heads/main:refs/remotes/origin/main');
  assert.equal(await readFile(localNote, 'utf8'), 'keep local work\n');
  await unlink(localNote);
  assert.match(flow(second, ['session', 'attach', 'HAND-101']).stdout, /Attached to HAND-101 from origin\/story\/HAND-101-delivery/);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'story/HAND-101-delivery');

  // Copilot may itself be rooted in another Git checkout. An unrelated .git directory must not
  // shadow the explicitly selected workspace repository after session attachment.
  const unrelatedGit = path.join(base, 'copilot-host-repository');
  const activeWorkspace = path.join(base, 'active-workspace.json');
  const workspaceRegistry = path.join(base, 'workspaces.json');
  run('git', ['init', '-b', 'main', unrelatedGit], base);
  await writeFile(activeWorkspace, `${JSON.stringify({
    schemaVersion: 1,
    workspaceId: 'handoff-workspace',
    workspaceName: 'Handoff workspace',
    workspacePath: base,
    repositoryId: 'application',
    repositoryPath: second,
    repositoryState: 'ready',
    branch: 'story/HAND-101-delivery',
    capabilities: [],
    repositoryCapabilities: [],
    storyId: 'HAND-101',
    selectedAt: '2026-08-26T00:00:00.000Z'
  }, null, 2)}\n`);
  const routed = spawnSync(process.execPath, [bin, 'progress', 'HAND-101', '--markdown'], {
    cwd: unrelatedGit,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Second Contributor',
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: activeWorkspace,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: workspaceRegistry
    }
  });
  assert.equal(routed.status, 0, routed.stderr);
  assert.match(routed.stdout, /# Workflow progress — HAND-101/);

  let session = JSON.parse(flow(second, ['session', 'status', '--json']).stdout);
  assert.equal(session.workItemSelectionRequired, false);
  assert.equal(session.selectionRequired, false);
  assert.equal(session.ready, true);
  assert.equal(session.activeAgent, 'product-owner');
  flow(second, ['agent', 'HAND-101', '--agent', 'architect']);
  session = JSON.parse(flow(second, ['session', 'status', '--json']).stdout);
  assert.equal(session.ready, true);
  assert.equal(session.activeAgent, 'architect');
  const workflow = JSON.parse(await readFile(path.join(second, 'singularity', 'work-items', 'HAND-101', 'workflow.json'), 'utf8'));
  assert.equal(workflow.currentPhase, 'requirements');

  await writeFile(path.join(first, 'handoff-note.txt'), 'Remote handoff update\n');
  run('git', ['add', 'handoff-note.txt'], first);
  run('git', ['commit', '-m', 'HAND-101 add handoff note'], first);
  run('git', ['push'], first);

  const restarted = spawnSync(process.execPath, [bin, 'hook', 'session-start'], {
    cwd: second, encoding: 'utf8', input: JSON.stringify({ cwd: second, sessionId: 'copilot-second-2', source: 'startup' }),
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Second Contributor' }
  });
  assert.match(JSON.parse(restarted.stdout).additionalContext, /work-item selection is required/);
  flow(second, ['session', 'attach', 'HAND-101']);
  assert.equal(await readFile(path.join(second, 'handoff-note.txt'), 'utf8'), 'Remote handoff update\n');
  assert.equal(run('git', ['status', '--porcelain'], second).stdout.trim(), '');

  await writeFile(path.join(second, 'local-only.txt'), 'preserve me\n');
  const dirty = spawnSync(process.execPath, [bin, 'session', 'attach', 'HAND-101'], { cwd: second, encoding: 'utf8' });
  assert.equal(dirty.status, 0);
  assert.match(dirty.stdout, /Attached to HAND-101 from origin\/story\/HAND-101-delivery/);
  assert.equal(await readFile(path.join(second, 'local-only.txt'), 'utf8'), 'preserve me\n');
  await unlink(path.join(second, 'local-only.txt'));

  run('git', ['switch', 'main'], second);
  await writeFile(path.join(second, 'wrong-branch-change.txt'), 'must not cross branches\n');
  const dirtyCheckout = spawnSync(process.execPath, [bin, 'session', 'attach', 'HAND-101'], { cwd: second, encoding: 'utf8' });
  assert.equal(dirtyCheckout.status, 1);
  assert.match(dirtyCheckout.stderr, /Working tree is not clean/);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'main');
  assert.equal(await readFile(path.join(second, 'wrong-branch-change.txt'), 'utf8'), 'must not cross branches\n');
  await unlink(path.join(second, 'wrong-branch-change.txt'));
  flow(second, ['session', 'attach', 'HAND-101']);

  await writeFile(path.join(second, 'ahead.txt'), 'local commit must survive\n');
  run('git', ['add', 'ahead.txt'], second);
  run('git', ['commit', '-m', 'local unpushed work'], second);
  const aheadHead = run('git', ['rev-parse', 'HEAD'], second).stdout.trim();
  const ahead = spawnSync(process.execPath, [bin, 'session', 'attach', 'HAND-101'], { cwd: second, encoding: 'utf8' });
  assert.equal(ahead.status, 1);
  assert.match(ahead.stderr, /contains commits that are not on origin\/story\/HAND-101-delivery/);
  assert.equal(run('git', ['rev-parse', 'HEAD'], second).stdout.trim(), aheadHead);
  assert.equal(await readFile(path.join(second, 'ahead.txt'), 'utf8'), 'local commit must survive\n');
});

test('a fresh production-bootstrap clone discovers and attaches a published Story', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-bootstrap-handoff-'));
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  const second = path.join(base, 'second');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', seed], base);
  identity(seed, 'Bootstrap Seed');
  await writeFile(path.join(seed, 'README.md'), '# Bootstrap handoff\n');
  run('git', ['add', '.'], seed);
  run('git', ['commit', '-m', 'initial'], seed);
  run('git', ['push', remote, 'main:main'], seed);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);

  const boot = await bootstrapRepository(remote, {
    capabilityId: 'handoff', capabilityName: 'Handoff', base: path.join(base, 'work'), stateBranch: null
  });
  assert.equal(spawnSync('git', ['cat-file', '-e', 'main:singularity/workflow.yml'], {
    cwd: boot.root, encoding: 'utf8'
  }).status, 128, 'production main intentionally has no workflow definition');
  flow(boot.root, [
    'start', 'BOOT-101', '--from-branch', 'main', '--title', 'Bootstrap handoff', '--work-type', 'feature'
  ]);

  const bootBranch = run('git', ['branch', '--show-current'], boot.root).stdout.trim();
  run('git', ['switch', '-c', 'malformed-url-discovery'], boot.root);
  const brokenRemoteState = path.join(boot.root, 'singularity', 'work-items', 'BROKEN', 'workflow.json');
  await mkdir(path.dirname(brokenRemoteState), { recursive: true });
  await writeFile(brokenRemoteState, '{broken json\n');
  run('git', ['add', 'singularity/work-items/BROKEN/workflow.json'], boot.root);
  run('git', ['commit', '-m', 'add malformed Story metadata'], boot.root);
  run('git', ['push', '-u', 'origin', 'malformed-url-discovery'], boot.root);
  run('git', ['switch', bootBranch], boot.root);

  // A capability can expose published Stories before its delivery repository is cloned locally.
  run('git', ['config', 'uploadpack.allowFilter', 'true'], remote);
  const remoteOnly = spawnSync(process.execPath, [
    bin, 'session', 'candidates', '--repository-url', pathToFileURL(remote).href,
    '--json', '--diagnostics'
  ], {
    cwd: base, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'unselected-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'unselected-workspace.json')
    }
  });
  assert.equal(remoteOnly.status, 0, remoteOnly.stderr);
  const remoteDiscovery = JSON.parse(remoteOnly.stdout);
  assert.equal(remoteDiscovery.source, 'remote-url');
  assert.equal(remoteDiscovery.repositoryPath, null);
  assert.ok(remoteDiscovery.items.some((item) => item.id === 'BOOT-101'));
  assert.ok(remoteDiscovery.unavailable.some((entry) => entry.claimedId === 'BROKEN'));

  // A mapped delivery repository may publish Stories while the lead repository alone owns
  // approved configuration. Both URL authorities must be explicit before a local clone exists.
  const delivery = path.join(base, 'delivery.git');
  run('git', ['init', '--bare', delivery], base);
  run('git', [
    'push', delivery,
    `refs/heads/${bootBranch}:refs/heads/${bootBranch}`,
    'refs/heads/malformed-url-discovery:refs/heads/malformed-url-discovery'
  ], remote);
  run('git', ['config', 'uploadpack.allowFilter', 'true'], delivery);
  const withoutLead = spawnSync(process.execPath, [
    bin, 'session', 'candidates', '--repository-url', pathToFileURL(delivery).href,
    '--json', '--diagnostics'
  ], { cwd: base, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.equal(withoutLead.status, 1);
  assert.match(withoutLead.stderr, /SESSION_REMOTE_CONFIGURATION_REQUIRED/);
  const separateLead = spawnSync(process.execPath, [
    bin, 'session', 'candidates', '--repository-url', pathToFileURL(delivery).href,
    '--configuration-url', pathToFileURL(remote).href, '--json', '--diagnostics'
  ], { cwd: base, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.equal(separateLead.status, 0, separateLead.stderr);
  const separateDiscovery = JSON.parse(separateLead.stdout);
  assert.equal(separateDiscovery.source, 'remote-url');
  assert.equal(separateDiscovery.repositoryPath, null);
  assert.ok(separateDiscovery.items.some((item) => item.id === 'BOOT-101'));
  assert.ok(separateDiscovery.unavailable.some((entry) => entry.claimedId === 'BROKEN'));
  run('git', ['config', 'uploadpack.allowFilter', 'false'], delivery);
  const unsupportedDelivery = spawnSync(process.execPath, [
    bin, 'session', 'candidates', '--repository-url', pathToFileURL(delivery).href,
    '--configuration-url', pathToFileURL(remote).href, '--json', '--diagnostics'
  ], { cwd: base, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.equal(unsupportedDelivery.status, 1);
  assert.match(unsupportedDelivery.stderr, /SESSION_REMOTE_FILTER_UNSUPPORTED/);
  run('git', ['config', 'uploadpack.allowFilter', 'true'], delivery);
  run('git', ['config', 'uploadpack.allowFilter', 'false'], remote);
  const unsupportedFilter = spawnSync(process.execPath, [
    bin, 'session', 'candidates', '--repository-url', pathToFileURL(remote).href,
    '--json', '--diagnostics'
  ], { cwd: base, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.equal(unsupportedFilter.status, 1);
  assert.match(unsupportedFilter.stderr, /SESSION_REMOTE_FILTER_UNSUPPORTED/);
  assert.equal(unsupportedFilter.stdout.trim(), '');
  run('git', ['config', 'uploadpack.allowFilter', 'true'], remote);

  // A Windows-style blobless workspace has branch trees but may not yet hold the Story state
  // blobs. Candidate refresh must explicitly recover only bounded metadata, with no checkout or
  // source hydration, and must not count SFlow's own review refs as unreadable Stories.
  const partial = path.join(base, 'partial');
  run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--single-branch',
    '--branch', 'main', pathToFileURL(remote).href, partial], base);
  const partialHead = run('git', ['rev-parse', 'HEAD'], partial).stdout.trim();
  const partialCandidates = spawnSync(process.execPath, [
    bin, 'session', 'candidates', '--json', '--diagnostics'
  ], {
    cwd: partial, encoding: 'utf8', env: {
      ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'partial-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'partial-selection.json')
    }
  });
  assert.equal(partialCandidates.status, 0, partialCandidates.stderr);
  const partialDiscovery = JSON.parse(partialCandidates.stdout);
  assert.equal(partialDiscovery.source, 'materialized-metadata-recovery');
  assert.ok(partialDiscovery.items.some((item) => item.id === 'BOOT-101'));
  assert.equal(partialDiscovery.unavailable.some((item) => item.branch?.startsWith('sflow/')), false);
  assert.equal(run('git', ['rev-parse', 'HEAD'], partial).stdout.trim(), partialHead);
  assert.equal(run('git', ['branch', '--show-current'], partial).stdout.trim(), 'main');
  assert.notEqual(spawnSync('git', ['cat-file', '-e', 'HEAD:README.md'], {
    cwd: partial, encoding: 'utf8', env: { ...process.env, GIT_NO_LAZY_FETCH: '1' }
  }).status, 0, 'Story metadata discovery must not fetch the application README blob');

  // The same metadata-only candidate must be attachable. Attach admits the exact pinned Story
  // blobs before switching, rather than treating a partial local index as "no governed Story".
  // --no-checkout deliberately left the worktree unpopulated (and therefore dirty). Materialize
  // only the governed sparse cone so attach's ordinary clean-tree protection can remain strict.
  run('git', ['sparse-checkout', 'init', '--cone'], partial);
  run('git', ['sparse-checkout', 'set', 'singularity'], partial);
  run('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', 'README.md'], partial);
  identity(partial, 'Partial Clone Contributor');
  const partialAttached = JSON.parse(run(process.execPath, [
    bin, 'session', 'attach', 'BOOT-101', '--json'
  ], partial, {
    ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Partial Clone Contributor',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'partial-workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'partial-selection.json')
  }).stdout);
  assert.equal(partialAttached.workId, 'BOOT-101');
  assert.equal(run('git', ['branch', '--show-current'], partial).stdout.trim(), 'BOOT-101');
  assert.equal(partialAttached.commit, run('git', ['rev-parse', 'HEAD'], partial).stdout.trim());

  // An explicitly selected deferred workspace repository is discoverable without a clone. An
  // unknown Story must not clone it; the exact published Story may materialize only that member.
  const deferred = await createWorkspaceConfiguration({
    baseDirectory: path.join(base, 'deferred-workspaces'),
    id: 'handoff-workspace', name: 'Handoff workspace', leadRepository: 'application',
    repositories: {
      application: {
        url: pathToFileURL(remote).href, defaultBranch: 'main',
        path: 'repos/application', required: true
      },
      reference: {
        url: pathToFileURL(remote).href, defaultBranch: 'main',
        path: 'repos/reference', required: false
      }
    }, capabilities: []
  }, { confirmation: 'handoff-workspace', clone: false });
  const deferredRegistry = path.join(base, 'deferred-registry.json');
  await rememberWorkspace(deferredRegistry, deferred.workspace, deferred.status);
  const deferredEnv = {
    ...process.env, NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Deferred Workspace Contributor',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: deferredRegistry,
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'deferred-selection.json')
  };
  const selector = [
    '--workspace', deferred.workspace.path, '--repository', 'application'
  ];
  const deferredRepository = path.join(deferred.workspace.path, 'repos/application');
  const unselectedRepository = path.join(deferred.workspace.path, 'repos/reference');
  const ambiguousSelector = spawnSync(process.execPath, [bin,
    'session', 'candidates', '--workspace', deferred.workspace.path, '--json'
  ], { cwd: base, encoding: 'utf8', env: deferredEnv });
  assert.notEqual(ambiguousSelector.status, 0);
  assert.match(ambiguousSelector.stderr, /--repository <ID>/);
  const deferredCandidates = JSON.parse(run(process.execPath, [bin,
    'session', 'candidates', ...selector, '--json', '--diagnostics'
  ], base, deferredEnv).stdout);
  assert.equal(deferredCandidates.source, 'remote-url');
  assert.ok(deferredCandidates.items.some((item) => item.id === 'BOOT-101'));
  const unknownDeferred = spawnSync(process.execPath, [bin,
    'session', 'attach', 'NOT-A-STORY', ...selector, '--json'
  ], { cwd: base, encoding: 'utf8', env: deferredEnv });
  assert.notEqual(unknownDeferred.status, 0);
  assert.equal(spawnSync('git', ['-C', deferredRepository, 'rev-parse', '--is-inside-work-tree'], {
    cwd: base, encoding: 'utf8'
  }).status, 128, 'an unknown Story must not materialize the selected repository');
  const malformedDeferred = spawnSync(process.execPath, [bin,
    'session', 'attach', 'BROKEN', ...selector, '--json'
  ], { cwd: base, encoding: 'utf8', env: deferredEnv });
  assert.notEqual(malformedDeferred.status, 0);
  assert.equal(spawnSync('git', ['-C', deferredRepository, 'rev-parse', '--is-inside-work-tree'], {
    cwd: base, encoding: 'utf8'
  }).status, 128, 'a malformed Story must not materialize the selected repository');
  const deferredAttached = JSON.parse(run(process.execPath, [bin,
    'session', 'attach', 'BOOT-101', ...selector, '--json'
  ], base, deferredEnv).stdout);
  assert.equal(deferredAttached.workId, 'BOOT-101');
  assert.equal(deferredAttached.repositoryPath, deferredRepository);
  assert.equal(run('git', ['branch', '--show-current'], deferredRepository).stdout.trim(), 'BOOT-101');
  assert.equal(spawnSync('git', ['-C', unselectedRepository, 'rev-parse', '--is-inside-work-tree'], {
    cwd: base, encoding: 'utf8'
  }).status, 128, 'attaching application must not clone another mapped repository');

  run('git', ['clone', '--no-hardlinks', remote, second], base);
  identity(second, 'Second Bootstrap Contributor');
  const isolated = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Second Bootstrap Contributor',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active-workspace.json')
  };
  const started = spawnSync(process.execPath, [bin, 'hook', 'session-start'], {
    cwd: second, encoding: 'utf8', input: JSON.stringify({ cwd: second, sessionId: 'bootstrap-second-1' }),
    env: isolated
  });
  assert.equal(started.status, 0);
  assert.match(JSON.parse(started.stdout).additionalContext, /work-item selection is required/);
  // An older application checkout may contain a malformed workflow copy. Session discovery must
  // use the approved sflow/config ref instead of treating that working-tree file as authority.
  await mkdir(path.join(second, 'singularity'));
  await writeFile(path.join(second, 'singularity', 'workflow.yml'), 'workflow: [unfinished\n');
  const candidates = JSON.parse(run(process.execPath, [bin, 'session', 'candidates', '--json'], second, isolated).stdout);
  assert.ok(candidates.some((item) => item.id === 'BOOT-101'));
  await unlink(path.join(second, 'singularity', 'workflow.yml'));
  await rmdir(path.join(second, 'singularity'));
  assert.match(run(process.execPath, [bin, 'resume', 'BOOT-101', '--fetch'], second, isolated).stdout, /BOOT-101/);
  run('git', ['switch', 'main'], second);
  run('git', ['remote', 'set-url', 'origin', path.join(base, 'temporarily-offline.git')], second);
  const unavailable = spawnSync(process.execPath,
    [bin, 'session', 'candidates', '--json', '--diagnostics'],
    { cwd: second, encoding: 'utf8', env: isolated });
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /REMOTE_REMOTE_NOT_FOUND/);
  assert.equal(unavailable.stdout.trim(), '');
  assert.match(run(process.execPath, [bin, 'start', 'BOOT-101'], second, isolated).stdout, /BOOT-101/);
  run('git', ['remote', 'set-url', 'origin', remote], second);
  run('git', ['switch', 'main'], second);
  assert.match(run(process.execPath, [bin, 'start', 'BOOT-101'], second, isolated).stdout, /BOOT-101/);
  run('git', ['switch', 'main'], second);
  assert.match(run(process.execPath, [bin, 'session', 'attach', 'BOOT-101'], second, isolated).stdout,
    /Attached to BOOT-101 from origin\/BOOT-101/);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'BOOT-101');
  assert.equal(run('git', ['rev-parse', 'HEAD'], second).stdout, run('git', ['rev-parse', 'origin/BOOT-101'], second).stdout);
});

test('remote Story discovery uses each branch pinned ID policy and state root', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-pinned-handoff-'));
  const remote = path.join(base, 'remote.git');
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');
  run('git', ['init', '--bare', remote], base);
  run('git', ['init', '-b', 'main', first], base);
  identity(first, 'First Pinned Contributor');
  await writeFile(path.join(first, 'README.md'), '# Pinned handoff\n');
  flow(first, ['init']);
  run('git', ['add', '.'], first);
  run('git', ['commit', '-m', 'initial governance'], first);
  run('git', ['remote', 'add', 'origin', remote], first);
  run('git', ['push', '-u', 'origin', 'main'], first);
  run('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  flow(first, ['start', 'OLD-101', '--from-branch', 'main', '--title', 'Pinned Story']);

  run('git', ['switch', 'main'], first);
  const definitionPath = path.join(first, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionPath, 'utf8'));
  definition.idPattern = '^NEW-[0-9]+$';
  definition.workItemRoot = 'governed/items';
  await writeFile(definitionPath, YAML.stringify(definition));
  run('git', ['add', definitionPath], first);
  run('git', ['commit', '-m', 'change policy for future Stories'], first);
  run('git', ['push', 'origin', 'main'], first);

  run('git', ['clone', '--no-hardlinks', remote, second], base);
  identity(second, 'Second Pinned Contributor');
  const candidates = JSON.parse(flow(second, ['session', 'candidates', '--json']).stdout);
  assert.ok(candidates.some((item) => item.id === 'OLD-101'));
  assert.match(flow(second, ['resume', 'OLD-101', '--fetch']).stdout, /OLD-101/);
  run('git', ['switch', 'main'], second);
  assert.match(flow(second, ['start', 'OLD-101']).stdout, /OLD-101/);
  run('git', ['switch', 'main'], second);
  assert.match(flow(second, ['session', 'attach', 'OLD-101']).stdout,
    /Attached to OLD-101 from origin\/OLD-101/);
  assert.equal(run('git', ['branch', '--show-current'], second).stdout.trim(), 'OLD-101');
});

test('session attach fails non-zero when no governed repository can be resolved', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'singularity-flow-no-session-repository-'));
  run('git', ['init', '-b', 'main'], root);
  const result = spawnSync(process.execPath, [bin, 'session', 'attach', 'MISSING-1'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, 'active-workspace.json')
    }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot attach a Story because no governed repository is active/);
  const discovery = spawnSync(process.execPath,
    [bin, 'session', 'candidates', '--json', '--diagnostics'], {
      cwd: root, encoding: 'utf8', env: {
        ...process.env,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, 'workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, 'active-workspace.json')
      }
    });
  assert.equal(discovery.status, 1);
  assert.match(discovery.stderr, /SESSION_REPOSITORY_REQUIRED/);
  assert.equal(discovery.stdout.trim(), '');
});
