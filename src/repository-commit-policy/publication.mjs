/** Revalidate retained objects; publication, leases and pending recovery stay with their owners. */
import {run} from '../util.mjs';
import {withoutGitProcessOverrides} from '../git-enterprise-environment.mjs';
import {resolveRepositoryCommitPolicy,repositoryCommitPolicyBinding} from './context.mjs';
import {planRepositoryCommit,issuedCommitPolicyPlan,assertCommitPlanCurrent} from './plan.mjs';
import {operationForCommit,readCommitPolicyRecord,retainCommitPolicyRecord} from './records.mjs';
import {observePolicyCommit} from './runtime.mjs';
import {evaluateRegisteredChecks} from './checks.mjs';
import {validateCommitMessage,rcpFailure,rcpDigest} from './policy.mjs';
import {commitPolicyGitVerb,withAdmittedCommitGit,commitGitRequestDigest} from './gate.mjs';

function local(root,args,options={}){return run('git',args,{cwd:root,env:{...withoutGitProcessOverrides(process.env),GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'},timeoutMs:15000,maxBuffer:4*1024*1024,...options});}
const oid=value=>/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value??'');
export function policyPushDestinations(args){
 const destinations=[];
 for(const value of args){
  const match=/^\+?([a-f0-9]{40}(?:[a-f0-9]{24})?):(refs\/(?:heads\/[^\s:]+|singularity\/pins\/[^\s:]+))$/u.exec(value);
  if(match){const lease=args.find(arg=>arg.startsWith(`--force-with-lease=${match[2]}:`));destinations.push({commit:match[1],ref:match[2],pin:match[2].startsWith('refs/singularity/pins/')||match[2].startsWith('refs/heads/singularity/pins/'),expectedRemote:lease==null?undefined:lease.slice(`--force-with-lease=${match[2]}:`.length)||null});}
  else if(/:refs\//u.test(value)&&!value.startsWith('--'))rcpFailure('RCP_PUSH_SCOPE_REQUIRED','Every outgoing refspec must name an exact retained commit and a qualified destination. No unrelated/default ref was pushed.');
 }
 if(!destinations.length || destinations.length>16)rcpFailure('RCP_PUSH_SCOPE_REQUIRED','Enforced publication requires a bounded list of exact commit:destination refspecs and the existing owner’s remote lease. No default/all/mirror push was attempted.');
 return destinations;
}
async function validateRetainedObject(root,commit,ref,binding){
 const operation=await operationForCommit(root,commit);
 const preliminary=observePolicyCommit(root,commit);
 const currentPolicy=repositoryCommitPolicyBinding(binding).policy;
 try {validateCommitMessage({...currentPolicy,types:undefined,scopes:undefined},preliminary.message);} catch(error){rcpFailure('RCP_OUTGOING_MESSAGE_REJECTED','An actual outgoing commit violates the current full-message grammar. Preserve the range for a reviewed remedy; no history was rewritten.',{commit,ref,reasonCode:error.code});}
 let portable=null;
 if(!operation?.observation || !operation.plan){
  const context=repositoryCommitPolicyBinding(binding);
  const candidate=await (await import('../ledger.mjs')).ledgerCommitPolicyEvidence(root,context.definition?.ledger??{},commit);
  if(candidate)portable=(await import('./evidence.mjs')).verifyPortableCommitPolicyFacts(candidate,{commit,repository:binding.repository});
  if(!portable)rcpFailure('RCP_PUBLICATION_UNPROVEN','This outgoing commit has no locally rebound or state-provider policy observation. Preserve it unchanged and obtain an owner-issued validation plan; do not amend, rerun message hooks, or substitute HEAD.',{commit,ref});
 }
 const prior=portable?.plan??await readCommitPolicyRecord(root,operation.plan),object=observePolicyCommit(root,commit);
 if(prior.ref!==ref || (operation?.commit??portable?.commit)!==commit)rcpFailure('RCP_PUBLICATION_UNPROVEN','The retained observation belongs to another exact destination or object.',{commit,ref});
 if(portable && ['tree','author','committer','message','messageSha256'].some(field=>object[field]!==portable.object[field]))rcpFailure('RCP_RECORD_INVALID','The portable fact does not describe the actual immutable commit object.',{commit});
 const plan=await planRepositoryCommit(root,{subject:prior.subject,purpose:prior.purpose,ref,tree:object.tree,parents:object.parents,
  message:prior.draftMessage,generation:prior.ownerGeneration??null,phase:prior.fields?.phase??null,type:prior.fields?.type??null,scope:prior.fields?.scope??null,
  expectedLocalRef:local(root,['rev-parse','--verify','--quiet',ref],{allowFailure:true}).stdout.trim()||null,policyBinding:binding});
 const context=issuedCommitPolicyPlan(plan);
 if(object.tree!==prior.prospectiveTree || rcpDigest(object.parents)!==rcpDigest(prior.parents))rcpFailure('RCP_COMMIT_OBJECT_REJECTED','The outgoing object does not match its recorded content and parents.',{commit});
 if(plan.strategy==='registered-checks'){
  // Re-evaluate the actual immutable message under current policy; never render and replace it.
  validateCommitMessage(context.policy,object.message,{...context.fields,expectedSubject:plan.proposedMessage.split('\n')[0]});
  if(object.message!==(plan.proposedMessage.endsWith('\n')?plan.proposedMessage:`${plan.proposedMessage}\n`))rcpFailure('RCP_PUBLICATION_POLICY_CHANGED','The retained full message is incompatible with current policy. A reviewed remedy is required; no rewrite was performed.',{commit});
  const checked=evaluateRegisteredChecks(plan);if(checked.status!=='passed')rcpFailure('RCP_CONTENT_REJECTED','The retained object no longer meets current registered content obligations.',{commit,checks:checked.checks});
 }else{
  if(prior.policySha256!==plan.policySha256||prior.profileSha256!==plan.profileSha256||!portable&&prior.discoverySha256!==plan.discoverySha256)rcpFailure('RCP_PUBLICATION_POLICY_CHANGED','Native policy, hooks or runtime bindings changed. The original object is preserved for a reviewed equivalent validation; its message-mutating hook was not rerun.',{commit});
  const native=operation?.native??portable?.native;
  if(!native)rcpFailure('RCP_PUBLICATION_UNPROVEN','Native execution facts are unavailable on this machine; local bindings must be re-established without reauthoring the object.',{commit});
  if(native.commit!==commit||native.beforeMessageSha256!==rcpDigest(prior.proposedMessage)||native.nativeContext!=='original-worktree-private-git'||native.effects?.status!=='unchanged'
      ||!Array.isArray(native.stages)||plan.hookBindings.some(hook=>!native.stages.some(stage=>stage.stage===hook.stage&&stage.status==='passed')))rcpFailure('RCP_PUBLICATION_UNPROVEN','The retained native facts do not establish every required stage against the unchanged original candidate.',{commit});
  (await import('./native.mjs')).verifyNativeCommitMessage(plan,object.message,native);
  validateCommitMessage(context.policy,object.message,context.fields);
 }
 if(context.policy.signing?.required && (object.signature==='absent'||local(root,['verify-commit','--raw',commit],{allowFailure:true}).status!==0))rcpFailure('RCP_COMMIT_OBJECT_REJECTED','The retained commit lacks a currently verifiable required signature.',{commit});
 await assertCommitPlanCurrent(plan);
 return {commit,planSha256:plan.planSha256,policySha256:plan.policySha256,profileSha256:plan.profileSha256,status:'passed',nativeHookReplay:'not-performed',localBindings:'freshly-rebound',evidence:portable?'state-provider-facts':'local-owner-records',approval:'not-implied'};
}
export async function withRepositoryPolicyPushAdmission(root,args,options,action){
 if(commitPolicyGitVerb(args)!=='push')return action();
 const binding=await resolveRepositoryCommitPolicy(root,{env:options.env??process.env});
 if(binding.mode!=='enforce')return action();
 if((options.env??process.env).HUSKY==='0'||(options.env??process.env).LEFTHOOK==='0'||['SKIP','SKIP_GIT_HOOKS','HUSKY_SKIP_HOOKS'].some(name=>(options.env??process.env)[name]))rcpFailure('RCP_HOOK_BYPASS_REFUSED','A hook-disabling environment setting conflicts with the adopted policy. No push was attempted.');
 if(args.includes('--no-verify')||args.includes('-n'))rcpFailure('RCP_HOOK_BYPASS_REFUSED','The adopted policy does not permit a hook-skipping push. Its existing owner must publish the retained exact commit without a skip flag.');
 const {policy}=repositoryCommitPolicyBinding(binding),destinations=policyPushDestinations(args),checks=[];
 for(const destination of destinations){
  if(destination.expectedRemote===undefined)rcpFailure('RCP_PUSH_SCOPE_REQUIRED','The current publication owner must supply its exact expected remote revision; policy validation does not replace its lease.',destination);
  let commits=[destination.commit];
  if(policy.outgoingRange==='new-commits'){
   if(local(root,['rev-parse','--is-shallow-repository']).stdout.trim()==='true')rcpFailure('RCP_RANGE_UNPROVEN','A shallow repository cannot prove this policy’s complete outgoing range. Resolve the required destination history through its workspace owner; no commit was rewritten.',destination);
   if(destination.expectedRemote!=null && (!oid(destination.expectedRemote)||local(root,['cat-file','-e',`${destination.expectedRemote}^{commit}`],{allowFailure:true}).status!==0))rcpFailure('RCP_RANGE_UNPROVEN','The exact leased remote parent is missing locally. Refresh that selected destination through its workspace owner.',destination);
   const listed=local(root,['rev-list','--topo-order',destination.commit,...(destination.expectedRemote?['--not',destination.expectedRemote]:[])]);
   commits=listed.stdout.trim().split('\n').filter(Boolean);
   if(commits.length>256||commits.some(commit=>!oid(commit)))rcpFailure('RCP_RANGE_UNPROVEN','The outgoing range exceeds the bounded validation window. Use a reviewed range-resolution plan; no history was changed.',destination);
  }
  for(const commit of commits){
   let ref=destination.ref;
   if(destination.pin){
    const operation=await operationForCommit(root,commit);
    if(!operation?.plan)rcpFailure('RCP_PUBLICATION_UNPROVEN','The retention pin has no rebound exact source-commit plan. No pin or branch was published.',{commit,ref});
    ref=(await readCommitPolicyRecord(root,operation.plan)).ref;
   }
   checks.push(await validateRetainedObject(root,commit,ref,binding));
  }
 }
 const planned=await retainCommitPolicyRecord(root,'publication',{repository:binding.repository,destinations,checks,status:'ready',remoteStatus:'not-attempted',approval:'not-implied'});
 const result=await withAdmittedCommitGit(root,{kind:'verified-push',requestSha256:commitGitRequestDigest(args,options)},action);
 await retainCommitPolicyRecord(root,'publication',{repository:binding.repository,destinations,checks,plan:planned,status:result?.status===0?'remote-command-completed':'remote-rejected-or-unproven',remoteStatus:'owned-by-existing-publication-reconciliation',diagnosticCode:result?.failure?.code??null,approval:'not-implied'});
 return result;
}
