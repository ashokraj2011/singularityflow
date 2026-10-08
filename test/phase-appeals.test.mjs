import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import YAML from 'yaml';
import { canonicalJson } from '../src/records.mjs';
import { loadAcceptedStoryExecution } from '../src/accepted-story-execution.mjs';
import { assertPhaseAppealsResolved, decidePhaseAppeal, phaseAppealStatus, preparePhaseAppeal,
  submitPhaseAppeal, validatePhaseAppeal } from '../src/phase-appeals.mjs';
import { phaseResolutionChoices, repairLoopAdmission } from '../src/phase-resolution.mjs';
import { submissionReadiness } from '../src/submission-readiness.mjs';
import { operationById, resolveOperation } from '../src/command-registry.mjs';
import { stepAttempts } from '../src/verification/attempts.mjs';
import { inspectPhaseQualityGate, prepareQualityRisk } from '../src/phase-quality-risk.mjs';
import { hasPublishedPhaseGeneration, pendingCodeSubmissionEvidence, requiresProspectivePhaseInspection } from '../src/code-submission-evidence.mjs';
import { artifactMetadataBlock, publishGeneration, scanArtifacts, storyArtifactMetadata } from '../src/state.mjs';
import { transactStory } from '../src/state-stores.mjs';
import { inspectPhaseRecovery } from '../src/recovery-plan.mjs';
import { phasePrepublish } from '../src/phase-prepublish.mjs';
import { artifactQualityStatus, approvedArtifactQualityFindings } from '../src/phase-artifact-risk.mjs';
import { inspectPhaseAuthoredReviewContent } from '../src/publication-preflight.mjs';
import { publishedGenerationCommit } from '../src/generation-publication-store.mjs';
import { runGovernanceGate } from '../src/governance.mjs';
import { readBoundSpecificationClaimMap } from '../src/specifications.mjs';
import { recoveryPlan } from '../src/collaboration.mjs';
import { setAgentSession } from '../src/session.mjs';
import { inspectPhasePublicationReadiness, assertPhasePublicationReadiness } from '../src/phase-publication-readiness.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const WORK = 'APPEAL-1';
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function sealed(value) { const copy = structuredClone(value); delete copy.packetSha256; return { ...copy, packetSha256: sha(canonicalJson(copy)) }; }
function packet() {
  return sealed({ schemaVersion: 1, kind: 'phase-appeal', id: `APL-${'a'.repeat(24)}`,
    binding: { workId: WORK, phaseId: 'custom-code', generation: 1, intentId: 'GI-1', policySha256: sha('policy'),
      planSha256: sha('plan'), sourceSha256: sha('source'), testInputSha256: null, evidenceSha256: sha('evidence') },
    reason: 'A helper implements the existing approved acceptance criterion.',
    changes: [{ kind: 'add-location', clauseId: `${WORK}:AC-001`, path: 'src/helper.mjs' }],
    diff: [{ path: 'src/helper.mjs', status: 'added', before: '', beforeSha256: null, after: 'export const value = 2;\n', afterSha256: sha('export const value = 2;\n') }],
    author: { actor: 'person@example.test', provenance: 'configured-git-identity-not-proof-of-tool-authorship' },
    baseCommit: 'a'.repeat(40), capturedHead: 'b'.repeat(40), requestedDisposition: 'account-scope', limitations: ['No tests waived.'] });
}
test('appeal packets are closed, exact-byte, bounded and portable', () => {
  assert.deepEqual(validatePhaseAppeal(packet()), packet());
  for (const file of ['../escape', '/tmp/file', 'src/*.mjs', 'C:/file', 'src\\file', 'src/CON.txt', 'src/name.', 'src/a\n']) {
    const value = packet(); value.changes[0].path = file; value.diff[0].path = file;
    assert.throws(() => validatePhaseAppeal(sealed(value)), { code: 'PHASE_APPEAL_INTEGRITY' });
  }
  for (const mutate of [value => { value.diff[0].after += 'changed'; }, value => { value.testsWaived = true; },
    value => { value.changes.push(value.changes[0]); }, value => { value.diff[0].before = 'unbound bytes'; },
    value => { value.diff[0].after = 'é'.repeat(140000); value.diff[0].afterSha256 = sha(value.diff[0].after); }]) {
    const value = packet(); mutate(value);
    assert.throws(() => validatePhaseAppeal(sealed(value)), { code: 'PHASE_APPEAL_INTEGRITY' });
  }
  const tampered = packet(); tampered.reason = 'A completely different purpose that nobody reviewed.';
  assert.throws(() => validatePhaseAppeal(tampered), { code: 'PHASE_APPEAL_INTEGRITY' });
});
test('all findings have an owner route; trust is never an ordinary risk waiver', () => {
  const workflow = { workItem: { id: WORK } }; const phase = { id: 'future-step' };
  for (const code of ['PROTECTED_PATH', 'AUTHORITY_UNAVAILABLE', 'snapshot-invalid', 'source-boundary-mismatch']) {
    const result = phaseResolutionChoices(workflow, phase, { code });
    assert.equal(result.choices[0].kind, 'configuration-owner');
    assert.equal(result.choices[0].automatic, false);
  }
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'CODE_TEST_FAILED' }).choices[0].kind, 'risk-inspection');
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'never-seen-before' }).choices[0].kind, 'owner-escalation');
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'scope.unclaimed' }).choices[0].kind, 'scope-appeal');
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'code.delivery.incomplete',
    details: { sourceCode: 'SPEC_COVERAGE_INCOMPLETE', coverage: { unclaimedChangedPaths: ['src/extra.css'] } } }).choices[0].kind, 'scope-appeal');
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'code.delivery.incomplete',
    details: { sourceCode: 'SPEC_COVERAGE_INCOMPLETE', qualityRisk: { eligible: true } } }).choices[0].kind, 'pilot-risk-review');
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'SPEC_COVERAGE_INCOMPLETE' }).choices[0].kind, 'author-correction');
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'artifact.placeholder' }).choices[0].kind, 'author-correction');
  const evidence = phaseResolutionChoices(workflow, phase, { code: 'phase.evidence-contract.not-ready',
    path: 'singularity/work-items/APPEAL-1/evidence/screen.png', category: 'evidence-contract',
    details: { sourceCode: 'PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED' } });
  assert.equal(evidence.status, 'needs-human');
  assert.match(evidence.choices[0].copilotCommand, /^\/sf-appeal evidence-prepare/u);
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'phase.appeal.not-ready', category: 'appeal', details: { sourceCode: 'PHASE_APPEAL_INTEGRITY' } }).choices[0].kind, 'configuration-owner');
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'PHASE_APPEAL_PATH_UNSUPPORTED' }).choices[0].kind, 'owner-escalation');
  assert.equal(phaseResolutionChoices(workflow, phase, { code: 'LIFECYCLE_WORKTREE_REVIEW_REQUIRED' }).status, 'needs-human');
});
test('repair admission rejects unchanged retries, oscillation and budget exhaustion', () => {
  assert.equal(repairLoopAdmission([], { actionId: 'fix', conditionHash: 'a' }).allowed, true);
  assert.equal(repairLoopAdmission([{ conditionHash: 'a' }], { actionId: 'fix', conditionHash: 'a' }).allowed, false);
  assert.equal(repairLoopAdmission([{ conditionHash: 'a' }, { conditionHash: 'b' }], { actionId: 'fix', conditionHash: 'a' }).allowed, false);
  assert.equal(repairLoopAdmission([{}, {}, {}], { actionId: 'fix', conditionHash: 'c' }).reason, 'budget-exhausted');
  assert.equal(repairLoopAdmission([], {}).reason, 'missing-exact-condition');
  assert.equal(repairLoopAdmission([], { actionId: 'fix', conditionHash: 'a' }, { maximumAttempts: 100 }).reason, 'invalid-repair-budget');
});
test('pilot appeal commands are registered model-free with accurate read/mutation effects', () => {
  for (const action of ['risk-prepare', 'risk-accept', 'risk-attest', 'risk-revoke']) {
    const resolved = resolveOperation({ requestedCommand: 'appeal', positionals: ['appeal', action], options: {} });
    assert.equal(resolved.id, `appeal.${action}`);
    assert.deepEqual(resolved, operationById(resolved.id));
    assert.equal(resolved.classification, action === 'risk-prepare' ? 'read' : 'mutation');
  }
});
test('malformed and orphan appeal state cannot escape the shared gate', async () => {
  for (const data of [{ phaseAppeals: {} }, { phaseAppeals: null }, { phaseAppeals: [], phaseAppealDecisions: [{}] }]) {
    await assert.rejects(assertPhaseAppealsResolved('/unused', {}, data, { id: 'code' }), { code: 'PHASE_APPEAL_INTEGRITY' });
  }
});

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Appeal Tester', SINGULARITY_FLOW_NO_MODEL: '1' } });
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function acceptDocumentRisk(root, cli, phase, { transitions = [] } = {}) {
  const expires = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const reason = 'The unfinished explanatory appendix is deferred for this pilot; source, tests and review remain required.';
  const options = ['--phase', phase, '--finding', 'artifact.placeholder.unresolved', '--gate-mode', 'soft', '--expires', expires, '--reason', reason,
    ...transitions.flatMap(transition => ['--transition', transition])];
  const packet = JSON.parse(cli('appeal', 'risk-prepare', ...options, '--json').stdout).data.packet;
  const id = `PQR-${packet.packetSha256.slice(7, 31)}`;
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const ceremony = spawnSync('/usr/bin/expect', ['-c', `set timeout 45\nspawn -noecho $env(PQR_NODE) $env(PQR_CLI) --no-model appeal risk-accept --phase $env(PQR_PHASE) --finding artifact.placeholder.unresolved --gate-mode soft --expires $env(PQR_EXPIRES) --reason $env(PQR_REASON) {*}$env(PQR_TRANSITIONS) --confirm $env(PQR_CONFIRM) --json\nexpect "Type Accept risk ${id} to confirm this exact action, or Enter to cancel:"\nsend -- "Accept risk ${id}\\r"\nexpect eof\ncatch wait result\nexit [lindex $result 3]`],
    { cwd: root, encoding: 'utf8', timeout: 50000, env: { ...environment, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Appeal Tester',
      PQR_NODE: process.execPath, PQR_CLI: CLI, PQR_PHASE: phase, PQR_EXPIRES: expires, PQR_REASON: reason,
      PQR_CONFIRM: packet.packetSha256, PQR_TRANSITIONS: transitions.flatMap(transition => ['--transition', transition]).join(' ') } });
  assert.equal(ceremony.status, 0, ceremony.stdout + ceremony.stderr); assert.match(ceremony.stdout, /risk-accepted/u);
  return packet;
}
async function fixture(t, { pilotCoverage = false, directCoverage = false, missingPlannedSource = false, intakeDocumentRisk = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-appeals-')); const remote = `${root}.git`;
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(remote, { recursive: true, force: true })]));
  const git = (...args) => run('git', args, root);
  const cli = (...args) => run(process.execPath, [CLI, '--no-model', ...args], root);
  const write = async (relative, contents) => { await mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await writeFile(path.join(root, relative), contents); };
  git('init', '-b', 'main'); git('config', 'user.name', 'Appeal Tester'); git('config', 'user.email', 'appeal@example.test');
  await write('package.json', JSON.stringify({ type: 'module', private: true, scripts: { test: 'node --test' } }));
  await write('src/value.mjs', 'export const value = 1;\n');
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value', () => assert.equal(value,1));\n`);
  cli('init');
  const configPath = path.join(root, 'singularity/workflow.yml'); const config = YAML.parse(await readFile(configPath, 'utf8'));
  config.worldModel.grounding = 'off'; config.approvalSecurity = { profile: 'poc' };
  for (const authority of Object.values(config.approvalAuthorities)) authority.allowAnyGitIdentity = true;
  config.workTypes['classic-delivery'].spec = { ...(config.workTypes['classic-delivery'].spec ?? {}), mode: 'enforce', coverage: 'enforce' };
  await writeFile(configPath, YAML.stringify(config));
  git('add', '.'); git('commit', '-m', 'Initialize appeal fixture');
  run('git', ['init', '--bare', '-b', 'main', remote], root); git('remote', 'add', 'origin', remote); git('push', '-u', 'origin', 'main');
  const ready = JSON.parse(cli('precheck', '--run', '--scope', 'dependency-test', '--json').stdout).data.plan;
  cli('precheck', '--run', '--scope', 'dependency-test', '--confirm-plan', ready.planId, '--json');
  cli('start', WORK, '--from-branch', 'main', '--work-type', 'classic-delivery', '--title', 'Use a helper', '--description', 'Return 2.',
    ...(pilotCoverage ? ['--gate-mode', 'soft'] : []));
  const item = `singularity/work-items/${WORK}`;
  cli('prepare', 'intake');
  await write(`${item}/artifacts/intake/intake.md`, [
    `# ${WORK} — intake`, '', '## Request and outcome', '', 'Return the approved value 2 to every caller.', '',
    '## Scope and constraints', '', 'Change only the value module and its test.', '',
    '## Acceptance criteria', '', '| Clause | Observable outcome |', '|---|---|', `| [${WORK}:AC-001] | The exported value equals 2. |`, '',
    '## Planned implementation evidence', '', '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| \`${WORK}:AC-001\` | \`src/value.mjs\`${pilotCoverage || missingPlannedSource ? ', `src/missing.mjs`' : ''} | \`test/value.test.mjs\` | modified |`, '',
    '## Initial evidence', '', 'The baseline module and test at the pinned main revision.', ''
  ].join('\n'));
  cli('wm', 'compose', '--phase', 'intake'); cli('clarification', 'record', 'intake', '--question', 'Is 2 the approved value?', '--answer', 'Yes.');
  if (intakeDocumentRisk) {
    const intake = `${item}/artifacts/intake/intake.md`;
    await write(intake, `${await readFile(path.join(root, intake), 'utf8')}\nPilot appendix: TODO record additional explanatory notes.\n`);
    await acceptDocumentRisk(root, cli, 'intake');
  }
  cli('phase', 'publish', 'intake', '--authored', 'human', '--channel', 'manual-in-place'); cli('submit', 'intake'); cli('approve', 'intake', '--yes');
  cli('prepare', 'implementation');
  await write('src/value.mjs', `// @clause:${WORK}:AC-001 returns the approved value\n${pilotCoverage || directCoverage ? 'export const value = 2;' : "import {approved} from './helper.mjs';\nexport const value = approved;"}\n`);
  if (!pilotCoverage && !directCoverage) await write('src/helper.mjs', 'export const approved = 2;\n');
  await write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value', () => assert.equal(value,2));\n`);
  if (!pilotCoverage && !directCoverage) await write('NOTES.md', 'Keep this unrelated note out of every appeal commit.\n');
  const summary = `${item}/artifacts/implementation/implementation-summary.md`;
  await write(summary, (await readFile(path.join(root, summary), 'utf8')).replace(/TODO:[^\n]*/gu, 'The value module reads the approved value from a small helper.'));
  return { root, remote, git, cli, write, item, summary, load: () => loadAcceptedStoryExecution(root, WORK) };
}
const request = { phaseId: 'implementation', changes: [{ kind: 'add-location', clauseId: `${WORK}:AC-001`, path: 'src/helper.mjs' }], reason: 'The small helper implements the already approved return value.' };

