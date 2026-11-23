/**
 * A person overrides a blocking finding the check got wrong (owner, 2026-11-23: "we should be able to override this",
 * "any blocking finding").
 *
 * - The finding is keyed by its code, file and clause on its step, never by its words.
 * - What a person may override is any finding a check raises about the step's own document. Never: integrity or a
 *   secret, a failing test, the code delivery check (which has its own dispute), a missing document, or an answer owed.
 * - Prepublish, publication and submission honour the same override, because the checks honour it themselves. A route
 *   offers it only where its gate does.
 * - It is a person's decision: on the decision list (the Decide card, /sf-decide after their Yes, `decisions record`) or
 *   `decision override-finding` in their terminal, under the step's approval rules, with their own reason.
 * - The approvers see it, and it is recorded as overridden, never passed.
 * - A later version is checked afresh.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { activeFindingOverrides, findingOverrideBar, findingOverrideKey, honourOverrides, overrideGeneration, recordFindingOverride } from '../src/finding-overrides.mjs';
import { phasePrepublish } from '../src/phase-prepublish.mjs';
import { inspectPhaseAuthoredReviewContent } from '../src/publication-preflight.mjs';
import { phaseResolutionChoices } from '../src/phase-resolution.mjs';
import { decisionPacket, optionOutcome } from '../src/decision-list.mjs';
import { withPlainWords } from '../src/decision-plain.mjs';
import { ANSWER_BOUND_STEPS, PERSON_DECISIONS, PERSON_STEP_FAMILIES } from '../src/person-step-catalog.mjs';
import { REASON_RULES } from '../src/copilot-answer-binding.mjs';
import { argvAllowed } from '../src/copilot-mutation-guard.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(packageRoot, 'bin', 'singularity-flow.mjs');
const REASON = 'The TODO is the product name of the to-do list feature, not unfinished text.';
const AT = '2026-11-23T09:00:00.000Z';

const placeholder = (extra = {}) => ({ code: 'artifact.placeholder.unresolved', category: 'authoring', path: 'singularity/work-items/D-1/artifacts/verification/report.md',
  line: 4, value: 'TODO', message: 'contains unresolved placeholder TODO', ...extra });
const storyAt = (overrides = []) => ({ workItem: { id: 'D-1' }, status: 'in_progress', currentPhase: 'verification', phaseOrder: ['verification'],
  phases: { verification: { id: 'verification', label: 'Verification', status: 'in_progress', generation: 11, approvalPolicy: { authorities: ['qa'] } } },
  resolution: { phases: [], approvalAuthorities: { qa: { label: 'QA', allowAnyGitIdentity: true, members: [] } } }, findingOverrides: overrides });

test('a finding is keyed by its code, file and clause on its step, never by its words or line', () => {
  const key = findingOverrideKey('verification', placeholder());
  assert.match(key, /^CHK-[a-f0-9]{12}$/u);
  assert.equal(findingOverrideKey('verification', placeholder({ line: 40, message: 'reworded' })), key, 'rewording or moving a line keeps it');
  assert.notEqual(findingOverrideKey('verification', placeholder({ path: 'other.md' })), key);
  assert.notEqual(findingOverrideKey('planning', placeholder()), key, 'another step');
  // A check may name the clause as value, clauseId or details.clauseId: one key, so prepublish and publication agree.
  const row = { code: 'conformance.clause-row-missing', path: 'r.md' };
  const keys = [{ ...row, value: 'D-1:AC-001' }, { ...row, clauseId: 'D-1:AC-001' }, { ...row, details: { clauseId: 'D-1:AC-001' } }]
    .map((finding) => findingOverrideKey('verification', finding));
  assert.equal(new Set(keys).size, 1, keys.join(' '));
});

test('a person may override what a check says about the step\'s own document, and nothing that guards integrity, a test or an answer', () => {
  for (const finding of [placeholder(), { code: 'conformance.witness-uncited', category: 'evidence', path: 'r.md', value: 'D-1:AC-001' },
    { code: 'specification.scope-unlinked', category: 'specification-quality', path: 's.md' }, { code: 'conformance.clause-row-missing', category: 'traceability', path: 'r.md' }]) {
    assert.equal(findingOverrideBar(finding), null, finding.code);
  }
  const barred = [
    [{ code: 'SECRET_FOUND', category: 'authoring' }, /integrity, an authority or a secret/u],
    [{ code: 'CODE_TEST_FAILED', category: 'tests' }, /failing test has its own accepted risk/u],
    [{ code: 'code.delivery.source-clause-tag-missing', category: 'traceability' }, /code delivery check has its own dispute/u],
    [{ code: 'artifact.required.missing', category: 'authoring', path: 'r.md' }, /document itself is missing/u],
    [{ code: 'specification.clarification', category: 'clarification' }, /not about the step's own document \(human-input\)/u],
    [{ ...placeholder(), blocking: false }, /advisory/u]
  ];
  for (const [finding, why] of barred) assert.match(findingOverrideBar(finding), why, finding.code);
});

test('an override stops that finding blocking that version only; the rest still block and each says it may be overridden', () => {
  const workflow = storyAt();
  const phase = workflow.phases.verification;
  const target = placeholder();
  const key = findingOverrideKey('verification', target);
  assert.throws(() => recordFindingOverride(structuredClone(workflow), { phase: 'verification', generation: 12, finding: { key, ...target }, reason: 'too short', actor: 'ana', authorityGroup: 'qa', at: AT }),
    /in your own words: 20 to 1000 characters \(this one has 9\)\. Nothing was recorded\./u);
  const record = recordFindingOverride(workflow, { phase: 'verification', generation: 12, finding: { key, ...target }, reason: REASON, actor: 'ana', authorityGroup: 'qa', at: AT });
  assert.equal(record.id, 'FOV-001');
  const other = { code: 'conformance.witness-uncited', category: 'evidence', path: 'r.md', value: 'D-1:AC-002', message: 'Cite WIT-002 there.' };
  const secret = { code: 'SECRET_FOUND', category: 'authoring', path: 'r.md' };
  const honoured = honourOverrides(workflow, phase, [target, other, secret], { generation: 12 });
  assert.deepEqual(honoured.findings.map((finding) => finding.code), ['conformance.witness-uncited', 'SECRET_FOUND']);
  assert.deepEqual(honoured.overridden.map((finding) => [finding.code, finding.overriddenBy.id, finding.overriddenBy.reason]), [['artifact.placeholder.unresolved', 'FOV-001', REASON]]);
  assert.match(honoured.findings[0].override.key, /^CHK-/u, 'an overridable finding says so, with its key');
  assert.equal(honoured.findings[1].override, undefined, 'a secret is never offered');
  // Another version is checked afresh; a withdrawn override counts for nothing.
  assert.equal(honourOverrides(workflow, phase, [target], { generation: 13 }).overridden.length, 0);
  workflow.findingOverrides[0].withdrawnAt = AT;
  assert.deepEqual(activeFindingOverrides(workflow, phase, 12), []);
});

test('prepublish and publication honour the same override, and the route offers it only where the gate does', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-override-gates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const relative = 'singularity/work-items/PRE-1/artifacts/planning/plan.md';
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), '# Plan\n\nThe TODO list screen keeps every item the person adds.\n');
  const phase = { id: 'planning', label: 'Planning', status: 'in_progress', generation: 0, approvalPolicy: { authorities: ['architects'] },
    generationPolicy: { defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: 'artifacts/planning/plan.md', minimumBytes: 20, validation: { requiredHeadings: ['Plan'], forbiddenPlaceholders: [] } }, artifacts: [] };
  const workflow = { workItem: { id: 'PRE-1' }, status: 'in_progress', currentPhase: 'planning', phaseOrder: ['planning'],
    resolution: { phases: [], artifactSets: {} }, phases: { planning: phase } };
  const config = { workItemRoot: 'singularity/work-items' };
  const session = { workId: 'PRE-1', phaseId: 'planning', agent: 'architect' };

  const before = await phasePrepublish(root, config, workflow, phase, { session });
  const finding = before.findings.find((entry) => entry.code === 'artifact.placeholder.unresolved');
  assert.ok(finding?.override?.key, JSON.stringify(before.findings));
  assert.equal(before.status, 'correction-required');
  // Its route names the override for the step's approvers, never as the agent's decision.
  const { choices } = phaseResolutionChoices(workflow, phase, finding);
  const override = choices.find((choice) => choice.kind === 'override');
  assert.deepEqual(override.argv, ['decision', 'override-finding', 'PRE-1', '--phase', 'planning', '--finding', finding.override.key, '--reason', '<why>']);
  assert.equal(override.owner, 'phase-approval-authority');
  assert.match(override.detail, /shows as overridden, never passed\. Never the agent's decision\.$/u);
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'SECRET_FOUND', category: 'authoring' }).choices.some((choice) => choice.kind === 'override'), false);

  recordFindingOverride(workflow, { phase: 'planning', generation: overrideGeneration(workflow, phase), finding: { key: finding.override.key, ...finding },
    reason: REASON, actor: 'ana', authorityGroup: 'architects', at: AT });
  const after = await phasePrepublish(root, config, workflow, phase, { session });
  assert.ok(!after.findings.some((entry) => entry.code === 'artifact.placeholder.unresolved'), JSON.stringify(after.findings));
  assert.deepEqual(after.overridden?.map((entry) => entry.overriddenBy.reason), [REASON]);
  // Publication's own content gate reads the same check, so it agrees.
  assert.deepEqual((await inspectPhaseAuthoredReviewContent(root, config, workflow, phase, { transition: 'publish' }))
    .filter((entry) => entry.code === 'artifact.placeholder.unresolved'), []);
});

test('the decision list offers each overridable finding as a row a person answers with their reason; never recommended, never asked in chat', () => {
  const workflow = storyAt();
  const facts = { phaseId: 'verification', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [], testRisks: [], unavailable: [], state: {}, pending: {},
    findingOverrides: { phase: 'verification', generation: 12, overridden: [],
      findings: [{ key: 'CHK-0123456789ab', code: 'conformance.witness-uncited', path: 'r.md', line: 559, value: 'D-1:AC-001', message: 'Line 559 marks D-1:AC-001 proved; its proof is WIT-001. Cite WIT-001 there.' }] } };
  const actor = { name: 'Ana Approver', email: 'ana@example.invalid', login: null };
  const packet = withPlainWords(workflow, decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities, actor, at: AT }));
  const row = packet.offered.find((item) => item.kind === 'check-finding');
  assert.ok(row, JSON.stringify(packet.offered.map((item) => item.kind)));
  assert.equal(row.plain.question, 'Override the check\'s finding conformance.witness-uncited on Verification version 12?');
  assert.equal(row.optional, true);
  assert.equal(row.holds, 'nothing');
  assert.equal(row.recommended.option, null, 'an override goes against the check: never recommended');
  const [option] = row.options;
  assert.equal(option.label, 'Override: the check is wrong');
  assert.equal(option.outcome, 'override');
  assert.equal(optionOutcome(row, option), 'override');
  assert.deepEqual(option.needs.reason, { default: '', minimum: 20, maximum: 1000 });
  assert.deepEqual(option.effects, [{ kind: 'finding-override', phase: 'verification', finding: 'CHK-0123456789ab', generation: 12 }]);
  assert.equal(option.terminal, 'singularity-flow decision override-finding D-1 --phase verification --finding CHK-0123456789ab --reason "<REASON>"');
  assert.equal(option.decidedBy.allowed, true);
});

test('the approvers see each override with who and why beside the approval', () => {
  const workflow = storyAt([{ id: 'FOV-001', phase: 'verification', generation: 11, finding: 'CHK-0123456789ab', code: 'conformance.witness-uncited', path: 'r.md',
    value: 'D-1:AC-001', message: 'Cite WIT-001 there.', reason: REASON, actor: 'ana', authorityGroup: 'qa', at: AT }]);
  workflow.phases.verification.status = 'awaiting_approval';
  const facts = { phaseId: 'verification', at: AT, gaps: [], issues: [], candidates: [], reuseProblems: [], testRisks: [], unavailable: [], state: {}, pending: {} };
  const packet = decisionPacket(workflow, facts, { authorities: workflow.resolution.approvalAuthorities, actor: { name: 'Bo', email: 'bo@example.invalid' }, at: AT });
  const approval = [...packet.items, ...(packet.next ? [packet.next] : [])].find((item) => item.kind === 'approval');
  assert.ok(approval, JSON.stringify(packet.items.map((item) => item.kind)));
  assert.ok(JSON.stringify(approval).includes(`conformance.witness-uncited on r.md was overridden by ana: \\"${REASON}\\". Recorded as overridden, not passed.`), JSON.stringify(approval.details ?? approval).slice(0, 2000));
});

test('an override is a person\'s decision: a bound Yes in /sf-decide with their reason, signed under SF Guard like the others', () => {
  assert.deepEqual(PERSON_DECISIONS.find((step) => step.id === 'finding-override')?.owners, ['decide']);
  const argv = ['decision', 'override-finding', 'D-1', '--phase', 'verification', '--finding', 'CHK-0123456789ab', '--reason', REASON];
  const turn = { contract: { workId: 'D-1', phaseId: 'verification' }, decisionEnded: false };
  assert.equal(argvAllowed(argv, 'decision-only', turn), true);
  assert.equal(argvAllowed([...argv, '--json'], 'decision-only', turn), true);
  // Another Story, no reason, or any other option: refused in the turn.
  assert.equal(argvAllowed(['decision', 'override-finding', 'D-2', '--finding', 'CHK-0123456789ab', '--reason', REASON], 'decision-only', turn), false);
  assert.equal(argvAllowed(['decision', 'override-finding', 'D-1', '--finding', 'CHK-0123456789ab'], 'decision-only', turn), false);
  assert.equal(argvAllowed([...argv, '--fetch'], 'decision-only', turn), false);
  assert.equal(argvAllowed(argv, 'decision-only', { ...turn, decisionEnded: true }), false);
  assert.ok(ANSWER_BOUND_STEPS.includes('finding-override'));
  assert.deepEqual(REASON_RULES['decision override-finding'], { reason: [20, 1000] });
  assert.deepEqual(PERSON_STEP_FAMILIES.find((row) => row.id === 'finding-override'),
    { id: 'finding-override', list: 'findingOverrides', action: 'decision.override-finding', label: 'Finding override', isPerson: PERSON_STEP_FAMILIES.find((row) => row.id === 'finding-override').isPerson });
});

test('on a real Story: the check blocks the draft, a person overrides it in their terminal, and prepublish lets the version through', async (t) => {
  const WORK = 'OVR-1';
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-override-story-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const env = { ...process.env, NODE_ENV: 'test' };
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Ana Approver'); git('config', 'user.email', 'ana@example.test');
  await writeFile(path.join(root, 'README.md'), '# Override fixture\n');
  const [{ initializeDefinition, resolveWorkType }, { setAgentSession }, { withOperationContext }, { createWorkflow, loadConfig, scanArtifacts }] = await Promise.all([
    import('../src/config.mjs'), import('../src/session.mjs'), import('../src/operation-context.mjs'), import('../src/state.mjs')]);
  await initializeDefinition(root);
  const workflowFile = path.join(root, 'singularity/workflow.yml');
  const authored = YAML.parse(await readFile(workflowFile, 'utf8'));
  authored.git.publish = 'off';
  for (const authority of Object.values(authored.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  for (const step of Object.values(authored.phases ?? {})) if (step.approval && step.approval !== 'none') step.approval.allowSelfApproval = true;
  await writeFile(workflowFile, YAML.stringify(authored));
  git('add', '.'); git('commit', '-m', 'Initialize'); git('switch', '-c', WORK);
  const config = await loadConfig(root);
  const resolved = resolveWorkType(config, 'spec-driven-standard');
  const phaseId = resolved.phases[0].id;
  const actor = { name: 'Ana Approver', email: 'ana@example.test' };
  await setAgentSession(root, config, actor, resolved.phases[0].defaultAgent, WORK, { phaseId, source: 'test' });
  const workflow = await withOperationContext({ operation: { id: 'test.override', command: 'test', modelPolicy: 'never' }, modelMode: { enabled: false, source: 'test' }, root, command: 'test' },
    () => createWorkflow(root, config, { id: WORK, title: 'Keep a to-do list', baseBranch: 'main', workType: 'spec-driven-standard', agent: resolved.phases[0].defaultAgent, resolved,
      source: { type: 'manual', key: WORK, title: 'Keep a to-do list', description: 'Keep a to-do list.', acceptanceCriteria: ['Adding an item keeps it.'], notes: '' } }));
  const artifact = path.join(root, 'singularity/work-items', WORK, workflow.phases[phaseId].requiredArtifact.path);
  await mkdir(path.dirname(artifact), { recursive: true });
  await writeFile(artifact, `# Specification — ${WORK}\n## Agent brief\nMembers keep a TODO list of items.\n## Actors\nMember\n## User scenarios\n### S1 — Add an item\n- Given the list, when an item is added, then it is kept.\n`
    + `## Failure and empty states\nAn empty list shows no items.\n## Permissions\nThe member edits their own list.\n## Boundary conditions\nThe list holds up to 100 items.\n`
    + `## Requirements\n- Keep each added item. (S1) [${WORK}:REQ-001]\n- Show the kept items. (S1) [${WORK}:AC-001]\n## Scenario coverage\n| Clause | Scenario | Outcome |\n|---|---|---|\n`
    + `| ${WORK}:REQ-001 | S1 | success |\n| ${WORK}:AC-001 | S1 | success |\n## Non-functional requirements\nNo additional non-functional target is asserted.\n## Assumptions\nStorage is available.\n## Out of scope\nSharing.\n`);
  await scanArtifacts(root, config, workflow, phaseId);
  git('add', '-A'); git('commit', '-m', `[${WORK}] Story created with its draft`);
  const cli = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', env });
  const json = (args) => { const result = cli([...args, '--json']); return { status: result.status, body: JSON.parse(result.stdout || '{}'), stderr: result.stderr }; };

  const blocked = json(['phase', 'prepublish', phaseId]);
  const finding = (blocked.body.findings ?? []).find((entry) => entry.code === 'artifact.placeholder.unresolved');
  assert.ok(finding?.override?.key, JSON.stringify(blocked.body.findings ?? blocked));
  const key = finding.override.key;

  const refusal = json(['decision', 'override-finding', WORK, '--phase', phaseId, '--finding', key, '--reason', 'too short']);
  assert.notEqual(refusal.status, 0);
  assert.match(JSON.stringify(refusal.body), /20 to 1000 characters/u);
  const wrong = json(['decision', 'override-finding', WORK, '--phase', phaseId, '--finding', 'CHK-000000000000', '--reason', REASON]);
  assert.match(JSON.stringify(wrong.body), new RegExp(`Its findings you may override: [^"]*${key}`, 'u'));

  const recorded = json(['decision', 'override-finding', WORK, '--phase', phaseId, '--finding', key, '--reason', REASON]);
  assert.equal(recorded.status, 0, recorded.stderr + JSON.stringify(recorded.body));
  assert.equal(recorded.body.data?.record?.id ?? recorded.body.record?.id, 'FOV-001', JSON.stringify(recorded.body));
  assert.match(git('log', '-1', '--format=%s'), new RegExp(`\\[${WORK}\\]\\[phase:${phaseId}\\]\\[finding-override\\] ${key}`, 'u'));

  const through = json(['phase', 'prepublish', phaseId]);
  assert.ok(!(through.body.findings ?? []).some((entry) => entry.code === 'artifact.placeholder.unresolved'), JSON.stringify(through.body.findings));
  assert.deepEqual((through.body.overridden ?? []).map((entry) => entry.overriddenBy.reason), [REASON]);
  const again = json(['decision', 'override-finding', WORK, '--phase', phaseId, '--finding', key, '--reason', REASON]);
  assert.match(JSON.stringify(again.body), /was overridden by .*Nothing else to record\./u);
});
