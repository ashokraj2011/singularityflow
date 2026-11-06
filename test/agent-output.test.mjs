/**
 * An agent reads `act` first and never more than its host shows. `[agent-output]`
 *
 * Live Copilot runs stalled on long results it saw only the start of, or could not open at all
 * once the host saved them outside the workspace; agents then asked again what an earlier step
 * settled, ended without the next step, or looped on a preview.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { agentAct, agentOutputGoverned, boundedAgentOutput, boundedAgentText, completeAgentResult, DEFAULT_AGENT_OUTPUT_BYTES, LOOP_THRESHOLD, observeAgentLoop, OMITTED_FIELDS_SHOWN, READ_CHUNK_BYTES, READ_PLAN_CHUNKS, returnsAgentPaths, withAgentRoutes } from '../src/agent-output.mjs';
import { CLI_PATH_REFERENCE } from '../src/safe-command-guidance.mjs';
import { approvalHoldContinuation } from '../src/copilot-guidance.mjs';
import { childTimeout } from './helpers/child-timeout.mjs';
import { namedReadRefused, namedReads } from './helpers/route-walker.mjs';
import { slowLane } from './helpers/slow-lane.mjs';

const cli = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));

test('known approval holds route every phase to its owner list while approval-time answers stay in approval', () => {
  for (const phase of ['specification', 'planning', 'implementation', 'convergence', 'verification', 'release', 'custom-review']) {
    const check = { ready: false, holds: [{ code: 'SPEC_COVERAGE_INCOMPLETE', owner: 'someone-decides' }] };
    const continuation = approvalHoldContinuation('HELD-1', check);
    const act = agentAct({ resultType: 'sflow-submission-readiness', workId: 'HELD-1', phaseId: phase,
      classification: 'already-submitted', approvalCheck: check, approvalContinuation: continuation,
      nextCommand: continuation.command });
    assert.equal(act.state, 'blocked');
    assert.equal(act.do.copilot, '/sf-decide HELD-1');
    assert.equal(act.do.shell, 'singularity-flow decisions HELD-1 --for-agent --json');
    assert.ok(act.read.includes('approvalCheck'));
    assert.doesNotMatch(JSON.stringify(act.do), /approve/u);
  }
  assert.equal(approvalHoldContinuation('HELD-1', { ready: true, holds: [] }), null);
  assert.equal(approvalHoldContinuation('HELD-1', { ready: true, holds: [{ owner: 'you-decide' }] }), null);
});
const digest = `sha256:${'e'.repeat(64)}`;

test('every agent command preserves issued path bytes and presents the path rule before material', async () => {
  for (const returned of ['/workspace clone/.git/worktrees/Story Ω/singularity-flow/review.json',
    'C:\\workspace clone\\.git\\worktrees\\Story Ω\\singularity-flow\\review.json',
    '\\\\server\\workspace clone\\.git\\worktrees\\Story Ω\\singularity-flow\\review.json',
    'team/stories/CUSTOM/artifacts/result.md']) {
    const original = { resultType: 'custom-phase', status: 'authoring-entry', repositoryPath: '/different/checkout',
      stagingPath: returned, stagingProtocol: { path: returned }, artifact: { path: returned } };
    const copy = structuredClone(original);
    const view = JSON.parse(await boundedAgentOutput(JSON.stringify(original)));
    assert.equal(view.act.paths, CLI_PATH_REFERENCE);
    assert.equal(Object.keys(view)[0], 'act');
    assert.equal(view.stagingPath, returned);
    assert.equal(view.stagingProtocol.path, returned);
    assert.equal(view.artifact.path, returned);
    assert.deepEqual(original, copy, 'host presentation cannot change paths or bound records');
  }
  const paused = JSON.parse(await boundedAgentOutput(JSON.stringify({ paused: true })));
  assert.equal(paused.act.paths, undefined, 'pause remains native Copilot, without workflow instructions');
});

test('act reads each result by its own fields and never invents a next action', () => {
  assert.equal(agentAct({ paused: true }).state, 'paused');
  assert.equal(agentAct({ resultType: 'session-open', status: 'choose' }).state, 'ask-person');
  assert.equal(agentAct({ resultType: 'session-open', status: 'ready' }).do, null,
    'opening a session never authorizes another skill in the session-only turn');
  assert.deepEqual(agentAct({ resultType: 'sflow-phase-entry', status: 'authoring-entry', phase: 'implementation' }).do, null,
    'authoring is the skill\'s own step, never a next action to relay');
  assert.equal(agentAct({ resultType: 'sflow-phase-entry', status: 'clarification-required' }).state, 'ask-person');
  assert.deepEqual(agentAct({ resultType: 'sflow-phase-entry', status: 'clarification-required' }).read, ['clarification', 'context']);
  // The questions are one stage of the step: the task's own record says the work goes on after them.
  assert.deepEqual(agentAct({ resultType: 'sflow-phase-entry', status: 'clarification-required', authoringProgress: { stage: 'complete-draft' }, taskCompletion: { complete: false } }).read,
    ['clarification', 'context', 'authoringProgress', 'taskCompletion']);
  const prepublish = agentAct({ resultType: 'sflow-phase-prepublish', status: 'ready', commands: { publish: 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host' } });
  assert.equal(prepublish.state, 'publish');
  assert.equal(prepublish.do.shell, 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host');
  assert.ok(prepublish.read.includes('scopeReview'), 'early scope advice is an explicit read, never a fabricated command');
  const scopeAdvice = agentAct({ resultType: 'sflow-phase-prepublish', status: 'ready',
    scopeReview: { status: 'repair-or-human-decision', blocking: false },
    commands: { publish: 'singularity-flow phase publish intake --authored governed-agent --channel copilot-host' } });
  assert.equal(scopeAdvice.state, 'publish', 'an advisory cannot silently become a publication gate');
  assert.equal(scopeAdvice.do.shell, prepublish.do.shell);
  // A prepared scope-owning draft reads its unlinked statements the way authoring-entry reads scopeReview.
  const prepared = (scope) => agentAct({ resultType: 'command-result', operation: { id: 'prepare' }, data: { preparation: { path: 'spec.md', ...(scope ? { scope } : {}) } },
    next: [{ id: 'prepare.author', label: 'Author', command: 'singularity-flow phase prepublish intake', copilotCommand: '/sf-phase', rank: 'NOW', kind: 'workflow' }] });
  assert.deepEqual(prepared({ status: 'repair-or-human-decision', items: [{ id: 'SRI-0123456789ab' }] }).read, ['data.preparation.scope']);
  assert.equal(prepared({ status: 'repair-or-human-decision', items: [] }).do.shell, 'singularity-flow phase prepublish intake', 'the route is unchanged');
  assert.equal(prepared(null).read, undefined, 'nothing to link adds nothing to read');
  assert.equal(agentAct({ resultType: 'sflow-phase-prepublish', status: 'correction-required', findings: [{}, {}] }).state, 'correct');
  assert.deepEqual(agentAct({ resultType: 'sflow-phase-prepublish', status: 'correction-required', findings: [{}, {}] }).read,
    ['findings', 'correction', 'traceabilityRepair', 'repairLoop'], 'every finding\'s choices and repair task are not what a correction needs');
  assert.deepEqual(agentAct({ resultType: 'sflow-phase-entry', status: 'authoring-entry', phase: 'implementation', generatesCode: true }).read.slice(-2), ['recovery.testExecution', 'intent']);
  assert.ok(agentAct({ resultType: 'sflow-phase-entry', status: 'authoring-entry', generatesCode: true, recovery: { requiresRecovery: true } }).read.includes('recovery'));
  assert.deepEqual(agentAct({ resultType: 'sflow-phase-entry', status: 'authoring-entry', phase: 'planning' }).read.includes('intent'), false);
  // What a skill checks or tells the author to follow must be read: every phase skill shares these lists.
  const coding = agentAct({ resultType: 'sflow-phase-entry', status: 'authoring-entry', generatesCode: true, authoring: { policyVerified: true }, upstream: { attention: true },
    clarification: { checkpoint: { newQuestionAction: { command: 'x' } } }, recovery: { blockers: [{ code: 'B' }] } }).read;
  for (const field of ['authoring', 'upstream', 'clarification.checkpoint.newQuestionAction', 'recovery.blockers', 'recovery.testExecution']) assert.ok(coding.includes(field), field);
  assert.equal(agentAct({ resultType: 'sflow-phase-entry', status: 'authoring-entry', upstream: { attention: false } }).read.includes('upstream'), false);
  assert.ok(agentAct({ resultType: 'sflow-phase-entry', status: 'clarification-required', authoring: {}, upstream: { attention: true } }).read.includes('upstream'));
  // A failed test the environment could not run names the approver's route; a finding's repair keeps its facts.
  assert.ok(agentAct({ error: { code: 'E', details: { testRunRisk: { command: 'x' } } }, remediationPlan: { repairContinuation: { revision: 'repair-continuation-v1', currentTurnRepair: true }, steps: [] } }).read.includes('error.details.testRunRisk'));
  const facts = { testExecution: { handoff: { guidance: 'g' } }, planningRepair: { scope: 'current-draft' }, planningEvidenceRepair: { sameTurn: true }, documentation: { status: 'missing' }, evidenceConsistency: { findings: [{ message: 'm' }] } };
  const correcting = agentAct({ resultType: 'sflow-phase-prepublish', status: 'correction-required', findings: [{}], correction: { sameTurn: true }, ...facts }).read;
  for (const field of ['testExecution', 'planningRepair', 'planningEvidenceRepair', 'documentation', 'evidenceConsistency.findings']) assert.ok(correcting.includes(field), field);
  assert.equal(correcting.includes('resolution'), false);
  assert.ok(agentAct({ resultType: 'sflow-phase-prepublish', status: 'blocked', correction: { sameTurn: false, class: 'other' } }).read.includes('resolution'));
  const publishing = agentAct({ resultType: 'sflow-phase-prepublish', status: 'ready', commands: { publish: 'p' }, ...facts }).read;
  for (const field of ['planningEvidenceRepair', 'documentation', 'evidenceConsistency.findings']) assert.ok(publishing.includes(field), field);
  assert.equal(publishing.includes('testExecution'), false);
  assert.deepEqual(agentAct({ resultType: 'sflow-phase-prepublish', status: 'ready', commands: { publish: 'p' }, documentation: { status: 'not-applicable' }, testExecution: { commands: [] } }).read, ['scopeReview']);
  assert.equal(agentAct({ resultType: 'sflow-phase-prepublish', repairLoop: { status: 'escalate', instruction: 'Stop.' } }).state, 'escalate');
  const published = agentAct({ publishIfReady: { published: true, next: { instruction: 'Published. End the reply.', reason: 'Submit it.',
    commandGuidance: { copilotCommand: '/sf-submit', command: 'singularity-flow submit intake --work-id W', modelFreeCommand: null } } } });
  assert.deepEqual(published.do, { reason: 'Submit it.', copilot: '/sf-submit', shell: 'singularity-flow submit intake --work-id W', vscode: null });
  assert.deepEqual(published.read, ['publishIfReady.next', 'publishIfReady.output', 'publishIfReady.review.handoff'], 'the review packet is the person\'s, not this step\'s');
  // A step only a person may author is theirs to publish: publish-if-ready did not, and the agent never does.
  const personal = agentAct({ resultType: 'sflow-phase-prepublish', status: 'ready',
    commands: { publish: 'singularity-flow phase publish charter --authored human --channel manual-in-place' },
    publishIfReady: { published: false, reason: 'person-authored', command: 'singularity-flow phase publish charter --authored human --channel manual-in-place' } });
  assert.equal(personal.state, 'confirm-in-terminal');
  assert.deepEqual([personal.do.shell, personal.do.copilot], ['singularity-flow phase publish charter --authored human --channel manual-in-place', null]);
  assert.match(personal.said, /never run it/u);
  const refused = agentAct({ error: { code: 'X_REFUSED', message: 'No.' }, remediationPlan: { context: { strategy: 'repair-in-place' },
    steps: [{ label: 'Inspect recovery', command: 'singularity-flow recover W --phase p --json' }] } });
  assert.equal(refused.state, 'refused');
  assert.equal(refused.strategy, 'repair-in-place');
  assert.equal(refused.do.shell, 'singularity-flow recover W --phase p --json');
  assert.equal(agentAct({ resultType: 'x', note: 'nothing to do' }).state, 'read');
});

test('an agent is given its own publication route wherever SFlow names a bare, person or external-tool publish', async () => {
  const own = (phase, workId = '') => `singularity-flow phase prepublish ${phase}${workId ? ` --work-id ${workId}` : ''} --for-agent --json --publish-if-ready`;
  // SFlow's own bare routes: continuation, recovery, evidence reuse (with its Work ID) and the
  // changed-after-publication refusal. Followed as given, each was refused and cost a round trip.
  assert.equal(agentAct({ continuation: { nextAction: { command: 'singularity-flow phase publish intake', reason: 'Publish a generation.' } } }).do.shell, own('intake'));
  const recovery = agentAct({ next: [{ command: 'singularity-flow phase publish code', skill: '/sf-publish', timing: 'now', reason: 'Publish the edited draft.' }] });
  assert.deepEqual([recovery.do.shell, recovery.do.copilot, recovery.do.vscode], [own('code'), '/sf-phase', null]);
  assert.equal(agentAct({ nextAction: { command: 'singularity-flow phase publish verify --work-id W-1', reason: 'Fresh recorded run.' } }).do.shell, own('verify', 'W-1'));
  const changed = { error: { code: 'ARTIFACT_AUTHORED_BYTES_CHANGED_AFTER_PUBLICATION', message: 'Changed after publication.' },
    remediationPlan: { steps: [{ label: 'Publish it as the next generation', command: 'singularity-flow phase publish intake' }] } };
  assert.equal(agentAct(changed).do.shell, own('intake'));
  // A person's authorship (the no-model fallback), an external tool's or a manual channel is never the agent's to run.
  for (const command of ['singularity-flow phase publish intake --authored human --channel manual-in-place --no-model',
    'singularity-flow phase publish intake --authored external-tool --channel external-tool',
    'singularity-flow phase publish intake --authored external-tool --channel external-tool --from out/intake.md',
    'singularity-flow phase publish intake --authored governed-agent --channel manual-in-place']) {
    assert.equal(agentAct({ nextAction: { command, reason: 'Publish.' } }).do.shell, own('intake'), command);
  }
  const tool = 'singularity-flow phase publish intake --authored external-tool --channel external-tool';
  assert.deepEqual([agentAct({ resultType: 'sflow-phase-prepublish', status: 'ready', commands: { publish: tool } }).do.shell], [own('intake')]);
  // The agent's own authorship and the kernel's run as given.
  for (const command of ['singularity-flow phase publish intake --authored governed-agent --channel copilot-host --no-model',
    'singularity-flow phase publish convergence --authored deterministic --channel kernel-generator']) {
    assert.equal(agentAct({ nextAction: { command, reason: 'Publish.' } }).do.shell, command, command);
  }
  // A genuine external tool's output stays the person's exact route, run in their own terminal.
  const person = agentAct({ resultType: 'sflow-phase-prepublish', status: 'ready', commands: { publish: tool },
    publishIfReady: { published: false, reason: 'person-authored', command: tool } });
  assert.deepEqual([person.state, person.do.shell, person.do.copilot], ['confirm-in-terminal', tool, null]);
  // Only the route the agent runs changes: the result's own fields, which a person reads, keep their command.
  const relayed = await withAgentRoutes(changed);
  assert.equal(relayed.remediationPlan.steps[0].command, 'singularity-flow phase publish intake');
});

test('a returned confirmation becomes an ask with its exact value, and its Copilot route carries it', () => {
  const act = agentAct({ classification: 'convergence-advance-required', reason: 'Review it.',
    nextCommand: `singularity-flow story advance --work-id W --confirm ${digest}`, nextSkill: '/sf-submit' });
  assert.equal(act.state, 'confirm');
  assert.equal(act.ask.value, digest);
  assert.match(act.ask.how, /ask the person in this chat, and only on an explicit yes run do\.shell once/u);
  assert.ok(act.do.copilot.includes(digest), act.do.copilot);
});

test('document handoff asks for files, never requirements again, and reports restore without claiming advancement', () => {
  const readiness = { resultType: 'document-readiness', status: 'upload-required', missing: [{ id: 'DOC-001' }] };
  const direct = agentAct(readiness);
  assert.equal(direct.state, 'ask-person');
  assert.deepEqual(direct.read, ['missing', 'instruction']);
  for (const resultType of ['sflow-phase-entry', 'source-review-agent-context', 'source-review-status']) {
    const act = agentAct({ resultType, documentReadiness: readiness });
    assert.equal(act.state, 'ask-person');
    assert.equal(act.do, null);
    assert.match(act.said, /do not recreate the Story/);
  }
  const restored = agentAct({ resultType: 'document-restored', documentId: 'DOC-001',
    next: [{ command: 'singularity-flow phase enter implementation --work-id HANDOFF --compose --for-agent --json' }] });
  assert.match(restored.said, /No Story phase, approval or Git ref changed/);
  assert.match(restored.do.shell, /phase enter implementation/);
});

test('source-review checks distinguish packet repair from retaining genuine reviewer findings', () => {
  assert.equal(agentAct({ resultType: 'source-review-agent-context', canReview: true }).state, 'review');
  const invalid = agentAct({ resultType: 'source-review-check', retentionReady: false,
    repair: { status: 'repair-packet' }, findings: [{ code: 'citation-line-invalid', field: 'rows[0]' }] });
  assert.equal(invalid.state, 'correct');
  assert.equal(invalid.do, null, 'do not recheck unchanged bytes automatically');
  assert.ok(invalid.read.includes('repair'));
  const refused = agentAct({ error: { code: 'SOURCE_REVIEW_REPORT_INVALID', details: {
    repair: { status: 'repair-packet' } } }, remediationPlan: { steps: [{ command: 'singularity-flow doctor --json' }] } });
  assert.equal(refused.state, 'correct');
  assert.equal(refused.do, null, 'stage refusal cannot replace packet correction with generic diagnostics');
  assert.ok(refused.read.includes('error.details.repair'));
  const valid = agentAct({ resultType: 'source-review-check', retentionReady: true,
    status: 'correction-required', continuation: { nextAction: {
      command: 'singularity-flow review-source submit specification --report-file /private/review.json --json', skill: '/sf-review-source'
    } } });
  assert.equal(valid.state, 'retain');
  assert.match(valid.do.copilot, /^\/sf-review-source submit specification/u);
  assert.match(valid.said, /not approval/u);
  const mapping = agentAct({ resultType: 'source-review-check', retentionReady: true,
    repair: { mappingTasks: [{ code: 'scenario-unmapped', scenarioId: 'S2' }] } });
  assert.equal(mapping.state, 'review');
  assert.equal(mapping.do, null, 'a missing reviewer row needs assessment before automatic retain/author handoff');
  assert.match(mapping.said, /otherwise retain reviewed genuine gaps/u);
  const stale = agentAct({ resultType: 'source-review-check', retentionReady: false,
    repair: { status: 'reload-context', instruction: 'Inputs changed.' }, continuation: { nextAction: {
      command: 'singularity-flow review-source context specification --json', skill: '/sf-review-source'
    } } });
  assert.equal(stale.state, 'next');
  assert.match(stale.do.shell, /context specification/u);
});

test('review check accepts output-only agent shaping without relaxing review context or mutations', async () => {
  const { interpretsForAgent } = await import('../src/cli-json-output.mjs');
  assert.equal(interpretsForAgent(['review-source', 'check']), false);
  for (const action of ['context', 'stage', 'submit', 'decide']) assert.equal(interpretsForAgent(['review-source', action]), true);
  const result = await withAgentRoutes({ next: [{
    command: 'singularity-flow review-source check custom-scope --report-file /private/report.json --json'
  }] });
  assert.equal(result.next[0].command, 'singularity-flow review-source check custom-scope --report-file /private/report.json --for-agent --json');
});

test('even short pinned review sources get exact line-readable files, not JSON line-number citations', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-review-source-lines-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const source = '# Converter\r\nAdd a converter.\r\n\r\nProvide screenshot and testcases.\r\n';
  const result = { resultType: 'source-review-agent-context', workId: 'CONVERTER', canReview: true,
    sources: [{ id: 'story', path: 'USER-STORY.md', text: source }] };
  const output = await boundedAgentOutput(JSON.stringify(result), { cwd: root });
  assert.ok(Buffer.byteLength(output) <= DEFAULT_AGENT_OUTPUT_BYTES);
  const view = JSON.parse(output);
  assert.equal(view.act.state, 'review');
  const full = JSON.parse(await readFile(view.agentOutput.path, 'utf8'));
  const sourceFile = full.sources[0].text;
  assert.equal(await readFile(sourceFile.textFile, 'utf8'), source, 'do not normalize or prefix pinned bytes');
  assert.equal(sourceFile.lines, 4, 'its last newline ends line 4 and starts no fifth');
  assert.ok(path.relative(await realpath(root), sourceFile.textFile).startsWith(path.join('.sflow', 'out', 'source-review-agent-context-')));
  assert.ok(view.omittedFields.find(entry => entry.field === 'sources').textFiles[0].path === sourceFile.textFile);
});

test('a composed step reads its result whole; only the command a person or agent ran is bounded', () => {
  assert.equal(agentOutputGoverned({}), true);
  assert.equal(agentOutputGoverned({ SINGULARITY_FLOW_AGENT_OUTPUT: 'raw' }), false);
  assert.equal(agentOutputGoverned({ SINGULARITY_FLOW_AGENT_OUTPUT: 'full' }), false);
  globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH = 1;
  try { assert.equal(agentOutputGoverned({}), false); }
  finally { globalThis.__SINGULARITY_FLOW_CLI_STEP_DEPTH = 0; }
});

test('a command whose action a person reviewed at the terminal reaches that person whole [OUT:REQ-014]', () => {
  // workflow author submit --json writes a review card, asks the person, then its result: the
  // literal envelope must not stand between them and it (wca-submission's terminal routes).
  globalThis.__SINGULARITY_FLOW_PERSON_AT_TERMINAL = true;
  try { assert.equal(agentOutputGoverned({}), false); }
  finally { delete globalThis.__SINGULARITY_FLOW_PERSON_AT_TERMINAL; }
  assert.equal(agentOutputGoverned({}), true);
});

test('a small result keeps every field with act first; a large one is written whole and its view fits', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-output-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const small = JSON.parse(await boundedAgentOutput(JSON.stringify({ resultType: 'x', status: 'ok', repositoryPath: root }), { cwd: root }));
  assert.deepEqual(Object.keys(small), ['act', 'resultType', 'status', 'repositoryPath']);

  const prose = Array.from({ length: 900 }, (_, index) => `Line ${index} of the composed context.`).join('\n');
  const large = { resultType: 'sflow-phase-entry', status: 'clarification-required', repositoryPath: root, workId: 'W',
    clarification: { checkpoint: { stage: 'derive-questions', instruction: 'Ask.' } },
    recovery: { blockers: Array.from({ length: 60 }, (_, index) => ({ id: index, detail: 'x'.repeat(120) })) },
    context: { text: prose, file: { path: 'singularity/work-items/W/context/prompts/p-gen1.md' } } };
  const text = await boundedAgentOutput(JSON.stringify(large), { cwd: root });
  assert.ok(Buffer.byteLength(text) <= DEFAULT_AGENT_OUTPUT_BYTES, `${Buffer.byteLength(text)} bytes`);
  const view = JSON.parse(text);
  assert.deepEqual(Object.keys(view).slice(0, 3), ['act', 'agentOutput', 'omittedFields']);
  assert.equal(view.act.state, 'ask-person');
  assert.equal(view.act.complete, false);
  assert.equal(view.act.paths, CLI_PATH_REFERENCE, 'the rule is named even when phase instructions are externalized');
  assert.deepEqual(view.clarification, large.clarification, 'the field act reads stays in the view');
  assert.equal(view.workId, 'W', 'small fields stay');
  // The complete result lives in the checkout's excluded output folder, readable by line range,
  // under a short name: its kind and eight hex digits.
  assert.match(view.agentOutput.relativePath, /^\.sflow\/out\/phase-entry-[0-9a-f]{8}\.json$/u);
  assert.equal(view.agentOutput.path, path.join(await realpath(root), '.sflow', 'out', path.basename(view.agentOutput.relativePath)));
  assert.equal(spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).stdout, '', 'nothing SFlow wrote shows as a change');
  const lines = (await readFile(view.agentOutput.path, 'utf8')).split('\n');
  const recovery = view.omittedFields.find((entry) => entry.field === 'recovery');
  const held = (recovery.read ?? [recovery.lines]).flatMap(([start, end]) => lines.slice(start - 1, end));
  const slice = held.join('\n').replace(/^"recovery": /u, '').replace(/,$/u, '');
  assert.deepEqual(JSON.parse(slice), large.recovery, 'the named line ranges are exactly the omitted field');
  const context = view.omittedFields.find((entry) => entry.field === 'context');
  assert.equal(await readFile(context.textFiles[0].path, 'utf8'), prose, 'a long text is its own line-readable file, byte for byte');
});

/** The fields a set of line ranges holds, parsed back from the file. */
async function fieldsIn(file, ranges) {
  const lines = (await readFile(file, 'utf8')).split('\n');
  const body = ranges.map(({ lines: [start, end] }) => lines.slice(start - 1, end).join('\n')).join('\n').replace(/,\s*$/u, '');
  return JSON.parse(`{\n${body}\n}`);
}

