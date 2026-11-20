/**
 * SFlow fills what it knows in the commands it hands an agent [owner, 2026-11-20].
 *
 * An approval's receipt token, a reviewed digest with its quoted reason, a conformance report's clause IDs: each was a
 * value SFlow computed and the model typed again, and each slip was a refusal. Now the approval's commands come filled,
 * a confirming command runs by its eight-character code, and prepare writes the clause column itself.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentAct } from '../src/agent-output.mjs';
import { approvalReceiptCommands } from '../src/choices.mjs';
import { confirmCommandByCode, resolveConfirmCode } from '../src/confirm-code.mjs';
import { scaffoldConformanceRows } from '../src/phase-authoring-contract.mjs';
import { sourceReviewDecisionPacket } from '../src/source-review-decision.mjs';

const TOKEN = '0b5c2f7e-8a41-4c3d-9e2f-1a2b3c4d5e6f';

async function codes(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sflow-fills-codes-'));
  const previous = process.env.SINGULARITY_FLOW_CONFIRM_CODES;
  process.env.SINGULARITY_FLOW_CONFIRM_CODES = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.SINGULARITY_FLOW_CONFIRM_CODES; else process.env.SINGULARITY_FLOW_CONFIRM_CODES = previous;
    await rm(directory, { recursive: true, force: true });
  });
}

test('an approval receipt hands back its filled commands: the Yes, then the approval, no token typed', () => {
  const receipt = { action: 'approve', token: TOKEN, workId: 'CALC-1', ready: false,
    choiceSets: [{ id: 'phase-confirmation', question: 'Approve Requirements v1?', options: [{ id: 'requirements', label: 'Approve Requirements v1' }] }], answers: {} };
  assert.deepEqual(approvalReceiptCommands(receipt), {
    answer: ['choices', 'answer', TOKEN, 'phase-confirmation', 'requirements', '--json'],
    approve: ['approve', 'requirements', '--work-id', 'CALC-1', '--fetch', '--selection-receipt', TOKEN, '--for-agent', '--json'] });
  assert.equal(approvalReceiptCommands({ ...receipt, action: 'start' }), null, 'only an approval\'s');
  // The review packet's act carries the Yes command where the question is asked.
  const act = agentAct({ approvalPacket: { review: {} }, approvalContext: { phase: 'requirements' }, ready: false, choiceSets: receipt.choiceSets,
    onYes: { command: `singularity-flow choices answer ${TOKEN} phase-confirmation requirements --json` } });
  assert.equal(act.state, 'ask-person');
  assert.equal(act.ask.onYes, `singularity-flow choices answer ${TOKEN} phase-confirmation requirements --json`);
  assert.match(act.ask.how, /On their Yes run ask\.onYes, then the next\.command its result returns when ready is true\./u);
});

test('a confirming route runs by its code: the digest and quoted words are never retyped, and the code stands for the exact command', async (t) => {
  await codes(t);
  const command = `singularity-flow phase rollover implementation --correction 'the user'"'"'s total' --confirm sha256:${'a'.repeat(64)} --json`;
  const byCode = confirmCommandByCode(command);
  assert.match(byCode, /^singularity-flow confirm [0-9A-Z]{4}-[0-9A-Z]{4} --json$/u, 'the same --json, never an added --for-agent');
  assert.equal(resolveConfirmCode(byCode.split(' ')[2]).command, command.replace(/ --json$/u, ''));
  assert.equal(confirmCommandByCode('singularity-flow status --json'), null, 'a command that confirms nothing has no code');
  const act = agentAct({ nextAction: { command, reason: 'Open version 4 for the correction.' } });
  assert.equal(act.state, 'confirm');
  assert.equal(act.do.shell, command, 'the person\'s own terminal keeps the whole command');
  assert.equal(act.do.confirm, byCode);
  assert.match(act.ask.how, /run do\.confirm \(do\.shell by its code\) once/u);
});

test('a source review disposition packet carries its command by code', async (t) => {
  await codes(t);
  const workflow = { workItem: { id: 'CALC-1' }, phases: { plan: { generation: 2 } } };
  const status = { reportSha256: 'b'.repeat(64), status: 'correction-required', generation: 2, reportPath: 'r.json',
    pendingDispositions: [{ id: 'not-applicable:CALC-1:REQ-003', kind: 'not-applicable' }] };
  const packet = sourceReviewDecisionPacket({ workflow, phaseId: 'plan', status, findingId: 'not-applicable:CALC-1:REQ-003',
    reason: "It's verified by the person's inspection.", actor: { email: 'reviewer@example.com' }, authority: { authorityGroup: 'leads' } });
  assert.match(packet.confirmCommand, /^singularity-flow confirm [0-9A-Z]{4}-[0-9A-Z]{4} --json$/u);
  assert.equal(resolveConfirmCode(packet.confirmCommand.split(' ')[2]).command, packet.commandGuidance.command.replace(/ --json$/u, ''));
});

test('prepare writes a conformance report\'s clause column, one row per approved clause, and leaves an authored table alone', () => {
  const template = ['# Release', '', '| Clause | Evidence | Verdict |', '|---|---|---|',
    '| `CALC-1:REQ-001` | TODO: exact source/test evidence | TODO: matched/partial/missing/deviated/unplanned |', ''].join('\n');
  const scaffolded = scaffoldConformanceRows(template, ['CALC-1:REQ-002', 'CALC-1:AC-001', 'CALC-1:REQ-001']);
  assert.deepEqual(scaffolded.split('\n').filter((line) => line.startsWith('| `')), [
    '| `CALC-1:AC-001` | TODO: exact source/test evidence | TODO: matched/partial/missing/deviated/unplanned |',
    '| `CALC-1:REQ-001` | TODO: exact source/test evidence | TODO: matched/partial/missing/deviated/unplanned |',
    '| `CALC-1:REQ-002` | TODO: exact source/test evidence | TODO: matched/partial/missing/deviated/unplanned |']);
  const authored = template.replace('TODO: exact source/test evidence | TODO: matched/partial/missing/deviated/unplanned', '`test/a.test.mjs` | matched');
  assert.equal(scaffoldConformanceRows(authored, ['CALC-1:REQ-002']), authored);
  assert.equal(scaffoldConformanceRows('# No table\n', ['CALC-1:REQ-001']), '# No table\n');
});
