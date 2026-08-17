import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  assertMcpPhaseReadiness,
  attestMcpHost,
  mcpDoctor,
  mcpHostInventory,
  mcpServersForContext,
  mcpStatus,
  normalizeMcpServers,
  recordMcpEvidence,
  smokeMcpHost,
  verifyMcpEvidence,
  verifyPhaseMcpRequirements,
  renderMcpPromptPolicy,
  scaffoldPlaywrightMcp,
  validateMcpAgentTools
} from '../src/mcp.mjs';
import { initializeDefinition, loadDefinition } from '../src/config.mjs';
import { doctorSnapshot } from '../src/doctor.mjs';
import { canonicalJson } from '../src/records.mjs';

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
  const playwright = JSON.parse(text).servers.playwright;
  for (const option of ['--isolated', '--headless', '--output-dir', '--output-max-size', '--viewport-size', '--timeout-action', '--timeout-navigation']) {
    assert.ok(playwright.args.includes(option), `${option} is missing from deterministic scaffold`);
  }
  const unchanged = await scaffoldPlaywrightMcp(root);
  assert.equal(unchanged.changed, false);
  const document = JSON.parse(text);
  document.servers.corporate = { type: 'http', url: 'https://mcp.example.test' };
  await writeFile(path.join(root, result.path), `${JSON.stringify(document, null, 2)}\n`);
  const merged = await scaffoldPlaywrightMcp(root);
  assert.equal(merged.changed, false);
  assert.ok(JSON.parse(await readFile(path.join(root, result.path))).servers.corporate);
});

test('phase readiness requires a hash-bound live smoke receipt when configured', async () => {
  const root = await repository('sflow-mcp-smoke-readiness-');
  const definition = { mcpServers: configured() };
  await scaffoldPlaywrightMcp(root);
  await attestMcpHost(root, definition, 'playwright', { confirmation: 'playwright' });
  const phase = { id: 'verification', mcp: { requiredServers: ['playwright'], requireSmoke: true, evidence: [] } };
  const workflow = {
    resolution: { mcpServers: definition.mcpServers },
    mcpAuthorizations: {
      playwright: { schemaVersion: 1, origins: ['https://example.test'], source: 'story-intake', pinnedAt: new Date().toISOString() }
    }
  };
  await assert.rejects(() => assertMcpPhaseReadiness(root, workflow, phase), /no successful live smoke receipt/);
  const receipt = await smokeMcpHost(root, definition, 'playwright', {
    targetUrl: 'https://example.test/health',
    probe: async (_entry, { url }) => ({
      status: 'passed', tools: ['browser_navigate', 'browser_snapshot', 'browser_close'],
      finalUrl: url.toString(), finalOrigin: url.origin
    })
  });
  assert.equal(receipt.authorizedOrigin, 'https://example.test');
  await assert.doesNotReject(() => assertMcpPhaseReadiness(root, workflow, phase));
  const wrongOrigin = structuredClone(workflow);
  wrongOrigin.mcpAuthorizations.playwright.origins = ['https://staging.example.test'];
  await assert.rejects(() => assertMcpPhaseReadiness(root, wrongOrigin, phase), /not authorized for this Story/);
  await writeFile(receipt.path, `${JSON.stringify({ ...receipt, checkedAt: '2020-01-01T00:00:00.000Z' }, null, 2)}\n`);
  await assert.rejects(() => assertMcpPhaseReadiness(root, workflow, phase), /older than 24 hours/);
  await writeFile(receipt.path, `${JSON.stringify({
    ...receipt,
    result: { status: 'passed', tools: ['browser_navigate'] }
  }, null, 2)}\n`);
  await assert.rejects(() => assertMcpPhaseReadiness(root, workflow, phase), /receipt structure or server identity is invalid/);
  await assert.rejects(() => smokeMcpHost(root, definition, 'playwright', {
    targetUrl: 'https://example.test',
    probe: async () => ({
      status: 'passed', tools: ['browser_navigate', 'browser_snapshot', 'browser_close'],
      finalUrl: 'https://redirect.example.test/landing', finalOrigin: 'https://redirect.example.test'
    })
  }), /ended outside the authorized origin/);
  await assert.rejects(() => smokeMcpHost(root, definition, 'playwright', {
    targetUrl: 'https://user:secret@example.test/health', probe: async () => ({ status: 'passed' })
  }), /must not contain credentials/);
});

