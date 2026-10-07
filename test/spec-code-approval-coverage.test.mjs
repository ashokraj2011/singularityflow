import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSpecIndex, canonicalJson, deriveObservedClaimMap, normalizeClaimMap
} from '../src/specifications.mjs';
import { assertCandidateSpecificationCoverage, inspectUnclaimedChangedPaths } from '../src/spec-coverage-preview.mjs';
import { assertFinalCodeSpecificationCoverage } from '../src/state.mjs';
import { STORY_DECISION_LISTS, storyDecisionsDigest } from '../src/phase-upstream.mjs';
import { currentSchemaVersion, readRecord } from '../src/schema-migrations.mjs';
import { acceptQualityRisk, coverageRiskEligibility, inspectPhaseQualityGate, normalizeQualityGateMode,
  prepareQualityRisk, qualityRiskBinding, qualityRiskStatus, validateQualityRiskPacket } from '../src/phase-quality-risk.mjs';

const ID = 'COVER-1';
const ITEM = `singularity/work-items/${ID}`;
const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function git(root, ...args) {
  const result = spawnSync('git', ['-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], {
    cwd: root, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function write(root, relative, contents) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function fixture({ baselineFirst = false, supportingFiles = [], steps = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-code-coverage-'));
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Coverage Test');
  git(root, 'config', 'user.email', 'coverage@example.invalid');
  await write(root, 'README.md', '# Project\n');
  if (baselineFirst) await write(root, 'src/first.mjs', 'export const first = false;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'baseline');
  const baseCommit = git(root, 'rev-parse', 'HEAD');

  const sourcePath = `${ITEM}/artifacts/specification/spec.md`;
  await write(root, sourcePath, [
    '# Specification', '',
    '## Requirements', '',
    '[COVER-1:REQ-001]', 'Implement the first behavior.', '',
    '[COVER-1:REQ-002]', 'Implement the second behavior.', ''
  ].join('\n'));
  const indexPath = `${ITEM}/context/spec-indexes/specification-gen1.json`;
  const index = await buildSpecIndex(root, sourcePath, {
    workId: ID, phase: 'specification', generation: 1, outputPath: indexPath,
    policy: { mode: 'enforce', coverage: 'enforce' }
  });
  const ids = index.clauses.map((clause) => clause.id);
  const plannedPath = `${ITEM}/context/claims/planning-gen1-planned.json`;
  const planned = {
    ...normalizeClaimMap({ claims: {
      'COVER-1:REQ-001': {
        expectedPaths: ['src/first.mjs'], tests: [], testDisposition: 'not-applicable',
        testReason: 'The required compile-time contract is checked without a runtime test.',
        ...(steps ? { steps: [steps[0]] } : {})
      },
      'COVER-1:REQ-002': {
        expectedPaths: ['src/second.mjs'], tests: [], testDisposition: 'not-applicable',
        testReason: 'The required compile-time contract is checked without a runtime test.',
        ...(steps ? { steps: [steps[1]] } : {})
      }
    }, supportingFiles }, { kind: 'planned', clauseIds: ids }),
    workId: ID, phase: 'planning', generation: 1
  };
  await write(root, plannedPath, canonicalJson(planned));

  await write(root, 'src/first.mjs', '// @clause:COVER-1:REQ-001\nexport const first = true;\n');
  const observedPath = `${ITEM}/context/claims/implementation-gen1-observed.json`;
  const observedRecord = (paths) => ({
    ...deriveObservedClaimMap(planned, {
      sourcePaths: paths,
      traceability: { sourceBindings: paths.map((sourcePath) => ({
        clauseId: sourcePath === 'src/first.mjs' ? 'COVER-1:REQ-001' : 'COVER-1:REQ-002',
        sourcePath
      })) }
    }, { clauseIds: ids, requireSourceBindings: true, generationCommit: baseCommit }),
    workId: ID, phase: 'implementation', generation: 1
  });
  const observed = observedRecord(['src/first.mjs']);
  await write(root, observedPath, canonicalJson(observed));
  const workflow = {
    workItem: { id: ID, workType: 'spec-driven-standard', baseCommit, baseBranch: 'main' },
    phaseOrder: ['specification', 'planning', 'implementation'],
    resolution: {
      spec: { mode: 'enforce', coverage: 'enforce' },
      plannedClaims: {
        mode: 'required', clausePhases: ['specification'],
        owners: { implementation: 'planning' }
      }
    },
    phases: {
      specification: {
        id: 'specification', generation: 1,
        requiredArtifact: { path: 'artifacts/specification/spec.md', kind: 'requirements' },
        artifacts: [{ path: sourcePath, status: 'approved', sha256: index.source.sha256, size: index.source.bytes }],
        specIndex: {
          path: indexPath, generation: 1, clauses: index.clauses.length,
          indexSha256: index.indexSha256, sourceSha256: index.source.sha256
        }
      },
      planning: {
        id: 'planning', generation: 1,
        claimMaps: { planned: { path: plannedPath, generation: 1, sha256: digest(planned) } }
      },
      implementation: {
        id: 'implementation', generation: 1,
        requiredArtifact: { kind: 'implementation-summary' },
        claimMaps: { observed: { path: observedPath, generation: 1, sha256: digest(observed) } }
      }
    }
  };
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'partial implementation evidence');
  return { root, config: { workItemRoot: 'singularity/work-items' }, workflow, observedPath, observedRecord };
}

test('final code approval refuses incomplete pinned clause coverage, then accepts exact completion', async () => {
  const { root, config, workflow, observedPath, observedRecord } = await fixture();
  const phase = workflow.phases.implementation;
  const partialCommit = git(root, 'rev-parse', 'HEAD');
  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(root, config, workflow, phase, partialCommit),
    (error) => error.code === 'SPEC_COVERAGE_INCOMPLETE'
      && error.details.coverage.unimplemented.includes('COVER-1:REQ-002')
      && /COVER-1:REQ-002/.test(error.message)
  );
  assert.equal(git(root, 'status', '--porcelain'), '', 'the refusal changed committed evidence');

  await write(root, 'src/second.mjs', '// @clause:COVER-1:REQ-002\nexport const second = true;\n');
  const complete = observedRecord(['src/first.mjs', 'src/second.mjs']);
  await write(root, observedPath, canonicalJson(complete));
  phase.claimMaps.observed.sha256 = digest(complete);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'complete second clause');
  const coverage = await assertFinalCodeSpecificationCoverage(
    root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')
  );
  assert.equal(coverage.complete, true);
  assert.equal(coverage.totals.observed, 2);

  // A changed source-bound claim after submission cannot be quietly accepted at approval.
  await write(root, observedPath, `${await readFile(path.join(root, observedPath), 'utf8')}\n`);
  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')),
    (error) => error.code === 'SPECIFICATION_INPUT_NOT_COMMITTED'
  );
});

test('published approval coverage is visible in appeal inspection; soft alone never waives it', async () => {
  const f = await fixture(); const phase = f.workflow.phases.implementation;
  phase.generationCommit = git(f.root, 'rev-parse', 'HEAD'); phase.status = 'awaiting_approval';
  f.workflow.status = 'in_progress'; f.workflow.currentPhase = phase.id;
  const before = git(f.root, 'rev-parse', 'HEAD');
  const inspection = await inspectPhaseQualityGate(f.root, f.config, f.workflow, phase);
  assert.equal(inspection.status, 'resolution-required');
  assert.equal(inspection.findings[0].code, 'SPEC_COVERAGE_INCOMPLETE');
  assert.equal(inspection.risks.eligible, true);
  assert.deepEqual(inspection.risks.remaining, ['COVER-1:REQ-002']);
  assert.equal(inspection.risks.gateMode, 'hard');
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), before);
  assert.equal(git(f.root, 'status', '--porcelain'), '');
  const expires = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const request = { expires, reason: 'The second behavior is explicitly deferred for this pilot.' };
  await assert.rejects(prepareQualityRisk(f.root, f.config, f.workflow, request), { code: 'PHASE_QUALITY_RISK_HARD_MODE' });
  const packet = await prepareQualityRisk(f.root, f.config, f.workflow, { ...request, gateMode: 'soft' });
  assert.equal(packet.enablesPilotForPhase, true);
  assert.deepEqual(packet.clauses, ['COVER-1:REQ-002']);
  assert.deepEqual(packet.transitions, ['approve', 'consume', 'submit', 'terminal']);
  assert.deepEqual(validateQualityRiskPacket(packet), packet);
  const altered = { ...packet, reason: 'An entirely different unchecked explanation of the change.' };
  assert.throws(() => validateQualityRiskPacket(altered), { code: 'PHASE_QUALITY_RISK_INTEGRITY' });
  for (const change of [{ clauses: ['OTHER:REQ-002'] }, { transitions: ['everything'] },
    { expires: '2026-02-30' }, { expires: '2099-01-01' }, { reason: 'short' }]) {
    await assert.rejects(prepareQualityRisk(f.root, f.config, f.workflow, { ...request, gateMode: 'soft', ...change }));
  }
  f.workflow.resolution.qualityGateMode = 'soft';
  assert.equal((await prepareQualityRisk(f.root, f.config, f.workflow, request)).enablesPilotForPhase, false);
  await assert.rejects(assertFinalCodeSpecificationCoverage(f.root, f.config, f.workflow, phase, phase.generationCommit), { code: 'SPEC_COVERAGE_INCOMPLETE' });
});

