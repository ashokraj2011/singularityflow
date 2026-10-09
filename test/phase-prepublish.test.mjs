import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { phasePrepublish, prepublishTestExecutionLines } from '../src/phase-prepublish.mjs';
import { buildSpecIndex, derivePlannedClaimMap } from '../src/specifications.mjs';
import { coordinatePhaseRepair } from '../src/phase-repair-runtime.mjs';
import { restoreAgentSession } from '../src/session.mjs';
import { testExecutionHandoff } from '../src/test-execution-handoff.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-prepublish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const relative = 'singularity/work-items/PRE-1/artifacts/planning/plan.md';
  const absolute = path.join(root, relative);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, '# Plan\n\nTODO describe the plan.\n');
  const phase = {
    id: 'planning', label: 'Planning', status: 'in_progress', generation: 0,
    generationPolicy: { defaultProducer: 'governed-agent', allowedProducers: ['governed-agent'] },
    requiredArtifact: { path: 'artifacts/planning/plan.md', minimumBytes: 20,
      validation: { requiredHeadings: ['Plan'], forbiddenPlaceholders: [] } },
    artifacts: []
  };
  const workflow = { workItem: { id: 'PRE-1' }, currentPhase: 'planning',
    resolution: { phases: [], artifactSets: {} }, phases: { planning: phase } };
  const session = { workId: 'PRE-1', phaseId: 'planning', agent: 'architect' };
  return { root, absolute, config: { workItemRoot: 'singularity/work-items' }, workflow, phase, session };
}

test('human prepublish test preview prints inferred argv and withholds configured secrets', () => {
  const plan = {
    status: 'not-run', commands: [
      { id: 'maven-tests', availability: 'ready', argvSource: 'inferred', argv: ['mvn', 'test'],
        workingDirectory: 'module', result: { adapter: 'junit-xml', path: 'target/surefire-reports' } },
      { id: 'qualityCommands[0]', availability: 'ready', argvSource: 'approved-configuration',
        argv: ['node', 'tests.mjs', '--token', 'hidden-configured-secret'],
        workingDirectory: '.', result: { adapter: 'node-tap', path: '.sflow/results/tests.tap' } }
    ]
  };
  const lines = prepublishTestExecutionLines({ ...plan, handoff: testExecutionHandoff(plan) });
  assert.match(lines.join('\n'), /argv=\["mvn","test"\] cwd=module report=junit-xml:target\/surefire-reports/u);
  assert.match(lines.join('\n'), /planned, not run by prepublish/u);
  assert.match(lines.join('\n'), /argv=\[see approved qualityCommands configuration\]/u);
  assert.doesNotMatch(lines.join('\n'), /hidden-configured-secret/u);
  assert.match(lines.join('\n'), /Runner: ready; hidden approved arguments/u);
  assert.match(lines.join('\n'), /passing fresh results continue that operation automatically/u);
});

test('prepublish routes authored findings to same-phase correction, then enables publication only when ready', async (t) => {
  const item = await fixture(t);
  const original = await readFile(item.absolute, 'utf8');
  const red = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(red.resultType, 'sflow-phase-prepublish');
  assert.equal(red.status, 'correction-required');
  assert.equal(red.workId, 'PRE-1');
  assert.equal(red.phase, 'planning');
  assert.equal(red.readiness.authoring, false);
  assert.equal(red.correction.sameTurn, true);
  assert.equal(red.commands.publish, null);
  assert.equal(red.commandGuidance.publish, null);
  assert.equal(red.testExecution.handoff.command, null);
  assert.equal(red.testExecution.handoff.runnerStatus, 'not-required');
  assert.equal(red.commandGuidance.recheck.copilotCommand, null);
  assert.match(red.commandGuidance.recheck.copilotReason, /No dedicated Copilot equivalent/);
  assert.equal(red.commandGuidance.recover.copilotCommand, '/sf-recover');
  assert.equal(red.commands.recheck, 'singularity-flow phase prepublish planning --json');
  assert.equal(red.mutates, false);
  assert.equal(await readFile(item.absolute, 'utf8'), original);

  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  const ready = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.findings, []);
  assert.equal(ready.readiness.lifecycle, true);
  assert.equal(ready.readiness.knownRecoveryBlockers, true);
  assert.match(ready.commands.publish, /phase publish planning --authored governed-agent/u);
  assert.equal(ready.commandGuidance.publish.copilotStatus, 'unavailable');
  assert.notEqual(ready.draftFingerprint, red.draftFingerprint);
});

