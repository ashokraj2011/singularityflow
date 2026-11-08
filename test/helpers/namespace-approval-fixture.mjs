/** Actual registered authoring, publication and submission; no seeded completion or votes. */
import {namespacePreparationFixture} from './namespace-preparation-fixture.mjs';
import {createNamespacePublicationEngine} from '../../src/engine-storage/namespace-publication.mjs';
import {createNamespaceSubmissionEngine} from '../../src/engine-storage/namespace-submission.mjs';
import {createNamespaceApprovalEngine} from '../../src/engine-storage/namespace-approval.mjs';
import {createNamespaceLifecycleObserver} from '../../src/engine-storage/namespace-lifecycle-reader.mjs';
export async function namespaceApprovalFixture(t,options={}) {
  const f=await namespacePreparationFixture(t,options);
  f.control.permissions.push('phase.publish','phase.submit','phase.approve');
  const common={records:f.records,content:f.content,scope:f.scope,workId:f.inputs.workId,authority:f.authority,access:f.access,clock:f.clock};
  const make=extra=>createNamespaceApprovalEngine({...common,...extra});
  const capture=async()=> (await createNamespaceLifecycleObserver(common).capture()).snapshot;
  async function submit(phaseId='intake') {
    await f.engine.run('phase.prepare',{phaseId});const draft=await f.engine.run('phase.draft.read',{phaseId});
    await f.engine.run('phase.draft.write',{operationId:'author-'+phaseId,workId:f.inputs.workId,phaseId,
      expectedRevision:draft.manifest.draft.revision,content:await f.upload('# Actual '+phaseId+' result\n\nThe authored review describes its observations and observable outcome.\n'),
      reason:'Retain the complete authored review.'});
    await createNamespacePublicationEngine({...common,localRecords:f.localRecords,localContent:f.localContent}).run('phase.publish',
      {phaseId,authored:'governed-agent',channel:'copilot-host'});
    return createNamespaceSubmissionEngine(common).run('phase.submit',{phaseId});
  }
  async function confirmation(engine=make(),phaseId='intake') {
    const {manifest}=await engine.run('phase.review',{phaseId}),binding=manifest.reviewBinding;
    return {workId:f.inputs.workId,phase:phaseId,generation:binding.generation,reviewPacketSha256:binding.packetSha256};
  }
  return {...f,makeApproval:make,capture,submit,confirmation};
}