test('reviewed evidence typing preserves the draft/index and clears only exact screenshot ownership', { timeout: 180000 }, async t => {
  const f = await fixture(t, { directCoverage: true, missingPlannedSource: true });
  const evidencePath = `${f.item}/evidence/value.png`;
  await f.write(evidencePath, Buffer.from('retained visual proof, not a passing adjudication'));
  const options = ['--phase', 'implementation', '--clause', `${WORK}:AC-001`, '--path', evidencePath,
    '--method', 'visual', '--reason', 'This approved visual value obligation was incorrectly typed as product-source delivery.'];
  let { workflow, definition } = await f.load();
  const owner = workflow.phases[workflow.resolution.plannedClaims.owners.implementation];
  const ownerBytes = await readFile(path.join(f.root, owner.claimMaps.planned.path));
  const codeBytes = await readFile(path.join(f.root, 'src/value.mjs'));
  const imageBytes = await readFile(path.join(f.root, evidencePath));
  f.git('add', 'src/value.mjs');
  const indexBefore = f.git('ls-files', '--stage').stdout;
  const recovery = await recoveryPlan(f.root, definition, workflow, { phaseId: 'implementation', inspectActivePhase: true });
  assert.deepEqual(recovery.actions.find(action => action.id === 'working-tree').unexpectedPaths, [evidencePath]);
  const route = recovery.actions.find(action => action.id.startsWith('review-evidence-contract:'));
  assert.match(route.copilotCommand, /^\/sf-appeal evidence-prepare/u);
  assert.equal(recovery.actions.find(action => action.id === 'working-tree').authoringContinuation?.allowed, true);
  const publishBefore = await inspectPhasePublicationReadiness(f.root, definition, workflow, workflow.phases.implementation);
  assert.ok(publishBefore.blockers.some(finding => finding.code === 'phase.evidence-contract.not-ready' && finding.path === evidencePath));
  await assert.rejects(assertPhasePublicationReadiness(f.root, definition, workflow, workflow.phases.implementation),
    { code: 'PLAN_EVIDENCE_CORRECTION_REVIEW_REQUIRED' });
  await setAgentSession(f.root, definition, { name: 'Appeal Tester', email: 'appeal@example.test' },
    workflow.phases.implementation.defaultAgent, WORK, { phaseId: 'implementation', source: 'test' });
  const composed = f.cli('phase', 'enter', '--compose', '--for-agent', '--json');
  const entry = JSON.parse(composed.stdout);
  assert.equal(entry.contextAdmission.allowed, true, composed.stdout);
  assert.equal(entry.contextComposition, 'delivered');
  assert.equal(entry.contextAdmission.pendingEvidence.evidenceAccepted, false);
  assert.equal(entry.next[0].scope, 'draft-only');
  assert.deepEqual(await readFile(path.join(f.root, evidencePath)), imageBytes);
  assert.equal(f.git('ls-files', '--stage').stdout, indexBefore, 'composition never stages held evidence or source');
  const summaryBefore = await readFile(path.join(f.root, f.summary), 'utf8');
  await f.write(f.summary, `${summaryBefore}\nTODO explain this implementation detail.\n`);
  const heldRepair = await phasePrepublish(f.root, definition, workflow, workflow.phases.implementation, {
    modelEnabled: true, session: { workId: WORK, phaseId: 'implementation', agent: workflow.phases.implementation.defaultAgent }
  });
  assert.equal(heldRepair.status, 'correction-required');
  assert.equal(heldRepair.commands.publish, null);
  assert.equal(heldRepair.draftRepair?.allowed, true);
  assert.equal(heldRepair.correction.sameTurn, true, JSON.stringify(heldRepair));
  assert.equal(heldRepair.correction.class, 'agent-authoring');
  await f.write(f.summary, summaryBefore);
  // A complete prose artifact does not imply complete source delivery. Recovery-only missing
  // bindings must still allow the verified author to repair while the screenshot stays held.
  const heldCoverageRepair = await phasePrepublish(f.root, definition, workflow, workflow.phases.implementation, {
    modelEnabled: true, session: { workId: WORK, phaseId: 'implementation', agent: workflow.phases.implementation.defaultAgent }
  });
  assert.equal(heldCoverageRepair.readiness.authoring, true, JSON.stringify(heldCoverageRepair));
  assert.ok(heldCoverageRepair.findings.some(finding => finding.details?.sourceCode === 'SPEC_COVERAGE_INCOMPLETE'));
  assert.equal(heldCoverageRepair.correction.sameTurn, true, JSON.stringify(heldCoverageRepair));
  assert.equal(heldCoverageRepair.correction.class, 'agent-authoring');
  assert.equal(heldCoverageRepair.correction.skill, '/sf-code');
  assert.equal(heldCoverageRepair.commands.publish, null);
  assert.ok(heldCoverageRepair.findings.some(finding => finding.code === 'phase.evidence-contract.not-ready'));
  assert.match(heldCoverageRepair.correction.guidance, /Repair the cited owned draft\/source\/test bindings/u);
  assert.deepEqual(await readFile(path.join(f.root, evidencePath)), imageBytes);
  assert.equal(f.git('ls-files', '--stage').stdout, indexBefore);
  const foreignPath = 'singularity/work-items/OTHER/private.md';
  await f.write(foreignPath, 'Another Story cannot inherit the current evidence hold.\n');
  const unrelatedRepair = await phasePrepublish(f.root, definition, workflow, workflow.phases.implementation, {
    modelEnabled: true, session: { workId: WORK, phaseId: 'implementation', agent: workflow.phases.implementation.defaultAgent }
  });
  assert.notEqual(unrelatedRepair.draftRepair?.allowed, true);
  assert.equal(unrelatedRepair.correction.sameTurn, false);
  assert.equal(unrelatedRepair.commands.publish, null);
  await rm(path.join(f.root, foreignPath));
  const packet = JSON.parse(f.cli('appeal', 'evidence-prepare', ...options, '--json').stdout).data.packet;
  assert.equal(packet.humanReview.surface, 'human-terminal');
  assert.equal(packet.humanReview.execution, 'human-relay-only');
  const id = `PEA-${packet.packetSha256.slice(7, 31)}`;
  assert.equal(packet.humanReview.confirmationText, `Correct evidence ${id}`);
  const stale = run(process.execPath, [CLI, '--no-model', 'appeal', 'evidence-accept', ...options, '--confirm', 'sha256:' + '0'.repeat(64), '--json'], f.root, true);
  assert.equal(JSON.parse(stale.stdout).error.code, 'PLAN_EVIDENCE_CORRECTION_STALE');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const ceremony = spawnSync('/usr/bin/expect', ['-c', `set timeout 45\nspawn -noecho $env(PEA_NODE) $env(PEA_CLI) --no-model appeal evidence-accept --phase implementation --clause $env(PEA_CLAUSE) --path $env(PEA_PATH) --method visual --reason $env(PEA_REASON) --confirm $env(PEA_CONFIRM) --json\nexpect "Type Correct evidence ${id} to confirm this exact action, or Enter to cancel:"\nsend -- "Correct evidence ${id}\\r"\nexpect eof\ncatch wait result\nexit [lindex $result 3]`],
    { cwd: f.root, encoding: 'utf8', timeout: 60000, env: { ...environment, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Appeal Tester',
      PEA_NODE: process.execPath, PEA_CLI: CLI, PEA_CLAUSE: `${WORK}:AC-001`, PEA_PATH: evidencePath, PEA_REASON: options.at(-1), PEA_CONFIRM: packet.packetSha256 } });
  assert.equal(ceremony.status, 0, ceremony.stdout + ceremony.stderr);
  assert.match(ceremony.stdout, /evidence-contract-corrected/u);
  ({ workflow, definition } = await f.load());
  const plan = await readBoundSpecificationClaimMap(f.root, path.join(f.root, f.item), workflow, workflow.phases[owner.id], 'planned', { requireCommitted: true });
  assert.equal(plan.claims[`${WORK}:AC-001`].fulfillment, 'evidence');
  assert.deepEqual(plan.claims[`${WORK}:AC-001`].expectedPaths, [evidencePath]);
  assert.deepEqual(plan.claims[`${WORK}:AC-001`].tests, ['test/value.test.mjs']);
  const restored = await recoveryPlan(f.root, definition, workflow, { phaseId: 'implementation', inspectActivePhase: true });
  const dirty = restored.actions.find(action => action.id === 'working-tree');
  assert.deepEqual(dirty.unexpectedPaths, []);
  assert.equal(dirty.confirmation, 'none');
  assert.equal(workflow.phases.implementation.generation, 0, 'correction neither publishes nor advances');
  assert.equal(workflow.phases.implementation.status, 'in_progress');
  const publishAfter = await inspectPhasePublicationReadiness(f.root, definition, workflow, workflow.phases.implementation);
  assert.equal(publishAfter.blockers.some(finding => finding.code === 'phase.evidence-contract.not-ready'), false,
    'only the reviewed contract clears publication ownership; adequacy and tests remain independent');
  assert.deepEqual(await readFile(path.join(f.root, owner.claimMaps.planned.path)), ownerBytes);
  assert.deepEqual(await readFile(path.join(f.root, 'src/value.mjs')), codeBytes);
  assert.deepEqual(await readFile(path.join(f.root, evidencePath)), imageBytes);
  assert.equal(f.git('ls-files', '--stage').stdout.split('\n').find(line => line.endsWith('\tsrc/value.mjs')),
    indexBefore.split('\n').find(line => line.endsWith('\tsrc/value.mjs')), 'unrelated staged source survives the exact decision commit');
  assert.match(f.git('status', '--porcelain=v1', '--untracked-files=all').stdout, /value\.png/u, 'screenshot stays private until normal publication');
});