test('prepublish never presents a publish command for a non-current or non-in-progress phase', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  item.workflow.currentPhase = 'verification';
  const red = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(red.status, 'correction-required');
  assert.equal(red.readiness.lifecycle, false);
  assert.equal(red.commands.publish, null);
  assert.ok(red.findings.some((finding) => finding.code === 'phase.lifecycle.not-publishable'));
});

test('staged owned draft paths need review before publish, while unrelated index bytes stay untouched', async t => {
  const item = await fixture(t);
  const git = (...args) => execFileSync('git', args, { cwd: item.root, encoding: 'utf8' });
  git('checkout', '-qb', 'PRE-1');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'baseline');
  item.workflow.workItem.branch = 'PRE-1'; item.workflow.status = 'in_progress';
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  await writeFile(path.join(item.root, 'unrelated.txt'), 'Keep this independently staged change.\n');
  git('add', 'unrelated.txt');
  const unrelatedIndex = git('ls-files', '--stage');
  const call = () => phasePrepublish(item.root, item.config, item.workflow, item.phase, { session: item.session });
  assert.equal((await call()).status, 'ready');
  assert.equal(git('ls-files', '--stage'), unrelatedIndex);
  git('add', item.absolute);
  const stagedIndex = git('ls-files', '--stage');
  const blocked = await call();
  assert.equal(blocked.status, 'correction-required');
  assert.equal(blocked.commands.publish, null);
  assert.equal(blocked.correction.skill, '/sf-recover');
  assert.ok(blocked.findings.some(f => f.code === 'LIFECYCLE_STAGED_GOVERNED_REVIEW_REQUIRED'));
  assert.equal(git('ls-files', '--stage'), stagedIndex);
});

test('real prepublish reserves and resumes owned corrections without treating its own journal hold as a blocker', async t => {
  const item = await fixture(t);
  execFileSync('git', ['checkout', '-qb', 'repair-story'], { cwd: item.root });
  execFileSync('git', ['add', '.'], { cwd: item.root });
  execFileSync('git', ['-c', 'user.name=Repair Fixture', '-c', 'user.email=repair@example.test', 'commit', '-qm', 'Fixture baseline'], { cwd: item.root });
  item.workflow.status = 'in_progress'; item.workflow.workItem.branch = 'repair-story';
  await restoreAgentSession(item.root, item.session);
  const call = (action, confirmation = null) => coordinatePhaseRepair({ root: item.root, phaseId: 'planning', action, confirmation },
    { load: async () => ({ definition: item.config, workflow: item.workflow }) });
  const plan = await call('plan');
  assert.equal(plan.action?.id, 'owned-producer-repair');
  assert.equal(plan.status, 'confirmation-required');
  assert.equal((await call('run', plan.confirmation)).status, 'awaiting-producer-repair');
  const held = await phasePrepublish(item.root, item.config, item.workflow, item.phase, { session: item.session });
  assert.equal(held.status, 'correction-required');
  assert.equal(held.repairLoop.status, 'recheck-required');
  assert.equal(held.commands.next, 'singularity-flow appeal repair-resume --phase planning --json');
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  const resumed = await call('resume');
  assert.equal(resumed.result, 'ready'); assert.equal(resumed.consumed, 1);
  const ready = await phasePrepublish(item.root, item.config, item.workflow, item.phase, { session: item.session });
  assert.equal(ready.status, 'ready'); assert.equal(ready.repairLoop.active, null);
});

test('prepublish reports missing governed grounding as guidance and still offers publication', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  // A Story pinned `enforce` acts as `warn`: the World Model never blocks publication.
  for (const mode of ['enforce', 'warn']) {
    item.workflow.resolution.worldModelGrounding = mode;
    const result = await phasePrepublish(item.root, item.config, item.workflow, item.phase, { session: item.session });
    assert.equal(result.status, 'ready', mode);
    assert.equal(result.grounding.status, 'warning', mode);
    assert.match(result.grounding.warnings.join('\n'), /grounding composition is missing/);
    assert.equal(result.findings.some((entry) => String(entry.code).startsWith('phase.grounding.')), false);
    assert.equal(result.mutates, false);
  }

  item.phase.generationPolicy = { defaultProducer: 'human', allowedProducers: ['human'] };
  const human = await phasePrepublish(item.root, item.config, item.workflow, item.phase, { session: item.session });
  assert.equal(human.status, 'ready', 'human authorship has no model-grounding requirement');
  assert.equal(human.grounding.status, 'not-applicable');
});

