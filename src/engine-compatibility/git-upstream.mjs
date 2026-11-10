/** Native upstream coordination. No CLI grammar, command rendering or replacement authority. */
import {actionActor} from '../git.mjs';
import {loadAcceptedStoryExecution} from '../accepted-story-execution.mjs';
import {actorKey} from '../state-stores.mjs';
import {nowIso,SingularityFlowError} from '../util.mjs';
import {nativeDecisionRecordActor as who} from './record-decision-context.mjs';
import {raiseUpstreamIssue,upstreamIssueAuthorities,upstreamIssueStates,UPSTREAM_ISSUE_OUTCOMES,
  UPSTREAM_ISSUE_PROBLEM_MAXIMUM,UPSTREAM_ISSUE_PROPOSALS} from '../upstream-issues.mjs';
import {pendingAmendmentRevalidations} from '../forward-amendments.mjs';
import {commitUpstreamIssueTransaction,commitUpstreamIssueDecision,undecidableIssue} from './native-upstream-decisions.mjs';

const refused=(message,code='UPSTREAM_ISSUE_INVALID',details=undefined)=>{
  throw new SingularityFlowError(message,{code,...(details?{details}:{})});
};
const detached=value=>JSON.parse(JSON.stringify(value));

export function createGitUpstreamPort({root,onContext=()=>{}}) {
  return {
    async load(input) {
      if(input.operationId!=null)refused('Explicit namespace decision IDs require their namespace record owner.','ENGINE_PORT_UNAVAILABLE',{
        required:['namespace-decision-idempotency']});
      // The installed upstream route resolves accepted Story execution; it never changes checkout.
      const accepted=await loadAcceptedStoryExecution(root,input.workId??undefined);
      const context={root,config:accepted.definition,workflow:accepted.workflow,
        subject:{kind:'story',id:accepted.workflow.workItem.id},last:null};
      onContext(context);
      return context;
    },
    async resolve(context,request,{operation}) {
      const {workflow,config}=context,id=operation.id;
      if(id==='upstream.list')return detached({issues:upstreamIssueStates(workflow)
        .filter(entry=>!request.open||['open','expired'].includes(entry.status))
        .map(({issue,decision,status,supersededBy})=>({...issue,status,decision,supersededBy}))});
      let requests=[request],authored=null,unowned=[];
      if(id==='upstream.raise') {
        const chosen=request.proposed;
        if(chosen!=null&&!UPSTREAM_ISSUE_PROPOSALS.includes(chosen))refused(`--proposed must be one of ${UPSTREAM_ISSUE_PROPOSALS.join(', ')}.`);
        const running=request.authored?null:await import('../comprehension/xpl2/sf-guard-recorder.mjs')
          .then(recorder=>recorder.sfGuardRunningAuthorship(root),()=>null);
        authored=request.authored??running?.authored??'human';
        if(!['human','governed-agent'].includes(authored))refused('--authored must be human or governed-agent.');
        const manual=request.fromArtifact?['phaseId','about','problem','assumption','impact','supersedes'].filter(key=>request[key]!=null):[];
        if(manual.length) {
          const names=manual.map(key=>key==='phaseId'?'phase':key);
          refused(`--from-artifact reads each item's owning step and text from the artifact, so it takes no --${names.join(' or --')}. `
            +'Raise one item yourself with --phase and --problem, without --from-artifact.','UPSTREAM_ISSUE_OPTIONS_INVALID');
        }
        const recorded=request.fromArtifact?await (await import('./upstream-artifact-issues.mjs')).recordedDiscrepancies(root,config,workflow):null;
        if(recorded?.tooLong.length)refused(
          `${recorded.tooLong.length} recorded item(s) are longer than the ${UPSTREAM_ISSUE_PROBLEM_MAXIMUM}-character limit of an upstream issue's problem, so nothing was raised: `
          +`${recorded.tooLong.map(entry=>`${entry.path} (${entry.length} characters: "${entry.text.slice(0,60)}…")`).join('; ')}. `
          +`Split each into shorter items under \`## Upstream discrepancies\`, or raise it with --phase, a --problem of at most ${UPSTREAM_ISSUE_PROBLEM_MAXIMUM} characters, and --assumption and --impact.`,
          'UPSTREAM_ISSUE_PROBLEM_TOO_LONG',{maximum:UPSTREAM_ISSUE_PROBLEM_MAXIMUM,items:recorded.tooLong});
        requests=recorded?recorded.requests.map(item=>({...item,proposed:chosen??item.proposed}))
          :[{phase:request.phaseId,about:request.about,problem:request.problem,assumption:request.assumption,
            impact:request.impact,proposed:chosen??'unknown',source:null,supersedes:request.supersedes}];
        if(!request.fromArtifact&&!requests[0].phase)refused('Name the earlier step with --phase.');
        const identity=await who(context);
        identity.agent=identity.agent??running?.agent??null;
        context.authored=authored;
        // Validate every item before the first write, matching the installed batch contract.
        for(const item of requests)raiseUpstreamIssue(structuredClone(workflow),{...item,authored,agent:identity.agent,
          raisedBy:actorKey(identity.actor),at:nowIso()});
        unowned=recorded?.unowned??[];
      } else if(id==='upstream.decide') {
        const state=upstreamIssueStates(workflow).find(entry=>entry.issue.id===request.issueId);
        if(!state)refused(`${request.issueId||'That issue'} is not an upstream issue of this Story. List them with upstream-issue list.`,'UPSTREAM_ISSUE_NOT_FOUND');
        if(!UPSTREAM_ISSUE_OUTCOMES.includes(request.outcome))refused(`--outcome must be one of ${UPSTREAM_ISSUE_OUTCOMES.join(', ')}.`);
        if(!upstreamIssueAuthorities(workflow,state.issue.phase).length)refused(...undecidableIssue(workflow,state.issue));
        await who(context);
      } else if(id==='forward-amendment.decide') {
        const proposal=(workflow.forwardAmendments??[]).find(entry=>entry.id===request.amendmentId);
        if(!proposal)refused(`${request.amendmentId||'That amendment'} is not a forward amendment of this Story.`,'FORWARD_AMENDMENT_NOT_FOUND');
        // Original amendment approval has no phase-agent session attribution.
        context.who={actor:actionActor(root),agent:null};
      } else {
        await who(context);
        if(id==='forward-amendment.propose') {
          if(!request.phaseId)refused('Name the earlier step with --phase.');
          if(request.upstreamIssue&&!upstreamIssueStates(workflow).some(entry=>entry.issue.id===request.upstreamIssue&&entry.issue.phase===request.phaseId)) {
            refused(`${request.upstreamIssue} is not an upstream issue about ${request.phaseId}.`);
          }
          if(!workflow.phases?.[request.phaseId]?.requiredArtifact?.path)refused(`${request.phaseId} is not a step with one document to amend.`);
        }
      }
      return detached({requests,actorId:actorKey(context.who.actor),agent:context.who.agent,authored,unowned});
    },
    async commit(context,request,{operation}) {
      const {config,workflow}=context,id=operation.id;
      let result;
      if(id==='upstream.raise')result=await commitUpstreamIssueTransaction(root,config,workflow,request,
        {...context.who,authored:context.authored});
      else if(id==='upstream.decide')result=await commitUpstreamIssueDecision(root,config,workflow,request.issueId,request,context.who);
      else {
        const owner=await import('./native-forward-amendments.mjs');
        if(id==='forward-amendment.propose')result=await owner.commitForwardAmendmentProposal(root,config,workflow,request,context.who);
        else if(id==='forward-amendment.decide')result=await owner.commitForwardAmendmentDecision(root,config,workflow,request.amendmentId,request,context.who);
        else result=await owner.commitForwardAmendmentRevalidation(root,config,workflow,request.phaseId,request,context.who);
      }
      context.last=result;
      return detached({revision:result.publication.sha,pushed:result.publication.pushed,record:result.value});
    },
    async finish(context,request,{operation}) {
      const {workflow,last}=context;
      const applied=operation.id==='forward-amendment.decide'&&last?.value.applied;
      return {workId:workflow.workItem.id,currentPhase:workflow.currentPhase??null,
        revalidate:applied?pendingAmendmentRevalidations(workflow).filter(entry=>entry.amendment===request.amendmentId).map(entry=>entry.phase):[],
        refreshed:applied?last.value.refreshed??null:null};
    }
  };
}
