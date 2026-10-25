/**
 * `native-copilot-audit.mjs --sessions <DIR> --failures` (scripts/native-copilot-failures.mjs) reads
 * only `events.jsonl` logs and writes only its own result: content-free by default, with redacted
 * examples under --details. Copilot keeps those logs on the machine that ran it, so this is what a
 * person runs there, on Windows too.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/native-copilot-audit.mjs', import.meta.url));

test('the failure audit counts guard stops, hook timeouts, failed edits and skill-tool misses, writing only its result', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = path.join(directory, 'session-state');
  const one = path.join(sessions, '11111111-aaaa-4bbb-8ccc-000000000001');
  await mkdir(one, { recursive: true });
  const at = (second) => `2026-10-25T01:00:${String(second).padStart(2, '0')}.000Z`;
  const events = [
    { type: 'user.message', timestamp: at(0), data: { content: '/sf-approve planning --work-id HEX-1' } },
    { type: 'tool.execution_start', timestamp: at(1), data: { toolName: 'skill', toolCallId: 's1', arguments: { skill: 'sf-approve' } } },
    { type: 'tool.execution_complete', timestamp: at(2), data: { toolCallId: 's1', success: false, error: { message: 'Skill not found: sf-approve' } } },
    { type: 'tool.execution_start', timestamp: at(3), data: { toolName: 'bash', toolCallId: 'b1',
      arguments: { command: 'singularity-flow approve planning --work-id HEX-1 --fetch --selection-receipt 11111111-1111-4111-8111-111111111111' } } },
    { type: 'hook.start', timestamp: at(4), data: { hookType: 'preToolUse', hookInvocationId: 'h1', input: { toolCalls: [{ id: 'b1', name: 'bash', args: {} }] } } },
    { type: 'hook.end', timestamp: at(17), data: { hookType: 'preToolUse', hookInvocationId: 'h1', success: false,
      error: { message: 'HookTimeoutError: Hook command timed out after 10 seconds' } } },
    { type: 'tool.execution_complete', timestamp: at(18), data: { toolCallId: 'b1', success: true, result: { content: '{"ok":true}' } } },
    { type: 'hook.start', timestamp: at(19), data: { hookType: 'postToolUse', hookInvocationId: 'h2', input: { toolName: 'bash', toolArgs: {} } } },
    { type: 'hook.end', timestamp: at(19), data: { hookType: 'postToolUse', hookInvocationId: 'h2', success: true,
      output: { additionalContext: 'Stop this SFlow authoring turn and preserve changes. PHASE_MUTATION_BASELINE_UNAVAILABLE: detection cannot establish which command changed bytes' } } },
    { type: 'tool.execution_start', timestamp: at(20), data: { toolName: 'apply_patch', toolCallId: 'p1', arguments: '*** Begin Patch\n*** Update File: notes.md\n*** End Patch\n' } },
    { type: 'tool.execution_complete', timestamp: at(21), data: { toolCallId: 'p1', success: false, error: { message: `Failed to find expected lines in ${os.homedir()}/notes.md` } } }
  ];
  await writeFile(path.join(one, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
  const out = path.join(directory, 'result.json');
  const result = spawnSync(process.execPath, [SCRIPT, '--sessions', sessions, '--failures', '--out', out], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## 1\. Guard stops/u, 'a summary is printed');
  const text = await readFile(out, 'utf8');
  const audit = JSON.parse(text);
  assert.equal(audit.scanned.sessionsWithEvents, 1);
  const codes = (signature) => audit.signatures[signature].codes.map((entry) => entry.code);
  assert.ok(codes('guard').some((code) => code.startsWith('PHASE_MUTATION_BASELINE_UNAVAILABLE')));
  assert.deepEqual(codes('hook-timeout'), ['preToolUse']);
  assert.deepEqual(codes('skill-not-found'), ['sf-approve']);
  assert.deepEqual(codes('edit-fail'), ['Failed to find expected lines']);
  // Content-free by default (SPEC-OUT CON-015): no command, message or path from a session.
  assert.equal(audit.details, false);
  assert.doesNotMatch(text, /selection-receipt|notes\.md|Failed to find expected lines in/u);
  const detailed = spawnSync(process.execPath, [SCRIPT, '--sessions', sessions, '--failures', '--details'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(detailed.status, 0, detailed.stderr);
  assert.match(detailed.stdout, /notes\.md/u, '--details keeps short examples');
  assert.doesNotMatch(detailed.stdout, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'), 'with the home folder redacted');
  // Only the logs are read and only the result is written.
  assert.deepEqual((await readdir(one)).sort(), ['events.jsonl']);
  assert.deepEqual((await readdir(directory)).sort(), ['result.json', 'session-state']);
});
