/** A real pre-feature assertion failure and separate passing Story acceptance tests. */
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {namespaceSourceClauseFixture} from './namespace-source-clause-fixture.mjs';
import {actualWitnessTest} from './namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNodeCheckExecutionUnit,createEnvironmentQualifiedNodeCheckExecutionUnit} from '../../src/sgos/node-check-execution-unit.mjs';
import {createNodeExecutionOwner} from '../../src/sgos/node-execution-owner.mjs';
import {createNamespaceStoryObserver} from '../../src/engine-storage/namespace-story-reader.mjs';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
export const legacyTest="import test from 'node:test';import assert from 'node:assert/strict';test('the unchanged legacy failure',()=>assert.equal(2+2,5));test('the existing passing regression',()=>assert.equal(2+2,4));\n";
export const knownFailureReason='The independently inventoried legacy arithmetic assertion fails identically on the original source; the Story acceptance tests must still pass.';
export async function namespaceKnownTestRiskFixture(t,{backend='sqlite',newTests=false,configure=()=>{},...extra}={}){
  let checks,starts=0;
  const f=await namespaceSourceClauseFixture(t,{backend,baselineTestSource:newTests?null:actualWitnessTest,testSource:actualWitnessTest,
    baselineFiles:{'test/legacy.test.js':legacyTest},retainChanges:false,...extra,
    configure:source=>{
      const primary=source.definition.phases.build.qualityCommands[0];primary.argv=['node','--test','test/converter.test.js'];
      source.definition.phases.build.qualityCommands.push({...structuredClone(primary),id:'legacy-tests',argv:['node','--test','--test-reporter=junit','test/legacy.test.js'],
        result:{adapter:'junit-xml',path:'legacy-report.xml',minimumDiscovered:2,minimumPassed:1}});
      source.definition.testRecovery={enabled:true,riskAuthorities:['reviewers'],enabledRiskCategories:['known-test-failure'],allowEvidenceReuse:true,maxRiskDays:20,
        caseInventory:[{phaseId:'build',commandId:'legacy-tests',adapter:'node-test-junit-v1',dependencyScope:'repository-and-node-builtins-only',
          baselineMutableRoots:['src'],tests:[{id:'legacy:arithmetic',path:'test/legacy.test.js',name:'the unchanged legacy failure'},
            {id:'legacy:passing',path:'test/legacy.test.js',name:'the existing passing regression'}]}]};configure(source);
    },
    beforeSpecification:async f=>{
      f.control.permissions.push('test-recovery.context','test-recovery.confirm');
      const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}}),view=await engine.run('test-recovery.context',{});
      await engine.run('test-recovery.confirm',{operationId:'known-full-command-agreement',phaseId:'intake',expectedContext:view.manifest.expectedContext,reason:knownFailureReason});
    },
    afterPrepare:async(f,_engine,roots)=>{
      f.control.permissions.push('phase.checks.run','test-risk.known-context','test-risk.confirm-known','phase.prepublish','phase.review','phase.review.resources','story.evidence');
      const bindings=[];
      for(const [index,root]of roots.entries()){
        const repositoryId=index?'service-'+index:'app',environment={NODE_OPTIONS:'--test-reporter='+new URL('../../src/verification/node-test-reporter.mjs',import.meta.url).href,
          SINGULARITY_FLOW_NODE_TEST_ROOT:root,SINGULARITY_FLOW_NODE_TEST_TAP:'1'},
          primary=await createNodeCheckExecutionUnit({id:'known-story-check-'+index,root,projectId:f.scope.projectId,repositoryId,content:f.content,
            command:{executable:process.execPath,executableSha256,arguments:['--test','test/converter.test.js'],environment},report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256}),
          legacy=await createEnvironmentQualifiedNodeCheckExecutionUnit({id:'known-legacy-check-'+index,hostId:'known-failure-host',root,projectId:f.scope.projectId,repositoryId,content:f.content,
            command:{executable:process.execPath,executableSha256,arguments:['--test','--test-reporter=junit','test/legacy.test.js'],environment:{}},report:{adapter:'junit-xml',files:[]},authorizeCommand:manifest=>manifest.manifestSha256});
        for(const [commandId,unit,env]of [['node-tests',primary,environment],['legacy-tests',legacy,{}]])bindings.push({phaseId:'build',commandId,repositoryId,
          executable:'node',executableSha256,environment:env,unit:{...unit,start(task){starts++;return unit.start(task);}}});
      }
      checks={owner:createNodeExecutionOwner({hostId:'known-failure-host'}),bindings};
      const options={...f.common,working:{records:f.localRecords,content:f.localContent},sources:[],checks};
      // The actual source ports belong to the already constructed engine's host. Bind identical real ports explicitly.
      const {createFilesystemSourceUnit,createFilesystemSourceContentReader}=await import('../../src/sgos/filesystem-source-unit.mjs');
      options.sources=await Promise.all(roots.map((root,index)=>createFilesystemSourceUnit({root,id:'clause-source-'+index,projectId:f.scope.projectId,repositoryId:index?'service-'+index:'app'})));
      options.sourceReaders=await Promise.all(roots.map((root,index)=>createFilesystemSourceContentReader({root,id:'clause-content-'+index,source:options.sources[index].descriptor})));
      const engine=createNamespaceEngine(options),draft=await engine.run('phase.draft.read',{phaseId:'build'});
      await engine.run('phase.draft.write',{operationId:'author-known-test-summary',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
        content:await f.upload('# Implementation\n\n## Agent brief\n\nThe approved converter has separate acceptance tests; the original legacy assertion remains visibly failed.\n'),reason:knownFailureReason});
      await engine.run('phase.checks.run',{operationId:'original-pre-feature-checks',workId:f.inputs.workId,phaseId:'build'});
    }});
  const make=extra=>createNamespaceEngine({...f.options,checks,...extra}),engine=make(),observer=createNamespaceStoryObserver(f.options),
    author=()=>Object.assign(f.control,{principalId:'author',agentId:'analyst',creator:{name:'Phase author',email:'reviewer@example.test',login:null}}),
    human=()=>Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}}),
    run=operationId=>engine.run('phase.checks.run',{operationId,workId:f.inputs.workId,phaseId:'build'}),
    retain=operationId=>engine.run('phase.source.retain',{operationId,workId:f.inputs.workId,phaseId:'build'}),
    rebase=async operationId=>{const {manifest}=await engine.run('phase.draft.read',{phaseId:'build'});return engine.run('phase.draft.rebase',{
      operationId,workId:f.inputs.workId,phaseId:'build',expectedRevision:manifest.draft.revision,confirm:manifest.draft.bodySha256,reason:knownFailureReason});};
  await retain('known-current-source');await run('current-known-failure-checks');
  const contextInput={phaseId:'build',baselineOperationId:'original-pre-feature-checks',observedOperationId:'current-known-failure-checks'},
    view=await engine.run('test-risk.known-context',contextInput),request={...contextInput,operationId:'review-known-failure',expectedContext:view.manifest.expectedContext,
      reason:knownFailureReason,expires:'2026-11-20',followUpOwner:'legacy-maintainers',remediationRef:'LEGACY-1'};
  return {...f,checks,engine,make,observer,author,human,run,retain,rebase,view,request,starts:()=>starts};
}
