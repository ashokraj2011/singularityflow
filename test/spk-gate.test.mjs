/**
 * The marker and specification-quality gates, at the boundaries that enforce them. `[SPK:AC-002]`
 *
 * The modules that decide what is wrong with a specification were already covered by
 * `spk-quality.test.mjs`. What is covered here is the thing that makes them matter: that
 * `publishGeneration` and `submitPhase` actually consult them, and that a refusal leaves nothing
 * behind `[SPK:REQ-065]`.
 *
 * That distinction is not academic in this codebase. The recurring defect is a policy that loads,
 * validates and resolves correctly, and is then read by nobody — indistinguishable from a working
 * one until someone drives the product. So these tests use the real `publishGeneration` against a
 * real git repository, not a stub of it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializeDefinition, resolveWorkType } from '../src/config.mjs';
import { buildGenerationAuthorship, normalizeAuthorshipOptions } from '../src/manual-authorship.mjs';
import { withOperationContext } from '../src/operation-context.mjs';
import { setAgentSession } from '../src/session.mjs';
import { createStoryReviewPacket } from '../src/story-lineage.mjs';
import { evaluateApprovalChecklist, priorChecklistExceptions } from '../src/specification-gate.mjs';
import { STARTER_CHECKLIST } from '../src/specification-quality.mjs';
import { approvePhase, createWorkflow, loadConfig, publishGeneration, scanArtifacts, submitPhase } from '../src/state.mjs';

const ACTOR = { name: 'Gate Driver', email: 'gate@example.invalid', login: null };

function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

const MARKER = 'may an operator retry a payment more than three times?';

function spec({ marker = false, sections = true, answered = false } = {}) {
  return [
    '# Specification — Retry a failed payment', '',
    ...(sections ? [
      '## Actors', '', 'An operator holding the payments role, and the payments provider.', '',
      '## User scenarios', '',
      'Given a payment that failed at the provider, when an operator retries it, then a new attempt',
      'is created and the original failed attempt is preserved for audit.', ''
    ] : []),
    '## Requirements', '',
    '- The system creates a new attempt when an operator retries a failed payment. [DRIVE:REQ-001]',
    '- The system preserves the original failed attempt and its provider response. [DRIVE:REQ-002]',
    ...(answered ? ['- An operator may make at most three attempts; the fourth moves the payment to manual review. [DRIVE:REQ-003]'] : []),
    '',
    ...(marker ? [`[NEEDS CLARIFICATION: ${MARKER}]`, ''] : []),
    'Retry is idempotent per attempt identifier, so a duplicated request never charges twice.', '',
    '## Evidence boundaries', '',
    'Verification must observe the new attempt identifier, the preserved provider response, and the absence of a second charge for a duplicated request.', ''
  ].join('\n');
}

/**
 * A governed Story on the spec-driven profile, with the marker policy under test.
 *
 * `markers` and `quality` are written onto the resolution the Story pins, which is the same place
 * `resolveWorkType` puts them and the same place the gate reads them from.
 */
async function story(name, { markers = 'block', quality = 'enforce' } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `sflow-gate-${name}-`));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', ACTOR.name);
  git(root, 'config', 'user.email', ACTOR.email);
  await writeFile(path.join(root, 'README.md'), '# Payments\n');
  await initializeDefinition(root);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initialize repository');
  git(root, 'switch', '-c', 'DRIVE-1');

  const config = await loadConfig(root);
  config.git.publish = 'off';
  for (const authority of Object.values(config.approvalAuthorities ?? {})) {
    authority.allowAnyGitIdentity = false;
    authority.members = [ACTOR];
  }
  const resolved = resolveWorkType(config, 'spec-driven-standard');
  const specification = resolved.phases.find((phase) => phase.id === 'specification');
  resolved.phases = [{
    ...specification,
    order: 0,
    clarification: { ...specification.clarification, mode: 'off', markers: { mode: markers } },
    specificationQuality: { ...specification.specificationQuality, mode: quality },
    approval: { mode: 'none', authorities: [], minimum: 0, rejectTo: ['specification'] }
  }];
  await setAgentSession(root, config, ACTOR, 'product-owner', 'DRIVE-1', { phaseId: 'specification', source: 'test' });
  return { root, config, resolved };
}

function inContext(root, run) {
  return withOperationContext({
    operation: { id: 'test.spk-gate', command: 'test', modelPolicy: 'never' },
    modelMode: { enabled: false, source: 'test' },
    root,
    command: 'test'
  }, run);
}