test('prepublish reports an invalid retained grounding receipt without blocking or rewriting it', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  item.workflow.resolution.worldModelGrounding = 'enforce';
  const receipt = path.join(item.root, 'singularity/work-items/PRE-1/context/planning-gen1.json');
  await mkdir(path.dirname(receipt), { recursive: true });
  await writeFile(receipt, '{invalid receipt');
  const result = await phasePrepublish(item.root, item.config, item.workflow, item.phase, { session: item.session });
  assert.equal(result.status, 'ready');
  assert.match(result.grounding.warnings.join('\n'), /grounding composition record is not a valid receipt/);
  assert.equal(await readFile(receipt, 'utf8'), '{invalid receipt');
});

test('prepublish refuses a code phase before its governed generation begins', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  item.phase.id = 'implementation';
  item.phase.label = 'Implementation';
  item.phase.generationPolicy.task = 'code';
  item.workflow.currentPhase = 'implementation';
  item.workflow.phases = { implementation: item.phase };
  const result = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: { ...item.session, phaseId: 'implementation' } });
  assert.equal(result.status, 'correction-required');
  assert.equal(result.readiness.knownRecoveryBlockers, false);
  assert.equal(result.commands.publish, null);
  assert.equal(result.commands.next, 'singularity-flow phase begin implementation');
  assert.ok(result.findings.some((finding) => finding.code === 'phase.generation-intent.required'));
});

test('prepublish never promises publication for an unqualified skill phase or missing assignment', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  item.phase.kind = 'skill';
  item.workflow.resolution.collaboration = { assignmentMode: 'required' };
  const result = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(result.status, 'correction-required');
  assert.equal(result.commands.publish, null);
  assert.equal(result.correction.sameTurn, false);
  assert.ok(result.findings.some((finding) => finding.code === 'phase.skill-host.unavailable'));
  assert.ok(result.findings.some((finding) => finding.code === 'phase.assignment.required'));
});

test('prepublish refuses an unreadable retained publication marker without rewriting it', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  const marker = path.join(item.root, '.git', 'singularity-flow', 'pending-publication',
    'story--PRE-1.json');
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, '{not-json');
  const original = await readFile(marker, 'utf8');
  const result = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(result.status, 'correction-required');
  assert.equal(result.commands.publish, null);
  assert.equal(result.correction.sameTurn, false);
  assert.ok(result.findings.some((finding) => finding.code === 'phase.publication.unreadable'));
  assert.equal(await readFile(marker, 'utf8'), original);
});

test('prepublish requires a nonempty declared evidence collection', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  item.phase.artifactSet = 'planning-evidence';
  item.workflow.resolution.artifactSets['planning-evidence'] = {
    primary: 'plan.md', members: [
      { path: 'plan.md', role: 'plan', required: true },
      { path: 'evidence/', role: 'evidence', required: true }
    ]
  };
  const evidence = path.join(path.dirname(item.absolute), 'evidence');
  await mkdir(evidence);
  const blocked = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(blocked.status, 'correction-required');
  assert.equal(blocked.commands.publish, null);
  assert.equal(blocked.correction.skill, '/sf-phase');
  assert.equal(blocked.correction.class, 'agent-authoring');
  assert.equal(blocked.correction.sameTurn, true);
  assert.ok(blocked.findings.some((finding) => finding.code === 'phase.artifact-set.required-member-missing'));

  await writeFile(path.join(evidence, 'index.md'), '# Approved verification evidence\n');
  const ready = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(ready.status, 'ready');
  assert.notEqual(ready.draftFingerprint, blocked.draftFingerprint);
});

