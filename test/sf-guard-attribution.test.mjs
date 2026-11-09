/**
 * SF Guard part 2, G1 [SPEC-SFG-v1 REQ-020 to REQ-024, AC-001 to AC-004]: with SF Guard on, every
 * Copilot edit and shell call is recorded with its session, agent, skill and Story, through the
 * hooks SFlow already runs; off, nothing is recorded and every hook answers as before.
 *
 * Payloads are the shapes the G0 probe saw (Copilot CLI 1.0.105 and VS Code 1.144): `sessionId`,
 * `timestamp`, `cwd`, `prompt`, `toolName`, `toolArgs`, a subagent's `agentId`, `agentType` and
 * `parentAgentId`, `sessionEnd`'s `reason`. The "tool" is this test writing the file between the
 * pre-tool hook and the session's next hook, as Copilot does.
 */
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  endRepositoryBoundaryTurn, recordRepositoryBoundaryTurn, repositoryPostToolGuard, repositoryToolGuard
} from '../src/copilot-repository-boundary.mjs';
import { captureMutationTurn } from '../src/copilot-mutation-guard.mjs';
import { readObservedWrites } from '../src/comprehension/xpl2/observed-writes.mjs';
import {
  callKey, readSfGuardGaps, readSfGuardShellRecords, sfGuardClassification, sfGuardOn, sfGuardRepository,
  sfGuardStamp, sfGuardStampingHooks, writeSfGuardLocalState
} from '../src/comprehension/xpl2/sf-guard-recorder.mjs';
import { setCopilotPaused } from '../src/copilot-mode.mjs';

const BASELINE = 'const a = 1;\nconst b = 2;\n';

async function fixture(t, { on = true, binding = null } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-sfg-g1-')));
  const root = path.join(directory, 'repository');
  await mkdir(path.join(root, 'src'), { recursive: true });
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (...args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Guard Tester'); git('config', 'user.email', 'guard@example.test');
  await writeFile(path.join(root, 'src/app.js'), BASELINE);
  git('add', '.'); git('commit', '-qm', 'baseline');
  // An unsigned enable is enough for the hooks to record (it records more, never less); the signed
  // policy decides everything else.
  if (on) {
    await mkdir(path.join(root, 'singularity'), { recursive: true });
    await writeFile(path.join(root, 'singularity/presence.json'), JSON.stringify({ schema: 'sflow-presence-chain@1', events: [{ seq: 0, kind: 'enable' }] }));
  }
  if (binding) {
    await mkdir(path.join(root, '.git/singularity-flow'), { recursive: true });
    await writeFile(path.join(root, '.git/singularity-flow/session.json'), JSON.stringify(binding));
  }
  const boundaries = path.join(directory, 'machine', 'copilot-boundaries');
  const prompt = (sessionId, text, extra = {}) => recordRepositoryBoundaryTurn({ sessionId, timestamp: Date.now(), cwd: root, prompt: text, ...extra });
  /** The pre-tool hook, then the tool itself (`write`), as Copilot runs them. */
  const edit = async (sessionId, before, after, extra = {}) => {
    const toolArgs = { path: path.join(root, 'src/app.js'), old_str: before, new_str: after };
    const decision = await repositoryToolGuard({ sessionId, cwd: root, toolName: 'edit', toolArgs, ...extra });
    await writeFile(path.join(root, 'src/app.js'), (await readFile(path.join(root, 'src/app.js'), 'utf8')).replace(before, after));
    return { decision, toolArgs };
  };
  const shell = async (sessionId, command, { after = true, extra = {} } = {}) => {
    const payload = { sessionId, cwd: root, toolName: 'bash', toolArgs: { command, description: 'probe' }, ...extra };
    const decision = await repositoryToolGuard(payload);
    if (after) await repositoryPostToolGuard({ ...payload, toolResult: { resultType: 'success' } });
    return decision;
  };
  const end = (sessionId, reason) => endRepositoryBoundaryTurn({ sessionId, cwd: root, reason });
  const writes = async () => (await readObservedWrites(path.join(root, '.git'), { paths: ['src/app.js'] })).records;
  const attributionFiles = async () => (await readdir(boundaries).catch(() => [])).filter((name) => name.includes('.attribution'));
  return { directory, root, git, boundaries, prompt, edit, shell, end, writes, attributionFiles };
}

test('SFG AC-001: SF Guard off records nothing, and every hook answers exactly as before', async (t) => {
  const f = await fixture(t, { on: false });
  assert.deepEqual(await f.prompt('s-off', 'Make b three.'), {});
  const { decision } = await f.edit('s-off', 'const b = 2;', 'const b = 3;');
  assert.deepEqual(decision, {});
  assert.deepEqual(await f.shell('s-off', 'echo hi'), {});
  assert.deepEqual(await f.end('s-off', 'complete'), {});
  assert.deepEqual(await f.prompt('s-off', 'Thanks.'), {});
  assert.deepEqual(await f.attributionFiles(), []);
  assert.deepEqual(await f.writes(), []);
  assert.deepEqual(await readSfGuardShellRecords(f.root), []);
});

test('SFG AC-002: a plain prompt with no custom agent is recorded as plain Copilot, outside the workflow (D1)', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.prompt('s-plain', 'Make b three.'), {});
  const { decision } = await f.edit('s-plain', 'const b = 2;', 'const b = 3;');
  assert.deepEqual(decision, {}, 'recording never changes the answer');
  await f.prompt('s-plain', 'Thanks.');
  const [record] = await f.writes();
  assert.equal(record.format, 'xpl2-observed-write@3');
  assert.equal(record.writer.kind, 'copilot-session');
  assert.equal(record.writer.agent, null);
  assert.equal(record.writer.skill, null);
  assert.equal(record.writer.attribution.agentSource, 'none');
  assert.equal(record.writer.attribution.skillSource, 'none');
  assert.equal(record.writer.attribution.classification, 'outside-workflow');
  assert.equal(record.writer.attribution.provisional, true);
  assert.equal(record.files[0].path, 'src/app.js');
  assert.equal(record.files[0].verified, true);
  assert.equal(record.subject, null, 'no Story bound: the whole repository');
});