async function begin(root, config, resolved) {
  return createWorkflow(root, config, {
    id: 'DRIVE-1',
    title: 'Retry a failed payment',
    source: { type: 'manual', key: 'DRIVE-1', title: 'Retry a failed payment', description: 'Let an operator retry a payment that failed at the provider.', acceptanceCriteria: ['A retry creates a new attempt.'] },
    baseBranch: 'main',
    workType: 'spec-driven-standard',
    agent: 'product-owner',
    resolved
  });
}

async function author(root, workflow, markdown) {
  const target = path.join(root, 'singularity', 'work-items', 'DRIVE-1', workflow.phases.specification.requiredArtifact.path);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, markdown);
  return target;
}

const AUTHORSHIP = buildGenerationAuthorship({
  options: normalizeAuthorshipOptions({ producer: 'human', channel: 'manual-in-place', externalAiUse: 'none' }),
  actor: ACTOR,
  governedAgentContext: 'product-owner',
  source: null
});

/**
 * A clarification answer bound to a marker, at the path the contract writes it to.
 *
 * The `clarification record --marker` command produces this record and was driven end-to-end against
 * a real Story; reproducing that here would mean building a world model and composing a governed
 * prompt to assert something about a different module. The gate's real input is this file at this
 * path, so this fixture is the gate's real input.
 */
