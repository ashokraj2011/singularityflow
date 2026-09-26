import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CODE_DELIVERY_POLICY } from '../src/code-delivery-policy.mjs';
import {
  compileConfirmedSkillPhase, skillCandidateCatalogSha256, skillContractSha256,
  skillPhaseCandidateSha256
} from '../src/skp-contract.mjs';

const H = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const phase = {
    id: 'threat-model', kind: 'skill', label: 'Threat model',
    skill: { id: 'threat-model', packageSha256: H('a') },
    contract: {
      task: 'analyze',
      consumes: [{ phase: 'requirements', output: 'primary', required: true, state: 'approved' }],
      produces: [{
        id: 'threat-report', path: 'artifacts/threat-model/threat-model.md',
        kind: 'custom:threat-model', mediaType: 'text/markdown', encoding: 'utf-8',
        minimumBytes: 400, maximumBytes: 131072, clauses: 'optional', claimRole: 'findings'
      }],
      checks: ['markdownlint'], writeScope: 'artifact-only',
      readScope: { inputs: true, sourcePaths: [] },
      approval: { authorities: ['security-reviewers'], minimum: 1 },
      clarification: { mode: 'when-needed', maxQuestions: 3 }
    }
  };
  const catalog = {
    skillPackages: {
      'threat-model': { packageSha256: H('a'), eligibility: 'candidate-producer' }
    },
    phases: {
      requirements: { outputs: [{ id: 'primary', path: 'artifacts/requirements/requirements.md' }] }
    },
    checks: {
      markdownlint: {
        id: 'markdownlint', argv: ['markdownlint', 'artifacts/threat-model/threat-model.md'],
        modelPolicy: 'never', kind: 'lint', requirement: 'required'
      }
    },
    approvalAuthorities: {
      'security-reviewers': {
        label: 'Security reviewers', members: [{ name: 'Reviewer', email: 'reviewer@example.test' }]
      }
    },
    approvalSecurity: { profile: 'team' },
    readPaths: [], sourceScopes: {}, artifactSets: {}
  };
  const phaseOrder = ['intake', 'requirements', 'threat-model'];
  return { phase, catalog, phaseOrder };
}

function confirmed({ phase, catalog, phaseOrder }) {
  const catalogSha256 = skillCandidateCatalogSha256(catalog);
  return {
    phase, catalog, phaseOrder,
    confirmation: {
      contractSha256: skillContractSha256(phase.id, phase.contract),
      catalogSha256,
      packageSha256: phase.skill.packageSha256,
      candidateSha256: skillPhaseCandidateSha256(phase, phaseOrder, catalogSha256),
      planSha256: H('b'), draftRevision: 8
    }
  };
}

function rejected(value, code) {
  assert.throws(() => compileConfirmedSkillPhase(confirmed(value)),
    (error) => error?.code === code, `expected ${code}`);
}

test('complete confirmed contract lowers to one ordinary phase policy and exact binding refs', () => {
  const value = fixture();
  const before = structuredClone(value);
  const compiled = compileConfirmedSkillPhase(confirmed(value));
  assert.deepEqual(value, before, 'compilation must not mutate the candidate');
  assert.equal(compiled.phasePolicy.artifact.path, 'artifacts/threat-model/threat-model.md');
  assert.equal(compiled.phasePolicy.artifact.kind, 'custom:threat-model');
  assert.deepEqual(compiled.phasePolicy.inputs, [{ phase: 'requirements', optional: false }]);
  assert.deepEqual(compiled.phasePolicy.qualityCommands[0].argv,
    ['markdownlint', 'artifacts/threat-model/threat-model.md']);
  assert.equal(compiled.phasePolicy.generation.task, 'analyze');
  assert.equal(compiled.phasePolicy.approval.minimum, 1);
  assert.deepEqual(compiled.bindingRefs.inputs, [{
    phase: 'requirements', output: 'primary', required: true, state: 'approved',
    path: 'artifacts/requirements/requirements.md'
  }]);
  assert.equal(compiled.bindingRefs.outputs[0].claimRole, 'findings');
  assert.equal(compiled.bindingRefs.skill.packageSha256, H('a'));
  assert.equal(compiled.bindingRefs.confirmation.draftRevision, 8);
  assert.match(compiled.bindingRefs.confirmation.candidateSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(compiled.bindingRefs.sourceScope, null);
  assert.equal(compiled.bindingRefs.codeDeliverySha256, null);
  assert.match(compiled.compilationSha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(compiled)), compiled);
  assert.deepEqual(compileConfirmedSkillPhase(confirmed(value)), compiled, 'compilation is deterministic');
});