test('SFG AC-003: an /sf-code turn as the step\'s agent is declared; a plain prompt after it is a plain chat, as the guard reads it [PCR:REQ-042]', async (t) => {
  const binding = { workId: 'SFG-1', phaseId: 'implementation', agent: 'developer' };
  const f = await fixture(t, { binding });
  // The explicit turn: its own recorder notes the edit, and SF Guard adds where it came from.
  const phase = { id: 'implementation', status: 'in_progress', generation: 0, writeScope: 'source-and-artifact',
    generationPolicy: { task: 'code', requirement: 'required' }, generationIntent: { status: 'open', generation: 1 } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: [] } };
  const workflow = { workItem: { id: 'SFG-1' }, currentPhase: phase.id, phaseOrder: [phase.id], phases: { [phase.id]: phase }, resolution: {} };
  const workflowFile = path.join(f.root, definition.workItemRoot, 'SFG-1', 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  f.git('add', '.'); f.git('commit', '-qm', 'story');
  await recordRepositoryBoundaryTurn({ sessionId: 's-code', cwd: f.root, prompt: '/sf-code' }, { captureMutation: (value, record) => captureMutationTurn(value, record,
    { resolveRoot: async () => f.root, load: async () => ({ definition, workflow }) }) });
  await f.edit('s-code', 'const a = 1;', 'const a = 10;');
  // The person answers the skill's question in a plain prompt; the guard reads that turn as a plain chat, and so does SF Guard.
  await f.prompt('s-code', 'Confirmed, go ahead.');
  await f.edit('s-code', 'const b = 2;', 'const b = 20;');
  assert.deepEqual(await f.shell('s-code', 'singularity-flow phase publish implementation --authored governed-agent --channel copilot-host --json'), {});
  // After publication the continuation ends: a later plain prompt is plain Copilot again.
  await f.prompt('s-code', 'Also add c.');
  await f.edit('s-code', 'const b = 20;\n', 'const b = 20;\nconst c = 3;\n');
  await f.end('s-code', 'user_exit');
  const [explicit, continued, after] = await f.writes();
  assert.equal(explicit.writer.kind, 'copilot-turn');
  assert.equal(explicit.writer.skill, 'sf-code');
  assert.deepEqual(explicit.subject, { workId: 'SFG-1', phase: 'implementation', generation: 1 });
  assert.equal(explicit.writer.attribution.agent, 'developer');
  assert.equal(explicit.writer.attribution.agentSource, 'binding');
  assert.equal(explicit.writer.attribution.classification, 'declared');
  assert.equal(continued.writer.kind, 'copilot-session');
  assert.equal(continued.writer.skill, null);
  assert.equal(continued.writer.attribution.skillSource, 'none');
  assert.equal(continued.writer.attribution.continued, undefined);
  assert.equal(continued.writer.attribution.plainChat, true);
  assert.equal(continued.writer.attribution.classification, 'outside-workflow');
  assert.deepEqual(continued.subject, { workId: 'SFG-1', phase: 'implementation', generation: null });
  assert.equal(after.writer.skill, null);
  assert.equal(after.writer.attribution.classification, 'outside-workflow');
  const [published] = await readSfGuardShellRecords(f.root);
  assert.equal(published.ran, true);
  assert.equal(published.writer.skill, null, 'the publish the person asked for in that plain prompt ran in a plain chat');
  assert.match(published.commandSha256, /^[0-9a-f]{64}$/u);
  assert.ok(!JSON.stringify(published).includes('phase publish'), 'a command\'s text is never kept, only its digest');
});

