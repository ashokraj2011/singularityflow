/**
 * Read skills answer through SFlow's gateway tools when the host offers them.
 *
 * VS Code registers `sflow_resolve`, `sflow_read`, `sflow_next`, `sflow_run` and `sflow_explain` as
 * language-model tools and `singularity-flow gateway serve` offers them over MCP; Copilot CLI's
 * plugin registers neither. /sf-recommend, /sf-home (no request) and /sf-advise (no argument) run
 * `singularity-flow recommend --json`, which is itself `kernel.resolve('what should I do next')`
 * and a read of the handle it returns. Their steps now name those two tool calls, and one generated
 * clause says to use them when present and the CLI command otherwise.
 *
 * These tests hold three things to that: the skill rule (tool first, CLI fallback, no new exit),
 * the answer (driven through the MCP tool layer, it carries every field those steps report, and the
 * same `data.guidance`, `data.personalization` and `data.home` the CLI command prints), and the
 * Story (the one the CLI's own selection rule picks). Pause and the read-turn guard are held by
 * int-tool-pause.test.mjs, vscode-host.test.mjs and phase-mutation-contract.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { recommendationNarration } from '../src/commands/recommend.mjs';
import { mutationTurnMode } from '../src/phase-mutation-contract.mjs';
import { createHostGateway } from '../src/gateway/host.mjs';
import { serveMcp } from '../src/gateway/mcp-stdio.mjs';
import { gatewayPlanners } from '../src/gateway/planners/index.mjs';
import { validateSflowResult } from '../src/gateway/result.mjs';
import { run } from '../src/util.mjs';
import { COPILOT_PAUSE_MARKER } from '../src/copilot-mode.mjs';
import { GATEWAY_TOOLS_CLAUSE, GATEWAY_TOOLS_MARKER, auditSkillPolicy, loadSkillPolicy } from '../scripts/skill-policy.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ACTOR = { login: 'dev', email: 'dev@example.test', name: 'Dev' };
const AUTHORITIES = {
  developers: {
    label: 'Developers', allowAnyGitIdentity: false, githubTeams: [],
    members: [{ name: ACTOR.name, email: ACTOR.email, githubLogin: ACTOR.login }]
  }
};

const RECOMMEND_CALL = /Call `sflow_resolve` with `\{"utterance": "what should I do next"\}`, then `sflow_read` its one\s+read handle \(`next\[0\]\.handle`\) as `resolutionId`|call `sflow_resolve` with `\{"utterance": "what should I do next"\}`, then `sflow_read` its one read handle \(`next\[0\]\.handle`\) as `resolutionId`/u;
const EXPLAIN_CALL = /call `sflow_explain` with `\{"question": "\$ARGUMENTS"\}`, then `sflow_read` each handle in its `data\.part\.read` as `resolutionId` in the same response; its `data\.body` and theirs, in part order, are `data\.served\.text`\./u;

/**
 * The skills whose step names a tool call: the call (exact), the CLI command it stands beside, and
 * what that step said before that must still be there. The answers are held to the CLI's JSON here
 * (recommend) and in int-skill-gateway-reads.test.mjs (docs, help).
 */
const SWITCHED = Object.freeze({
  'sflow-recommend': { call: RECOMMEND_CALL, command: 'singularity-flow recommend --json', kept: [] },
  'sflow-home': { call: RECOMMEND_CALL, command: 'singularity-flow recommend --json', kept: ["singularity-flow home --json --request '$ARGUMENTS'"] },
  'sflow-advise': { call: RECOMMEND_CALL, command: 'singularity-flow recommend --json', kept: ["singularity-flow home --json --request '$ARGUMENTS'"] },
  'sflow-docs': { call: EXPLAIN_CALL, command: "singularity-flow explain '$ARGUMENTS' --json",
    kept: ["each inner `'` as `'\\''` (PowerShell `''`) so nothing expands", 'run `singularity-flow explain --json` for the topic catalog', 'Do not map the question to a topic from model memory.'] },
  'sflow-help': { call: EXPLAIN_CALL, command: "singularity-flow explain '$ARGUMENTS' --json",
    kept: ["each inner `'` as `'\\''` (PowerShell `''`) so nothing expands", 'Relay only `data.served.text`, its citation/provenance, warnings, and related actions.', 'Never answer product behavior from model memory.'] }
});

