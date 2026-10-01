import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import {
  checkImportSources, importsStatus, inspectImportContent, parseImportReference, previewImport,
  readStagedImport, removeAgentTableRow, resolveChangeSetImports, stageImport, suggestImportKind,
  upsertAgentTableRow
} from '../src/asset-import.mjs';
import { fetchRemoteBytes, isPublicRemoteAddress } from '../src/remote-fetch.mjs';
import { agentStatus, lockAgent, prepareRemoteOutputs, syncAgent } from '../src/agents.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Import Tester' };
delete env.SINGULARITY_FLOW_TEST_REMOTE_FIXTURES;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function repository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-import-unit-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'Import Tester'], root); run('git', ['config', 'user.email', 'imports@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# Imports\n');
  run(process.execPath, [bin, 'init'], root);
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

function response(content, { status = 200, location = null } = {}) {
  const bytes = Buffer.from(content);
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => name.toLowerCase() === 'location' ? location : null }, arrayBuffer: async () => bytes };
}
const served = (values) => async (url) => (Object.hasOwn(values, url) ? response(values[url]) : response('missing', { status: 404 }));

async function staged(root, content, url = 'https://skills.example.org/a.md') {
  const bytes = Buffer.from(content);
  await stageImport(root, { bytes, source: { kind: 'url', url, resolvedUrl: url } });
  return { sha: sha256(bytes), imports: new Map([[sha256(bytes), await readStagedImport(root, sha256(bytes))]]) };
}
const plan = (root, changes, options = {}) => planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes }, options);

test('fetched bytes are exact: no newline is added, a byte-order mark is kept, and NAT64 and 6to4 hosts are private', async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# Title')]);
  const fetched = await fetchRemoteBytes('https://cdn.example.com/a.md', { fetchImpl: async () => response(bom) });
  assert.deepEqual(fetched.bytes, bom);
  assert.equal(fetched.sha256, sha256(bom));
  assert.equal(isPublicRemoteAddress('64:ff9b::a00:1'), false, 'NAT64 can embed 10.0.0.1');
  assert.equal(isPublicRemoteAddress('2002:a00:1::1'), false, '6to4 can embed 10.0.0.1');
  assert.equal(isPublicRemoteAddress('2606:4700:4700::1111'), true);
});

test('a locked remote skill without a final newline stays ready after one sync, and generated output is not "edited locally"', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-exact-'));
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/reviewer.agent.md'), [
    '---', 'name: reviewer', 'description: Reviews things.', '---', '# Reviewer', '', 'Review.', '',
    '## Remote skills', '', '| ID | URL | Phases | Optional | Max bytes |', '|---|---|---|---|---|',
    '| checklist | https://cdn.example.com/checklist.md | design | no | 1024 |', '',
    '## Remote generated artifacts', '', '| ID | URL template | Phase | Target | Optional | Max bytes |', '|---|---|---|---|---|---|',
    '| notes | https://cdn.example.com/{workId}.md | design | artifacts/design/notes.md | no | 1024 |', ''
  ].join('\n'));
  const fetchImpl = served({ 'https://cdn.example.com/checklist.md': '# Checklist', 'https://cdn.example.com/ARCH-1.md': '# Notes' });
  const preview = await lockAgent(root, 'reviewer', { fetchImpl });
  await lockAgent(root, 'reviewer', { accepted: true, resolution: preview.resolution });
  const lock = await readFile(path.join(root, 'singularity/agents.lock.yml'), 'utf8');
  assert.doesNotMatch(lock, /bytes:|content:/, 'fetched bytes are never written into the lock');
  await syncAgent(root, 'reviewer', { fetchImpl });
  assert.equal((await agentStatus(root, 'reviewer'))[0].status, 'ready', 'the cached copy matches its locked hash');
  await syncAgent(root, 'reviewer', { fetchImpl: async () => { throw new Error('a ready cache is not fetched again'); } });
  const itemDirectory = path.join(root, 'singularity/work-items/ARCH-1'); await mkdir(itemDirectory, { recursive: true });
  const workflow = { workItem: { id: 'ARCH-1', workType: 'feature' } }; const phase = { id: 'design', generation: 0 };
  await prepareRemoteOutputs(root, workflow, phase, { agent: 'reviewer' }, { itemDirectory, fetchImpl });
  const again = await prepareRemoteOutputs(root, workflow, phase, { agent: 'reviewer' }, { itemDirectory, fetchImpl: async () => { throw new Error('reuse'); } });
  assert.equal(again.outputs[0].renderedSha256, sha256('# Notes'));
});

