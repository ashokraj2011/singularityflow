/** Authenticate local input metadata without reading or uploading another device's files. */
import {createHash} from 'node:crypto';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {planStoryDocument} from '../kernel/story-documents.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
import {createNamespaceRecordedMutationReader} from './namespace-recorded-mutation-reader.mjs';
import {namespaceDocumentIndex,namespaceReadRecord} from './namespace-read-contract.mjs';
const hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex'),same=(a,b)=>canonicalJson(a)===canonicalJson(b);
const error=(message,code='ENGINE_STORAGE_CORRUPT',details=null)=>new SingularityFlowError(message,{code,details});
export const INPUT_DOCUMENT_OPERATIONS=Object.freeze(['story.document.attach','story.document.detach']);
function inputRows(workflow){
  namespaceDocumentIndex(namespaceReadRecord('documents',{documents:workflow.namespaceDocuments??[]}));
  return (workflow.namespaceDocuments??[]).filter(row=>row.kind==='input-document');
}
export function createNamespaceInputDocumentOwners({observer,scope,workId}) {
  const owners=new Map(),readers=new Map();
  async function admitted(snapshot,{signal,policyTraversal}={}) {
    const rows=inputRows(snapshot.workflow),links=namespaceDecisionContract.receipts(snapshot.workflow)
      .filter(row=>INPUT_DOCUMENT_OPERATIONS.includes(row.operation)),last=links.at(-1);
    if(!last){if(rows.length)throw error('Input metadata needs its original accepted attachment operation.');return [];}
    const proof=await readers.get(last.operation).accepted(last,{signal,policyTraversal});
    if(!same(inputRows(proof.accepted.state.workflow),rows))throw error('Input metadata differs from the accepted attach/detach sequence.');
    return [last.record];
  }
  for(const operation of INPUT_DOCUMENT_OPERATIONS) {
    const owner={
      async read(snapshot,request,{signal,policyTraversal}={}) {
        const references=await admitted(snapshot,{signal,policyTraversal}),phase=snapshot.workflow.phases[request.phaseId];
        if(!phase)throw error('The input owner is not in this Story.','ENGINE_PHASE_UNAVAILABLE');
        return {generation:phase.generation,references,identity:{profile:'sflow-local-input-metadata/v1',
          documentsSha256:hash(inputRows(snapshot.workflow)),document:request.documentId}};
      },authority:()=>null,
      plan(workflow,request,facts) {
        const planned=planStoryDocument(workflow,operation,request);planned.workflow.history.push({at:facts.at,actor:facts.actorId,agent:facts.agentId,
          event:operation.endsWith('attach')?'input_attached':'input_detached',phase:workflow.currentPhase,
          detail:request.documentId+': '+request.reason});return planned;
      }
    };
    owners.set(operation,owner);readers.set(operation,createNamespaceRecordedMutationReader({observer,scope,workId,operation,owner,contract:namespaceDecisionContract}));
  }
  return Object.freeze({owners,readers,admitted});
}
