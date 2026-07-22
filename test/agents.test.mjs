import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  agentStatus,
  fetchRemoteMarkdown,
  lockAgent,
  materializeAgentTemplate,
  parseAgentDependencies,
  prepareRemoteOutputs,
  renderAgentSkills,
  syncAgent
} from '../src/agents.mjs';
import { setAgentSession, setPersonaSession, loadSession } from '../src/session.mjs';
import { initializeDefinition, loadDefinition, resolveWorkType } from '../src/config.mjs';
import { createWorkflow } from '../src/state.mjs';
import YAML from 'yaml';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin/singularity-flow.mjs');

const agentMarkdown = `---
name: architecture
description: Architecture delivery
tools: ["bash", "edit", "view"]
---

This prose link is inert: https://example.com/not-a-dependency.md

## Remote skills

| ID | URL | Phases | Personas | Optional | Max bytes |
|---|---|---|---|---|---|
| secure-review | https://cdn.example.com/skill.md | design, verification | architect | false | 4096 |

## Remote artifact templates

| ID | URL | Phases | Optional | Max bytes |
|---|---|---|---|---|
| design-template | https://cdn.example.com/design.md | design | false | 8192 |

## Remote generated artifacts

| ID | URL template | Phase | Target | Optional | Max bytes |
|---|---|---|---|---|---|
| threat-model | https://cdn.example.com/{workId}/{phase}/{generation}.md | design | artifacts/design/threat-model.md | false | 4096 |
`;

function response(content, { status = 200, location = null } = {}) {
  const bytes = Buffer.from(content);
  return { ok: status >= 200 && status < 300, status, headers: { get: (name) => name.toLowerCase() === 'location' ? location : null }, arrayBuffer: async () => bytes };
}

async function rootWithAgent(content = agentMarkdown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-'));
  await mkdir(path.join(root, '.github/agents'), { recursive: true });
  await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(root, '.github/agents/architecture.agent.md'), content);
  return root;
}

function remoteFetch(values, calls = []) {
  return async (url) => {
    calls.push(url);
    if (!Object.hasOwn(values, url)) return response('missing', { status: 404 });
    return response(values[url]);
  };
}

test('agent Markdown parser processes only exact dependency tables and validates safety', () => {
  const parsed = parseAgentDependencies(agentMarkdown, { source: '.github/agents/architecture.agent.md' });
  assert.equal(parsed.id, 'architecture');
  assert.deepEqual(parsed.dependencies.map((entry) => entry.id), ['secure-review', 'design-template', 'threat-model']);
  assert.deepEqual(parsed.skills[0].phases, ['design', 'verification']);
  assert.equal(parsed.dependencies.some((entry) => entry.url.includes('not-a-dependency')), false);
  assert.throws(() => parseAgentDependencies(agentMarkdown.replace('https://cdn.example.com/skill.md', 'http://cdn.example.com/skill.md')), /public HTTPS/);
  assert.throws(() => parseAgentDependencies(agentMarkdown.replace('https://cdn.example.com/skill.md', 'https://127.0.0.1/skill.md')), /public Internet host/);
  assert.throws(() => parseAgentDependencies(agentMarkdown.replace('{generation}', '{secret}')), /unsupported variable/);
  assert.throws(() => parseAgentDependencies(agentMarkdown.replace('artifacts/design/threat-model.md', '../threat-model.md')), /under artifacts\/design/);
  assert.throws(() => parseAgentDependencies(agentMarkdown.replace('| design-template |', '| secure-review |')), /duplicated/);
});

test('remote fetch enforces redirects, UTF-8 content, emptiness, and byte ceilings', async () => {
  const calls = [];
  const fetched = await fetchRemoteMarkdown('https://example.com/start.md', { maxBytes: 20, fetchImpl: async (url) => {
    calls.push(url);
    return url.endsWith('start.md') ? response('', { status: 302, location: 'https://cdn.example.com/final.md' }) : response('# trusted\n');
  } });
  assert.deepEqual(calls, ['https://example.com/start.md', 'https://cdn.example.com/final.md']);
  assert.equal(fetched.content, '# trusted\n');
  await assert.rejects(() => fetchRemoteMarkdown('https://example.com/empty.md', { fetchImpl: async () => response('') }), /empty Markdown/);
  await assert.rejects(() => fetchRemoteMarkdown('https://example.com/large.md', { maxBytes: 2, fetchImpl: async () => response('large') }), /byte limit/);
  await assert.rejects(() => fetchRemoteMarkdown('https://example.com/bad.md', { fetchImpl: async () => response(Buffer.from([0xc3, 0x28])) }), /UTF-8/);
});