test('the fields a view leaves out are written first and together, and named as one read', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-read-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const large = { resultType: 'sflow-phase-entry', status: 'clarification-required', repositoryPath: root, workId: 'W',
    // Sized so the fields left out fit one read (READ_CHUNK_BYTES) while the whole result does not fit the view.
    notes: Array.from({ length: 30 }, (_, index) => `Note ${index}: ${'n'.repeat(60)}`),
    clarification: { checkpoint: { stage: 'derive-questions', instruction: 'Ask.' } },
    recovery: { blockers: Array.from({ length: 35 }, (_, index) => ({ id: index, detail: 'x'.repeat(80) })) },
    context: { text: Array.from({ length: 900 }, (_, index) => `Line ${index}.`).join('\n') } };
  const text = await boundedAgentOutput(JSON.stringify(large), { cwd: root });
  assert.ok(Buffer.byteLength(text) <= DEFAULT_AGENT_OUTPUT_BYTES, `${Buffer.byteLength(text)} bytes`);
  const view = JSON.parse(text);
  const omitted = view.omittedFields.map((entry) => entry.field);
  assert.ok(omitted.length >= 2, omitted.join(', '));
  // act reads context, so it is first; the rest follow in the result's own order.
  assert.equal(omitted[0], 'context');
  assert.deepEqual(view.agentOutput.read.length, 1, 'one read holds what act names');
  assert.equal(view.agentOutput.read[0].lines[0], 2, 'the fields left out start the file');
  assert.ok(view.agentOutput.read[0].bytes <= READ_CHUNK_BYTES);
  const read = await fieldsIn(view.agentOutput.path, view.agentOutput.read);
  assert.deepEqual(Object.keys(read), ['context'], 'only the field left out that act names');
  const full = JSON.parse(await readFile(view.agentOutput.path, 'utf8'));
  assert.deepEqual(read.context, full.context);
  assert.match(view.agentOutput.instruction, /in one response/u);
  assert.match(view.agentOutput.instruction, /the other omittedFields are optional/u);
  // The rest is still listed, at lines that hold it whole.
  const recovery = view.omittedFields.find((entry) => entry.field === 'recovery');
  const lines = (await readFile(view.agentOutput.path, 'utf8')).split('\n');
  assert.deepEqual(JSON.parse(lines.slice(recovery.lines[0] - 1, recovery.lines[1]).join('\n').replace(/^"recovery": /u, '').replace(/,$/u, '')), large.recovery);
  assert.equal(recovery.read, undefined, 'its own ranges would invite a second read');
});

