import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  attestMcpHost,
  mcpDoctor,
  mcpHostInventory,
  mcpServersForContext,
  mcpStatus,
  normalizeMcpServers,
  recordMcpEvidence,
  verifyMcpEvidence,
  renderMcpPromptPolicy,
  scaffoldPlaywrightMcp,
  validateMcpAgentTools
} from '../src/mcp.mjs';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { doctorSnapshot } from '../src/doctor.mjs';

const configured = () => normalizeMcpServers({
  playwright: {
    label: 'Playwright', hostReference: 'playwright', agents: ['qa'], phases: ['verification'],
    tools: ['browser_navigate', 'browser_take_screenshot'], required: true, approval: 'confirm',
    evidence: { captureToolCalls: true, captureResults: true }
  }
}, { agents: ['qa'], phases: ['verification'] });

async function repository(prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.test'], { cwd: root });
  return root;
}

test('MCP registry validates agent, phase, tool, approval, and evidence declarations', () => {
  const result = configured();
  assert.deepEqual(result.playwright.tools, ['browser_navigate', 'browser_take_screenshot']);
  assert.equal(result.playwright.evidence.captureResults, true);
  assert.throws(() => normalizeMcpServers({ bad: { agents: ['missing'] } }, { agents: ['qa'] }), /unknown governed agent/);
  assert.throws(() => normalizeMcpServers({ bad: { phases: ['missing'] } }, { phases: ['verification'] }), /unknown phase/);
  assert.throws(() => normalizeMcpServers({ bad: { tools: ['playwright\/browser_navigate'] } }), /unqualified MCP tool name/);
  assert.throws(() => normalizeMcpServers({ bad: { approval: 'never' } }), /confirm or host/);
});

test('MCP evidence integrity detects changed captured output', async () => {
  const root = await repository('sflow-mcp-integrity-');
  const output = path.join(root, 'singularity/work-items/WORK-1/artifacts/verification/browser.txt');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, 'observed\n');
  const workflow = {
    workItem: { id: 'WORK-1' }, currentPhase: 'verification', phaseOrder: ['verification'],
    phases: { verification: { generation: 0, status: 'in_progress' } },
    resolution: { mcpServers: configured() }
  };
  await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', phase: 'verification', agent: 'qa',
    outputPath: path.relative(root, output)
  });
  const valid = await verifyMcpEvidence(root, workflow);
  assert.equal(valid.errors.length, 0);
  assert.match(valid.passes.join('\n'), /MCP evidence integrity: 1 record/);
  const recordedOutput = path.join(root, 'singularity/work-items/WORK-1', valid.records[0].output.path);
  await writeFile(recordedOutput, 'changed\n');
  const changed = await verifyMcpEvidence(root, workflow);
  assert.match(changed.errors.join('\n'), /output changed after capture/);
});

test('MCP routing composes only the active agent and phase tool policy', () => {
  const definition = { mcpServers: configured() };
  assert.equal(mcpServersForContext(definition, { agent: 'qa', phase: 'verification' }).length, 1);
  assert.equal(mcpServersForContext(definition, { agent: 'developer', phase: 'verification' }).length, 0);
  assert.equal(mcpServersForContext(definition, { agent: 'qa', phase: 'implementation' }).length, 0);
  const prompt = renderMcpPromptPolicy(definition, { agent: 'qa', phase: 'verification' });
  assert.match(prompt, /# Governed MCP tools/);
  assert.match(prompt, /`playwright\/browser_navigate`/);
  assert.match(prompt, /Never copy credentials/);
});

test('MCP assignments require matching custom-agent tool namespaces', () => {
  const definition = { mcpServers: configured(), agentCatalog: [{ id: 'qa', tools: ['read', 'playwright/*'] }] };
  assert.doesNotThrow(() => validateMcpAgentTools(definition));
  definition.agentCatalog[0].tools = ['read'];
  assert.throws(() => validateMcpAgentTools(definition), /Agent Markdown tools do not allow/);
});

test('MCP host inventory discovers workspace and user files without reading secret values', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-home-'));
  await mkdir(path.join(root, '.vscode'), { recursive: true });
  await mkdir(path.join(home, '.copilot'), { recursive: true });
  await writeFile(path.join(root, '.vscode/mcp.json'), JSON.stringify({ servers: { playwright: { command: 'npx', env: { SECRET: 'do-not-return' } } } }));
  await writeFile(path.join(home, '.copilot/mcp-config.json'), JSON.stringify({ mcpServers: { corporate: { url: 'https://example.invalid', token: 'do-not-return' } } }));
  const inventory = await mcpHostInventory(root, { home });
  assert.deepEqual(inventory.map((row) => row.name).sort(), ['corporate', 'playwright']);
  assert.equal(JSON.stringify(inventory).includes('do-not-return'), false);
  const status = await mcpStatus(root, { mcpServers: configured() }, { home });
  assert.equal(status.servers[0].configured, true);
  assert.deepEqual(status.servers[0].sources, ['vscode-workspace']);
});

