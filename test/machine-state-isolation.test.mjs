/**
 * A repository is governed by its own committed configuration, and by nothing on the machine.
 *
 * This exists because of a real incident rather than a theory. Fifteen unrelated tests began failing
 * on unchanged code, and the difference was a file outside the repository:
 * `~/.singularity-flow/active-workspace.json`, holding a workspace someone had selected in the
 * editor. Isolating the home directory made them pass again; restoring it made them fail.
 *
 * The mechanism was never reproduced — by the time it was investigated the same machine state no
 * longer produced it, and the guard in `workspaceContextForRepository` provably holds. So rather
 * than guess at a fix, this pins the property that matters: whatever a person has selected on their
 * machine, an unrelated repository must still be governed the way its own configuration says. If
 * some future change lets machine-global selection reach into repository policy, this fails.
 *
 * The strongest case is asserted deliberately: the selected workspace's capability demands
 * publication, while the unrelated repository has publication off. Story base discovery still
 * uses an isolated bare remote, but the structured result proves no Story publication occurred.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');

async function scenario() {
  // Every pointer is redirected, so this never reads or writes the real machine's state.
  const machine = await mkdtemp(path.join(os.tmpdir(), 'sflow-machine-'));
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Isolation Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(machine, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(machine, 'active-workspace.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(machine, 'leads.json')
  };
  const run = (command, args, cwd) => spawnSync(command, args, { cwd, encoding: 'utf8', env });

  async function repository(label, publish) {
    const root = await mkdtemp(path.join(os.tmpdir(), `sflow-${label}-`));
    run('git', ['init', '-b', 'main'], root);
    run('git', ['config', 'user.name', 'Isolation Tester'], root);
    run('git', ['config', 'user.email', 'isolation@example.com'], root);
    await writeFile(path.join(root, 'README.md'), `# ${label}\n`);
    run(process.execPath, [bin, 'init'], root);
    const file = path.join(root, 'singularity/workflow.yml');
    const config = YAML.parse(await readFile(file, 'utf8'));
    config.git.publish = publish;
    config.worldModel.grounding = 'off';
    await writeFile(file, YAML.stringify(config));
    run('git', ['add', '-A'], root);
    run('git', ['commit', '-m', 'initialize'], root);
    const remote = `${root}.git`;
    run('git', ['init', '--bare', '-b', 'main', remote], root);
    run('git', ['remote', 'add', 'origin', remote], root);
    run('git', ['push', '-u', 'origin', 'main'], root);
    return root;
  }

  const selected = await repository('selected', 'required');
  await writeFile(path.join(selected, 'singularity/capabilities.yml'), YAML.stringify({
    schemaVersion: 1,
    capabilities: {
      'selected-capability': {
        name: 'Selected capability',
        kind: 'delivery',
        policy: { gitPublication: 'required' },
        deliveredBy: [{ repository: 'selected', repositories: ['selected'] }]
      }
    }
  }));
  run('git', ['add', '-A'], selected);
  run('git', ['commit', '-m', 'capability'], selected);

  const unrelated = await repository('unrelated', 'off');

  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'sflow-workspace-'));
  await mkdir(path.join(workspacePath, 'repos'), { recursive: true });
  await writeFile(path.join(workspacePath, 'workspace.json'), JSON.stringify({
    version: 1,
    id: 'selected',
    name: 'selected',
    anchor: {
      provider: 'workspace',
      siteId: 'local',
      key: 'selected',
      title: 'selected'
    },
    leadRepository: 'selected',
    repositories: {
      selected: {
        path: `repos/${path.basename(selected)}`,
        adoption: {
          mode: 'existing-clone',
          canonicalPath: selected,
          proofHash: `sha256:${'a'.repeat(64)}`,
          reviewedAt: '2026-08-10T00:00:00.000Z'
        },
        url: 'https://example.invalid/selected.git',
        capabilities: ['selected-capability']
      }
    },
    capabilities: ['selected-capability']
  }, null, 2));
  await writeFile(env.SINGULARITY_FLOW_ACTIVE_WORKSPACE, JSON.stringify({
    schemaVersion: 1,
    workspaceId: 'selected',
    workspaceName: 'selected',
    workspacePath,
    anchorKey: 'selected',
    repositoryId: 'selected',
    repositoryPath: selected,
    repositoryState: 'ready',
    branch: 'main',
    capabilities: ['selected-capability'],
    repositoryCapabilities: ['selected-capability'],
    storyId: null,
    selectedAt: '2026-08-10T00:00:00.000Z',
    prompt: 'selected >'
  }, null, 2));

  return { unrelated, run };
}

test('a workspace selected on this machine does not govern an unrelated repository', async () => {
  const { unrelated, run } = await scenario();
  const started = run(process.execPath,
    [bin, 'start', 'ISOLATED-1', '--from-branch', 'main', '--title', 'Isolated', '--work-type', 'quick-fix', '--json'], unrelated);
  const output = `${started.stdout}\n${started.stderr}`;
  assert.equal(started.status, 0, output);
  const result = JSON.parse(started.stdout);
  assert.equal(result.data.publication.pushed, false,
    'the selected workspace forced publication on a repository whose own configuration disables it');
});

test('capability resolution gives an unrelated governed repository its own implicit root', async () => {
  // A selected workspace elsewhere is never borrowed. Under progressive disclosure, an otherwise
  // governed repository with no map still has its own deterministic repository-root capability.
  const { unrelated } = await scenario();
  const { resolveLifecycleCapability } = await import('../src/capability-context.mjs');
  const capability = await resolveLifecycleCapability(unrelated);
  assert.equal(capability.mode, 'implicit');
  assert.equal(capability.id, 'repository-root');
  assert.notEqual(capability.map.authority, 'approved-configuration');
});