test('large fields left out become a few ranges of whole fields, each within one read', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-chunks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const rows = (label, count) => Array.from({ length: count }, (_, index) => ({ id: `${label}-${index}`, detail: 'y'.repeat(150) }));
  // authoring-entry reads mutationContract: it is read first although the result lists it last.
  const large = { resultType: 'sflow-phase-entry', status: 'authoring-entry', repositoryPath: root, workId: 'W',
    history: rows('history', 160), evidence: rows('evidence', 90), extra: rows('extra', 400), mutationContract: { rules: rows('rule', 120) } };
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(large), { cwd: root }));
  const { read } = view.agentOutput;
  assert.ok(read.length >= 2 && read.length <= READ_PLAN_CHUNKS, JSON.stringify(read));
  for (const [index, range] of read.entries()) {
    assert.ok(range.bytes <= READ_CHUNK_BYTES, JSON.stringify(range));
    if (index) assert.equal(range.lines[0], read[index - 1].lines[1] + 1, 'consecutive ranges');
  }
  const lines = (await readFile(view.agentOutput.path, 'utf8')).split('\n');
  assert.match(lines[read[0].lines[0] - 1], /^"mutationContract":/u, 'what act reads comes first');
  // A field larger than a read is split at line boundaries; what act does not name is not planned.
  const reached = read.at(-1).lines[1];
  const extra = view.omittedFields.find((entry) => entry.field === 'extra');
  assert.ok(extra.read[0][0] > reached, 'a field act does not name stays out of the plan');
  assert.equal(extra.lines, undefined, 'and names ranges that fit, not all its lines at once');
  const planned = view.omittedFields.find((entry) => entry.field === 'mutationContract');
  assert.equal(planned.readBy, 'agentOutput.read', 'a field the plan holds names the plan');
  assert.equal(planned.lines ?? planned.read, undefined, 'and no range of its own to read twice');
  assert.match(lines[reached], /^"history":/u, 'the plan ends where the field does');
});