test('release evidence correction stays with the release skill', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nDeployment steps and rollback validated from approved evidence.\n');
  item.phase.id = 'release';
  item.phase.label = 'Release';
  item.phase.artifactSet = 'release-evidence';
  item.workflow.currentPhase = 'release';
  item.workflow.phases = { release: item.phase };
  item.workflow.resolution.artifactSets['release-evidence'] = {
    primary: 'plan.md', members: [
      { path: 'plan.md', role: 'plan', required: true },
      { path: 'verification/', role: 'evidence', required: true }
    ]
  };
  const result = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: { ...item.session, phaseId: 'release' } });
  assert.equal(result.status, 'correction-required');
  assert.equal(result.correction.skill, '/sf-release');
  assert.equal(result.correction.sameTurn, true);
  assert.equal(result.commands.publish, null);
});

test('prepublish routes missing evidence through lifecycle recovery once the phase awaits approval', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nImplement the approved requirements and run the planned tests.\n');
  item.phase.status = 'awaiting_approval';
  item.phase.artifactSet = 'planning-evidence';
  item.workflow.resolution.artifactSets['planning-evidence'] = {
    primary: 'plan.md', members: [
      { path: 'plan.md', role: 'plan', required: true },
      { path: 'evidence/', role: 'evidence', required: true }
    ]
  };
  const blocked = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(blocked.status, 'correction-required');
  assert.ok(blocked.findings.some((finding) => finding.code === 'phase.artifact-set.required-member-missing'));
  assert.ok(blocked.findings.some((finding) => finding.code === 'phase.lifecycle.not-publishable'));
  assert.equal(blocked.correction.class, 'phase-recovery');
  assert.equal(blocked.correction.sameTurn, false);
  assert.equal(blocked.correction.skill, '/sf-recover');
  assert.equal(blocked.commands.next, 'singularity-flow recover PRE-1 --phase planning --json');
  assert.match(blocked.correction.guidance, /before changing evidence/u);
  assert.equal(blocked.commands.publish, null);

  await writeFile(item.absolute, '# Plan\n\nTODO describe the plan.\n');
  const unfinished = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(unfinished.correction.class, 'phase-recovery');
  assert.equal(unfinished.correction.sameTurn, false);
  assert.equal(unfinished.correction.skill, '/sf-recover');
  assert.match(unfinished.correction.guidance, /before changing evidence/u);
});

test('prepublish refuses a required collection whose only evidence Git ignores', async (t) => {
  const item = await fixture(t);
  await writeFile(item.absolute, '# Plan\n\nDeployment evidence is recorded in the release bundle.\n');
  item.phase.artifactSet = 'release-evidence';
  item.workflow.resolution.artifactSets['release-evidence'] = {
    primary: 'plan.md', members: [
      { path: 'plan.md', role: 'plan', required: true },
      { path: 'evidence/', role: 'evidence', required: true }
    ]
  };
  const evidence = path.join(path.dirname(item.absolute), 'evidence');
  await mkdir(evidence);
  await writeFile(path.join(evidence, '.gitignore'), '*.log\n');
  await writeFile(path.join(evidence, 'run.log'), 'passing tests\n');
  const blocked = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(blocked.status, 'correction-required');
  assert.equal(blocked.commands.publish, null);
  assert.equal(blocked.correction.sameTurn, true);
  assert.ok(blocked.findings.some((finding) =>
    finding.code === 'phase.artifact-set.required-member-unpublishable'));

  execFileSync('git', ['add', '-f', path.relative(item.root, path.join(evidence, 'run.log'))],
    { cwd: item.root });
  const ready = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(ready.status, 'ready');
  assert.notEqual(ready.draftFingerprint, blocked.draftFingerprint);
});

test('prepublish surfaces enforced specification quality before publication without recording state', async (t) => {
  const item = await fixture(t);
  item.phase.id = 'specification';
  item.phase.requiredArtifact.kind = 'requirements';
  item.phase.specificationQuality = { mode: 'enforce' };
  item.workflow.currentPhase = 'specification';
  item.workflow.phases = { specification: item.phase };
  const session = { ...item.session, phaseId: 'specification' };
  await writeFile(item.absolute, '# Plan\n\nA complete sentence without the required review sections.\n');

  const blocked = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session });
  assert.equal(blocked.status, 'correction-required');
  assert.equal(blocked.commands.publish, null);
  assert.equal(blocked.correction.class, 'agent-authoring');
  assert.equal(blocked.correction.sameTurn, true);
  assert.deepEqual(blocked.findings.filter((finding) =>
    finding.code === 'specification.missing-required-section').map((finding) => finding.value),
  ['Actors', 'Requirements', 'User scenarios']);
  assert.equal(item.phase.generation, 0);

  await writeFile(item.absolute, '# Plan\n\nReviewed outcome.\n\n## Actors\n\nA buyer.\n\n## User scenarios\n\nA buyer completes checkout.\n\n## Requirements\n\nThe checkout accepts payment.\n');
  const ready = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.findings, []);
  assert.equal(item.phase.generation, 0);
});

