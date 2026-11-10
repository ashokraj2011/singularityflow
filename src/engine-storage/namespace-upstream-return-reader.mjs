/** Authenticate a return by its actual issue-owner receipt, without inventing a rejection packet. */
import {canonicalJson} from '../foundation/record-schema.mjs';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {NAMESPACE_UPSTREAM_RETURN_PROFILE} from '../kernel/upstream-issues.mjs';
import {namespaceDecisionReceipts} from './namespace-decision-contract.mjs';
import {createNamespaceUpstreamOwners} from './namespace-upstream-reader.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b);
export function namespaceReturnGenesis(request){const {status,resolution,resolvedAt,resolvedBy,...value}=request;return value;}
export function createNamespaceUpstreamReturnReader({observer,scope,workId}){
  let owned;const reader=()=> (owned??=createNamespaceUpstreamOwners({observer,scope,workId})).readers.get('upstream.decide');
  async function accepted(snapshot,request,{signal,policyTraversal}={}){
    if(request.profile!==NAMESPACE_UPSTREAM_RETURN_PROFILE)return null;
    for(const link of namespaceDecisionReceipts(snapshot.workflow).filter(row=>row.operation==='upstream.decide').reverse()){
      const value=await reader().decode(link.record,{signal});
      if(value.source.profile!==NAMESPACE_UPSTREAM_RETURN_PROFILE||value.request.outcome!=='return'||value.outcome.record.changeRequest?.id!==request.id)continue;
      const proof=await reader().accepted(link,{signal,policyTraversal}),original=proof.accepted.state.workflow.changeRequests?.find(row=>row.id===request.id);
      if(!original||!same(namespaceReturnGenesis(original),namespaceReturnGenesis(request))||value.recordedAt!==request.requestedAt
        ||value.request.issueId!==request.upstreamIssue?.id||request.reviewPacketSha256!==null)break;
      return {kind:'upstream',binding:{operationId:link.operationId,record:link.record},value,accepted:proof.accepted,
        references:[link.record,...proof.source.references]};
    }
    throw new SingularityFlowError('The upstream return lost its exact accepted issue, owner or repair request.',{code:'ENGINE_STORAGE_CORRUPT'});
  }
  return Object.freeze({accepted});
}