test('quality risk cannot waive integrity, unaccounted paths, withdrawn clauses or unknown gates', () => {
  assert.equal(normalizeQualityGateMode(), 'hard');
  assert.throws(() => normalizeQualityGateMode('skip-all'));
  const error = { code: 'SPEC_COVERAGE_INCOMPLETE', details: { coverage: { unimplemented: ['US:REQ-001'],
    invalidEvidence: [], unclaimedChangedPaths: [], withdrawnButClaimed: [] } } };
  assert.equal(coverageRiskEligibility(error).eligible, true);
  for (const key of ['invalidEvidence', 'unclaimedChangedPaths', 'withdrawnButClaimed']) {
    const altered = structuredClone(error); altered.details.coverage[key].push('untrusted');
    assert.equal(coverageRiskEligibility(altered).eligible, false);
  }
  for (const code of ['CODE_TEST_FAILED', 'STORY_POLICY_ANCHOR_INVALID', 'PROTECTED_PATH', 'unknown']) {
    assert.equal(coverageRiskEligibility({ ...error, code }).eligible, false);
  }
});

test('risk decisions survive the Story reader and invalidate downstream rework decisions without legacy drift', () => {
  const workflow = { schemaVersion: currentSchemaVersion('story-workflow'), resolution: { qualityGateMode: 'soft' } };
  const legacy = storyDecisionsDigest(workflow);
  assert.equal(legacy, `sha256:${digest(Object.fromEntries(STORY_DECISION_LISTS.map(key => [key, null])))}`);
  assert.equal(storyDecisionsDigest({ ...workflow, qualityRiskDecisions: [] }), legacy);
  workflow.qualityRiskDecisions = [{ id: 'PQR-test', reason: 'Retained risk affects the exact downstream decision.' }];
  const restored = readRecord('story-workflow', canonicalJson(workflow)).record;
  assert.deepEqual(restored.qualityRiskDecisions, workflow.qualityRiskDecisions);
  assert.equal(restored.resolution.qualityGateMode, 'soft');
  const accepted = storyDecisionsDigest(restored);
  assert.notEqual(accepted, legacy);
  restored.qualityRiskDecisions.push({ id: 'revocation-test', revokes: 'PQR-test' });
  assert.notEqual(storyDecisionsDigest(restored), accepted);
});