test('draft, stale confirmation, and non-producer skill cannot become executable policy', () => {
  const value = fixture();
  assert.throws(() => compileConfirmedSkillPhase(value),
    (error) => error?.code === 'SKP_CONTRACT_UNCONFIRMED');
  const stale = confirmed(value);
  stale.phase.contract.produces[0].minimumBytes = 401;
  assert.throws(() => compileConfirmedSkillPhase(stale),
    (error) => error?.code === 'SKP_CONTRACT_UNCONFIRMED');
  const renamed = confirmed(fixture());
  renamed.phase.label = 'Renamed after confirmation';
  assert.throws(() => compileConfirmedSkillPhase(renamed),
    (error) => error?.code === 'SKP_CONTRACT_UNCONFIRMED');
  const reordered = confirmed(fixture());
  reordered.phaseOrder = ['requirements', 'intake', 'threat-model'];
  assert.throws(() => compileConfirmedSkillPhase(reordered),
    (error) => error?.code === 'SKP_CONTRACT_UNCONFIRMED');
  value.catalog.skillPackages['threat-model'].eligibility = 'management-orchestration';
  rejected(value, 'SKP_SKILL_NOT_PHASE_PRODUCER');
});

test('empty or merely optional outputs fail before a template or source diff can stand in', () => {
  const none = fixture();
  none.phase.contract.produces = [];
  rejected(none, 'SKP_CONTRACT_EMPTY');
  const optional = fixture();
  optional.phase.contract.produces[0].required = false;
  rejected(optional, 'SKP_CONTRACT_EMPTY');
  const sourceGlob = fixture();
  sourceGlob.phase.contract.produces[0].path = 'src/**/*.js';
  rejected(sourceGlob, 'SKP_OUTPUT_PATH_INVALID');
  const windowsAlias = fixture();
  windowsAlias.phase.contract.produces[0].path = 'artifacts/threat-model/CON.md';
  rejected(windowsAlias, 'SKP_OUTPUT_PATH_INVALID');
  const noRole = fixture();
  delete noRole.phase.contract.produces[0].claimRole;
  rejected(noRole, 'SKP_CONTRACT_INVALID');
  const noEncoding = fixture();
  delete noEncoding.phase.contract.produces[0].encoding;
  rejected(noEncoding, 'SKP_CONTRACT_INVALID');
});

test('unknown checks and authorities cannot be minted from skill prose', () => {
  const check = fixture();
  check.phase.contract.checks = ['prose-says-run-audit'];
  rejected(check, 'SKP_CHECK_UNKNOWN');
  const authority = fixture();
  authority.phase.contract.approval.authorities = ['skill-maintainers'];
  rejected(authority, 'SKP_AUTHORITY_UNKNOWN');
  const command = fixture();
  command.catalog.checks.markdownlint = {
    id: 'markdownlint', command: 'markdownlint artifacts', modelPolicy: 'never', kind: 'lint'
  };
  rejected(command, 'SKP_CHECK_INVALID');
  const network = fixture();
  network.phase.contract.network = 'full';
  rejected(network, 'SKP_CONTRACT_INVALID');
});

test('ordinary duplicate policy fields cannot compete with confirmed contract lowering', () => {
  for (const duplicate of [
    { artifact: { path: 'artifacts/threat-model/other.md' } },
    { generation: { task: 'code' } },
    { approval: 'none' },
    { qualityCommands: ['echo okay'] }
  ]) {
    const value = fixture();
    Object.assign(value.phase, duplicate);
    rejected(value, 'SKP_CONTRACT_CONFLICT');
  }
});

test('input bindings require one earlier exact output and approved review state', () => {
  const later = fixture();
  later.phaseOrder = ['intake', 'threat-model', 'requirements'];
  rejected(later, 'SKP_INPUT_ORDER');
  const unknown = fixture();
  unknown.phase.contract.consumes[0].output = 'imagined';
  rejected(unknown, 'SKP_INPUT_UNKNOWN');
  const ambiguous = fixture();
  ambiguous.catalog.phases.requirements.outputs.push({
    id: 'primary', path: 'artifacts/requirements/alternate.md'
  });
  rejected(ambiguous, 'SKP_INPUT_AMBIGUOUS');
  const unreviewed = fixture();
  unreviewed.phase.contract.consumes[0].state = 'draft';
  rejected(unreviewed, 'SKP_INPUT_STATE_INVALID');
  const duplicate = fixture();
  duplicate.phase.contract.consumes.push({ ...duplicate.phase.contract.consumes[0] });
  rejected(duplicate, 'SKP_INPUT_DUPLICATE');
});

