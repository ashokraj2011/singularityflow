/**
 * Never stuck, second part (owner, 2026-11-28).
 *
 * 1. Browser stop: when SFlow still cannot capture a page after its setup, a person signs off on SFlow's saved screenshot.
 *    It is recorded as "signed off by a person, not captured by SFlow" and shown at the approval and in the pull request;
 *    the workflow's gate stays, and the sign-off is its way out.
 * 2. A wrong SFlow check: "This check is wrong here" with the person's reason moves the Story on, recorded as overridden
 *    and shown at the approval and in the pull request, with the report for SFlow's maintainer to copy. SFlow's own hooks,
 *    governance files and secrets stay protected, with why in one line.
 * 3. The rest of the stuck points' dead ends each offer something to press.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkReportText, checkWrongBar, findingOverrideKey, honourOverrides, overriddenWords, personOverrideLines, PROTECTED_WHY,
  recordFindingOverride } from '../src/finding-overrides.mjs';
import { BROWSER_UNOBSERVED_CODE, MCP_EVIDENCE_SCHEMA_VERSION, verifyPhaseMcpRequirements } from '../src/mcp-evidence.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { decisionPacket } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { PERSON_DECISIONS_HEADING, storyPullRequestBody } from '../src/pull-request.mjs';
import { PERSON_DECISIONS_SECTION, renderChangeStory } from '../src/change-story-page.mjs';
import { changeStoryForPullRequest } from '../src/change-story-read.mjs';
import { STOP_KINDS, stopAdvice } from '../src/step-advice.mjs';
import { argvAllowed } from '../src/copilot-mutation-guard.mjs';
import { refusalRemediationPlan } from '../src/refusal-remediation.mjs';
import { decisionInputChoiceRoutes } from '../src/story-value-answers.mjs';
import { actionCommandLine } from '../src/action-command-map.mjs';
import { publicationPushRefusal, writeAccessRequest } from '../src/publication-retry-refusals.mjs';
import { createPullRequest } from '../src/pull-request.mjs';

const AT = '2026-11-28T09:00:00.000Z';
const REASON = 'The check reads the verdict table column order wrongly; the row is right.';
const SERVER = 'playwright';
const ORIGIN = 'http://127.0.0.1:4173';

const story = (extra = {}) => ({
  workItem: { id: 'D-1', title: 'Fix the dashboard', workType: 'feature' }, status: 'in_progress', currentPhase: 'verification', phaseOrder: ['verification'],
  phases: { verification: { id: 'verification', label: 'Verification', status: 'in_progress', generation: 1,
    approvalPolicy: { authorities: ['qa'] }, mcp: { evidence: [{ server: SERVER, tool: 'browser_snapshot', minimum: 1, outputRequired: true }] } } },
  resolution: { phases: [], approvalAuthorities: { qa: { label: 'QA', allowAnyGitIdentity: true, members: [] } },
    mcpServers: { [SERVER]: { hostReference: 'playwright', phases: [], agents: [], tools: [], evidence: {} } } },
  mcpAuthorizations: { [SERVER]: { origins: [ORIGIN] } },
  findingOverrides: [], ...extra
});

/** SFlow's saved screenshot of the page: an agent's capture, kept for audit, that the host did not observe. */
async function savedScreenshot(itemDirectory, bytes = 'snapshot of the dashboard') {
  const id = 'mcp-00000000-0000-4000-8000-000000000001';
  const relative = `context/mcp/outputs/${id}/browser-snapshot.json`;
  await mkdir(path.join(itemDirectory, path.dirname(relative)), { recursive: true });
  await writeFile(path.join(itemDirectory, relative), bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await mkdir(path.join(itemDirectory, 'context', 'mcp', 'records'), { recursive: true });
  await writeFile(path.join(itemDirectory, 'context', 'mcp', 'records', `${id}.json`), JSON.stringify({ schemaVersion: MCP_EVIDENCE_SCHEMA_VERSION, id,
    kind: 'tool-call', workId: 'D-1', phase: 'verification', targetGeneration: 2, server: SERVER, hostReference: 'playwright', tool: 'browser_snapshot',
    agent: null, actor: null, recordedAt: AT, captureSource: 'declared-by-agent', note: null, targetOrigin: null, observedFinalUrlSha256: null,
    observedFinalOrigin: null, originReceipt: null, output: { path: relative, sha256, bytes: Buffer.byteLength(bytes), mediaType: 'application/json', sourceDisposition: 'local-copy' } }));
  return { id, relative, sha256 };
}

test('a page SFlow could not capture: the gate offers a person\'s sign-off on its saved screenshot, and honours it as signed off, not captured', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-sign-off-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workflow = story();
  const phase = workflow.phases.verification;
  // Nothing saved yet: the setup is the way on, and there is nothing to sign off.
  const empty = await verifyPhaseMcpRequirements(root, workflow, phase, { itemDirectory: root, targetGeneration: 2 });
  assert.ok(empty.errors.some((line) => /host-observed navigation receipt/u.test(line)), empty.errors.join('\n'));
  assert.ok(empty.routes.length >= 3, 'the setup commands, in order');
  assert.deepEqual(empty.signOffs, []);
  // SFlow saved a screenshot: its sign-off is offered, keyed to the page and bound to those exact bytes.
  const shot = await savedScreenshot(root);
  const offered = await verifyPhaseMcpRequirements(root, workflow, phase, { itemDirectory: root, targetGeneration: 2 });
  assert.match(offered.errors.join('\n'), /If SFlow still cannot capture it, a person who approves the step may sign off on SFlow's saved screenshot instead\./u);
  const [offer] = offered.signOffs;
  assert.equal(offer.code, BROWSER_UNOBSERVED_CODE);
  assert.equal(offer.value, SERVER);
  assert.equal(offer.override.kind, 'browser-sign-off');
  assert.deepEqual(offer.override.screenshot, { record: shot.id, path: shot.relative, sha256: shot.sha256 });
  assert.equal(offer.override.key, findingOverrideKey('verification', { code: BROWSER_UNOBSERVED_CODE, value: SERVER }));
  // A sign-off takes no reason, and names the exact screenshot.
  assert.throws(() => recordFindingOverride(structuredClone(workflow), { phase: 'verification', generation: 2, finding: { key: offer.override.key, code: offer.code, value: SERVER },
    reason: '', actor: 'ana', authorityGroup: 'qa', at: AT, kind: 'browser-sign-off' }), /names the exact screenshot SFlow saved/u);
  const record = recordFindingOverride(workflow, { phase: 'verification', generation: 2, finding: { key: offer.override.key, code: offer.code, value: SERVER, message: offer.message },
    reason: '', actor: 'ana', authorityGroup: 'qa', at: AT, kind: 'browser-sign-off', screenshot: offer.override.screenshot });
  assert.deepEqual([record.kind, record.reason, record.screenshot.sha256], ['browser-sign-off', null, shot.sha256]);
  const signed = await verifyPhaseMcpRequirements(root, workflow, phase, { itemDirectory: root, targetGeneration: 2 });
  assert.deepEqual(signed.errors, [], 'the gate passes on the sign-off');
  assert.ok(signed.passes.some((line) => line === `${SERVER}: The ${SERVER} page was signed off by ana on SFlow's saved screenshot ${shot.relative}, not captured by SFlow.`), signed.passes.join('\n'));
  assert.equal(signed.signed.length, 1);
  // A changed screenshot is not what was signed off: the gate asks again.
  await writeFile(path.join(root, shot.relative), 'another page');
  const changed = await verifyPhaseMcpRequirements(root, workflow, phase, { itemDirectory: root, targetGeneration: 2 });
  assert.ok(changed.errors.length, 'a sign-off counts only for the bytes it saw');
  // A later version is checked afresh.
  await writeFile(path.join(root, shot.relative), 'snapshot of the dashboard');
  assert.ok((await verifyPhaseMcpRequirements(root, workflow, phase, { itemDirectory: root, targetGeneration: 3 })).errors.length);
});

test('a sign-off and a wrong check are said as what they are at the approval and in the pull request, never as checked by SFlow', () => {
  const workflow = story();
  const signOffKey = findingOverrideKey('verification', { code: BROWSER_UNOBSERVED_CODE, value: SERVER });
  recordFindingOverride(workflow, { phase: 'verification', generation: 1, finding: { key: signOffKey, code: BROWSER_UNOBSERVED_CODE, value: SERVER },
    reason: '', actor: 'ana', authorityGroup: 'qa', at: AT, kind: 'browser-sign-off', screenshot: { record: 'mcp-1', path: 'context/mcp/outputs/mcp-1/shot.png', sha256: 'a'.repeat(64) } });
  recordFindingOverride(workflow, { phase: 'verification', generation: 1, finding: { key: 'CHK-0123456789ab', code: 'conformance.verdict-row', path: 'report.md' },
    reason: REASON, actor: 'ana', authorityGroup: 'qa', at: AT, kind: 'check-wrong' });
  const lines = personOverrideLines(workflow).map((entry) => entry.words);
  assert.deepEqual(lines, [
    'The playwright page was signed off by ana on SFlow\'s saved screenshot context/mcp/outputs/mcp-1/shot.png, not captured by SFlow.',
    `ana said SFlow's check conformance.verdict-row on report.md is wrong here: "${REASON}". Recorded as overridden, not passed.`]);
  // The pull request has its own section, from the Story as it is.
  const body = storyPullRequestBody(workflow, null, { personDecisions: personOverrideLines(workflow) });
  assert.ok(body.includes(`${PERSON_DECISIONS_HEADING}\n\n- Verification v1: ${lines[0]}\n- Verification v1: ${lines[1]}`), body);
  assert.ok(!storyPullRequestBody(story(), null).includes(PERSON_DECISIONS_HEADING), 'no section when nobody decided in SFlow\'s place');
  // The change story page says the same, and the pull request keeps only its own copy of it.
  const page = renderChangeStory({ workId: 'D-1', title: 'Fix the dashboard', asked: { request: 'Fix it.', requirements: [], criteria: [] }, how: null, reasons: [], files: [],
    tests: { ran: false }, outsidePlan: null, withheld: 0, codeSteps: [{ id: 'code', label: 'Code', generation: 1 }],
    personDecisions: [{ step: 'Verification', generation: 1, words: lines[0] }] });
  assert.ok(page.includes(`${PERSON_DECISIONS_SECTION}\n\n- Verification version 1: ${lines[0]}`), page);
  assert.ok(!changeStoryForPullRequest(page).includes('Decided by a person'), 'the pull request shows its own section, not the page\'s');
  // At the approval: the approval item's reviewed lines say each as what it is.
  workflow.phases.verification.status = 'awaiting_approval';
  const facts = { phaseId: 'verification', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [], testRisks: [], unavailable: [], state: {}, pending: {} };
  const packet = decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities, actor: { name: 'Bo', email: 'bo@example.invalid' }, at: AT });
  const approval = [...packet.items, ...(packet.next ? [packet.next] : [])].find((item) => item.kind === 'approval');
  const text = JSON.stringify(approval);
  assert.ok(text.includes('signed off by ana on SFlow\'s saved screenshot context/mcp/outputs/mcp-1/shot.png, not captured by SFlow.'), text.slice(0, 1500));
  assert.ok(text.includes('said SFlow\'s check conformance.verdict-row on report.md is wrong here'), text.slice(0, 1500));
});