test('browser navigation evidence is bound to the Story-authorized origin', async () => {
  const root = await repository('sflow-mcp-origin-evidence-');
  await scaffoldPlaywrightMcp(root);
  const workflow = {
    workItem: { id: 'WORK-ORIGIN' }, currentPhase: 'verification', phaseOrder: ['verification'],
    phases: { verification: {
      id: 'verification', generation: 0, status: 'in_progress',
      mcp: { evidence: [{ server: 'playwright', tool: 'browser_navigate', minimum: 1, outputRequired: false }] }
    } },
    resolution: { mcpServers: configured() },
    mcpAuthorizations: {
      playwright: { schemaVersion: 1, origins: ['https://staging.example.test'], source: 'story-intake', pinnedAt: new Date().toISOString() }
    }
  };
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', phase: 'verification', agent: 'qa'
  }), /requires --target-url/);
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', phase: 'verification', agent: 'qa',
    targetUrl: 'https://production.example.test'
  }), /outside this Story's authorization/);
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', phase: 'verification', agent: 'qa',
    targetUrl: 'https://staging.example.test/checkout'
  }), /must come from a live Playwright MCP observation/);
  const smoke = await smokeMcpHost(root, { mcpServers: configured() }, 'playwright', {
    targetUrl: 'https://staging.example.test/checkout',
    evidence: { workflow, phase: 'verification', agent: 'qa' },
    probe: async (_entry, { url }) => ({
      status: 'passed', tools: ['browser_navigate', 'browser_snapshot', 'browser_close'],
      finalUrl: url.toString(), finalOrigin: url.origin,
      snapshotResult: {
        content: [{ type: 'text', text: `- Page URL: ${url.toString()}\n- heading "Checkout"` }]
      }
    })
  });
  assert.equal(smoke.evidence.navigation.targetOrigin, 'https://staging.example.test');
  assert.equal(smoke.evidence.snapshot.captureSource, 'observed-by-mcp-host');
  assert.equal(smoke.evidence.snapshot.observedFinalOrigin, 'https://staging.example.test');
  assert.equal(smoke.evidence.navigation.captureId, smoke.evidence.snapshot.captureId);
  const managedSnapshot = path.join(
    root, 'singularity/work-items/WORK-ORIGIN', smoke.evidence.snapshot.output.path
  );
  const exactBytes = await readFile(managedSnapshot, 'utf8');
  assert.equal(exactBytes, canonicalJson({
    content: [{ type: 'text', text: '- Page URL: https://staging.example.test/checkout\n- heading "Checkout"' }]
  }));
  assert.equal(JSON.stringify(smoke).includes('/checkout'), false, 'receipts must not persist target URL paths or query strings');
  const integrity = await verifyMcpEvidence(root, workflow);
  assert.equal(integrity.errors.length, 0, integrity.errors.join('\n'));
  assert.equal((await verifyPhaseMcpRequirements(root, workflow, workflow.phases.verification)).errors.length, 0);
  await writeFile(managedSnapshot, `${exactBytes} `);
  assert.match((await verifyMcpEvidence(root, workflow)).errors.join('\n'), /output changed after capture/);
  await writeFile(managedSnapshot, exactBytes);
  workflow.phases.verification.generation = 1;
  assert.match(
    (await verifyPhaseMcpRequirements(root, workflow, workflow.phases.verification)).errors.join('\n'),
    /generation 2 requires a live, host-observed navigation receipt/
  );
  const recordsDir = path.join(root, 'singularity/work-items/WORK-ORIGIN/context/mcp/records');
  await writeFile(path.join(recordsDir, `${smoke.evidence.navigation.id}-replay.json`),
    `${JSON.stringify({ ...smoke.evidence.navigation, id: `${smoke.evidence.navigation.id}-replay` }, null, 2)}\n`);
  assert.match(
    (await verifyMcpEvidence(root, workflow)).errors.join('\n'),
    /MCP_EVIDENCE_RECEIPT_REPLAYED/
  );
});

