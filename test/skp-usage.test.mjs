import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { withApprovedConfigurationRead } from '../src/approved-configuration-reader.mjs';
import { initializeDefinition } from '../src/config.mjs';
import { DEFAULT_CODE_DELIVERY_POLICY } from '../src/code-delivery-policy.mjs';
import { resolveOperation } from '../src/command-registry.mjs';
import { validateWorkflowAuthorRequest } from '../src/commands/workflow-author.mjs';
import { compileConfirmedSkillPhase, configurationPhaseFromCompiledSkill,
  skillCandidateCatalogSha256, skillContractSha256, skillPhaseCandidateSha256 } from '../src/skp-contract.mjs';
import { inspectSkillPackageContents } from '../src/skp-package.mjs';
import { lookupApprovedSkillUsage, SKP_USAGE_LIMITS } from '../src/skp-usage.mjs';
import { parseArgs } from '../src/util.mjs';

const CLI = fileURLToPath(new URL('../bin/singularity-flow.mjs', import.meta.url));
const SKILL = 'criteria-skill';
const H = (digit) => `sha256:${digit.repeat(64)}`;
const ORDER = ['intake', 'team-criteria', 'team-plan', 'team-code', 'conformance'];
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr.slice(0, 2000)); return result.stdout.trim();
}
function flow(root, ...args) {
  return spawnSync(process.execPath, [CLI, 'workflow', 'author', 'where-used', ...args, '--json'],
    { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_ENV: 'test',
      SINGULARITY_FLOW_DISABLE_MODELS: '1',
      SINGULARITY_FLOW_WORKSPACE_REGISTRY: path.join(root, '.test-workspaces.json'),
      SINGULARITY_FLOW_ACTIVE_WORKSPACE: path.join(root, '.test-active-workspace.json'),
      SINGULARITY_FLOW_LEAD_REGISTRY: path.join(root, '.test-leads.json') } });
}
function usage(root, ...args) {
  const result = flow(root, ...args);
  assert.equal(result.status, 0, result.stderr.slice(0, 2000)); return JSON.parse(result.stdout);
}
function phase(id, role, input, packageSha256, task = 'analyze') {
  return { id, kind: 'skill', label: id, skill: { id: SKILL, packageSha256 }, contract: {
    task, consumes: [{ phase: input, output: 'primary', required: true, state: 'approved' }],
    produces: [{ id: 'primary', path: `artifacts/${id}/output.md`, kind: `custom:${id}`,
      minimumBytes: 200, maximumBytes: 16384, mediaType: 'text/markdown', encoding: 'utf-8',
      clauses: role === 'criteria' ? 'required' : 'optional', claimRole: role }],
    checks: task === 'code' ? ['unit'] : [], writeScope: task === 'code' ? 'source-and-artifact' : 'artifact-only',
    ...(task === 'code' ? { sourceScope: 'application' } : {}), readScope: { inputs: true, sourcePaths: [] },
    approval: { authorities: ['engineering-reviewers'], minimum: 1 } } };
}
async function fixture(t, { overflow = false, disclosure = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'sflow-skp-usage-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'client'); const remote = path.join(base, 'approved.git');
  await mkdir(root); await initializeDefinition(root);
  const contents = new Map([['SKILL.md', Buffer.from('# Exact selected package\nDo not execute during lookup.\n')]]);
  const capture = inspectSkillPackageContents(SKILL, contents);
  const packageSha256 = capture.manifest.packageSha256;
  await mkdir(path.join(root, 'singularity/skills', SKILL), { recursive: true });
  await writeFile(path.join(root, 'singularity/skills', SKILL, 'SKILL.md'), contents.get('SKILL.md'));
  const definition = YAML.parse(await readFile(path.join(root, 'singularity/workflow.yml'), 'utf8'));
  definition.version = 3;
  const proposals = [phase('team-criteria', 'criteria', 'intake', packageSha256),
    phase('team-plan', 'planning', 'team-criteria', packageSha256, 'reason'),
    phase('team-code', 'evidence', 'team-plan', packageSha256, 'code')];
  const catalog = { skillPackages: { [SKILL]: { packageSha256, eligibility: 'candidate-producer' } },
    phases: { intake: { outputs: [{ id: 'primary', path: definition.phases.intake.artifact.path }] },
      ...Object.fromEntries(proposals.map((value) => [value.id, { outputs: value.contract.produces }])) },
    checks: { unit: { id: 'unit', argv: ['node', '--test'], modelPolicy: 'never', requirement: 'required', kind: 'test',
      result: { adapter: 'node-tap', path: 'artifacts/test-results/tap.txt', minimumDiscovered: 1, minimumPassed: 1 } } },
    approvalAuthorities: definition.approvalAuthorities, approvalSecurity: definition.approvalSecurity,
    readPaths: [], sourceScopes: { application: { writeRoots: ['src'] } }, artifactSets: {}, codeDelivery: DEFAULT_CODE_DELIVERY_POLICY };
  const compile = (value, selectedCatalog = catalog, order = ORDER) => {
    const catalogSha256 = skillCandidateCatalogSha256(selectedCatalog);
    return configurationPhaseFromCompiledSkill(compileConfirmedSkillPhase({ phase: value, catalog: selectedCatalog,
      phaseOrder: order, confirmation: { contractSha256: skillContractSha256(value.id, value.contract), catalogSha256,
        packageSha256: value.skill.packageSha256, candidateSha256: skillPhaseCandidateSha256(value, order, catalogSha256),
        planSha256: H('b'), draftRevision: 1 } }));
  };
  for (const value of proposals) definition.phases[value.id] = compile(value);
  const other = phase('old-binding', 'findings', 'intake', H('c'));
  const otherCatalog = { ...catalog, skillPackages: { [SKILL]: { packageSha256: H('c'), eligibility: 'candidate-producer' } } };
  definition.phases[other.id] = compile(other, otherCatalog, ['intake', other.id, 'conformance']);
  definition.workTypes['team-delivery'] = { label: 'Team delivery', phases: ORDER,
    plannedClaims: { mode: 'required', clausePhases: ['team-criteria'], owners: { 'team-code': 'team-plan' } } };
  definition.workTypes['team-notes'] = { label: 'Team notes', phases: ['intake', 'team-criteria', 'conformance'] };
  if (disclosure) {
    definition.workTypes[`xoxb-${'a'.repeat(16)}`] = definition.workTypes['team-notes'];
    delete definition.workTypes['team-notes'];
  }
  if (overflow) for (let index = 0; index <= SKP_USAGE_LIMITS.workflows; index += 1) {
    definition.workTypes[`bounded-${index}`] = { label: 'Bounded', phases: ['intake', 'conformance'] };
  }
  await writeFile(path.join(root, 'singularity/workflow.yml'), YAML.stringify(definition));
  for (const phaseId of ['team-criteria', 'team-plan', 'team-code', 'old-binding']) {
    await writeFile(path.join(root, `.github/agents/${phaseId}-role.agent.md`), `---\nname: ${phaseId}-role\ndescription: Exact repository role\ntools: []\nmetadata:\n  sflow-phases: ${phaseId}\n  sflow-default-for: ${phaseId}\n---\nPrivate prompt is not usage output: ghp_${'X'.repeat(36)}\n${phaseId === 'team-plan' ? `\n## Remote skills\n\n| ID | URL | Phases | Optional | Max bytes |\n| --- | --- | --- | --- | --- |\n| ${SKILL} | https://example.test/private-team/skill.md | team-plan | false | 4096 |\n` : ''}`);
  }
  git(base, 'init', '--bare', '-q', '-b', 'main', remote); git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Usage Reader'); git(root, 'config', 'user.email', 'reader@example.test');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'approved declared usage'); git(root, 'branch', 'sflow/config');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-q', 'origin', 'main', 'sflow/config');
  return { base, root, remote, definition, packageSha256, commit: git(root, 'rev-parse', 'HEAD') };
}

test('where-used actual parsed preflight is bounded read-only and has no scope or approval shortcuts', async () => {
  const parse = (...argv) => parseArgs(['workflow', 'author', 'where-used', ...argv]);
  const valid = parse(SKILL, '--limit', '64', '--cursor', '1', '--expected-source', H('a'), '--package-sha256', H('b'), '--json');
  assert.equal(validateWorkflowAuthorRequest(valid), 'where-used');
  const operation = resolveOperation({ requestedCommand: 'workflow', ...valid });
  assert.equal(operation.id, 'workflow.author.where-used'); assert.equal(operation.classification, 'read'); assert.equal(operation.modelPolicy, 'never');
  for (const argv of [[], ['../skill'], ['UPPER'], ['a'.repeat(129)], [SKILL, '--cursor', '1'],
    [SKILL, '--limit', '65'], [SKILL, '--cursor', '1025'], [SKILL, '--expected-source', H('a'), '--expected-source', H('b')],
    [SKILL, '--package-sha256', 'invalid'], [SKILL, '--remote', '/other'], [SKILL, '--story', '../OTHER-1'],
    [SKILL, '--ref', 'refs/heads/story'], [SKILL, '--story', 'OTHER-1', '--ref', 'refs/heads/../main'],
    [SKILL, '--story', 'OTHER-1', '--commit', 'main'], [SKILL, '--story', 'OTHER-1', '--snapshot-revision', '65'],
    [SKILL, '--all'], [SKILL, '--confirmed', 'true'], [SKILL, '--input', '/private']]) {
    assert.throws(() => validateWorkflowAuthorRequest(parse(...argv)), { code: 'WCA_AUTHOR_REQUEST_INVALID' });
  }
  assert.equal(validateWorkflowAuthorRequest(parse(SKILL, '--story', 'OTHER-1', '--ref', 'refs/heads/story',
    '--commit', 'a'.repeat(40), '--snapshot-revision', '1', '--json')), 'where-used');
  for (const extra of [{ remote: '/other' }, { confirmed: true }, { packageSha256: { toString: () => H('a') } }]) {
    await assert.rejects(lookupApprovedSkillUsage('/unused-not-contacted', { skillId: SKILL, ...extra }), { code: 'SKP_USAGE_INVALID' });
  }
});

test('exact approved package usage reports phase, role and workflow declarations with proven code topology only', async (t) => {
  const f = await fixture(t); const result = usage(f.root, SKILL, '--package-sha256', f.packageSha256); const value = result.data.usage;
  assert.deepEqual(value.subject, { skillId: SKILL, packageSha256: f.packageSha256 });
  assert.equal(value.source.configurationCommit, f.commit); assert.equal(value.source.repository, f.remote);
  assert.equal(value.coverage.kind, 'configuration-only'); assert.equal(value.coverage.storyPins, 'not-searched');
  assert.equal(value.coverage.otherPackageBindings, 1); assert.equal(value.readScope.authenticatedPrincipal, 'not-established');
  assert.equal(result.operation.modelPolicy, 'never'); assert.equal(result.capability, undefined, 'lookup does not open the draft store');
  assert.deepEqual(result.effects, { stateChanged: false, filesChanged: false, publicationCreated: false, externalSystemsChanged: false });
  const criteria = value.references.find((entry) => entry.kind === 'workflow' && entry.workflowId === 'team-delivery' && entry.phaseId === 'team-criteria');
  assert.deepEqual(criteria.contractImpact.criteriaFor, ['team-code']); assert.equal(criteria.contractImpact.claimRole, 'criteria');
  const planning = value.references.find((entry) => entry.kind === 'workflow' && entry.workflowId === 'team-delivery' && entry.phaseId === 'team-plan');
  assert.deepEqual(planning.contractImpact.plannedClaimOwnerFor, ['team-code']);
  const notes = value.references.find((entry) => entry.kind === 'workflow' && entry.workflowId === 'team-notes');
  assert.equal(notes.contractImpact.assessment, 'code-not-applicable'); assert.deepEqual(notes.contractImpact.criteriaFor, []);
  const role = value.references.find((entry) => entry.kind === 'agent' && entry.reference === 'remote-skill-id'); assert.equal(role.packageBinding, 'unbound');
  const defaults = value.references.filter((entry) => entry.kind === 'agent-phase' && entry.reference === 'skill-phase-default-agent');
  assert.equal(defaults.length, 3); assert.ok(defaults.every((entry) => entry.packageBinding === 'exact' && entry.selection === 'default'));
  assert.equal(criteria.agentId, 'team-criteria-role');
  assert.ok(value.references.some((entry) => entry.kind === 'workflow' && entry.reference === 'default-agent-remote-skill-id'));
  const text = JSON.stringify(result);
  for (const privateText of ['Private prompt', 'ghp_', 'private-team', 'reader@example.test', 'SKILL.md', 'Exact selected package']) assert.ok(!text.includes(privateText));
  assert.ok(!value.references.some((entry) => entry.phaseId === 'old-binding'));
  assert.deepEqual(usage(f.root, SKILL).data.usage, value);
});

test('pagination is deterministic and refuses changed exact sources before returning any page', async (t) => {
  const f = await fixture(t); const first = usage(f.root, SKILL, '--limit', '2').data.usage;
  assert.equal(first.page.returned, 2); assert.equal(first.page.nextCursor, 2); assert.equal(first.page.complete, false);
  const second = usage(f.root, SKILL, '--limit', '2', '--cursor', '2', '--expected-source', first.sourceSha256).data.usage;
  assert.equal(second.sourceSha256, first.sourceSha256); assert.equal(second.page.cursor, 2);
  assert.notDeepEqual(second.references, first.references);
  const all = usage(f.root, SKILL).data.usage;
  assert.deepEqual([...first.references, ...second.references], all.references.slice(0, 4));
  git(f.root, 'checkout', '-q', 'sflow/config');
  await writeFile(path.join(f.root, 'singularity/approved-note.txt'), 'Another exact approved source.\n');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'advance approved source'); git(f.root, 'push', '-q', 'origin', 'sflow/config');
  const refused = flow(f.root, SKILL, '--cursor', '2', '--expected-source', first.sourceSha256);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /SKP_USAGE_SOURCE_CHANGED/u); assert.equal(refused.stdout.trim(), '');
});

