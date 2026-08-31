import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';
import { rollbackStoryWorktree } from '../src/story-worktree.mjs';
import { createWorkflow, loadConfig } from '../src/state.mjs';
import { preflightFetchedStoryCapability } from '../src/commands/story.mjs';

const cli = path.resolve('bin/singularity-flow.mjs');

function run(command, args, cwd, { allowFailure = false, env = {} } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      SINGULARITY_FLOW_TEST_IDENTITY: 'Worktree Story Tester',
      ...env
    }
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function repository(t, {
  workItemRoot = 'singularity/work-items', repositoryRelative = 'repository'
} = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-story-worktree-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, repositoryRelative);
  await mkdir(root, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], root);
  run('git', ['config', 'user.name', 'Worktree Story Tester'], root);
  run('git', ['config', 'user.email', 'worktree-story@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# isolated Story test\n');
  run(process.execPath, [cli, 'init'], root);
  const definitionFile = path.join(root, 'singularity/workflow.yml');
  const definition = YAML.parse(await readFile(definitionFile, 'utf8'));
  definition.git.publish = 'off';
  definition.workItemRoot = workItemRoot;
  await writeFile(definitionFile, YAML.stringify(definition));
  run('git', ['add', '.'], root);
  run('git', ['commit', '-q', '-m', 'initialize'], root);
  const remote = path.join(base, 'remote.git');
  run('git', ['init', '--bare', '-q', '-b', 'main', remote], base);
  run('git', ['remote', 'add', 'origin', remote], root);
  run('git', ['push', '-q', '-u', 'origin', 'main'], root);
  return { base, root };
}

function git(root, args) {
  return run('git', args, root).stdout.trim();
}

test('a dirty prior checkout cannot block a new Story and is never mutated', async (t) => {
  const { root } = await repository(t);
  run('git', ['switch', '-q', '-c', 'CANCELLED-PRIOR'], root);
  await writeFile(path.join(root, 'unfinished-prior-story.txt'), 'keep this exact local work\n');
  const beforeHead = git(root, ['rev-parse', 'HEAD']);

  const started = run(process.execPath, [cli,
    'start', 'ISO-STORY-1', '--json', '--from-branch', 'main', '--work-type', 'feature',
    '--title', 'Start independently', '--description', 'Do not disturb the prior checkout.'
  ], root);
  const result = JSON.parse(started.stdout);
  const worktree = result.data.repositoryPath;

  assert.notEqual(path.resolve(worktree), path.resolve(root));
  assert.equal(git(root, ['branch', '--show-current']), 'CANCELLED-PRIOR');
  assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead);
  assert.match(git(root, ['status', '--porcelain']), /unfinished-prior-story\.txt/);
  assert.equal(await readFile(path.join(root, 'unfinished-prior-story.txt'), 'utf8'), 'keep this exact local work\n');
  assert.equal(git(worktree, ['branch', '--show-current']), 'ISO-STORY-1');
  assert.equal(JSON.parse(await readFile(path.join(
    worktree, 'singularity/work-items/ISO-STORY-1/workflow.json'
  ), 'utf8')).workItem.id, 'ISO-STORY-1');
  assert.equal(result.data.worktree.isolated, true);
});

test('an inferred capability remains bound to the exact approved map digest', async (t) => {
  const { root } = await repository(t);
  const approved = YAML.stringify({
    version: 1,
    capabilities: {
      product: {
        name: 'Approved Product', kind: 'delivery', parent: null,
        repository: 'repository', policy: { gitPublication: 'off' }
      }
    }
  });
  const changed = YAML.stringify({
    version: 1,
    capabilities: {
      product: {
        name: 'Changed Product', kind: 'delivery', parent: null,
        repository: 'repository', policy: { gitPublication: 'off' }
      }
    }
  });
  await writeFile(path.join(root, 'singularity/capabilities.yml'), changed);
  run('git', ['add', 'singularity/capabilities.yml'], root);
  run('git', ['commit', '-qm', 'change capability map before creation'], root);
  run('git', ['switch', '-q', '-c', 'INFERRED-CAP-DRIFT'], root);
  const config = await loadConfig(root);

  await assert.rejects(() => createWorkflow(root, config, {
    id: 'INFERRED-CAP-DRIFT',
    title: 'Bind an inferred capability',
    source: {
      type: 'manual', id: 'INFERRED-CAP-DRIFT', title: 'Bind an inferred capability',
      description: 'The capability is inferred from the only delivery in the map.',
      acceptanceCriteria: ['The approved map digest remains authoritative.']
    },
    baseBranch: 'main',
    workType: 'quick-fix',
    agent: 'developer',
    capabilityMapSha256: createHash('sha256').update(approved).digest('hex')
  }), (error) => error.code === 'STORY_CONFIGURATION_AUTHORITY_STALE'
    && error.details?.capabilityId === 'product');
  await assert.rejects(
    access(path.join(root, 'singularity/work-items/INFERRED-CAP-DRIFT/workflow.json')),
    (error) => error.code === 'ENOENT'
  );
});

