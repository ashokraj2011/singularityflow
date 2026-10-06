import { repositoryOwnedWorkflows } from './helpers/repository-owned-workflows.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { mcpTransportFromEntry, describeMcpTransport } from '../src/mcp-client.mjs';
import { fetchMcpContent, listMcpSources, normalizeMcpArguments, parseMcpReference } from '../src/mcp-import.mjs';
import { mcpImportOnly, mcpServersForContext, mcpSourceAllowed, normalizeMcpServers } from '../src/mcp.mjs';
import { previewImport, readStagedImport } from '../src/asset-import.mjs';
import { agentStatus, lockAgent, syncAgent } from '../src/agents.mjs';
import { planStudioChangeSet, STUDIO_CHANGE_SET_SCHEMA } from '../src/workflow-studio.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const fixture = path.join(packageRoot, 'test', 'fixtures', 'mcp-docs-server.mjs');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'MCP Tester' };
const SOURCES = { prompts: ['security-checklist'], resources: ['docs://templates/'], tools: ['render-notes', 'fail'] };

function run(command, args, cwd, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** A governed repository whose `docs` MCP server is the stdio fixture, allowed for imports only. */
async function repository({ entry = { type: 'stdio', command: process.execPath, args: [fixture] }, sources = SOURCES } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-import-'));
  run('git', ['init', '-b', 'main'], root); run('git', ['config', 'user.name', 'MCP Tester'], root); run('git', ['config', 'user.email', 'mcp@example.com'], root);
  await writeFile(path.join(root, 'README.md'), '# MCP\n');
  run(process.execPath, [bin, 'init'], root);
  // Imports into an agent's own tables need an agent the repository owns; seeded agents are read-only.
  await repositoryOwnedWorkflows(root);
  const file = path.join(root, 'singularity/workflow.yml');
  const document = YAML.parseDocument(await readFile(file, 'utf8'));
  document.setIn(['mcpServers', 'docs'], document.createNode({ label: 'Docs server', ...(sources ? { sources } : {}) }));
  await writeFile(file, document.toString());
  await mkdir(path.join(root, '.vscode'), { recursive: true });
  await writeFile(path.join(root, '.vscode/mcp.json'), JSON.stringify({ servers: { docs: entry } }, null, 2));
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'initialize'], root);
  return root;
}

test('host entries become bounded transports; prompts only VS Code can answer, and plain remote HTTP, are refused', () => {
  const root = '/work/repo';
  const stdio = mcpTransportFromEntry({ command: 'node', args: ['${workspaceFolder}/server.mjs'], env: { TOKEN: '${env:SFLOW_TEST_MCP_TOKEN}' } }, { root, name: 'docs' });
  assert.deepEqual([stdio.type, stdio.args[0], stdio.cwd], ['stdio', '/work/repo/server.mjs', root]);
  assert.match(describeMcpTransport(stdio), /^runs node \/work\/repo\/server\.mjs in \/work\/repo$/);
  assert.throws(() => mcpTransportFromEntry({ command: 'node', env: { KEY: '${input:key}' } }, { root }), { code: 'MCP_HOST_INPUT_UNSUPPORTED' });
  assert.throws(() => mcpTransportFromEntry({ type: 'http', url: 'http://docs.example.org/mcp' }, { root }), /HTTPS, or plain HTTP only on this machine/);
  assert.throws(() => mcpTransportFromEntry({ type: 'sse', url: 'https://docs.example.org/sse' }, { root }), { code: 'MCP_HOST_ENTRY_UNSUPPORTED' });
  const http = mcpTransportFromEntry({ type: 'http', url: 'https://docs.example.org/mcp', headers: { Authorization: 'Bearer ${env:SFLOW_TEST_MCP_TOKEN}' } }, { root });
  assert.equal(describeMcpTransport(http), 'connects to https://docs.example.org/mcp with header(s) Authorization', 'header values never appear');
});

