import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalAgentResult } from '../src/approval-agent-result.mjs';
import { action, commandResult, effects, succeeded, validateCommandResult } from '../src/narration/command-result.mjs';
import { renderCommandResult } from '../src/narration/render-terminal.mjs';
import { redactDiagnosticText } from '../src/git-remote-diagnostics.mjs';

test('compact approval keeps receipt, identity warnings and final verdict without authoring instructions', () => {
  const result = commandResult({ operation: { id: 'approve', classification: 'mutation' }, subject: { kind: 'story', id: 'PMC-1' },
    outcome: succeeded('approve.succeeded', { phase: 'custom-step' }), effects: effects({ stateChanged: true }),
    data: { commit: 'a'.repeat(40), pushed: false, reviewer: 'Ada', authorityGroup: 'engineers', selfApproval: true,
      reviewPacketSha256: 'b'.repeat(64), artifactSetSha256: 'c'.repeat(64), finalCheck: { verified: false, errors: ['visual evidence missing'] } } });
  const compact = approvalAgentResult(result);
  assert.equal(compact.turnBoundary, 'end');
  assert.deepEqual(compact.effects, result.effects);
  assert.equal(compact.decision.reviewPacketSha256, result.data.reviewPacketSha256);
  assert.equal(compact.finalCheck.verified, false);
  assert.match(compact.warnings[0], /not independent/);
  assert.equal(compact.next[0].copilotCommand, '/sf-nextsteps');
  assert.equal(compact.next[0].modelFreeCommand, '@sflow /next');
  assert.doesNotMatch(JSON.stringify(compact.next), /prepare|sf-code|publish/);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 2048);
});

test('every rendered action shows three ordered surfaces without inventing unsupported @ routes', () => {
  const result = commandResult({ operation: { id: 'approve', classification: 'mutation' }, subject: null,
    outcome: succeeded('approve.succeeded', { phase: 'custom-step' }), effects: effects(), next: [
      action({ id: 'a', label: 'Inspect next', command: 'singularity-flow nextsteps --json' }),
      action({ id: 'b', label: 'Prepare draft', command: 'singularity-flow prepare custom-step' })] });
  const text = renderCommandResult(result);
  assert.match(text, /Copilot: \/sf-nextsteps\n\s+Shell: singularity-flow nextsteps --json\n\s+VS Code \(model-free\): @sflow \/next/);
  assert.match(text, /VS Code \(model-free\): not available for this action/);
  assert.throws(() => validateCommandResult({ ...result, next: [{ ...result.next[1], modelFreeCommand: '@sflow /publish other' }] }), /exact supported equivalent/);
});

test('human refusal lines survive redaction without exposing credentials or terminal escapes', () => {
  const redacted = redactDiagnosticText('Next:\nCopilot: /sf-submit\nShell: singularity-flow submit phase\npassword=secret-value\n\x1b[31munsafe', { multiline: true });
  assert.match(redacted, /^Next:\nCopilot: \/sf-submit\nShell:/);
  assert.doesNotMatch(redacted, /secret-value|\x1b/);
  assert.doesNotMatch(redactDiagnosticText('a\nb'), /\n/);
});