test('the decision list offers the sign-off with no reason and its why from the step\'s advice; the chat turn admits it on the person\'s yes', () => {
  const workflow = story();
  const facts = { phaseId: 'verification', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [], testRisks: [], unavailable: [], state: {}, pending: {},
    findingOverrides: { phase: 'verification', generation: 2, overridden: [], findings: [
      { key: 'CHK-00000000000a', code: BROWSER_UNOBSERVED_CODE, value: SERVER, message: 'SFlow could not capture the playwright page itself for this version.',
        kind: 'browser-sign-off', screenshot: { record: 'mcp-1', path: 'context/mcp/outputs/mcp-1/shot.json', sha256: 'a'.repeat(64), file: 'singularity/work-items/D-1/context/mcp/outputs/mcp-1/shot.json' } },
      { key: 'CHK-00000000000b', code: 'conformance.verdict-row', path: 'report.md', message: 'The verdict row names no witness.', kind: 'check-wrong',
        report: checkReportText('D-1', 'verification', { code: 'conformance.verdict-row', path: 'report.md', message: 'The verdict row names no witness.' }) }] } };
  const packet = withPlainWords(workflow, decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities, actor: { name: 'Ana', email: 'ana@example.invalid' }, at: AT }));
  const signOff = packet.offered.find((item) => item.kind === 'browser-sign-off');
  assert.ok(signOff, JSON.stringify(packet.offered.map((item) => item.kind)));
  assert.equal(signOff.plain.question, 'Sign off SFlow\'s screenshot of the playwright page for Verification version 2?');
  assert.equal(signOff.details.path, 'singularity/work-items/D-1/context/mcp/outputs/mcp-1/shot.json', 'the card opens the screenshot beside the row');
  const [option] = signOff.options;
  assert.deepEqual([option.label, option.outcome, option.needs ?? {}], ['Sign off SFlow\'s screenshot', 'sign-off', {}]);
  assert.ok(option.words.startsWith(stopAdvice('generic', 'signOff')), option.words);
  assert.ok(signOff.why.endsWith(stopAdvice('generic', 'browser', { step: 'Verification' })), signOff.why);
  assert.match(option.terminal, /^singularity-flow decision override-finding D-1 --phase verification --finding CHK-00000000000a --sign-off$/u);
  // The wrong check: "This check is wrong here", the reason the person's own, and the report to copy.
  const wrong = packet.offered.find((item) => item.kind === 'check-finding');
  assert.equal(wrong.options[0].label, 'This check is wrong here');
  assert.equal(wrong.plain.question, 'Is SFlow\'s check conformance.verdict-row wrong here, on Verification version 2?');
  assert.match(wrong.details.report, /^SFlow check conformance\.verdict-row looks wrong\. It blocked step verification of Story D-1 on report\.md: The verdict row names no witness\./u);
  assert.ok(wrong.why.endsWith(stopAdvice('generic', 'wrongCheck', { step: 'Verification' })), wrong.why);
  // In /sf-decide: the sign-off on the person's yes, with no reason; nothing else rides with it.
  const turn = { contract: { workId: 'D-1', phaseId: 'verification' }, decisionEnded: false };
  const argv = ['decision', 'override-finding', 'D-1', '--phase', 'verification', '--finding', 'CHK-00000000000a', '--sign-off'];
  assert.equal(argvAllowed(argv, 'decision-only', turn), true);
  assert.equal(argvAllowed([...argv, '--fetch'], 'decision-only', turn), false);
  assert.equal(argvAllowed(['decision', 'override-finding', 'D-1', '--finding', 'CHK-00000000000a'], 'decision-only', turn), false, 'an override still takes a reason');
});