test('prepublish validates a prospective specification index without writing it', async (t) => {
  const item = await fixture(t);
  item.phase.id = 'specification';
  item.phase.requiredArtifact.kind = 'requirements';
  item.workflow.currentPhase = 'specification';
  item.workflow.phases = { specification: item.phase };
  item.workflow.resolution.spec = { mode: 'enforce', namespace: 'PRE-1', acceptance: 'off' };
  const session = { ...item.session, phaseId: 'specification' };
  await writeFile(item.absolute, '# Plan\n\n[PRE-1:REQ-001]\nThe checkout accepts a payment.\n\n[PRE-1:REQ-001]\nThe checkout records a receipt.\n');

  const blocked = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session });
  assert.equal(blocked.status, 'correction-required');
  assert.ok(blocked.findings.some((finding) => finding.code === 'specification.index-invalid'
    && /duplicated/u.test(finding.message)));
  assert.equal(blocked.commands.publish, null);

  await writeFile(item.absolute, '# Plan\n\n[PRE-1:REQ-001]\nThe checkout accepts a payment.\n\n[PRE-1:AC-001]\nThe checkout records a receipt.\n');
  const ready = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session });
  assert.equal(ready.status, 'ready');
  assert.equal(item.phase.specIndex, undefined);
  await assert.rejects(readFile(path.join(item.root, 'singularity/work-items/PRE-1/context/spec-indexes/specification-gen1.json')),
    { code: 'ENOENT' });
});

test('prepublish routes an unresolved specification marker to human clarification', async (t) => {
  const item = await fixture(t);
  item.phase.id = 'specification';
  item.phase.requiredArtifact.kind = 'requirements';
  item.phase.clarification = { mode: 'off', markers: { mode: 'block' } };
  item.workflow.currentPhase = 'specification';
  item.workflow.phases = { specification: item.phase };
  await writeFile(item.absolute, '# Plan\n\n[NEEDS CLARIFICATION: May the buyer retry payment?]\n');

  const blocked = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: { ...item.session, phaseId: 'specification' } });
  assert.equal(blocked.status, 'correction-required');
  assert.equal(blocked.correction.class, 'human-input');
  assert.equal(blocked.correction.sameTurn, false);
  assert.equal(blocked.commands.next, 'singularity-flow clarification status specification --json');
  assert.equal(blocked.commands.publish, null);
  assert.ok(blocked.findings.some((finding) =>
    finding.code === 'specification.unresolved-clarification' && finding.line === 3));
});

