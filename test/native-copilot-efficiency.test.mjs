import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { summarizeNativeCopilotTrace, readNativeCopilotTrace } from '../src/native-copilot-efficiency.mjs';
import { agentPacketPresentation, phaseEntryAgentPresentation } from '../src/agent-packet-presentation.mjs';
import { agentNextSteps } from '../src/commands/nextsteps.mjs';
import { authoringSkillCatalog } from '../src/authoring-skills.mjs';
import { loadSkillPolicy } from '../scripts/skill-policy.mjs';
import { SESSION_ENTRY_PAUSE_GUARD } from '../src/copilot-mode.mjs';

test('agent presentation preserves exact current-platform commands, bindings, material and findings', () => {
  const packet = { ready: false, context: { text: 'Exact governed input' },
    findings: [{ code: 'INTEGRITY', hash: 'retained', confirmation: 'fresh-human' }],
    next: [{ command: 'singularity-flow recover X', platformCommands: { darwin: 'mac', linux: 'linux', win32: 'windows' } }],
    reportTemplate: { binding: { sha256: 'exact' } } };
  for (const platform of ['darwin', 'linux', 'win32']) {
    const projected = agentPacketPresentation(packet, platform);
    assert.deepEqual(projected.next[0].platformCommands, { [platform]: packet.next[0].platformCommands[platform] });
    for (const key of ['ready', 'context', 'findings', 'reportTemplate']) assert.deepEqual(projected[key], packet[key]);
    assert.equal(projected.next[0].command, packet.next[0].command);
  }
  assert.deepEqual(agentPacketPresentation(packet, 'unknown-host'), packet);
  assert.equal(Object.keys(packet.next[0].platformCommands).length, 3, 'do not mutate the original');
  const entry = phaseEntryAgentPresentation(packet);
  assert.match(entry.agentGuide.instruction, /Never reuse approval consent/);
  assert.equal(entry.agentGuide.testExecutionPath, 'recovery.testExecution');
  assert.equal(Object.keys(entry)[0], 'agentGuide', 'show extraction guidance before a large tool packet is truncated');
  assert.deepEqual(phaseEntryAgentPresentation({ paused: true }), { paused: true });
  assert.match(SESSION_ENTRY_PAUSE_GUARD, /supplied in this invocation before any mutation or selection change/);
  assert.match(SESSION_ENTRY_PAUSE_GUARD, /fresh operation checks\/consent remain required/);
});

test('every selectable drafting skill composes inline; other prerequisites and arbitrary routes survive', () => {
  for (const entry of authoringSkillCatalog()) {
    const draft = { timing: 'now', copilotCommand: `/${entry.id}`, argv: ['prepare', 'custom-phase'] };
    const compose = { route: 'grounding-composition', argv: ['wm', 'compose', '--phase', 'custom-phase'] };
    const human = { timing: 'now', route: 'human-confirmation', command: 'review' };
    const snapshot = { currentPhase: 'custom-phase', actions: [compose, human, draft] };
    assert.deepEqual(agentNextSteps(snapshot).actions, [human, draft]);
    assert.equal(agentNextSteps(snapshot).preparation.fulfilledBy, `/${entry.id}`);
  }
  const snapshot = { currentPhase: 'custom-phase', actions: [{ timing: 'now', copilotCommand: '/sf-other', argv: ['prepare', 'custom-phase'] }] };
  assert.equal(agentNextSteps(snapshot), snapshot);
});

test('trace metrics distinguish complete runs, unknown usage, exact reviews and legitimate refreshes', () => {
  const event = { invocationId: 'turn-1', bindingKey: 'head:phase:generation', phase: 'coding',
    command: 'singularity-flow session current --for-agent --json', responseBytes: 100, durationMs: 25 };
  const trace = { schemaVersion: 1, phaseOrder: ['intake', 'coding', 'close'], completedPhases: ['intake', 'coding', 'close'],
    lifecycleStatus: 'completed', events: [event, { ...event }, { ...event, freshnessRequired: true },
      { ...event, bindingKey: 'different' }, { ...event, command: 'document read', responseBytes: 20000,
        exactReviewMaterial: true, document: { displayBinding: 'exact', sha256: 'h', complete: true } },
      { ...event, command: 'document read', responseBytes: 20000, document: { displayBinding: 'exact', sha256: 'h', complete: true } }] };
  const result = summarizeNativeCopilotTrace(trace);
  assert.equal(result.completeStoryReported, true);
  assert.equal(result.toolCalls, 6);
  assert.equal(result.responseBytes, 40400);
  assert.equal(result.providerUsage, null);
  assert.equal(result.billedSavings, null);
  assert.equal(result.duplicateCandidates.length, 2);
  assert.equal(result.documentReads, 2);
  assert.equal(result.completeDocumentBindings, 1);
  const chunks = trace.events.slice(4).map(event => ({ ...event, document: { ...event.document, complete: false } }));
  assert.deepEqual(summarizeNativeCopilotTrace({ ...trace, events: chunks }).duplicateCandidates, [],
    'two required portions of the same pinned document are not a repeated complete read');
  assert.equal(result.oversizedPackets[0].exactReviewMaterial, true);
  assert.equal(summarizeNativeCopilotTrace({ ...trace, completedPhases: ['intake'] }).completeStoryReported, false);
  assert.equal(summarizeNativeCopilotTrace({ ...trace, events: [{ ...event, usage: { inputTokens: 5, outputTokens: 2 } }, event] }).providerUsage.complete, false);
  assert.throws(() => summarizeNativeCopilotTrace({ schemaVersion: 1, events: [{}] }), /Invalid tool event/);
});

test('trace reads use only the selected bounded regular file', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-copilot-trace-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'trace.json');
  const data = { schemaVersion: 1, events: [] };
  await writeFile(file, JSON.stringify(data));
  assert.deepEqual(await readNativeCopilotTrace(file), data);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cli = spawnSync(process.execPath, [path.join(packageRoot, 'scripts/native-copilot-audit.mjs'), '--trace', file],
    { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(cli.status, 0, cli.stderr);
  const result = JSON.parse(cli.stdout);
  assert.equal(result.skillCount, Object.keys((await loadSkillPolicy(packageRoot)).policy.skills).length);
  assert.equal(result.skills, undefined, 'routine audit output must not dump the entire catalogue');
  assert.equal(Object.values(result.entryStrategies).reduce((sum, count) => sum + count, 0), result.skillCount);
  assert.ok(result.largestSkills.length <= 10);
  assert.equal(result.trace.toolCalls, 0);
  assert.equal(result.trace.providerUsage, null);
  assert.deepEqual(result.errors, []);
  const detailed = spawnSync(process.execPath, [path.join(packageRoot, 'scripts/native-copilot-audit.mjs'), '--details'],
    { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.equal(JSON.parse(detailed.stdout).skills.length, result.skillCount);
  const invalid = spawnSync(process.execPath, [path.join(packageRoot, 'scripts/native-copilot-audit.mjs'), '--unknown', file],
    { cwd: root, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  await assert.rejects(readNativeCopilotTrace(root));
  if (process.platform !== 'win32') {
    await symlink(file, path.join(root, 'linked.json'));
    await assert.rejects(readNativeCopilotTrace(path.join(root, 'linked.json')));
  }
});
