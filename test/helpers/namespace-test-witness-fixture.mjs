/** Real approved specification/plan, retained source and a pinned Node execution for exact witnesses. */
import {writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {namespaceSourceClauseFixture} from './namespace-source-clause-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNodeCheckExecutionUnit} from '../../src/sgos/node-check-execution-unit.mjs';
import {createNodeExecutionOwner} from '../../src/sgos/node-execution-owner.mjs';
const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex');
export const actualWitnessTest="import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport {convert} from '../src/converter.js';\n// @ac:STORY-1:AC-001\ntest('converts the approved value',()=>assert.equal(convert(255),'FF'));\n";
export async function namespaceTestWitnessFixture(t,{backend='filesystem',testSource=actualWitnessTest,reporter=true,run=true,shared=false,configure=()=>{},...extra}={}){
  const f=await namespaceSourceClauseFixture(t,{backend,retainChanges:false,...extra,...(shared?{namespace:'SHARED',lineOrigins:true,retainOrigins:false}:{}),configure:source=>{
    source.definition.phases.build.qualityCommands[0].argv=['node','--test','test/converter.test.js'];configure(source);}});
  f.control.permissions.push('phase.checks.run');
  let starts=0;const bindings=[],units=[];
  for(const [index,root]of f.roots.entries()){
    const text=typeof testSource==='function'?testSource(index):testSource;
    await writeFile(path.join(root,'test/converter.test.js'),shared?text.replaceAll('STORY-1:','SHARED:'):text);
    const repositoryId=f.sources[index].descriptor.repositoryId,environment=reporter?{NODE_OPTIONS:'--test-reporter='+new URL('../../src/verification/node-test-reporter.mjs',import.meta.url).href,
      SINGULARITY_FLOW_NODE_TEST_ROOT:root,SINGULARITY_FLOW_NODE_TEST_TAP:'1'}:{},
      raw=await createNodeCheckExecutionUnit({id:'witness-check-'+index,root,projectId:f.scope.projectId,repositoryId,content:f.content,
        command:{executable:process.execPath,executableSha256,arguments:['--test','test/converter.test.js'],environment},report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256});
    const unit={...raw,start(task){starts++;return raw.start(task);}};units.push(unit);bindings.push({phaseId:'build',commandId:'node-tests',repositoryId,executable:'node',executableSha256,environment,unit});
  }
  const checks={owner:createNodeExecutionOwner({hostId:'witness-check-host'}),bindings},engine=createNamespaceEngine({...f.options,checks});
  const draft=await engine.run('phase.draft.read',{phaseId:'build'});
  await engine.run('phase.draft.write',{operationId:'author-witness-summary',workId:f.inputs.workId,phaseId:'build',expectedRevision:draft.manifest.draft.revision,
    content:await f.upload('# Implementation\n\n## Agent brief\n\nThe converter and its exact pinned regression implement the approved contract.\n'),reason:'Complete the real draft before retaining test evidence.'});
  await engine.run('phase.source.retain',{operationId:'witness-current-source',workId:f.inputs.workId,phaseId:'build'});
  if(shared)await engine.run('phase.source-control.retain',{operationId:'witness-origin-lines',workId:f.inputs.workId,phaseId:'build'});
  const runChecks=(operationId='witness-execution')=>engine.run('phase.checks.run',{operationId,workId:f.inputs.workId,phaseId:'build'});
  if(run)await runChecks();
  return {...f,checks,engine,units,runChecks,starts:()=>starts,inspect:input=>engine.run('phase.test-witnesses.inspect',{phaseId:'build',...input})};
}