test('lookup ignores dirty checkout replacements and Story branches and never writes draft or configuration refs', async (t) => {
  const f = await fixture(t);
  git(f.root, 'checkout', '-q', '-b', 'WORK-PRIVATE');
  await mkdir(path.join(f.root, 'singularity/work-items/WORK-PRIVATE'), { recursive: true });
  await writeFile(path.join(f.root, 'singularity/work-items/WORK-PRIVATE/private.json'), '{"privateStory":"not-usage"}');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'unrelated Story branch');
  await writeFile(path.join(f.root, 'singularity/workflow.yml'), 'malformed private live configuration');
  await rm(path.join(f.root, 'singularity/skills', SKILL), { recursive: true });
  const head = git(f.root, 'rev-parse', 'HEAD'); const index = await readFile(path.join(f.root, '.git/index'));
  const refs = git(f.remote, 'for-each-ref', '--format=%(refname) %(objectname)');
  const result = usage(f.root, SKILL);
  assert.equal(result.data.usage.source.configurationCommit, f.commit);
  assert.ok(!JSON.stringify(result).includes('WORK-PRIVATE')); assert.ok(!JSON.stringify(result).includes('privateStory'));
  assert.equal(git(f.root, 'rev-parse', 'HEAD'), head); assert.deepEqual(await readFile(path.join(f.root, '.git/index')), index);
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname) %(objectname)'), refs);
  assert.equal(await readFile(path.join(f.root, 'singularity/workflow.yml'), 'utf8'), 'malformed private live configuration');
});