test('a long text file is named as ranges the file tool shows whole, to request in the same response', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-text-ranges-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const prompt = Array.from({ length: 700 }, (_, index) => `Line ${index} of the composed phase prompt, with its rules.`).join('\n');
  const result = { resultType: 'sflow-phase-entry', status: 'authoring-entry', repositoryPath: root, workId: 'W', context: { text: prompt } };
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(result), { cwd: root }));
  const [text] = view.omittedFields.find((entry) => entry.field === 'context').textFiles;
  assert.ok(text.bytes > READ_CHUNK_BYTES, `${text.bytes} bytes`);
  const lines = (await readFile(text.path, 'utf8')).split('\n');
  assert.deepEqual(text.read[0][0], 1);
  assert.equal(text.read.at(-1)[1], 700, 'the ranges cover the whole text');
  for (const [index, [start, end]] of text.read.entries()) {
    assert.ok(Buffer.byteLength(lines.slice(start - 1, end).join('\n')) <= READ_CHUNK_BYTES, `range ${start}-${end}`);
    if (index) assert.equal(start, text.read[index - 1][1] + 1, 'consecutive ranges');
  }
  assert.equal(text.need, true, 'act names context, so its file is marked to read');
  assert.match(view.agentOutput.instruction, /every textFiles entry marked need, by its own read ranges exactly as listed/u);
});

// Copilot 1.0.100 in VS Code (2026-10-27) showed at most 8,193 bytes of a read before "Output truncated"
// and refused an 8,909-byte file whole; a source review whose specification text never came through
// ended without reviewing. Every read SFlow names must fit under that.
test('a source review\'s reads all fit what the host file tool shows in one read', async (t) => {
  assert.ok(READ_CHUNK_BYTES <= 7_000 && READ_CHUNK_BYTES * READ_PLAN_CHUNKS >= 64_000, `${READ_CHUNK_BYTES} x ${READ_PLAN_CHUNKS}`);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-review-reads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const paragraph = (label, count) => Array.from({ length: count }, (_, index) => `${label} line ${index}: the clause, its scenario and the test that proves it.`).join('\n');
  const result = { resultType: 'source-review-agent-context', canReview: true, ready: true, repositoryPath: root, workId: 'W', phase: 'specification',
    reviewGuide: { role: 'Do the whole review now.', next: 'Start from reportTemplate.' },
    reviewer: { effectiveInstructions: paragraph('Reviewer rule', 140) },
    sources: [{ id: 'story', path: 'USER-STORY.md', text: '# Story\n\nPlot a graph.\n' }],
    artifact: { path: 'spec.md', text: paragraph('Specification', 125) },
    reportTemplate: { binding: { workId: 'W', phase: 'specification', generation: 1 }, rows: Array.from({ length: 120 }, (_, index) => ({ clauseId: `REQ-${index}`, status: 'unreviewed' })) },
    stagingProtocol: { path: path.join(root, 'review.json') }, stagingPath: path.join(root, 'review.json') };
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(result), { cwd: root }));
  assert.match(view.act.said, /Reading and summarising is not the review: end only after the filled report is staged and checked/u);
  const file = (await readFile(view.agentOutput.path, 'utf8')).split('\n');
  for (const { lines: [start, end] } of view.agentOutput.read) {
    assert.ok(Buffer.byteLength(file.slice(start - 1, end).join('\n')) <= READ_CHUNK_BYTES, `result range ${start}-${end}`);
  }
  const texts = view.omittedFields.flatMap((entry) => entry.textFiles ?? []);
  for (const field of ['artifact.text', 'reviewer.effectiveInstructions']) {
    const text = texts.find((entry) => entry.field === field);
    assert.ok(text.bytes > 8_000 && text.read?.length >= 2, `${field}: ${text.bytes} bytes must come as ranges`);
    const lines = (await readFile(text.path, 'utf8')).split('\n');
    for (const [start, end] of text.read) assert.ok(Buffer.byteLength(lines.slice(start - 1, end).join('\n')) <= READ_CHUNK_BYTES, `${field} ${start}-${end}`);
  }
  const story = texts.find((entry) => entry.field === 'sources.0.text');
  assert.equal(story.read, undefined, 'a short source is read whole');
});

test('omitted pretty JSON fields advertise safe field-specific reads and actual disk bytes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-schema-reads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const reportSchema = { type: 'object', properties: Object.fromEntries(Array.from({ length: 95 }, (_, i) =>
    [`field${i}`, { type: 'string', minLength: 1, maxLength: 128 }])) };
  assert.ok(Buffer.byteLength(JSON.stringify(reportSchema)) < READ_CHUNK_BYTES, 'compact value misleadingly fits one read');
  const result = { resultType: 'source-review-agent-context', canReview: true, ready: true, repositoryPath: root,
    sources: [{ id: 'story', text: 'Keep the pinned source.' }], reportSchema,
    artifact: { text: 'Authored artifact.\n'.repeat(500) } };
  const output = await boundedAgentOutput(JSON.stringify(result), { cwd: root });
  assert.ok(Buffer.byteLength(output) <= DEFAULT_AGENT_OUTPUT_BYTES);
  const view = JSON.parse(output);
  const reference = view.omittedFields.find(field => field.field === 'reportSchema');
  const lines = (await readFile(view.agentOutput.path, 'utf8')).split('\n');
  const range = lines.slice(reference.lines[0] - 1, reference.lines[1]).join('\n') + '\n';
  assert.equal(reference.bytes, Buffer.byteLength(range));
  assert.equal(reference.read, undefined, 'the read plan holds it; a list of its own got one result read twice');
  const planned = view.agentOutput.read.filter(({ lines: [start, end] }) => start <= reference.lines[1] && end >= reference.lines[0]);
  assert.ok(planned.length >= 1 && planned[0].lines[0] <= reference.lines[0] && planned.at(-1).lines[1] >= reference.lines[1], JSON.stringify(view.agentOutput.read));
  for (const { lines: [start, end] } of planned) assert.ok(Buffer.byteLength(lines.slice(start - 1, end).join('\n')) <= READ_CHUNK_BYTES);
  assert.deepEqual(completeAgentResult(view).reportSchema, reportSchema);
});

test('review document bodies and text given elsewhere become reference files outside the reads, restored whole', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-references-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const body = (label) => Array.from({ length: 80 }, (_, index) => `${label} line ${index}: the authored requirement text.`).join('\n');
  const rule = 'Run the declared local checks before publishing; '.repeat(16);
  const document = (id, content) => ({ id, path: `singularity/work-items/W/artifacts/${id}.md`, sha256: 'a'.repeat(64), size: Buffer.byteLength(content), content });
  const result = { resultType: 'x', status: 'ready', repositoryPath: root, workId: 'W', summary: rule,
    publishIfReady: { published: true, command: 'singularity-flow publish intake --json',
      review: { displayBinding: `sha256:${'b'.repeat(64)}`, documents: [document('intake', body('Intake')), document('brief', 'Short brief.')] } },
    guidance: { protocol: rule, extended: `${'Context first. '.repeat(50)}${rule}`, steps: Array.from({ length: 60 }, (_, index) => `Step ${index}: ${'s'.repeat(100)}`) },
    history: Array.from({ length: 120 }, (_, index) => ({ id: index, note: 'z'.repeat(80) })) };
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(result), { cwd: root }));
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= DEFAULT_AGENT_OUTPUT_BYTES);
  const file = JSON.parse(await readFile(view.agentOutput.path, 'utf8'));
  const [intake, brief] = file.publishIfReady.review.documents;
  assert.match(intake.content.referenceOf, /^document body: the person reviews it outside the chat/u);
  assert.equal(await readFile(intake.content.textFile, 'utf8'), result.publishIfReady.review.documents[0].content, 'the body file is exact');
  assert.equal(brief.content, 'Short brief.', 'a short body stays inline');
  assert.equal(file.publishIfReady.review.displayBinding, result.publishIfReady.review.displayBinding, 'bindings are untouched');
  // The kept summary already shows the rule; the longer guidance text holds the protocol.
  assert.equal(view.summary, rule);
  assert.equal(file.guidance.protocol.referenceOf, 'same text as summary');
  const listed = view.omittedFields.flatMap((entry) => entry.textFiles ?? []).map((entry) => entry.path);
  assert.ok(!listed.includes(intake.content.textFile) && !listed.includes(file.guidance.protocol.textFile), 'references are not in the files to read');
  const read = await fieldsIn(view.agentOutput.path, view.agentOutput.read);
  assert.doesNotMatch(JSON.stringify(read), /authored requirement text/u, 'no body inside the read ranges');
  assert.deepEqual(completeAgentResult(view), { act: completeAgentResult(view).act, ...result }, 'the complete result is restored exactly');
});