test('publication stage follows policy and generation rather than a built-in phase name', () => {
  for (const id of ['implementation', 'verification', 'custom-code', 'specification']) {
    const workflow = { workItem: { id: WORK }, history: [] };
    const phase = { id, status: 'in_progress', generation: 2, generationIntent: { status: 'consumed', generation: 2 } };
    assert.equal(hasPublishedPhaseGeneration(phase), true);
    assert.equal(requiresProspectivePhaseInspection(workflow, phase), false);
    assert.equal(requiresProspectivePhaseInspection(workflow, { ...phase,
      generationIntent: { status: 'open', generation: 3 } }), true);
    assert.equal(requiresProspectivePhaseInspection(workflow, { ...phase,
      reworkRevalidation: { generation: 2 } }), true);
    assert.equal(requiresProspectivePhaseInspection(workflow, { ...phase, status: 'awaiting_approval' }), false);
    assert.equal(hasPublishedPhaseGeneration({ ...phase, generationIntent: { status: 'open', generation: 3 } }), false);
    assert.equal(hasPublishedPhaseGeneration({ ...phase, generation: 0 }), false);
    assert.equal(hasPublishedPhaseGeneration({ ...phase, generationIntent: null,
      generationPublications: [{ generation: 2, record: { path: 'retained-publication.json' } }] }), true);
  }
});

