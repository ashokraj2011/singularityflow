/**
 * A user-defined agent's folder travels with its workflow. Bundles before v10 carried only the agent
 * and its starter template, so the destination imported a step whose folder it did not have and
 * refused to compose it (USER_AGENT_FOLDER_CHANGED, "has no manifest").
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { readWorkflowBundle } from '../src/workflow-transfer.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/** The bundle digest after a test rewrote it, as the exporter computes it. */
function resealed(bundle) {
  for (const asset of bundle.assets) { asset.size = Buffer.byteLength(asset.content, 'utf8'); asset.sha256 = sha256(asset.content); }
  const copy = structuredClone(bundle); delete copy.bundleSha256;
  bundle.bundleSha256 = sha256(JSON.stringify(canonical(copy)));
  return bundle;
}

async function teamFolder(base, note = 'Use small functions.') {
  const folder = path.join(base, 'team-agents');
  await mkdir(path.join(folder, 'skills', 'review'), { recursive: true });
  await mkdir(path.join(folder, 'notes'));
  await writeFile(path.join(folder, 'orchestrator.agent.md'), '---\nname: orchestrator\ndescription: Plans, reviews and implements a change.\n---\n# Orchestrator\n\n1. Plan.\n2. Apply skills/review/SKILL.md.\n3. Implement, following notes/style.md.\n');
  await writeFile(path.join(folder, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a plan for risks.\n---\nList each risk with a mitigation.\n');
  await writeFile(path.join(folder, 'notes', 'style.md'), `# Style\n${note}\n`);
  return folder;
}

test('a user-defined agent\'s folder travels with its workflow, and an import that would lose it is refused', { timeout: 600_000 }, async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-user-agent-transfer-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const folder = await teamFolder(base);
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Transfer Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_TRANSPORT_OUTBOX: path.join(base, 'outbox'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Transfer Tester', GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'transfer.tester@example.invalid' };
  delete env.NODE_TEST_CONTEXT;
  const run = (command, args, cwd, { allowFailure = false } = {}) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 300_000 });
    if (!allowFailure) assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const sflow = (cwd, ...args) => run(process.execPath, [cli, '--no-model', ...args], cwd).stdout;
  const json = (cwd, ...args) => JSON.parse(sflow(cwd, ...args, '--json'));
  const refused = (cwd, ...args) => {
    const result = run(process.execPath, [cli, '--no-model', ...args, '--json'], cwd, { allowFailure: true });
    assert.notEqual(result.status, 0, `${args.join(' ')} should be refused`);
    return JSON.parse(result.stdout).error;
  };
  const repository = async (name) => {
    const root = path.join(base, name); const remote = path.join(base, `${name}.git`);
    run('git', ['init', '-q', '-b', 'main', root], base);
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
    sflow(root, 'init');
    const configPath = path.join(root, 'singularity/workflow.yml');
    const config = YAML.parse(await readFile(configPath, 'utf8'));
    config.worldModel.grounding = 'off';
    config.approvalSecurity = { profile: 'poc' };
    for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
    await writeFile(configPath, YAML.stringify(config));
    run('git', ['add', '-A'], root); run('git', ['commit', '-q', '-m', 'fixture'], root);
    run('git', ['init', '-q', '--bare', '-b', 'main', remote], base);
    run('git', ['remote', 'add', 'origin', remote], root); run('git', ['push', '-q', '-u', 'origin', 'main'], root);
    run('git', ['push', '-q', 'origin', 'HEAD:refs/heads/sflow/config'], root);
    return { root, remote };
  };
  const activate = ({ root, remote }) => {
    const branch = run('git', ['--git-dir', remote, 'branch', '--list', 'sflow/config-change/*', '--format=%(refname:short)'], base).stdout.trim().split('\n').at(-1);
    sflow(root, 'workflow', 'activate', branch, '--confirm', run('git', ['--git-dir', remote, 'rev-parse', branch], base).stdout.trim(), '--acknowledge-unprotected');
  };
  const addAgent = (repo, source, ...extra) => {
    const preview = json(repo.root, 'call', 'add', source, ...extra);
    sflow(repo.root, 'call', 'add', source, ...extra, '--confirm', preview.data.planSha256);
    activate(repo);
  };

  // A: the agent is added, its folder is exported with it.
  const a = await repository('a');
  addAgent(a, folder);
  const bundlePath = path.join(base, 'orchestrator.bundle.json');
  sflow(a.root, 'workflow', 'export', '--workflow', 'orchestrator', '--out', bundlePath);
  const bundle = JSON.parse(await readFile(bundlePath, 'utf8'));
  assert.equal(bundle.schemaVersion, 10);
  assert.deepEqual(bundle.assets.filter((asset) => asset.kind === 'user-defined').map((asset) => [asset.path, asset.owner.id]), [
    ['singularity/user-defined/orchestrator.json', 'orchestrator'],
    ['singularity/user-defined/orchestrator/notes/style.md', 'orchestrator'],
    ['singularity/user-defined/orchestrator/orchestrator.agent.md', 'orchestrator'],
    ['singularity/user-defined/orchestrator/skills/review/SKILL.md', 'orchestrator']
  ]);
  for (const relative of ['notes/style.md', 'skills/review/SKILL.md']) {
    assert.equal(bundle.assets.find((asset) => asset.path === `singularity/user-defined/orchestrator/${relative}`).content,
      await readFile(path.join(folder, relative), 'utf8'), `${relative} travels byte for byte`);
  }

  // B: the import adds the folder, and the Story's step composes from it.
  const b = await repository('b');
  const preview = json(b.root, 'workflow', 'import', bundlePath, '--dry-run');
  assert.ok(preview.added.some((entry) => entry.kind === 'user-defined' && entry.id === 'singularity/user-defined/orchestrator.json'), JSON.stringify(preview.added));
  sflow(b.root, 'workflow', 'import', bundlePath, '--confirm', preview.planSha256, '--propose');
  activate(b);
  sflow(b.root, 'start', 'MOVE-1', '--agent', 'orchestrator', '--from-branch', 'main', '--title', 'Moved agent',
    '--description', 'Run the imported user-defined agent.', '--readiness-baseline', 'defer');
  const prompt = sflow(b.root, 'wm', 'compose', '--phase', 'orchestrator', '--render-only');
  assert.match(prompt, /# The Orchestrator folder[\s\S]*### notes\/style\.md[\s\S]*Use small functions\.[\s\S]*### skills\/review\/SKILL\.md/u);

  // C: a different folder under the same name is a conflict of the agent, kept or replaced, never renamed.
  const c = await repository('c');
  const other = await teamFolder(path.join(base, 'other'), 'Other rules.');
  addAgent(c, other);
  const blocked = json(c.root, 'workflow', 'import', bundlePath, '--dry-run');
  const agent = blocked.unresolved.find((entry) => entry.subject === 'agent:orchestrator');
  assert.deepEqual(agent.choices, ['keep', 'replace']);
  assert.ok(blocked.conflicts.some((entry) => entry.kind === 'user-defined' && entry.id === 'singularity/user-defined/orchestrator/notes/style.md'));
  assert.ok(blocked.reused.some((entry) => entry.kind === 'user-defined' && entry.id === 'singularity/user-defined/orchestrator/skills/review/SKILL.md'),
    'an identical file is already here');

  // An older bundle (v9 carried no folder), a changed file, or a stray file is refused, not imported.
  const write = async (name, value) => { const file = path.join(base, name); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); return file; };
  const older = structuredClone(bundle);
  older.schemaVersion = 9;
  older.assets = older.assets.filter((asset) => asset.kind !== 'user-defined');
  const olderPath = await write('older.json', resealed(older));
  await assert.rejects(readWorkflowBundle(olderPath), (error) => error.code === 'WORKFLOW_BUNDLE_USER_AGENT_FOLDER_MISSING' && /v9 bundle/u.test(error.message));
  assert.equal(refused(b.root, 'workflow', 'import', olderPath, '--dry-run').code, 'WORKFLOW_BUNDLE_USER_AGENT_FOLDER_MISSING', 'the preview names the problem instead of saying ready');
  const tampered = structuredClone(bundle);
  tampered.assets.find((asset) => asset.path.endsWith('notes/style.md')).content = '# Style\nAnything goes.\n';
  await assert.rejects(readWorkflowBundle(await write('tampered.json', resealed(tampered))),
    (error) => error.code === 'WORKFLOW_BUNDLE_USER_AGENT_FOLDER_MISSING' && /notes\/style\.md than its manifest lists/u.test(error.message));
  const stray = structuredClone(bundle);
  stray.assets.push({ ...structuredClone(stray.assets.find((asset) => asset.path.endsWith('notes/style.md'))), path: 'singularity/user-defined/orchestrator/notes/extra.md' });
  await assert.rejects(readWorkflowBundle(await write('stray.json', resealed(stray))), (error) => error.code === 'WORKFLOW_BUNDLE_DEPENDENCY_EXTRA');

  // A folder edited by hand on sflow/config is never exported as if its agent pinned it.
  const edited = path.join(base, 'edited');
  run('git', ['clone', '-q', '-b', 'sflow/config', a.remote, edited], base);
  await writeFile(path.join(edited, 'singularity/user-defined/orchestrator/notes/style.md'), '# Style\nAnything goes.\n');
  run('git', ['commit', '-qam', 'edit the copied note by hand'], edited); run('git', ['push', '-q', 'origin', 'sflow/config'], edited);
  assert.equal(refused(a.root, 'workflow', 'export', '--workflow', 'orchestrator', '--out', path.join(base, 'again.json')).code, 'WORKFLOW_USER_AGENT_FOLDER_CHANGED');
});