test('unknown packages, different package digests and incomplete read scopes are refusals, not zero usage', async (t) => {
  const f = await fixture(t);
  const absent = flow(f.root, 'absent-skill'); assert.notEqual(absent.status, 0); assert.match(absent.stderr, /SKP_SKILL_MISSING/u);
  const mismatch = flow(f.root, SKILL, '--package-sha256', H('f'));
  assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /SKP_SKILL_DRIFT/u);
  await assert.rejects(withApprovedConfigurationRead(f.root, () => lookupApprovedSkillUsage(f.root, { skillId: SKILL }),
    { preferAuthority: true, requireAuthorityRefresh: true, allowLocalHeads: false,
      selectPaths: ['singularity/workflow.yml'] }), { code: 'SKP_USAGE_SCOPE_UNAVAILABLE' });
  git(f.root, 'remote', 'remove', 'origin');
  const noAuthority = flow(f.root, SKILL); assert.notEqual(noAuthority.status, 0); assert.match(noAuthority.stderr, /SKP_USAGE_SCOPE_UNAVAILABLE/u);
});

test('source digest binds exact authority even when two repositories retain identical commits', async (t) => {
  const f = await fixture(t); const first = usage(f.root, SKILL).data.usage;
  const other = path.join(f.base, 'other.git'); git(f.base, 'clone', '--bare', '-q', f.remote, other);
  git(f.root, 'remote', 'set-url', 'origin', other);
  const refused = flow(f.root, SKILL, '--expected-source', first.sourceSha256);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /SKP_USAGE_SOURCE_CHANGED/u);
  const second = usage(f.root, SKILL).data.usage;
  assert.equal(second.source.configurationCommit, first.source.configurationCommit);
  assert.notEqual(second.sourceSha256, first.sourceSha256); assert.equal(second.source.repository, other);
});

test('configuration budget overflow refuses the complete lookup instead of silently truncating', async (t) => {
  const f = await fixture(t, { overflow: true }); const refused = flow(f.root, SKILL);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /SKP_USAGE_LIMIT/u); assert.equal(refused.stdout.trim(), '');
});

test('credential-shaped projected metadata is blocked without echoing its value or returning a partial page', async (t) => {
  const f = await fixture(t, { disclosure: true }); const refused = flow(f.root, SKILL);
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /SKP_USAGE_DISCLOSURE_BLOCKED/u);
  assert.ok(!refused.stderr.includes(`xoxb-${'a'.repeat(16)}`)); assert.equal(refused.stdout.trim(), '');
});
