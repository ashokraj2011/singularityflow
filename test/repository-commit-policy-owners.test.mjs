import test from 'node:test';import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';
import {rcpFixture,registeredRcpPolicy} from './helpers/rcp-fixture.mjs';
import {commitIsolated,commitReviewedPaths} from '../src/git.mjs';
import {initializeLedger,appendLedgerIntent,createLedgerIntent,ledgerCommitPolicyEvidence} from '../src/ledger.mjs';
import {createRepositoryPolicyCommit} from '../src/repository-commit-policy/runtime.mjs';
import {verifyPortableCommitPolicyFacts} from '../src/repository-commit-policy/evidence.mjs';
import {resolveRepositoryCommitPolicy} from '../src/repository-commit-policy/context.mjs';
import {planRepositoryCommit} from '../src/repository-commit-policy/plan.mjs';
import {withRepositoryPolicyRefAdmission} from '../src/repository-commit-policy/runtime.mjs';
import {withRepositoryPolicyPushAdmission} from '../src/repository-commit-policy/publication.mjs';
import {operationForCommit} from '../src/repository-commit-policy/records.mjs';
import {run} from '../src/util.mjs';
import {withoutGitProcessOverrides} from '../src/git-enterprise-environment.mjs';
import {pathToFileURL} from 'node:url';

function withMetadata({repository}){const policy=registeredRcpPolicy();policy.tracking.allowedKinds=['story','maintenance-story'];policy.tracking.bindings.ledger='approved-maintenance-story';policy.tracking.references={'ledger-maintenance':{kind:'maintenance-story',key:'OPS-100',subjectId:'state',repository,immutableIssueId:'maintenance-100'}};return policy;}

test('all standard and future phase owners use the same exact key/template and keep SFlow trailers',async t=>{
 const f=await rcpFixture(t);
 for(const phase of ['specification','planning','implementation','convergence','verification','release','custom-future-phase']){
  await writeFile(path.join(f.root,'source.js'),`export const phase = '${phase}';\n`);
  const parent=f.git(f.root,['rev-parse','HEAD']);
  const commit=await commitIsolated(f.root,`complete ${phase}`,['source.js'],{expectedHead:parent,expectedRef:f.ref,commitPolicyContext:{subject:f.subject,purpose:'story',phase,generation:1},transaction:{id:`transaction-${phase}`,eventSha256:'event-bound',stateSha256:'state-bound'}});
  assert.match(f.git(f.root,['show','-s','--format=%B',commit]),new RegExp(`^WEB-221: complete ${phase}\\n\\nSingularity-Flow-Transaction: transaction-${phase}`));
 }
});

test('orphan state bootstrap and ledger append use an explicit accepted maintenance reference and retain portable facts outside the source tree',async t=>{
 const f=await rcpFixture(t,withMetadata);const config={enabled:true,branch:'state',remote:'origin',publication:'required',signing:'off',pinTransport:'none'};
 const initial=await initializeLedger(f.root,config,{publish:false,refreshRemote:false});assert.match(f.git(f.root,['show','-s','--format=%s',initial.commit]),/^OPS-100: /u);
 const built=await createRepositoryPolicyCommit(f.root,{subject:f.subject,purpose:'story',ref:f.ref,tree:await f.candidate(),parents:[f.parent],message:'application work',allowedPaths:['source.js']});
 const intent=createLedgerIntent({eventType:'artifact-generated',capabilityId:'calculator',actor:{name:'Story Author',email:'author@example.invalid'},subject:{workId:f.subject.id},payload:{phase:'implementation'}});
 await appendLedgerIntent(f.root,config,intent,built.commit,{publish:false});
 const binding=await resolveRepositoryCommitPolicy(f.root);const fact=await ledgerCommitPolicyEvidence(f.root,config,built.commit);
 assert.equal(verifyPortableCommitPolicyFacts(fact,{commit:built.commit,repository:binding.repository}).hostBindings,'must-rebind');
 assert.equal(f.git(f.root,['ls-tree','-r','--name-only',built.commit]).includes('evidence/repository-commit-policy/'),false);
});

