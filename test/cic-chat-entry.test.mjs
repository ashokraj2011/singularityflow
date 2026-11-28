/**
 * The chat entry of SPEC-CIC switch 3 [CIC:REQ-015, AC-015], decided once (owner, 2026-11-28, reversing the "Propose it?"
 * of owner decision 3, 2026-11-14). In chat the agent drafts the change, shows its preview in plain words (what changes, how
 * big it is and why, what is redone, what is kept, who decides) and writes the proposal in the same turn, its reason one line
 * on why it is proposed, asking nothing first. The person decides it once, approving or dropping it on the Decide card or in
 * their own terminal; deciding (applying it) and acknowledging stay the person's, refused in every chat turn without them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHash } from 'node:crypto';

import { COMMAND_REGISTRY } from '../src/command-registry.mjs';
import { recordRepositoryBoundaryTurn, repositoryPostToolGuard, repositoryToolGuard } from '../src/copilot-repository-boundary.mjs';
import { deriveMutationContract } from '../src/phase-mutation-contract.mjs';
import { captureMutationTurn } from '../src/copilot-mutation-guard.mjs';
import { ANSWER_BOUND_STEPS } from '../src/person-step-catalog.mjs';

const AUTO_REPLY = 'The user is not available to answer your question. Choose a pragmatic option best aligned with the context of the request.';
const UNBOUND = /^PHASE_MUTATION_ANSWER_UNBOUND: nothing was recorded\./u;

async function fixture(t, { changeImpact = 'on' } = {}) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-cic-chat-')));
  const root = path.join(directory, 'repository');
  await mkdir(root);
  const previous = process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
  process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = path.join(directory, 'machine', 'mode.json');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE;
    else process.env.SINGULARITY_FLOW_COPILOT_MODE_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const git = (args) => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); };
  git(['init', '-q']); git(['config', 'user.name', 'Chat Tester']); git(['config', 'user.email', 'chat@example.test']);
  await writeFile(path.join(root, 'README.md'), 'Fixture.\n');
  const phase = { id: 'design', status: 'in_progress', generation: 1, writeScope: 'artifact-only', generationPolicy: { task: 'document', requirement: 'required' } };
  const definition = { workItemRoot: 'singularity/work-items', governance: { protectedPaths: ['policy'] } };
  const workflow = { workItem: { id: 'CHAT-1' }, currentPhase: 'design', phaseOrder: ['design'], phases: { design: phase },
    resolution: changeImpact === 'on' ? { spec: { changeImpact: 'on', observedDependencies: 'on' } } : {} };
  const workflowFile = path.join(root, definition.workItemRoot, 'CHAT-1', 'workflow.json');
  await mkdir(path.dirname(workflowFile), { recursive: true });
  await writeFile(workflowFile, JSON.stringify(workflow));
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const accepted = { definition, workflow };
  const enter = async (skill, sessionId) => {
    const payload = { cwd: root, sessionId, prompt: skill };
    await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record, { resolveRoot: async () => root, load: async () => accepted }) });
    return payload;
  };
  const run = (payload, command) => repositoryToolGuard({ ...payload, toolName: 'bash', toolArgs: { command, cwd: root } });
  // What the person answered to the agent's question, as Copilot CLI and VS Code's agent host hand it to the post-tool hook.
  const answered = (payload, question, reply) => repositoryPostToolGuard({ ...payload, toolName: 'ask_user', toolArgs: { question },
    toolResult: { textResultForLlm: reply, resultType: 'success' } });
  return { root, enter, run, answered, boundaries: path.join(directory, 'machine', 'copilot-boundaries') };
}

const PROPOSE = 'singularity-flow story intent-amendment propose --work-id CHAT-1 --file draft.md --reason "Retries go to five; the business wants it." --authored governed-agent --channel copilot-host --json';

test('a proposal in chat is written without asking "Propose it?", in /sf-reject and /sf-amend, on both hosts, change impact on or off [CIC:AC-015, owner 2026-11-28]', async (t) => {
  assert.ok(!ANSWER_BOUND_STEPS.includes('intent-amendment-proposal'), 'a proposal is no step held to a yes');
  for (const changeImpact of ['on', 'off']) {
    const f = await fixture(t, { changeImpact });
    // Nobody was asked anything: the proposal runs. Before, it waited for the person's Yes to "Propose it?" (one answer).
    for (const prompt of ['/sf-reject intent-amendment propose CHAT-1', '/sf-amend CHAT-1 retries go to five']) {
      const unasked = await f.enter(prompt, `unasked-${changeImpact}-${prompt.split(' ')[0]}`);
      assert.deepEqual(await f.run(unasked, PROPOSE), {}, `${changeImpact}: ${prompt}`);
    }
    // A No or a host's own reply to some other question changes nothing about it: no question is bound to it.
    const other = await f.enter('/sf-amend CHAT-1', `other-${changeImpact}`);
    await f.answered(other, 'Is CHAT-1 the right Story?', AUTO_REPLY);
    assert.deepEqual(await f.run(other, PROPOSE), {});
    // VS Code's own chat, whose answers may not reach SFlow, proposes the same way: nothing is sent to the person's terminal.
    const payload = await f.enter('/sf-reject intent-amendment propose CHAT-1', `local-${changeImpact}`);
    const local = await repositoryToolGuard({ session_id: payload.sessionId, cwd: payload.cwd, hook_event_name: 'PreToolUse', tool_name: 'run_in_terminal',
      tool_input: { command: PROPOSE, cwd: f.root } });
    assert.notEqual(local.permissionDecision, 'deny', JSON.stringify(local));
  }
});

test('applying an intent amendment without the person is still refused: deciding and acknowledging stay theirs in every chat turn [CIC:AC-015, AC-017]', async (t) => {
  const f = await fixture(t);
  const decide = ['singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --work-id CHAT-1',
    'singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --class material --work-id CHAT-1',
    'singularity-flow story intent-amendment decide AMD-001 --decision reject --confirm AMD-001 --work-id CHAT-1'];
  const acknowledge = 'singularity-flow story intent-amendment acknowledge AMD-001 --work-id CHAT-1';
  // In the turns that write the proposal, and in a work command's turn, neither applies it: nor does a "Yes" typed or answered.
  for (const prompt of ['/sf-reject intent-amendment propose CHAT-1', '/sf-amend CHAT-1', '/sf-phase', '/sf-code', 'Yes, approve it.']) {
    const payload = await f.enter(prompt, `apply-${prompt}`);
    await f.answered(payload, 'Approve AMD-001? (Yes, No)', 'User responded: Yes');
    for (const command of [...decide, acknowledge]) {
      const answer = await f.run(payload, command);
      assert.equal(answer.permissionDecision, 'deny', `${prompt}: ${command}`);
      assert.match(answer.permissionDecisionReason, /decisions card|own terminal/u, `${prompt}: ${command}`);
    }
  }
  // Deciding it is the person's own step, refused even in /sf-decide; its acknowledgement there stands only on their own Yes.
  const card = await f.enter('/sf-decide CHAT-1', 'apply-decide');
  for (const command of decide) assert.equal((await f.run(card, command)).permissionDecision, 'deny', command);
  const unasked = await f.run(card, acknowledge);
  assert.equal(unasked.permissionDecision, 'deny');
  assert.match(unasked.permissionDecisionReason, UNBOUND);
  // In /sf-reject a proposal waits for nothing now; its other steps keep their own checks, as before.
  const chatRecord = 'singularity-flow decisions record CHAT-1 --choose d1=dismiss --reason "The person dismissed it." --expected k1';
  const elsewhere = await f.enter('/sf-reject intent-amendment propose CHAT-1', 'record');
  assert.doesNotMatch((await f.run(elsewhere, chatRecord)).permissionDecisionReason ?? '', UNBOUND);
});

test('both skills show the preview in plain words and propose it without asking, its reason one line on why [CIC:AC-015, REQ-015]', async () => {
  const reject = await readFile(new URL('../plugin/skills/sflow-reject/SKILL.md', import.meta.url), 'utf8');
  assert.match(reject, /in plain words\n\s+\(what changes, its size and why, what is redone or kept, who decides\), then, asking nothing, in this turn run/u);
  const amend = await readFile(new URL('../plugin/skills/sflow-amend/SKILL.md', import.meta.url), 'utf8');
  assert.match(amend, /in plain words \(what changes, its size and why, what is redone or kept, who decides\)\. It records nothing\.\n4\. Propose it in this same turn, asking nothing first,/u);
  for (const skill of [reject, amend]) {
    assert.doesNotMatch(skill, /Propose it\?/u);
    assert.match(skill, /--reason "<one line: why it is proposed>"/u);
    assert.match(skill, /[Nn]ever decide or acknowledge here/u);
  }
});

// Every turn summary, as the prompt hook gives it to the model: an /sf-amend turn is told its own route, a /sf-reject turn
// keeps "approval or rejection only", and no summary names an SFlow command without its binary [owner, 2026-11-14, D1: a
// model copied `story intent-amendment propose --file` from the reminder and was refused twice].
const ROOTS = new Set(COMMAND_REGISTRY.flatMap((entry) => [entry.name, ...(entry.aliases ?? [])]));
function bareCommands(text) {
  const spans = [...String(text).matchAll(/`([^`]+)`/gu)].map((match) => match[1]);
  const bare = spans.filter((span) => !/^(?:singularity-flow|sflow) /u.test(span) && ROOTS.has(span.split(/\s+/u)[0]));
  // A flag outside a command span is a command written without its binary.
  const outside = String(text).replace(/`[^`]+`/gu, '');
  return [...bare, ...[...outside.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/gu)].map((match) => match[1])];
}

test('an /sf-amend turn is told its own route with full commands, /sf-reject keeps approval only, and no summary names a bare command [D1]', async (t) => {
  assert.deepEqual(bareCommands('Use `story intent-amendment propose --file x`, then --reason.'), ['story intent-amendment propose --file x', '--reason']);
  assert.deepEqual(bareCommands('Run `singularity-flow prepare` and `/sf-decide W-1`.'), []);
  const summaries = [];
  const recorded = async (f, payload) => JSON.parse(await readFile(path.join(f.boundaries, `${createHash('sha256').update(payload.sessionId).digest('hex')}.mutation.json`), 'utf8')).contract;
  for (const changeImpact of ['on', 'off']) {
    const f = await fixture(t, { changeImpact });
    const amend = await f.enter('/sf-amend CHAT-1', `pin-amend-${changeImpact}`);
    const contract = await recorded(f, amend);
    const file = contract.allow.staging[0] ?? null;
    // Preview and propose read the Story's own draft by default: the turn is never told to retype its path [owner, 2026-11-20].
    assert.equal(contract.summary, `Intent amendment only: draft the change ${file ? `only at the issued file ${file}` : 'only in the file `singularity-flow story intent-amendment draft` issues'}, `
      + 'show `singularity-flow story intent-amendment preview --work-id CHAT-1 --for-agent --json`, then propose with '
      + '`singularity-flow story intent-amendment propose --work-id CHAT-1 --reason "<why>" --authored governed-agent --channel copilot-host --json`'
      + ', its reason one line on why it is proposed, asking nothing first. '
      + 'A person decides it once, approving or dropping it, and acknowledges it, on the Decide card (/sf-decide CHAT-1) or in their own terminal, never this turn.');
    const reject = await recorded(f, await f.enter('/sf-reject intent-amendment propose CHAT-1', `pin-reject-${changeImpact}`));
    assert.ok(reject.summary.startsWith('Approval/rejection only. No file edits or next-phase authoring; end this turn after the decision.'), reject.summary);
    if (reject.allow.staging.length) {
      assert.ok(reject.summary.endsWith(` Draft an intent amendment only at the issued file ${reject.allow.staging[0]}, for \`singularity-flow story intent-amendment propose --work-id CHAT-1 --reason "<why>" --authored governed-agent --channel copilot-host --json\`.`), reject.summary);
    }
    const approve = await recorded(f, await f.enter('/sf-approve design', `pin-approve-${changeImpact}`));
    assert.equal(approve.summary, 'Approval/rejection only. No file edits or next-phase authoring; end this turn after the decision.');
    for (const skill of ['/sf-amend', '/sf-reject', '/sf-approve', '/sf-decide', '/sf-review-decide', '/sf-review-source', '/sf-session', '/sf-confirm', '/sf-run-app',
      '/sf-publish', '/sf-import-team', '/sf-build-workflow', '/sf-fix-workflow', '/sf-phase', '/sf-code', '/sf-next', '/sf-submit', '/sf-epic-story-draft']) {
      const payload = await f.enter(skill, `all-${changeImpact}-${skill}`);
      summaries.push([skill, (await recorded(f, payload)).summary]);
    }
  }
  // A step paused by a pending proposal, and the step states an authoring turn can be in.
  const paused = { workItem: { id: 'P-1' }, currentPhase: 'code', phaseOrder: ['scope', 'code'], resolution: {},
    phases: { scope: { id: 'scope', status: 'approved', generation: 1, requiredArtifact: { kind: 'requirements' } },
      code: { id: 'code', status: 'in_progress', generation: 0, generationPolicy: { task: 'code' } } },
    intentAmendments: [{ id: 'AMD-001', status: 'proposed' }], history: [{ event: 'intent_amendment_proposed', phase: 'code', detail: 'AMD-001 proposes 1 clause change(s)' }] };
  summaries.push(['paused', deriveMutationContract({ definition: { workItemRoot: 'singularity/work-items' }, workflow: paused, turnMode: 'authoring' }).summary]);
  assert.match(summaries.at(-1)[1], /`singularity-flow story intent-amendment status` and `singularity-flow story intent-amendment draft`, stay open/u);
  for (const step of [{ generationPolicy: { task: 'code' }, generationIntent: { status: 'open', generation: 1 } },
    { generationPolicy: { task: 'code', allowedProducers: ['deterministic'] }, generationIntent: { status: 'open', generation: 1 } },
    { generationPolicy: { task: 'document' }, writeScope: 'source-and-artifact' }, { generationPolicy: { task: 'document' } }]) {
    const workflow = { workItem: { id: 'S-1' }, currentPhase: 'step', phaseOrder: ['step'], resolution: {},
      phases: { step: { id: 'step', status: 'in_progress', generation: 0, writeScope: 'artifact-only', ...step } } };
    for (const turnMode of ['authoring', 'read', 'kernel-only', 'decision-only', 'approval-only']) {
      summaries.push([`${turnMode} ${JSON.stringify(step)}`, deriveMutationContract({ definition: { workItemRoot: 'singularity/work-items' }, workflow, turnMode }).summary]);
    }
  }
  // A drafting skill in a checkout with no Story (an Epic or Initiative, a repair).
  const f = await fixture(t);
  for (const skill of ['/sf-fix', '/sf-epic-story-draft']) {
    const payload = { cwd: f.root, sessionId: `no-story-${skill}`, prompt: skill };
    const entered = await recordRepositoryBoundaryTurn(payload, { captureMutation: (value, record) => captureMutationTurn(value, record,
      { resolveRoot: async () => f.root, load: async () => { throw new Error('No Story here'); } }) });
    summaries.push([`no Story ${skill}`, JSON.stringify(entered)]);
    assert.match(JSON.stringify(entered), /singularity-flow (?:repair authorize|initiative phase)/u, skill);
  }
  for (const [skill, summary] of summaries) assert.deepEqual(bareCommands(summary.replaceAll('\\`', '`')), [], `${skill}: ${summary}`);
});