test('SFG AC-004: an undeclared subagent is named by Copilot and labelled outside the workflow; a bundled SFlow agent is declared', async (t) => {
  const f = await fixture(t);
  await f.prompt('s-parent', 'Ask the helper to change b.');
  const helper = { agentId: 'agent-helper-1', agentType: 'helper', parentAgentId: 's-parent' };
  await f.prompt('s-helper', 'Change b to 4.', helper);
  await f.edit('s-helper', 'const b = 2;', 'const b = 4;', helper);
  await f.end('s-helper', 'complete');
  const bundled = { agentId: 'agent-flow-1', agentType: 'sflow-workflow', parentAgentId: 's-parent' };
  await f.prompt('s-flow', 'Change a to 5.', bundled);
  await f.edit('s-flow', 'const a = 1;', 'const a = 5;', bundled);
  await f.end('s-flow', 'complete');
  const [fromHelper, fromFlow] = await f.writes();
  assert.equal(fromHelper.writer.agent, 'helper');
  assert.equal(fromHelper.writer.attribution.agentSource, 'subagent');
  assert.equal(fromHelper.writer.attribution.classification, 'outside-workflow');
  assert.match(fromHelper.writer.attribution.subagent.parent, /^[0-9a-f]{16}$/u);
  assert.equal(fromFlow.writer.agent, 'sflow-workflow');
  assert.equal(fromFlow.writer.attribution.classification, 'declared');
});

test('SFG REQ-020/D4: a declared agent\'s stamping hook names the top-level agent per prompt, and a skill call names the skill', async (t) => {
  const f = await fixture(t);
  const text = 'Run the probe steps.';
  await f.prompt('s-alpha', text);
  // The agent-scoped hook fires for the same prompt, a moment after the plugin's.
  await sfGuardStamp('alpha', 'userPromptSubmitted', { sessionId: 's-alpha', cwd: f.root, prompt: text }, { directory: f.boundaries });
  await f.edit('s-alpha', 'const a = 1;', 'const a = 2;');
  await repositoryToolGuard({ sessionId: 's-alpha', cwd: f.root, toolName: 'skill', toolArgs: { skill: 'probe-skill' } });
  await f.edit('s-alpha', 'const b = 2;', 'const b = 9;');
  await f.end('s-alpha', 'complete');
  const [stamped, withSkill] = await f.writes();
  assert.equal(stamped.writer.agent, 'alpha');
  assert.equal(stamped.writer.attribution.agentSource, 'agent-hook');
  assert.equal(stamped.writer.attribution.classification, 'declared');
  assert.equal(withSkill.writer.skill, 'probe-skill');
  assert.equal(withSkill.writer.attribution.skillSource, 'skill-call');
  assert.equal(withSkill.writer.attribution.classification, 'pending', 'G2 checks a non-SFlow skill against the declared set');
  // A stamp from an earlier, identical prompt does not carry over to a later one.
  await f.prompt('s-alpha', text, { timestamp: Date.now() });
  const map = JSON.parse(await readFile(path.join(f.boundaries, (await f.attributionFiles()).find((name) => name.endsWith('.attribution.json'))), 'utf8'));
  assert.equal(map.currentSkill, null, 'a skill call belongs to its prompt');
});

