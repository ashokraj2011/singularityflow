/** Genuine observed baseline and a separately executed reduced suite. */
import {writeFile} from 'node:fs/promises';import path from 'node:path';
import {namespaceTestWitnessFixture,actualWitnessTest} from './namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../../src/engine-storage/namespace-story-reader.mjs';
const extraTest="test('an existing unrelated regression',()=>assert.equal(2+2,4));\n",cohortReason='The existing unrelated regression is exercised in the integration suite; the exact changed converter has fresh focused evidence.';
export {cohortReason,extraTest as cohortExtraTest};
export async function namespaceObservedCohortFixture(t,backend='sqlite',extra={}){
  const f=await namespaceTestWitnessFixture(t,{backend,testSource:actualWitnessTest+extraTest,run:false,...extra});
  f.control.permissions.push('test-cohort.context','test-cohort.confirm','phase.review','phase.prepublish','phase.review.resources');
  const make=extra=>createNamespaceEngine({...f.options,checks:f.checks,...extra}),engine=make(),observer=createNamespaceStoryObserver(f.options),
    author=()=>Object.assign(f.control,{principalId:'author',agentId:'analyst',creator:{name:'Phase author',email:'reviewer@example.test',login:null}}),
    human=()=>Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}}),
    run=operationId=>engine.run('phase.checks.run',{operationId,workId:f.inputs.workId,phaseId:'build'}),
    retain=operationId=>engine.run('phase.source.retain',{operationId,workId:f.inputs.workId,phaseId:'build'}),
    rebase=async operationId=>{const {manifest}=await engine.run('phase.draft.read',{phaseId:'build'});return engine.run('phase.draft.rebase',{
      operationId,workId:f.inputs.workId,phaseId:'build',expectedRevision:manifest.draft.revision,confirm:manifest.draft.bodySha256,reason:cohortReason});};
  await run('baseline-suite');await writeFile(path.join(f.root,'test/converter.test.js'),actualWitnessTest);await retain('selected-source');await run('selected-suite');
  const contextInput={phaseId:'build',baselineOperationId:'baseline-suite',observedOperationId:'selected-suite'},view=await engine.run('test-cohort.context',contextInput),
    request={...contextInput,operationId:'confirm-selected-suite',expectedContext:view.manifest.expectedContext,reason:cohortReason,expires:'2026-11-20'};
  return {...f,make,engine,observer,author,human,run,retain,rebase,view,request};
}
