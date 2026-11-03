import test from 'node:test';import assert from 'node:assert/strict';
import {rcpFixture,registeredRcpPolicy} from './helpers/rcp-fixture.mjs';
import {createRepositoryPolicyCommit,withRepositoryPolicyRefAdmission} from '../src/repository-commit-policy/runtime.mjs';
import {withRepositoryPolicyPushAdmission} from '../src/repository-commit-policy/publication.mjs';
import {gitPolicyCommand} from '../src/commands/git-policy.mjs';
import {run} from '../src/util.mjs';import {withoutGitProcessOverrides} from '../src/git-enterprise-environment.mjs';
import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import YAML from 'yaml';
const env=()=>({...withoutGitProcessOverrides(process.env),GIT_NO_REPLACE_OBJECTS:'1',GIT_NO_LAZY_FETCH:'1'});
async function built(f){return createRepositoryPolicyCommit(f.root,{subject:f.subject,purpose:'story',ref:f.ref,tree:await f.candidate(),parents:[f.parent],message:'publish verified work',allowedPaths:['source.js']});}
async function advance(f,result){await withRepositoryPolicyRefAdmission(result.admission,()=>run('git',['update-ref','--no-deref',f.ref,result.commit,f.parent],{cwd:f.root,env:env()}));}
const pushArgs=(f,commit,lease='')=>['push','--porcelain',`--force-with-lease=${f.ref}:${lease}`,'origin',`${commit}:${f.ref}`];

test('retained publication validates the actual exact object and preserves the original commit across failure/retry',async t=>{
 const f=await rcpFixture(t),result=await built(f);await advance(f,result);const args=pushArgs(f,result.commit);let calls=0;
 const failed=await withRepositoryPolicyPushAdmission(f.root,args,{env:env()},()=>{calls++;return {status:1,stderr:'remote hook refused'};});assert.equal(failed.status,1);
 const pushed=await withRepositoryPolicyPushAdmission(f.root,args,{env:env()},()=>{calls++;return run('git',args,{cwd:f.root,env:env()});});
 assert.equal(pushed.status,0);assert.equal(calls,2);assert.equal(f.git(f.remote,['rev-parse',f.ref]),result.commit);
});
test('unbound commits, missing leases and incomplete outgoing history cannot be reported as valid',async t=>{
 const f=await rcpFixture(t,registeredRcpPolicy({outgoingRange:'new-commits'}));const result=await built(f);await advance(f,result);
 let calls=0;await assert.rejects(withRepositoryPolicyPushAdmission(f.root,pushArgs(f,result.commit),{},()=>{calls++;}),{code:'RCP_OUTGOING_MESSAGE_REJECTED'});
 assert.equal(calls,0);
 await assert.rejects(withRepositoryPolicyPushAdmission(f.root,['push','origin',`${result.commit}:${f.ref}`],{},()=>{calls++;}),{code:'RCP_PUSH_SCOPE_REQUIRED'});assert.equal(calls,0);
});
test('policy inspection and owner plan validation never manufacture a commit or approval',async t=>{
 const f=await rcpFixture(t);const report=await gitPolicyCommand(f.root,['git-policy','show']);assert.equal(report.mode,'enforce');assert.equal(report.approval,'not-implied');assert.equal(report.next.vscode,null);assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
 await assert.rejects(gitPolicyCommand(f.root,['git-policy','validate'],{operation:'sha256:'+ '0'.repeat(64)}),{code:'RCP_PLAN_UNISSUED'});
 const compatible=await gitPolicyCommand(f.root,['git-policy','discover']);assert.equal(compatible.discovery.observationsOnly,true);assert.equal(compatible.next.vscode,'@sflow /git-policy');
});

async function adoptStricterPolicy(f){
 f.git(f.source,['switch','-q','sflow/config']);const file=path.join(f.source,'singularity/workflow.yml');
 const definition=YAML.parse(await readFile(file,'utf8'));definition.git.commitPolicy.body={requiredTrailers:['Repository-Review']};await writeFile(file,YAML.stringify(definition));
 f.git(f.source,['add','singularity/workflow.yml']);f.git(f.source,['commit','-qm','Adopt additional repository trailer']);
 f.git(f.source,['push',f.remote,'sflow/config']);f.git(f.root,['fetch','origin','+refs/heads/sflow/config:refs/remotes/origin/sflow/config']);
}
test('a changed approved policy refuses an already-verified object before the owner CAS',async t=>{
 const f=await rcpFixture(t),result=await built(f);await adoptStricterPolicy(f);
 await assert.rejects(advance(f,result),{code:'RCP_PLAN_STALE'});assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
 assert.equal(f.git(f.root,['cat-file','-t',result.commit]),'commit');
});
test('pending publication applies a stricter current policy without rewriting the old object',async t=>{
 const f=await rcpFixture(t),result=await built(f);await advance(f,result);const message=f.git(f.root,['show','-s','--format=%B',result.commit]);
 await adoptStricterPolicy(f);let calls=0;
 await assert.rejects(withRepositoryPolicyPushAdmission(f.root,pushArgs(f,result.commit),{env:env()},()=>{calls++;}),{code:'RCP_OUTGOING_MESSAGE_REJECTED'});
 assert.equal(calls,0);assert.equal(f.git(f.root,['rev-parse','HEAD']),result.commit);assert.equal(f.git(f.root,['show','-s','--format=%B',result.commit]),message);
});
test('read-only discovery remains available for an unadopted candidate policy',async t=>{
 const f=await rcpFixture(t);f.git(f.root,['remote','remove','origin']);
 const report=await gitPolicyCommand(f.root,['git-policy','discover']);
 assert.equal(report.status,'attention-required');assert.equal(report.diagnostic.code,'RCP_POLICY_NOT_ADOPTED');
 assert.equal(report.discovery.observationsOnly,true);assert.equal(report.changesAuthorization,false);assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
});