test('exact committed risk needs live human origin; stale/expired/revoked decisions cannot waive the gate',
  { skip: process.platform === 'win32' || !existsSync('/usr/bin/expect') }, async () => {
    const f = await fixture(); const phase = f.workflow.phases.implementation;
    phase.generationCommit = git(f.root, 'rev-parse', 'HEAD'); phase.status = 'in_progress';
    phase.approvalPolicy = { mode: 'required', minimum: 1, authorities: ['engineers'], requiredAuthorities: [] };
    f.workflow.status = 'in_progress'; f.workflow.currentPhase = phase.id;
    f.workflow.resolution.approvalAuthorities = { engineers: { label: 'Engineering', allowAnyGitIdentity: true, members: [] } };
    const options = { gateMode: 'soft', expires: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      reason: 'The second behavior is deliberately deferred during this pilot.' };
    const packet = await prepareQualityRisk(f.root, f.config, f.workflow, options);
    await assert.rejects(acceptQualityRisk(f.root, f.config, f.workflow, { ...options, confirm: packet.packetSha256 }), { code: 'ACTION_TERMINAL_PRESENTATION_REQUIRED' });
    const record = { ...packet, id: `PQR-${packet.packetSha256.slice(7, 31)}`, actor: 'coverage@example.invalid',
      authorityGroup: 'engineers', identityAssurance: null, authorizationId: 'original-human-review',
      reviewAssurance: 'live-terminal-risk-review', at: new Date().toISOString(), testsWaived: false, phaseApproved: false };
    f.workflow.qualityRiskDecisions = [record];
    await write(f.root, `${ITEM}/workflow.json`, canonicalJson(f.workflow));
    git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'retain public human decision without local proof');
    let failure;
    try { await assertFinalCodeSpecificationCoverage(f.root, f.config, f.workflow, phase, phase.generationCommit); } catch (error) { failure = error; }
    assert.equal(failure.code, 'SPEC_COVERAGE_INCOMPLETE');
    assert.equal(failure.details.qualityRisk.items[0].status, 'needs-reattestation');
    const code = `import {attestQualityRisk} from ${JSON.stringify(new URL('../src/phase-quality-risk.mjs', import.meta.url).href)};
      const result=await attestQualityRisk(${JSON.stringify(f.root)},${JSON.stringify(f.config)},${JSON.stringify(f.workflow)},${JSON.stringify({ id: record.id, confirm: `sha256:${digest(record)}` })});
      console.log('RESULT:'+result.status);`;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    const ceremony = spawnSync('/usr/bin/expect', ['-c', `set timeout 20\nspawn -noecho $env(PQR_NODE) --input-type=module -e $env(PQR_CODE)\nexpect "Type Re-review risk ${record.id} to confirm this exact action, or Enter to cancel:"\nsend -- "Re-review risk ${record.id}\\r"\nexpect eof\ncatch wait result\nexit [lindex $result 3]`],
      { cwd: f.root, encoding: 'utf8', timeout: 30000, env: { ...environment, PQR_NODE: process.execPath, PQR_CODE: code } });
    assert.equal(ceremony.status, 0, ceremony.stdout + ceremony.stderr);
    assert.match(ceremony.stdout, /risk-review-origin-restored/);
    const coverage = await assertFinalCodeSpecificationCoverage(f.root, f.config, f.workflow, phase, phase.generationCommit);
    assert.equal(coverage.complete, false); assert.equal(coverage.acceptedRisk.excepted, true);
    assert.deepEqual(coverage.acceptedRisk.accepted, ['COVER-1:REQ-002']);
    assert.equal(coverage.acceptedRisk.testsWaived, false);
    assert.equal((await qualityRiskStatus(f.root, f.config, f.workflow, phase, failure,
      { at: new Date(Date.now() + 8 * 86400000).toISOString() })).items[0].status, 'expired');
    const binding = qualityRiskBinding(f.workflow, phase);
    phase.generation = 2;
    assert.notDeepEqual(qualityRiskBinding(f.workflow, phase), binding);
    assert.equal((await qualityRiskStatus(f.root, f.config, f.workflow, phase, failure)).items[0].status, 'stale');
    phase.generation = 1;
    const narrowed = { code: failure.code, details: structuredClone(failure.details) }; narrowed.details.coverage.unimplemented.push('COVER-1:REQ-003');
    assert.equal((await qualityRiskStatus(f.root, f.config, f.workflow, phase, narrowed)).items[0].status, 'observation-changed');
    f.workflow.qualityRiskDecisions.push({ kind: 'phase-quality-risk-revocation', id: 'revoke-test', revokes: record.id,
      reason: 'Pilot exception is no longer appropriate for this change.', actor: record.actor,
      authorityGroup: record.authorityGroup, authorizationId: 'human-revocation', at: new Date().toISOString() });
    await write(f.root, `${ITEM}/workflow.json`, canonicalJson(f.workflow)); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'retain revocation');
    assert.equal((await qualityRiskStatus(f.root, f.config, f.workflow, phase, failure)).items[0].status, 'revoked');
    await assert.rejects(assertFinalCodeSpecificationCoverage(f.root, f.config, f.workflow, phase, phase.generationCommit), { code: 'SPEC_COVERAGE_INCOMPLETE' });
    f.workflow.qualityRiskDecisions.pop();
    await write(f.root, `${ITEM}/workflow.json`, canonicalJson(f.workflow)); git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'attempt to erase revocation');
    await assert.rejects(qualityRiskStatus(f.root, f.config, f.workflow, phase, failure), { code: 'PHASE_QUALITY_RISK_INTEGRITY' });
    f.workflow.qualityRiskDecisions[0].reason = 'Tampered decision that is not present in committed history.';
    await assert.rejects(qualityRiskStatus(f.root, f.config, f.workflow, phase, failure), { code: 'PHASE_QUALITY_RISK_INTEGRITY' });
  });