test('the governed policy says what may be imported; a sources-only server is never offered to agents', () => {
  const servers = normalizeMcpServers({ docs: { sources: SOURCES }, browser: { tools: ['navigate'] } });
  assert.deepEqual(servers.docs.sources, SOURCES);
  assert.equal(servers.browser.sources, undefined, 'servers without sources keep their exact normalized shape');
  assert.equal(mcpImportOnly(servers.docs), true);
  assert.deepEqual(mcpServersForContext({ mcpServers: servers }, { agent: 'architect' }).map((server) => server.id), ['browser']);
  assert.equal(mcpSourceAllowed(servers.docs.sources, 'resource', 'docs://templates/decision-record'), true);
  assert.equal(mcpSourceAllowed(servers.docs.sources, 'resource', 'docs://private/notes'), false);
  assert.equal(mcpSourceAllowed(servers.docs.sources, 'prompt', 'secret-prompt'), false);
  assert.throws(() => normalizeMcpServers({ docs: { sources: {} } }), /at least one prompt, resource or tool/);
  assert.throws(() => normalizeMcpServers({ docs: { sources: { commands: ['x'] } } }), /unknown field 'commands'/);
  assert.deepEqual(parseMcpReference('mcp:docs/resource/docs%3A%2F%2Ftemplates%2Fdecision-record'), {
    kind: 'mcp', server: 'docs', method: 'resource', name: 'docs://templates/decision-record', display: 'mcp:docs/resource/docs%3A%2F%2Ftemplates%2Fdecision-record'
  });
  assert.throws(() => normalizeMcpArguments({ token: 'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB' }), { code: 'MCP_ARGUMENTS_INVALID' });
});