async function skillBody(name) {
  const text = await readFile(path.join(root, 'plugin', 'skills', name, 'SKILL.md'), 'utf8');
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
}

/** A numbered step, or the paragraph it is in, that names an `sflow_*` call. */
function toolSteps(body) {
  return body.replace(GATEWAY_TOOLS_CLAUSE, '').split(/\n(?=\d+\. )/u).filter((step) => /`sflow_[a-z]+`/u.test(step));
}

test('the skills that name a tool call are exactly the registry\'s gatewayTools skills, all read turns', async () => {
  const { policy } = await loadSkillPolicy(root);
  const flagged = Object.entries(policy.skills).filter(([, rule]) => rule.gatewayTools === true).map(([name]) => name).sort();
  assert.deepEqual(flagged, Object.keys(SWITCHED).sort());
  for (const name of flagged) assert.equal(mutationTurnMode(name), 'read', name);
  const audit = await auditSkillPolicy(root);
  assert.deepEqual(audit.errors, []);
  for (const name of Object.keys(policy.skills)) {
    const body = await skillBody(name);
    assert.equal(body.includes(GATEWAY_TOOLS_MARKER), flagged.includes(name), name);
    // No skill names sflow_run as something to call; read turns refuse it (copilot-mutation-guard).
    assert.doesNotMatch(body.replace(GATEWAY_TOOLS_CLAUSE, ''), /`sflow_run`/u, name);
  }
});

test('tool first, the same CLI command otherwise, and no new reason to stop', async () => {
  // The rule every switched skill carries, word for word, directly under its pause line.
  for (const required of [
    'When a step names an `sflow_*` call and that tool is in your tool list, make that call once, exactly as written, instead of the step\'s CLI command',
    'its `gateway.copilot-paused` refusal carries `data.paused`',
    'If the tool is absent, errors or refuses for another reason, or its answer lacks a field the step reports, run the step\'s CLI command once and finish the step with it.',
    'Never call `sflow_run` here.'
  ]) assert.ok(GATEWAY_TOOLS_CLAUSE.includes(required), required);
  // The clause adds no stop, relay, hand-off or question: every way a tool can fail runs the CLI read.
  assert.doesNotMatch(GATEWAY_TOOLS_CLAUSE, /\b(?:stop|stops|relay|hand(?:s)? off|hand-off|ask(?:s)?|wait)\b/iu);
  for (const [name, { call, command, kept }] of Object.entries(SWITCHED)) {
    const body = await skillBody(name);
    const pause = body.indexOf(COPILOT_PAUSE_MARKER);
    const pauseLineEnd = body.indexOf('\n', body.indexOf('\n', pause) + 1);
    assert.equal(body.indexOf(`${GATEWAY_TOOLS_MARKER}\n${GATEWAY_TOOLS_CLAUSE}`), pauseLineEnd + 2, `${name}: under the pause line`);
    const steps = toolSteps(body);
    assert.equal(steps.length, 1, `${name}: one step names its tool calls`);
    const [step] = steps;
    // The tool call, exactly, and the CLI command it replaces in the same step as its fallback.
    assert.match(step, call, name);
    assert.ok(step.includes(`\`${command}\``), `${name}: the CLI command stays in the step`);
    assert.ok(step.search(/`sflow_(?:resolve|explain)`/u) < step.indexOf(command), `${name}: the tool comes first`);
    // Nothing the step said before was lost: the CLI path keeps its exact quoting and rules.
    for (const sentence of kept) assert.ok(step.includes(sentence), `${name}: ${sentence}`);
  }
});

test('the recommend steps keep every reported field and rule', async () => {
  const body = await skillBody('sflow-recommend');
  for (const kept of ['Read `data.guidance` from the returned envelope.', '`data.personalization.replyName`', '`requiredInputs`',
    'Offer secondary actions only after the primary recommendation.', 'Do not execute the recommended command automatically.',
    'Trust only', 'do not search for missing context']) assert.ok(body.includes(kept), kept);
  const home = await skillBody('sflow-home');
  for (const kept of ['`data.home.repository`', '`data.home.currentWork`', '`data.home.personalization.replyName`', 'Report `bootstrap`',
    'Stored locally · Never pushed', 'Safe reads may run immediately.']) assert.ok(home.includes(kept), kept);
  const advise = await skillBody('sflow-advise');
  for (const kept of ["singularity-flow explain '$ARGUMENTS' --here --json", 'singularity-flow nextsteps <WORK-ID> --for-agent --json',
    'Never choose on their behalf.', '“Nothing yet”']) assert.ok(advise.includes(kept), kept);
});