test('editable candidate coverage catches incomplete delivery without consuming the generation', async () => {
  const { root, config, workflow } = await fixture();
  workflow.resolution.codeDelivery = { traceability: { sourceBindings: 'enforce' } };
  const before = git(root, 'status', '--porcelain');
  const candidate = (paths) => ({ sourcePaths: paths, testPaths: [], fulfillment: [],
    sourceBindings: { bindings: paths.map((sourcePath, index) => ({ sourcePath, clauseId: `COVER-1:REQ-00${index + 1}` })) },
    changeSet: { entries: paths.map((newPath) => ({ newPath })) } });
  await assert.rejects(() => assertCandidateSpecificationCoverage(root, config, workflow, workflow.phases.implementation,
    candidate(['src/first.mjs'])), (error) => error.code === 'SPEC_COVERAGE_INCOMPLETE'
      && error.details.coverage.unimplemented.includes('COVER-1:REQ-002'));
  assert.equal(git(root, 'status', '--porcelain'), before);
  const result = await assertCandidateSpecificationCoverage(root, config, workflow, workflow.phases.implementation,
    candidate(['src/first.mjs', 'src/second.mjs']));
  assert.equal(result.complete, true);
  const retained = workflow.phases.implementation.claimMaps.observed;
  delete workflow.phases.implementation.claimMaps.observed;
  assert.equal((await assertCandidateSpecificationCoverage(root, config, workflow, workflow.phases.implementation,
    candidate(['src/first.mjs', 'src/second.mjs']))).complete, true, 'the candidate derives its observation before the first publication exists');
  await assert.rejects(assertFinalCodeSpecificationCoverage(root, config, workflow, workflow.phases.implementation,
    git(root, 'rev-parse', 'HEAD')), { code: 'SPECIFICATION_CLAIM_MAP_BINDING_REQUIRED' });
  workflow.phases.implementation.claimMaps.observed = retained;
});