test('references, kinds and content checks refuse what could never be used', () => {
  assert.equal(parseImportReference('https://skills.example.org/a.md').kind, 'url');
  assert.throws(() => parseImportReference('http://skills.example.org/a.md'), { code: 'IMPORT_REFERENCE_UNSUPPORTED' });
  assert.throws(() => parseImportReference('https://localhost/a.md'), /public Internet host/);
  assert.throws(() => parseImportReference('https://user:secret@skills.example.org/a.md'), /without embedded credentials/);
  assert.throws(() => parseImportReference('ftp://skills.example.org/a.md'), { code: 'IMPORT_REFERENCE_UNSUPPORTED' });
  assert.equal(suggestImportKind('---\nname: a\ndescription: b\ntools: [read]\n---\nBody'), 'agent');
  assert.equal(suggestImportKind('# {{work.id}} plan'), 'template');
  assert.equal(suggestImportKind('# Checklist\n- one'), 'skill');
  assert.throws(() => inspectImportContent('skill', '<!DOCTYPE html><html></html>'), { code: 'IMPORT_NOT_MARKDOWN' });
  assert.throws(() => inspectImportContent('skill', 'token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"'), { code: 'IMPORT_SECRET_DETECTED' });
  assert.throws(() => inspectImportContent('template', '# {{secret}}'), { code: 'IMPORT_TEMPLATE_INVALID' });
  assert.throws(() => inspectImportContent('agent', '---\nname: real-name\ndescription: x\n---\nBody', { id: 'other-name' }), { code: 'IMPORT_AGENT_ID_MISMATCH' });
  const agent = inspectImportContent('agent', '---\nname: helper\ndescription: Helps.\nmetadata:\n  sflow-default-for: "design"\n---\nBody');
  assert.equal(agent.id, 'helper');
  assert.match(agent.warnings.join(' '), /exactly one default agent/);
});

