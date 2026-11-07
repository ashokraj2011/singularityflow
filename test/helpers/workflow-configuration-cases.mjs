/** Compatibility inputs exercise the real packaged compiler and all its policy collaborators. */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import * as native from '../../src/config.mjs';

export const configurationCases = [
  ['packaged-v2', () => {}],
  ['template-v3', d => { d.version = 3; }],
  ['bootstrap-catalog', d => { d.agentCatalog = [{id:'phase-author',defaultFor:['specification'],metadata:{}}]; }, {storyBootstrap:true}],
  ['retired-settings', d => { d.architectureIntent={enabled:true};d.worldModel.views={unused:true}; }],
  ['unknown-version', d => { d.version = 1; }],
  ['retired-personas', d => { d.personas = {}; }],
  ['empty-workflows', d => { d.workTypes = {}; }],
  ['empty-phases', d => { d.phases = {}; }],
  ['unsupported-producer', d => { d.phases.specification.kind = 'custom'; }],
  ['unknown-authoring-skill', d => { d.phases.specification.authoringSkill = 'sf-does-not-exist'; }],
  ['producer-authoring-conflict', d => { d.phases.convergence.authoringSkill = 'sf-phase'; }],
  ['unknown-commit-policy', d => { d.git.commitPolicy = {unknown:true}; }],
  ['escaping-templates-root', d => { d.templatesRoot = '../outside'; }],
  ['catalog-template', d => { d.templates={example:{label:'Example',path:'common/example.md'}};d.phases.specification.defaultTemplate='template:example'; }],
  ['missing-template', d => { d.phases.specification.defaultTemplate='template:absent'; }],
  ['unknown-sequence-gate', d => { d.sequenceGates={unknown:'soft'}; }],
  ['soft-sequence', d => { d.sequenceGates={default:'soft',completion:'hard'}; }],
  ['invalid-readiness', d => { d.repositoryReadiness={structuredTests:'never'}; }],
  ['invalid-test-runtime', d => { d.repositoryReadiness={testRuntime:{unknown:true}}; }],
  ['preview-composer', d => { d.tokenEconomy={mode:'record',composer:'tkr-v1'}; }],
  ['unknown-model', d => { d.models={providers:{example:{type:'unknown'}}}; }],
  ['unknown-document-phase', d => { d.documents={allowedPhases:['absent']}; }],
  ['unknown-workflow-phase', d => { d.workTypes.feature.phases.push('absent'); }],
  ['inactive-override', d => { d.workTypes.feature.phaseOverrides={absent:{label:'Invalid'}}; }],
  ['invalid-approval-authority', d => { d.phases.specification.approval={mode:'required',authorities:['absent']}; }],
  ['convergence-cannot-waive', d => { d.phases.convergence.approval={mode:'none'}; }],
  ['convergence-cannot-author', d => { d.phases.convergence.generation={requirement:'required',defaultProducer:'human',allowedProducers:['human']}; }],
  ['invalid-size', d => { d.phases.specification.artifact.maximumBytes=0; }],
  ['invalid-heading', d => { d.phases.specification.artifact.validation={requiredHeadings:['Same','same']}; }],
  ['description-only', d => { d.phases.specification.description='Describe the accepted behavior.'; }],
  ['unknown-artifact-set', d => { d.phases.specification.artifactSet='absent'; }],
  ['duplicate-input', d => { d.phases.planning.inputs=['specification','specification']; }],
  ['input-not-preceding', d => { d.workTypes['spec-driven-standard'].phaseOverrides.planning={inputs:['implementation']}; }],
  ['summary-projection', d => { d.workTypes['spec-driven-standard'].phaseOverrides.release.inputs=[{phase:'verification',projection:'approved-summary',preserve:['Evidence'],maximumSummaryBytes:4096}]; }],
  ['invalid-rework-direction', d => { d.workTypes.feature.reworkLoops=[{from:'intake',to:'implementation',maxAttempts:2}]; }],
  ['invalid-decision', d => { d.workTypes.feature.decisions=[{after:'intake',kind:'unknown'}]; }],
  ['required-web-review-no-preview', d => { d.workTypes.feature.applicationReview={mode:'required',surface:'web'}; }],
  ['unknown-workflow', () => {}, {}, 'absent'],
  ['inherited-workflow', () => {}, {}, 'constructor'],
  ['missing-reviewer', d => { d.agentCatalog=[{id:'phase-author',defaultFor:['specification'],metadata:{}}]; }],
  ['invalid-visual-threshold', d => { d.workTypes.feature.verification={comparison:{mode:'enforce'}}; }],
  ['invalid-skill-phase', d => { d.version=3;d.phases.specification.kind='skill'; }],
  ['unbound-template-resolution', d => { d.phases.specification.defaultTemplate='template:absent'; }, null, 'spec-driven-standard']
];

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function configurationCaseResults() {
  const source = YAML.parse(await readFile(new URL('../../templates/workflow.yml', import.meta.url),'utf8'));
  const results=[];
  for (const [name, mutate, options={}, only=null] of configurationCases) {
    const definition=structuredClone(source);
    try {
      mutate(definition);
      if (options !== null) native.validateDefinition(definition,options);
      const resolutions=only ? [native.resolveWorkType(definition,only)]
        : Object.keys(definition.workTypes).map(id=>native.resolveWorkType(definition,id));
      results.push({name,status:'compiled',definition:sha(definition),resolution:sha(resolutions),workTypes:resolutions.length});
    } catch(error) {
      results.push({name,status:'refused',definition:sha(definition),error:{name:error.name,message:error.message,
        code:error.code??null,exitCode:error.exitCode??null,details:error.details??null}});
    }
  }
  return results;
}
