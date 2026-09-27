import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { diagnoseRetainedSkillPackage } from '../src/skp-doctor.mjs';
import { inspectSkillPackageContents } from '../src/skp-package.mjs';
import { excludesActiveWorkspaceRouting } from '../src/cli-entry.mjs';
import { initializeDefinition } from '../src/config.mjs';
import {
  compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill,
  skillCandidateCatalogSha256, skillContractSha256, skillPhaseCandidateSha256
} from '../src/skp-contract.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const capture = (entry = '# Exact approved procedure\n') => inspectSkillPackageContents(
  'report', new Map([['SKILL.md', Buffer.from(entry)],
    ['references/checklist.md', Buffer.from('Private checklist bytes\r\n')]])
);
function retained(source = capture()) {
  return { skillId: source.manifest.skillId, phaseId: 'analysis',
    packageSha256: source.manifest.packageSha256, manifest: source.manifest,
    files: source.contents, contractSha256: `sha256:${'a'.repeat(64)}`,
    snapshotHash: `sha256:${'b'.repeat(64)}` };
}

test('skill doctor distinguishes retained integrity and unavailable host without raw content', () => {
  const original = retained();
  const report = diagnoseRetainedSkillPackage(original);
  assert.equal(report.retention.status, 'complete');
  assert.equal(report.retention.files, 2);
  assert.equal(report.source.status, 'not-checked');
  assert.equal(report.host.status, 'unavailable');
  assert.equal(report.host.unavailableDimensions.length, 7);
  assert.equal(report.host.observationScope, 'source-capabilities-only');
  assert.equal(report.host.installedHost, 'not-checked');
  assert.equal(report.host.integrationSeam.modelProviderId, 'copilot-cli');
  assert.equal(report.host.integrationSeam.qualifiedSkillAdapter, false);
  assert.deepEqual(report.host.missingOwners.map((owner) => owner.id), [
    'pre-effect-enforcement', 'authenticated-mediated-confirmation', 'exact-host-delivery'
  ]);
  assert.equal(report.host.launchAuthorized, false);
  assert.equal(report.host.nextAction.executionAuthorized, false);
  assert.equal(report.executable, false);
  assert.equal(report.execution, 'not-run');
  assert.equal(report.approval, 'not-checked');
  assert.equal(report.provenance.status, 'not-checked');
  assert.equal(report.mutationRequired, false);
  assert.match(report.guidance, /authenticated mediated confirmation/);
  assert.doesNotMatch(JSON.stringify(report), /Private checklist|Exact approved procedure/);
});

test('a newer live source remains an update, never corrupts or upgrades the Story pin', () => {
  const original = retained();
  const before = Buffer.from(original.files.get('SKILL.md'));
  const source = capture('# Changed procedure\n');
  const report = diagnoseRetainedSkillPackage(original, { source });
  assert.equal(report.source.status, 'update-available');
  assert.equal(report.retention.status, 'complete');
  assert.equal(report.packageSha256, original.packageSha256);
  assert.notEqual(report.packageSha256, report.source.packageSha256);
  assert.match(report.guidance, /separate reviewed amendment/);
  assert.deepEqual(original.files.get('SKILL.md'), before);
});

test('exact source comparison preserves the accepted version', () => {
  assert.equal(diagnoseRetainedSkillPackage(retained(), { source: capture() }).source.status, 'unchanged');
});

test('corrupt retained entry never falls back to an intact latest package', () => {
  const original = retained();
  original.files.get('SKILL.md')[0] ^= 1;
  assert.throws(() => diagnoseRetainedSkillPackage(original, { source: capture() }),
    { code: 'SKP_PACKAGE_CORRUPT' });
});

test('missing retained resource is not replaced by a newer source', () => {
  const original = retained();
  original.files.delete('references/checklist.md');
  assert.throws(() => diagnoseRetainedSkillPackage(original, { source: capture() }),
    { code: 'SKP_PACKAGE_CORRUPT' });
});

test('a corrupt optional source cannot be treated as a valid update', () => {
  const source = capture();
  source.contents.get('SKILL.md')[0] ^= 1;
  assert.throws(() => diagnoseRetainedSkillPackage(retained(), { source }),
    { code: 'SKP_PACKAGE_CORRUPT' });
});

