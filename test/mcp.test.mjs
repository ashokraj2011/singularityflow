import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
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

const configured = () => normalizeMcpServers({
  playwright: {
    label: 'Playwright', hostReference: 'playwright', agents: ['qa'], phases: ['verification'],
    tools: ['browser_navigate', 'browser_take_screenshot'], required: true, approval: 'confirm',
    evidence: { captureToolCalls: true, captureResults: true }
  }
}, { agents: ['qa'], phases: ['verification'] });

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
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-integrity-'));
  const output = path.join(root, 'singularity/work-items/WORK-1/artifacts/verification/browser.txt');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, 'observed\n');
  const workflow = {
    workItem: { id: 'WORK-1' }, currentPhase: 'verification', phaseOrder: ['verification'],
    phases: { verification: { generation: 0 } },
    resolution: { mcpServers: configured() }
  };
  await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', phase: 'verification', agent: 'qa',
    outputPath: path.relative(root, output)
  });
  const valid = await verifyMcpEvidence(root, workflow);
  assert.equal(valid.errors.length, 0);
  assert.match(valid.passes.join('\n'), /MCP evidence integrity: 1 record/);
  await writeFile(output, 'changed\n');
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
  assert.match(text, /@playwright\/mcp@latest/);
  await assert.rejects(() => scaffoldPlaywrightMcp(root), /already exists/);
});

test('MCP provenance records only governed tools and hash-bound work-item outputs', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-evidence-'));
  const output = path.join(root, 'singularity/work-items/STORY-1/artifacts/verification/screenshot.png');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, 'image bytes');
  const workflow = {
    workItem: { id: 'STORY-1' }, currentPhase: 'verification',
    phases: { verification: { generation: 1 } },
    resolution: { mcpServers: configured() }
  };
  const result = await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_take_screenshot', outputPath: path.relative(root, output), note: 'final screen', agent: 'qa'
  });
  assert.match(result.file, /^singularity\/work-items\/STORY-1\/context\/mcp\//);
  assert.equal(result.record.generation, 2);
  assert.equal(result.record.output.sha256.length, 64);
  await assert.rejects(() => recordMcpEvidence(root, workflow, { server: 'playwright', tool: 'browser_install', agent: 'qa' }), /not allowed/);
  await assert.rejects(() => recordMcpEvidence(root, workflow, { server: 'playwright', tool: 'browser_navigate', agent: 'developer' }), /requires one of these governed agents/);
});