test('Playwright scaffold is explicit and never replaces host configuration silently', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-scaffold-'));
  const result = await scaffoldPlaywrightMcp(root);
  assert.equal(result.path, '.vscode/mcp.json');
  const text = await readFile(path.join(root, result.path), 'utf8');
  assert.match(text, /@playwright\/mcp@0\.0\.79/);
  const unchanged = await scaffoldPlaywrightMcp(root);
  assert.equal(unchanged.changed, false);
  const document = JSON.parse(text);
  document.servers.corporate = { type: 'http', url: 'https://mcp.example.test' };
  await writeFile(path.join(root, result.path), `${JSON.stringify(document, null, 2)}\n`);
  const merged = await scaffoldPlaywrightMcp(root);
  assert.equal(merged.changed, false);
  assert.ok(JSON.parse(await readFile(path.join(root, result.path))).servers.corporate);
});

test('preflight-readiness-lines: MCP doctor requires a current machine-local host readiness attestation', async () => {
  const root = await repository('sflow-mcp-readiness-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  const before = await mcpDoctor(root, definition);
  assert.equal(before.servers[0].readiness, 'needs-host-setup');
  assert.match(before.servers[0].reasons.join('\n'), /not been attested/);

  await assert.rejects(
    () => attestMcpHost(root, definition, 'playwright', { confirmation: 'wrong' }),
    /--confirm playwright/
  );
  await attestMcpHost(root, definition, 'playwright', { confirmation: 'playwright' });
  const ready = await mcpDoctor(root, definition);
  assert.equal(ready.servers[0].readiness, 'ready');

  const hostFile = path.join(root, '.vscode/mcp.json');
  const host = JSON.parse(await readFile(hostFile, 'utf8'));
  host.servers.playwright.args.push('--isolated');
  await writeFile(hostFile, `${JSON.stringify(host, null, 2)}\n`);
  const stale = await mcpDoctor(root, definition);
  assert.equal(stale.servers[0].readiness, 'needs-host-setup');
  assert.match(stale.servers[0].reasons.join('\n'), /attestation is stale/);
});

test('platform doctor reports static MCP preflight readiness without contacting the network', async () => {
  const root = await repository('sflow-mcp-platform-doctor-');
  await initializeDefinition(root);
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'initialize'], { cwd: root });
  const definition = await loadDefinition(root);
  const report = await doctorSnapshot(root, { offline: true });
  for (const id of Object.keys(definition.mcpServers)) {
    const check = report.checks.find((entry) => entry.id === `mcp-${id}`);
    assert.ok(check, `doctor should include ${id}`);
    assert.match(check.message, new RegExp(`MCP ${id}: (ready|needs-host-setup|misconfigured)`));
  }
});

test('MCP provenance records only governed tools and hash-bound work-item outputs', async () => {
  const root = await repository('sflow-mcp-evidence-');
  const output = path.join(root, 'singularity/work-items/STORY-1/artifacts/verification/screenshot.png');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, 'image bytes');
  const workflow = {
    workItem: { id: 'STORY-1' }, currentPhase: 'verification',
    phaseOrder: ['verification'], phases: { verification: { generation: 1, status: 'in_progress' } },
    resolution: { mcpServers: configured() }
  };
  const result = await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_take_screenshot', outputPath: path.relative(root, output), note: 'final screen', agent: 'qa'
  });
  assert.match(result.file, /^singularity\/work-items\/STORY-1\/context\/mcp\/records\//);
  assert.equal(result.record.targetGeneration, 2);
  assert.equal(result.record.output.sha256.length, 64);
  await assert.rejects(() => recordMcpEvidence(root, workflow, { server: 'playwright', tool: 'browser_install', agent: 'qa' }), /not allowed/);
  await assert.rejects(() => recordMcpEvidence(root, workflow, { server: 'playwright', tool: 'browser_navigate', agent: 'developer' }), /requires one of these governed agents/);
});