/** A Git repository holding the given Stories, the first checked out on its own branch when asked. */
async function repository(t, stories, { branch = null } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'sflow-skill-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  run('git', ['init', '-q', '-b', 'main'], { cwd: directory });
  run('git', ['config', 'user.email', ACTOR.email], { cwd: directory });
  run('git', ['config', 'user.name', ACTOR.name], { cwd: directory });
  for (const [index, id] of stories.entries()) {
    const item = path.join(directory, 'singularity', 'work-items', id);
    await mkdir(item, { recursive: true });
    await writeFile(path.join(item, 'workflow.json'), JSON.stringify({
      workItem: { id, title: `Story ${id}`, workType: 'feature', branch: `wi/${id}` },
      phaseOrder: ['planning', 'design'], currentPhase: 'planning',
      phases: {
        planning: { label: 'Planning', status: index === 0 ? 'in_progress' : 'awaiting_approval', generation: 1,
          approvalPolicy: { authorities: ['developers'], minimum: 1, allowSelfApproval: true } },
        design: { label: 'Design', status: 'pending' }
      },
      history: [{ event: 'work_started', phase: 'planning', actor: ACTOR, at: `2026-10-24T1${index}:00:00.000Z` },
        ...(index === 0 ? [] : [{ event: 'phase_submitted', phase: 'planning', actor: ACTOR, at: `2026-10-24T1${index}:30:00.000Z` }])],
      resolution: { approvalAuthorities: AUTHORITIES }
    }));
  }
  await writeFile(path.join(directory, 'README.md'), '# fixture\n');
  run('git', ['add', '-A'], { cwd: directory });
  run('git', ['commit', '-q', '-m', 'first'], { cwd: directory });
  if (branch) run('git', ['checkout', '-q', '-b', branch], { cwd: directory });
  return directory;
}

/** Copilot's side of an MCP session: each call goes through the server's own tool dispatch. */
async function mcp(createKernel, calls) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map();
  let buffered = '';
  let next = 1;
  const pending = new Map();
  output.on('data', (chunk) => {
    buffered += chunk;
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffered.slice(0, at));
      buffered = buffered.slice(at + 1);
      replies.set(reply.id, reply);
      pending.get(reply.id)?.(reply);
    }
  });
  const request = (method, params) => new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const served = serveMcp({ input, output, serverInfo: { name: 'sflow-test', version: '0' }, createKernel });
  await request('initialize', {});
  const tool = async (name, args) => {
    const reply = await request('tools/call', { name, arguments: args });
    return validateSflowResult(reply.result.structuredContent);
  };
  try { return await calls(tool); } finally { input.end(); await served; }
}

/** The two calls the switched steps name, exactly as written there. */
async function recommendThroughTools(tool) {
  const resolved = await tool('sflow_resolve', { utterance: 'what should I do next' });
  assert.deepEqual([resolved.kind, resolved.operation.id, resolved.next.length], ['read', 'developer.next', 1]);
  assert.match(resolved.next[0].handle, /^rea_/u, 'one read handle, which sflow_read takes as it is');
  return tool('sflow_read', { resolutionId: resolved.next[0].handle });
}