test('rejected code successors submit fresh evidence, including old-writer historical live pointers',
  { timeout: 240000 }, async t => {
    for (const legacyWriter of [false, true]) await t.test(legacyWriter ? 'already published by old writer' : 'new publication', async t => {
      const f = await fixture(t, { directCoverage: true });
      f.cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
      f.cli('submit', 'implementation');
      const first = (await f.load()).workflow.phases.implementation;
      const oldPointer = structuredClone(first.claimMaps.observed);
      const oldBytes = await readFile(path.join(f.root, oldPointer.path));
      f.cli('reject', 'implementation', '--to', 'implementation', '--reason', 'Revise the same implementation with fresh evidence.');
      f.cli('prepare', 'implementation');
      await f.write('src/value.mjs', `// @clause:${WORK}:AC-001 returns the approved value\nexport const value = 1 + 1;\n`);
      await f.write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value after correction', () => assert.equal(value,2));\n`);
      if (legacyWriter) {
        // Reproduce the real old writer inside an authenticated publication transaction, not by
        // hand-editing state after publication. The patched reader must handle this existing state.
        const { workflow, definition } = await f.load();
        const phase = workflow.phases.implementation;
        await transactStory(f.root, definition, workflow, { type: 'artifact-generated', phaseId: phase.id,
          generation: 2, actor: phase.generatedBy, agent: null,
          payload: { generationStartSha256: phase.generationIntent.receiptSha256 } },
        `[${WORK}][phase:implementation][generated:2] old writer publication`, async (aggregate, event, context) => {
          const result = await publishGeneration(f.root, definition, aggregate, { phaseId: phase.id, persist: false,
            authorship: { ...first.authorship.at(-1), producer: 'human', channel: 'manual-in-place' },
            publicationTransaction: { publicationEvent: event, transactionId: context.transactionId, expectedHead: context.expectedHead } });
          result.claimMaps ??= {}; result.claimMaps.observed = oldPointer;
          result.generationCommit = first.generationCommit; result.publicationCommit = first.publicationCommit;
          // The old writer also rendered these carried commit fields into managed metadata.
          // Reproduce those bytes before committing; post-publication state edits are not legacy.
          const summary = await readFile(path.join(f.root, f.summary), 'utf8');
          await f.write(f.summary, summary.replace(/^<!-- singularity-flow:metadata\n[\s\S]*?\n-->/u,
            artifactMetadataBlock(storyArtifactMetadata(aggregate, result))));
          await scanArtifacts(f.root, definition, aggregate, phase.id);
          return result;
        }, { paths: ['src/value.mjs', 'test/value.test.mjs'] });
      } else f.cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
      let { workflow, definition } = await f.load();
      let phase = workflow.phases.implementation;
      assert.equal(phase.generation, 2); assert.equal(phase.deliveryEvidence.status, 'pending-tests');
      if (!legacyWriter) { assert.equal(phase.claimMaps?.observed, undefined); assert.equal(phase.generationCommit, null); }
      const stateBytes = await readFile(path.join(f.root, `${f.item}/workflow.json`));
      const pending = await pendingCodeSubmissionEvidence(f.root, definition, workflow, phase);
      assert.equal(pending.generation, 2); assert.equal(pending.historicalObservedGeneration, legacyWriter ? 1 : null);
      const reopened = structuredClone(workflow);
      reopened.phases.implementation.reworkRevalidation = { generation: 2 };
      assert.equal(await pendingCodeSubmissionEvidence(f.root, definition, reopened, reopened.phases.implementation), null,
        'an explicit rework boundary cannot borrow the prior generation\'s pending submission route');
      const preflight = JSON.parse(f.cli('appeal', 'preflight', '--phase', phase.id, '--json').stdout).data;
      assert.equal(preflight.quality.status, 'pending-submission-evidence', JSON.stringify(preflight));
      assert.equal(preflight.quality.testsWaived, false);
      assert.deepEqual(preflight.inspection.findings, []);
      assert.deepEqual(preflight.recovery.blockers, []);
      assert.ok(preflight.recovery.actions.some(action => action.command?.startsWith('singularity-flow submit implementation')));
      assert.equal(requiresProspectivePhaseInspection(workflow, phase), false);
      const draft = JSON.parse(f.cli('phase', 'draft-check', phase.id, '--json').stdout);
      assert.equal(draft.generation, 2); assert.equal(draft.inspectionStage, 'published');
      assert.equal(draft.commands.publish, null); assert.equal(draft.correction.sameTurn, false);
      const prepublish = JSON.parse(f.cli('phase', 'prepublish', phase.id, '--json').stdout);
      assert.equal(prepublish.status, 'ready', JSON.stringify(prepublish));
      assert.equal(prepublish.generation, 2); assert.equal(prepublish.commands.publish, null);
      assert.match(prepublish.commands.next, /submit implementation/u);
      assert.equal(prepublish.readiness.publicationTransaction, 'already-published');
      assert.deepEqual(prepublish.findings, []);
      await assert.rejects(prepareQualityRisk(f.root, definition, workflow, { phaseId: phase.id, gateMode: 'soft' }), error => {
        assert.equal(error.code, 'PHASE_QUALITY_RISK_PENDING_TESTS');
        assert.equal(error.details.nextAction.skill, '/sf-submit');
        assert.equal(error.details.nextAction.command, pending.next); return true;
      });
      const riskRefusal = run(process.execPath, [CLI, '--no-model', 'appeal', 'risk-prepare', '--phase', phase.id,
        '--gate-mode', 'soft', '--json'], f.root, true);
      assert.notEqual(riskRefusal.status, 0);
      const refusal = JSON.parse(riskRefusal.stdout);
      assert.equal(refusal.error.code, 'PHASE_QUALITY_RISK_PENDING_TESTS');
      assert.ok(refusal.remediationPlan.steps.some(step => step.command === pending.next && step.copilotCommand === '/sf-submit'));
      if (!legacyWriter) {
        // Simulate read-only inspection at the document publication checkpoint using its real,
        // authenticated retained commit. No CLI lifecycle mutation or Story file rewrite occurs.
        const documents = structuredClone(workflow); documents.currentPhase = 'intake';
        const document = documents.phases.intake; document.status = 'in_progress';
        const pathToDocument = `${f.item}/${document.requiredArtifact.path}`;
        const documentBytes = await readFile(path.join(f.root, pathToDocument));
        let preview = await phasePrepublish(f.root, definition, documents, document);
        assert.equal(preview.status, 'ready', JSON.stringify(preview));
        assert.equal(preview.generation, 1); assert.equal(preview.commands.publish, null);
        await f.write(pathToDocument, `${documentBytes.toString('utf8')}\nTODO unreviewed correction.\n`);
        const documentRecovery = await inspectPhaseRecovery(f.root, definition, documents, document);
        assert.ok(documentRecovery.blockers.some(finding => finding.code === 'generation.document.published-changed'
          && finding.generation === 1));
        assert.ok(documentRecovery.actions.some(action => action.id === 'published-document-successor:intake'));
        assert.equal(documentRecovery.actions.some(action => action.retry?.command?.includes('publish')), false);
        preview = await phasePrepublish(f.root, definition, documents, document);
        assert.equal(preview.status, 'correction-required'); assert.equal(preview.correction.sameTurn, false);
        await f.write(pathToDocument, documentBytes);
      }
      const repair = JSON.parse(f.cli('appeal', 'repair-plan', '--phase', phase.id, '--json').stdout).data;
      assert.equal(repair.status, 'ready-for-next-check');
      assert.deepEqual(repair.inspection.findings, []);
      assert.equal(repair.action, null, 'pending submission does not hand a published generation back to its author');
      assert.deepEqual(await readFile(path.join(f.root, `${f.item}/workflow.json`)), stateBytes, 'preview never rewrites Story state');
      if (legacyWriter) {
        const forged = structuredClone(workflow);
        forged.phases.implementation.claimMaps.observed.sha256 = '0'.repeat(64);
        await assert.rejects(pendingCodeSubmissionEvidence(f.root, definition, forged, forged.phases.implementation),
          { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE' });
        const old = JSON.parse(oldBytes); old.recordedAt = '2026-01-01T00:00:00.000Z';
        await f.write(oldPointer.path, JSON.stringify(old));
        await assert.rejects(pendingCodeSubmissionEvidence(f.root, definition, workflow, phase),
          { code: 'SPECIFICATION_CLAIM_MAP_BINDING_STALE' });
        await f.write(oldPointer.path, oldBytes);
      }
      const applicationBytes = await readFile(path.join(f.root, 'src/value.mjs'));
      f.cli('submit', 'implementation');
      ({ workflow, definition } = await f.load()); phase = workflow.phases.implementation;
      assert.equal(phase.status, 'awaiting_approval'); assert.equal(phase.claimMaps.observed.generation, 2);
      assert.match(phase.claimMaps.observed.path, /implementation-gen2-observed\.json$/u);
      assert.ok(phase.deliveryEvidence.testExecutions.some(execution => execution.status === 'passed'));
      assert.deepEqual(await readFile(path.join(f.root, oldPointer.path)), oldBytes, 'generation one stays immutable');
      assert.deepEqual(await readFile(path.join(f.root, 'src/value.mjs')), applicationBytes, 'submission does not alter code');
      const corrupt = structuredClone(workflow); corrupt.phases.implementation.claimMaps.observed = oldPointer;
      const inspection = await inspectPhaseQualityGate(f.root, definition, corrupt, corrupt.phases.implementation);
      assert.equal(inspection.risks, null); assert.equal(inspection.findings[0].code, 'SPECIFICATION_CLAIM_MAP_BINDING_STALE');
      const resolution = phaseResolutionChoices(corrupt, corrupt.phases.implementation, inspection.findings[0]);
      assert.equal(resolution.choices[0].owner, 'workflow-maintainer');
      assert.equal(resolution.choices[0].skill, '/sf-doctor');
      const recovery = await inspectPhaseRecovery(f.root, definition, corrupt, corrupt.phases.implementation);
      assert.ok(recovery.blockers.some(finding => finding.code === 'SPECIFICATION_CLAIM_MAP_BINDING_STALE'));
      assert.ok(recovery.actions.some(action => action.id.includes('submission-evidence') && action.skill === '/sf-doctor'));
      f.cli('approve', 'implementation', '--yes');
      assert.equal((await f.load()).workflow.phases.implementation.status, 'approved');
    });
  });

test('pilot risk unlocks only the reviewed editable candidate, still runs tests and requires fresh published review',
  { timeout: 180000, skip: process.platform === 'win32' || !existsSync('/usr/bin/expect') }, async t => {
    const f = await fixture(t, { pilotCoverage: true });
    const options = ['--phase', 'implementation', '--expires', new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      '--reason', 'The second planned location is explicitly deferred for this pilot.'];
    const preview = JSON.parse(f.cli('appeal', 'risk-prepare', ...options, '--json').stdout).data.packet;
    assert.equal(preview.binding.stage, 'candidate'); assert.equal(preview.binding.generation, 1);
    assert.deepEqual(preview.transitions, ['publish']); assert.deepEqual(preview.clauses, [`${WORK}:AC-001`]);
    const source = await readFile(path.join(f.root, 'src/value.mjs'), 'utf8');
    assert.equal(JSON.parse(f.cli('phase', 'prepublish', 'implementation', '--json').stdout).status, 'correction-required');
    const blocked = JSON.parse(f.cli('appeal', 'preflight', '--phase', 'implementation', '--json').stdout).data;
    assert.equal(blocked.resolution.issues.filter(issue => ['SPEC_COVERAGE_INCOMPLETE', 'code.delivery.incomplete'].includes(issue.code)).length, 1);
    assert.equal(blocked.resolution.issues.find(issue => issue.code === 'SPEC_COVERAGE_INCOMPLETE').choices[0].kind, 'pilot-risk-review');
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    const accept = packet => {
      const id = `PQR-${packet.packetSha256.slice(7, 31)}`;
      const ceremony = spawnSync('/usr/bin/expect', ['-c', `set timeout 45\nspawn -noecho $env(PQR_NODE) $env(PQR_CLI) --no-model appeal risk-accept --phase implementation --expires $env(PQR_EXPIRES) --reason {The second planned location is explicitly deferred for this pilot.} --confirm $env(PQR_CONFIRM) --json\nexpect "Type Accept risk ${id} to confirm this exact action, or Enter to cancel:"\nsend -- "Accept risk ${id}\\r"\nexpect eof\ncatch wait result\nexit [lindex $result 3]`],
      { cwd: f.root, encoding: 'utf8', timeout: 50000, env: { ...environment, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Appeal Tester',
        PQR_NODE: process.execPath, PQR_CLI: CLI, PQR_EXPIRES: options[3], PQR_CONFIRM: packet.packetSha256 } });
      assert.equal(ceremony.status, 0, ceremony.stdout + ceremony.stderr); assert.match(ceremony.stdout, /risk-accepted/u);
    };
    accept(preview);
    assert.equal(await readFile(path.join(f.root, 'src/value.mjs'), 'utf8'), source);
    const paths = f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').stdout.trim().split('\n');
    assert.deepEqual(paths.sort(), [`${f.item}/STATUS.md`, `${f.item}/workflow.json`].sort());
    let preflight = JSON.parse(f.cli('appeal', 'preflight', '--phase', 'implementation', '--json').stdout).data;
    assert.equal(preflight.quality.status, 'ready-with-accepted-risk');
    await f.write('src/value.mjs', source.replace('value = 2', 'value = 3'));
    preflight = JSON.parse(f.cli('appeal', 'preflight', '--phase', 'implementation', '--json').stdout).data;
    assert.equal(preflight.quality.risks.items[0].status, 'stale');
    await f.write('src/value.mjs', source);
    f.cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
    const { workflow } = await f.load();
    assert.equal(workflow.phases.implementation.generation, 1);
    assert.equal(workflow.phases.implementation.generationIntent.status, 'consumed');
    assert.ok((await stepAttempts(f.root, f.item, WORK, 'implementation')).some(attempt => attempt.status === 'passed' && attempt.purpose === 'preflight'));
    const inspection = await inspectPhaseQualityGate(f.root, (await f.load()).definition, workflow, workflow.phases.implementation);
    assert.equal(inspection.status, 'pending-submission-evidence', JSON.stringify(inspection));
    f.cli('submit', 'implementation', '--json');
    assert.equal((await f.load()).workflow.phases.implementation.status, 'awaiting_approval');
    assert.ok((await f.load()).workflow.phases.implementation.deliveryEvidence.testExecutions.some(execution => execution.status === 'passed'));
    const approval = run(process.execPath, [CLI, '--no-model', 'approve', 'implementation', '--yes', '--json'], f.root, true);
    assert.notEqual(approval.status, 0, approval.stdout); assert.match(approval.stdout, /SPEC_COVERAGE_INCOMPLETE/u);
    const retained = JSON.parse(f.cli('appeal', 'risk-prepare', ...options, '--json').stdout).data.packet;
    assert.equal(retained.binding.stage, 'published'); assert.notEqual(retained.packetSha256, preview.packetSha256);
    assert.deepEqual(retained.transitions, ['approve', 'consume', 'submit', 'terminal']);
    accept(retained);
    f.cli('approve', 'implementation', '--yes', '--json');
    const approved = (await f.load()).workflow.phases.implementation;
    assert.equal(approved.status, 'approved');
    assert.ok(approved.approvals.some(approval => approval.qualityRisks?.some(risk => risk.packetSha256 === retained.packetSha256)));
  });

test('one live document-quality decision survives publication and submission without waiving tests or approval',
  { timeout: 180000, skip: process.platform === 'win32' || !existsSync('/usr/bin/expect') }, async t => {
    const f = await fixture(t, { directCoverage: true });
    const original = await readFile(path.join(f.root, f.summary), 'utf8');
    await f.write(f.summary, `${original}\nPilot limitation: TODO add the explanatory appendix.\n`);
    const reason = 'The unfinished explanatory appendix is deferred for this pilot; source, tests and review remain required.';
    const expires = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const options = ['--phase', 'implementation', '--finding', 'artifact.placeholder.unresolved', '--gate-mode', 'soft', '--expires', expires, '--reason', reason];
    const preview = JSON.parse(f.cli('appeal', 'risk-prepare', ...options, '--json').stdout).data.packet;
    assert.equal(preview.schemaVersion, 2); assert.equal(preview.gate, 'PHASE_ARTIFACT_QUALITY');
    const before = JSON.parse(f.cli('appeal', 'preflight', '--phase', 'implementation', '--json').stdout).data;
    assert.equal(before.artifactQuality.eligible, true);
    assert.ok(before.resolution.issues.some(issue => issue.choices.some(choice => choice.kind === 'preserve-checkpoint')));
    const beforeHead = f.git('rev-parse', 'HEAD').stdout.trim();
    const beforeStatus = f.git('status', '--porcelain=v1').stdout;
    const beforeIndex = await readFile(path.join(f.root, '.git/index'));
    const saved = JSON.parse(f.cli('appeal', 'checkpoint', '--phase', 'implementation', '--json').stdout);
    assert.equal(saved.operation.classification, 'mutation');
    assert.equal(saved.effects.stateChanged, false); assert.equal(saved.effects.filesChanged, true);
    const shown = JSON.parse(f.cli('appeal', 'checkpoint-show', saved.data.id, '--phase', 'implementation', '--json').stdout);
    assert.equal(shown.data.automaticRestore, false); assert.equal(shown.effects.filesChanged, false);
    assert.equal(f.git('rev-parse', 'HEAD').stdout.trim(), beforeHead);
    assert.equal(f.git('status', '--porcelain=v1').stdout, beforeStatus);
    assert.deepEqual(await readFile(path.join(f.root, '.git/index')), beforeIndex);
    const id = `PQR-${preview.packetSha256.slice(7, 31)}`;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    const ceremony = spawnSync('/usr/bin/expect', ['-c', `set timeout 45\nspawn -noecho $env(PQR_NODE) $env(PQR_CLI) --no-model appeal risk-accept --phase implementation --finding artifact.placeholder.unresolved --gate-mode soft --expires $env(PQR_EXPIRES) --reason $env(PQR_REASON) --confirm $env(PQR_CONFIRM) --json\nexpect "Type Accept risk ${id} to confirm this exact action, or Enter to cancel:"\nsend -- "Accept risk ${id}\\r"\nexpect eof\ncatch wait result\nexit [lindex $result 3]`],
      { cwd: f.root, encoding: 'utf8', timeout: 50000, env: { ...environment, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Appeal Tester',
        PQR_NODE: process.execPath, PQR_CLI: CLI, PQR_EXPIRES: expires, PQR_REASON: reason, PQR_CONFIRM: preview.packetSha256 } });
    assert.equal(ceremony.status, 0, ceremony.stdout + ceremony.stderr);
    assert.match(ceremony.stdout, /risk-accepted/u);
    const current = await f.load(); const phase = current.workflow.phases.implementation;
    const raw = await inspectPhaseAuthoredReviewContent(f.root, current.definition, current.workflow, phase, { resolveRisks: false });
    const expired = await artifactQualityStatus(f.root, current.definition, current.workflow, phase, raw,
      { at: new Date(Date.now() + 8 * 86400000).toISOString() });
    assert.equal(expired.items[0].status, 'expired'); assert.equal(expired.excepted, false);
    await f.write(f.summary, `${original}\nChanged shortfall: TODO do a different analysis.\n`);
    const changed = await artifactQualityStatus(f.root, current.definition, current.workflow, phase,
      await inspectPhaseAuthoredReviewContent(f.root, current.definition, current.workflow, phase, { resolveRisks: false }));
    assert.equal(changed.items[0].status, 'stale'); assert.equal(changed.excepted, false);
    await f.write(f.summary, `${original}\nPilot limitation: TODO add the explanatory appendix.\n`);
    const source = await readFile(path.join(f.root, 'src/value.mjs'), 'utf8');
    const accepted = JSON.parse(f.cli('phase', 'prepublish', 'implementation', '--json').stdout);
    assert.equal(accepted.status, 'ready', JSON.stringify(accepted));
    assert.equal(accepted.qualityDisposition, 'accepted-risk');
    assert.ok((await readFile(path.join(f.root, f.summary), 'utf8')).includes('TODO'));
    f.cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
    assert.equal((await f.load()).workflow.phases.implementation.generation, 1);
    const after = JSON.parse(f.cli('appeal', 'preflight', '--phase', 'implementation', '--json').stdout).data;
    assert.equal(after.artifactQuality.items[0].status, 'active', JSON.stringify(after.artifactQuality));
    f.cli('submit', 'implementation', '--json');
    const submitted = (await f.load()).workflow.phases.implementation;
    assert.equal(submitted.status, 'awaiting_approval');
    assert.ok(submitted.deliveryEvidence.testExecutions.some(execution => execution.status === 'passed'));
    f.cli('approve', 'implementation', '--yes', '--json');
    assert.equal((await f.load()).workflow.phases.implementation.status, 'approved');
    assert.equal((await f.load()).workflow.phases.implementation.approvals[0].qualityRisks[0].id, id);
    assert.equal(await readFile(path.join(f.root, 'src/value.mjs'), 'utf8'), source);
    assert.equal((await f.load()).workflow.qualityRiskDecisions.length, 1);
  });

test('non-code intake keeps an accepted document shortfall visible through approval and downstream use',
  { timeout: 180000, skip: process.platform === 'win32' || !existsSync('/usr/bin/expect') }, async t => {
    const f = await fixture(t, { directCoverage: true, intakeDocumentRisk: true });
    const { workflow, definition } = await f.load(); const phase = workflow.phases.intake;
    assert.equal(phase.status, 'approved');
    assert.equal(phase.approvals[0].qualityRisks.length, 1);
    const raw = await inspectPhaseAuthoredReviewContent(f.root, definition, workflow, phase, { resolveRisks: false });
    const current = await artifactQualityStatus(f.root, definition, workflow, phase, raw, { transition: 'consume' });
    assert.equal(current.items[0].status, 'active'); assert.equal(current.excepted, true);
    assert.deepEqual(current.items[0].clauses, []);
    assert.deepEqual(await approvedArtifactQualityFindings(f.root, definition, workflow), []);
    const expired = await approvedArtifactQualityFindings(f.root, definition, workflow,
      { transition: 'terminal', at: new Date(Date.now() + 8 * 86400000).toISOString() });
    assert.ok(expired.some(finding => finding.phaseId === 'intake' && finding.code === 'artifact.placeholder.unresolved'));
    const riskRoute = phaseResolutionChoices(workflow, workflow.phases.implementation, expired[0]).choices
      .find(choice => choice.kind === 'pilot-risk-review');
    assert.equal(riskRoute.argv[riskRoute.argv.indexOf('--phase') + 1], 'intake');
    const governance = await runGovernanceGate(f.root, definition, workflow);
    assert.ok(governance.warnings.some(warning => /artifact.placeholder.unresolved/.test(warning)));
    assert.ok(!governance.errors.some(error => /reading 'join'|reading 'includes'/.test(error)));
    assert.ok((await readFile(path.join(f.root, `${f.item}/artifacts/intake/intake.md`), 'utf8')).includes('TODO'));
    assert.equal(workflow.qualityRiskDecisions[0].testsWaived, false);
  });

test('a publication-only document exception can be extended by fresh human review without republication',
  { timeout: 180000, skip: process.platform === 'win32' || !existsSync('/usr/bin/expect') }, async t => {
    const f = await fixture(t, { directCoverage: true });
    const original = await readFile(path.join(f.root, f.summary), 'utf8');
    await f.write(f.summary, `${original}\nPilot appendix: TODO complete explanatory notes.\n`);
    const first = await acceptDocumentRisk(f.root, f.cli, 'implementation', { transitions: ['publish'] });
    f.cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
    const published = (await f.load()).workflow;
    const commit = publishedGenerationCommit(f.root, published, published.phases.implementation);
    assert.match(commit, /^[a-f0-9]{40,64}$/u);
    const blocked = run(process.execPath, [CLI, '--no-model', 'submit', 'implementation', '--json'], f.root, true);
    assert.notEqual(blocked.status, 0); assert.match(blocked.stdout + blocked.stderr, /TODO|placeholder|unfinished/iu);
    const next = await acceptDocumentRisk(f.root, f.cli, 'implementation', { transitions: ['submit', 'approve', 'consume', 'terminal'] });
    assert.deepEqual(next.binding, first.binding); assert.notEqual(next.packetSha256, first.packetSha256);
    f.cli('submit', 'implementation', '--json'); f.cli('approve', 'implementation', '--yes', '--json');
    const current = (await f.load()).workflow;
    assert.equal(publishedGenerationCommit(f.root, current, current.phases.implementation), commit);
    assert.equal(current.phases.implementation.generation, 1);
    assert.equal(current.phases.implementation.status, 'approved');
    assert.equal(current.qualityRiskDecisions.length, 2);
    assert.ok(current.phases.implementation.deliveryEvidence.testExecutions.some(execution => execution.status === 'passed'));
  });

async function liveReview(root, id, confirm, action = 'decide', decision = 'account-scope', native = false) {
  const code = `
    import {loadAcceptedStoryExecution} from ${JSON.stringify(new URL('../src/accepted-story-execution.mjs', import.meta.url).href)};
    import {decidePhaseAppeal,attestPhaseAppeal} from ${JSON.stringify(new URL('../src/phase-appeals.mjs', import.meta.url).href)};
    try { const {workflow,definition}=await loadAcceptedStoryExecution(${JSON.stringify(root)},${JSON.stringify(WORK)});
      const result=await ${action === 'attest' ? 'attestPhaseAppeal' : 'decidePhaseAppeal'}(${JSON.stringify(root)},definition,workflow,${JSON.stringify({ id, confirm, decision, reason: 'The exact diff serves the existing approved criterion without changing intent.' })});
      console.log('APPEAL_RESULT:'+JSON.stringify({ok:true,result}));
    } catch(error) { console.log('APPEAL_RESULT:'+JSON.stringify({ok:false,code:error.code,message:error.message,stack:error.stack})); }
  `;
  const label = `${action === 'attest' ? 'Re-review' : 'Review'} ${id}`;
  const launch = native
    ? `spawn -noecho $env(SF_APPEAL_NODE) $env(SF_APPEAL_CLI) --no-model appeal decide $env(SF_APPEAL_ID) --decision ${decision} --reason {The exact diff needs correction before this phase can continue.} --confirm $env(SF_APPEAL_CONFIRM) --json`
    : 'spawn -noecho $env(SF_APPEAL_NODE) --input-type=module -e $env(SF_APPEAL_CODE)';
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/expect', ['-c', `set timeout 45\n${launch}\nexpect {\n "Type ${label} to confirm this exact action, or Enter to cancel:" {send -- "${label}\\r"}\n timeout {exit 124}\n eof {exit 125}\n}\nexpect eof\ncatch wait result\nexit [lindex $result 3]`], { cwd: root,
      env: { ...environment, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Appeal Tester', SINGULARITY_FLOW_NO_MODEL: '1', SF_APPEAL_NODE: process.execPath, SF_APPEAL_CODE: code,
        SF_APPEAL_CLI: CLI, SF_APPEAL_ID: id, SF_APPEAL_CONFIRM: confirm } });
    let output = ''; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(output.slice(-5000))); }, 50000);
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.on('error', error => { clearTimeout(timer); reject(error); }); child.on('close', status => { clearTimeout(timer); resolve({ status, output }); });
  });
  assert.equal(result.status, 0, result.output.slice(-5000));
  if (native) {
    const output = result.output.replaceAll('\r', '');
    const rendered = JSON.parse(output.slice(output.lastIndexOf('\n{\n') + 1).trim());
    assert.equal(rendered.outcome.status, 'succeeded'); return rendered.data;
  }
  const parsed = JSON.parse(result.output.match(/APPEAL_RESULT:(\{[^\r\n]+\})/u)?.[1] ?? '{}');
  assert.equal(parsed.ok, true, parsed.stack ?? result.output.slice(-5000)); return parsed.result;
}