test('source-writing skill requires explicit code task, approved scope, and structured executable test', () => {
  const value = fixture();
  value.phase.contract.writeScope = 'source-and-artifact';
  value.phase.contract.sourceScope = 'application';
  value.catalog.sourceScopes.application = { writeRoots: ['src'] };
  value.catalog.codeDelivery = DEFAULT_CODE_DELIVERY_POLICY;
  rejected(value, 'SKP_CODE_TASK_REQUIRED');
  value.phase.contract.task = 'code';
  rejected(value, 'SKP_SCOPE_REQUIRES_CHECKS', 'lint cannot count as a code test');
  value.catalog.checks.unit = {
    id: 'unit', argv: ['node', '--test'], modelPolicy: 'never', requirement: 'required',
    kind: 'test', result: {
      adapter: 'node-tap', path: 'artifacts/test-results/tap.txt',
      minimumDiscovered: 1, minimumPassed: 1
    }
  };
  value.phase.contract.checks.push('unit');
  const compiled = compileConfirmedSkillPhase(confirmed(value));
  assert.equal(compiled.phasePolicy.generation.task, 'code');
  assert.equal(compiled.phasePolicy.writeScope, 'source-and-artifact');
  assert.equal(compiled.bindingRefs.sourceScope.id, 'application');
  assert.match(compiled.bindingRefs.codeDeliverySha256, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(compiled.bindingRefs.checks.map((check) => check.id), ['markdownlint', 'unit']);
  value.catalog.checks.unit.result = undefined;
  assert.throws(() => compileConfirmedSkillPhase(confirmed(value)),
    (error) => error?.code === 'SKP_CONTRACT_INVALID', 'undefined is not valid catalog data');
});

test('source-writing scopes cannot alias protected control paths on case-insensitive hosts', () => {
  for (const protectedAlias of ['Singularity', 'Singularity/work-items', '.Github/agents', '.GIT/hooks']) {
    const value = fixture();
    value.phase.contract.writeScope = 'source-and-artifact';
    value.phase.contract.task = 'code';
    value.phase.contract.sourceScope = 'application';
    value.catalog.sourceScopes.application = { writeRoots: [protectedAlias] };
    value.catalog.codeDelivery = DEFAULT_CODE_DELIVERY_POLICY;
    assert.throws(() => compileConfirmedSkillPhase(confirmed(value)),
      (error) => ['SKP_SCOPE_UNAPPROVED', 'SKP_OUTPUT_PATH_INVALID'].includes(error?.code),
      `protected source alias '${protectedAlias}' must be refused before any source write`);
  }
});

test('multiple outputs require exact approved artifact-set membership', () => {
  const value = fixture();
  value.phase.contract.produces.push({
    id: 'risk-register', path: 'artifacts/threat-model/risks.md', kind: 'review',
    minimumBytes: 100, maximumBytes: 10000, clauses: 'none', claimRole: 'findings'
  });
  value.phase.contract.primaryOutput = 'threat-report';
  rejected(value, 'SKP_CONTRACT_INVALID', 'an artifact set ID is required');
  value.phase.contract.artifactSet = 'threat-bundle';
  value.catalog.artifactSets['threat-bundle'] = {
    primary: 'threat-model.md',
    members: [
      { path: 'threat-model.md', role: 'report', required: true },
      { path: 'risks.md', role: 'risks', required: true }
    ]
  };
  const compiled = compileConfirmedSkillPhase(confirmed(value));
  assert.equal(compiled.phasePolicy.artifactSet, 'threat-bundle');
  assert.deepEqual(compiled.bindingRefs.outputs.map((output) => output.id),
    ['threat-report', 'risk-register']);
  value.catalog.artifactSets['threat-bundle'].members[1].path = 'unrelated.md';
  rejected(value, 'SKP_ARTIFACT_SET_INVALID');
});

test('read requirements cannot silently request unapproved source paths', () => {
  const value = fixture();
  value.phase.contract.readScope.sourcePaths = ['secrets/config'];
  rejected(value, 'SKP_READ_SCOPE_UNAPPROVED');
  value.catalog.readPaths = ['secrets/config'];
  const compiled = compileConfirmedSkillPhase(confirmed(value));
  assert.deepEqual(compiled.bindingRefs.readScope.sourcePaths, ['secrets/config']);
});
