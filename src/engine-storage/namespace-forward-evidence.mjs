/** Construct ordinary policy records in memory; the conditional decision writer alone persists them. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {primaryDocumentPublicationRequirements,codeInputPublicationPolicy,CODE_INPUT_PUBLICATION_OWNERS,conformancePublicationPolicy,CONFORMANCE_PUBLICATION_OWNERS} from '../kernel/publication-intent.mjs';
import {documentReviewPublicationPolicy,DOCUMENT_REVIEW_OWNERS} from '../kernel/document-review.mjs';
import {specificationAnalysisPublicationPolicy} from '../kernel/specification-analysis.mjs';
import {phaseAssignmentRequired} from '../kernel/phase-policy.mjs';
import {createNamespacePublicationReader} from './namespace-publication-reader.mjs';
import {createNamespacePublicationPolicyWriter} from './namespace-policy-retention.mjs';
import {forwardEvidence} from './namespace-forward-projections.mjs';
export async function namespaceForwardEvidence({observer,scope,workId,checks,snapshot,head,publication,reviewer,signal}){
  const phase=snapshot.workflow.phases[publication.phase],definition=(await observer.approved(snapshot,{signal})).compiled.definition,
    required=primaryDocumentPublicationRequirements(snapshot.workflow,phase,{definition}),document=documentReviewPublicationPolicy(snapshot.workflow,phase),
    inputs=codeInputPublicationPolicy(snapshot.workflow,phase),conformance=conformancePublicationPolicy(snapshot.workflow,phase),
    analysis=specificationAnalysisPublicationPolicy(definition,snapshot.workflow,phase),constitution=snapshot.workflow.resolution.constitution?.mode!=='off',
    assignment=phaseAssignmentRequired(snapshot.workflow,definition),recovery=snapshot.workflow.resolution.testRecovery?.enabled===true,available=[...(recovery?['test-recovery']:[]),...(document?DOCUMENT_REVIEW_OWNERS:[]),...(inputs?CODE_INPUT_PUBLICATION_OWNERS:[]),
      ...(conformance?CONFORMANCE_PUBLICATION_OWNERS:[]),...(analysis?['specification-analysis']:[]),...(constitution?['constitution-policy']:[]),...(assignment?['assignment-record']:[])],
    missing=required.filter(owner=>!available.includes(owner));
  if(missing.length)throw new SingularityFlowError('Return this document for its configured authoring and evidence ceremony.',{
    code:'ENGINE_PORT_UNAVAILABLE',details:{phase:phase.id,required:missing,actions:[
      {operation:'forward-amendment.decide',inputs:{workId,amendmentId:publication.origin.amendmentId,decision:'reject',confirmation:publication.origin.amendmentId},
        requiredInputs:['operationId','reason'],prerequisites:['authorized-human-document-owner']},
      {operation:'upstream.raise',inputs:{workId,phaseId:phase.id},requiredInputs:['operationId','about','problem'],prerequisites:['identify-exact-evidence-owner-before-return']}]}});
  if(!available.length)return {bindings:[],pendingEvidence:[],reports:[],references:[]};
  const staged=new Map(),key=ref=>canonicalJson(ref),pendingEvidence=[],reports=[],bindings=[],
    overlay={...observer,async bytes(ref,maximum,passedSignal){const value=staged.get(key(ref));return value?Buffer.from(value.bytes.subarray(0,maximum)):observer.bytes(ref,maximum,passedSignal);}},
    reader=createNamespacePublicationReader({observer:overlay,scope,workId,checks}),content={async put(_scope,namespace,bytes){
      if(namespace!=='evidence')throw new SingularityFlowError('An amendment may construct evidence only.',{code:'ENGINE_PORT_RESULT_INVALID'});
      const value=forwardEvidence(JSON.parse(Buffer.from(bytes).toString('utf8'))),reused=staged.has(key(value.reference));
      if(!reused){staged.set(key(value.reference),value);pendingEvidence.push(value);}return {reference:value.reference,reused};}},
    writer=createNamespacePublicationPolicyWriter({observer:overlay,content,scope,workId,reader:reader.policies}),options={snapshot,head,signal};
  for(const [enabled,method]of [[recovery,'retainRecovery'],[document,'retainDocumentReview'],[inputs,'retainCodeInputs'],[conformance,'retainConformance'],[analysis,'retain'],[constitution,'retainConstitution'],[assignment,'retainAssignment']]){
    if(!enabled)continue;const value=await writer[method](publication,options);bindings.push(value.binding);reports.push({kind:value.binding.kind,reference:value.report});
  }
  const value={...publication,policyEvidence:bindings};await reader.policies.verify(value,{signal});
  const missingProof=required.filter(owner=>!reader.policies.owners(value).includes(owner));
  if(missingProof.length)throw new SingularityFlowError('The replacement lacks its actual configured policy proof.',{code:'ENGINE_PORT_UNAVAILABLE',details:{required:missingProof}});
  const checklist=reader.policies.checklist(value,reviewer,[]);
  if(checklist?.result.errors.length)throw new SingularityFlowError('This replacement needs its normal exact human checklist review.',{code:'ENGINE_PORT_UNAVAILABLE',details:{required:['amendment-human-checklist']}});
  return {bindings,pendingEvidence,reports,checklist,references:reader.policies.evidence(value)};
}