test('agent resource rows are added to the exact table shape, replaced only deliberately, and removed', () => {
  const empty = '# Agent\n\nDo things.\n\n## Remote skills\n\n| ID | URL | Phases | Optional | Max bytes |\n|---|---|---|---|---|\n\n## Notes\n\nKeep.\n';
  const added = upsertAgentTableRow(empty, 'skill', ['checklist', 'https://cdn.example.com/c.md', 'design', 'no', '1024']);
  assert.match(added, /\|---\|---\|---\|---\|---\|\n\| checklist \| https:\/\/cdn\.example\.com\/c\.md \| design \| no \| 1024 \|\n\n## Notes/);
  assert.throws(() => upsertAgentTableRow(added, 'skill', ['checklist', 'https://cdn.example.com/d.md', '*', 'no', '1024']), { code: 'IMPORT_TARGET_EXISTS' });
  const replaced = upsertAgentTableRow(added, 'skill', ['checklist', 'https://cdn.example.com/d.md', '*', 'no', '1024'], { replace: true });
  assert.match(replaced, /\| checklist \| https:\/\/cdn\.example\.com\/d\.md \| \* \|/);
  assert.doesNotMatch(replaced, /c\.md/);
  const created = upsertAgentTableRow('# Agent\n\nDo things.\n', 'generated', ['notes', 'https://cdn.example.com/{workId}.md', 'design', 'artifacts/design/notes.md', 'no', '1024']);
  assert.match(created, /## Remote generated artifacts\n\n\| ID \| URL template \| Phase \| Target \| Optional \| Max bytes \|\n\|---\|---\|---\|---\|---\|---\|\n\| notes \|/);
  assert.doesNotMatch(removeAgentTableRow(replaced, 'skill', 'checklist'), /checklist/);
  assert.match(removeAgentTableRow(replaced, 'skill', 'checklist'), /## Notes\n\nKeep\./);
  assert.throws(() => upsertAgentTableRow(empty, 'skill', ['x', 'https://a|b', '*', 'no', '1']), { code: 'IMPORT_ROW_INVALID' });
});

test('an imported skill is vendored with its lock entry; the agent then runs offline and refuses edited bytes', async () => {
  const root = await repository();
  const content = '# Security review\n\n- Check every entry point.';
  const { sha, imports } = await staged(root, content);
  const changes = [{ op: 'import.skill', agent: 'architect', id: 'security-review', source: 'https://skills.example.org/a.md', sha256: sha, phases: ['design'] }];
  const dry = await plan(root, changes, { imports });
  assert.equal(dry.valid, true, JSON.stringify(dry.problems));
  assert.deepEqual(dry.files.map((file) => [file.action, file.path]).sort(), [
    ['create', 'singularity/agents.lock.yml'], ['create', 'singularity/imports.lock.yml'],
    ['create', 'singularity/imports/agents/architect/skill-security-review.md'], ['update', '.github/agents/architect.agent.md']
  ]);
  await plan(root, changes, { imports, write: true });
  assert.equal(await readFile(path.join(root, 'singularity/imports/agents/architect/skill-security-review.md'), 'utf8'), content);
  const synced = await syncAgent(root, 'architect', { fetchImpl: async () => { throw new Error('an imported skill is never fetched'); } });
  assert.equal(synced.dependencies[0].status, 'ready');
  // `agents lock --update` keeps the reviewed import instead of trusting newly fetched bytes.
  const relock = await lockAgent(root, 'architect', { update: true, fetchImpl: async () => { throw new Error('not fetched'); } });
  assert.equal(relock.resolution.dependencies[0].vendored, 'singularity/imports/agents/architect/skill-security-review.md');
  await writeFile(path.join(root, 'singularity/imports/agents/architect/skill-security-review.md'), `${content}\nEdited.\n`);
  await assert.rejects(() => syncAgent(root, 'architect'), { code: 'AGENT_VENDORED_DEPENDENCY_MISMATCH' });
  assert.match((await importsStatus(root))[0].status, /^edited/);
});

test('adding to an agent that names untrusted remote resources is refused; a Studio edit re-stamps a current lock', async () => {
  const root = await repository();
  const file = path.join(root, '.github/agents/architect.agent.md');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('|---|---|---|---|---|\n', '|---|---|---|---|---|\n| existing | https://cdn.example.com/e.md | * | no | 1024 |\n'));
  const { sha, imports } = await staged(root, '# Extra');
  const refused = await plan(root, [{ op: 'import.skill', agent: 'architect', id: 'extra', source: 'https://skills.example.org/a.md', sha256: sha }], { imports });
  assert.equal(refused.valid, false);
  assert.equal(refused.problems[0].code, 'STUDIO_AGENT_LOCK_REQUIRED');

  const fetchImpl = served({ 'https://cdn.example.com/e.md': '# Existing\n' });
  const preview = await lockAgent(root, 'architect', { fetchImpl });
  await lockAgent(root, 'architect', { accepted: true, resolution: preview.resolution });
  await plan(root, [{ op: 'agent.update', id: 'architect', description: 'Designs systems, carefully.' }], { write: true });
  const lock = YAML.parse(await readFile(path.join(root, 'singularity/agents.lock.yml'), 'utf8'));
  assert.equal(lock.agents.architect.sourceSha256, sha256(await readFile(file)), 'the edited agent keeps a current lock');
  assert.equal(lock.agents.architect.dependencies[0].sha256, sha256('# Existing\n'));
});

test('templates and agents import exactly; replacing local work and removing in-use imports are refused', async () => {
  const root = await repository();
  const template = '# {{work.id}} threat model\n\n{{inputs}}';
  const first = await staged(root, template, 'https://skills.example.org/t.md');
  const result = await plan(root, [{ op: 'import.template', id: 'threat-model', source: 'https://skills.example.org/t.md', sha256: first.sha, phases: ['design'] }], { imports: first.imports, write: true });
  assert.equal(result.valid, true, JSON.stringify(result.problems));
  assert.equal(await readFile(path.join(root, 'singularity/templates/imported/threat-model.md'), 'utf8'), template);
  const workflow = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(workflow.phases.design.defaultTemplate, 'template:threat-model');
  assert.deepEqual(workflow.templates['threat-model'], { path: 'imported/threat-model.md', label: 'Threat model' });
  const inUse = await plan(root, [{ op: 'import.remove', key: 'template:threat-model' }]);
  assert.equal(inUse.problems[0].code, 'STUDIO_TEMPLATE_IN_USE');

  const agent = '---\nname: security-reviewer\ndescription: Reviews security.\ntools: [read]\nmetadata:\n  sflow-default-for: "design"\n---\n# Security reviewer\n\nReview.\n';
  const second = await staged(root, agent, 'https://skills.example.org/r.agent.md');
  const conflict = await plan(root, [{ op: 'import.agent', source: 'https://skills.example.org/r.agent.md', sha256: second.sha }], { imports: second.imports });
  assert.equal(conflict.valid, false, 'two default agents for one step are refused');
  assert.equal(conflict.problems[0].code, 'STUDIO_PHASE_AGENT_CONFLICT');
  const kept = await plan(root, [{ op: 'import.agent', source: 'https://skills.example.org/r.agent.md', sha256: second.sha, withoutDefaults: true }], { imports: second.imports, write: true });
  assert.equal(kept.valid, true, JSON.stringify(kept.problems));
  assert.doesNotMatch(await readFile(path.join(root, '.github/agents/security-reviewer.agent.md'), 'utf8'), /sflow-default-for/);
  const local = await staged(root, '---\nname: architect\ndescription: Not ours.\n---\nBody\n', 'https://skills.example.org/x.agent.md');
  const replaceLocal = await plan(root, [{ op: 'import.agent', source: 'https://skills.example.org/x.agent.md', sha256: local.sha, replace: true }], { imports: local.imports });
  assert.equal(replaceLocal.problems[0].code, 'STUDIO_AGENT_EXISTS');
  assert.match(replaceLocal.problems[0].message, /not imported/);
});

test('an add re-fetches content that is no longer staged and refuses when it changed', async () => {
  const root = await repository();
  const url = 'https://skills.example.org/fresh.md';
  const preview = await previewImport(root, url, { as: 'skill', fetchImpl: served({ [url]: '# Fresh' }) });
  const changeSet = { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ op: 'import.skill', agent: 'architect', id: 'fresh', source: url, sha256: preview.sha256 }] };
  await writeFile(path.join(root, '.git/singularity-flow/imports/staged', `${preview.sha256}.json`), '{}');
  const same = await resolveChangeSetImports(root, changeSet, { fetchImpl: served({ [url]: '# Fresh' }) });
  assert.equal(same.get(preview.sha256).size, 7);
  await writeFile(path.join(root, '.git/singularity-flow/imports/staged', `${preview.sha256}.json`), '{}');
  const changed = await planStudioChangeSet(root, changeSet, { fetchImpl: served({ [url]: '# Changed' }) });
  assert.equal(changed.valid, false);
  assert.equal(changed.problems[0].code, 'IMPORT_CONTENT_CHANGED');
});