test('TOFU locks hashes, sync reuses verified cache, and changed agent content requires update', async () => {
  const root = await rootWithAgent(); const calls = [];
  const values = {
    'https://cdn.example.com/skill.md': '# Skill\nReview boundaries.\n',
    'https://cdn.example.com/design.md': '# {{work.id}} design\n\n{{inputs}}\n'
  };
  const fetchImpl = remoteFetch(values, calls);
  const preview = await lockAgent(root, 'architecture', { fetchImpl });
  assert.equal(preview.written, false);
  await assert.rejects(() => readFile(path.join(root, '.singularity/agents.lock.yml')), /ENOENT/);
  await lockAgent(root, 'architecture', { accepted: true, resolution: preview.resolution, fetchImpl });
  const synced = await syncAgent(root, 'architecture', { fetchImpl });
  assert.equal(synced.dependencies.filter((entry) => entry.status === 'ready').length, 2);
  const callsAfterSync = calls.length;
  await syncAgent(root, 'architecture', { fetchImpl: async () => { throw new Error('network must not be used for cached locks'); } });
  assert.equal(calls.length, callsAfterSync);
  assert.equal((await agentStatus(root, 'architecture'))[0].status, 'ready');
  await writeFile(path.join(root, '.github/agents/architecture.agent.md'), `${agentMarkdown}\nChanged agent contract.\n`);
  await assert.rejects(() => syncAgent(root, 'architecture', { fetchImpl }), /changed after locking/);
});

test('locked skills route by phase and persona and are copied into generation context', async () => {
  const root = await rootWithAgent(); const values = { 'https://cdn.example.com/skill.md': '# Skill\nReview boundaries.\n', 'https://cdn.example.com/design.md': '# Design\n' }; const fetchImpl = remoteFetch(values);
  const preview = await lockAgent(root, 'architecture', { fetchImpl }); await lockAgent(root, 'architecture', { accepted: true, resolution: preview.resolution }); await syncAgent(root, 'architecture', { fetchImpl });
  const itemDirectory = path.join(root, '.singularity/work-items/ARCH-1'); await mkdir(itemDirectory, { recursive: true });
  const workflow = { workItem: { id: 'ARCH-1', workType: 'feature' } }; const phase = { id: 'design', generation: 0 };
  const selected = await renderAgentSkills(root, workflow, phase, { agent: 'architecture', persona: 'architect' }, { record: true, itemDirectory, fetchImpl });
  assert.match(selected.text, /Remote skill: secure-review/);
  const audit = JSON.parse(await readFile(path.join(itemDirectory, 'context/agents-design-gen1.json'), 'utf8'));
  assert.equal(audit.files[0].sha256, selected.skills[0].sha256);
  const excluded = await renderAgentSkills(root, workflow, phase, { agent: 'architecture', persona: 'developer' }, { fetchImpl });
  assert.equal(excluded.skills.length, 0);
  const template = await materializeAgentTemplate(root, 'agent:architecture/design-template', { phaseId: 'design', fetchImpl });
  assert.equal(template.source, 'agent');
  await assert.rejects(() => materializeAgentTemplate(root, 'agent:architecture/design-template', { phaseId: 'verification', fetchImpl }), /not scoped/);
});

test('dynamic output snapshots are reused and local edits need explicit replacement', async () => {
  const root = await rootWithAgent(); const values = { 'https://cdn.example.com/skill.md': '# Skill\n', 'https://cdn.example.com/design.md': '# Design\n', 'https://cdn.example.com/ARCH-1/design/1.md': '# Threat model v1\n' }; const calls = []; const fetchImpl = remoteFetch(values, calls);
  const preview = await lockAgent(root, 'architecture', { fetchImpl }); await lockAgent(root, 'architecture', { accepted: true, resolution: preview.resolution }); await syncAgent(root, 'architecture', { fetchImpl });
  const itemDirectory = path.join(root, '.singularity/work-items/ARCH-1'); await mkdir(itemDirectory, { recursive: true });
  const workflow = { workItem: { id: 'ARCH-1', workType: 'feature' } }; const phase = { id: 'design', generation: 0 };
  const first = await prepareRemoteOutputs(root, workflow, phase, { agent: 'architecture' }, { itemDirectory, fetchImpl });
  assert.equal(first.outputs[0].target, 'artifacts/design/threat-model.md');
  const fetchCount = calls.length;
  await prepareRemoteOutputs(root, workflow, phase, { agent: 'architecture' }, { itemDirectory, fetchImpl: async () => { throw new Error('snapshot should be reused'); } });
  assert.equal(calls.length, fetchCount);
  const target = path.join(itemDirectory, 'artifacts/design/threat-model.md'); await writeFile(target, '# Local edit\n');
  await assert.rejects(() => prepareRemoteOutputs(root, workflow, phase, { agent: 'architecture' }, { itemDirectory, fetchImpl }), /edited locally/);
  values['https://cdn.example.com/ARCH-1/design/1.md'] = '# Threat model v2\n';
  await assert.rejects(() => prepareRemoteOutputs(root, workflow, phase, { agent: 'architecture' }, { itemDirectory, refresh: true, resourceId: 'threat-model', fetchImpl }), /local edits/);
  const refreshed = await prepareRemoteOutputs(root, workflow, phase, { agent: 'architecture' }, { itemDirectory, refresh: true, replace: true, resourceId: 'threat-model', fetchImpl });
  assert.notEqual(refreshed.outputs[0].sourceSha256, first.outputs[0].sourceSha256);
});

