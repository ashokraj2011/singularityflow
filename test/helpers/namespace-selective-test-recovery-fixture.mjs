/** Real full original baseline, approved independent cases and a later whole-file receiving run. */
import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {namespaceSourceClauseFixture} from './namespace-source-clause-fixture.mjs';
import {actualWitnessTest} from './namespace-test-witness-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNodeCheckExecutionUnit,createEnvironmentQualifiedNodeCheckExecutionUnit} from '../../src/sgos/node-check-execution-unit.mjs';
import {createFilesystemSourceUnit} from '../../src/sgos/filesystem-source-unit.mjs';
import {createNodeExecutionOwner} from '../../src/sgos/node-execution-owner.mjs';
import {createNamespaceStoryObserver} from '../../src/engine-storage/namespace-story-reader.mjs';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
export const selectionReason='Run the selected independent legacy regression and all Story acceptance tests; the other unchanged baseline regression stays explicitly unexecuted.';
export async function namespaceSelectiveTestRecoveryFixture(t,{backend='sqlite',configure=()=>{},...extra}={}){
  let checks,starts=0,deadlines={};
  const f=await namespaceSourceClauseFixture(t,{backend,baselineTestSource:actualWitnessTest,testSource:actualWitnessTest,retainChanges:false,...extra,
    baselineFiles:{'test/first.test.js':"import test from 'node:test';import assert from 'node:assert/strict';test('first stable regression',()=>assert.equal(2+2,4));\n",
      'test/second.test.js':"import test from 'node:test';import assert from 'node:assert/strict';test('second stable regression',()=>assert.equal(3+3,6));\n",...(extra.baselineFiles??{})},
    configure:source=>{
      const primary=source.definition.phases.build.qualityCommands[0];primary.argv=['node','--test','test/converter.test.js'];
      source.definition.phases.build.qualityCommands.push({...structuredClone(primary),id:'legacy-tests',argv:['node','--test','--test-reporter=junit','test/first.test.js','test/second.test.js'],
        result:{adapter:'junit-xml',path:'legacy-report.xml',minimumDiscovered:2,minimumPassed:2}});
      source.definition.testRecovery={enabled:true,riskAuthorities:['reviewers'],enabledRiskCategories:['reduced-coverage'],allowEvidenceReuse:true,maxRiskDays:20,
        caseInventory:[{phaseId:'build',commandId:'legacy-tests',adapter:'node-test-junit-v1',dependencyScope:'repository-and-node-builtins-only',baselineMutableRoots:['src'],
          tests:[{id:'legacy:first',path:'test/first.test.js',name:'first stable regression'},{id:'legacy:second',path:'test/second.test.js',name:'second stable regression'}]}]};configure(source);
      deadlines=Object.fromEntries(source.definition.phases.build.qualityCommands.map(row=>[row.id,row.timeoutMs??300000]));
    },
    beforeSpecification:async f=>{
      f.control.permissions.push('test-recovery.context','test-recovery.confirm');
      const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent}}),view=await engine.run('test-recovery.context',{});
      await engine.run('test-recovery.confirm',{operationId:'original-full-recovery',phaseId:'intake',expectedContext:view.manifest.expectedContext,reason:selectionReason});
    },
    afterPrepare:async(f,_engine,roots)=>{
      f.control.permissions.push('phase.checks.run','test-recovery.select-context','test-recovery.select-confirm','phase.prepublish','phase.review','phase.review.resources','story.evidence');
      const bindings=[],sources=[];
      function wrap(raw){return {...raw,start(task){starts++;return raw.start(task);},...(raw.selectTestFiles?{async selectTestFiles(input){return wrap(await raw.selectTestFiles(input));}}:{})};}
      for(const [index,root]of roots.entries()){
        const repositoryId=index?'service-'+index:'app',environment={NODE_OPTIONS:'--test-reporter='+new URL('../../src/verification/node-test-reporter.mjs',import.meta.url).href,
          SINGULARITY_FLOW_NODE_TEST_ROOT:root,SINGULARITY_FLOW_NODE_TEST_TAP:'1'},
          primary=await createNodeCheckExecutionUnit({id:'selective-primary-'+index,root,projectId:f.scope.projectId,repositoryId,content:f.content,timeoutMs:deadlines['node-tests'],
            command:{executable:process.execPath,executableSha256,arguments:['--test','test/converter.test.js'],environment},report:{adapter:'node-tap',files:[]},authorizeCommand:m=>m.manifestSha256}),
          legacy=await createEnvironmentQualifiedNodeCheckExecutionUnit({id:'selective-legacy-'+index,hostId:'selective-host',root,projectId:f.scope.projectId,repositoryId,content:f.content,timeoutMs:deadlines['legacy-tests'],
            command:{executable:process.execPath,executableSha256,arguments:['--test','--test-reporter=junit','test/first.test.js','test/second.test.js'],environment:{}},report:{adapter:'junit-xml',files:[]},authorizeCommand:m=>m.manifestSha256});
        for(const [commandId,unit,env]of [['node-tests',primary,environment],['legacy-tests',legacy,{}]])bindings.push({phaseId:'build',commandId,repositoryId,
          executable:'node',executableSha256,environment:env,unit:wrap(unit)});
        sources.push(await createFilesystemSourceUnit({root,id:'clause-source-'+index,projectId:f.scope.projectId,repositoryId}));
      }
      checks={owner:createNodeExecutionOwner({hostId:'selective-host'}),bindings};
      const engine=createNamespaceEngine({...f.common,working:{records:f.localRecords,content:f.localContent},sources,checks}),draft=await engine.run('phase.draft.read',{phaseId:'build'});
      await engine.run('phase.draft.write',{operationId:'author-selective-summary',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
        content:await f.upload('# Implementation\n\n## Agent brief\n\nThe approved converter has current acceptance tests and an independently inventoried stable suite.\n'),reason:selectionReason});
      await engine.run('phase.checks.run',{operationId:'pre-feature-full-execution',workId:f.inputs.workId,phaseId:'build'});
    }});
  const engine=createNamespaceEngine({...f.options,checks}),make=extra=>createNamespaceEngine({...f.options,checks,...extra}),observer=createNamespaceStoryObserver(f.options),
    contextInput={phaseId:'build',baselineOperationId:'pre-feature-full-execution',selection:f.sources.map(row=>({repositoryId:row.descriptor.repositoryId,commandId:'legacy-tests',files:['test/first.test.js']}))},
    human=()=>Object.assign(f.control,{principalId:'independent-reviewer',agentId:null,creator:{name:'Independent reviewer',email:'independent@example.test',login:null}}),
    author=()=>Object.assign(f.control,{principalId:'author',agentId:'analyst',creator:{name:'Phase author',email:'reviewer@example.test',login:null}}),
    view=()=>engine.run('test-recovery.select-context',contextInput),confirm=async()=>{
      human();const reviewed=await view(),request={...contextInput,operationId:'review-selected-files',expectedContext:reviewed.manifest.expectedContext,
        reason:selectionReason,expires:'2026-11-20',followUpOwner:'suite-maintainers',remediationRef:'TEST-SCOPE-1'};
      const result=await engine.run('test-recovery.select-confirm',request);return {request,result,view:reviewed};},
    rebase=async(id='rebase-selected-generation')=>{author();const draft=await engine.run('phase.draft.read',{phaseId:'build'});
      await engine.run('phase.draft.rebase',{operationId:id,workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
        confirm:draft.manifest.draft.bodySha256,reason:selectionReason});
      await engine.run('phase.source.retain',{operationId:id+'-source',workId:f.inputs.workId,phaseId:'build'});},
    run=(operationId='selected-receiving-execution')=>engine.run('phase.checks.run',{operationId,workId:f.inputs.workId,phaseId:'build'});
  return {...f,engine,make,checks,observer,human,author,view,confirm,rebase,run,contextInput,starts:()=>starts};
}