test('a preflighted capability map cannot disappear or become capability-free before creation', async (t) => {
  for (const replacement of [
    { label: 'missing', contents: null },
    {
      label: 'collection-only',
      contents: YAML.stringify({
        version: 1,
        capabilities: {
          platform: { name: 'Platform', kind: 'collection', parent: null, policy: {} }
        }
      })
    }
  ]) {
    await t.test(replacement.label, async (st) => {
      const { root } = await repository(st);
      const approved = YAML.stringify({
        version: 1,
        capabilities: {
          product: {
            name: 'Approved Product', kind: 'delivery', parent: null,
            repository: 'repository', policy: { gitPublication: 'off' }
          }
        }
      });
      const capabilityPath = path.join(root, 'singularity/capabilities.yml');
      await writeFile(capabilityPath, approved);
      run('git', ['add', 'singularity/capabilities.yml'], root);
      run('git', ['commit', '-qm', 'approve capability map'], root);
      const id = `CAP-MAP-${replacement.label.toUpperCase()}`;
      run('git', ['switch', '-q', '-c', id], root);
      const config = await loadConfig(root);
      if (replacement.contents == null) await rm(capabilityPath);
      else await writeFile(capabilityPath, replacement.contents);
      const expectedMapSha256 = createHash('sha256').update(approved).digest('hex');

      await assert.rejects(() => createWorkflow(root, config, {
        id,
        title: 'Keep the preflighted capability',
        source: {
          type: 'manual', id, title: 'Keep the preflighted capability',
          description: 'A map replacement cannot downgrade governed capability policy.',
          acceptanceCriteria: ['The exact preflighted map remains authoritative.']
        },
        baseBranch: 'main',
        workType: 'quick-fix',
        agent: 'developer',
        capabilityMapSha256: expectedMapSha256
      }), (error) => error.code === 'STORY_CONFIGURATION_AUTHORITY_STALE'
        && error.details?.expectedMapSha256 === expectedMapSha256
        && (replacement.contents == null
          ? error.details?.actualMapSha256 === null
          : error.details?.actualMapSha256 === createHash('sha256').update(replacement.contents).digest('hex')));
      await assert.rejects(
        access(path.join(root, `singularity/work-items/${id}/workflow.json`)),
        (error) => error.code === 'ENOENT'
      );
    });
  }
});

test('an unchanged collection-only map preserves legacy capability-free Story creation', async (t) => {
  const { root } = await repository(t);
  const collectionOnly = YAML.stringify({
    version: 1,
    capabilities: {
      platform: { name: 'Platform', kind: 'collection', parent: null, policy: {} }
    }
  });
  await writeFile(path.join(root, 'singularity/capabilities.yml'), collectionOnly);
  run('git', ['add', 'singularity/capabilities.yml'], root);
  run('git', ['commit', '-qm', 'use collection-only catalog'], root);
  const id = 'CAPABILITY-FREE';
  run('git', ['switch', '-q', '-c', id], root);
  const config = await loadConfig(root);
  const workflow = await createWorkflow(root, config, {
    id,
    title: 'Remain capability free',
    source: {
      type: 'manual', id, title: 'Remain capability free',
      description: 'A collection-only catalog does not force delivery governance.',
      acceptanceCriteria: ['Capability resolution remains optional.']
    },
    baseBranch: 'main',
    workType: 'quick-fix',
    agent: 'developer',
    capabilityMapSha256: createHash('sha256').update(collectionOnly).digest('hex')
  });
  assert.equal(workflow.resolution.capability, null);
});

