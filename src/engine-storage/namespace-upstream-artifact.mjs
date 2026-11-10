/** One registered batch coordinator over independently recoverable issue transactions. */
import {createHash} from 'node:crypto';
import {SingularityFlowError} from '../foundation/failures.mjs';
import {canonicalJson} from '../foundation/record-schema.mjs';
import {namespaceIdentifier} from '../sda/namespace/values.mjs';
import {phaseTransitionAccess,phaseAccessIdentity} from '../kernel/phase-preparation.mjs';
import {upstreamOperationRequest} from '../kernel/decision-plan.mjs';
import {raiseUpstreamIssue,UPSTREAM_ISSUE_PROPOSALS,UPSTREAM_ISSUE_PROBLEM_MAXIMUM} from '../kernel/upstream-issues.mjs';
import {createNamespaceUpstreamOwners} from './namespace-upstream-reader.mjs';
import {namespaceDecisionContract} from './namespace-decision-contract.mjs';
const same=(a,b)=>canonicalJson(a)===canonicalJson(b),hash=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const error=(message,code='UPSTREAM_ISSUE_INVALID',details=null)=>new SingularityFlowError(message,{code,details});
export function createNamespaceArtifactIssuePort(options,{observer,owned,portFor,runtime}){
  const {scope,workId,access,clock}=options,states=new WeakMap(),reports=owned.reports;
  async function identity(signal,expected=null){const facts=await access.current({projectId:scope.projectId,workId,operation:'upstream.raise',signal});
    phaseTransitionAccess(facts,scope.projectId,'upstream.raise',{expected});return {facts,principal:phaseAccessIdentity(facts,scope.projectId)};}
  function selected(context){const s=states.get(context);if(!s)throw error('Use the issued report batch.','ENGINE_INPUT_INVALID');return s;}
  return {
    async load(input,{signal}={}){
      const operationId=namespaceIdentifier(input.operationId,'Discrepancy batch operation ID'),request=upstreamOperationRequest('upstream.raise',input),
        requestSha256=hash({workId,request}),prefix='artifact-'+hash({scope,workId,operationId}).slice(0,48)+'-',
        snapshot=(await observer.inspect({signal})).snapshot,{facts,principal}=await identity(signal);
      const manual=['phaseId','about','problem','assumption','impact','supersedes'].filter(key=>request[key]!=null);
      if(manual.length)throw error('Artifact filing reads each owner and item from the report; omit the manual issue fields.','UPSTREAM_ISSUE_OPTIONS_INVALID',{fields:manual});
      if(request.proposed!==null&&!UPSTREAM_ISSUE_PROPOSALS.includes(request.proposed))throw error('Choose a supported proposed owner action.');
      if(request.authored!==null&&!['human','governed-agent'].includes(request.authored))throw error('Choose human or governed-agent authorship.');
      const links=namespaceDecisionContract.receipts(snapshot.workflow).filter(row=>row.operationId.startsWith(prefix));
      if(links.length>50)throw error('The discrepancy batch exceeds its bounded item inventory.','ENGINE_STORAGE_CORRUPT');
      let original=snapshot,token=null,batch={operationId,requestSha256,proposed:request.proposed,at:await clock.now()},agent=facts.agentId??null;
      const proofs=[];
      for(const link of links.sort((a,b)=>Number(a.operationId.slice(prefix.length))-Number(b.operationId.slice(prefix.length)))){
        if(link.operation!=='upstream.raise'||!/^\d+$/u.test(link.operationId.slice(prefix.length)))throw error('Another operation occupies this batch.','ENGINE_OPERATION_ID_REUSED');
        const proof=await owned.readers.get('upstream.raise').accepted(link,{signal}),source=proof.value.source;
        if(source.profile!=='sflow-namespace-upstream-source/v2'||source.batch.operationId!==operationId||source.batch.requestSha256!==requestSha256)throw error(
          'This batch ID has a different retained request.','ENGINE_OPERATION_ID_REUSED');
        if(!same(proof.value.actor,principal.actor))throw error('Only the original issue producer can replay this batch.','ENGINE_ACTOR_CHANGED');
        proofs.push(proof);
      }
      if(proofs.length){const first=proofs[0];
        if(first.value.operationId!==prefix+'0'||proofs.some((proof,index)=>proof.value.operationId!==prefix+index
          ||!same(proof.value.source.report,first.value.source.report)||!same(proof.value.source.batch,first.value.source.batch)))throw error(
          'The accepted batch prefix lost its exact source or ordered receipts.','ENGINE_STORAGE_CORRUPT');
        original=first.original;batch=first.value.source.batch;agent=first.value.agentId;
        token=await reports.restore(original,first.value.source.report,{signal});
      }else{
        await owned.admitted(snapshot,{signal});token=await reports.capture(snapshot,{signal});
      }
      const context={subject:{kind:'story',id:workId},workflow:original.workflow};
      states.set(context,{snapshot,original,token,batch,prefix,request,principal,agent,authored:request.authored??(principal.actor.actorKind==='human'?'human':'governed-agent'),accepted:0});
      return context;
    },
    async resolve(context,request,{signal}={}){
      const s=selected(context);if(!same(request,s.request))throw error('Use this batch\'s original request.','ENGINE_INPUT_INVALID');
      if((s.authored==='human')!==(s.principal.actor.actorKind==='human'))throw error('The report producer differs from its authenticated authorship.','ENGINE_ACTOR_CHANGED');
      const recorded=reports.requests(s.original,s.token,s.batch.at);
      if(recorded.tooLong.length)throw error('Split the overlong discrepancy items before filing; no item was raised.','UPSTREAM_ISSUE_PROBLEM_TOO_LONG',{
        maximum:UPSTREAM_ISSUE_PROBLEM_MAXIMUM,items:recorded.tooLong});
      s.requests=recorded.requests.map(item=>({...item,proposed:request.proposed??item.proposed}));
      if(s.requests.length>50)throw error('Split this report into bounded discrepancy batches.','UPSTREAM_ISSUE_INVALID');
      const owners=createNamespaceUpstreamOwners({observer,scope,workId,runtime,artifactReports:reports,artifactSelection:{token:s.token,batch:s.batch}});
      s.owner=owners.owners.get('upstream.raise');
      // Validate the entire batch, including every actual earlier publication, before the first effect.
      const scratch=structuredClone(context.workflow);
      for(const item of s.requests){const child={...upstreamOperationRequest('upstream.raise',{...item,phaseId:item.phase,authored:s.authored}),phaseId:item.phase};
        await s.owner.read(s.original,child,{signal,at:s.batch.at});
        raiseUpstreamIssue(scratch,{...item,raisedBy:s.principal.actor.principalId,authored:s.authored,agent:s.agent,at:s.batch.at});}
      return {requests:s.requests,actorId:s.principal.actor.principalId,authored:s.authored,agent:s.agent,unowned:recorded.unowned};
    },
    async commit(context,item,{signal,index}={}){
      const s=selected(context);if(!same(item,s.requests?.[index]))throw error('Use the ordered issued discrepancy.','ENGINE_INPUT_INVALID');
      const input={...item,operationId:s.prefix+index,fromArtifact:false,phaseId:item.phase,authored:s.authored},port=portFor('upstream.raise',s.owner),
        child=await port.load(input,{signal}),prepared=await port.prepare(child,input,{signal}),accepted=await port.commit(child,prepared,{signal}),
        result=await port.finish(child,prepared,accepted);s.accepted++;return result;
    },
    async finish(context,_request,{signal}={}){
      const s=selected(context);await identity(signal,s.principal);
      if(!s.accepted){await reports.fresh(s.snapshot,s.token,{signal});
        if((await observer.inspect({signal})).snapshot.revision!==s.snapshot.revision)throw error('The report changed during discrepancy inspection.','ENGINE_CONTEXT_CHANGED');}
      return {workId,currentPhase:context.workflow.currentPhase,revalidate:[],refreshed:null};
    }
  };
}