test('live pilot acceptance commits only decision metadata and keeps its human event identity',
  { skip: process.platform === 'win32' || !existsSync('/usr/bin/expect') }, async () => {
    const f = await fixture(); const phase = f.workflow.phases.implementation;
    phase.generationCommit = git(f.root, 'rev-parse', 'HEAD'); phase.status = 'awaiting_approval';
    phase.generatedAgent = 'developer';
    phase.approvalPolicy = { mode: 'required', minimum: 1, authorities: ['engineers'], requiredAuthorities: [] };
    f.workflow.workItem.branch = 'main'; f.workflow.history = [];
    f.workflow.status = 'in_progress'; f.workflow.currentPhase = phase.id;
    for (const [order, id] of f.workflow.phaseOrder.entries()) Object.assign(f.workflow.phases[id], {
      order, label: id, approvals: [], usage: [], status: f.workflow.phases[id].status ?? 'approved'
    });
    f.workflow.resolution.approvalAuthorities = { engineers: { label: 'Engineering', allowAnyGitIdentity: true, members: [] } };
    f.workflow.resolution.workType = f.workflow.workItem.workType;
    f.workflow.phases.planning.requiredArtifact = { path: 'artifacts/planning/plan.md', kind: 'implementation-plan' };
    await write(f.root, `${ITEM}/artifacts/planning/plan.md`, '# Pinned plan\n');
    f.config.git = { publish: 'off' };
    await write(f.root, `${ITEM}/workflow.json`, canonicalJson(f.workflow));
    git(f.root, 'add', '.'); git(f.root, 'commit', '-m', 'legacy submitted generation with a coverage gap');
    const options = { phaseId: phase.id, gateMode: 'soft', expires: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
      reason: 'The second behavior is explicitly deferred during this pilot.' };
    const packet = await prepareQualityRisk(f.root, f.config, f.workflow, options);
    const id = `PQR-${packet.packetSha256.slice(7, 31)}`;
    await write(f.root, `${ITEM}/artifacts/implementation/scratch.md`, 'Unfinished draft must not enter the risk commit.\n');
    await write(f.root, 'README.md', '# User-staged unrelated edit\n'); git(f.root, 'add', 'README.md');
    const index = git(f.root, 'diff', '--cached');
    const code = `import {acceptQualityRisk} from ${JSON.stringify(new URL('../src/phase-quality-risk.mjs', import.meta.url).href)};
      const result=await acceptQualityRisk(${JSON.stringify(f.root)},${JSON.stringify(f.config)},${JSON.stringify(f.workflow)},${JSON.stringify({ ...options, confirm: packet.packetSha256 })});
      console.log('RESULT:'+result.status);`;
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    const ceremony = spawnSync('/usr/bin/expect', ['-c', `set timeout 30\nspawn -noecho $env(PQR_NODE) --input-type=module -e $env(PQR_CODE)\nexpect "Type Accept risk ${id} to confirm this exact action, or Enter to cancel:"\nsend -- "Accept risk ${id}\\r"\nexpect eof\ncatch wait result\nexit [lindex $result 3]`],
      { cwd: f.root, encoding: 'utf8', timeout: 40000, env: { ...environment, PQR_NODE: process.execPath, PQR_CODE: code } });
    assert.equal(ceremony.status, 0, ceremony.stdout + ceremony.stderr);
    assert.match(ceremony.stdout, /RESULT:risk-accepted/);
    const retained = JSON.parse(await readFile(path.join(f.root, ITEM, 'workflow.json'), 'utf8'));
    assert.equal(retained.qualityRiskDecisions[0].id, id);
    assert.equal(retained.phases.implementation.status, 'awaiting_approval');
    assert.equal(retained.phases.implementation.generationCommit, phase.generationCommit);
    assert.equal(retained.publicationProjections.at(-1).event.agent, null, 'human risk is not attributed to the code author agent');
    assert.equal(retained.publicationProjections.at(-1).event.payload.decision, 'quality-risk');
    assert.deepEqual(git(f.root, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').sort(),
      [`${ITEM}/STATUS.md`, `${ITEM}/workflow.json`].sort());
    assert.equal(git(f.root, 'diff', '--cached'), index, 'the pre-existing user index is preserved');
    const coverage = await assertFinalCodeSpecificationCoverage(f.root, f.config, retained, retained.phases.implementation, phase.generationCommit);
    assert.equal(coverage.acceptedRisk.excepted, true);
    assert.equal((await inspectPhaseQualityGate(f.root, f.config, retained, retained.phases.implementation)).status, 'ready-with-accepted-risk');
  });

test('historical and intermediate code phases retain their pinned coverage boundary', async () => {
  const { root, config, workflow } = await fixture();
  const phase = workflow.phases.implementation;
  const revision = git(root, 'rev-parse', 'HEAD');
  workflow.resolution.spec.coverage = 'off';
  assert.equal(await assertFinalCodeSpecificationCoverage(root, config, workflow, phase, revision), null);
  workflow.resolution.spec.coverage = 'enforce';
  workflow.phases.finalization = {
    id: 'finalization', generation: 0,
    requiredArtifact: { kind: 'implementation-summary' }
  };
  workflow.phaseOrder.push('finalization');
  assert.equal(await assertFinalCodeSpecificationCoverage(root, config, workflow, phase, revision), null);
});

test('an earlier code step answers for the rows allocated to it, and only those', async () => {
  const { root, config, workflow } = await fixture({ steps: ['implementation', 'finalization'] });
  workflow.phases.finalization = { id: 'finalization', generation: 0, requiredArtifact: { kind: 'implementation-summary' } };
  workflow.phaseOrder.push('finalization');
  workflow.resolution.plannedClaims.owners.finalization = 'planning';
  const revision = git(root, 'rev-parse', 'HEAD');
  // REQ-001 is allocated here and implemented; REQ-002 belongs to the later step.
  const coverage = await assertFinalCodeSpecificationCoverage(root, config, workflow, workflow.phases.implementation, revision);
  assert.deepEqual(coverage.unimplemented, ['COVER-1:REQ-002']);

  const swapped = await fixture({ steps: ['finalization', 'implementation'] });
  swapped.workflow.phases.finalization = { id: 'finalization', generation: 0, requiredArtifact: { kind: 'implementation-summary' } };
  swapped.workflow.phaseOrder.push('finalization');
  swapped.workflow.resolution.plannedClaims.owners.finalization = 'planning';
  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(swapped.root, swapped.config, swapped.workflow, swapped.workflow.phases.implementation,
      git(swapped.root, 'rev-parse', 'HEAD')),
    (error) => error.code === 'SPEC_COVERAGE_INCOMPLETE' && error.details.open.join() === 'COVER-1:REQ-002'
      && /rows the plan allocates to it are not implemented/.test(error.message)
  );
});