test('Jira capability preflight refuses unknown IDs and carries a digest into creation', async (t) => {
  const { root } = await repository(t);
  const approved = YAML.stringify({
    version: 1,
    capabilities: {
      product: {
        name: 'Approved Product', kind: 'delivery', parent: null,
        repository: 'repository', policy: { gitPublication: 'off' }
      }
    }
  });
  const capabilityPath = path.join(root, 'singularity/capabilities.yml');
  await writeFile(capabilityPath, approved);
  run('git', ['add', 'singularity/capabilities.yml'], root);
  run('git', ['commit', '-qm', 'approve Jira capability'], root);
  const id = 'JIRA-CAPABILITY';
  run('git', ['switch', '-q', '-c', id], root);
  const before = git(root, ['rev-parse', 'HEAD']);

  await assert.rejects(
    () => preflightFetchedStoryCapability(root, { capabilityId: 'unknown-capability' }),
    (error) => error.code === 'CAPABILITY_UNKNOWN'
  );
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
  await assert.rejects(access(path.join(root, `singularity/work-items/${id}/workflow.json`)), {
    code: 'ENOENT'
  });

  const preflight = await preflightFetchedStoryCapability(root, { capabilityId: 'product' });
  assert.equal(preflight.capabilityId, 'product');
  assert.equal(preflight.capabilityMapSha256, createHash('sha256').update(approved).digest('hex'));
  const collectionOnly = YAML.stringify({
    version: 1,
    capabilities: {
      platform: { name: 'Platform', kind: 'collection', parent: null, policy: {} }
    }
  });
  await writeFile(capabilityPath, collectionOnly);
  const config = await loadConfig(root);
  await assert.rejects(() => createWorkflow(root, config, {
    id,
    title: 'Attach Jira Story',
    source: {
      type: 'jira', id, key: id, title: 'Attach Jira Story',
      description: 'The fetched capability must retain its exact map.',
      acceptanceCriteria: ['No governed publication occurs after drift.']
    },
    baseBranch: 'main',
    workType: 'quick-fix',
    agent: 'developer',
    capabilityId: preflight.capabilityId,
    capabilityMapSha256: preflight.capabilityMapSha256
  }), (error) => error.code === 'STORY_CONFIGURATION_AUTHORITY_STALE');
  assert.equal(git(root, ['rev-parse', 'HEAD']), before);
  await assert.rejects(access(path.join(root, `singularity/work-items/${id}/workflow.json`)), {
    code: 'ENOENT'
  });
});

