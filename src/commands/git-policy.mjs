/** Repository policy discovery and owner-issued validation. This surface never commits or pushes. */
import {optionBoolean,optionString,SingularityFlowError} from '../util.mjs';
import {repoRoot} from '../git-execution.mjs';
import {resolveRepositoryCommitPolicy,repositoryCommitPolicyBinding} from '../repository-commit-policy/context.mjs';
import {discoverCommitPolicy} from '../repository-commit-policy/discovery.mjs';
import {readCommitPolicyOperation,readCommitPolicyRecord} from '../repository-commit-policy/records.mjs';
import {planRepositoryCommit,assertCommitPlanCurrent} from '../repository-commit-policy/plan.mjs';
import {validateRegisteredCommitPlan} from '../repository-commit-policy/checks.mjs';
import {rcpFailure} from '../repository-commit-policy/policy.mjs';

export const GIT_POLICY_ACTIONS=Object.freeze(['discover','show','plan','validate']);
export const GIT_POLICY_USAGE='singularity-flow git-policy discover|show [--json]\nsingularity-flow git-policy plan|validate --operation sha256:<OWNER-ISSUED-ID> [--json]';
export function gitPolicyGuidance(action='show',operationId=null){const tail=operationId?` --operation ${operationId}`:'';return {copilot:`/sf-git-policy ${action}${tail}`,shell:`singularity-flow git-policy ${action}${tail} --json`,vscode:action==='show'&&!operationId?'@sflow /git-policy':null,command:`singularity-flow git-policy ${action}${tail} --json`,copilotCommand:`/sf-git-policy ${action}${tail}`,modelFreeCommand:action==='show'&&!operationId?'@sflow /git-policy':null};}
export async function gitPolicyCommand(root,positionals=['git-policy','show'],options={}){
 const action=positionals[1]??'show';
 if(!GIT_POLICY_ACTIONS.includes(action)||positionals.length>2||Object.keys(options).some(key=>!['operation','json','for-agent','timings','help'].includes(key)))throw new SingularityFlowError(`Use ${GIT_POLICY_USAGE}`,{code:'RCP_COMMAND_INVALID'});
 let binding,context;
 try {binding=await resolveRepositoryCommitPolicy(root,{refreshAuthority:false});context=repositoryCommitPolicyBinding(binding);}
 catch(error){
  // Inspection remains available while a branch-local candidate awaits adoption. It cannot
  // issue a plan, persist an enforcement binding or make that candidate authoritative.
  if(!['discover','show'].includes(action)||error.code!=='RCP_POLICY_NOT_ADOPTED')throw error;
  return {schemaVersion:1,resultType:'sflow-git-policy',action,status:'attention-required',mode:'unadopted',compliance:'analysis-only-no-admission',
   changesAuthorization:false,approval:'not-implied',diagnostic:{code:error.code,message:error.message,details:error.details},
   discovery:await discoverCommitPolicy(root),adoption:{status:'existing-configuration-review-required',path:'singularity/workflow.yml'},next:gitPolicyGuidance('show')};
 }
 const result={schemaVersion:1,resultType:'sflow-git-policy',action,mode:binding.mode,compliance:binding.compliance,repository:binding.repository,authority:binding.authority,policySha256:binding.policySha256,
  policy:context.policy??null,changesAuthorization:false,approval:'not-implied',capabilities:{registeredChecks:'exact-tree-and-full-message',nativeGit:'explicit-original-worktree-private-git-profiles-only',mergeMessageNative:'unsupported',projectionNative:'unsupported',outgoingRange:'bounded-exact-new-commits',portableEvidence:'facts-only-local-validation-rebound',uncoveredWriters:'refused-before-authoritative-write'}};
 if(['discover','show'].includes(action)){
  result.discovery=context.discovery??await discoverCommitPolicy(root);
  result.adoption={status:'existing-configuration-review-required',path:'singularity/workflow.yml',commandGuidance:{copilot:'/sf-configuration',shell:'singularity-flow configuration --help',vscode:null}};
  result.next=gitPolicyGuidance(action==='show'?'discover':'show');return result;
 }
 const id=optionString(options,'operation');if(!id)rcpFailure('RCP_PLAN_UNISSUED','Use the exact operation ID retained by a commit owner. A hand-authored JSON file is not an executable validation plan.');
 const operation=await readCommitPolicyOperation(root,id);if(!operation?.plan)rcpFailure('RCP_PLAN_UNISSUED','This host has no owner-issued plan for that operation. Re-enter its current phase or retained publication owner to establish local bindings.');
 const previous=await readCommitPolicyRecord(root,operation.plan);
 const plan=await planRepositoryCommit(root,{subject:previous.subject,purpose:previous.purpose,ref:previous.ref,tree:previous.prospectiveTree,parents:previous.parents,message:previous.draftMessage,
  ...previous.fields,generation:previous.ownerGeneration??null,operationId:id,expectedLocalRef:previous.expectedLocalRef,...(previous.expectedRemote===undefined?{}:{expectedRemote:previous.expectedRemote})});
 if(plan.status==='not-applicable')return {...result,plan,next:gitPolicyGuidance('show')};
 await assertCommitPlanCurrent(plan,{allowLocalRef:operation.refAdvanced?operation.commit:null});
 result.plan=plan;
 if(action==='validate'){
  if(plan.strategy!=='registered-checks')rcpFailure('RCP_OWNER_EXECUTION_REQUIRED','Native validation produces an actual object and must run inside the existing commit owner. This diagnostic command will not commit, run a hook, or select another adapter.',{operationId:id});
  if(operation.refAdvanced)rcpFailure('RCP_OWNER_EXECUTION_REQUIRED','This object already advanced its ref. Revalidate it through its retained push/sync owner rather than rerunning draft validation.',{operationId:id,commit:operation.commit});
  const checked=await validateRegisteredCommitPlan(plan,{operationId:id});result.validation={reference:checked.reference,status:checked.record.status};
 }
 result.next=gitPolicyGuidance('show');return result;
}
export function gitPolicyMarkdown(report){
 const rows=[`Repository commit policy: ${report.mode}`,`Validation: ${report.compliance}`,`Policy: ${report.policySha256??'not adopted'}`,`Authority: ${report.authority?.ref??report.authority?.kind??'none'}`,`Approval: not implied`];
 if(report.validation)rows.push(`Checks: ${report.validation.status}`);
 if(report.discovery)rows.push('',...report.discovery.hooks.filter(hook=>hook.status!=='missing').map(hook=>`${hook.stage}: ${hook.classification}; ${hook.execution}`));
 const next=report.next;return `${rows.join('\n')}\n\n- Copilot: \`${next.copilot}\`\n- Shell: \`${next.shell}\`\n- VS Code (model-free): \`${next.vscode??'not available for this action'}\``;
}
export async function run(_argv,{positionals=['git-policy'],options={}}={}){
 if(options.help === true){console.log(GIT_POLICY_USAGE);return;}
 const result=await gitPolicyCommand(repoRoot(process.cwd()),positionals,options);
 console.log(optionBoolean(options,'json')?JSON.stringify(result,null,2):gitPolicyMarkdown(result));return result;
}