test('agent sync preserves selected persona in local session', async () => {
  const root = await rootWithAgent(`---\nname: local-agent\ndescription: Local only\ntools: ["bash"]\n---\n\nNo dependencies.\n`);
  const definition = { personas: { architect: { label: 'Architect' } } };
  await setPersonaSession(root, definition, { name: 'A' }, 'architect', 'ARCH-1');
  const synced = await syncAgent(root, 'local-agent'); await setAgentSession(root, synced.agent);
  const session = await loadSession(root);
  assert.equal(session.persona, 'architect'); assert.equal(session.agent, 'local-agent'); assert.equal(session.workId, 'ARCH-1');
});

test('CLI first trust fails non-interactively unless exact test confirmation is supplied', async () => {
  const root = await rootWithAgent(`---\nname: local-agent\ndescription: Local only\ntools: ["bash"]\n---\n\nNo dependencies.\n`);
  assert.equal(spawnSync('git', ['init', '-b', 'main'], { cwd: root }).status, 0);
  const denied = spawnSync(process.execPath, [bin, 'agents', 'lock', 'local-agent'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test' } });
  assert.notEqual(denied.status, 0); assert.match(denied.stderr, /requires an interactive terminal/);
  const accepted = spawnSync(process.execPath, [bin, 'agents', 'lock', 'local-agent'], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_AGENT_CONFIRM: 'local-agent' } });
  assert.equal(accepted.status, 0, accepted.stderr); assert.match(accepted.stdout, /Locked 'local-agent'/);
});

test('explicit remote templates are copied into immutable work-item context', async () => {
  const root = await rootWithAgent();
  for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Agent Tester'], ['config', 'user.email', 'agent@example.com']]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0);
  await initializeDefinition(root);
  const workflowFile = path.join(root, '.singularity/workflow.yml'); const definition = YAML.parse(await readFile(workflowFile, 'utf8'));
  definition.git.publish = 'off'; definition.workTypes.feature.templateOverrides.design = 'agent:architecture/design-template';
  await writeFile(workflowFile, YAML.stringify(definition));
  const values = { 'https://cdn.example.com/skill.md': '# Skill\n', 'https://cdn.example.com/design.md': '# Remote {{work.id}} design\n\n{{inputs}}\n' }; const fetchImpl = remoteFetch(values);
  const preview = await lockAgent(root, 'architecture', { fetchImpl }); await lockAgent(root, 'architecture', { accepted: true, resolution: preview.resolution }); await syncAgent(root, 'architecture', { fetchImpl });
  assert.equal(spawnSync('git', ['add', '.'], { cwd: root }).status, 0); assert.equal(spawnSync('git', ['commit', '-m', 'initialize'], { cwd: root }).status, 0); assert.equal(spawnSync('git', ['checkout', '-b', 'ARCH-2'], { cwd: root }).status, 0);
  const loaded = await loadDefinition(root); await setPersonaSession(root, loaded, { name: 'Agent Tester', email: 'agent@example.com' }, 'architect', 'ARCH-2'); await setAgentSession(root, (await syncAgent(root, 'architecture', { fetchImpl })).agent);
  const created = await createWorkflow(root, loaded, { id: 'ARCH-2', title: 'Pinned remote template', source: { type: 'manual', key: 'ARCH-2', title: 'Pinned remote template', description: 'Verify immutable template delivery.', acceptanceCriteria: [] }, baseBranch: 'main', workType: 'feature', persona: 'architect', resolved: resolveWorkType(loaded, 'feature') });
  const template = created.resolution.templates.design;
  assert.equal(template.source, 'agent'); assert.match(template.path, /context\/agent-templates\/architecture/); assert.equal(await readFile(path.join(root, template.path), 'utf8'), values['https://cdn.example.com/design.md']);
});