test('isolated Story start retains an external workspace capability authority instead of a stale canonical map', async (t) => {
  const { base, root } = await repository(t, { repositoryRelative: 'repos/passistant' });
  const remote = path.join(base, 'remote.git');
  const authority = path.join(base, 'capability-authority.git');
  run('git', ['init', '--bare', '-q', '-b', 'main', authority], base);
  run('git', ['remote', 'add', 'capability-authority', authority], root);
  const approvedCapabilities = YAML.stringify({
    version: 1,
    capabilities: {
      enterprise: { kind: 'collection', parent: null, policy: {} },
      product: { kind: 'collection', parent: 'enterprise', policy: {} },
      piassistnat: {
        name: 'PI Assistant Native',
        kind: 'delivery',
        parent: 'product',
        repository: 'passistant',
        policy: { gitPublication: 'off' }
      }
    }
  });
  run('git', ['switch', '-q', '-c', 'sflow/config'], root);
  await writeFile(path.join(root, 'singularity/capabilities.yml'), approvedCapabilities);
  run('git', ['add', 'singularity/capabilities.yml'], root);
  run('git', ['commit', '-qm', 'approve piassistnat capability'], root);
  run('git', ['push', '-q', 'capability-authority', 'sflow/config'], root);
  run('git', ['switch', '-q', 'main'], root);

  const canonicalCapabilities = await readFile(path.join(root, 'singularity/capabilities.yml'), 'utf8');
  assert.doesNotMatch(canonicalCapabilities, /piassistnat/,
    'the canonical application checkout deliberately retains the generic bootstrap map');
  const approvedMapSha256 = createHash('sha256').update(approvedCapabilities).digest('hex');

  const workspace = {
    version: 1,
    id: 'local--piassist',
    name: 'PI Assistant',
    anchor: {
      provider: 'workspace', siteId: 'local', key: 'piassist', title: 'PI Assistant'
    },
    leadRepository: 'passistant',
    capabilityAuthority: { url: authority },
    repositories: {
      passistant: {
        id: 'passistant', url: remote, defaultBranch: 'main', required: true,
        path: 'repos/passistant', capabilities: ['piassistnat'],
        clone: { mode: 'full', sparseCone: [], fallback: 'refuse' }
      }
    },
    capabilities: ['piassistnat'],
    directories: {
      repositories: 'repos', documents: 'documents', logs: 'logs', jiraCache: 'cache/jira'
    },
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z'
  };
  await writeFile(path.join(base, 'workspace.json'), `${JSON.stringify(workspace, null, 2)}\n`);
  const selection = path.join(base, 'active-workspace.json');
  const registry = path.join(base, 'workspaces.json');
  await writeFile(selection, `${JSON.stringify({
    schemaVersion: 1,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePath: base,
    anchorKey: workspace.anchor.key,
    repositoryId: 'passistant',
    repositoryPath: root,
    canonicalRepositoryPath: root,
    checkoutPath: root,
    repositoryState: 'ready',
    branch: 'main',
    capabilities: ['piassistnat'],
    repositoryCapabilities: ['piassistnat'],
    storyId: null,
    selectedAt: '2026-08-31T00:00:00.000Z'
  }, null, 2)}\n`);
  await writeFile(registry, `${JSON.stringify({
    schemaVersion: 1,
    workspaces: [{
      id: workspace.id,
      path: base,
      name: workspace.name,
      anchorKey: workspace.anchor.key,
      siteId: workspace.anchor.siteId,
      leadRepositoryPath: root,
      openedAt: '2026-08-31T00:00:00.000Z',
      archivedAt: null
    }]
  }, null, 2)}\n`);
  const env = {
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: selection,
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: registry,
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json')
  };
  const current = JSON.parse(run(process.execPath, [
    cli, 'workspace', 'current', '--json'
  ], root, { env }).stdout);
  assert.equal(current.active, true);
  assert.equal(await realpath(current.repositoryPath), await realpath(root));
  assert.deepEqual(current.repositoryCapabilities, ['piassistnat']);

  const branchCatalog = JSON.parse(run(process.execPath, [
    cli, 'workspace', 'branches', '--json'
  ], root, { env }).stdout);
  assert.equal(branchCatalog.capability, 'piassistnat',
    'the new-Story branch surface must read workspace capabilityAuthority A, not member origin B');
  assert.equal(branchCatalog.scope, 'capability');

  const authorityDiagnosed = JSON.parse(run(process.execPath, [
    cli, 'capabilities', 'doctor', 'piassistnat', '--json'
  ], root, { env }).stdout);
  assert.equal(authorityDiagnosed.capability.id, 'piassistnat');
  assert.equal(authorityDiagnosed.capability.map.repository, authority,
    'online doctor must use workspace capabilityAuthority instead of the member origin');
  assert.equal(authorityDiagnosed.capability.map.sha256, approvedMapSha256);
  assert.equal(authorityDiagnosed.checks.find((item) => item.id === 'authority-freshness')?.status, 'pass');

  const started = run(process.execPath, [cli,
    'start', 'ISO-APPROVED-CAP-1', '--isolated-worktree', '--json', '--from-branch', 'main',
    '--work-type', 'quick-fix',
    '--title', 'Use the approved workspace capability',
    '--description', 'The application checkout has a stale generic map.'
  ], root, { env });
  const result = JSON.parse(started.stdout);
  const worktree = result.data.repositoryPath;
  assert.equal(result.data.capabilityBase.capability, 'piassistnat');
  const workflow = JSON.parse(await readFile(path.join(
    worktree, 'singularity/work-items/ISO-APPROVED-CAP-1/workflow.json'
  ), 'utf8'));

  assert.equal(workflow.resolution.capability.id, 'piassistnat');
  assert.equal(workflow.resolution.capability.map.sha256, approvedMapSha256);
  assert.equal(workflow.resolution.configurationSource.branch, 'sflow/config');
  assert.match(workflow.resolution.configurationSource.commit, /^[0-9a-f]{40}$/);
  assert.equal(workflow.resolution.capability.map.repository,
    workflow.resolution.configurationSource.repository);
  assert.equal(workflow.resolution.capability.map.repository, authority);
  assert.equal(workflow.resolution.capability.map.branch,
    workflow.resolution.configurationSource.branch);
  assert.equal(workflow.resolution.capability.map.commit,
    workflow.resolution.configurationSource.commit);
  assert.equal(workflow.resolution.capability.map.authority, 'pinned-story-configuration');
  const fetchedPreflight = await preflightFetchedStoryCapability(worktree, {
    capabilityId: 'piassistnat'
  });
  assert.equal(fetchedPreflight.capabilityId, 'piassistnat');
  assert.equal(fetchedPreflight.capabilityMapSha256, approvedMapSha256,
    'Jira attachment preflight must retain the fetched branch pinned catalog digest');
  assert.deepEqual(fetchedPreflight.authority, {
    repository: authority,
    branch: 'sflow/config',
    commit: workflow.resolution.configurationSource.commit,
    filesSha256: workflow.resolution.configurationSource.filesSha256
  }, 'Jira attachment preflight must report the same verified authority pinned by the Story');
  assert.match(await readFile(path.join(worktree, 'singularity/capabilities.yml'), 'utf8'), /piassistnat/);
  const diagnosed = JSON.parse(run(process.execPath, [
    cli, 'capabilities', 'doctor', 'piassistnat', '--offline', '--json'
  ], worktree, { env }).stdout);
  assert.equal(diagnosed.capability.id, 'piassistnat',
    'post-start lifecycle resolution must keep using the Story-pinned approved capability map');
  assert.equal(diagnosed.capability.map.sha256, approvedMapSha256);
  assert.equal(diagnosed.capability.map.repository, authority);
  assert.equal(diagnosed.capability.map.branch, 'sflow/config');
  assert.equal(diagnosed.capability.map.commit, workflow.resolution.configurationSource.commit);
  assert.equal(diagnosed.capability.map.authority, 'pinned-story-configuration');
  const onlinePinned = JSON.parse(run(process.execPath, [
    cli, 'capabilities', 'doctor', 'piassistnat', '--json'
  ], worktree, { env }).stdout);
  assert.equal(onlinePinned.capability.map.authority, 'pinned-story-configuration');
  assert.equal(onlinePinned.capability.map.commit, workflow.resolution.configurationSource.commit);
  assert.equal(onlinePinned.checks.find((item) => item.id === 'configuration-pin')?.status, 'pass');
  assert.match(onlinePinned.checks.find((item) => item.id === 'configuration-pin')?.detail ?? '',
    /intentionally not substituted/);
  assert.equal(onlinePinned.checks.some((item) => item.id === 'authority-freshness'), false,
    'an exact Story pin must not be replaced by an online authority refresh');
  const checkedPin = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], worktree, { env }).stdout);
  assert.equal(checkedPin.complete, true);
  assert.equal(checkedPin.configurationMode, 'story-pinned');
  assert.equal(checkedPin.authorityState, 'story-pinned');

  const configurationSourceFile = path.join(worktree, 'singularity/configuration-source.json');
  const configurationSourceBytes = await readFile(configurationSourceFile);
  const workflowFile = path.join(
    worktree, 'singularity/work-items/ISO-APPROVED-CAP-1/workflow.json'
  );
  const workflowBytes = await readFile(workflowFile);

  // Simulate an exact Story created by an older package whose approved catalog did not yet contain
  // a newly shipped optional prompt. Its own definition and pin remain valid; init --check must not
  // compare it with today's package inventory or recommend rewriting immutable lifecycle input.
  const oldPinRecord = JSON.parse(configurationSourceBytes);
  const oldPackageOnlyPath = 'singularity/prompts/copilot-planning.md';
  const oldPackageOnlyBytes = await readFile(path.join(worktree, oldPackageOnlyPath));
  delete oldPinRecord.files[oldPackageOnlyPath];
  delete oldPinRecord.assets[oldPackageOnlyPath];
  oldPinRecord.projectionSha256 = createHash('sha256').update(JSON.stringify({
    baseCommit: oldPinRecord.baseCommit,
    assets: oldPinRecord.assets,
    removed: oldPinRecord.removed ?? {}
  })).digest('hex');
  const oldPinAttestation = {
    files: Object.fromEntries(Object.entries(oldPinRecord.files).sort(([a], [b]) => a.localeCompare(b))),
    baseCommit: oldPinRecord.baseCommit,
    assets: oldPinRecord.assets,
    removed: oldPinRecord.removed ?? {},
    projectionSha256: oldPinRecord.projectionSha256
  };
  const oldPinFilesSha256 = createHash('sha256')
    .update(JSON.stringify(oldPinAttestation)).digest('hex');
  const oldPinWorkflow = JSON.parse(workflowBytes);
  oldPinWorkflow.resolution.configurationSource.filesSha256 = oldPinFilesSha256;
  await rm(path.join(worktree, oldPackageOnlyPath));
  await writeFile(configurationSourceFile, `${JSON.stringify(oldPinRecord, null, 2)}\n`);
  await writeFile(workflowFile, `${JSON.stringify(oldPinWorkflow, null, 2)}\n`);
  const oldPinCheck = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], worktree, { env }).stdout);
  assert.equal(oldPinCheck.complete, true,
    'a valid immutable Story pin is judged against its own asset catalog, not a newer package');
  assert.equal(oldPinCheck.configurationMode, 'story-pinned');
  assert.equal(oldPinCheck.nextCommand, null);
  await writeFile(path.join(worktree, oldPackageOnlyPath), oldPackageOnlyBytes);
  await writeFile(configurationSourceFile, configurationSourceBytes);
  await writeFile(workflowFile, workflowBytes);

  await writeFile(configurationSourceFile, '{corrupt configuration source\n');
  const corruptPinCheck = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], worktree, { env }).stdout);
  assert.equal(corruptPinCheck.complete, false,
    'remote configuration completeness must not hide corruption in a bound Story pin');
  assert.equal(corruptPinCheck.configurationMode, 'story-pin-invalid');
  assert.equal(corruptPinCheck.authorityState, 'story-pin-invalid');
  assert.match(corruptPinCheck.configurationError, /configuration-source\.json|JSON/i);
  const corruptPinDoctor = run(process.execPath, [
    cli, 'capabilities', 'doctor', 'piassistnat', '--json'
  ], worktree, { env, allowFailure: true });
  assert.equal(corruptPinDoctor.status, 1);
  const corruptPinDiagnosis = JSON.parse(corruptPinDoctor.stdout);
  assert.equal(corruptPinDiagnosis.valid, false);
  assert.equal(corruptPinDiagnosis.checks.find((item) => item.id === 'configuration-pin')?.status,
    'fail', 'a corrupt canonical Story pin must be a diagnostic result, not an exception');
  await writeFile(configurationSourceFile, configurationSourceBytes);

  const wrongBranchWorkflow = JSON.parse(workflowBytes);
  wrongBranchWorkflow.lineage.canonicalBranch = 'WRONG-CANONICAL-BRANCH';
  await writeFile(workflowFile, `${JSON.stringify(wrongBranchWorkflow, null, 2)}\n`);
  await rm(configurationSourceFile);
  const missingPinCheck = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], worktree, { env }).stdout);
  assert.equal(missingPinCheck.complete, false);
  assert.equal(missingPinCheck.configurationMode, 'story-pin-invalid',
    'a workflow at the canonical path remains a damaged Story even when its branch fields are corrupt');
  const missingPinDoctor = run(process.execPath, [
    cli, 'capabilities', 'doctor', 'piassistnat', '--offline', '--json'
  ], worktree, { env, allowFailure: true });
  assert.equal(missingPinDoctor.status, 1);
  const missingPinDiagnosis = JSON.parse(missingPinDoctor.stdout);
  assert.equal(missingPinDiagnosis.valid, false);
  assert.equal(missingPinDiagnosis.checks.find((item) => item.id === 'configuration-pin')?.status,
    'fail', 'a missing canonical Story pin must always fail diagnosis');
  await writeFile(workflowFile, workflowBytes);
  await writeFile(configurationSourceFile, configurationSourceBytes);
  assert.doesNotMatch(await readFile(path.join(root, 'singularity/capabilities.yml'), 'utf8'), /piassistnat/,
    'Story configuration materialization must not mutate the canonical application checkout');

  run('git', ['switch', '-q', '-c', 'UNBOUND-PIN-COPY'], worktree);
  const unboundInit = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], worktree, { env }).stdout);
  assert.equal(unboundInit.complete, false,
    'a copied self-consistent configuration source is not an immutable pin for another branch');
  assert.equal(unboundInit.configurationMode, 'story-pin-invalid');
  assert.equal(unboundInit.nextCommand, 'singularity-flow doctor');
  const unbound = run(process.execPath, [
    cli, 'capabilities', 'doctor', 'piassistnat', '--json'
  ], worktree, { env, allowFailure: true });
  assert.equal(unbound.status, 1,
    'a self-consistent configuration copy without current-Story binding must fail diagnosis');
  const unboundDiagnosis = JSON.parse(unbound.stdout);
  assert.equal(unboundDiagnosis.valid, false);
  assert.equal(unboundDiagnosis.checks.find((item) => item.id === 'configuration-pin')?.status, 'fail');
  assert.equal(unboundDiagnosis.checks.find((item) => item.id === 'authority-freshness')?.status, 'pass',
    'an unbound copy must not suppress the normal online authority refresh');
  assert.equal(unboundDiagnosis.capability.map.repository, authority);
  assert.equal(unboundDiagnosis.capability.map.authority, 'approved-configuration');

  await writeFile(path.join(worktree, 'singularity/configuration-source.json'), '{corrupt copy\n');
  const corruptUnboundInit = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], worktree, { env }).stdout);
  assert.equal(corruptUnboundInit.complete, false);
  assert.equal(corruptUnboundInit.configurationMode, 'story-pin-invalid');
  const corruptUnbound = run(process.execPath, [
    cli, 'capabilities', 'doctor', 'piassistnat', '--json'
  ], worktree, { env, allowFailure: true });
  assert.equal(corruptUnbound.status, 1);
  const corruptDiagnosis = JSON.parse(corruptUnbound.stdout);
  assert.equal(corruptDiagnosis.checks.find((item) => item.id === 'configuration-pin')?.status, 'fail');
  assert.equal(corruptDiagnosis.checks.find((item) => item.id === 'authority-freshness')?.status, 'pass');
  assert.equal(corruptDiagnosis.capability.map.repository, authority,
    'a corrupt unbound copy must not prevent read-only diagnosis of the verified authority');

  // Story detection must follow the configured root even while the pin is damaged. Otherwise a
  // current remote authority could make init --check report green over a broken local Story.
  const definitionFile = path.join(worktree, 'singularity/workflow.yml');
  await writeFile(definitionFile, (await readFile(definitionFile, 'utf8'))
    .replace('workItemRoot: singularity/work-items', 'workItemRoot: governed/story-state'));
  const customWorkflow = path.join(worktree, 'governed/story-state/UNBOUND-PIN-COPY/workflow.json');
  await mkdir(path.dirname(customWorkflow), { recursive: true });
  await writeFile(customWorkflow, workflowBytes);
  await rm(configurationSourceFile);
  const customRootCheck = JSON.parse(run(process.execPath, [
    cli, 'init', '--check', '--json'
  ], worktree, { env }).stdout);
  assert.equal(customRootCheck.complete, false);
  assert.equal(customRootCheck.configurationMode, 'story-pin-invalid');
  assert.equal(customRootCheck.authorityState, 'story-pin-invalid');
});