test('final code approval refuses a claimed source path reverted to its pre-Story bytes', async () => {
  const { root, config, workflow, observedRecord } = await fixture({ baselineFirst: true });
  const finalPath = `${ITEM}/context/claims/finalization-gen1-observed.json`;
  workflow.phaseOrder.push('finalization');
  workflow.resolution.plannedClaims.owners.finalization = 'planning';
  const phase = workflow.phases.finalization = {
    id: 'finalization', generation: 1,
    requiredArtifact: { kind: 'implementation-summary' },
    claimMaps: { observed: { path: finalPath, generation: 1 } }
  };
  await write(root, 'src/first.mjs', 'export const first = false;\n');
  await write(root, 'src/second.mjs', '// @clause:COVER-1:REQ-002\nexport const second = true;\n');
  const observed = { ...observedRecord(['src/first.mjs', 'src/second.mjs']), phase: 'finalization' };
  await write(root, finalPath, canonicalJson(observed));
  phase.claimMaps.observed.sha256 = digest(observed);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'revert first clause while implementing second');

  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')),
    (error) => error.code === 'SPEC_COVERAGE_INCOMPLETE'
      && error.details.coverage.invalidEvidence.some((message) =>
        message.includes('COVER-1:REQ-001') && message.includes('src/first.mjs'))
  );
});