test('SFG REQ-020: VS Code\'s <skill-context> prompt names the skill, and a per-call stamp matches its call', async (t) => {
  const f = await fixture(t);
  await f.prompt('s-vscode', 'The user explicitly invoked the "/probe-skill" skill. Follow its instructions now.\n\n<skill-context name="probe-skill">\nsteps\n</skill-context>');
  const toolArgs = { path: path.join(f.root, 'src/app.js'), old_str: 'const a = 1;', new_str: 'const a = 3;' };
  await sfGuardStamp('alpha', 'preToolUse', { sessionId: 's-vscode', cwd: f.root, toolName: 'edit', toolArgs }, { directory: f.boundaries });
  await f.edit('s-vscode', 'const a = 1;', 'const a = 3;');
  await f.end('s-vscode', 'user_exit');
  const [record] = await f.writes();
  assert.equal(record.writer.skill, 'probe-skill');
  assert.equal(record.writer.attribution.skillSource, 'prompt');
  assert.equal(record.writer.agent, 'alpha');
  assert.equal(record.writer.attribution.call, callKey('edit', toolArgs));
});

test('SFG REQ-021: a shell call is recorded with fingerprints when it ran, and as not run when no post-tool hook came', async (t) => {
  const f = await fixture(t);
  await f.prompt('s-shell', 'Commit the change.');
  await writeFile(path.join(f.root, 'src/app.js'), 'const a = 1;\nconst b = 7;\n');
  // The command changes the index and HEAD while it runs.
  const decision = await repositoryToolGuard({ sessionId: 's-shell', cwd: f.root, toolName: 'bash', toolArgs: { command: 'git commit -am x' } });
  f.git('commit', '-qam', 'x');
  await repositoryPostToolGuard({ sessionId: 's-shell', cwd: f.root, toolName: 'bash', toolArgs: { command: 'git commit -am x' } });
  assert.deepEqual(decision, {});
  await f.shell('s-shell', 'rm -rf build', { after: false });
  await f.end('s-shell', 'complete');
  const [ran, skipped] = await readSfGuardShellRecords(f.root);
  assert.equal(ran.ran, true);
  assert.equal(ran.changed, true);
  assert.notEqual(ran.before.head, ran.after.head);
  assert.equal(skipped.ran, false, 'pre without post: it never ran');
  assert.equal(skipped.after, null);
});

test('SFG REQ-022: a session map lasts the session; ACP\'s per-prompt "complete" keeps it, a real end starts a new one', async (t) => {
  const f = await fixture(t, { binding: { workId: 'SFG-2', phaseId: 'specification', agent: 'product-owner' } });
  await recordRepositoryBoundaryTurn({ sessionId: 's-acp', cwd: f.root, prompt: '/sf-phase' }, { captureMutation: async () => ({}) });
  await f.end('s-acp', 'complete');
  await f.prompt('s-acp', 'Answers: 1. yes 2. no');
  const name = (await f.attributionFiles()).find((entry) => entry.endsWith('.attribution.json'));
  const first = JSON.parse(await readFile(path.join(f.boundaries, name), 'utf8'));
  assert.equal(first.prompt.continued, false, 'a clarification answer in a plain prompt is a plain chat, as the guard reads it [PCR:REQ-042]');
  assert.equal(first.prompt.plainChat, true);
  assert.equal(first.lastExplicit.skill, 'sf-phase', 'the map still knows the turn ACP\'s per-prompt end kept');
  await f.end('s-acp', 'user_exit');
  assert.deepEqual(await f.attributionFiles(), []);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.prompt('s-acp', 'A new chat that reuses the id.');
  const second = JSON.parse(await readFile(path.join(f.boundaries, name), 'utf8'));
  assert.notEqual(second.startedAt, first.startedAt);
  assert.equal(second.lastExplicit, null);
  assert.equal(second.prompt.continued, false);
});

