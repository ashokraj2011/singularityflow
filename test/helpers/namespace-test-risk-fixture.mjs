/** Real stopped local service and instrumented node:test observations, never printed failure fixtures. */
import {createHash} from 'node:crypto';import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {namespacePhaseCheckFixture} from './namespace-phase-check-fixture.mjs';
import {createNamespaceEngine} from '../../src/engine-storage/namespace-engine.mjs';
import {createNamespaceStoryObserver} from '../../src/engine-storage/namespace-story-reader.mjs';
import {createNodeCheckExecutionUnit} from '../../src/sgos/node-check-execution-unit.mjs';
export const testRiskReason='The independent service integration pipeline exercises the same service before the deployment is accepted.';
export async function namespaceTestRiskFixture(t,{backend='sqlite',assertion=false,configure=()=>{}}={}){
  const f=await namespacePhaseCheckFixture(t,{backend,configure(source){
    source.definition.phases.intake.qualityCommands[0].argv=['node','--test','case.test.mjs'];
    source.definition.phases.intake.approval.allowSelfApproval=false;
    source.definition.approvalAuthorities.reviewers.members.push({email:'independent@example.test'},{email:'author@example.test'});configure(source);
  }});
  await writeFile(path.join(f.root,'case.test.mjs'),assertion?"import test from 'node:test';import assert from 'node:assert/strict';test('real assertion fails',()=>assert.equal(2+2,5));\n":
    "import test from 'node:test';import net from 'node:net';import {once} from 'node:events';\n"+
    "test('actual unavailable integration service',async()=>{const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));const socket=net.connect({port,host:'127.0.0.1'});await once(socket,'connect');});\n");
  const executableSha256='sha256:'+createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
    reporter=fileURLToPath(new URL('../../src/verification/node-test-reporter.mjs',import.meta.url)),
    environment={NODE_OPTIONS:'--test-reporter='+JSON.stringify(reporter),SINGULARITY_FLOW_NODE_TEST_ROOT:f.root,SINGULARITY_FLOW_NODE_TEST_TAP:'1'},
    raw=await createNodeCheckExecutionUnit({id:'actual-environment-test',root:f.root,projectId:f.scope.projectId,repositoryId:'app',content:f.content,
      command:{executable:process.execPath,executableSha256,arguments:['--test','case.test.mjs'],environment},
      report:{adapter:'node-tap',files:[]},authorizeCommand:manifest=>manifest.manifestSha256}),
    checks={...f.checks,bindings:[{...f.checks.bindings[0],environment,unit:{...raw,start(task){f.control.starts++;return raw.start(task);}}}]},
    {localRecords,localContent,...shared}=f.options,common={...shared,working:{records:localRecords,content:localContent}},
    make=extra=>createNamespaceEngine({...common,checks,...extra}),engine=make(),observer=createNamespaceStoryObserver(common),
    author=()=>Object.assign(f.accessControl,{actorKind:'human',principalId:'risk-author',creator:{name:'Phase author',email:'author@example.test',login:null},agentId:'analyst'}),
    human=()=>Object.assign(f.accessControl,{actorKind:'human',principalId:'risk-reviewer',creator:{name:'Independent reviewer',email:'independent@example.test',login:null},agentId:null});
  f.accessControl.permissions.push('test-risk.context','decision.test-risk','phase.publish','phase.submit','phase.review','phase.approve','phase.prepublish','phase.review.resources','decisions.list');author();
  const view=await engine.run('test-risk.context',{phaseId:'intake'}),request={phaseId:'intake',commandId:'node-tests',argvSha256:view.manifest.commands[0].argvSha256,
    causeClass:'service-unreachable',cause:'The integration service is not running on this device.',reason:testRiskReason,expires:'2026-11-20'},
    rebase=async operationId=>{const {manifest}=await engine.run('phase.draft.read',{phaseId:'intake'});return engine.run('phase.draft.rebase',{
      operationId,workId:f.inputs.workId,phaseId:'intake',expectedRevision:manifest.draft.revision,confirm:manifest.draft.bodySha256,reason:testRiskReason});};
  return {...f,common,checks,make,engine,observer,request,author,human,rebase};
}