test('through the MCP tool layer the two calls answer with every field the switched steps report', async (t) => {
  const directory = await repository(t, ['hex-1', 'hex-2'], { branch: 'wi/hex-1' });
  const { kernel } = createHostGateway({ root: directory, hostSessionId: 'skill-tools-mcp', planners: gatewayPlanners() });
  const answer = await mcp(async () => kernel, recommendThroughTools);
  assert.deepEqual([answer.kind, answer.operation.id], ['read', 'developer.next']);

  // /sf-recommend steps 2-5 and /sf-advise step 7: guidance, reply name, required inputs, the action.
  const { guidance } = answer.data;
  assert.equal(guidance.workId, 'hex-1');
  for (const field of ['state', 'currentPhase', 'recommendation', 'actions', 'evidence', 'preflight', 'requiredInputs', 'unavailableReason']) {
    assert.ok(Object.hasOwn(guidance, field), `data.guidance.${field}`);
  }
  assert.ok(Array.isArray(guidance.requiredInputs));
  assert.equal(answer.data.personalization.replyName, ACTOR.name);
  // Secondary actions are next[1..], each with the routes the shared clause names (`fallback`).
  assert.ok(answer.next.length > 1);
  for (const action of answer.next) assert.equal(typeof action.fallback?.command, 'string', action.id);
  assert.equal(answer.next[0].fallback.command, guidance.recommendation.command);
  assert.equal(answer.next[0].fallback.copilotCommand, guidance.recommendation.skill);

  // /sf-home step 2 reads these from `data.home`; in the tool answer they are `data` itself.
  for (const field of ['workspace', 'repository', 'currentWork', 'attentionWork', 'personalization', 'today', 'yesterday']) {
    assert.ok(Object.hasOwn(answer.data, field), `data.${field}`);
  }
  // The tool answer names the repository; its location stays off what the model reads.
  assert.deepEqual([answer.data.repository.id, answer.data.repository.path], [path.basename(directory), null]);
  assert.equal(answer.data.currentWork.id, 'hex-1');
  // With no workspace there is no repository, and the answer says so with its `bootstrap` field.
  const { kernel: rootless } = createHostGateway({ root: null, hostSessionId: 'skill-tools-rootless', planners: gatewayPlanners() });
  const unrooted = await mcp(async () => rootless, recommendThroughTools);
  assert.deepEqual([unrooted.data.workspace, unrooted.data.repository], [null, null]);
  assert.ok(Object.hasOwn(unrooted.data, 'bootstrap'));
  assert.equal(unrooted.data.guidance.state, 'no_workspace');

  // The CLI command builds its JSON from this same envelope: same guidance, name and Home data.
  const printed = recommendationNarration(answer);
  assert.deepEqual(printed.data.guidance, answer.data.guidance);
  assert.deepEqual(printed.data.personalization, answer.data.personalization);
  assert.deepEqual(printed.data.home, answer.data);
  assert.deepEqual(printed.data.alternatives.map((entry) => entry.command), answer.next.slice(1).map((action) => action.fallback.command));
});

test('the Story is the one the CLI\'s own selection picks, never another', async (t) => {
  // The checked-out Story's branch selects it, as `recommend` does for this checkout.
  const checkedOut = await repository(t, ['hex-1', 'hex-2'], { branch: 'wi/hex-2' });
  const onBranch = createHostGateway({ root: checkedOut, hostSessionId: 'skill-tools-branch', planners: gatewayPlanners() });
  assert.equal((await mcp(async () => onBranch.kernel, recommendThroughTools)).data.guidance.workId, 'hex-2');

  // The attached Story `recommend` and `gateway serve` take from the active selection wins over the
  // branch: both hosts hand the kernel the same plannerContext fields (commands/recommend.mjs,
  // commands/gateway.mjs), so the tool answer and the CLI's are about the same Story.
  const attached = createHostGateway({ root: checkedOut, hostSessionId: 'skill-tools-attached', planners: gatewayPlanners(),
    plannerContext: { storyId: 'hex-1', workId: 'hex-1', workKind: 'story' } });
  const selected = await mcp(async () => attached.kernel, recommendThroughTools);
  assert.deepEqual([selected.data.guidance.workId, selected.data.currentWork.id], ['hex-1', 'hex-1']);

  // No Story at all: the answer names none rather than borrowing another repository's.
  const empty = await repository(t, []);
  const none = createHostGateway({ root: empty, hostSessionId: 'skill-tools-none', planners: gatewayPlanners() });
  const nothing = await mcp(async () => none.kernel, recommendThroughTools);
  assert.equal(nothing.data.guidance.workId, null);
  assert.equal(nothing.data.currentWork, null);
});

test('the registry declares gatewayTools only as a boolean beside the class', async () => {
  const registry = YAML.parse(await readFile(path.join(root, 'plugin', 'skills', 'registry.yml'), 'utf8'));
  for (const [name, rule] of Object.entries(registry.skills)) {
    if ('gatewayTools' in rule) assert.equal(rule.gatewayTools, true, name);
  }
});
