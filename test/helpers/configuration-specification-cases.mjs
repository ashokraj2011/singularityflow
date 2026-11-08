/** Native specification declarations only; no repository inspection, execution or model calls. */
import * as quality from '../../src/specification-quality.mjs';
import * as roles from '../../src/specifications.mjs';
import * as binding from '../../src/skp-contract.mjs';
import * as packages from '../../src/skp-package.mjs';
import * as phases from '../../src/phase-semantics.mjs';

export const specificationModules = { quality, roles, binding, packages, phases };
const digest = `sha256:${'a'.repeat(64)}`;
const header = patch => ({ schemaVersion: 1, compiler: 'skp-contract/v1',
  parserProfile: 'skp-skill-text/v1', compilationSha256: digest, bindingRefs: {}, ...patch });
const skill = (outputs, patch = {}) => ({ id: 'criteria', kind: 'skill',
  artifact: { path: 'artifacts/criteria/intent.md', kind: 'requirements' },
  skillBinding: header({ bindingRefs: { outputs } }), ...patch });
const output = patch => ({ path: 'artifacts/criteria/intent.md', kind: 'requirements',
  required: true, claimRole: 'criteria', ...patch });
const witness = patch => ({ witnessedClauses: { profile: 'witnessed-v1', ...patch } });
const cases = [
  ...[[], [null], [{}], [{ mode: 'enforce', approvalChecklist: 'required', exceptionAuthority: 'quality', assisted: true, scenarioCoverage: 'required' }],
    [{ mode: 'invalid' }], [{ checklist: '' }], [{ checklist: ' ' }], [{ approvalChecklist: 'yes' }],
    [{ exceptionAuthority: ' ' }], [{ exceptionAuthority: 1 }], [{ assisted: 'false' }], [{ scenarioCoverage: 'yes' }],
    [witness({})], [{ witnessedClauses: null }], [{ witnessedClauses: [] }], [witness({ extra: true })],
    [witness({ profile: 'unknown' })], [witness({ clauseTypes: [] })], [witness({ clauseTypes: ['acceptance', 'acceptance'] })],
    [witness({ clauseTypes: ['requirement'] })], [witness({ enforceableWitnessTypes: ['manual'] })],
    [witness({ lexicalHints: 'advisory' })], [witness({ lexicalHints: 'enforce' })],
    [witness({ limits: { maxClauses: 10000, maxFieldBytes: 1048576, maxReportBytes: 10485760 } })],
    [witness({ limits: { maxReportBytes: 2048 } })], [witness({ limits: { maxReportBytes: 2047 } })],
    [witness({ limits: { maxClauses: 10001 } })], [witness({ limits: { maxFieldBytes: 0 } })],
    [witness({ limits: { unknown: 2 } })], [witness({ limits: [] })],
    [{ mode: 'warn', scenarioCoverage: 'off', approvalChecklist: 'off', extra: 'legacy field remains ignored' }]
  ].map(input => ['quality', 'specificationQualityPolicy', input]),
  ...[[], [null], [header()], [header(), 'criteria'], [header({ schemaVersion: 2 }), 'criteria'],
    [header({ compiler: 'other/v1' })], [header({ parserProfile: 'other/v1' })],
    [header({ compilationSha256: 'a'.repeat(64) })], [header({ compilationSha256: `sha256:${'A'.repeat(64)}` })],
    [header({ extra: true })], [[]], [header({ bindingRefs: null })],
    [header({ bindingRefs: { outputs: [] } })]
  ].map(input => ['binding', 'validateSkillPhaseBindingHeader', input]),
  ...[[], [null], [{}], [{ kind: 'template' }], [skill([output()])],
    [skill([output({ claimRole: 'findings' })])], [skill([output({ claimRole: 'evidence' })])],
    [skill([output(), output()])], [skill([output({ required: false })])],
    [skill([output({ path: 'artifacts/criteria/other.md' })])], [skill([output({ kind: 'report' })])],
    [skill([output()], { skillBinding: header({ schemaVersion: 2 }) })],
    [skill([output()], { requiredArtifact: { path: 'artifacts/criteria/new.md', kind: 'requirements' } })],
    [skill([output()], { artifact: null, requiredArtifact: { path: 'artifacts/criteria/intent.md', kind: 'requirements' } })]
  ].map(input => ['roles', 'skillPhasePrimaryOutputRole', input]),
  ...[[], [null], [{}], ['requirements'], ['implementation-spec'], ['test-evidence'], ['conformance-report'],
    [{ artifact: { kind: 'requirements' } }], [{ artifact: { kind: 'delivery-plan' } }],
    [{ requiredArtifact: { kind: 'test-evidence' }, artifact: { kind: 'requirements' } }],
    [skill([output()])], [skill([output({ claimRole: 'findings' })])],
    [skill([output({ claimRole: 'evidence' })])], [skill([output({ claimRole: 'planning' })])],
    [skill([output()], { kind: 'template' })],
    [skill([output()], { skillBinding: header({ compilationSha256: 'invalid' }) })]
  ].map(input => ['roles', 'isSpecificationDefinitionPhase', input])
];

export function configurationSpecificationResults(modules = specificationModules) {
  return cases.map(([family, name, args], id) => {
    const input = structuredClone(args);
    try {
      const value = modules[family][name](...input);
      return { id, family, name, status: 'returned', input, value: value === undefined ? { $undefined: true } : value };
    } catch (error) {
      return { id, family, name, status: 'refused', input,
        error: { name: error.name, message: error.message, code: error.code ?? null,
          exitCode: error.exitCode ?? null, details: error.details ?? null } };
    }
  });
}

export function specificationDeclarationData(modules = specificationModules) {
  return { checklist: modules.quality.STARTER_CHECKLIST,
    modes: modules.quality.SPECIFICATION_QUALITY_MODES,
    witnessProfile: modules.quality.WITNESSED_CLAUSE_PROFILE,
    definitionKinds: modules.roles.SPECIFICATION_DEFINITION_KINDS,
    compiler: modules.binding.SKP_CONTRACT_COMPILER,
    bindingVersion: modules.binding.SKP_PHASE_BINDING_VERSION,
    parser: modules.packages.SKP_PARSER_PROFILE,
    phaseProfile: modules.phases.PHASE_SEMANTICS_PROFILE,
    applicationReviewPhaseProfile: modules.phases.ARA_PHASE_SEMANTICS_PROFILE };
}