test('a matching package cannot authorize a forged retained summary', () => {
  const original = retained();
  original.packageSha256 = `sha256:${'c'.repeat(64)}`;
  assert.throws(() => diagnoseRetainedSkillPackage(original), { code: 'SKP_PACKAGE_CORRUPT' });
});

test('Story skill doctor uses repository routing while local inspect stays machine-local', () => {
  assert.equal(excludesActiveWorkspaceRouting('skill', 'doctor'), false);
  assert.equal(excludesActiveWorkspaceRouting('skill', 'approved'), false);
  assert.equal(excludesActiveWorkspaceRouting('skill', 'inspect'), true);
});

test('skill doctor refuses an ambiguous Story/phase before repository or source access', async (t) => {
  const isolated = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-doctor-preflight-'));
  t.after(() => rm(isolated, { recursive: true, force: true }));
  for (const flags of [[], ['--story', 'story-id'], ['--phase', 'analysis'],
    ['--story', 'story-id', '--phase', 'analysis', '--confirm', 'yes']]) {
    const result = spawnSync(process.execPath, [CLI, 'skill', 'doctor', 'report', ...flags, '--json'],
      { cwd: isolated, encoding: 'utf8', timeout: 10000, env: {
        ...process.env,
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(isolated, '.test-workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(isolated, '.test-active-workspace.json'),
        SINGULARITY_FLOW_LEAD_REGISTRY: path.join(isolated, '.test-leads.json')
      } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /SKP_OPTION_UNSUPPORTED|requires an explicit|does not support/);
  }
});

async function retainedStory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-doctor-cli-'));
  const remote = `${root}.git`;
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  const invoke = (executable, argv, { allowFailure = false } = {}) => {
    const result = spawnSync(executable, argv, {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: {
        ...process.env, NODE_ENV: 'test', SINGULARITY_FLOW_TEST_IDENTITY: 'Skill Doctor Tester',
        SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
        SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
        SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json')
      }
    });
    if (!allowFailure) assert.equal(result.status, 0,
      `${executable} ${argv.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
    return result;
  };
  const git = (...argv) => invoke('git', argv).stdout.trim();
  const cli = (...argv) => invoke(process.execPath, [CLI, '--no-model', ...argv]);
  const refused = (...argv) => invoke(process.execPath, [CLI, '--no-model', ...argv], { allowFailure: true });
  await initializeDefinition(root);
  const workflowFile = path.join(root, 'singularity', 'workflow.yml');
  const definition = YAML.parse(await readFile(workflowFile, 'utf8'));
  definition.version = 3;
  const source = inspectSkillPackageContents('report', new Map([
    ['SKILL.md', Buffer.from('# Exact approved procedure\n')],
    ['references/checklist.md', Buffer.from('Private checklist bytes\n')]
  ]));
  const skillDirectory = path.join(root, 'singularity', 'skills', 'report');
  for (const [relative, bytes] of source.contents) {
    const absolute = path.join(skillDirectory, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);
  }
  const phase = {
    id: 'analysis', kind: 'skill', label: 'Report analysis',
    skill: { id: 'report', packageSha256: source.manifest.packageSha256 },
    contract: {
      task: 'analyze',
      consumes: [{ phase: 'intake', output: 'primary', required: true, state: 'approved' }],
      produces: [{ id: 'primary', path: 'artifacts/analysis/report.md', kind: 'custom:report',
        minimumBytes: 200, maximumBytes: 16384, mediaType: 'text/markdown', encoding: 'utf-8',
        clauses: 'optional', claimRole: 'findings' }],
      checks: [], writeScope: 'artifact-only', readScope: { inputs: true, sourcePaths: [] },
      approval: { authorities: ['engineering-reviewers'], minimum: 1 }
    }
  };
  const catalog = {
    skillPackages: { report: { packageSha256: source.manifest.packageSha256, eligibility: 'candidate-producer' } },
    phases: { intake: { outputs: [{ id: 'primary', path: definition.phases.intake.artifact.path }] } },
    checks: {}, approvalAuthorities: definition.approvalAuthorities,
    approvalSecurity: definition.approvalSecurity, readPaths: [], sourceScopes: {}, artifactSets: {}
  };
  const order = ['intake', 'analysis', 'conformance'];
  const catalogSha256 = skillCandidateCatalogSha256(catalog);
  definition.phases.analysis = configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({
    phase, catalog, phaseOrder: order, confirmation: {
      contractSha256: skillContractSha256(phase.id, phase.contract), catalogSha256,
      packageSha256: phase.skill.packageSha256,
      candidateSha256: skillPhaseCandidateSha256(phase, order, catalogSha256),
      planSha256: `sha256:${'c'.repeat(64)}`, draftRevision: 1
    }
  }));
  definition.workTypes['skill-analysis'] = { label: 'Skill analysis', phases: order };
  await writeFile(workflowFile, YAML.stringify(definition));
  await writeFile(path.join(root, '.github', 'agents', 'report-producer.agent.md'), [
    '---', 'name: report-producer', 'description: Governed report producer.', 'model: [auto]',
    'tools: [read, search, ask_user]', 'metadata:', '  sflow-label: "Report producer"',
    '  sflow-phases: "analysis"', '  sflow-default-for: "analysis"',
    '  sflow-world-model-views: ""', '  sflow-model-task: "analyze"',
    '---', '', '# Report producer', '', 'Produce only the governed candidate.', ''
  ].join('\n'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Skill Doctor Tester');
  git('config', 'user.email', 'skill-doctor@example.invalid');
  git('add', '-A');
  git('commit', '-qm', 'approved diagnostic configuration');
  invoke('git', ['init', '--bare', '-b', 'main', remote]);
  git('remote', 'add', 'origin', remote);
  git('branch', 'sflow/config');
  git('push', '-q', '-u', 'origin', 'main', 'sflow/config');
  cli('start', 'SKP-DIAG-1', '--from-branch', 'main', '--work-type', 'skill-analysis',
    '--title', 'Review a retained report', '--description', 'Retain the exact package for read-only diagnostics.');
  return { root, git, cli, refused, source, skillDirectory,
    recordPath: path.join(root, 'singularity', 'work-items', 'SKP-DIAG-1', 'workflow.json') };
}

test('actual doctor CLI verifies a retained Story and does not substitute deleted live source or mutate state', async (t) => {
  const value = await retainedStory(t);
  await rm(value.skillDirectory, { recursive: true, force: true });
  const before = await readFile(value.recordPath);
  const head = value.git('rev-parse', 'HEAD');
  const status = value.git('status', '--porcelain');
  const result = value.cli('skill', 'doctor', 'report', '--story', 'SKP-DIAG-1', '--phase', 'analysis', '--json');
  const response = JSON.parse(result.stdout);
  assert.equal(response.operation.id, 'skill.doctor');
  assert.equal(response.operation.classification, 'read');
  assert.deepEqual(Object.values(response.effects), [false, false, false, false]);
  assert.equal(response.data.diagnostic.packageSha256, value.source.manifest.packageSha256);
  assert.equal(response.data.diagnostic.retention.status, 'complete');
  assert.equal(response.data.diagnostic.provenance.status, 'verified-story-snapshot');
  assert.equal(response.data.diagnostic.source.status, 'not-checked');
  assert.equal(response.data.diagnostic.host.status, 'unavailable');
  assert.equal(response.data.diagnostic.host.observationScope, 'source-capabilities-only');
  assert.equal(response.data.diagnostic.host.installedHost, 'not-checked');
  assert.equal(response.data.diagnostic.host.integrationSeam.qualifiedSkillAdapter, false);
  assert.equal(response.data.diagnostic.host.launchAuthorized, false);
  assert.equal(response.data.diagnostic.host.nextAction.kind, 'external-prerequisite');
  assert.deepEqual(response.data.diagnostic.host.missingOwners.map((owner) => owner.id), [
    'pre-effect-enforcement', 'authenticated-mediated-confirmation', 'exact-host-delivery'
  ]);
  assert.equal(response.data.diagnostic.executable, false);
  assert.doesNotMatch(result.stdout, /Private checklist|Exact approved procedure/);
  const mismatched = value.refused('skill', 'doctor', 'different-report', '--story', 'SKP-DIAG-1',
    '--phase', 'analysis', '--source', path.join(value.root, 'missing-source'), '--json');
  assert.notEqual(mismatched.status, 0);
  assert.match(mismatched.stderr, /SKP_SKILL_MISSING/);
  assert.doesNotMatch(mismatched.stderr, /SKP_SKILL_DRIFT|SKP_PACKAGE_CORRUPT|ENOENT/);
  assert.deepEqual(await readFile(value.recordPath), before);
  assert.equal(value.git('rev-parse', 'HEAD'), head);
  assert.equal(value.git('status', '--porcelain'), status);
});