test('metadata profiles cannot cover source files or invent an exemption from real-key requirements',async t=>{
 const f=await rcpFixture(t,({repository})=>{const policy=withMetadata({repository});policy.metadata={mode:'scoped-profile',profile:'message-v1',refs:['refs/heads/state'],paths:['ledger'],purposes:['ledger'],requireBranchAgreement:false};return policy;});
 await assert.rejects(planRepositoryCommit(f.root,{subject:{kind:'ledger',id:'state'},purpose:'ledger',ref:'refs/heads/state',tree:await f.candidate(),parents:[f.parent],message:'metadata'}),{code:'RCP_METADATA_POLICY_INCOMPATIBLE'});
});

test('reviewed authoring retains its original stability guard after policy object verification',async t=>{
 const f=await rcpFixture(t);await f.candidate();let observations=0;
 await assert.rejects(commitReviewedPaths(f.root,'reviewed repair',['source.js'],{expectedHead:f.parent,commitPolicyContext:{subject:f.subject,purpose:'story',phase:'implementation',generation:1},stabilityGuard:async()=>++observations<3}),{code:'RECOVERY_PLAN_STALE'});
 assert.equal(observations,3);assert.equal(f.git(f.root,['rev-parse','HEAD']),f.parent);
 assert.equal(await readFile(path.join(f.root,'source.js'),'utf8'),'export const value = 2;\n');
});

test('a second laptop clone rebinds portable state facts without copying host execution grants or reauthoring the commit',async t=>{
 const f=await rcpFixture(t,withMetadata),config={enabled:true,branch:'state',remote:'origin',publication:'required',signing:'off',pinTransport:'none'};
 await initializeLedger(f.root,config,{publish:false,refreshRemote:false});
 const built=await createRepositoryPolicyCommit(f.root,{subject:f.subject,purpose:'story',ref:f.ref,tree:await f.candidate(),parents:[f.parent],message:'application work',allowedPaths:['source.js']});
 const env={...withoutGitProcessOverrides(process.env),GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1'};
 await withRepositoryPolicyRefAdmission(built.admission,()=>run('git',['update-ref','--no-deref',f.ref,built.commit,f.parent],{cwd:f.root,env}));
 const push=['push',`--force-with-lease=${f.ref}:`,'origin',`${built.commit}:${f.ref}`];
 await withRepositoryPolicyPushAdmission(f.root,push,{env},()=>run('git',push,{cwd:f.root,env}));
 const intent=createLedgerIntent({eventType:'artifact-generated',capabilityId:'calculator',actor:{name:'Story Author',email:'author@example.invalid'},subject:{workId:f.subject.id},payload:{phase:'implementation'}});
 await appendLedgerIntent(f.root,config,intent,built.commit,{publish:true});
 const other=path.join(f.base,'another-laptop');f.git(f.base,['clone','-q',pathToFileURL(f.remote).href,other]);
 f.git(other,['switch','-q','WEB-221']);f.git(other,['config','user.name','Another Author']);f.git(other,['config','user.email','other@example.invalid']);
 assert.equal(await operationForCommit(other,built.commit),null);
 const facts=await ledgerCommitPolicyEvidence(other,config,built.commit);
 assert.equal(facts.executionAuthorization,'not-portable');assert.equal(facts.hostBindings,'must-rebind');
 const retry=['push',`--force-with-lease=${f.ref}:${built.commit}`,'origin',`${built.commit}:${f.ref}`];let calls=0;
 const result=await withRepositoryPolicyPushAdmission(other,retry,{env},()=>{calls++;return run('git',retry,{cwd:other,env});});
 assert.equal(result.status,0);assert.equal(calls,1);assert.equal(f.git(other,['rev-parse','HEAD']),built.commit);
 assert.equal(await operationForCommit(other,built.commit),null);
});