test('agent-supplied browser snapshots remain audit evidence but cannot establish origin', async () => {
  const root = await repository('sflow-mcp-snapshot-origin-');
  await mkdir(path.join(root, 'singularity/work-items/WORK-SNAPSHOT'), { recursive: true });
  const workflow = {
    workItem: { id: 'WORK-SNAPSHOT' }, currentPhase: 'verification', phaseOrder: ['verification'],
    phases: { verification: {
      id: 'verification', generation: 0, status: 'in_progress',
      mcp: { evidence: [{ server: 'playwright', tool: 'browser_snapshot', minimum: 1, outputRequired: true }] }
    } },
    resolution: { mcpServers: normalizeMcpServers({
      playwright: {
        hostReference: 'playwright', agents: ['qa'], phases: ['verification'],
        tools: ['browser_snapshot'], evidence: { captureToolCalls: true, captureResults: true }
      }
    }, { agents: ['qa'], phases: ['verification'] }) },
    mcpAuthorizations: {
      playwright: { schemaVersion: 1, origins: ['https://staging.example.test'], source: 'story-intake', pinnedAt: new Date().toISOString() }
    }
  };
  await writeFile(path.join(root, 'wrong-snapshot.txt'), '- Page URL: https://production.example.test/checkout\n');
  const wrong = await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_snapshot', phase: 'verification', agent: 'qa',
    outputPath: 'wrong-snapshot.txt'
  });
  assert.equal(wrong.record.captureSource, 'declared-by-agent');
  assert.equal(wrong.gateSatisfying, false);
  assert.equal(wrong.noticeCode, 'mcp.evidence-observation-required');
  assert.deepEqual(wrong.diagnosticCodes, ['MCP_EVIDENCE_OBSERVATION_REQUIRED']);
  assert.equal(await readFile(path.join(root, 'wrong-snapshot.txt'), 'utf8'), '- Page URL: https://production.example.test/checkout\n');
  await writeFile(path.join(root, 'right-snapshot.txt'), '- Page URL: https://staging.example.test/checkout?state=ready\n');
  const recorded = await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_snapshot', phase: 'verification', agent: 'qa',
    outputPath: 'right-snapshot.txt'
  });
  assert.equal(recorded.record.captureSource, 'declared-by-agent');
  assert.equal(recorded.record.observedFinalOrigin, null);
  const verified = await verifyMcpEvidence(root, workflow);
  assert.equal(verified.errors.length, 0);
  assert.match(verified.warnings.join('\n'), /audit only/);
  assert.match(
    (await verifyPhaseMcpRequirements(root, workflow, workflow.phases.verification)).errors.join('\n'),
    /requires a live, host-observed navigation receipt/
  );
});

test('phase MCP evidence requirements are generation-bound and require durable outputs', async () => {
  const root = await repository('sflow-mcp-required-evidence-');
  const output = path.join(root, 'snapshot.txt');
  await mkdir(path.join(root, 'singularity/work-items/STORY-1'), { recursive: true });
  await writeFile(output, 'accessible page snapshot\n');
  const servers = normalizeMcpServers({
    playwright: {
      agents: ['qa'], phases: ['verification'], tools: ['browser_snapshot'],
      evidence: { captureToolCalls: true, captureResults: true }
    }
  }, { agents: ['qa'], phases: ['verification'] });
  const phase = {
    id: 'verification', generation: 0, status: 'in_progress',
    mcp: { evidence: [{ server: 'playwright', tool: 'browser_snapshot', minimum: 1, outputRequired: true }] }
  };
  const workflow = {
    workItem: { id: 'STORY-1' }, currentPhase: 'verification', phaseOrder: ['verification'],
    phases: { verification: phase }, resolution: { mcpServers: servers }
  };
  const missing = await verifyPhaseMcpRequirements(root, workflow, phase);
  assert.match(missing.errors.join('\n'), /requires 1 MCP evidence/);
  await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_snapshot', phase: 'verification', agent: 'qa', outputPath: 'snapshot.txt'
  });
  const ready = await verifyPhaseMcpRequirements(root, workflow, phase);
  assert.equal(ready.errors.length, 0);
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

test('MCP evidence rejects symbolic-link sources and credential-bearing URLs', async () => {
  const root = await repository('sflow-mcp-boundaries-');
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), 'sflow-mcp-outside-')), 'secret.txt');
  const linked = path.join(root, 'linked-output.txt');
  await writeFile(outside, 'outside repository evidence\n');
  await symlink(outside, linked);
  const workflow = {
    workItem: { id: 'STORY-1' }, currentPhase: 'verification',
    phaseOrder: ['verification'], phases: { verification: { generation: 0, status: 'in_progress' } },
    resolution: { mcpServers: configured() }
  };

  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', agent: 'qa', outputPath: 'linked-output.txt'
  }), /symbolic|outside the repository|regular/i);
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', agent: 'qa',
    outputUrl: 'https://user:secret@example.test/evidence.txt'
  }), /must not contain credentials/);
  await assert.rejects(() => recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', agent: 'qa', note: 'Authorization: bearer private'
  }), /must not contain credentials or secrets/);
});

test('MCP evidence honors an immutable custom work-item root', async () => {
  const root = await repository('sflow-mcp-custom-root-');
  const output = path.join(root, 'verification-output.txt');
  await mkdir(path.join(root, 'governed/story-state/STORY-1'), { recursive: true });
  await writeFile(output, 'verified from custom root\n');
  const workflow = {
    workItem: { id: 'STORY-1' }, currentPhase: 'verification',
    phaseOrder: ['verification'], phases: { verification: { generation: 0, status: 'in_progress' } },
    resolution: { workItemRoot: 'governed/story-state', mcpServers: configured() }
  };

  const result = await recordMcpEvidence(root, workflow, {
    server: 'playwright', tool: 'browser_navigate', agent: 'qa', outputPath: 'verification-output.txt'
  });
  assert.match(result.file, /^governed\/story-state\/STORY-1\/context\/mcp\/records\//);
  const verified = await verifyMcpEvidence(root, workflow);
  assert.equal(verified.errors.length, 0);
  assert.equal(verified.records.length, 1);
});