test('prepublish checks every approved clause against the planning table without creating a claim map', async (t) => {
  const item = await fixture(t);
  item.phase.requiredArtifact.kind = 'design';
  item.workflow.phaseOrder = ['specification', 'planning', 'implementation'];
  item.workflow.resolution.spec = { mode: 'record', namespace: 'PRE-1', acceptance: 'presence' };
  item.workflow.resolution.plannedClaims = {
    mode: 'required', clausePhases: ['specification'], owners: { implementation: 'planning' }
  };
  const specPhase = {
    id: 'specification', status: 'approved', generation: 1,
    requiredArtifact: { path: 'artifacts/specification/spec.md', kind: 'requirements' }
  };
  const implementation = { id: 'implementation', generationPolicy: { task: 'code' } };
  item.workflow.phases = { specification: specPhase, planning: item.phase, implementation };
  const specRelative = 'singularity/work-items/PRE-1/artifacts/specification/spec.md';
  await mkdir(path.join(item.root, path.dirname(specRelative)), { recursive: true });
  await writeFile(path.join(item.root, specRelative), '# Requirements\n\n[PRE-1:REQ-001]\nThe checkout accepts a payment.\n\n[PRE-1:AC-001]\nAn accepted payment produces a receipt.\n');
  await buildSpecIndex(item.root, specRelative, {
    workId: 'PRE-1', phase: 'specification', generation: 1,
    outputPath: 'singularity/work-items/PRE-1/context/spec-indexes/specification-gen1.json',
    policy: item.workflow.resolution.spec
  });
  await writeFile(item.absolute, '# Plan\n\nImplement payment and receipt handling.\n');

  const blocked = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(blocked.status, 'correction-required');
  assert.deepEqual(blocked.findings.filter((finding) =>
    finding.code === 'specification.planned-test-missing').map((finding) => finding.details.clauseId),
  ['PRE-1:AC-001', 'PRE-1:REQ-001']);
  assert.equal(blocked.correction.class, 'agent-authoring');
  assert.equal(blocked.correction.sameTurn, true);
  assert.equal(blocked.commands.publish, null);

  await writeFile(item.absolute, [
    '# Plan', '', 'Implement payment and receipt handling.', '',
    '| Clause | Expected paths | Planned tests |',
    '| --- | --- | --- |',
    '| [PRE-1:REQ-001] | `src/payment.mjs` | `test/payment.test.mjs` |',
    '| [PRE-1:AC-001] | `src/receipt.mjs` | not-applicable: to be determined |', ''
  ].join('\n'));
  const placeholder = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(placeholder.status, 'correction-required');
  assert.ok(placeholder.findings.some((finding) =>
    finding.code === 'specification.planned-test-placeholder'
      && finding.details.clauseId === 'PRE-1:AC-001'));

  await writeFile(item.absolute, [
    '# Plan', '', 'Implement payment and receipt handling.', '',
    '| Clause | Expected paths | Planned tests |',
    '| --- | --- | --- |',
    '| [PRE-1:REQ-001] | `src/payment.mjs` | `test/payment.test.mjs` |',
    '| [PRE-1:AC-001] | `src/receipt.mjs` | `test/receipt.test.mjs` |', ''
  ].join('\n'));
  const ready = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.findings, []);
  assert.equal(item.phase.claimMaps, undefined);
  await assert.rejects(readFile(path.join(item.root, 'singularity/work-items/PRE-1/context/claims/planning-gen1-planned.json')),
    { code: 'ENOENT' });

  const planText = await readFile(item.absolute, 'utf8');
  const seedPath = path.join(item.root,
    'singularity/work-items/PRE-1/context/claims/planning-gen1-planned.json');
  await mkdir(path.dirname(seedPath), { recursive: true });
  const seeded = {
    ...derivePlannedClaimMap(planText, {
      clauseIds: ['PRE-1:REQ-001', 'PRE-1:AC-001'], policy: item.workflow.resolution.spec
    }).claimMap,
    workId: 'PRE-1', phase: 'planning', generation: 1,
    source: { path: path.relative(item.root, item.absolute),
      sha256: '0'.repeat(64), bytes: Buffer.byteLength(planText) }
  };
  await writeFile(seedPath, `${JSON.stringify(seeded)}\n`);
  const seededBytes = await readFile(seedPath, 'utf8');
  const stale = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: item.session });
  assert.equal(stale.status, 'correction-required');
  assert.ok(stale.findings.some((finding) => finding.code === 'specification.planned-test-invalid'
    && /does not match the reviewed Markdown/u.test(finding.message)));
  assert.equal(await readFile(seedPath, 'utf8'), seededBytes);
});

