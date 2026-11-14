/** Real scope, cohort and failure decisions. No staged evidence or successful-result flags. */
import {namespaceKnownTestRiskFixture,knownFailureReason} from './namespace-known-test-risk-fixture.mjs';
import {namespaceSelectiveTestRecoveryFixture,selectionReason} from './namespace-selective-test-recovery-fixture.mjs';
import {converterSource} from './namespace-source-clause-fixture.mjs';
const serviceTest="import test from 'node:test';import assert from 'node:assert/strict';import net from 'node:net';import {once} from 'node:events';\n"
 +"import {convert,remoteRequired} from '../src/converter.js';\n// @ac:STORY-1:AC-001\n"
 +"test('converts the approved value',async()=>{assert.equal(convert(255),'FF');if(!remoteRequired)return;const server=net.createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(resolve=>server.close(resolve));await once(net.connect({host:'127.0.0.1',port}),'connect');});\n";
export async function namespaceCombinedRiskFixture(t,{kind,backend='sqlite',repositories=1,configure=()=>{},...options}){
 const known=kind==='known',f=known?await namespaceKnownTestRiskFixture(t,{...options,backend,repositories,selective:true,configure}):
  await namespaceSelectiveTestRecoveryFixture(t,{...options,backend,repositories,baselineSource:converterSource+'export const remoteRequired=false;\n',source:converterSource+'export const remoteRequired=true;\n',
    baselineTestSource:serviceTest,testSource:serviceTest,configure(source){source.definition.testRecovery.enabledRiskCategories.push('validation-unavailable');configure(source);}});
 f.control.permissions.push('test-risk.context','test-risk.confirm-recovery','test-cohort.context','test-cohort.confirm');f.human();
 const baselineOperationId=known?'original-pre-feature-checks':'pre-feature-full-execution',reason=known?knownFailureReason:selectionReason,
  selectionInput={phaseId:'build',baselineOperationId,selection:f.sources.map(unit=>({repositoryId:unit.descriptor.repositoryId,commandId:known?'stable-tests':'legacy-tests',
    files:[known?'test/stable-first.test.js':'test/first.test.js']}))},selection=(await f.engine.run('test-recovery.select-context',selectionInput)).manifest,
  selectionRequest={...selectionInput,operationId:'combined-scope',expectedContext:selection.expectedContext,reason,expires:'2026-11-20',followUpOwner:'suite-owners',remediationRef:'SCOPE-1'};
 await f.engine.run('test-recovery.select-confirm',selectionRequest);let riskRequest;
 if(known){riskRequest=f.request;await f.engine.run('test-risk.confirm-known',riskRequest);}
 else{const risk=(await f.engine.run('test-risk.context',{phaseId:'build'})).manifest,command=risk.commands.find(row=>row.command.id==='node-tests');
  riskRequest={operationId:'combined-environment-risk',phaseId:'build',expectedRecovery:risk.expectedRecovery,commandId:'node-tests',argvSha256:command.argvSha256,
    causeClass:'service-unreachable',cause:'The integration service is genuinely unavailable on this executor.',reason,expires:'2026-11-20'};
  await f.engine.run('test-risk.confirm-recovery',riskRequest);}
 f.author();await f.rebase('combined-before-cohort');await f.retain('combined-before-cohort-source');await f.run('combined-selected-execution');f.human();
 const cohortInput={phaseId:'build',baselineOperationId,observedOperationId:'combined-selected-execution'},cohort=(await f.engine.run('test-cohort.context',cohortInput)).manifest,
  cohortRequest={...cohortInput,operationId:'combined-cohort',expectedContext:cohort.expectedContext,reason,expires:'2026-11-20'};
 await f.engine.run('test-cohort.confirm',cohortRequest);f.author();await f.rebase('combined-before-publication');await f.retain('combined-before-publication-source');await f.run('combined-published-execution');
 return {...f,kind,selectionRequest,riskRequest,cohortRequest,reason};
}