test('session attach reuses the managed Story worktree instead of switching its launch clone', async (t) => {
  const { root } = await repository(t);
  const started = run(process.execPath, [cli,
    'start', 'ISO-ATTACH-1', '--isolated-worktree', '--json', '--from-branch', 'main',
    '--work-type', 'feature', '--title', 'Attach independently',
    '--description', 'Reuse the exact managed Story checkout without disturbing the launch clone.'
  ], root);
  const worktree = JSON.parse(started.stdout).data.repositoryPath;
  run('git', ['push', '-q', '-u', 'origin', 'ISO-ATTACH-1'], worktree);
  await writeFile(path.join(root, 'unrelated-launch-work.txt'), 'must remain in the launch checkout\n');

  const attached = run(process.execPath, [cli, 'session', 'attach', 'ISO-ATTACH-1', '--json'], root);
  const result = JSON.parse(attached.stdout);

  assert.equal(path.resolve(result.repositoryPath), path.resolve(worktree));
  assert.equal(await realpath(result.sourceRepositoryPath), await realpath(root));
  assert.equal(result.resolvedFrom, 'managed-story-worktree');
  assert.equal(result.materialization, 'reused-managed-story-worktree');
  assert.equal(git(root, ['branch', '--show-current']), 'main');
  assert.match(git(root, ['status', '--porcelain']), /unrelated-launch-work\.txt/);
  assert.equal(git(worktree, ['branch', '--show-current']), 'ISO-ATTACH-1');
  const status = JSON.parse(run(process.execPath, [cli, 'session', 'status', '--json'], worktree).stdout);
  assert.equal(status.workId, 'ISO-ATTACH-1');
  assert.equal(status.ready, true);
});

