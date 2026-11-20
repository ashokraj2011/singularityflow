/**
 * The chat entry of SPEC-CIC switch 3 [CIC:REQ-015, AC-015; owner decision 3, 2026-11-14]. In chat the agent drafts the
 * change and runs its preview, shows the person in plain words what changes, how big it is and why, what is redone, what is
 * kept and who must confirm, and asks yes or no. Only after the person's own yes does it propose, through the existing route;
 * a host's auto-reply, a declined question, a no or Not now proposes nothing. Deciding and acknowledging stay the person's,
 * on the Decide card or in their own terminal. With change impact off, a proposal in chat is as it was.
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
import { ANSWER_BOUND_STEPS, ANSWER_BOUND_TURNS } from '../src/person-step-catalog.mjs';

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
const SAID = 'User responded: Yes. Retries go to five; the business wants it.';

test('a proposal in chat is held to the person\'s yes to its preview, on the reply to that question only [CIC:AC-015]', async (t) => {
  assert.ok(ANSWER_BOUND_TURNS.includes('reject') && ANSWER_BOUND_TURNS.includes('amend'));
  assert.ok(ANSWER_BOUND_STEPS.includes('intent-amendment-proposal'));
  const f = await fixture(t);
  // Nobody was asked: refused, with the preview to show them as the way through, and the turn carries on.
  const unasked = await f.enter('/sf-reject intent-amendment propose CHAT-1', 'unasked');
  const refused = await f.run(unasked, PROPOSE);
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, UNBOUND);
  assert.match(refused.permissionDecisionReason, /proposed only on the person's own yes\. Show them its preview in plain words \(what changes, how big it is and why, what is redone, what is kept, who decides\), ask "Propose it\?" \(Yes, No\)/u);
  assert.equal(refused.recoverable, true);
  assert.match(refused.next?.[0]?.command ?? '', /^singularity-flow story intent-amendment preview --work-id CHAT-1 --file draft\.md/u);
  // Their yes to "Propose it?", with their own words as the reason: it runs.
  const yes = await f.enter('/sf-reject intent-amendment propose CHAT-1', 'yes');
  await f.answered(yes, 'Propose it? (Yes, No)', SAID);
  assert.deepEqual(await f.run(yes, PROPOSE), {});
  // A reason they did not say is not theirs.
  const reworded = await f.enter('/sf-reject intent-amendment propose CHAT-1', 'reworded');
  await f.answered(reworded, 'Propose it? (Yes, No)', SAID);
  assert.match((await f.run(reworded, PROPOSE.replace('Retries go to five; the business wants it.', 'Raise the retry limit.'))).permissionDecisionReason, /is not what the person answered/u);
  // A no, Not now, the host's own answer, a declined question: nothing is proposed.
  for (const [id, reply, said] of [['no', 'User responded: No', /did not say yes to proposing it: propose nothing/u],
    ['later', 'User responded: Not now', /did not say yes to proposing it: propose nothing/u],
    ['canned', AUTO_REPLY, /proposed only on the person's own yes/u],
    ['declined', 'User declined to answer', /proposed only on the person's own yes/u]]) {
    const payload = await f.enter('/sf-reject intent-amendment propose CHAT-1', id);
    await f.answered(payload, 'Propose it? (Yes, No)', reply);
    const answer = await f.run(payload, PROPOSE);
    assert.equal(answer.permissionDecision, 'deny', id);
    assert.match(answer.permissionDecisionReason, said, id);
  }
  // A yes to another question is no yes to proposing.
  const other = await f.enter('/sf-reject intent-amendment propose CHAT-1', 'other');
  await f.answered(other, 'Is CHAT-1 the right Story?', SAID);
  assert.match((await f.run(other, PROPOSE)).permissionDecisionReason, /proposed only on the person's own yes/u);
});

test('/sf-amend holds its proposal to the person\'s yes the same way, on both hosts [CIC:AC-015]', async (t) => {
  const f = await fixture(t);
  const unasked = await f.enter('/sf-amend CHAT-1 retries go to five', 'amend-unasked');
  const refused = await f.run(unasked, PROPOSE);
  assert.equal(refused.permissionDecision, 'deny');
  assert.match(refused.permissionDecisionReason, /proposed only on the person's own yes/u);
  for (const [id, reply] of [['amend-no', 'User responded: No'], ['amend-canned', AUTO_REPLY], ['amend-declined', 'User declined to answer']]) {
    const payload = await f.enter('/sf-amend CHAT-1', id);
    await f.answered(payload, 'Propose it? (Yes, No)', reply);
    assert.match((await f.run(payload, PROPOSE)).permissionDecisionReason ?? '', UNBOUND, id);
  }
  const yes = await f.enter('/sf-amend CHAT-1', 'amend-yes');
  await f.answered(yes, 'Propose it? (Yes, No)', SAID);
  assert.deepEqual(await f.run(yes, PROPOSE), {});
  // VS Code's agent host hands the same ask_user answer; its own chat hands the questions tool's JSON, read the same way.
  const local = await f.enter('/sf-amend CHAT-1', 'amend-vscode');
  const hook = (fields) => ({ session_id: local.sessionId, cwd: local.cwd, hook_event_name: fields.tool_response === undefined ? 'PreToolUse' : 'PostToolUse', ...fields });
  await repositoryPostToolGuard(hook({ tool_name: 'vscode_askQuestions', tool_input: { questions: [{ header: 'Propose', question: 'Propose it?' }] }, tool_use_id: 'q1',
    tool_response: JSON.stringify({ answers: { Propose: { selected: ['Yes'], freeText: 'Retries go to five; the business wants it.', skipped: false } } }) }));
  assert.notEqual((await repositoryToolGuard(hook({ tool_name: 'run_in_terminal', tool_input: { command: PROPOSE, cwd: f.root } }))).permissionDecision, 'deny');
  // Deciding and acknowledging stay the person's there too.
  for (const command of ['singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --class material --work-id CHAT-1',
    'singularity-flow story intent-amendment acknowledge AMD-001 --work-id CHAT-1']) assert.equal((await f.run(yes, command)).permissionDecision, 'deny', command);
});

// A real Copilot CLI /sf-amend (stage 7, 2026-11-15) asked "Propose it?" as chat text and ended its turn. Asked with
// ask_user, Copilot CLI sends the preview's summary as `message` with a Yes/No form, and hands back "User responded: Yes".
test('/sf-amend\'s "Propose it?" asked with Copilot CLI\'s ask_user form proposes on its Yes in that same turn, and a typed reply still does [CIC:AC-015]', async (t) => {
  const f = await fixture(t);
  const REASON = 'Retries go to five; the business wants it.';
  const ask = { message: 'This changes CHAT-1:REQ-001: retries go from three to five. Small, one clause: design is redone, intake is kept, and a scope approver decides. Propose it?',
    requestedSchema: { properties: { choice: { type: 'string', enum: ['Yes', 'No'] } } } };
  const asked = async (payload, toolArgs, reply) => {
    assert.notEqual((await repositoryToolGuard({ ...payload, toolName: 'ask_user', toolArgs })).permissionDecision, 'deny', 'asking is never refused');
    await repositoryPostToolGuard({ ...payload, toolName: 'ask_user', toolArgs, toolResult: { textResultForLlm: reply, resultType: 'success' } });
  };
  const yes = await f.enter(`/sf-amend CHAT-1 ${REASON}`, 'amend-form-yes');
  await asked(yes, ask, 'User responded: Yes');
  assert.deepEqual(await f.run(yes, PROPOSE), {});
  // The same form handed as JSON text reads the same.
  const text = await f.enter(`/sf-amend CHAT-1 ${REASON}`, 'amend-form-text');
  await asked(text, JSON.stringify(ask), 'User responded: Yes');
  assert.deepEqual(await f.run(text, PROPOSE), {});
  // Its No proposes nothing, and a Yes to another question is no yes to proposing.
  const no = await f.enter(`/sf-amend CHAT-1 ${REASON}`, 'amend-form-no');
  await asked(no, ask, 'User responded: No');
  assert.match((await f.run(no, PROPOSE)).permissionDecisionReason ?? '', /did not say yes to proposing it: propose nothing/u);
  const other = await f.enter(`/sf-amend CHAT-1 ${REASON}`, 'amend-form-other');
  await asked(other, { ...ask, message: 'Is CHAT-1 the right Story?' }, 'User responded: Yes');
  assert.match((await f.run(other, PROPOSE)).permissionDecisionReason ?? '', /proposed only on the person's own yes/u);
  // Asked in chat text after all, the person's typed Yes is their next prompt: that plain follow-up still proposes.
  await f.enter(`/sf-amend CHAT-1 ${REASON}`, 'amend-typed');
  const typed = await f.enter('Yes', 'amend-typed');
  assert.deepEqual(await f.run(typed, PROPOSE), {});
});

test('VS Code\'s own chat, whose answers may not reach SFlow, is told to propose in the person\'s own terminal [CIC:AC-015]', async (t) => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-reject intent-amendment propose CHAT-1', 'local');
  const local = await repositoryToolGuard({ session_id: payload.sessionId, cwd: payload.cwd, hook_event_name: 'PreToolUse', tool_name: 'run_in_terminal',
    tool_input: { command: PROPOSE, cwd: f.root } });
  assert.equal(local.permissionDecision, 'deny');
  assert.match(local.permissionDecisionReason, /do not ask again in this chat\. They propose it in their own terminal, with their reason: singularity-flow story intent-amendment propose --work-id CHAT-1 --reason "<why>" --authored human/u);
});

test('deciding and acknowledging stay the person\'s in the chat entry, and without change impact a proposal is as it was [CIC:AC-015, AC-017]', async (t) => {
  const f = await fixture(t);
  const payload = await f.enter('/sf-reject intent-amendment propose CHAT-1', 'decide');
  await f.answered(payload, 'Propose it? (Yes, No)', SAID);
  for (const command of ['singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --work-id CHAT-1',
    'singularity-flow story intent-amendment decide AMD-001 --decision approve --confirm AMD-001 --class material --work-id CHAT-1',
    'singularity-flow story intent-amendment acknowledge AMD-001 --work-id CHAT-1']) {
    const answer = await f.run(payload, command);
    assert.equal(answer.permissionDecision, 'deny', command);
    assert.match(answer.permissionDecisionReason, /decisions card|own terminal/u, command);
  }
  // In /sf-reject only the proposal waits for a yes; its other steps keep their own checks, as before.
  const chatRecord = 'singularity-flow decisions record CHAT-1 --choose d1=dismiss --reason "The person dismissed it." --expected k1';
  const elsewhere = await f.enter('/sf-reject intent-amendment propose CHAT-1', 'record');
  assert.doesNotMatch((await f.run(elsewhere, chatRecord)).permissionDecisionReason ?? '', UNBOUND);
  const off = await fixture(t, { changeImpact: 'off' });
  const before = await off.enter('/sf-reject intent-amendment propose CHAT-1', 'off');
  assert.deepEqual(await off.run(before, PROPOSE), {}, 'no yes is asked for where change impact is off');
});

test('both skills show the preview in plain words, ask, and propose only after the person\'s own yes [CIC:AC-015, REQ-015]', async () => {
  const reject = await readFile(new URL('../plugin/skills/sflow-reject/SKILL.md', import.meta.url), 'utf8');
  assert.match(reject, /in plain words\n\s+\(what changes, its size and why, what is redone or kept, who decides\) and `ask_user` "Propose it\?" \(Yes, No\)\. On their Yes, in this turn, run/u);
  const amend = await readFile(new URL('../plugin/skills/sflow-amend/SKILL.md', import.meta.url), 'utf8');
  // Asked with the question tool in the preview's own response, never as chat text that ends the turn [stage 7 run, 2026-11-15].
  assert.match(amend, /in plain words \(what changes, its size and why, what is redone or kept, who decides\) and, in the same response, `ask_user` "Propose it\?" \(Yes, No\), never as chat text\. It records nothing\.\n4\. Propose only on their Yes, in this same turn,/u);
  for (const skill of [reject, amend]) assert.match(skill, /Where the steps say ask_user, use your host's question tool: ask_user in the Copilot CLI, vscode_askQuestions in VS Code/u);
  for (const skill of [reject, amend]) {
    assert.match(skill, /--reason "<THEIR WORDS>"/u);
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
      + `${changeImpact === 'on' ? ', only after the person\'s own Yes to "Propose it?", with their words as the reason' : ''}. `
      + 'A person decides and acknowledges it on the Decide card (/sf-decide CHAT-1) or in their own terminal, never this turn.');
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