test('final code approval retains exact source deletion as implementation evidence', async () => {
  const { root, config, workflow, observedPath, observedRecord } = await fixture({ baselineFirst: true });
  const phase = workflow.phases.implementation;
  await unlink(path.join(root, 'src/first.mjs'));
  await write(root, 'src/second.mjs', '// @clause:COVER-1:REQ-002\nexport const second = true;\n');
  const observed = observedRecord(['src/first.mjs', 'src/second.mjs']);
  await write(root, observedPath, canonicalJson(observed));
  phase.claimMaps.observed.sha256 = digest(observed);
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'delete obsolete first source and implement second');

  const coverage = await assertFinalCodeSpecificationCoverage(
    root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')
  );
  assert.equal(coverage.complete, true);
});

test('a changed file the plan lists under Supporting files needs no clause, and prepublish names any other', async () => {
  const { root, config, workflow, observedPath, observedRecord } = await fixture({ supportingFiles: ['package.json'] });
  const phase = workflow.phases.implementation;
  await write(root, 'src/second.mjs', '// @clause:COVER-1:REQ-002\nexport const second = true;\n');
  await write(root, 'package.json', '{ "name": "ledger", "dependencies": { "ledger-client": "1.0.0" } }\n');
  await write(root, 'Makefile', 'build:\n\ttrue\n');
  const complete = observedRecord(['src/first.mjs', 'src/second.mjs']);
  await write(root, observedPath, canonicalJson(complete));
  phase.claimMaps.observed.sha256 = digest(complete);

  // Before submission: the preview names the one path approval would refuse.
  const preview = await inspectUnclaimedChangedPaths(root, config, workflow, phase);
  assert.equal(preview.coverage.status, 'unclaimed');
  assert.deepEqual(preview.advisories.map((advisory) => advisory.path), ['Makefile']);
  assert.equal(preview.advisories[0].blocking, false);
  assert.match(preview.advisories[0].message, /not under the plan's Supporting files; approving this phase would refuse it/);

  git(root, 'add', '.');
  git(root, 'commit', '-m', 'complete with supporting files');
  await assert.rejects(
    () => assertFinalCodeSpecificationCoverage(root, config, workflow, phase, git(root, 'rev-parse', 'HEAD')),
    (error) => error.code === 'SPEC_COVERAGE_INCOMPLETE'
      && error.details.coverage.unclaimedChangedPaths.join() === 'Makefile'
      && error.details.coverage.supportingChangedPaths.join() === 'package.json'
  );
  git(root, 'rm', '-q', 'Makefile');
  git(root, 'commit', '-q', '-m', 'drop the unplanned change');
  const coverage = await assertFinalCodeSpecificationCoverage(root, config, workflow, phase, git(root, 'rev-parse', 'HEAD'));
  assert.equal(coverage.complete, true);
  assert.equal((await inspectUnclaimedChangedPaths(root, config, workflow, phase)).coverage.status, 'ready');
});