test('a long text held by a longer one the agent reads is a reference; a lone copy stays', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-held-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const protocol = 'Use only the exact issued staging path and run the declared checks. '.repeat(12);
  const result = { resultType: 'x', repositoryPath: root, workId: 'W',
    contract: { toolProtocol: { guidance: protocol }, rules: Array.from({ length: 60 }, (_, index) => `Rule ${index}: ${'r'.repeat(100)}`) },
    context: { text: `# Phase prompt\n\n${'Write the plan. '.repeat(400)}\n\n# Runtime protocol\n\n${protocol}\n` },
    unique: { note: 'Only here. '.repeat(80) },
    filler: Array.from({ length: 80 }, (_, index) => ({ id: index, note: 'q'.repeat(90) })) };
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(result), { cwd: root }));
  const file = JSON.parse(await readFile(view.agentOutput.path, 'utf8'));
  assert.equal(file.contract.toolProtocol.guidance.referenceOf, 'same text as context.text');
  assert.equal(typeof file.unique.note, 'string', 'text found nowhere else stays inline');
  assert.ok(view.omittedFields.find((entry) => entry.field === 'context').textFiles.length, 'the holder is still read');
  assert.deepEqual(completeAgentResult(view).contract, result.contract);
});

test('the CLI bounds a real phase entry, and the bytes it leaves out are in the file it names', slowLane({ timeout: 300_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-output-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Agent Tester',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Agent Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'agent.tester@example.invalid' };
  delete env.SINGULARITY_FLOW_AGENT_OUTPUT;
  const run = (args, extra = {}) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  must('git', ['init', '-q', '-b', 'main', root], base);
  // Publication intentionally drops process-only Git config overrides. Use a real fixture-local
  // identity, as a repository would, rather than inheriting this machine's global Git identity.
  must('git', ['config', 'user.name', 'Agent Tester']);
  must('git', ['config', 'user.email', 'agent.tester@example.invalid']);
  await writeFile(path.join(root, 'README.md'), '# Agent output\n');
  must(process.execPath, [cli, '--no-model', 'init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']);
  must('git', ['commit', '-q', '-m', 'Agent output fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]);
  must('git', ['push', '-q', '-u', 'origin', 'main']);
  must(process.execPath, [cli, '--no-model', 'start', 'OUT-1', '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Bound the entry', '--description', 'Agents read act first.']);

  const bounded = run(['phase', 'enter', '--compose', '--for-agent', '--json']);
  assert.equal(bounded.status, 0, bounded.stderr);
  assert.ok(Buffer.byteLength(bounded.stdout) <= DEFAULT_AGENT_OUTPUT_BYTES, `${Buffer.byteLength(bounded.stdout)} bytes`);
  const view = JSON.parse(bounded.stdout);
  assert.equal(Object.keys(view)[0], 'act');
  assert.equal(view.act.state, 'ask-person');
  // The checkpoint act points at is in the view, or exactly at the line range the view names.
  const named = view.omittedFields.find((entry) => entry.field === 'clarification');
  const clarification = view.clarification ?? JSON.parse((await readFile(view.agentOutput.path, 'utf8')).split('\n')
    .slice(named.lines[0] - 1, named.lines[1]).join('\n').replace(/^"clarification": /u, '').replace(/,$/u, ''));
  assert.ok(clarification.checkpoint, 'the checkpoint act points at is in the view or at its named range');
  // One read holds the fields it left out, from the top of the file.
  assert.ok(view.agentOutput.read?.length >= 1 && view.agentOutput.read[0].lines[0] === 2, JSON.stringify(view.agentOutput.read));
  const first = view.omittedFields[0];
  assert.deepEqual(first.lines.slice(0, 1), [2], 'the first field left out starts the file');
  const context = view.omittedFields.find((entry) => entry.field === 'context');
  const whole = JSON.parse(run(['phase', 'enter', '--compose', '--for-agent', '--json'], { SINGULARITY_FLOW_AGENT_OUTPUT: 'full' }).stdout);
  assert.equal(await readFile(context.textFiles[0].path, 'utf8'), whole.context.text, 'the composed context is complete in its file');
  // The composition records its own prompt; the bounded result, in the checkout's excluded
  // output folder, adds nothing Git sees.
  const changed = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
  assert.ok(changed.every((line) => line.startsWith('?? singularity/work-items/OUT-1/context/')), changed.join('\n'));
  assert.match(view.agentOutput.relativePath, /^\.sflow\/out\/phase-entry-[0-9a-f]{8}\.json$/u);
});

test('the same actionable result a third time in a row says it is a loop and names what changes it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-loop-'));
  const previous = process.env.SINGULARITY_FLOW_FINDING_STREAKS;
  process.env.SINGULARITY_FLOW_FINDING_STREAKS = path.join(root, 'streaks');
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_FINDING_STREAKS;
    else process.env.SINGULARITY_FLOW_FINDING_STREAKS = previous;
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const now = Date.parse('2026-10-15T12:00:00Z');
  // The Convergence preview the person kept following without confirming: readiness returns the
  // preview, and only the preview's own route carries the digest.
  const preview = { resultType: 'sflow-submission-readiness', workId: 'W', phaseId: 'convergence', head: 'h0',
    classification: 'convergence-advance-required', nextCommand: 'singularity-flow story advance --work-id W', nextSkill: '/sf-submit' };
  const previews = [1, 2, 3].map((minute) => observeAgentLoop(root, preview, agentAct(preview), { now: now - 30 * 60_000 + minute * 60_000 }));
  assert.equal(previews[2].state, 'confirm-review');
  assert.match(previews[2].loop.instruction, /Run do\.shell once to show the digest, then ask the person now in this chat to confirm it; only on an explicit yes run the returned --confirm command once\./u);
  const review = { ...preview, head: 'h1', nextCommand: `singularity-flow story advance --work-id W --confirm ${digest}` };
  const seen = [1, 2, 3].map((minute) => observeAgentLoop(root, review, agentAct(review), { now: now + minute * 60_000 }));
  assert.equal(seen[1].loop, undefined);
  assert.equal(seen[2].loop.repeated, LOOP_THRESHOLD);
  assert.match(seen[2].loop.instruction, /Ask them now in this chat to confirm the exact value; only on an explicit yes run do\.shell once\. Do not offer the preview again\./u);
  assert.match(seen[2].said, /^Repeated 3 times: /u);
  // A change of head is progress, not a repeat; nor is a result two hours later.
  assert.equal(observeAgentLoop(root, { ...review, head: 'h2' }, agentAct(review), { now: now + 4 * 60_000 }).loop, undefined);
  assert.equal(observeAgentLoop(root, { ...review, head: 'h2' }, agentAct(review), { now: now + 5 * 60_000 }).loop, undefined);
  assert.equal(observeAgentLoop(root, { ...review, head: 'h2' }, agentAct(review), { now: now + 4 * 60 * 60_000 }).loop, undefined);
  // Authoring and plain reads are never counted, however often they repeat.
  const authoring = { resultType: 'sflow-phase-entry', status: 'authoring-entry', workId: 'W', phase: 'code' };
  for (let index = 0; index < 4; index += 1) assert.equal(observeAgentLoop(root, authoring, agentAct(authoring)).loop, undefined);
});

