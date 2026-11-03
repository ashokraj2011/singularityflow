import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initializeDefinition } from '../src/config.mjs';
import { publishCurrentIdentityToConfiguration } from '../src/configuration-people.mjs';
import { proposeConfigurationChange } from '../src/configuration-proposal.mjs';
import { commandTimer, withCommandTiming } from '../src/dx-command-timing.mjs';
import { run } from '../src/util.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-partial-enrollment-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source'), remote = path.join(base, 'authority.git'), root = path.join(base, 'workspace');
  const git = (cwd, args) => run('git', args, { cwd }).stdout.trim();
  git(base, ['init', '-q', '-b', 'main', source]);
  git(source, ['config', 'user.name', 'Configuration Author']);
  git(source, ['config', 'user.email', 'configuration@example.invalid']);
  await writeFile(path.join(source, 'README.md'), '# Application\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'Application base']);
  git(source, ['switch', '-q', '-c', 'sflow/config']);
  await initializeDefinition(source);
  await mkdir(path.join(source, '.github', 'agents'), { recursive: true });
  const agent = '.github/agents/fixture.agent.md', bytes = '# Fixture agent\nRetain these exact approved bytes.\n';
  await writeFile(path.join(source, agent), bytes);
  git(source, ['add', '.']);
  git(source, ['commit', '-qm', 'Approved configuration']);
  const approved = git(source, ['rev-parse', 'HEAD']);
  git(source, ['switch', '-q', 'main']);
  git(base, ['clone', '-q', '--bare', source, remote]);
  git(remote, ['config', 'uploadpack.allowFilter', 'true']);
  git(base, ['clone', '-q', '-b', 'main', '--filter=blob:none', pathToFileURL(remote).href, root]);
  git(root, ['config', 'user.name', 'Enrollment Developer']);
  git(root, ['config', 'user.email', 'enrollment@example.invalid']);
  await writeFile(path.join(root, 'preserved.txt'), 'User work\n');
  await writeFile(path.join(root, 'README.md'), '# Staged user changes\n');
  git(root, ['add', 'README.md']);
  const index = await readFile(path.join(root, '.git', 'index'));
  const head = git(root, ['rev-parse', 'HEAD']);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox') };
  return { root, remote, git, head, approved, index, env, agent, bytes };
}

test('automatic enrollment from a blobless workspace publishes membership and retains all approved agents', async t => {
  const f = await fixture(t);
  const timer = commandTimer('partial-clone-enrollment', { commandClass: 'write' });
  const enrolled = await withCommandTiming(timer, () => publishCurrentIdentityToConfiguration(f.root, {
    automatic: true, transport: { env: f.env }
  }));
  assert.equal(enrolled.pushed, true);
  assert.equal(enrolled.changed, true);
  assert.ok(timer.finish().counters['configuration.projection.blobs-fetched'] > 0);
  assert.equal(f.git(f.remote, ['show', `sflow/config:${f.agent}`]), f.bytes.trim());
  assert.match(f.git(f.remote, ['show', 'sflow/config:singularity/workflow.yml']), /enrollment@example\.invalid/u);
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), f.head);
  assert.deepEqual(await readFile(path.join(f.root, '.git', 'index')), f.index);
  assert.equal(await readFile(path.join(f.root, 'README.md'), 'utf8'), '# Staged user changes\n');
  assert.equal(await readFile(path.join(f.root, 'preserved.txt'), 'utf8'), 'User work\n');
});

test('workflow proposals from blobless workspaces retain missing approved agents without activating the proposal', async t => {
  const f = await fixture(t);
  const timer = commandTimer('partial-clone-proposal', { commandClass: 'write' });
  const proposal = await withCommandTiming(timer, () => proposeConfigurationChange(f.root, {
    operation: 'edit-workflow', subject: 'fixture', message: 'Update workflow description',
    async mutate(directory) {
      const file = path.join(directory, 'singularity', 'workflow.yml');
      await writeFile(file, `${await readFile(file, 'utf8')}\n# Reviewed fixture change\n`);
    }
  }, { env: f.env, transport: { env: f.env } }));
  assert.equal(proposal.reviewRequired, true);
  assert.ok(timer.finish().counters['configuration.projection.blobs-fetched'] > 0);
  assert.equal(f.git(f.remote, ['show', `${proposal.branch}:${f.agent}`]), f.bytes.trim());
  assert.deepEqual(proposal.files, ['singularity/workflow.yml']);
  assert.equal(f.git(f.remote, ['rev-parse', 'sflow/config']), f.approved);
  assert.equal(f.git(f.root, ['rev-parse', 'HEAD']), f.head);
  assert.deepEqual(await readFile(path.join(f.root, '.git', 'index')), f.index);
  assert.equal(await readFile(path.join(f.root, 'README.md'), 'utf8'), '# Staged user changes\n');
  assert.equal(await readFile(path.join(f.root, 'preserved.txt'), 'utf8'), 'User work\n');
});