async function answerMarker(root, question, generation) {
  const file = path.join(root, 'singularity', 'work-items', 'DRIVE-1', 'context', `clarifications-specification-gen${generation}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    schemaVersion: 1, workId: 'DRIVE-1', phase: 'specification', generation, mode: 'required',
    responses: [{
      id: 'Q-001', question, answer: 'No. Three attempts, then the payment moves to manual review.',
      status: 'answered', blocking: false, marker: { question, questionHash: question }
    }],
    completed: true, recordedAt: '2026-01-01T00:00:00.000Z', recordedBy: ACTOR, agent: 'product-owner'
  }, null, 2));
}

test('block refuses publication with an open marker, and changes nothing', async () => {
  const { root, config, resolved } = await story('block');
  await inContext(root, async () => {
    const workflow = await begin(root, config, resolved);
    await author(root, workflow, spec({ marker: true }));
    await scanArtifacts(root, config, workflow, 'specification');
    const before = JSON.stringify(workflow.phases.specification);

    await assert.rejects(
      () => publishGeneration(root, config, workflow, { phaseId: 'specification', authorship: AUTHORSHIP }),
      /unresolved clarification marker/
    );

    // `[SPK:REQ-065]` asks for the refusal to land *before any state mutation*, and the reason is
    // behavioural: if an honest question costs a half-published generation to unwind, the rational
    // move is to delete the question. So the phase must be untouched, not merely rolled back.
    assert.equal(workflow.phases.specification.generation, 0, 'the generation counter advanced past a refusal');
    assert.equal(JSON.stringify(workflow.phases.specification), before, 'the refused publication mutated phase state');
  });
});

test('the answer has to reach the document, not only the record', async () => {
  // The half of `[SPK:REQ-067]` that is easy to lose: filing an answer while leaving the marker in
  // the text would publish a specification that still asks the question.
  const { root, config, resolved } = await story('filed');
  await inContext(root, async () => {
    const workflow = await begin(root, config, resolved);
    await answerMarker(root, MARKER, 1);
    await author(root, workflow, spec({ marker: true }));
    await scanArtifacts(root, config, workflow, 'specification');

    await assert.rejects(
      () => publishGeneration(root, config, workflow, { phaseId: 'specification', authorship: AUTHORSHIP }),
      /unresolved clarification marker/
    );

    // Removing it, with the answer already on record, is resolution — and publishes.
    await author(root, workflow, spec({ answered: true }));
    await scanArtifacts(root, config, workflow, 'specification');
    await publishGeneration(root, config, workflow, { phaseId: 'specification', authorship: AUTHORSHIP });
    assert.equal(workflow.phases.specification.generation, 1);

    const ledger = workflow.phases.specification.markers.at(-1);
    assert.equal(ledger.generation, 1);
    assert.deepEqual(ledger.open, []);
    assert.equal(ledger.markerMode, 'block');
    assert.equal(ledger.findings, 0);
    assert.match(ledger.artifactSha256, /^[0-9a-f]{64}$/);
  });
});

test('warn publishes an open marker, and reports it when it later disappears unanswered', async () => {
  const { root, config, resolved } = await story('warn', { markers: 'warn' });
  await inContext(root, async () => {
    const workflow = await begin(root, config, resolved);
    await author(root, workflow, spec({ marker: true }));
    await scanArtifacts(root, config, workflow, 'specification');
    await publishGeneration(root, config, workflow, { phaseId: 'specification', authorship: AUTHORSHIP });

    // Under `warn` the marker reaches a governed generation, which is what gives the next one
    // something to notice it vanishing from.
    assert.deepEqual(workflow.phases.specification.markers.at(-1).open.map((entry) => entry.question), [MARKER]);

    git(root, 'add', '.');
    git(root, 'commit', '-m', '[DRIVE-1][phase:specification][generated:1] publish');

    // Generation 2 simply deletes the question. No answer anywhere.
    await author(root, workflow, spec({ answered: true }));
    await scanArtifacts(root, config, workflow, 'specification');
    const warnings = [];
    const original = console.warn;
    console.warn = (message) => warnings.push(String(message));
    try { await publishGeneration(root, config, workflow, { phaseId: 'specification', authorship: AUTHORSHIP }); }
    finally { console.warn = original; }

    assert.ok(
      warnings.some((message) => /clarification marker removed without a recorded answer/.test(message)),
      `deleting a question passed silently: ${JSON.stringify(warnings)}`
    );
  });
});

test('the default is off, so an ungoverned Story sees no new gate', async () => {
  // Every existing repository pins nothing. A marker-shaped string in an artifact must behave
  // exactly as it did before this feature existed.
  const { root, config, resolved } = await story('off', { markers: 'off', quality: 'off' });
  await inContext(root, async () => {
    const workflow = await begin(root, config, resolved);
    await author(root, workflow, spec({ marker: true, sections: false }));
    await scanArtifacts(root, config, workflow, 'specification');
    await publishGeneration(root, config, workflow, { phaseId: 'specification', authorship: AUTHORSHIP });
    assert.equal(workflow.phases.specification.generation, 1);
    assert.equal(workflow.phases.specification.markers, undefined, 'an off policy still wrote a marker ledger');
  });
});

test('specification quality enforces the findings markers do not own', async () => {
  const { root, config, resolved } = await story('quality', { markers: 'off', quality: 'enforce' });
  await inContext(root, async () => {
    const workflow = await begin(root, config, resolved);
    await author(root, workflow, spec({ sections: false }));
    await scanArtifacts(root, config, workflow, 'specification');
    await assert.rejects(
      () => publishGeneration(root, config, workflow, { phaseId: 'specification', authorship: AUTHORSHIP }),
      /has no 'Actors' section/
    );
  });
});

test('submission re-reads the artifact, so a policy tightened after publication still bites', async () => {
  const { root, config, resolved } = await story('submit', { markers: 'warn' });
  await inContext(root, async () => {
    const workflow = await begin(root, config, resolved);
    await author(root, workflow, spec({ marker: true }));
    await scanArtifacts(root, config, workflow, 'specification');
    await publishGeneration(root, config, workflow, { phaseId: 'specification', authorship: AUTHORSHIP });
    git(root, 'add', '.');
    git(root, 'commit', '-m', '[DRIVE-1][phase:specification][generated:1] publish');

    // The Story now pins `block`. The published generation was legal when it was made; asking other
    // people to review it is a separate decision, and this is where that decision is taken.
    workflow.resolution.phases.find((phase) => phase.id === 'specification').clarification.markers = { mode: 'block' };
    await assert.rejects(
      () => submitPhase(root, config, workflow, { phaseId: 'specification', runChecks: false }),
      /cannot be submitted for approval[\s\S]*unresolved clarification marker/
    );
    assert.equal(workflow.phases.specification.submittedAt, null, 'a refused submission recorded a submission time');
  });
});

test('an approval without its checklist is not an approval', async () => {
  // `[SPK:REQ-060]` `[SPK:REQ-181]`. The reviewer's confirmation is the product of this phase; an
  // approval that skips it records agreement nobody expressed.
  const { root, config, resolved } = await story('checklist', { markers: 'off', quality: 'enforce' });
  resolved.phases[0].approval = {
    authorities: ['product-approvers'], minimum: 1, rejectTo: ['specification'], allowSelfApproval: true
  };
  await inContext(root, async () => {
    const workflow = await begin(root, config, resolved);
    await author(root, workflow, spec({}));
    await scanArtifacts(root, config, workflow, 'specification');
    await publishGeneration(root, config, workflow, { phaseId: 'specification', authorship: AUTHORSHIP });
    git(root, 'add', '.');
    git(root, 'commit', '-m', '[DRIVE-1][phase:specification][generated:1] publish');
    await submitPhase(root, config, workflow, { phaseId: 'specification', runChecks: false });
    assert.equal(workflow.phases.specification.status, 'awaiting_approval');
    await createStoryReviewPacket(root, config, workflow, workflow.phases.specification);
    git(root, 'add', '.');
    git(root, 'commit', '-m', '[DRIVE-1][phase:specification][submit] immutable review evidence');

    await assert.rejects(
      () => approvePhase(root, config, workflow, { phaseId: 'specification', persist: false }),
      /checklist article 'completeness' has no decision/
    );

    const decisions = STARTER_CHECKLIST.articles.map((article) => ({ article: article.id, decision: 'satisfied' }));
    // An exception is a considered choice, so it carries a reason `[SPK:REQ-061]`.
    const unreasoned = [...decisions.slice(0, 5), { article: 'non-functional', decision: 'exception' }];
    await assert.rejects(
      () => approvePhase(root, config, workflow, { phaseId: 'specification', checklist: unreasoned, persist: false }),
      /needs a human-authored reason/
    );

    const { approval } = await approvePhase(root, config, workflow, {
      phaseId: 'specification',
      checklist: [...decisions.slice(0, 5), { article: 'non-functional', decision: 'exception', reason: 'Internal tool; no external SLA.' }],
      persist: false
    });
    assert.equal(approval.checklist.length, 6);
    assert.equal(approval.checklist.at(-1).reason, 'Internal tool; no external SLA.');
    assert.match(approval.checklistSha256, /^[0-9a-f]{64}$/);

    // And the packet shows the next reviewer what was let through `[SPK:REQ-059]`.
    assert.deepEqual(
      priorChecklistExceptions(workflow.phases.specification).map((entry) => entry.article),
      ['non-functional']
    );
  });
});

test('an exception authority narrows who may take one', async () => {
  // `[SPK:REQ-061]`. Never a way to make an exception cheaper — only dearer.
  const { root, config, resolved } = await story('authority', { markers: 'off', quality: 'enforce' });
  const policy = { mode: 'enforce', checklist: 'requirements-quality-v1', exceptionAuthority: 'architecture-reviewers' };
  const authorities = { 'architecture-reviewers': { label: 'Architecture reviewers', allowAnyGitIdentity: false, members: [{ email: 'architect@example.invalid' }] } };
  const decisions = [
    ...STARTER_CHECKLIST.articles.slice(0, 5).map((article) => ({ article: article.id, decision: 'satisfied' })),
    { article: 'non-functional', decision: 'exception', reason: 'Internal tool.' }
  ];

  const refused = evaluateApprovalChecklist({ policy, decisions, authorities, actor: ACTOR });
  assert.equal(refused.errors.length, 1);
  assert.match(refused.errors[0], /requires membership of the 'architecture-reviewers' authority/);

  const allowed = evaluateApprovalChecklist({
    policy, decisions, authorities, actor: { name: 'Architect', email: 'architect@example.invalid', login: null }
  });
  assert.deepEqual(allowed.errors, []);

  // Satisfying every article needs no special authority; the narrowing is about exceptions alone.
  const satisfied = STARTER_CHECKLIST.articles.map((article) => ({ article: article.id, decision: 'satisfied' }));
  assert.deepEqual(evaluateApprovalChecklist({ policy, decisions: satisfied, authorities, actor: ACTOR }).errors, []);
  assert.equal(root.length > 0, true);
});

test('the analyzer report and the gate are the same evaluation', async () => {
  // `spec analyze` promises to show what a publish would say. It keeps that promise by calling the
  // same function, so the two can only disagree if this stops being true.
  const gate = await readFile(new URL('../src/specification-gate.mjs', import.meta.url), 'utf8');
  const cli = await readFile(new URL('../src/cli.mjs', import.meta.url), 'utf8');
  const state = await readFile(new URL('../src/state.mjs', import.meta.url), 'utf8');
  assert.ok(gate.includes('export async function evaluateSpecificationGate'));
  assert.match(cli, /evaluateSpecificationGate\(root, config, workflow, phase/, 'spec analyze does not use the gate');
  assert.equal(
    state.match(/evaluateSpecificationGate\(/g)?.length, 2,
    'the gate must be called at exactly the two boundaries [SPK:REQ-065] names: publication and submission'
  );
});