test('SFG: paused SFlow still records where SF Guard is on, labelled paused', async (t) => {
  const f = await fixture(t);
  await setCopilotPaused(true);
  await f.prompt('s-paused', 'Edit while paused.');
  await f.edit('s-paused', 'const a = 1;', 'const a = 6;');
  await f.end('s-paused', 'user_exit');
  const [record] = await f.writes();
  assert.equal(record.writer.attribution.paused, true);
});

test('SFG REQ-023: a recording failure is a gap, never a changed answer', async (t) => {
  const f = await fixture(t);
  await f.prompt('s-gap', 'Run it.');
  // Make the shell-record store unwritable: a file where its directory should be.
  await mkdir(path.join(f.root, '.git/singularity-flow'), { recursive: true });
  await writeFile(path.join(f.root, '.git/singularity-flow/attribution'), 'not a directory');
  assert.deepEqual(await f.shell('s-gap', 'echo hi'), {});
  assert.ok((await readSfGuardGaps(f.root)).length >= 1);
});

test('SFG REQ-060: the guard command\'s verified state turns recording on without the policy file, and the on check reads no Git', async (t) => {
  const f = await fixture(t, { on: false });
  const repo = await sfGuardRepository(path.join(f.root, 'src'));
  assert.equal(repo.root, f.root);
  assert.equal((await sfGuardOn(repo)).on, false);
  await writeSfGuardLocalState(f.root, true);
  assert.equal((await sfGuardOn(repo)).on, true);
  await f.prompt('s-state', 'Change a.');
  await f.edit('s-state', 'const a = 1;', 'const a = 8;');
  await f.end('s-state', 'user_exit');
  assert.equal((await f.writes()).length, 1);
  await writeSfGuardLocalState(f.root, false);
  assert.equal((await sfGuardOn(repo)).on, false);
  // A worktree's .git file leads to the same common directory.
  const linked = path.join(f.directory, 'linked');
  f.git('worktree', 'add', '-q', linked);
  const worktree = await sfGuardRepository(linked);
  assert.equal(await realpath(worktree.commonDir), await realpath(path.join(f.root, '.git')));
});

test('SFG D4: stamping hooks answer {} wherever SFlow is missing, and refuse a name that is not one', () => {
  const hooks = sfGuardStampingHooks('product-owner');
  assert.deepEqual(Object.keys(hooks), ['userPromptSubmitted']);
  const [entry] = hooks.userPromptSubmitted;
  assert.match(entry.bash, /singularity-flow hook agent-stamp product-owner userPromptSubmitted \|\| printf '%s\\n' '\{\}'$/u);
  const result = spawnSync('/bin/bash', ['-c', entry.bash], { env: { PATH: '/nonexistent' }, encoding: 'utf8', input: '{}' });
  assert.equal(result.stdout.trim(), '{}');
  assert.throws(() => sfGuardStampingHooks('bad name; rm -rf /'), /agent name/u);
});

test('SFG: the provisional class follows §4 and D1', () => {
  const none = { agent: null, agentSource: 'none' };
  assert.equal(sfGuardClassification(none, { name: null }), 'outside-workflow');
  assert.equal(sfGuardClassification(none, { name: 'sf-code' }), 'declared');
  assert.equal(sfGuardClassification({ agent: 'alpha', agentSource: 'agent-hook' }, { name: null }), 'declared');
  assert.equal(sfGuardClassification({ agent: 'alpha', agentSource: 'agent-hook' }, { name: 'probe-skill' }), 'pending');
  assert.equal(sfGuardClassification({ agent: 'helper', agentSource: 'subagent' }, { name: null }), 'outside-workflow');
  assert.equal(sfGuardClassification({ agent: 'sflow-utility', agentSource: 'subagent' }, { name: null }), 'declared');
});

test('SFG: no session map, no stamp, outside a repository or with SF Guard off', async (t) => {
  const f = await fixture(t, { on: false });
  await sfGuardStamp('alpha', 'userPromptSubmitted', { sessionId: 's-none', cwd: f.root, prompt: 'x' }, { directory: f.boundaries });
  await sfGuardStamp('alpha', 'userPromptSubmitted', { sessionId: 's-none', cwd: os.tmpdir(), prompt: 'x' }, { directory: f.boundaries });
  assert.equal(await lstat(f.boundaries).then(() => true, () => false) ? (await f.attributionFiles()).length : 0, 0);
});