test('nothing is started without consent, and only what the policy allows is read', async () => {
  const marker = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-marker-')), 'started');
  const root = await repository({ entry: { type: 'stdio', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`] } });
  await assert.rejects(() => fetchMcpContent(root, parseMcpReference('mcp:docs/prompt/security-checklist')), (error) => {
    assert.equal(error.code, 'MCP_LAUNCH_CONSENT_REQUIRED');
    assert.match(error.message, /Importing from MCP server Docs server runs .*node.* -e/);
    return true;
  });
  assert.equal(existsSync(marker), false, 'the server was not launched');
  await assert.rejects(() => fetchMcpContent(root, parseMcpReference('mcp:docs/prompt/secret-prompt'), { launch: true }), { code: 'MCP_SOURCE_NOT_ALLOWED' });
  assert.equal(existsSync(marker), false);
  const closed = await repository({ sources: null });
  await assert.rejects(() => fetchMcpContent(closed, parseMcpReference('mcp:docs/prompt/security-checklist'), { launch: true }), (error) => {
    assert.equal(error.code, 'MCP_SOURCE_NOT_ALLOWED');
    assert.match(error.message, /mcpServers\.docs\.sources/);
    return true;
  });
});

test('a launched stdio server answers prompts, resources and tools, and lists only what the policy allows', async () => {
  const root = await repository();
  const prompt = await fetchMcpContent(root, parseMcpReference('mcp:docs/prompt/security-checklist'), { launch: true, arguments: { area: 'payments' } });
  assert.match(prompt.bytes.toString('utf8'), /^# Security checklist[\s\S]*Focus: payments\n$/);
  assert.deepEqual(prompt.source.serverInfo, { name: 'docs-fixture', version: '1.2.3' });
  assert.equal(prompt.source.url, 'mcp://docs/prompt/security-checklist');
  assert.deepEqual(prompt.source.arguments, { area: 'payments' });
  const resource = await fetchMcpContent(root, parseMcpReference('mcp:docs/resource/docs%3A%2F%2Ftemplates%2Fdecision-record'), { launch: true });
  assert.match(resource.bytes.toString('utf8'), /^# \{\{work\.id\}\} decision record/);
  const tool = await fetchMcpContent(root, parseMcpReference('mcp:docs/tool/render-notes'), { launch: true, arguments: { topic: 'caching' } });
  assert.match(tool.bytes.toString('utf8'), /^# Notes on caching/);
  await assert.rejects(() => fetchMcpContent(root, parseMcpReference('mcp:docs/tool/fail'), { launch: true }), { code: 'MCP_TOOL_ERROR' });
  const offered = await listMcpSources(root, 'docs', { launch: true });
  assert.deepEqual(offered.prompts.map((entry) => entry.name), ['security-checklist']);
  assert.deepEqual(offered.prompts[0].arguments, [{ name: 'area', description: 'Which area', required: false }]);
  assert.deepEqual(offered.resources.map((entry) => entry.reference), ['mcp:docs/resource/docs%3A%2F%2Ftemplates%2Fdecision-record']);
  assert.deepEqual(offered.tools.map((entry) => entry.name), ['render-notes', 'fail']);
});

for (const mode of ['json', 'sse']) {
  test(`a streamable HTTP server on this machine answers too (${mode})`, async (t) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-http-'));
    const portFile = path.join(directory, 'port');
    const server = spawn(process.execPath, [fixture, '--http', portFile, ...(mode === 'sse' ? ['--sse'] : [])], { stdio: 'ignore' });
    t.after(() => server.kill());
    for (let attempt = 0; attempt < 100 && !existsSync(portFile); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const port = Number(await readFile(portFile, 'utf8'));
    const root = await repository({ entry: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } });
    const fetched = await fetchMcpContent(root, parseMcpReference('mcp:docs/prompt/security-checklist'), { launch: true });
    assert.match(fetched.bytes.toString('utf8'), /^# Security checklist/);
    assert.equal(fetched.source.hostSurface, 'vscode-workspace');
  });
}

test('an MCP skill is previewed with consent, vendored, read offline, kept by re-locking, and refused by bundles', async () => {
  const root = await repository();
  const reference = 'mcp:docs/prompt/security-checklist';
  await assert.rejects(() => previewImport(root, reference, { as: 'skill' }), { code: 'MCP_LAUNCH_CONSENT_REQUIRED' });
  const preview = await previewImport(root, reference, { as: 'skill', launch: true, arguments: { area: 'auth' } });
  assert.equal((await readStagedImport(root, preview.sha256)).source.kind, 'mcp');
  const changes = [{ op: 'import.skill', agent: 'architect', id: 'security-checklist', source: reference, sha256: preview.sha256, phases: ['design'] }];
  const applied = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes }, { write: true });
  assert.equal(applied.valid, true, JSON.stringify(applied.problems));
  const agent = await readFile(path.join(root, '.github/agents/architect.agent.md'), 'utf8');
  assert.match(agent, /\| security-checklist \| mcp:\/\/docs\/prompt\/security-checklist \| design \| no \|/);
  const vendored = await readFile(path.join(root, 'singularity/imports/agents/architect/skill-security-checklist.md'));
  assert.equal(sha256(vendored), preview.sha256);
  const ledger = YAML.parse(await readFile(path.join(root, 'singularity/imports.lock.yml'), 'utf8'));
  assert.deepEqual(ledger.imports['skill:architect/security-checklist'].source.arguments, { area: 'auth' });
  // Nothing contacts the server again: sync reads the vendored copy; re-locking keeps it.
  await writeFile(path.join(root, '.vscode/mcp.json'), JSON.stringify({ servers: {} }));
  assert.equal((await syncAgent(root, 'architect')).dependencies[0].status, 'ready');
  assert.equal((await agentStatus(root, 'architect'))[0].status, 'ready');
  const relock = await lockAgent(root, 'architect', { update: true });
  assert.equal(relock.resolution.dependencies[0].vendored, 'singularity/imports/agents/architect/skill-security-checklist.md');
  // A staged preview that is gone cannot be fetched again from an MCP server.
  const missing = await planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes: [{ ...changes[0], id: 'again', sha256: 'f'.repeat(64) }] });
  assert.equal(missing.problems[0].code, 'IMPORT_NOT_STAGED');
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'import from mcp'], root);
  const exported = run(process.execPath, [bin, 'workflow', 'export', '--workflow', 'repo-feature', '--out', path.join(root, '..', `${path.basename(root)}.json`)], root, { allowFailure: true });
  assert.notEqual(exported.status, 0);
  assert.match(exported.stderr, /imported from an MCP server, which a workflow bundle cannot carry yet/);
});

const DESCRIPTOR = {
  format: 'sflow-mcp-server@1', id: 'tickets', label: 'Ticket search', description: 'Searches the ticket tracker.',
  policy: { tools: ['search'], approval: 'confirm' },
  host: { type: 'stdio', command: 'npx', args: ['-y', '@example/tickets-mcp@2.1.0'], env: { TICKETS_TOKEN: '${input:tickets-token}' } },
  inputs: [{ id: 'tickets-token', type: 'promptString', description: 'Ticket tracker token', password: true }]
};

test('an MCP server descriptor is checked before review: no self-assigned agents, HTTPS only, floating packages flagged', async () => {
  const { parseMcpServerDescriptor } = await import('../src/mcp-descriptor.mjs');
  const parsed = parseMcpServerDescriptor(JSON.stringify(DESCRIPTOR));
  assert.deepEqual([parsed.id, parsed.policy.tools, parsed.host.command], ['tickets', ['search'], 'npx']);
  assert.ok(!parsed.warnings.some((warning) => /without an exact version/.test(warning)));
  const floating = parseMcpServerDescriptor(JSON.stringify({ ...DESCRIPTOR, host: { ...DESCRIPTOR.host, args: ['-y', '@example/tickets-mcp'] } }));
  assert.ok(floating.warnings.some((warning) => /without an exact version/.test(warning)));
  assert.throws(() => parseMcpServerDescriptor(JSON.stringify({ ...DESCRIPTOR, policy: { agents: ['architect'] } })), /importing repository chooses agents and steps/);
  assert.throws(() => parseMcpServerDescriptor(JSON.stringify({ ...DESCRIPTOR, host: { type: 'http', url: 'http://tickets.example.org/mcp' } })), /HTTPS URL/);
  assert.throws(() => parseMcpServerDescriptor('{"format":"other"}'), /sflow-mcp-server@1/);
});

test('installing an MCP server adds its governed policy, grants the chosen agents its tools, and writes the host entry only on request', async () => {
  const root = await repository();
  const { stageImport } = await import('../src/asset-import.mjs');
  const bytes = Buffer.from(`${JSON.stringify(DESCRIPTOR, null, 2)}\n`);
  await stageImport(root, { bytes, source: { kind: 'url', url: 'https://tools.example.org/tickets.json', resolvedUrl: 'https://tools.example.org/tickets.json' } });
  const imports = new Map([[sha256(bytes), await readStagedImport(root, sha256(bytes))]]);
  const plan = (changes, options) => planStudioChangeSet(root, { schema: STUDIO_CHANGE_SET_SCHEMA, changes }, options);
  const unassigned = await plan([{ op: 'import.mcpServer', source: 'https://tools.example.org/tickets.json', sha256: sha256(bytes) }], { imports });
  assert.equal(unassigned.problems[0].code, 'STUDIO_IMPORT_INVALID');
  const applied = await plan([{ op: 'import.mcpServer', source: 'https://tools.example.org/tickets.json', sha256: sha256(bytes), agents: ['architect'], phases: ['design'] }], { imports, write: true });
  assert.equal(applied.valid, true, JSON.stringify(applied.problems));
  const workflow = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.deepEqual(workflow.mcpServers.tickets, {
    label: 'Ticket search', hostReference: 'tickets', agents: ['architect'], phases: ['design'], tools: ['search'],
    approval: 'confirm', evidence: { captureToolCalls: true, captureResults: false }
  });
  assert.match(await readFile(path.join(root, '.github/agents/architect.agent.md'), 'utf8'), /tickets\/search/);
  assert.equal(await readFile(path.join(root, 'singularity/imports/mcp/tickets.json'), 'utf8'), bytes.toString('utf8'));
  assert.equal(existsSync(path.join(root, '.vscode/mcp.json')) && JSON.parse(await readFile(path.join(root, '.vscode/mcp.json'), 'utf8')).servers.tickets, undefined, 'no host entry is written by the import');
  run('git', ['add', '-A'], root); run('git', ['commit', '-m', 'install tickets'], root);
  const added = run(process.execPath, [bin, 'mcp', 'host', 'add', 'tickets'], root);
  assert.match(added.stdout, /It runs: npx -y @example\/tickets-mcp@2\.1\.0/);
  const host = JSON.parse(await readFile(path.join(root, '.vscode/mcp.json'), 'utf8'));
  assert.deepEqual(host.servers.tickets, DESCRIPTOR.host);
  assert.deepEqual(host.inputs.map((input) => input.id), ['tickets-token']);
  assert.ok(host.servers.docs, 'other host entries are kept');
  const removed = await plan([{ op: 'import.remove', key: 'mcp-server:tickets' }], { write: true });
  assert.equal(removed.valid, true, JSON.stringify(removed.problems));
  const after = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  assert.equal(after.mcpServers.tickets, undefined);
  assert.doesNotMatch(await readFile(path.join(root, '.github/agents/architect.agent.md'), 'utf8'), /tickets\//);
  assert.equal(existsSync(path.join(root, 'singularity/imports/mcp/tickets.json')), false);
});