test('a failed isolated start removes its disposable checkout and branch', async (t) => {
  const { root } = await repository(t);
  await writeFile(path.join(root, 'unfinished-prior-story.txt'), 'still mine\n');
  const before = git(root, ['worktree', 'list', '--porcelain']);
  const failed = run(process.execPath, [cli,
    'start', 'ISO-FAIL-1', '--json', '--from-branch', 'main', '--work-type', 'does-not-exist',
    '--title', 'Fail safely', '--description', 'Exercise rollback.'
  ], root, { allowFailure: true });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Workflow template 'does-not-exist' is not installed in the approved configuration/);
  assert.match(failed.stderr, /Upgrade Capabilities & Workspaces/);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']), before);
  assert.equal(run('git', ['show-ref', '--verify', '--quiet', 'refs/heads/ISO-FAIL-1'], root, {
    allowFailure: true
  }).status, 1);
  assert.equal(git(root, ['branch', '--show-current']), 'main');
  assert.equal(await readFile(path.join(root, 'unfinished-prior-story.txt'), 'utf8'), 'still mine\n');
  const expected = path.join(path.dirname(root), '.singularity-flow', 'story-worktrees');
  await access(expected).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
});

test('a malformed approved capability map refuses Story start without leaving lifecycle state', async (t) => {
  const { root } = await repository(t);
  run('git', ['switch', '-q', '-c', 'sflow/config'], root);
  await writeFile(path.join(root, 'singularity/capabilities.yml'), YAML.stringify({
    version: 1,
    capabilities: {
      'broken-delivery': {
        kind: 'delivery',
        parent: null,
        policy: {}
      }
    }
  }));
  run('git', ['add', 'singularity/capabilities.yml'], root);
  run('git', ['commit', '-qm', 'publish malformed approved capability map'], root);
  run('git', ['push', '-q', 'origin', 'sflow/config'], root);
  run('git', ['switch', '-q', 'main'], root);

  const beforeHead = git(root, ['rev-parse', 'HEAD']);
  const beforeWorktrees = git(root, ['worktree', 'list', '--porcelain']);
  const beforeAuthority = run('git', [
    'ls-remote', 'origin', 'refs/heads/sflow/config'
  ], root).stdout.trim();
  const beforeRecoveryRefs = run('git', [
    'for-each-ref', '--format=%(refname)', 'refs/singularity/transport/configuration'
  ], root).stdout.trim();
  const failed = run(process.execPath, [cli,
    'start', 'ISO-MALFORMED-CAP-1', '--isolated-worktree', '--json', '--from-branch', 'main',
    '--work-type', 'quick-fix', '--title', 'Refuse malformed approved authority',
    '--description', 'Do not treat an invalid approved capability map as if it were absent.'
  ], root, {
    allowFailure: true,
    env: { SINGULARITY_FLOW_TEST_IDENTITY: 'Previously Unknown User' }
  });

  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr,
    /Capability 'broken-delivery' is a delivery and must name at least one repository/);
  assert.doesNotMatch(failed.stderr, /No singularity\/capabilities\.yml is available/);
  assert.equal(git(root, ['rev-parse', 'HEAD']), beforeHead);
  assert.equal(git(root, ['branch', '--show-current']), 'main');
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.equal(git(root, ['worktree', 'list', '--porcelain']), beforeWorktrees);
  assert.equal(run('git', [
    'ls-remote', 'origin', 'refs/heads/sflow/config'
  ], root).stdout.trim(), beforeAuthority, 'a refused start must not enroll and push the new identity');
  assert.equal(run('git', [
    'for-each-ref', '--format=%(refname)', 'refs/singularity/transport/configuration'
  ], root).stdout.trim(), beforeRecoveryRefs, 'a refused start must not retain an enrollment commit');
  assert.equal(run('git', [
    'show-ref', '--verify', '--quiet', 'refs/heads/ISO-MALFORMED-CAP-1'
  ], root, { allowFailure: true }).status, 1);
});

