/** Two genuine scope approvals feed one independently reviewed plan; no synthetic source document. */
import {namespaceSpecificationFixture,specificationText,planText} from './namespace-specification-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
const storyText='# Request\n\nConvert an integer into hexadecimal and reject invalid input.\n';
const secondSpec='# Specification\n\n## Requirements\n[STORY-1:REQ-002] Reject invalid input.\n\n## Acceptance criteria\n[STORY-1:AC-002] A negative input is rejected.\n';
export async function namespaceMultiscopeReviewFixture(t,backend='filesystem',{clarifications=false}={}){
  const f=await namespaceSpecificationFixture(t,{backend,storyText,configure(source){
    source.definition.phases.technical={...structuredClone(source.definition.phases.intake),label:'Technical scope',
      artifact:{path:'artifacts/technical/spec.md',kind:'requirements'},inputs:[{phase:'intake'}]};
    source.definition.workTypes.simple.phases=['intake','technical','design','build'];
    source.definition.workTypes.simple.plannedClaims.clausePhases=['intake','technical'];
    source.definition.phases.design.inputs=[{phase:'intake'},{phase:'technical'}];
    source.agents[0].phases.push('technical');source.agents[0].defaultFor.push('technical');
    source.definition.workTypes.simple.sourceReview={mode:'enforce',phases:['design'],reviewerAgent:'source-reviewer'};
    source.agents.push({...structuredClone(source.agents[0]),id:'source-reviewer',label:'Independent source reviewer',mode:'read-only-review',defaultFor:[]});
    if(clarifications)for(const id of ['intake','technical','design'])source.definition.phases[id].clarification={mode:'required',markers:{mode:'off'}};
  }}),options={...f.common,working:{records:f.localRecords,content:f.localContent}},engine=createNamespaceEngine(options);
  f.control.permissions.push('source-review.context','source-review.record','clarification.status','clarification.record');
  async function clarify(phaseId){if(!clarifications)return;const view=await engine.run('clarification.status',{phaseId});
    await engine.run('clarification.record',{operationId:'answer-'+phaseId,workId:f.inputs.workId,phaseId,contextSha256:view.context.sha256,
      responses:[{question:'Which behavior belongs to this scope?',answer:'The approved request requires hexadecimal conversion and rejection of negative input.'}]});}
  for(const [phaseId,text]of [['intake',specificationText],['technical',secondSpec]]){
    await clarify(phaseId);await f.author(phaseId,text);await f.approve(phaseId);
  }
  await clarify('design');await f.author('design',planText+['REQ-002','AC-002'].map(id=>'| STORY-1:'+id+' | `src/converter.js` | `test/converter.test.js` |\n').join(''));
  return {...f,engine,options};
}
export function namespaceMultiscopeReviewReport(manifest){return {schemaVersion:1,profile:manifest.binding.profile,resultType:'source-grounded-review',kind:'planning',binding:manifest.binding,
  reviewer:{agentId:'source-reviewer',readOnly:true},sourcesReviewed:['story-source'],clarificationsReviewed:(manifest.binding.clarifications??[]).map(row=>row.id),findings:[],
  rows:['REQ-001','AC-001','REQ-002','AC-002'].map(id=>({clauseId:'STORY-1:'+id,expectedPaths:['src/converter.js'],plannedTests:['test/converter.test.js'],testDisposition:'applicable',assessment:'supported'}))};}