test('the pause read every skill starts with is never an action, however often it repeats', async (t) => {
  // Live Copilot run 2026-10-18: the third `pause status --json` in a terminal came back
  // "Repeated 3 times … Do act.do now", act.do being `pause on`, and Copilot asked to pause SFlow.
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-pause-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1',
    SINGULARITY_FLOW_FINDING_STREAKS: path.join(base, 'streaks'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json') };
  assert.equal(spawnSync('git', ['init', '-q', path.join(base, 'repo')]).status, 0);
  const status = () => {
    const result = spawnSync(process.execPath, [cli, 'pause', 'status', '--for-agent', '--json'], { cwd: path.join(base, 'repo'), env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  for (let index = 0; index < LOOP_THRESHOLD + 1; index += 1) {
    const { act, next, data } = status();
    assert.equal(data.paused, false);
    assert.equal(next[0].kind, 'informational', 'the offer to pause stays in next for the person');
    assert.deepEqual([act.state, act.do, act.loop], ['read', null, undefined], `call ${index + 1}: ${JSON.stringify(act)}`);
    assert.equal(act.said, data.agentInstruction);
  }
  await writeFile(env.SINGULARITY_FLOW_COPILOT_MODE_FILE, JSON.stringify({ schemaVersion: 1, paused: true, changedAt: '2026-10-18T00:00:00.000Z' }));
  for (let index = 0; index < LOOP_THRESHOLD + 1; index += 1) {
    const { act } = status();
    assert.deepEqual([act.state, act.do, act.loop], ['paused', null, undefined], 'a paused SFlow is never resumed for the person');
  }
  // Any other informational offer is not the one thing to do now either.
  const offered = agentAct({ resultType: 'command-result', next: [{ label: 'Read it', command: 'singularity-flow explain x', kind: 'informational' }] });
  assert.deepEqual([offered.state, offered.do], ['read', null]);
});

test('JSON written to a terminal is an agent view; JSON read through a pipe or file stays whole', async () => {
  const { agentViewRequested } = await import('../src/cli-json-output.mjs');
  const terminal = { isTTY: true }, pipe = { isTTY: false };
  // A host agent runs commands in a terminal and saved a long /sf-session result where it could not read it.
  assert.equal(agentViewRequested({ json: true }, { stream: terminal, env: {} }), true);
  assert.equal(agentViewRequested({ json: true }, { stream: pipe, env: {} }), false, 'VS Code, scripts and tests read through pipes');
  assert.equal(agentViewRequested({ 'for-agent': true, json: true }, { stream: pipe, env: {} }), true, '--for-agent asks for it anywhere');
  assert.equal(agentViewRequested({ json: true }, { stream: terminal, env: { SINGULARITY_FLOW_AGENT_OUTPUT: 'full' } }), false);
  assert.equal(agentViewRequested({}, { stream: terminal, env: {} }), false, 'human text output is unchanged');
});

test('the default view fits inline in the host, which saves 8,192 characters and more to a file', () => {
  // Copilot CLI saves a shell result of 8,192+ characters outside the workspace with a 500-character
  // preview; a session turn may not read that copy. Leave room for the stderr lines in the same result.
  assert.ok(DEFAULT_AGENT_OUTPUT_BYTES <= 7_500, `${DEFAULT_AGENT_OUTPUT_BYTES} bytes`);
});

test('the bound has no gaps: literal output, no repository, many omitted fields and platform routes [OUT:REQ-014]', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-bound-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-unkept-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const fits = (value) => assert.ok(Buffer.byteLength(value) <= DEFAULT_AGENT_OUTPUT_BYTES, `${Buffer.byteLength(value)} bytes`);

  // Output that is not one JSON object: unchanged when it fits, else kept whole behind a literal envelope.
  assert.equal(await boundedAgentOutput('[1,2]', { cwd: root }), '[1,2]');
  const array = JSON.stringify(Array.from({ length: 2000 }, (_, index) => ({ index, text: 'x'.repeat(20) })), null, 2);
  const arrayView = await boundedAgentOutput(array, { cwd: root });
  fits(arrayView);
  const literal = JSON.parse(arrayView);
  assert.deepEqual([literal.act.state, literal.agentOutput.literal, literal.agentOutput.complete], ['read', 'json-array', false]);
  assert.equal(await readFile(literal.agentOutput.path, 'utf8'), array, 'kept byte for byte');
  assert.ok(literal.agentOutput.read.length > 0 && array.startsWith(literal.preview) && literal.preview.length > 0);
  const malformed = `{"partial": true}\n${'not json\n'.repeat(3000)}`;
  assert.equal(JSON.parse(await boundedAgentOutput(malformed, { cwd: root })).agentOutput.literal, 'not-json');

  // No repository to keep the result in: the view still fits and names what it does not show.
  const big = { resultType: 'x', status: 'ok', workId: 'W', blob: 'y'.repeat(20_000), other: 'z'.repeat(9_000) };
  const unkeptView = await boundedAgentOutput(JSON.stringify(big), { cwd: outside });
  fits(unkeptView);
  const unkept = JSON.parse(unkeptView);
  assert.deepEqual([unkept.agentOutput.retained, unkept.agentOutput.state, unkept.agentOutput.path], [false, 'detail-unavailable', undefined]);
  assert.deepEqual(unkept.omittedFields.map((entry) => entry.field).sort(), ['blob', 'other']);
  assert.equal(unkept.workId, 'W', 'small fields stay');
  const unkeptLiteral = await boundedAgentOutput(array, { cwd: outside });
  fits(unkeptLiteral);
  assert.equal(JSON.parse(unkeptLiteral).agentOutput.state, 'detail-unavailable');
  const unkeptText = await boundedAgentText('a line of output\n'.repeat(5000), { cwd: outside });
  fits(unkeptText);
  assert.match(unkeptText, /\[Output not kept\] Lines 1-\d+ of 5000 are above\. No repository was found from here/u);

  // Many omitted fields: the view names a few, their count, and an index of every one.
  const wide = { resultType: 'wide', repositoryPath: root, ...Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`field${index}`, 'v'.repeat(400)])) };
  const wideView = await boundedAgentOutput(JSON.stringify(wide), { cwd: root });
  fits(wideView);
  const view = JSON.parse(wideView);
  assert.equal(view.omittedFields.length, OMITTED_FIELDS_SHOWN);
  const index = JSON.parse(await readFile(view.omittedIndex.path, 'utf8'));
  assert.equal(index.length, view.omittedFieldCount);
  assert.ok(view.omittedFieldCount > OMITTED_FIELDS_SHOWN && index.every((entry) => Array.isArray(entry.lines)));
  const { act: _act, ...restored } = completeAgentResult(view);
  assert.deepEqual(restored, wide, 'the full result is still restored exactly');

  // Each platform's copy of a route carries --for-agent with its command.
  const routed = await withAgentRoutes({ step: { command: 'singularity-flow recover --phase intake --json', argv: ['recover', '--phase', 'intake', '--json'],
    platformCommands: { darwin: "'singularity-flow' 'recover' '--phase' 'intake' '--json'", win32: "& 'singularity-flow' 'recover' '--phase' 'intake' '--json'" } } });
  assert.deepEqual(routed.step.platformCommands, { darwin: "'singularity-flow' 'recover' '--phase' 'intake' '--for-agent' '--json'",
    win32: "& 'singularity-flow' 'recover' '--phase' 'intake' '--for-agent' '--json'" });
});

test('routes an agent view returns carry --for-agent unless a strict agent entry would refuse it', async () => {
  // Copilot's shell is not a terminal: a route the agent runs as given printed its whole result,
  // and the host saved anything from 8,192 characters outside the workspace.
  const confirm = `singularity-flow story advance --work-id W --confirm ${digest} --json`;
  const routed = await withAgentRoutes({
    act: { do: { shell: 'singularity-flow recover --phase intake --json', copilot: '/sf-recover' } },
    next: [{ command: 'singularity-flow nextsteps QF-1 --json', argv: ['nextsteps', 'QF-1', '--json'] },
      { command: 'singularity-flow status QF-1 --submission-readiness --json --submit-if-ready' },
      { command: 'singularity-flow appeal list --json' }, { command: 'singularity-flow review-source status --json' },
      { command: 'singularity-flow session status --json' }, { command: 'singularity-flow inputs restore intake --json' },
      { command: confirm }, { command: 'singularity-flow phase enter --compose --json' }],
    prose: 'Run singularity-flow status --json when ready.' });
  assert.equal(routed.act.do.shell, 'singularity-flow recover --phase intake --for-agent --json');
  assert.equal(routed.act.do.copilot, '/sf-recover');
  assert.deepEqual(routed.next.map((entry) => entry.command), [
    'singularity-flow nextsteps QF-1 --for-agent --json',
    'singularity-flow status QF-1 --submission-readiness --for-agent --json --submit-if-ready',
    // Any other command takes it as an output option (appeal used to refuse it).
    'singularity-flow appeal list --for-agent --json',
    // review-source status now takes it, as an output option.
    'singularity-flow review-source status --for-agent --json',
    // The strict agent entries refuse it outside their compact forms; a confirmation is replayed exactly.
    'singularity-flow session status --json', 'singularity-flow inputs restore intake --json', confirm,
    'singularity-flow phase enter --compose --for-agent --json']);
  assert.deepEqual(routed.next[0].argv, ['nextsteps', 'QF-1', '--for-agent', '--json'], 'argv stays the same command');
  assert.equal(routed.prose, 'Run singularity-flow status --json when ready.', 'prose is never rewritten');
});