test('an unknown approved capability refuses Story start before automatic enrollment', async (t) => {
  const { root } = await repository(t);
  run('git', ['switch', '-q', '-c', 'sflow/config'], root);
  await writeFile(path.join(root, 'singularity/capabilities.yml'), YAML.stringify({
    version: 1,
    capabilities: {
      product: {
        kind: 'delivery', parent: null, repository: 'repository', policy: {}
      }
    }
  }));
  run('git', ['add', 'singularity/capabilities.yml'], root);
  run('git', ['commit', '-qm', 'publish approved capability catalog'], root);
  run('git', ['push', '-q', 'origin', 'sflow/config'], root);
  run('git', ['switch', '-q', 'main'], root);
  const beforeAuthority = run('git', [
    'ls-remote', 'origin', 'refs/heads/sflow/config'
  ], root).stdout.trim();
  const beforeWorktrees = git(root, ['worktree', 'list', '--porcelain']);

  const failed = run(process.execPath, [cli,
    'start', 'ISO-UNKNOWN-CAP-1', '--isolated-worktree', '--json', '--from-branch', 'main',
    '--work-type', 'quick-fix', '--capability', 'missing-capability',
    '--title', 'Refuse an unknown approved capability',
    '--description', 'Validate the retained catalog before automatic enrollment.'
  ], root, {
    allowFailure: true,
    env: { SINGULARITY_FLOW_TEST_IDENTITY: 'Previously Unknown User' }
  });

  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /Unknown capability 'missing-capability'/);
  assert.equal(run('git', [
    'ls-remote', 'origin', 'refs/heads/sflow/config'
  ], root).stdout.trim(), beforeAuthority);
  assert.equal(git(root, ['worktree', 'list', '--porcelain']), beforeWorktrees);
  assert.equal(git(root, ['branch', '--show-current']), 'main');
  assert.equal(git(root, ['status', '--porcelain']), '');
  assert.equal(run('git', [
    'show-ref', '--verify', '--quiet', 'refs/heads/ISO-UNKNOWN-CAP-1'
  ], root, { allowFailure: true }).status, 1);
});

test('isolated-start recovery retains a durable Story under a custom configured root', async (t) => {
  const workItemRoot = 'governed/story-state';
  const { root } = await repository(t, { workItemRoot });
  const started = run(process.execPath, [cli,
    'start', 'ISO-CUSTOM-1', '--isolated-worktree', '--json', '--from-branch', 'main',
    '--work-type', 'feature', '--title', 'Custom root Story',
    '--description', 'Retain durable work regardless of the configured state directory.'
  ], root);
  const worktree = JSON.parse(started.stdout).data.repositoryPath;
  const workflow = JSON.parse(await readFile(path.join(
    worktree, workItemRoot, 'ISO-CUSTOM-1', 'workflow.json'
  ), 'utf8'));
  assert.equal(workflow.resolution.workItemRoot, workItemRoot);

  const recovery = rollbackStoryWorktree({
    sourceRepository: root,
    repositoryPath: worktree,
    workId: 'ISO-CUSTOM-1',
    stagingBranch: 'already-removed'
  });
  assert.equal(recovery.retained, true);
  assert.equal(git(worktree, ['branch', '--show-current']), 'ISO-CUSTOM-1');
});
