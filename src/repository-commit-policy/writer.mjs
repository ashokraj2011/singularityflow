/** Shared bridge for existing async owners; never stages a file or pushes on their behalf. */
import {run} from '../util.mjs';
import {withoutGitProcessOverrides} from '../git-enterprise-environment.mjs';
import {createRepositoryPolicyCommit,withRepositoryPolicyRefAdmission} from './runtime.mjs';
import {resolveRepositoryCommitPolicy} from './context.mjs';
import {rcpFailure} from './policy.mjs';
export async function commitPolicyIndex(root,message,{subject={kind:'maintenance',id:'repository-maintenance'},purpose='maintenance',env=process.env,identity=null,sign=false,allowedPaths=null,ref=null,phase=null,generation=null,operationId=null,beforeRefAdvance,legacyCreate}={}){
 const binding=await resolveRepositoryCommitPolicy(root);
 if(binding.mode!=='enforce')return legacyCreate();
 const read=args=>run('git',args,{cwd:root,env:{...withoutGitProcessOverrides(env),...(env.GIT_INDEX_FILE?{GIT_INDEX_FILE:env.GIT_INDEX_FILE}:{}),GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'},allowFailure:true,timeoutMs:15000});
 const symbolic=read(['symbolic-ref','--quiet','HEAD']);ref??=symbolic.stdout.trim();
 if(!ref.startsWith('refs/heads/'))rcpFailure('RCP_VALIDATION_UNSUPPORTED','This detached legacy writer has no qualified owner-ref handoff. Use its object writer with an explicit metadata destination; no normal commit was attempted.');
 const parent=read(['rev-parse','--verify','--quiet','HEAD']);
 const tree=read(['write-tree']);if(tree.status!==0)rcpFailure('RCP_VALIDATION_INCOMPLETE','The owner’s exact staged tree could not be captured.');
 const result=await createRepositoryPolicyCommit(root,{subject,purpose,ref,tree:tree.stdout.trim(),parents:parent.status===0?[parent.stdout.trim()]:[],expectedLocalRef:parent.status===0?parent.stdout.trim():null,message,allowedPaths,phase,generation,operationId}, {env,sign,commitIdentity:identity});
 if(beforeRefAdvance)await beforeRefAdvance();
 const args=['update-ref','--no-deref',ref,result.commit,parent.status===0?parent.stdout.trim():'0'.repeat(result.commit.length)];
 await withRepositoryPolicyRefAdmission(result.admission,()=>run('git',args,{cwd:root,env:{...withoutGitProcessOverrides(env),GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'}}));
 return result.commit;
}

/** Migrate normal async commit owners without changing their off-mode Git behavior. */
export async function runPolicyCommit(root,args,{env=process.env,subject={kind:'configuration',id:'repository-configuration'},purpose='configuration',legacyRun,...options}={}){
 const binding=await resolveRepositoryCommitPolicy(root);
 const legacy=()=>legacyRun(args,{...options,env});
 if(binding.mode!=='enforce')return legacy();
 const at=args.indexOf('commit');
 if(at<0)rcpFailure('RCP_PLAN_INVALID','The normal commit bridge accepts commit only.');
 const messages=[];let name=null,email=null,sign=false;
 for(let i=0;i<args.length;i++){
  if(args[i]==='-c'){
   const entry=args[++i];if(entry.startsWith('user.name='))name=entry.slice(10);if(entry.startsWith('user.email='))email=entry.slice(11);
  }else if(i>at){
   if(args[i]==='-m'||args[i]==='--message')messages.push(args[++i]);
   else if(args[i]==='-S')sign=true;
   else rcpFailure('RCP_VALIDATION_UNSUPPORTED','This normal writer uses commit options outside its qualified policy bridge. No alternate Git strategy was selected.');
  }
 }
 if(!messages.length)rcpFailure('RCP_PLAN_INVALID','The normal owner did not supply its complete message.');
 const commit=await commitPolicyIndex(root,messages.join('\n\n'),{subject,purpose,env,sign,
  identity:name&&email?{name,email,source:'configured'}:null,legacyCreate:legacy});
 return {status:0,stdout:`${commit}\n`,stderr:'',commit};
}

/** Ledger's existing detached projection: validate an object, update only its private HEAD. */
export async function commitPolicyDetachedIndex(root,message,{ref,subject,purpose,env=process.env,identity=null,sign=false,allowedPaths=null,legacyCreate}={}){
 const binding=await resolveRepositoryCommitPolicy(root);if(binding.mode!=='enforce')return legacyCreate();
 const read=args=>run('git',args,{cwd:root,env,allowFailure:true,timeoutMs:15000});
 const symbolic=read(['symbolic-ref','--quiet','HEAD']);
 if(symbolic.status===0&&!symbolic.stdout.trim().startsWith('refs/singularity-flow/ledger-bootstrap/'))rcpFailure('RCP_VALIDATION_UNSUPPORTED','The ledger projection is attached to an authoritative application branch. No commit was attempted.');
 const parent=read(['rev-parse','--verify','--quiet','HEAD']);const tree=read(['write-tree']);
 if(tree.status!==0)rcpFailure('RCP_VALIDATION_INCOMPLETE','The exact metadata tree could not be captured.');
 const built=await createRepositoryPolicyCommit(root,{ref,subject,purpose,tree:tree.stdout.trim(),parents:parent.status===0?[parent.stdout.trim()]:[],message,allowedPaths},{env,commitIdentity:identity,sign});
 const args=['update-ref','HEAD',built.commit,parent.status===0?parent.stdout.trim():'0'.repeat(built.commit.length)];
 const {withAdmittedCommitGit,commitGitRequestDigest}=await import('./gate.mjs');
 withAdmittedCommitGit(root,{kind:'private-ref',requestSha256:commitGitRequestDigest(args,{env})},()=>run('git',args,{cwd:root,env}));
 return built.commit;
}