test('every route form given --for-agent is accepted, fits the host, and a paused SFlow answers first', slowLane({ timeout: 300_000 }), async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-routes-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const env = { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_NO_MODEL: '1', SINGULARITY_FLOW_TEST_IDENTITY: 'Agent Tester',
    SINGULARITY_FLOW_FINDING_STREAKS: 'off',
    SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(base, 'workspaces.json'), SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(base, 'active.json'),
    SINGULARITY_FLOW_LEAD_REGISTRY: path.join(base, 'leads.json'), SINGULARITY_FLOW_COPILOT_MODE_FILE: path.join(base, 'copilot-mode.json'),
    GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Agent Tester',
    GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: 'agent.tester@example.invalid' };
  const run = (args, cwd = root) => spawnSync(process.execPath, [cli, '--no-model', ...args], { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
  const must = (command, args, cwd = root) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: childTimeout(180_000) });
    assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  };
  must('git', ['init', '-q', '-b', 'main', root], base);
  must('git', ['config', 'user.name', 'Agent Tester']);
  must('git', ['config', 'user.email', 'agent.tester@example.invalid']);
  await writeFile(path.join(root, 'package.json'), '{"type":"module","private":true}\n');
  must(process.execPath, [cli, '--no-model', 'init']);
  const configPath = path.join(root, 'singularity/workflow.yml');
  const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off';
  await writeFile(configPath, YAML.stringify(config));
  must('git', ['add', '.']); must('git', ['commit', '-q', '-m', 'Route fixture']);
  must('git', ['init', '-q', '--bare', '-b', 'main', path.join(base, 'remote.git')], base);
  must('git', ['remote', 'add', 'origin', path.join(base, 'remote.git')]); must('git', ['push', '-q', '-u', 'origin', 'main']);
  must(process.execPath, [cli, '--no-model', 'start', 'QF-1', '--from-branch', 'main', '--work-type', 'quick-fix', '--title', 'Routes', '--description', 'Agent routes.']);
  // One route per accepted form; each must gain the flag and the command must not refuse it.
  const forms = ['status QF-1 --submission-readiness --json', 'recover --phase intake --json', 'choices begin approve QF-1 --fetch --json --review-packet',
    'pause status --json', 'revision status --json', 'documents list --json', 'phase prepublish intake --json', 'phase begin intake --json',
    'phase show intake --json', 'phase enter --compose --json', 'nextsteps QF-1 --json', 'inputs intake --dry-run --json',
    'review-source context --json', 'session open QF-1 --json', 'session current --json', 'appeal list --json', 'workspace current --json'];
  const routed = await withAgentRoutes(forms.map((form) => `singularity-flow ${form}`));
  for (const [index, command] of routed.entries()) {
    assert.match(command, / --for-agent --json/u, forms[index]);
    const result = run(command.split(' ').slice(1));
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /OPTIONS?_(?:INVALID|UNSUPPORTED)|Unsupported [^\n]*option|has no option/iu, command);
    // Copilot shows a result inline below 8,192 characters and saves a larger one outside the workspace.
    assert.ok(Buffer.byteLength(result.stdout) <= DEFAULT_AGENT_OUTPUT_BYTES + 1, `${command}: ${Buffer.byteLength(result.stdout)} bytes`);
  }
  // A maintained help topic may shrink below the host limit. Exercise the real text route without
  // assuming its editorial length, then use controlled oversized text to verify the retained file.
  const explained = run(['explain', 'workflow-markup']);
  const agentExplain = run(['explain', 'workflow-markup', '--for-agent']);
  assert.equal(explained.status, 0, explained.stderr);
  assert.equal(agentExplain.status, 0, agentExplain.stderr);
  assert.ok(Buffer.byteLength(agentExplain.stdout) <= DEFAULT_AGENT_OUTPUT_BYTES);
  if (Buffer.byteLength(explained.stdout) <= DEFAULT_AGENT_OUTPUT_BYTES) assert.equal(agentExplain.stdout, explained.stdout);
  const whole = 'A requirement has an observable outcome and verifiable evidence. Ω\n'.repeat(2000);
  const bounded = await boundedAgentText(whole, { cwd: root, kind: 'explain' });
  assert.ok(Buffer.byteLength(bounded) <= DEFAULT_AGENT_OUTPUT_BYTES, `${Buffer.byteLength(bounded)} bytes`);
  const [, file, relative] = /The complete output is (\S+) \(([^)]+)\)/u.exec(bounded);
  assert.match(relative, /^\.sflow\/out\/explain-[0-9a-f]{8}\.txt$/u);
  assert.equal(await readFile(file, 'utf8'), whole, 'nothing was truncated');
  assert.ok(whole.startsWith(bounded.slice(0, bounded.indexOf('\n[Output continues]'))), 'the view is the start of the text');
  // A paused SFlow answers an agent command before any Git or lookup; pause itself still runs.
  await writeFile(env.SINGULARITY_FLOW_COPILOT_MODE_FILE, JSON.stringify({ schemaVersion: 1, paused: true, changedAt: '2026-10-16T00:00:00.000Z' }));
  for (const args of [['appeal', 'list', '--for-agent', '--json'], ['status', 'QF-1', '--for-agent', '--json']]) {
    const paused = run(args);
    assert.equal(paused.status, 0, paused.stderr);
    assert.equal(JSON.parse(paused.stdout).nativeCopilot, true, args.join(' '));
  }
  assert.equal(JSON.parse(run(['pause', 'status', '--for-agent', '--json']).stdout).resultType, 'command-result');
  assert.match(run(['status', 'QF-1', '--for-agent']).stdout, /paused/iu, 'text mode answers too');
});

test('a prepublish correction names each finding to fix in act itself', () => {
  // The correction once said only "correct the cited findings": an agent whose host showed the start
  // of the result edited blind and reran prepublish ten times while the count went 1, 3, 2, 4.
  const findings = Array.from({ length: 8 }, (_, index) => ({ code: `specification.example-${index}`,
    path: 'singularity/work-items/W/artifacts/intake/intake.md', line: index + 10, message: `Row ${index + 1} names an unknown clause.` }));
  const act = agentAct({ resultType: 'sflow-phase-prepublish', status: 'correction-required', workId: 'W', phase: 'intake', findings,
    correction: { guidance: 'Correct the cited findings, then rerun prepublish.' } });
  assert.equal(act.state, 'correct');
  assert.equal(act.fix.length, 7);
  assert.equal(act.fix[0], 'specification.example-0 at singularity/work-items/W/artifacts/intake/intake.md:10: Row 1 names an unknown clause.');
  assert.equal(act.fix.at(-1), '+2 more in findings');
  assert.equal(agentAct({ resultType: 'sflow-phase-prepublish', status: 'correction-required', findings: [] }).fix, undefined);
});

test('an opened session keeps its commit, path and every next action in view, however large the workflow', async (t) => {
  const { agentSessionView } = await import('../src/commands/session-open.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-session-view-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  // A workflow with many steps: verbose open and status records, twelve actions with full guidance.
  const guidance = (index) => ({ command: `singularity-flow phase prepublish step-${index} --json`, copilotCommand: '/sf-code', modelFreeCommand: null,
    executable: 'singularity-flow', argv: ['phase', 'prepublish', `step-${index}`, '--json'], copyable: true,
    platformCommands: { posix: `singularity-flow phase prepublish step-${index} --json`, powershell: `singularity-flow phase prepublish step-${index} --json` } });
  const raw = {
    schemaVersion: 1, resultType: 'session-open', status: 'ready', workId: 'BIG-1', repositoryPath: root, localOnly: true, attachedFromRemote: false,
    open: { workId: 'BIG-1', branch: 'BIG-1', head: 'a'.repeat(40), repositoryPath: root, phase: 'step-3', status: 'in_progress', agent: 'developer',
      phases: Array.from({ length: 30 }, (_, index) => ({ id: `step-${index}`, label: `Step ${index}`, status: 'not_started', detail: 'x'.repeat(200) })) },
    session: { ready: true, workId: 'BIG-1', activeAgent: 'developer', phase: 'step-3', personalization: { replyName: 'Contributor' }, phases: 'y'.repeat(9000) },
    context: { text: 'Brief line.\n'.repeat(1500) },
    nextsteps: { resultType: 'sflow-nextsteps', state: 'active', currentPhase: 'step-3', evidence: { blob: 'z'.repeat(8000) },
      actions: Array.from({ length: 12 }, (_, index) => ({ id: `a${index}`, timing: index ? 'later' : 'now', reason: `Do step ${index}`, skill: '/sf-code',
        command: guidance(index).command, copilotCommand: '/sf-code', argv: guidance(index).argv, route: 'authoring', commandGuidance: guidance(index) })) }
  };
  const result = { ...raw, ...agentSessionView(raw), ready: true };
  assert.deepEqual(Object.keys(result.open).sort(), ['agent', 'branch', 'head', 'phase', 'repositoryPath', 'status', 'workId']);
  assert.equal(result.session.personalization.replyName, 'Contributor');
  assert.equal(result.nextsteps.actions.length, 12);
  assert.deepEqual(result.nextsteps.actions[0], { id: 'a0', timing: 'now', reason: 'Do step 0', skill: '/sf-code',
    commandGuidance: { command: 'singularity-flow phase prepublish step-0 --json', copilotCommand: '/sf-code', modelFreeCommand: null } },
  'each action once, with its routes; PowerShell only where it differs');
  assert.equal(result.nextsteps.evidence, undefined);

  const act = agentAct(result);
  assert.deepEqual(act.story, { workId: 'BIG-1', repositoryPath: root, commit: 'a'.repeat(12), agent: 'developer', phase: 'step-3', localOnly: true });
  assert.equal(act.do, null, 'opening a session is never counted as a loop');
  assert.equal(act.next.length, 5);
  assert.deepEqual(act.next[0], { timing: 'now', reason: 'Do step 0', copilot: '/sf-code', shell: 'singularity-flow phase prepublish step-0 --json', vscode: null });

  // Within the bound, the fields the session skill reports stay in view; only the brief moves out.
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(result), { cwd: root }));
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= DEFAULT_AGENT_OUTPUT_BYTES);
  assert.equal(view.act.story.commit, 'a'.repeat(12));
  assert.equal(view.repositoryPath, root);
  assert.equal(view.open.head, 'a'.repeat(40));
  assert.deepEqual(view.omittedFields.map((field) => field.field), ['context']);
  assert.equal(view.nextsteps.actions.length, 12);
});

