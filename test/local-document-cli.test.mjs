import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { childTimeout } from './helpers/child-timeout.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(source, 'bin/singularity-flow.mjs');

test('real CLI delivers private source context, asks on takeover, and resumes after exact re-upload without changing Story state', { timeout: 300_000 }, async t => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-local-document-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await mkdir(root);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_TEST_IDENTITY: 'Document CLI Tester',
    SINGULARITY_FLOW_TEST_SELECTION: JSON.stringify({ workType: 'spec-driven-standard', agent: 'product-owner' }),
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'),
    SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'),
    SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    SINGULARITY_FLOW_AGENT_OUTPUT: 'full' };
  function run(command, args, cwd = root, allowFailure = false) {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(120_000), maxBuffer: 8 * 1024 * 1024 });
    if (!allowFailure) assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  }
  const git = (...args) => run('git', args).stdout.trim();
  const flow = (cwd, ...args) => run(process.execPath, [cli, '--no-model', ...args], cwd);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Document CLI Tester');
  git('config', 'user.email', 'document-cli@example.invalid');
  await writeFile(path.join(root, 'README.md'), '# Document handoff fixture\n');
  flow(root, 'init');
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.git.publish = 'off';
  config.worldModel.grounding = 'off';
  config.repositoryReadiness.requiredBeforeStory = false;
  config.approvalSecurity = { profile: 'poc' };
  await writeFile(configPath, YAML.stringify(config));
  git('add', '.');
  git('commit', '-qm', 'Initialize fixture');
  git('init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git'));
  git('remote', 'add', 'origin', path.join(base, 'remote.git'));
  git('push', '-q', '-u', 'origin', 'main');
  flow(root, 'start', 'LOCAL-CLI', '--from-branch', 'main', '--work-type', 'spec-driven-standard',
    '--title', 'Use private requirements', '--description', 'Read the locally uploaded sources.');
  const original = path.join(base, 'requirements.md');
  const marker = 'LOCAL_DOCUMENT_PRIVATE_CONTENT_314159: show the saved state.';
  await writeFile(original, `# Requirements\n${marker}\n`);
  flow(root, 'documents', 'upload', original, '--name', 'Private requirements');
  const first = JSON.parse(flow(root, 'phase', 'enter', 'specification', '--compose', '--for-agent', '--json').stdout);
  assert.match(first.context.text, new RegExp(marker));
  assert.equal(first.context.file.storage, 'local');
  assert.equal(await readFile(first.context.file.path, 'utf8'), first.context.text);
  const exportedPrompt = path.join(path.dirname(first.context.file.path), 'cli-export.md');
  flow(root, 'wm', 'compose', '--phase', 'specification', '--work-id', 'LOCAL-CLI',
    '--out', exportedPrompt);
  assert.match(await readFile(exportedPrompt, 'utf8'), new RegExp(marker),
    'CLI exports include the runtime local evidence, not only the durable metadata');
  const durable = await readFile(path.join(root, first.context.durableFile.path), 'utf8');
  assert.ok(!durable.includes(marker), 'committed prompt snapshots contain only source identity');
  assert.equal(git('ls-files', 'singularity/work-items/LOCAL-CLI/inputs'), '');
  git('add', '.');
  git('commit', '-qm', 'Keep metadata prompt');
  git('push', '-q', '-u', 'origin', 'LOCAL-CLI');
  assert.equal(run('git', ['grep', '-F', marker, 'HEAD'], root, true).status, 1);

  const second = path.join(base, 'another-laptop');
  git('clone', '-q', '--config', 'core.autocrlf=true', '--branch', 'LOCAL-CLI', '--no-local', path.join(base, 'remote.git'), second);
  run('git', ['config', 'user.name', 'Document CLI Tester'], second);
  run('git', ['config', 'user.email', 'document-cli@example.invalid'], second);
  flow(second, 'session', 'attach', 'LOCAL-CLI', '--json');
  const before = run('git', ['rev-parse', 'HEAD'], second).stdout;
  const missing = JSON.parse(flow(second, 'phase', 'enter', 'specification', '--compose', '--for-agent', '--json').stdout);
  assert.equal(missing.status, 'documents-required', JSON.stringify({ status: missing.status,
    ready: missing.ready, phaseAgent: missing.phaseAgent, next: missing.next }));
  assert.equal(missing.authoringAllowed, false);
  assert.equal(missing.context, null);
  assert.equal(missing.documentReadiness.missing[0].id, 'DOC-001');
  assert.equal(missing.clarification.checkpoint.questioningAllowed, false);
  const readiness = JSON.parse(flow(second, 'documents', 'readiness', '--phase', 'specification',
    '--work-id', 'LOCAL-CLI', '--for-agent', '--json').stdout);
  assert.equal(readiness.resultType, 'document-readiness');
  assert.equal(readiness.status, 'upload-required');
  assert.equal(readiness.missing[0].id, 'DOC-001');
  const next = JSON.parse(flow(second, 'nextsteps', '--json').stdout);
  assert.equal(next.state, 'documents-required');
  assert.equal(next.actions[0].argv[1], 'restore');
  const restored = JSON.parse(flow(second, 'documents', 'restore', 'DOC-001', '--work-id', 'LOCAL-CLI', '--file', original, '--json').stdout);
  assert.equal(restored.documentId, 'DOC-001');
  assert.equal(restored.next[0].argv[0], 'nextsteps', 'restoring during review must not send the reviewer back into authoring');
  assert.equal(restored.effects.approvalsChanged, false);
  assert.equal(run('git', ['rev-parse', 'HEAD'], second).stdout, before);
  const resumed = JSON.parse(flow(second, 'phase', 'enter', 'specification', '--compose', '--for-agent', '--json').stdout);
  assert.notEqual(resumed.status, 'documents-required');
  assert.match(resumed.context.text, new RegExp(marker));
  const takeoverExport = path.join(path.dirname(resumed.context.file.path), 'cli-export.md');
  flow(second, 'wm', 'compose', '--phase', 'specification', '--work-id', 'LOCAL-CLI',
    '--out', takeoverExport);
  assert.match(await readFile(takeoverExport, 'utf8'), new RegExp(marker));
  assert.notEqual(exportedPrompt, takeoverExport, 'another clone receives its own exact private export path');
  assert.equal(resumed.context.renderedSha256, first.context.renderedSha256,
    'restoring the original does not invalidate prompt-bound clarification answers');
});
