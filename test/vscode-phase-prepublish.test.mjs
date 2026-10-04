import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { phasePrepublishDecision } = await import(path.join(
  root, 'apps/vscode/src/views/phase-prepublish.ts'
));
const { phaseGenerationChatPrefill } = await import(path.join(
  root, 'apps/vscode/src/views/submission-presentation.ts'
));

const expected = { workId: 'STORY-1', phaseId: 'implementation' };
const ready = {
  schemaVersion: 1, resultType: 'sflow-phase-prepublish',
  status: 'ready', workId: 'STORY-1', phase: 'implementation',
  findings: [], correction: { guidance: null },
  readiness: { lifecycle: true, authoring: true, knownRecoveryBlockers: true,
    publicationTransaction: 'not-run' },
  commands: { publish: 'singularity-flow phase publish implementation --authored governed-agent --channel copilot-host' },
  mutates: false, modelInvocations: 0
};

test('dependency warnings remain visible advisories and never become publication blockers', () => {
  const decision = phasePrepublishDecision({ ...ready,
    warnings: ['Approved input is advisory.', 'The recorded grounding is stale under warn policy.']
  }, expected);
  assert.equal(decision.ready, true);
  assert.deepEqual(decision.advisories, ['Approved input is advisory.', 'The recorded grounding is stale under warn policy.']);
});

test('VS Code Publish accepts only an exact fresh read-only ready projection', () => {
  assert.equal(phasePrepublishDecision(ready, expected).ready, true);
  const withPendingTests = phasePrepublishDecision({
    ...ready, testExecution: { status: 'not-run', commands: [] }
  }, expected);
  assert.equal(withPendingTests.ready, true);
  assert.match(withPendingTests.headline, /required tests run during publication/u);
  for (const result of [
    null, {},
    { ...ready, status: 'correction-required' },
    { ...ready, workId: 'OTHER-STORY' },
    { ...ready, phase: 'planning' },
    { ...ready, findings: [{ message: 'Tests failed.' }] },
    { ...ready, commands: { publish: null } },
    { ...ready, commands: { publish: 'singularity-flow phase publish planning --authored human' } },
    { ...ready, schemaVersion: 2 },
    { ...ready, resultType: 'sflow-phase-draft-check' },
    { ...ready, readiness: { ...ready.readiness, lifecycle: false } },
    { ...ready, readiness: { ...ready.readiness, authoring: false } },
    { ...ready, readiness: { ...ready.readiness, knownRecoveryBlockers: false } },
    { ...ready, readiness: { ...ready.readiness, publicationTransaction: 'complete' } },
    { ...ready, mutates: true },
    { ...ready, modelInvocations: 1 }
  ]) {
    assert.equal(phasePrepublishDecision(result, expected).ready, false, JSON.stringify(result));
  }
});

test('a correction names the current phase, bounded findings, and the owner skill', () => {
  const decision = phasePrepublishDecision({
    ...ready,
    status: 'correction-required',
    findings: [{ message: 'The required test command did not pass.' }],
    correction: { guidance: 'Correct the tests in this phase.', skill: '/sf-code' },
    commands: { publish: null, next: 'singularity-flow phase show implementation --json' }
  }, expected);
  assert.equal(decision.ready, false);
  assert.match(decision.headline, /implementation stopped/);
  assert.match(decision.details.join('\n'), /required test command did not pass/);
  assert.match(decision.details.join('\n'), /Next in Copilot: \/sf-code/);
  assert.equal(decision.skill, '/sf-code');
  assert.deepEqual(phaseGenerationChatPrefill(decision.skill), {
    query: '/sf-code ', isPartialQuery: true
  }, 'Fix in Copilot is a draft query, not execution');
  assert.match(decision.details.join('\n'), /Next in Shell: singularity-flow phase show implementation --json/);
  assert.match(decision.details.join('\n'), /phase prepublish implementation --json/);
  assert.ok(decision.details.every((detail) => !detail.includes('\n')));
  const unsupported = phasePrepublishDecision({
    ...ready, status: 'correction-required', findings: [{ message: 'Needs review.' }],
    correction: { skill: '/sf-code now', guidance: 'Review the source.' },
    commands: { publish: null }
  }, expected);
  assert.equal(unsupported.skill, null);
  assert.equal(phaseGenerationChatPrefill(unsupported.skill), null);
});

test('the VS Code Publish route checks after saved buffers and before any mutation', async () => {
  const extension = await readFile(path.join(root, 'apps/vscode/src/extension.ts'), 'utf8');
  const start = extension.indexOf("if (argv[0] === 'phase' && argv[1] === 'publish')");
  const route = extension.slice(start,
    extension.indexOf("if (argv[0] === 'session' && argv[1] === 'attach')", start));
  const save = route.indexOf('workbench.action.files.saveAll');
  const check = route.indexOf("['phase', 'prepublish', phaseId, '--json']");
  const mutation = extension.indexOf('runGovernedAction(client', start);
  assert.ok(save >= 0 && check > save && mutation > start + check,
    'Publish follows save → prepublish → mutation');
  assert.match(route, /if \(!gate\.ready\) \{/);
  assert.match(route, /repository !== checkedRepository/);
  assert.match(route, /repositoryEpoch\.isCurrent\(publishScope\)/);
  assert.match(route, /phaseGenerationChatPrefill\(gate\.skill\)/);
  assert.match(route, /'Fix in Copilot'/);
  assert.match(route, /workbench\.action\.chat\.open', correctionPrefill/);
  assert.match(route, /if \(choice === 'Show correction steps'\) output\.show\(true\)/);
  assert.match(route, /catch \(error\) \{\s*showRefusal\(error, \{ headline: `Could not check/);
});

test('documentation advisories ride along with a ready decision and never change it', () => {
  const decision = phasePrepublishDecision({
    ...ready,
    documentation: { status: 'missing', undocumented: 1, blocking: false },
    advisories: [{ code: 'code.documentation.missing', blocking: false, message: "Public function 'settle' in src/ledger.js:4 has no doc comment." }]
  }, expected);
  assert.equal(decision.ready, true);
  assert.deepEqual(decision.advisories, ["Public function 'settle' in src/ledger.js:4 has no doc comment."]);
  const unavailable = phasePrepublishDecision({
    ...ready, documentation: { status: 'unavailable', reason: 'diff-unavailable', blocking: false }, advisories: []
  }, expected);
  assert.equal(unavailable.ready, true);
  assert.deepEqual(unavailable.advisories, ['The documentation check could not run (diff-unavailable); it never blocks publication.']);
  assert.deepEqual(phasePrepublishDecision(ready, expected).advisories, []);
});

test('a correction that restates the blocking finding is shown once, in its fuller form', () => {
  const sentence = `Phase 'verify' requires current Code evidence: source or tests changed after their approved execution: src/value.mjs. Return them with: singularity-flow reject verify --to implement --repair --reason <REASON>. They stay in your worktree; nothing was reverted or adopted. They change QF-GUI:AC-001, owned by implement.`;
  const decision = phasePrepublishDecision({
    ...ready, phase: 'verify', status: 'correction-required',
    findings: [{ message: sentence }],
    correction: { guidance: sentence },
    commands: { publish: null, next: 'singularity-flow reject verify --to implement --repair --reason <REASON>' }
  }, { workId: 'STORY-1', phaseId: 'verify' });
  assert.equal(decision.ready, false);
  assert.deepEqual(decision.details, [
    sentence,
    'Next in Shell: singularity-flow reject verify --to implement --repair --reason <REASON>',
    'Shell: singularity-flow phase prepublish verify --json'
  ]);
});