// Measured on a recorded Story, 2026-11-05: 73% of the JSON read was outside the fields each act named,
// and the review packet alone was 10 KB of each publish and 25 KB of a code step's submit.
test('a result reads what its act names, nested fields included, and only a result with no act direction is read whole', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-needs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const rows = (label, count) => Array.from({ length: count }, (_, index) => ({ id: `${label}-${index}`, detail: 'y'.repeat(120) }));
  const next = { instruction: 'Submitted. End the reply.', reason: 'Decide it.', commandGuidance: { copilotCommand: '/sf-approve intake --work-id W', command: 'singularity-flow approve intake --work-id W --fetch', modelFreeCommand: null } };
  const submitted = { resultType: 'sflow-submission-readiness', repositoryPath: root, workId: 'W', submitIfReady: { submitted: true, next, result: 'Submitted generation 1.',
    review: { documents: rows('document', 60), displayBinding: rows('binding', 20) } }, recovery: { blockers: rows('blocker', 60) } };
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(submitted), { cwd: root }));
  assert.deepEqual(view.act.read, ['submitIfReady.next', 'submitIfReady.result']);
  assert.equal(view.agentOutput.read.length, 1);
  const lines = (await readFile(view.agentOutput.path, 'utf8')).split('\n');
  const planned = lines.slice(view.agentOutput.read[0].lines[0] - 1, view.agentOutput.read[0].lines[1]).join('\n');
  assert.match(planned, /^"next": \{/mu);
  assert.match(planned, /^"result": "Submitted generation 1\."/mu);
  assert.doesNotMatch(planned, /document-0|blocker-0/u, 'neither the packet nor recovery is planned');
  assert.ok(lines.every((line) => !line.startsWith(' ')), 'a saved result has line structure and no indentation');
  assert.deepEqual(completeAgentResult(view).submitIfReady, submitted.submitIfReady, 'the complete result is still whole');

  // Fields apart in the file never share a range, which would read every line between them.
  const apart = { resultType: 'source-review-agent-context', canReview: true, ready: true, repositoryPath: root, workId: 'W',
    sources: [{ id: 'story', text: 'Keep the pinned source.' }], unnamed: rows('unnamed', 60), artifact: { text: 'Authored artifact.\n'.repeat(500) } };
  const review = JSON.parse(await boundedAgentOutput(JSON.stringify(apart), { cwd: root }));
  const unnamed = review.omittedFields.find((entry) => entry.field === 'unnamed');
  for (const { lines: [start, end] } of review.agentOutput.read ?? []) assert.ok(end < unnamed.read[0][0] || start > unnamed.read.at(-1)[1], JSON.stringify(review.agentOutput.read));

  // No direction from act: the result is itself the answer.
  const plain = { resultType: 'x', repositoryPath: root, workId: 'W', first: rows('first', 60), second: rows('second', 60) };
  const whole = JSON.parse(await boundedAgentOutput(JSON.stringify(plain), { cwd: root }));
  assert.equal(whole.act.read, undefined);
  const read = await fieldsIn(whole.agentOutput.path, whole.agentOutput.read);
  assert.deepEqual(Object.keys(read).sort(), ['first', 'second']);
});

test('nextsteps names its actions, and act alone is enough when they are already in view', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-nextsteps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const actions = [{ id: 'phase', timing: 'now', reason: 'Author it.', command: 'singularity-flow phase enter --compose --for-agent --json', copilotCommand: '/sf-phase' }];
  const result = { resultType: 'sflow-nextsteps', repositoryPath: root, workId: 'W', actions, mutationContract: { rules: 'r'.repeat(9_000) },
    authoringContract: { rules: 'a'.repeat(9_000) } };
  const view = JSON.parse(await boundedAgentOutput(JSON.stringify(result), { cwd: root }));
  assert.deepEqual(view.act.read, ['contextBoundary', 'actions', 'pending']);
  assert.deepEqual(view.actions, actions, 'what it names stays in the view');
  assert.equal(view.agentOutput.read, undefined);
  assert.match(view.agentOutput.instruction, /act is all this step needs/u);
  assert.ok(view.omittedFields.every((entry) => (entry.textFiles ?? []).every((file) => !file.need)), 'nothing is marked to read');
});

test('a repeated entry with the same prompt names the same prompt file', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-same-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const text = Array.from({ length: 700 }, (_, index) => `Line ${index} of the composed phase prompt, with its rules.`).join('\n');
  const entry = (head) => ({ resultType: 'sflow-phase-entry', status: 'clarification-required', repositoryPath: root, workId: 'W', head, context: { text } });
  const [first, second] = await Promise.all(['a', 'b'].map(async (head) => JSON.parse(await boundedAgentOutput(JSON.stringify(entry(head)), { cwd: root }))));
  assert.notEqual(first.agentOutput.path, second.agentOutput.path, 'the results differ');
  const file = (view) => view.omittedFields.find((candidate) => candidate.field === 'context').textFiles[0];
  assert.equal(file(first).path, file(second).path, 'the same bytes keep one path');
  assert.match(path.basename(file(first).path), /^context-text-[0-9a-f]{8}\.txt$/u);
  assert.equal(await readFile(file(first).path, 'utf8'), text);
  assert.equal(completeAgentResult(second).context.text, text);
});

test('the next step after publishing or submitting says when it starts in a new chat', async () => {
  const { nextAfterStep } = await import('../src/cli-steps.mjs');
  const after = (copilotCommand) => nextAfterStep({ continuation: { nextAction: { reason: 'Go.' }, copilotCommand, nextCommand: 'singularity-flow status' } }, 'Done.').instruction;
  for (const route of ['/sf-review-source planning', '/sf-submit', '/sf-approve planning --work-id W']) assert.match(after(route), /Say to run it in a new chat/u, route);
  for (const route of ['/sf-code', '/sf-phase', '/sf-next', '/sf-outcome W', '/sf-review-decide planning']) assert.doesNotMatch(after(route), /new chat/u, route);
});

test('every range a kept result names comes back from the read guard, whatever the field sizes', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-named-reads-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const rows = (label, count) => Array.from({ length: count }, (_, index) => ({ id: `${label}-${index}`, detail: 'y'.repeat(150) }));
  const prose = Array.from({ length: 400 }, (_, index) => `Line ${index + 1} of a text long enough for a file of its own, and for several reads.`).join('\n');
  // A real result named `lines` for a 35 KB field beside the plan that split it, and the agent asked for that.
  const results = [
    { act: { read: ['submitIfReady'] }, resultType: 'custom', repositoryPath: root, workId: 'W', submitIfReady: rows('s', 200), note: 'kept' },
    { resultType: 'sflow-phase-entry', status: 'authoring-entry', repositoryPath: root, workId: 'W',
      history: rows('history', 160), evidence: rows('evidence', 90), extra: rows('extra', 400), mutationContract: { rules: rows('rule', 120) } },
    { resultType: 'source-review-agent-context', canReview: true, ready: true, repositoryPath: root, workId: 'W',
      sources: [{ id: 'story', text: 'One line.\n' }, { id: 'long', text: prose }], reviewer: { effectiveInstructions: prose }, artifact: { text: `${prose}\n` }, schema: rows('schema', 200) },
    // More fields than a view lists, so an index of them is named too, and more than ten reads' worth.
    { resultType: 'custom', repositoryPath: root, ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}`, rows(`f${index}`, 80)])) }];
  for (const result of results) {
    const view = JSON.parse(await boundedAgentOutput(JSON.stringify(result), { cwd: root }));
    const named = namedReads(view);
    assert.ok(named.length >= 2, JSON.stringify(view.omittedFields));
    for (const read of named) assert.equal(await namedReadRefused(read, root), null, `${path.basename(read.file)} ${read.range}`);
    for (const entry of view.omittedFields) {
      assert.ok(entry.lines || entry.read || entry.readBy, `${JSON.stringify(entry)} says how it is read`);
      if (entry.lines) {
        const lines = (await readFile(view.agentOutput.path, 'utf8')).split('\n').slice(entry.lines[0] - 1, entry.lines[1]);
        assert.ok(Buffer.byteLength(lines.join('\n')) <= READ_CHUNK_BYTES, 'a field named by its lines fits one read');
      }
    }
  }

  // Text kept the same way: the rest is named in ranges that fit, however long it is.
  for (const lines of [300, 4_000]) {
    const whole = Array.from({ length: lines }, (_, index) => `Line ${index + 1} of the output of a long explanation for the agent.`).join('\n');
    const shown = await boundedAgentText(`${whole}\n`, { cwd: root, kind: 'explain' });
    assert.ok(Buffer.byteLength(shown) <= DEFAULT_AGENT_OUTPUT_BYTES, `${Buffer.byteLength(shown)} bytes`);
    const [, file] = /The complete output is (\S+) /u.exec(shown);
    const [, named] = /Read lines ([\d, -]+) there/u.exec(shown);
    const ranges = named.split(', ').map((range) => range.split('-').map(Number));
    assert.ok(ranges.length <= READ_PLAN_CHUNKS, named);
    assert.equal(ranges[0][0], Number(/Lines 1-(\d+) of/u.exec(shown)[1]) + 1, 'from the first line not shown');
    for (const range of ranges) assert.equal(await namedReadRefused({ file, range }, root), null, range.join('-'));
    const further = /then go on from line (\d+) the same way/u.exec(shown);
    if (further) assert.equal(Number(further[1]), ranges.at(-1)[1] + 1);
    else assert.equal(ranges.at(-1)[1], lines, 'the ranges reach the last line');
  }
});

test('a saved text counts the lines it has, with or without a last newline', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-agent-line-count-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q', root]).status, 0);
  const body = Array.from({ length: 200 }, (_, index) => `Line ${index + 1} of a long text the agent reads from its own saved file.`).join('\n');
  for (const [text, lines] of [[`${body}\n`, 200], [body, 200], [`${body}\n\n`, 201]]) {
    const view = JSON.parse(await boundedAgentOutput(JSON.stringify({ resultType: 'custom', repositoryPath: root, body: text }), { cwd: root }));
    const saved = view.omittedFields.flatMap((entry) => entry.textFiles ?? []).find((entry) => entry.field === 'body');
    assert.equal(saved.read.at(-1)[1], lines, JSON.stringify(saved));
    assert.equal(saved.lines, undefined, 'a long file names ranges, not a count an agent then asks for at once');
  }
});