test('any configured planning owner gets a hash-bound evidence repair before approval, not a late code gate', async t => {
  const item = await fixture(t);
  const AC = 'PRE-1:AC-001';
  const screenshot = 'singularity/work-items/PRE-1/evidence/desktop.png';
  item.phase.id = 'custom-design';
  item.workflow.currentPhase = 'custom-design';
  item.session.phaseId = 'custom-design';
  item.workflow.phaseOrder = ['requirements', 'custom-design', 'custom-code'];
  item.workflow.resolution.spec = { mode: 'record', namespace: 'PRE-1', acceptance: 'presence' };
  item.workflow.resolution.plannedClaims = {
    mode: 'required', clausePhases: ['requirements'], owners: { 'custom-code': 'custom-design' }
  };
  item.workflow.phases = {
    requirements: { id: 'requirements', status: 'approved', generation: 1,
      requiredArtifact: { path: 'artifacts/requirements/spec.md', kind: 'requirements' } },
    'custom-design': item.phase, 'custom-code': { id: 'custom-code', generationPolicy: { task: 'code' } }
  };
  const spec = 'singularity/work-items/PRE-1/artifacts/requirements/spec.md';
  await mkdir(path.join(item.root, path.dirname(spec)), { recursive: true });
  await writeFile(path.join(item.root, spec), `# Requirements\n\n[${AC}]\nCapture the desktop result for human inspection.\n`);
  await buildSpecIndex(item.root, spec, { workId: 'PRE-1', phase: 'requirements', generation: 1,
    outputPath: 'singularity/work-items/PRE-1/context/spec-indexes/requirements-gen1.json',
    policy: item.workflow.resolution.spec });
  const source = ['# Plan', '', 'Retain the approved desktop result.', '',
    '| Clause | Expected paths | Planned tests | Fulfillment |', '|---|---|---|---|',
    `| [${AC}] | \`src/App.jsx\` | \`test/App.test.mjs\` | modified |`, '',
    `Primary visual verification contract for [${AC}]. Retain \`${screenshot}\`.`, ''].join('\n');
  await writeFile(item.absolute, source);
  const inspect = () => phasePrepublish(item.root, item.config, item.workflow, item.phase, { session: item.session });
  const blocked = await inspect();
  assert.equal(blocked.status, 'correction-required');
  assert.equal(blocked.commands.publish, null);
  assert.equal(blocked.correction.sameTurn, true);
  assert.equal(blocked.planningEvidenceRepair.status, 'producer-repair');
  assert.equal(blocked.planningEvidenceRepair.sameTurn, true);
  assert.equal(blocked.planningEvidenceRepair.phase, 'custom-design');
  assert.equal(blocked.planningEvidenceRepair.artifact.sha256, blocked.artifact.sha256);
  assert.equal(blocked.planningEvidenceRepair.sourceSha256, blocked.artifact.sha256.replace(/^sha256:/u, ''));
  assert.equal(blocked.findings.find(finding => finding.code === 'specification.planned-test-invalid').details.path, screenshot);
  assert.equal(await readFile(item.absolute, 'utf8'), source, 'inspection cannot rewrite the plan');
  item.workflow.currentPhase = 'custom-code';
  const wrongPhase = await inspect();
  assert.equal(wrongPhase.planningEvidenceRepair.sameTurn, false);
  assert.deepEqual(wrongPhase.planningEvidenceRepair.patches, []);
  item.workflow.currentPhase = 'custom-design';
  const foreign = await phasePrepublish(item.root, item.config, item.workflow, item.phase,
    { session: { ...item.session, workId: 'OTHER-STORY' } });
  assert.equal(foreign.planningEvidenceRepair.sameTurn, false);
  assert.deepEqual(foreign.planningEvidenceRepair.patches, []);
  item.phase.status = 'awaiting_approval';
  const submitted = await inspect();
  assert.equal(submitted.planningEvidenceRepair.sameTurn, false);
  assert.deepEqual(submitted.planningEvidenceRepair.patches, []);
  item.phase.status = 'in_progress';
  let candidate = source;
  for (const patch of blocked.planningEvidenceRepair.patches) candidate = patch.kind === 'append'
    ? candidate + patch.after : candidate.replace(patch.before, () => patch.after);
  await writeFile(item.absolute, candidate);
  const ready = await inspect();
  assert.equal(ready.status, 'ready', JSON.stringify(ready.findings));
  assert.equal(ready.planningEvidenceRepair, null);
  assert.deepEqual(derivePlannedClaimMap(candidate, { clauseIds: [AC],
    evidenceRoot: 'singularity/work-items/PRE-1/evidence' }).claimMap.claims[AC].expectedPaths, [screenshot]);
  assert.equal(item.phase.claimMaps, undefined, 'prepublish never publishes a map or accepts evidence');
  await writeFile(item.absolute, `${candidate}\n<!-- Primary inspection verification contract for [${AC}]. -->\n`);
  const ignored = await inspect();
  assert.equal(ignored.status, 'ready', 'example/comment declarations must not disagree with publication parsing');
});
