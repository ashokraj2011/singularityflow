/** Capture contract behavior without package, repository or execution effects. */
import * as native from '../../src/skp-contract.mjs';
import * as paths from '../../src/configuration-assets.mjs';
import * as portable from '../../src/util.mjs';
import { DEFAULT_CODE_DELIVERY_POLICY } from '../../src/code-delivery-policy.mjs';
const H = character => 'sha256:' + character.repeat(64);
export const skillModules = { native, paths, portable };
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
function confirmed({ phase, catalog, phaseOrder }, api = native) {
  const catalogSha256 = api.skillCandidateCatalogSha256(catalog);
  return {
    phase, catalog, phaseOrder,
    confirmation: {
      contractSha256: api.skillContractSha256(phase.id, phase.contract),
      catalogSha256,
      packageSha256: phase.skill.packageSha256,
      candidateSha256: api.skillPhaseCandidateSha256(phase, phaseOrder, catalogSha256),
      planSha256: H('b'), draftRevision: 8
    }
  };
}

const code = () => { const value=fixture(); value.phase.contract.writeScope='source-and-artifact';value.phase.contract.task='code';value.phase.contract.sourceScope='application';value.catalog.sourceScopes.application={writeRoots:['src']};value.catalog.codeDelivery=DEFAULT_CODE_DELIVERY_POLICY;value.catalog.checks.unit={id:'unit',argv:['node','--test'],modelPolicy:'never',requirement:'required',kind:'test',result:{adapter:'node-tap',path:'artifacts/test-results/tap.txt',minimumDiscovered:1,minimumPassed:1}};value.phase.contract.checks.push('unit');return value; };
const multiple=()=>{const value=fixture();value.phase.contract.produces.push({id:'risk-register',path:'artifacts/threat-model/risks.md',kind:'review',minimumBytes:100,maximumBytes:10000,clauses:'none',claimRole:'findings'});value.phase.contract.primaryOutput='threat-report';value.phase.contract.artifactSet='threat-bundle';value.catalog.artifactSets['threat-bundle']={primary:'threat-model.md',members:[{path:'threat-model.md',role:'report',required:true},{path:'risks.md',role:'risks',required:true}]};return value;};
const change=(mutate,base=fixture)=>()=>{const value=base();mutate(value);return value;};
const cases=[
 ['ordinary',fixture],['source-code',code],['multiple',multiple],
 ['unknown-output',change(v=>v.phase.contract.produces[0].kind='CUSTOM')],
 ['empty-output',change(v=>v.phase.contract.produces=[])],
 ['optional-only',change(v=>v.phase.contract.produces[0].required=false)],
 ['missing-role',change(v=>delete v.phase.contract.produces[0].claimRole)],
 ['missing-encoding',change(v=>delete v.phase.contract.produces[0].encoding)],
 ['reserved-output',change(v=>v.phase.contract.produces[0].path='artifacts/threat-model/CON.md')],
 ['escaping-output',change(v=>v.phase.contract.produces[0].path='artifacts/threat-model/../other.md')],
 ['unapproved-check',change(v=>v.phase.contract.checks=['invented'])],
 ['shell-check',change(v=>v.catalog.checks.markdownlint={id:'markdownlint',command:'lint all',kind:'lint',modelPolicy:'never'})],
 ['unknown-authority',change(v=>v.phase.contract.approval.authorities=['other'])],
 ['extra-contract',change(v=>v.phase.contract.network='all')],
 ['duplicate-policy',change(v=>v.phase.artifact={kind:'requirements',path:'other.md'})],
 ['management-agent',change(v=>v.catalog.skillPackages['threat-model'].eligibility='management-orchestration')],
 ['upstream-order',change(v=>v.phaseOrder=['intake','threat-model','requirements'])],
 ['upstream-output',change(v=>v.phase.contract.consumes[0].output='missing')],
 ['unapproved-input',change(v=>v.phase.contract.consumes[0].state='published')],
 ['source-without-code',change(v=>v.phase.contract.task='analyze',code)],
 ['source-without-tests',change(v=>v.phase.contract.checks=['markdownlint'],code)],
 ['source-protected',change(v=>v.catalog.sourceScopes.application.writeRoots=['.Github/agents'],code)],
 ['source-unknown-scope',change(v=>v.phase.contract.sourceScope='not-approved',code)],
 ['multi-set-mismatch',change(v=>v.catalog.artifactSets['threat-bundle'].members[1].path='other.md',multiple)],
 ['multi-set-absent',change(v=>delete v.phase.contract.artifactSet,multiple)],
 ['unapproved-read',change(v=>v.phase.contract.readScope.sourcePaths=['secrets/config'])],
 ['approved-read',change(v=>{v.phase.contract.readScope.sourcePaths=['src/model.js'];v.catalog.readPaths=['src/model.js'];})],
 ['altered-after-confirmation',fixture, request=>{request.phase.label='changed after confirmation';}],
 ['invalid-plan-digest',fixture, request=>{request.confirmation.planSha256='invalid';}],
 ['invalid-revision',fixture, request=>{request.confirmation.draftRevision=0;}]
];
const errorOf=error=>({name:error.name,message:error.message,code:error.code??null,exitCode:error.exitCode??null,details:error.details??null});
export function skillContractResults(api=native){return cases.map(([label,create,after],id)=>{const value=create();try{const request=confirmed(value,api);after?.(request);const before=structuredClone(request);const compiled=api.compileConfirmedSkillPhase(request);const configured=api.configurationPhaseFromCompiledSkill(compiled);const binding=api.validateConfiguredSkillPhase(configured,compiled.phaseId);const proposal=api.compileSkillPhaseProposal({phase:request.phase,catalog:request.catalog,phaseOrder:request.phaseOrder});return{id,label,request,before,compiled,configured,binding,proposal};}catch(error){return{id,label,error:errorOf(error)};}});}
export function portableValueResults(api=portable){const values=[null,'','src','.git','.GIT','..','.','folder/name','folder\\name','name.','name ','CON','con.md','com1','LPT9.log','com¹','conin$','CLOCK$','a:b','a?b','a\u0000b','é','e\u0301','alpha_1','0'];return values.flatMap((value,id)=>['isPortableRepositoryPathComponent','portableIdentifier'].map(name=>{try{return{id,name,value,result:api[name](value)};}catch(error){return{id,name,value,error:errorOf(error)};}}));}
export function assetPathResults(api=paths){const definitions=[{}, {templatesRoot:'policy/templates',agentPromptsRoot:'agents',worldModel:{outputDir:'generated/model',promptSource:'prompts/repo.md'},workItemRoot:'stories'}, {templatesRoot:'../escape'}, {templatesRoot:'C:/escape'}, {templatesRoot:'CON'}, {templatesRoot:'templates./assets'}, {templatesRoot:'templates/~1'}, {templatesRoot:'templates/é'}];const outcomes=definitions.map((value,id)=>{try{return{id,value,result:api.configurationAssetPolicy(value,{initiativeRoot:'portfolio'})};}catch(error){return{id,value,error:errorOf(error)};}});const policy=api.configurationAssetPolicy();return{outcomes,defaultPolicy:api.DEFAULT_CONFIGURATION_ASSET_POLICY,merged:api.mergeConfigurationAssetPolicies(policy,api.configurationAssetPolicy({templatesRoot:'custom'})),paths:['singularity/workflow.yml','singularity/work-items/a/a.json','Singularity/work-items/a','singularity/templates/spec.md','.github/agents/a.agent.md','singularity/configuration-source.json','../outside','C:/outside','singularity/CON','singularity/../outside','policy/é','singularity/templates/readme.md.'].map(value=>({value,portable:api.portableConfigurationPath(value),asset:api.isConfigurationAssetPath(value),identity:api.portableFilesystemPathIdentity(value)})),search:api.configurationAssetSearchRoots(policy)};}