test('imports check reports changed sources with the exact reviewed update command', async () => {
  const root = await repository();
  const url = 'https://skills.example.org/c.md';
  const { sha, imports } = await staged(root, '# One', url);
  await plan(root, [{ op: 'import.skill', agent: 'architect', id: 'c', source: url, sha256: sha, phases: ['design'] }], { imports, write: true });
  const [same] = await checkImportSources(root, { fetchImpl: served({ [url]: '# One' }) });
  assert.equal(same.status, 'up to date');
  const [changed] = await checkImportSources(root, { fetchImpl: served({ [url]: '# Two' }) });
  assert.equal(changed.status, 'changed at its source');
  assert.equal(changed.updateCommand, `singularity-flow import add "${url}" --as skill --agent architect --id c --phases design --sha256 ${sha256('# Two')} --replace`);
  assert.ok(await readStagedImport(root, sha256('# Two')), 'the new version is staged for review');
});

test('a workflow bundle carries an imported skill as an ordinary locked dependency, never a path in this repository', async () => {
  const root = await repository();
  const url = 'https://skills.example.org/bundle.md';
  const { sha, imports } = await staged(root, '# Bundled skill\n', url);
  await plan(root, [{ op: 'import.skill', agent: 'architect', id: 'bundled', source: url, sha256: sha, phases: ['design'] }], { imports, write: true });
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'import'], root);
  const out = path.join(root, '..', `${path.basename(root)}-bundle.json`);
  run(process.execPath, [bin, 'workflow', 'export', '--workflow', 'feature', '--out', out], root);
  const bundle = JSON.parse(await readFile(out, 'utf8'));
  const dependency = bundle.agentLocks.architect.dependencies.find((entry) => entry.id === 'bundled');
  assert.equal(dependency.sha256, sha);
  assert.equal(dependency.url, url);
  assert.equal(dependency.vendored, undefined);
});
