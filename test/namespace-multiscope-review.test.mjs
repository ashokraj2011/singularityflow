import test from 'node:test';import assert from 'node:assert/strict';
import {createNamespaceEngine} from '../src/engine-storage/namespace-engine.mjs';
import {namespaceMultiscopeReviewFixture,namespaceMultiscopeReviewReport} from './helpers/namespace-multiscope-review-fixture.mjs';
for(const backend of ['filesystem','sqlite','application'])test(backend+': planning retains each actual approved scope through independent shared-only review',{timeout:120000},async t=>{
  const f=await namespaceMultiscopeReviewFixture(t,backend,{clarifications:backend==='filesystem'}),view=await f.engine.run('source-review.context',{phaseId:'design'}),
    report=namespaceMultiscopeReviewReport(view.manifest),input={operationId:'review-multiple-approved-scopes',phaseId:'design',expectedContext:view.manifest.contextBinding,report};
  assert.equal(view.manifest.binding.profile,'sflow-source-grounded-multi-scope-review/v1');
  assert.deepEqual(view.manifest.binding.upstreamSpecifications.map(row=>row.phase),['intake','technical']);
  assert.equal(view.manifest.resources.filter(row=>row.kind==='approved-input').length,2);
  if(backend==='filesystem')assert.equal(view.manifest.binding.clarifications.length,3);
  for(const row of view.manifest.resources)assert.equal((await f.engine.run(row.read.operation,row.read.inputs)).document.integrity,'matched');
  assert.equal(view.manifest.reportContract.profile,report.profile);assert.equal(view.manifest.reportContract.semanticJudgmentRequired,true);
  f.control.agentId='source-reviewer';
  if(backend==='filesystem'){
    const before=await f.capture(),incompatible=structuredClone(report);delete incompatible.profile;
    await assert.rejects(f.engine.run('source-review.record',{...input,operationId:'missing-explicit-profile',report:incompatible}),{code:'SOURCE_REVIEW_REPORT_INVALID'});
    assert.deepEqual(await f.capture(),before);
    await f.engine.run('source-review.record',{...input,operationId:'repair-one-omitted-row',report:{...report,rows:report.rows.slice(0,-1)}});
    const correction=await f.engine.run('source-review.context',{phaseId:'design'});assert.equal(correction.manifest.status.status,'correction-required');
    input.expectedContext=correction.manifest.contextBinding;
  }
  await f.engine.run('source-review.record',input);
  assert.equal((await f.engine.run('source-review.context',{phaseId:'design'})).manifest.status.status,'ready');
  const state=await f.capture();
  const receipt=state.workflow.namespaceDecisionReceipts.find(row=>row.operationId===input.operationId),
    retained=JSON.parse(Buffer.from((await f.content.read(f.scope,receipt.record)).data)),referenceSha=retained.source.binding.upstreamSpecifications[1].originalSha256,
    denied=Object.freeze(Object.assign(Error('Original multi-scope provenance is unreadable.'),{code:'EACCES'}));
  const bad=createNamespaceEngine({...f.options,content:{...f.content,read(scope,ref,options){if(ref.sha256===referenceSha)throw denied;return f.content.read(scope,ref,options);}}});
  await assert.rejects(bad.run('source-review.context',{phaseId:'design'}),error=>error===denied);
  f.control.agentId='analyst';await f.approve('design');assert.equal((await f.capture()).workflow.currentPhase,'build');
  const historical=createNamespaceEngine({...f.options,working:null,clock:{now(){throw Error('Replay cannot replace the original time.');}}});f.control.agentId='source-reviewer';
  const before=await f.capture();await historical.run('source-review.record',input);assert.deepEqual(await f.capture(),before);
});