test('exact-diff appeal preserves source/drafts/index, blocks transitions, and human scope accounting still requires tests',
  { timeout: 240000, skip: process.platform === 'win32' || !existsSync('/usr/bin/expect') }, async t => {
    const f = await fixture(t); let { definition, workflow } = await f.load();
    const beforeHead = f.git('rev-parse', 'HEAD').stdout.trim();
    const draft = await readFile(path.join(f.root, f.summary), 'utf8');
    f.git('add', 'src/value.mjs'); const index = f.git('diff', '--cached').stdout;
    const repairStatus = JSON.parse(f.cli('appeal', 'repair-status', '--phase', 'implementation', '--json').stdout);
    assert.equal(repairStatus.operation.id, 'appeal.repair-status');
    assert.equal(repairStatus.data.consumed, 0); assert.equal(repairStatus.data.machineLocal, true);
    const repairPlan = JSON.parse(f.cli('appeal', 'repair-plan', '--phase', 'implementation', '--json').stdout);
    assert.equal(repairPlan.data.phaseAdvanced, false); assert.equal(repairPlan.data.testsRun, false);
    assert.equal(repairPlan.effects.stateChanged, false); assert.equal(repairPlan.effects.filesChanged, false);
    const staleRepair = run(process.execPath, [CLI, '--no-model', 'appeal', 'repair-run', '--phase', 'implementation', '--confirm', sha('not this plan'), '--json'], f.root, true);
    assert.notEqual(staleRepair.status, 0); assert.match(staleRepair.stdout, /PHASE_REPAIR_PLAN_STALE/u);
    assert.equal(f.git('diff', '--cached').stdout, index);
    const prepared = await preparePhaseAppeal(f.root, definition, workflow, request);
    const preview = JSON.parse(f.cli('appeal', 'prepare', '--add-location', `${WORK}:AC-001=src/helper.mjs`, '--reason', request.reason, '--json').stdout);
    assert.deepEqual(preview.data.packet.binding, prepared.binding);
    assert.deepEqual(preview.data.packet.diff, prepared.diff);
    assert.equal(f.git('rev-parse', 'HEAD').stdout.trim(), beforeHead, 'preparation is read-only');
    const protectedConfig = Object.assign(Object.create(Object.getPrototypeOf(definition)), definition,
      { governance: { ...definition.governance, protectedPaths: ['src/helper.mjs'] } });
    await assert.rejects(preparePhaseAppeal(f.root, protectedConfig, workflow, request), { code: 'PHASE_APPEAL_PATH_UNSUPPORTED' });
    await assert.rejects(preparePhaseAppeal(f.root, definition, workflow, { ...request,
      changes: [{ ...request.changes[0], clauseId: 'OTHER-STORY:AC-001' }] }), /has no row/);
    await assert.rejects(submitPhaseAppeal(f.root, definition, workflow, { ...request, confirm: sha('wrong') }), { code: 'PHASE_APPEAL_STALE' });
    const submitted = await submitPhaseAppeal(f.root, definition, workflow, { ...request, confirm: prepared.packetSha256 });
    assert.equal(submitted.status, 'submitted');
    const committedPaths = f.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').stdout.trim().split('\n');
    assert.ok(committedPaths.every(file => file === `${f.item}/workflow.json` || file === `${f.item}/STATUS.md` || file.startsWith(`${f.item}/appeals/`)), committedPaths.join('\n'));
    assert.equal(await readFile(path.join(f.root, f.summary), 'utf8'), draft);
    assert.equal(f.git('diff', '--cached').stdout, index, 'existing staged application edits preserved');
    ({ definition, workflow } = await f.load());
    const listed = JSON.parse(f.cli('appeal', 'list', '--json').stdout);
    assert.equal(listed.data.items[0].id, prepared.id);
    assert.equal(JSON.parse(f.cli('appeal', 'show', prepared.id, '--json').stdout).data.packet.packetSha256, prepared.packetSha256);
    const preflight = JSON.parse(f.cli('appeal', 'preflight', '--phase', 'implementation', '--json').stdout).data;
    assert.equal(preflight.mutates, false); assert.equal(preflight.testsRun, false); assert.equal(preflight.status, 'resolution-required');
    assert.equal((await phaseAppealStatus(f.root, definition, workflow)).status, 'needs-human');
    await assert.rejects(assertPhaseAppealsResolved(f.root, definition, workflow, workflow.phases.implementation), { code: 'PHASE_APPEAL_REVIEW_REQUIRED' });
    assert.equal((await submissionReadiness(f.root, definition, workflow)).nextSkill, '/sf-appeal');
    assert.equal((await submitPhaseAppeal(f.root, definition, workflow, { ...request, confirm: prepared.packetSha256 })).status, 'already-submitted');
    const options = { id: prepared.id, decision: 'account-scope', confirm: prepared.packetSha256, reason: 'The helper is exactly bound to the approved return-value criterion.' };
    await assert.rejects(decidePhaseAppeal(f.root, definition, workflow, options), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
    await f.write('src/helper.mjs', 'export const approved = 3;\n');
    await assert.rejects(decidePhaseAppeal(f.root, definition, workflow, options), { code: 'PHASE_APPEAL_STALE' });
    await f.write('src/helper.mjs', 'export const approved = 2;\n');
    const decided = await liveReview(f.root, prepared.id, prepared.packetSha256);
    assert.equal(decided.testsWaived, false); assert.equal(decided.phaseApproved, false);
    ({ definition, workflow } = await f.load());
    assert.equal(workflow.phases.implementation.status, 'in_progress');
    assert.equal(workflow.planAmendments.at(-1).changes[0].path, 'src/helper.mjs');
    assert.equal((await phaseAppealStatus(f.root, definition, workflow)).status, 'ready');
    assert.equal(f.git('ls-files', '--', 'src/helper.mjs', 'NOTES.md').stdout, '', 'application additions were not committed by review');
    assert.equal(f.git('diff', '--cached').stdout, index);
    // Local consent cannot be recreated just by copying the public Git/JSON decision.
    const clone = `${f.root}-clone`; t.after(() => rm(clone, { recursive: true, force: true }));
    run('git', ['clone', '--branch', WORK, f.remote, clone], f.root);
    run('git', ['config', 'user.name', 'Appeal Tester'], clone); run('git', ['config', 'user.email', 'appeal@example.test'], clone);
    run('git', ['config', 'core.autocrlf', 'true'], clone);
    for (const name of ['packet.json', 'decision.json']) {
      const file = path.join(clone, f.item, 'appeals', prepared.id, name);
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\n', '\r\n'));
    }
    const cloned = await loadAcceptedStoryExecution(clone, WORK);
    const missingProof = await phaseAppealStatus(clone, cloned.definition, cloned.workflow);
    assert.equal(missingProof.items[0].status, 'needs-reattestation');
    const restored = await liveReview(clone, prepared.id, missingProof.items[0].decisionSha256, 'attest');
    assert.equal(restored.historicalRecordsChanged, false);
    assert.equal((await phaseAppealStatus(clone, cloned.definition, cloned.workflow)).status, 'ready');
    const origins = path.join(clone, '.git', 'singularity-flow', 'phase-appeal-review-origins');
    for (const name of await readdir(origins)) if (name.endsWith('.key')) await writeFile(path.join(origins, name), 'corrupt');
    assert.equal((await phaseAppealStatus(clone, cloned.definition, cloned.workflow)).items[0].status, 'needs-reattestation');
    await liveReview(clone, prepared.id, missingProof.items[0].decisionSha256, 'attest');
    assert.equal((await phaseAppealStatus(clone, cloned.definition, cloned.workflow)).status, 'ready', 'fresh live review recovers corrupt keys without rewriting history');
    // Keep this transport simulation separate from the author's later application checkout.
    for (const name of ['packet.json', 'decision.json']) {
      const file = path.join(clone, f.item, 'appeals', prepared.id, name);
      await writeFile(file, (await readFile(file, 'utf8')).replaceAll('\r\n', '\n'));
    }
    run('git', ['config', 'core.autocrlf', 'false'], clone);
    await f.write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value', () => assert.equal(value,999));\n`);
    const refused = run(process.execPath, [CLI, '--no-model', 'phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place', '--json'], f.root, true);
    assert.notEqual(refused.status, 0); assert.match(refused.stdout + refused.stderr, /CODE_TEST_FAILED/);
    assert.equal(f.git('ls-files', '--', 'src/helper.mjs').stdout, '');
    await f.write('test/value.test.mjs', `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {value} from '../src/value.mjs';\n// @ac:${WORK}:AC-001\ntest('value', () => assert.equal(value,2));\n`);
    // Deliberately unstage in this disposable fixture; review itself preserved the user's index.
    f.git('restore', '--staged', '--', 'src/value.mjs');
    f.cli('phase', 'publish', 'implementation', '--authored', 'human', '--channel', 'manual-in-place');
    f.cli('submit', 'implementation');
    run('git', ['fetch', 'origin', WORK], clone); run('git', ['merge', '--ff-only', `origin/${WORK}`], clone);
    run(process.execPath, [CLI, '--no-model', 'approve', 'implementation', '--yes'], clone);
    const approved = await loadAcceptedStoryExecution(clone, WORK); assert.equal(approved.workflow.phases.implementation.status, 'approved');
    assert.equal(f.git('ls-files', '--', 'NOTES.md').stdout, '');
  });

test('request changes preserves the rejected bytes, requires correction, and refuses forged decisions',
  { timeout: 240000, skip: process.platform === 'win32' || !existsSync('/usr/bin/expect') }, async t => {
    const f = await fixture(t); let { definition, workflow } = await f.load();
    const prepared = await preparePhaseAppeal(f.root, definition, workflow, request);
    await submitPhaseAppeal(f.root, definition, workflow, { ...request, confirm: prepared.packetSha256 });
    await liveReview(f.root, prepared.id, prepared.packetSha256, 'decide', 'request-changes', true);
    ({ definition, workflow } = await f.load());
    assert.equal((await phaseAppealStatus(f.root, definition, workflow)).items[0].status, 'correction-required');
    await assert.rejects(assertPhaseAppealsResolved(f.root, definition, workflow, workflow.phases.implementation), { code: 'PHASE_APPEAL_REVIEW_REQUIRED' });
    assert.equal(workflow.planAmendments?.length ?? 0, 0);
    await f.write('src/helper.mjs', 'export const approved = 3;\n');
    assert.equal((await phaseAppealStatus(f.root, definition, workflow)).status, 'ready', 'normal scope/test gates still assess the changed candidate');
    const forged = structuredClone(workflow); forged.phaseAppealDecisions[0].testsWaived = true;
    await assert.rejects(phaseAppealStatus(f.root, definition, forged), { code: 'PHASE_APPEAL_INTEGRITY' });
    const retained = `${f.item}/appeals/${prepared.id}/packet.json`;
    await f.write(retained, canonicalJson(sealed({ ...prepared, reason: 'Rewritten purpose that the original human did not approve.' })));
    await assert.rejects(phaseAppealStatus(f.root, definition, workflow), { code: 'PHASE_APPEAL_INTEGRITY' });
  });