test('nothing else gets past a check: "This check is wrong here" replaces the maintainer route; SFlow\'s own hooks and governance stay protected', () => {
  const workflow = story();
  const phase = workflow.phases.verification;
  // A finding with its own person's route keeps it; one with none is offered "this check is wrong here" by its gate.
  const finding = { code: 'specification.clarification', category: 'clarification', path: 'report.md', message: 'The report asks a question nobody answered.' };
  const honoured = honourOverrides(workflow, phase, [finding]);
  assert.equal(honoured.findings[0].override.kind, 'check-wrong', JSON.stringify(honoured.findings[0]));
  const { choices } = phaseResolutionChoices(workflow, phase, { ...honoured.findings[0] });
  assert.ok(!choices.some((choice) => choice.kind === 'check-defect'), 'no maintainer-only route');
  const wrong = choices.find((choice) => choice.kind === 'check-wrong');
  assert.ok(wrong, JSON.stringify(choices.map((choice) => choice.kind)));
  assert.deepEqual(wrong.argv.slice(0, 6), ['decision', 'override-finding', 'D-1', '--phase', 'verification', '--finding']);
  assert.equal(wrong.owner, 'phase-approval-authority');
  assert.ok(wrong.detail.includes(stopAdvice('generic', 'wrongCheck', { step: 'Verification' })), wrong.detail);
  assert.match(wrong.report, /^SFlow check specification\.clarification looks wrong\./u);
  // Recorded with the person's reason; a later override with the same key is honoured by the gate.
  const record = recordFindingOverride(workflow, { phase: 'verification', generation: 2, finding: { key: honoured.findings[0].override.key, ...finding },
    reason: REASON, actor: 'ana', authorityGroup: 'qa', at: AT, kind: 'check-wrong' });
  assert.equal(record.kind, 'check-wrong');
  assert.equal(honourOverrides(workflow, phase, [finding], { generation: 2 }).findings.length, 0, 'the Story moves on');
  assert.match(overriddenWords(finding, { by: 'ana', reason: REASON, kind: 'check-wrong' }), /^ana said SFlow's check specification\.clarification on report\.md is wrong here/u);
  // SFlow's own hooks, governance files and secrets: no override, why in one line, and the report still offered.
  const guarded = { code: 'HOOK_BUNDLE_CHANGED', category: 'integrity', path: '.github/hooks/sflow.json', message: 'SFlow\'s hook bundle changed.' };
  assert.equal(checkWrongBar(guarded), PROTECTED_WHY);
  assert.equal(honourOverrides(workflow, phase, [guarded]).findings[0].override, undefined);
  // Its way on is the configuration's own authority, never an override of SFlow's guard.
  const guardedRoutes = phaseResolutionChoices(workflow, phase, guarded).choices;
  assert.ok(!guardedRoutes.some((choice) => choice.kind === 'check-wrong'), JSON.stringify(guardedRoutes.map((choice) => choice.kind)));
  assert.equal(guardedRoutes[0].owner, 'configuration-authority');
  // A check no route names anyone for and whose gate keeps no override: the report to copy, with why in one line.
  const unkeyed = phaseResolutionChoices(workflow, phase, { code: 'AGENT_BRIEF_SUMMARY_REQUIRED', category: 'authoring', path: 'report.md', message: 'No summary.' }).choices;
  const report = unkeyed.find((choice) => choice.kind === 'check-report');
  assert.ok(report, JSON.stringify(unkeyed.map((choice) => choice.kind)));
  assert.match(report.report, /^SFlow check AGENT_BRIEF_SUMMARY_REQUIRED looks wrong\./u);
  assert.match(stopAdvice('generic', 'protected'), /^This check guards SFlow's own hooks, governance files or a secret, so nobody overrides it/u);
  // Where the Story stands is its own next action's, and a failing test is fixed: neither is overridden.
  assert.match(checkWrongBar({ code: 'X', category: 'lifecycle' }), /where the Story stands/u);
  assert.match(checkWrongBar({ code: 'CODE_TEST_FAILED', category: 'tests' }), /failing test is fixed, never overridden/u);
  assert.equal(honourOverrides(workflow, phase, [{ code: 'CODE_TEST_FAILED', category: 'tests', message: 'unit failed' }]).findings[0].override, undefined);
});

test('the advice table has a line for each new stop, the hooks-off line among them', () => {
  for (const kind of ['signOff', 'wrongCheck', 'protected', 'hooks']) {
    assert.ok(STOP_KINDS.includes(kind), kind);
    assert.ok(stopAdvice('code', kind, { step: 'Code' }).length > 40, kind);
  }
  assert.match(stopAdvice('generic', 'hooks'), /^Reload VS Code \(Developer: Reload Window\) and start a new chat/u);
});

test('the other dead ends: write access names the words to send, a missing decision value gets one filled submit per value, a pull request refusal its code and route', () => {
  // Write access is someone else's call: the exact words, carried to the card's Copy button.
  const words = writeAccessRequest({ branch: 'd-story', remote: 'origin', commit: 'abcdef1234567890', subject: { id: 'D-1' } });
  assert.equal(words, 'Please give my Git account write access to the d-story branch on origin. SFlow could not push Story D-1\'s commit abcdef123456; it will send the same commit unchanged once I can write.');
  const refusal = publicationPushRefusal({ result: { status: 128, stderr: 'remote: Permission to acme/app.git denied to someone.\nfatal: unable to access: The requested URL returned error: 403', stdout: '',
    failure: { classification: 'authorization-denied', code: 'REMOTE_AUTHORIZATION_DENIED', retryable: false } }, subject: { id: 'D-1' }, branch: 'd-story', remote: 'origin', commit: 'abcdef1234567890' });
  assert.equal(refusal.details.share.text, words);
  assert.ok(refusal.message.includes(`Send the repository owner: "${words}"`), refusal.message);
  const plan = refusalRemediationPlan(refusal, ['sync', 'D-1']);
  const send = plan.steps.find((entry) => entry.id === 'send-request');
  assert.equal(send?.copy, words, JSON.stringify(plan.steps.map((entry) => entry.id)));
  // A decision after the step reads a value nobody gave: one filled submission per value, the given ones kept.
  const decision = { id: 'risk-route', label: 'Risk route', inputs: [{ name: 'risk', values: ['low', 'high'] }, { name: 'size', type: 'number' }] };
  const workflow = story();
  const routes = decisionInputChoiceRoutes(actionCommandLine, workflow, workflow.phases.verification, decision);
  assert.deepEqual(routes.recoveryCommands.map((entry) => entry.command), [
    'singularity-flow submit verification --work-id D-1 --decision risk=low', 'singularity-flow submit verification --work-id D-1 --decision risk=high']);
  assert.deepEqual(decisionInputChoiceRoutes(actionCommandLine, workflow, workflow.phases.verification, decision, { risk: 'low' }).recoveryCommands, [], 'a number is typed, never guessed');
  // A pull request SFlow could not open: its code and one filled route each.
  const plan2 = { workId: 'D-1', base: 'main', head: 'd-story', title: 'D-1', body: 'b', blockedBy: [] };
  const run = (responses) => (command, args) => responses[`${command} ${args[0]}`] ?? { status: 0, stdout: '', stderr: '' };
  assert.throws(() => createPullRequest('/tmp', { ...plan2, blockedBy: ['D-1 has a commit waiting to be published; run singularity-flow sync D-1 first'] }, { runCommand: run({}) }),
    (error) => error.code === 'PULL_REQUEST_NOT_READY' && error.details.nextAction.command === 'singularity-flow sync D-1');
  assert.throws(() => createPullRequest('/tmp', plan2, { runCommand: run({ 'git remote': { status: 2, stdout: '', stderr: 'No such remote' } }) }),
    (error) => error.code === 'PULL_REQUEST_REMOTE_MISSING' && error.details.nextAction.command === 'singularity-flow pr describe D-1 --clipboard');
});
